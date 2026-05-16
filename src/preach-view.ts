import {
	ItemView,
	MarkdownRenderer,
	TFile,
	WorkspaceLeaf,
	Component,
} from "obsidian";
import type PreachMDPlugin from "./main";
import { PreachTimer } from "./timer";
import { HighlightManager, parseBlocks } from "./highlight";
import { ScriptureExpander } from "./scripture";
import { FormatManager, FORMAT_BOLD, FORMAT_ITALIC, FORMAT_UNDERLINE, FORMAT_HIGHLIGHT } from "./format";

export const PREACH_VIEW_TYPE = "preach-md-view";

/**
 * Extracts all headings at a given level from raw markdown text.
 * Returns an array of { text, slug } objects.
 */
function extractHeadings(
	markdown: string,
	level: number
): { text: string; slug: string }[] {
	const prefix = "#".repeat(level) + " ";
	const results: { text: string; slug: string }[] = [];
	for (const line of markdown.split("\n")) {
		if (line.startsWith(prefix)) {
			const text = line.slice(prefix.length).trim();
			const slug = text
				.toLowerCase()
				.replace(/[^\w\s-]/g, "")
				.replace(/\s+/g, "-");
			results.push({ text, slug });
		}
	}
	return results;
}

// WakeLock API types (not present in all TS lib versions)
interface WakeLockSentinel {
	release(): Promise<void>;
	readonly released: boolean;
	readonly type: string;
}

interface WakeLockAPI {
	request(type: "screen"): Promise<WakeLockSentinel>;
}

export class PreachView extends ItemView {
	plugin: PreachMDPlugin;
	file: TFile | null = null;

	// Persisted scroll position within this session
	private savedScrollTop = 0;

	// Back-pill tracking
	private preachLeaf: WorkspaceLeaf | null = null;
	private editPills: Map<WorkspaceLeaf, HTMLElement> = new Map();

	// DOM elements (named to avoid conflict with ItemView.contentEl)
	private scrollEl!: HTMLElement;
	private timerEl!: HTMLElement;
	private outlineBtn!: HTMLElement;
	private exitBtn!: HTMLElement;
	private editBtn!: HTMLElement;
	private formatBtn!: HTMLElement;
	private topBar!: HTMLElement;
	private overlayEl!: HTMLElement;
	private exitChip!: HTMLElement;

	// Idle-fade timeout handle
	private idleTimeout: number | null = null;

	// Timer
	private timer!: PreachTimer;

	// Wake lock
	private wakeLock: WakeLockSentinel | null = null;

	// Edge-swipe suppression
	private touchHandler: ((e: TouchEvent) => void) | null = null;

	// Exit confirm state
	private exitConfirming = false;
	private exitConfirmTimeout: number | null = null;

	// Component used by MarkdownRenderer
	private renderComponent!: Component;

	// Feature managers
	private highlightManager!: HighlightManager;
	private scriptureExpander!: ScriptureExpander;
	private formatManager!: FormatManager;

	// Format toolbar (shown when format mode is active)
	private formatToolbar!: HTMLElement;

	// Parsed blocks (kept in sync after each renderFile call)
	private blocks: ReturnType<typeof parseBlocks> = [];

	// View header (hidden while preach mode is active)
	private viewHeaderEl: HTMLElement | null = null;

	// Sidebar collapse state - tracked per open so restore is accurate
	private leftSplitWasOpen = false;
	private rightSplitWasOpen = false;

	constructor(leaf: WorkspaceLeaf, plugin: PreachMDPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return PREACH_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file ? this.file.basename : "Preach";
	}

	getIcon(): string {
		return "book-open";
	}

