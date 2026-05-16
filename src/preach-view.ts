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
	private overlayEl!: HTMLElement;
	private exitChip!: HTMLElement;

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
		if (this.scrollEl) {
			await this.renderFile(file);
		}
	}

	// Build the full preach UI into containerEl
	private buildUI(): void {
		const root = this.containerEl;
		root.empty();
		root.addClass("preach-md-root");

		// Scrollable content area
		this.scrollEl = root.createEl("div", { cls: "preach-content" });
		this.scrollEl.addEventListener("scroll", () => {
			this.savedScrollTop = this.scrollEl.scrollTop;
		});

		// Timer pill (top-centre)
		this.timerEl = root.createEl("div", { cls: "preach-timer-wrap" });
		this.timer = new PreachTimer(this.timerEl, {
			targetMinutes: this.plugin.settings.targetMinutes,
			warnMinutes: this.plugin.settings.warnMinutes,
			critMinutes: this.plugin.settings.critMinutes,
		});

		// Corner controls container
		const corners = root.createEl("div", { cls: "preach-corners" });

		// Top-left: outline
		this.outlineBtn = corners.createEl("button", {
			cls: "preach-corner preach-corner--top-left",
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
			this.toggleOutline();
		});

		// Top-right: exit (with confirm chip above the button)
		const exitWrap = corners.createEl("div", {
			cls: "preach-corner-wrap preach-corner-wrap--top-right",
		});
		this.exitChip = exitWrap.createEl("span", {
			cls: "preach-exit-chip",
			text: "Exit?",
		});
		this.exitBtn = exitWrap.createEl("button", {
			cls: "preach-corner preach-corner--top-right",
			attr: { "aria-label": "Exit preach mode", title: "Exit" },
		});
		const exitSvg = this.exitBtn.createSvg("svg", {
			attr: { xmlns: "http://www.w3.org/2000/svg", width: "22", height: "22", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" },
		});
		exitSvg.createSvg("line", { attr: { x1: "18", y1: "6", x2: "6", y2: "18" } });
		exitSvg.createSvg("line", { attr: { x1: "6", y1: "6", x2: "18", y2: "18" } });
		this.exitBtn.addEventListener("pointerdown", (e: PointerEvent) => {
			e.stopPropagation();
			this.handleExit();
		});

		// Bottom-right: edit
		this.editBtn = corners.createEl("button", {
			cls: "preach-corner preach-corner--bottom-right",
			attr: { "aria-label": "Edit note", title: "Edit" },
		});
		const editSvg = this.editBtn.createSvg("svg", {
			attr: { xmlns: "http://www.w3.org/2000/svg", width: "22", height: "22", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" },
		});
		editSvg.createSvg("path", { attr: { d: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" } });
		editSvg.createSvg("path", { attr: { d: "M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" } });
		this.editBtn.addEventListener("pointerdown", (e: PointerEvent) => {
			e.stopPropagation();
			this.goToEdit();
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
	}

	// Render the file into the scroll area using block-by-block rendering
	private async renderFile(file: TFile): Promise<void> {
		const scrollTop = this.savedScrollTop;
		this.scriptureExpander.collapseAll();
		this.scrollEl.empty();

		const markdown = await this.app.vault.read(file);
		const blocks = parseBlocks(markdown);

		// Store blocks in highlight manager
		this.highlightManager.attachBlocks(blocks);

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

	// Edit round-trip: open the file in an edit leaf, preserving scroll
	private goToEdit(): void {
		if (!this.file) return;

		this.savedScrollTop = this.scrollEl.scrollTop;

		const existingLeaf = this.app.workspace
			.getLeavesOfType("markdown")
			.find(
				(l) =>
					(l.view as { file?: TFile }).file?.path === this.file?.path
			);

		if (existingLeaf) {
			this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
			setTimeout(() => this.maybeInjectBackPill(existingLeaf), 0);
		} else {
			const leaf = this.app.workspace.getLeaf("tab");
			if (this.file) {
				void leaf.openFile(this.file, { active: true });
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
