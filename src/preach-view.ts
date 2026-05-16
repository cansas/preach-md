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
	private savedScrollTop = 0;
	private preachLeaf: WorkspaceLeaf | null = null;
	private editPills: Map<WorkspaceLeaf, HTMLElement> = new Map();
	private scrollEl!: HTMLElement;
	private timerEl!: HTMLElement;
	private outlineBtn!: HTMLElement;
	private exitBtn!: HTMLElement;
	private editBtn!: HTMLElement;
	private bottomBtns!: HTMLElement;
	private overlayEl!: HTMLElement;
	private exitChip!: HTMLElement;
	private idleTimeout: number | null = null;
	private timer!: PreachTimer;
	private wakeLock: WakeLockSentinel | null = null;
	private touchHandler: ((e: TouchEvent) => void) | null = null;
	private exitConfirming = false;
	private exitConfirmTimeout: number | null = null;
	private renderComponent!: Component;
	private highlightManager!: HighlightManager;
	private scriptureExpander!: ScriptureExpander;
	private blocks: ReturnType<typeof parseBlocks> = [];
	private viewHeaderEl: HTMLElement | null = null;
	private leftSplitWasOpen = false;
	private rightSplitWasOpen = false;

	constructor(leaf: WorkspaceLeaf, plugin: PreachMDPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return PREACH_VIEW_TYPE; }
	getDisplayText(): string { return this.file ? this.file.basename : "Preach"; }
	getIcon(): string { return "book-open"; }

	async onOpen(): Promise<void> {
		const leafContent = this.containerEl.closest<HTMLElement>(".workspace-leaf-content");
		if (leafContent) {
			this.viewHeaderEl = leafContent.querySelector<HTMLElement>(".view-header");
			if (this.viewHeaderEl) this.viewHeaderEl.classList.add("preach-view-header--hidden");
		}
		document.body.addClass("preach-md-active");
		const ws = this.app.workspace;
		this.leftSplitWasOpen = !ws.leftSplit.collapsed;
		this.rightSplitWasOpen = !ws.rightSplit.collapsed;
		if (this.leftSplitWasOpen) ws.leftSplit.collapse();
		if (this.rightSplitWasOpen) ws.rightSplit.collapse();
		this.renderComponent = new Component();
		this.renderComponent.load();
		this.highlightManager = new HighlightManager(this.app, this.file, this.renderComponent);
		this.scriptureExpander = new ScriptureExpander(this.app, this.plugin.settings.csbFolderPath, this.renderComponent, "");
		this.buildUI();
		await this.requestWakeLock();
		this.suppressEdgeSwipes();
		if (this.file) await this.renderFile(this.file);
		this.registerEvent(this.app.vault.on("modify", (modified) => {
			if (this.file && modified.path === this.file.path) void this.renderFile(this.file);
		}));
		this.preachLeaf = this.leaf;
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => { this.maybeInjectBackPill(leaf); }));
		this.registerEvent(this.app.workspace.on("layout-change", () => { this.pruneEditPills(); }));
		this.timer.start();
	}

	async onClose(): Promise<void> {
		if (this.idleTimeout !== null) { window.clearTimeout(this.idleTimeout); this.idleTimeout = null; }
		this.cleanupEditPills();
		if (this.viewHeaderEl) { this.viewHeaderEl.classList.remove("preach-view-header--hidden"); this.viewHeaderEl = null; }
		document.body.removeClass("preach-md-active");
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
		if (this.highlightManager) this.highlightManager.updateFile(file);
		if (this.scrollEl) await this.renderFile(file);
	}

	private buildUI(): void {
		const root = this.containerEl;
		root.empty();
		root.addClass("preach-md-root");
		this.scrollEl = root.createEl("div", { cls: "preach-content" });
		this.scrollEl.addEventListener("scroll", () => { this.savedScrollTop = this.scrollEl.scrollTop; this.resetIdleTimer(); });
		this.timerEl = root.createEl("div", { cls: "preach-timer-corner" });
		this.timer = new PreachTimer(this.timerEl, {
			targetMinutes: this.plugin.settings.targetMinutes,
			warnMinutes: this.plugin.settings.warnMinutes,
			critMinutes: this.plugin.settings.critMinutes,
		});
		this.bottomBtns = root.createEl("div", { cls: "preach-bottom-btns" });
		this.outlineBtn = this.bottomBtns.createEl("button", { cls: "preach-corner-btn", attr: { "aria-label": "Outline", title: "Outline" } });
		const outlineSvg = this.outlineBtn.createSvg("svg", { attr: { xmlns: "http://www.w3.org/2000/svg", width: "22", height: "22", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" } });
		outlineSvg.createSvg("line", { attr: { x1: "3", y1: "6", x2: "21", y2: "6" } });
		outlineSvg.createSvg("line", { attr: { x1: "3", y1: "12", x2: "15", y2: "12" } });
		outlineSvg.createSvg("line", { attr: { x1: "3", y1: "18", x2: "18", y2: "18" } });
		this.outlineBtn.addEventListener("pointerdown", (e: PointerEvent) => { e.stopPropagation(); this.resetIdleTimer(); this.toggleOutline(); });
		const rightGroup = this.bottomBtns.createEl("div", { cls: "preach-bottom-right" });
		this.editBtn = rightGroup.createEl("button", { cls: "preach-corner-btn", attr: { "aria-label": "Edit note", title: "Edit" } });
		const editSvg = this.editBtn.createSvg("svg", { attr: { xmlns: "http://www.w3.org/2000/svg", width: "20", height: "20", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" } });
		editSvg.createSvg("path", { attr: { d: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" } });
		editSvg.createSvg("path", { attr: { d: "M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" } });
		this.editBtn.addEventListener("pointerdown", (e: PointerEvent) => { e.stopPropagation(); this.resetIdleTimer(); this.goToEdit(); });
		const exitWrap = rightGroup.createEl("div", { cls: "preach-exit-wrap" });
		this.exitChip = exitWrap.createEl("span", { cls: "preach-exit-chip", text: "Exit?" });
		this.exitBtn = exitWrap.createEl("button", { cls: "preach-corner-btn", attr: { "aria-label": "Exit preach mode", title: "Exit" } });
		const exitSvg = this.exitBtn.createSvg("svg", { attr: { xmlns: "http://www.w3.org/2000/svg", width: "20", height: "20", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" } });
		exitSvg.createSvg("line", { attr: { x1: "18", y1: "6", x2: "6", y2: "18" } });
		exitSvg.createSvg("line", { attr: { x1: "6", y1: "6", x2: "18", y2: "18" } });
		this.exitBtn.addEventListener("pointerdown", (e: PointerEvent) => { e.stopPropagation(); this.resetIdleTimer(); this.handleExit(); });
		this.scrollEl.addEventListener("pointerdown", () => { this.resetIdleTimer(); });
		this.highlightManager.init(null, this.scrollEl, this.scrollEl);
		this.overlayEl = root.createEl("div", { cls: "preach-outline-overlay preach-outline-overlay--hidden" });
		this.overlayEl.addEventListener("pointerdown", (e: PointerEvent) => { if (e.target === this.overlayEl) this.closeOutline(); });
		this.resetIdleTimer();
	}

	private resetIdleTimer(): void {
		this.bottomBtns?.classList.remove("preach-bottom-btns--idle");
		if (this.idleTimeout !== null) window.clearTimeout(this.idleTimeout);
		this.idleTimeout = window.setTimeout(() => {
			this.bottomBtns?.classList.add("preach-bottom-btns--idle");
			this.idleTimeout = null;
		}, 3000);
	}

	private async renderFile(file: TFile): Promise<void> {
		const scrollTop = this.savedScrollTop;
		this.scriptureExpander.collapseAll();
		this.scrollEl.empty();
		const markdown = await this.app.vault.read(file);
		const blocks = parseBlocks(markdown);
		this.blocks = blocks;
		this.highlightManager.attachBlocks(blocks);
		const body = this.scrollEl.createEl("div", { cls: "preach-body" });
		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i];
			const wrapper = body.createEl("div", { cls: "preach-block", attr: { "data-block-index": String(i), "data-highlightable": block.highlightable ? "true" : "false" } });
			await MarkdownRenderer.render(this.app, block.content, wrapper, file.path, this.renderComponent);
			if (block.highlightable) {
				wrapper.addEventListener("pointerdown", (e: PointerEvent) => {
					const target = e.target as HTMLElement;
					if (target.closest(".preach-scripture-ref") || target.closest(".preach-scripture-expand")) return;
					if (this.highlightManager.isActive()) {
						e.stopPropagation();
						void this.highlightManager.handleBlockTap(i).then(() => { void this.renderFile(file); });
					}
				});
			}
		}
		this.scriptureExpander.updateSourcePath(file.path);
		this.scriptureExpander.processElement(body);
		this.tagRenderedHeadings(body, markdown);
		window.requestAnimationFrame(() => { this.scrollEl.scrollTop = scrollTop; });
	}

	private tagRenderedHeadings(wrapper: HTMLElement, markdown: string): void {
		const level = this.plugin.settings.sectionHeadingLevel;
		const headings = extractHeadings(markdown, level);
		const tag = `h${level}`;
		const rendered = wrapper.querySelectorAll<HTMLElement>(tag);
		rendered.forEach((el, i) => { if (headings[i]) el.dataset.preachSlug = headings[i].slug; });
	}

	private toggleOutline(): void {
		if (!this.overlayEl.classList.contains("preach-outline-overlay--hidden")) { this.closeOutline(); return; }
		this.openOutline();
	}

	private openOutline(): void {
		if (!this.file) return;
		const panel = this.overlayEl.querySelector<HTMLElement>(".preach-outline-panel") ?? this.overlayEl.createEl("div", { cls: "preach-outline-panel" });
		panel.empty();
		const level = this.plugin.settings.sectionHeadingLevel;
		const tag = `h${level}`;
		const headingEls = this.scrollEl.querySelectorAll<HTMLElement>(tag);
		if (headingEls.length === 0) {
			panel.createEl("p", { cls: "preach-outline-empty", text: "No sections found." });
		} else {
			headingEls.forEach((el) => {
				const btn = panel.createEl("button", { cls: "preach-outline-item", text: el.textContent ?? "" });
				btn.addEventListener("pointerdown", (e: PointerEvent) => { e.stopPropagation(); el.scrollIntoView({ behavior: "smooth", block: "start" }); this.closeOutline(); });
			});
		}
		this.overlayEl.classList.remove("preach-outline-overlay--hidden");
	}

	private closeOutline(): void { this.overlayEl.classList.add("preach-outline-overlay--hidden"); }

	private handleExit(): void {
		if (this.exitConfirming) { this.confirmExit(); return; }
		this.exitConfirming = true;
		this.exitChip.classList.add("preach-exit-chip--visible");
		this.exitConfirmTimeout = window.setTimeout(() => {
			this.exitConfirming = false;
			this.exitChip.classList.remove("preach-exit-chip--visible");
			this.exitConfirmTimeout = null;
		}, 3000);
	}

	private confirmExit(): void {
		if (this.exitConfirmTimeout !== null) { window.clearTimeout(this.exitConfirmTimeout); this.exitConfirmTimeout = null; }
		this.exitConfirming = false;
		this.exitChip.classList.remove("preach-exit-chip--visible");
		this.leaf.detach();
	}

	private getTopmostVisibleLine(): number | null {
		const blockEls = this.scrollEl.querySelectorAll<HTMLElement>(".preach-block");
		for (const el of Array.from(blockEls)) {
			if (el.getBoundingClientRect().bottom > 0) {
				const idx = parseInt(el.dataset.blockIndex ?? "", 10);
				if (!isNaN(idx) && this.blocks[idx] !== undefined) return this.blocks[idx].startLine;
			}
		}
		return null;
	}

	private goToEdit(): void {
		if (!this.file) return;
		this.savedScrollTop = this.scrollEl.scrollTop;
		const startLine = this.getTopmostVisibleLine();
		const existingLeaf = this.app.workspace.getLeavesOfType("markdown").find((l) => (l.view as { file?: TFile }).file?.path === this.file?.path);
		if (existingLeaf) {
			this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
			if (startLine !== null) setTimeout(() => { (existingLeaf.view as { setEphemeralState?: (s: object) => void }).setEphemeralState?.({ line: startLine }); }, 0);
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
			if (this.preachLeaf) this.app.workspace.setActiveLeaf(this.preachLeaf, { focus: true });
		});
		host.appendChild(pill);
		this.editPills.set(leaf, pill);
	}

	private pruneEditPills(): void {
		for (const [leaf, pill] of this.editPills) {
			if (!pill.isConnected) { pill.remove(); this.editPills.delete(leaf); }
		}
	}

	private cleanupEditPills(): void {
		for (const [, pill] of this.editPills) pill.remove();
		this.editPills.clear();
		this.preachLeaf = null;
	}

	private async requestWakeLock(): Promise<void> {
		try {
			if ("wakeLock" in navigator) {
				const nav = navigator as Navigator & { wakeLock: WakeLockAPI };
				this.wakeLock = await nav.wakeLock.request("screen");
			}
		} catch { /* non-fatal */ }
	}

	private async releaseWakeLock(): Promise<void> {
		try { if (this.wakeLock) { await this.wakeLock.release(); this.wakeLock = null; } } catch { /* ignore */ }
	}

	private suppressEdgeSwipes(): void {
		this.touchHandler = (e: TouchEvent) => {
			if (e.touches.length === 1) {
				const x = e.touches[0].clientX;
				if (x < 30 || x > window.innerWidth - 30) e.stopPropagation();
			}
		};
		document.addEventListener("touchstart", this.touchHandler, { capture: true, passive: true });
	}

	private restoreEdgeSwipes(): void {
		if (this.touchHandler) { document.removeEventListener("touchstart", this.touchHandler, { capture: true }); this.touchHandler = null; }
	}
}