	async onOpen(): Promise<void> {
		// Hide the leaf's view-header (tab/title bar) for a cleaner preach surface
		const leafContent = this.containerEl.closest<HTMLElement>(".workspace-leaf-content");
		if (leafContent) {
			this.viewHeaderEl = leafContent.querySelector<HTMLElement>(".view-header");
			if (this.viewHeaderEl) this.viewHeaderEl.classList.add("preach-view-header--hidden");
		}

		// Add body class so CSS can hide global chrome (ribbon, status bar, mobile toolbar, sidebars)
		document.body.addClass("preach-md-active");

		// Collapse sidebars and track whether they were open so onClose can restore them
		const ws = this.app.workspace;
		this.leftSplitWasOpen = !ws.leftSplit.collapsed;
		this.rightSplitWasOpen = !ws.rightSplit.collapsed;
		if (this.leftSplitWasOpen) ws.leftSplit.collapse();
		if (this.rightSplitWasOpen) ws.rightSplit.collapse();

		this.renderComponent = new Component();
		this.renderComponent.load();

		this.highlightManager = new HighlightManager(
			this.app,
			this.file,
			this.renderComponent
		);
		this.scriptureExpander = new ScriptureExpander(
			this.app,
			this.plugin.settings.csbFolderPath,
			this.renderComponent,
			""
		);
		this.formatManager = new FormatManager(this.app, this.file);

		this.buildUI();
		await this.requestWakeLock();
		this.suppressEdgeSwipes();

		if (this.file) {
			await this.renderFile(this.file);
		}

		// Re-render when the source file is saved (e.g. after editing)
		this.registerEvent(
			this.app.vault.on("modify", (modified) => {
				if (this.file && modified.path === this.file.path) {
					void this.renderFile(this.file);
				}
			})
		);

		// Track this leaf so pills can switch focus back to it
		this.preachLeaf = this.leaf;

		// Inject back-pill whenever a new leaf becomes active
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				this.maybeInjectBackPill(leaf);
			})
		);

		// Remove pills for leaves that have been closed
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.pruneEditPills();
			})
		);

		this.timer.start();
	}

	async onClose(): Promise<void> {
		if (this.idleTimeout !== null) {
			window.clearTimeout(this.idleTimeout);
			this.idleTimeout = null;
		}
		this.cleanupEditPills();

		// Restore the view-header when leaving preach mode
		if (this.viewHeaderEl) {
			this.viewHeaderEl.classList.remove("preach-view-header--hidden");
			this.viewHeaderEl = null;
		}

		// Remove body class to restore global chrome
		document.body.removeClass("preach-md-active");

		// Restore sidebars only if they were open before preach mode started
		const ws = this.app.workspace;
		if (this.leftSplitWasOpen) ws.leftSplit.expand();
		if (this.rightSplitWasOpen) ws.rightSplit.expand();
		this.leftSplitWasOpen = false;
		this.rightSplitWasOpen = false;

		this.timer.stop();
		await this.releaseWakeLock();
		this.restoreEdgeSwipes();
		this.renderComponent.unload();
	}

	async setFile(file: TFile): Promise<void> {
		this.file = file;
		if (this.highlightManager) {
			this.highlightManager.updateFile(file);
		}
		if (this.formatManager) {
			this.formatManager.updateFile(file);
		}
		if (this.scrollEl) {
			await this.renderFile(file);
		}
	}

	// Build the full preach UI into containerEl
	private buildUI(): void {
		const root = this.containerEl;
		root.empty();
		root.addClass("preach-md-root");

		// Scrollable content area - built first so it sits behind the top bar
		this.scrollEl = root.createEl("div", { cls: "preach-content" });
		this.scrollEl.addEventListener("scroll", () => {
			this.savedScrollTop = this.scrollEl.scrollTop;
			this.resetIdleTimer();
		});

		// Single top bar spanning full width
		this.topBar = root.createEl("div", { cls: "preach-top-bar" });

		// Left group: outline
		const leftGroup = this.topBar.createEl("div", { cls: "preach-top-bar-group preach-top-bar-group--left" });

		this.outlineBtn = leftGroup.createEl("button", {
			cls: "preach-top-btn preach-top-btn--fadeable",
			attr: { "aria-label": "Outline", title: "Outline" },
		});
		const outlineSvg = this.outlineBtn.createSvg("svg", {
			attr: { xmlns: "http://www.w3.org/2000/svg", width: "22", height: "22", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" },
		});
		outlineSvg.createSvg("line", { attr: { x1: "3", y1: "6", x2: "21", y2: "6" } });
		outlineSvg.createSvg("line", { attr: { x1: "3", y1: "12", x2: "15", y2: "12" } });
		outlineSvg.createSvg("line", { attr: { x1: "3", y1: "18", x2: "18", y2: "18" } });
		this.outlineBtn.addEventListener("pointerdown", (e: PointerEvent) => {
			e.stopPropagation();
			this.resetIdleTimer();
			this.toggleOutline();
		});

		// Centre group: timer (always visible - not fadeable)
		const centreGroup = this.topBar.createEl("div", { cls: "preach-top-bar-group preach-top-bar-group--centre" });
		this.timerEl = centreGroup.createEl("div", { cls: "preach-timer-wrap" });
		this.timer = new PreachTimer(this.timerEl, {
			targetMinutes: this.plugin.settings.targetMinutes,
			warnMinutes: this.plugin.settings.warnMinutes,
			critMinutes: this.plugin.settings.critMinutes,
		});

		// Right group: format (placeholder), edit, exit
		const rightGroup = this.topBar.createEl("div", { cls: "preach-top-bar-group preach-top-bar-group--right" });

		// Format button (placeholder - wired in Phase 3)
		this.formatBtn = rightGroup.createEl("button", {
			cls: "preach-top-btn preach-top-btn--fadeable preach-format-btn",
			attr: { "aria-label": "Format text", title: "Format" },
		});
		const formatSvg = this.formatBtn.createSvg("svg", {
			attr: { xmlns: "http://www.w3.org/2000/svg", width: "20", height: "20", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" },
		});
		// "type" icon: T with serifs
		formatSvg.createSvg("polyline", { attr: { points: "4 7 4 4 20 4 20 7" } });
		formatSvg.createSvg("line", { attr: { x1: "9", y1: "20", x2: "15", y2: "20" } });
		formatSvg.createSvg("line", { attr: { x1: "12", y1: "4", x2: "12", y2: "20" } });
		this.formatBtn.addEventListener("pointerdown", (e: PointerEvent) => {
			e.stopPropagation();
			this.resetIdleTimer();
			this.formatManager.activate();
		});

		// Edit button
		this.editBtn = rightGroup.createEl("button", {
			cls: "preach-top-btn preach-top-btn--fadeable",
			attr: { "aria-label": "Edit note", title: "Edit" },
		});
		const editSvg = this.editBtn.createSvg("svg", {
			attr: { xmlns: "http://www.w3.org/2000/svg", width: "20", height: "20", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" },
		});
		editSvg.createSvg("path", { attr: { d: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" } });
		editSvg.createSvg("path", { attr: { d: "M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" } });
		this.editBtn.addEventListener("pointerdown", (e: PointerEvent) => {
			e.stopPropagation();
			this.resetIdleTimer();
			this.goToEdit();
		});

		// Exit button with confirm chip
		const exitWrap = rightGroup.createEl("div", { cls: "preach-exit-wrap preach-top-btn--fadeable" });
		this.exitChip = exitWrap.createEl("span", {
			cls: "preach-exit-chip",
			text: "Exit?",
		});
		this.exitBtn = exitWrap.createEl("button", {
			cls: "preach-top-btn",
			attr: { "aria-label": "Exit preach mode", title: "Exit" },
		});
		const exitSvg = this.exitBtn.createSvg("svg", {
			attr: { xmlns: "http://www.w3.org/2000/svg", width: "20", height: "20", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" },
		});
		exitSvg.createSvg("line", { attr: { x1: "18", y1: "6", x2: "6", y2: "18" } });
		exitSvg.createSvg("line", { attr: { x1: "6", y1: "6", x2: "18", y2: "18" } });
		this.exitBtn.addEventListener("pointerdown", (e: PointerEvent) => {
			e.stopPropagation();
			this.resetIdleTimer();
			this.handleExit();
		});

		// Idle-fade: reset on any tap on the scroll area
		this.scrollEl.addEventListener("pointerdown", () => {
			this.resetIdleTimer();
		});

		// Wire the highlight manager to its content area (button removed)
		this.highlightManager.init(null, this.scrollEl, this.scrollEl);

		// Outline overlay (hidden by default)
		this.overlayEl = root.createEl("div", {
			cls: "preach-outline-overlay preach-outline-overlay--hidden",
		});
		this.overlayEl.addEventListener("pointerdown", (e: PointerEvent) => {
			if (e.target === this.overlayEl) {
				this.closeOutline();
			}
		});

		// Format toolbar (hidden until format mode activates)
		this.formatToolbar = this.buildFormatToolbar(root);

		// Wire format manager callbacks
		this.formatManager.onActivate = () => {
			this.scrollEl.addClass("preach-format-active");
			this.formatToolbar.classList.remove("preach-format-toolbar--hidden");
			this.formatBtn.classList.add("preach-top-btn--format-on");
		};
		this.formatManager.onDeactivate = () => {
			this.scrollEl.removeClass("preach-format-active");
			this.formatToolbar.classList.add("preach-format-toolbar--hidden");
			this.formatBtn.classList.remove("preach-top-btn--format-on");
		};

		// Start idle timer immediately
		this.resetIdleTimer();
	}

	/** Build the secondary format toolbar and return it (initially hidden). */
	private buildFormatToolbar(root: HTMLElement): HTMLElement {
		const toolbar = root.createEl("div", {
			cls: "preach-format-toolbar preach-format-toolbar--hidden",
		});

		const makeFormatBtn = (label: string, title: string, handler: () => void): HTMLElement => {
			const btn = toolbar.createEl("button", {
				cls: "preach-fmt-btn",
				attr: { "aria-label": title, title },
			});
			btn.textContent = label;
			// Capture selection on pointerdown BEFORE focus change clears it,
			// then apply format. preventDefault keeps the text selection alive.
			btn.addEventListener("pointerdown", (e: PointerEvent) => {
				e.preventDefault();
				e.stopPropagation();
				const captured = this.formatManager.captureCurrentSelection(this.scrollEl);
				if (captured) {
					handler();
				}
			});
			return btn;
		};

		makeFormatBtn("B", "Bold", () => {
			void this.formatManager.applyFormat(FORMAT_BOLD);
		});
		makeFormatBtn("I", "Italic", () => {
			void this.formatManager.applyFormat(FORMAT_ITALIC);
		});
		makeFormatBtn("U", "Underline", () => {
			void this.formatManager.applyFormat(FORMAT_UNDERLINE);
		});
		makeFormatBtn("H", "Highlight", () => {
			void this.formatManager.applyFormat(FORMAT_HIGHLIGHT);
		});

		// Done button
		const doneBtn = toolbar.createEl("button", {
			cls: "preach-fmt-btn preach-fmt-btn--done",
			attr: { "aria-label": "Done formatting", title: "Done" },
			text: "Done",
		});
		doneBtn.addEventListener("pointerdown", (e: PointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			this.formatManager.deactivate();
		});

		return toolbar;
	}

	// Idle-fade: show controls, then fade after 3 seconds of no interaction.
	private resetIdleTimer(): void {
		// Reveal all fadeable controls
		this.topBar?.classList.remove("preach-top-bar--idle");

		if (this.idleTimeout !== null) {
			window.clearTimeout(this.idleTimeout);
		}
		this.idleTimeout = window.setTimeout(() => {
			this.topBar?.classList.add("preach-top-bar--idle");
			this.idleTimeout = null;
		}, 3000);
	}

	// Render the file into the scroll area using block-by-block rendering
	private async renderFile(file: TFile): Promise<void> {
		const scrollTop = this.savedScrollTop;
		this.scriptureExpander.collapseAll();
		this.scrollEl.empty();

		const markdown = await this.app.vault.read(file);
		const blocks = parseBlocks(markdown);

		// Keep a reference for scroll-sync in goToEdit
		this.blocks = blocks;

		// Store blocks in highlight manager and format manager
		this.highlightManager.attachBlocks(blocks);
		if (this.formatManager) {
			this.formatManager.updateBlocks(blocks);
		}

		const body = this.scrollEl.createEl("div", { cls: "preach-body" });

		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i];
			const wrapper = body.createEl("div", {
				cls: "preach-block",
				attr: {
					"data-block-index": String(i),
					"data-highlightable": block.highlightable ? "true" : "false",
				},
			});

			await MarkdownRenderer.render(
				this.app,
				block.content,
				wrapper,
				file.path,
				this.renderComponent
			);

			if (block.highlightable) {
				wrapper.addEventListener("pointerdown", (e: PointerEvent) => {
					// Only handle in highlight mode; ignore if user is tapping a scripture ref
					const target = e.target as HTMLElement;
					if (target.closest(".preach-scripture-ref") || target.closest(".preach-scripture-expand")) {
						return;
					}
					if (this.highlightManager.isActive()) {
						e.stopPropagation();
						void this.highlightManager.handleBlockTap(i).then(() => {
							// Re-render after highlight change
							void this.renderFile(file);
						});
					}
				});
			}
		}

		// Scripture detection pass
		this.scriptureExpander.updateSourcePath(file.path);
		this.scriptureExpander.processElement(body);

		// Tag headings so outline works
		this.tagRenderedHeadings(body, markdown);

		// Restore scroll position after render
		window.requestAnimationFrame(() => {
			this.scrollEl.scrollTop = scrollTop;
		});
	}

	/**
	 * Attach data-preach-slug to rendered heading elements so the outline
	 * can call scrollIntoView on them by reference.
	 */
	private tagRenderedHeadings(wrapper: HTMLElement, markdown: string): void {
		const level = this.plugin.settings.sectionHeadingLevel;
		const headings = extractHeadings(markdown, level);
		const tag = `h${level}`;
		const rendered = wrapper.querySelectorAll<HTMLElement>(tag);

		rendered.forEach((el, i) => {
			if (headings[i]) {
				el.dataset.preachSlug = headings[i].slug;
			}
		});
	}

	// Outline overlay controls
	private toggleOutline(): void {
		if (!this.overlayEl.classList.contains("preach-outline-overlay--hidden")) {
			this.closeOutline();
			return;
		}
		this.openOutline();
	}

	private openOutline(): void {
		if (!this.file) return;

		// Rebuild panel each time (file may have changed)
		const panel =
			this.overlayEl.querySelector<HTMLElement>(".preach-outline-panel") ??
			this.overlayEl.createEl("div", { cls: "preach-outline-panel" });
		panel.empty();

		const level = this.plugin.settings.sectionHeadingLevel;
		const tag = `h${level}`;
		const headingEls = this.scrollEl.querySelectorAll<HTMLElement>(tag);

		if (headingEls.length === 0) {
			panel.createEl("p", {
				cls: "preach-outline-empty",
				text: "No sections found.",
			});
		} else {
			headingEls.forEach((el) => {
				const btn = panel.createEl("button", {
					cls: "preach-outline-item",
					text: el.textContent ?? "",
				});
				btn.addEventListener("pointerdown", (e: PointerEvent) => {
					e.stopPropagation();
					el.scrollIntoView({ behavior: "smooth", block: "start" });
					this.closeOutline();
				});
			});
		}

		this.overlayEl.classList.remove("preach-outline-overlay--hidden");
	}

	private closeOutline(): void {
		this.overlayEl.classList.add("preach-outline-overlay--hidden");
	}

	// Exit two-step confirmation
	private handleExit(): void {
		if (this.exitConfirming) {
			this.confirmExit();
			return;
		}

		this.exitConfirming = true;
		this.exitChip.classList.add("preach-exit-chip--visible");

		this.exitConfirmTimeout = window.setTimeout(() => {
			this.exitConfirming = false;
			this.exitChip.classList.remove("preach-exit-chip--visible");
			this.exitConfirmTimeout = null;
		}, 3000);
	}

	private confirmExit(): void {
		if (this.exitConfirmTimeout !== null) {
			window.clearTimeout(this.exitConfirmTimeout);
			this.exitConfirmTimeout = null;
		}
		this.exitConfirming = false;
		this.exitChip.classList.remove("preach-exit-chip--visible");
		this.leaf.detach();
	}

	// Find the 0-indexed source line of the topmost visible preach block.
	private getTopmostVisibleLine(): number | null {
		const blockEls = this.scrollEl.querySelectorAll<HTMLElement>(".preach-block");
		for (const el of Array.from(blockEls)) {
			if (el.getBoundingClientRect().bottom > 0) {
				const idx = parseInt(el.dataset.blockIndex ?? "", 10);
				if (!isNaN(idx) && this.blocks[idx] !== undefined) {
					return this.blocks[idx].startLine;
				}
			}
		}
		return null;
	}

	// Edit round-trip: open the file in an edit leaf, scrolled to current position.
	private goToEdit(): void {
		if (!this.file) return;

		this.savedScrollTop = this.scrollEl.scrollTop;

		const startLine = this.getTopmostVisibleLine();

		const existingLeaf = this.app.workspace
			.getLeavesOfType("markdown")
			.find(
				(l) =>
					(l.view as { file?: TFile }).file?.path === this.file?.path
			);

		if (existingLeaf) {
			this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
			if (startLine !== null) {
				setTimeout(() => {
					(existingLeaf.view as { setEphemeralState?: (s: object) => void })
						.setEphemeralState?.({ line: startLine });
				}, 0);
			}
			setTimeout(() => this.maybeInjectBackPill(existingLeaf), 0);
		} else {
			const leaf = this.app.workspace.getLeaf("tab");
			if (this.file) {
				const eState: Record<string, unknown> = { mode: "source" };
				if (startLine !== null) eState.line = startLine;
				void leaf.openFile(this.file, { active: true, eState });
				setTimeout(() => this.maybeInjectBackPill(leaf), 0);
			}
		}
	}

	// Back-pill: inject a floating button into editor leaves that show the sermon file
	private maybeInjectBackPill(leaf: WorkspaceLeaf | null): void {
		if (!leaf || !this.file || leaf === this.preachLeaf) return;

		const leafFile = (leaf.view as { file?: TFile }).file;
		if (leafFile?.path !== this.file.path) return;

		if (this.editPills.has(leaf)) return;

		const host = leaf.view.containerEl;

		const pill = document.createElement("button");
		pill.className = "preach-back-pill";
		pill.textContent = "← Preach";
		pill.setAttribute("aria-label", "Back to preach mode");

		pill.addEventListener("pointerdown", (e: PointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.preachLeaf) {
				this.app.workspace.setActiveLeaf(this.preachLeaf, { focus: true });
			}
		});

		host.appendChild(pill);
		this.editPills.set(leaf, pill);
	}

	// Remove pills for leaves that are no longer in the workspace
	private pruneEditPills(): void {
		for (const [leaf, pill] of this.editPills) {
			if (!pill.isConnected) {
				pill.remove();
				this.editPills.delete(leaf);
			}
		}
	}

	// Remove all pills - called when preach mode exits
	private cleanupEditPills(): void {
		for (const [, pill] of this.editPills) {
			pill.remove();
		}
		this.editPills.clear();
		this.preachLeaf = null;
	}

	// Screen wake lock
	private async requestWakeLock(): Promise<void> {
		try {
			if ("wakeLock" in navigator) {
				const nav = navigator as Navigator & { wakeLock: WakeLockAPI };
				this.wakeLock = await nav.wakeLock.request("screen");
			}
		} catch {
			// Wake lock unavailable - non-fatal
		}
	}

	private async releaseWakeLock(): Promise<void> {
		try {
			if (this.wakeLock) {
				await this.wakeLock.release();
				this.wakeLock = null;
			}
		} catch {
			// Ignore release errors
		}
	}

	// Suppress edge-swipe gestures (Obsidian Mobile sidebar open)
	private suppressEdgeSwipes(): void {
		this.touchHandler = (e: TouchEvent) => {
			if (e.touches.length === 1) {
				const x = e.touches[0].clientX;
				if (x < 30 || x > window.innerWidth - 30) {
					e.stopPropagation();
				}
			}
		};
		document.addEventListener("touchstart", this.touchHandler, {
			capture: true,
			passive: true,
		});
	}

	private restoreEdgeSwipes(): void {
		if (this.touchHandler) {
			document.removeEventListener("touchstart", this.touchHandler, {
				capture: true,
			});
			this.touchHandler = null;
		}
	}
}
