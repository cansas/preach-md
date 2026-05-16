// Format mode for Preach MD.
// Provides bold, italic, underline, and highlight wrapping applied directly
// to the source file from selected text in the preach view.

import { App, TFile } from "obsidian";
import type { Block } from "./highlight";

export interface FormatWrapper {
	open: string;
	close: string;
}

export const FORMAT_BOLD: FormatWrapper = { open: "**", close: "**" };
export const FORMAT_ITALIC: FormatWrapper = { open: "*", close: "*" };
export const FORMAT_UNDERLINE: FormatWrapper = { open: "<u>", close: "</u>" };
export const FORMAT_HIGHLIGHT: FormatWrapper = { open: "==", close: "==" };

/** Result returned by captureFromSelection. */
export interface CaptureResult {
	/** Bounding rect of the selection range (for toolbar positioning). */
	rect: DOMRect;
}

export class FormatManager {
	private app: App;
	private file: TFile | null;
	private blocks: Block[] = [];

	// The selection captured on pointerdown (before focus changes clear it)
	private capturedSelection: { text: string; blockIndex: number } | null = null;

	// Reused notice element
	private noticeEl: HTMLElement | null = null;
	private noticeTimeout: number | null = null;

	constructor(app: App, file: TFile | null) {
		this.app = app;
		this.file = file;
	}

	updateFile(file: TFile): void {
		this.file = file;
	}

	updateBlocks(blocks: Block[]): void {
		this.blocks = blocks;
	}

	/**
	 * Inspect the current window selection, validate it is inside the preach body,
	 * not cross-block, not inside a scripture expand, and capture it.
	 *
	 * Returns a CaptureResult on success (with selection bounding rect),
	 * or null if the selection is empty, collapsed, or out of bounds.
	 * On a bail condition (cross-block, scripture, etc.) calls showFormatFailNotice
	 * and returns null.
	 */
	captureFromSelection(bodyEl: HTMLElement): CaptureResult | null {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

		const selectedText = sel.toString().trim();
		if (!selectedText) return null;

		// Check the selection is inside the preach body
		const range = sel.getRangeAt(0);
		if (!bodyEl.contains(range.commonAncestorContainer)) return null;

		// Bail if selection is inside a scripture expansion
		let node: Node | null = sel.anchorNode;
		while (node) {
			if (node instanceof HTMLElement) {
				if (node.classList.contains("preach-scripture-expand")) {
					this.showFormatFailNotice("scripture-expand");
					return null;
				}
			}
			node = node.parentNode;
		}

		// Walk anchor node up to find .preach-block
		let blockEl: HTMLElement | null = null;
		node = sel.anchorNode;
		while (node) {
			if (node instanceof HTMLElement && node.classList.contains("preach-block")) {
				blockEl = node;
				break;
			}
			node = node.parentNode;
		}

		if (!blockEl) return null;

		// Check selection doesn't span multiple preach-blocks
		let focusBlockEl: HTMLElement | null = null;
		let fn: Node | null = sel.focusNode;
		while (fn) {
			if (fn instanceof HTMLElement && fn.classList.contains("preach-block")) {
				focusBlockEl = fn;
				break;
			}
			fn = fn.parentNode;
		}
		if (focusBlockEl !== blockEl) {
			this.showFormatFailNotice("cross-block");
			return null;
		}

		const blockIndex = parseInt(blockEl.dataset.blockIndex ?? "", 10);
		if (isNaN(blockIndex)) return null;

		const block = this.blocks[blockIndex];
		if (!block) return null;

		const sourceContent = block.content;

		// Try to find selected text in source block
		let sourceIdx = sourceContent.indexOf(selectedText);

		if (sourceIdx === -1) {
			// Fuzzy fallback: strip common markdown markers from source before searching.
			const stripped = sourceContent.replace(/[*_~=<>/]/g, "");
			const strippedIdx = stripped.indexOf(selectedText);
			if (strippedIdx !== -1) {
				// Map the stripped index back to source index
				let srcPos = 0;
				let strippedCount = 0;
				while (srcPos < sourceContent.length && strippedCount < strippedIdx) {
					if (!/[*_~=<>/]/.test(sourceContent[srcPos])) strippedCount++;
					srcPos++;
				}
				sourceIdx = srcPos;
			}
		}

		if (sourceIdx === -1) {
			this.showFormatFailNotice("not-found");
			return null;
		}

		// Collision check: is this position already inside an existing wrapper?
		const before = sourceContent.slice(0, sourceIdx);
		const after = sourceContent.slice(sourceIdx + selectedText.length);
		const wrappers = ["**", "*", "==", "<u>"];
		for (const w of wrappers) {
			if (before.endsWith(w) && after.startsWith(w === "**" ? "**" : w === "*" ? "*" : w === "==" ? "==" : "</u>")) {
				this.showFormatFailNotice("collision");
				return null;
			}
		}

		this.capturedSelection = { text: selectedText, blockIndex };

		const rect = range.getBoundingClientRect();
		return { rect };
	}

	/**
	 * Called from a pointerdown handler on a format button in the editor.
	 * Must read window.getSelection() immediately before focus changes lose it.
	 */
	captureCurrentSelection(scrollEl: HTMLElement): boolean {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;

		const selectedText = sel.toString().trim();
		if (!selectedText) return false;

		// Walk anchor node up to find .preach-block
		let node: Node | null = sel.anchorNode;
		let blockEl: HTMLElement | null = null;
		while (node) {
			if (node instanceof HTMLElement) {
				if (node.classList.contains("preach-scripture-expand")) return false;
				if (node.classList.contains("preach-block")) {
					blockEl = node;
					break;
				}
			}
			node = node.parentNode;
		}

		if (!blockEl) return false;

		// Check selection doesn't span multiple preach-blocks
		const focusNode = sel.focusNode;
		let focusBlockEl: HTMLElement | null = null;
		let fn: Node | null = focusNode;
		while (fn) {
			if (fn instanceof HTMLElement && fn.classList.contains("preach-block")) {
				focusBlockEl = fn;
				break;
			}
			fn = fn.parentNode;
		}
		if (focusBlockEl !== blockEl) {
			console.warn("preach-md format: selection spans multiple blocks, ignoring");
			return false;
		}

		const blockIndex = parseInt(blockEl.dataset.blockIndex ?? "", 10);
		if (isNaN(blockIndex)) return false;

		this.capturedSelection = { text: selectedText, blockIndex };
		return true;
	}

	/**
	 * Apply a format wrapper around the previously captured selection.
	 * Writes to the source file via vault.process().
	 */
	async applyFormat(wrapper: FormatWrapper): Promise<void> {
		if (!this.capturedSelection || !this.file) return;

		const { text: selectedText, blockIndex } = this.capturedSelection;
		const block = this.blocks[blockIndex];
		if (!block) return;

		const sourceContent = block.content;

		let sourceIdx = sourceContent.indexOf(selectedText);

		if (sourceIdx === -1) {
			const stripped = sourceContent.replace(/[*_~=]/g, "");
			const strippedIdx = stripped.indexOf(selectedText);
			if (strippedIdx !== -1) {
				let srcPos = 0;
				let strippedCount = 0;
				while (srcPos < sourceContent.length && strippedCount < strippedIdx) {
					if (!/[*_~=]/.test(sourceContent[srcPos])) strippedCount++;
					srcPos++;
				}
				sourceIdx = srcPos;
			}
		}

		if (sourceIdx === -1) {
			console.warn("preach-md format: could not locate selected text in source block, ignoring");
			return;
		}

		const absoluteStart = block.startOffset + sourceIdx;
		const absoluteEnd = absoluteStart + selectedText.length;

		await this.app.vault.process(this.file, (data) => {
			return (
				data.slice(0, absoluteStart) +
				wrapper.open +
				data.slice(absoluteStart, absoluteEnd) +
				wrapper.close +
				data.slice(absoluteEnd)
			);
		});

		this.capturedSelection = null;
	}

	/** Show a brief notice near the selection area that formatting failed. */
	showFormatFailNotice(reason: string): void {
		console.log("preach-md format-fail:", reason);

		// Ensure a single notice element exists
		if (!this.noticeEl) {
			this.noticeEl = document.createElement("div");
			this.noticeEl.className = "preach-format-fail-notice";
			this.noticeEl.textContent = "Can't format here. Use the edit button for changes.";
			this.noticeEl.addEventListener("pointerdown", () => this.hideFormatFailNotice());
		}

		// Attach to body if not already
		if (!this.noticeEl.isConnected) {
			document.body.appendChild(this.noticeEl);
		}

		// Position near centre of viewport - no selection rect available at notice time
		this.noticeEl.classList.add("preach-format-fail-notice--visible");

		if (this.noticeTimeout !== null) window.clearTimeout(this.noticeTimeout);
		this.noticeTimeout = window.setTimeout(() => this.hideFormatFailNotice(), 3000);
	}

	/** Position and show notice near a specific rect. */
	showFormatFailNoticeAt(rect: DOMRect): void {
		console.log("preach-md format-fail near selection");
		if (!this.noticeEl) {
			this.noticeEl = document.createElement("div");
			this.noticeEl.className = "preach-format-fail-notice";
			this.noticeEl.textContent = "Can't format here. Use the edit button for changes.";
			this.noticeEl.addEventListener("pointerdown", () => this.hideFormatFailNotice());
		}
		if (!this.noticeEl.isConnected) document.body.appendChild(this.noticeEl);

		this.positionNotice(rect);
		this.noticeEl.classList.add("preach-format-fail-notice--visible");

		if (this.noticeTimeout !== null) window.clearTimeout(this.noticeTimeout);
		this.noticeTimeout = window.setTimeout(() => this.hideFormatFailNotice(), 3000);
	}

	private hideFormatFailNotice(): void {
		if (this.noticeTimeout !== null) {
			window.clearTimeout(this.noticeTimeout);
			this.noticeTimeout = null;
		}
		this.noticeEl?.classList.remove("preach-format-fail-notice--visible");
	}

	private positionNotice(rect: DOMRect): void {
		if (!this.noticeEl) return;
		const TOOLBAR_H = 36;
		const MARGIN = 8;
		const vpW = window.innerWidth;

		// Temporarily show off-screen to measure width
		this.noticeEl.style.visibility = "hidden";
		this.noticeEl.style.top = "-9999px";
		this.noticeEl.style.left = "-9999px";

		const noticeW = this.noticeEl.offsetWidth || 260;
		const midX = rect.left + rect.width / 2;
		let left = midX - noticeW / 2;
		left = Math.max(8, Math.min(vpW - noticeW - 8, left));

		let top: number;
		if (rect.top > TOOLBAR_H + MARGIN) {
			top = rect.top - TOOLBAR_H - MARGIN;
		} else {
			top = rect.bottom + MARGIN;
		}

		this.noticeEl.style.left = `${left}px`;
		this.noticeEl.style.top = `${top}px`;
		this.noticeEl.style.visibility = "";
	}

	/** Clean up any notice elements (call on view close). */
	destroy(): void {
		if (this.noticeTimeout !== null) window.clearTimeout(this.noticeTimeout);
		this.noticeEl?.remove();
		this.noticeEl = null;
	}
}

/**
 * Manages a floating format toolbar in the preach view.
 * Registers a selectionchange listener; shows/hides the toolbar
 * based on whether a valid selection exists inside .preach-body.
 *
 * bodyElGetter is called on each selection event so it always has
 * the current body element (which is replaced on every renderFile call).
 */
export class PreachFormatToolbar {
	private formatManager: FormatManager;
	private bodyElGetter: () => HTMLElement | null;
	private containerEl: HTMLElement;
	private toolbarEl: HTMLElement;
	private selectionChangeHandler: () => void;
	private visible = false;

	constructor(
		formatManager: FormatManager,
		bodyElGetter: () => HTMLElement | null,
		containerEl: HTMLElement
	) {
		this.formatManager = formatManager;
		this.bodyElGetter = bodyElGetter;
		this.containerEl = containerEl;

		this.toolbarEl = this.buildToolbar();
		this.containerEl.appendChild(this.toolbarEl);

		this.selectionChangeHandler = () => this.onSelectionChange();
		document.addEventListener("selectionchange", this.selectionChangeHandler);
	}

	private buildToolbar(): HTMLElement {
		const bar = document.createElement("div");
		bar.className = "preach-inline-format-bar";
		bar.setAttribute("aria-label", "Format selection");

		const makeBtn = (
			label: string,
			title: string,
			wrapper: FormatWrapper,
			extraClass?: string
		): void => {
			const btn = document.createElement("button");
			btn.className = "preach-inline-fmt-btn" + (extraClass ? " " + extraClass : "");
			btn.setAttribute("aria-label", title);
			btn.setAttribute("title", title);
			// Prevent text selection on toolbar buttons
			btn.style.userSelect = "none";
			(btn.style as CSSStyleDeclaration & { webkitUserSelect: string }).webkitUserSelect = "none";

			if (label === "H") {
				// Highlight icon: small coloured square
				btn.innerHTML = '<span style="display:inline-block;width:13px;height:13px;background:#ffd24a;border-radius:2px;vertical-align:middle;"></span>';
			} else {
				btn.textContent = label;
			}

			// pointerdown + preventDefault keeps the selection alive while focus moves
			btn.addEventListener("pointerdown", (e: PointerEvent) => {
				e.preventDefault();
				e.stopPropagation();

				const currentBody = this.bodyElGetter();
				if (!currentBody) { this.hide(); return; }

				// Capture from the live selection right now
				const result = this.formatManager.captureFromSelection(currentBody);
				if (!result) {
					// captureFromSelection already called showFormatFailNotice on bail conditions
					this.hide();
					return;
				}
				// Apply asynchronously
				void this.formatManager.applyFormat(wrapper).then(() => {
					this.hide();
					window.getSelection()?.removeAllRanges();
				});
			});

			bar.appendChild(btn);
		};

		makeBtn("B", "Bold", FORMAT_BOLD, "preach-inline-fmt-btn--bold");
		makeBtn("I", "Italic", FORMAT_ITALIC, "preach-inline-fmt-btn--italic");
		makeBtn("U", "Underline", FORMAT_UNDERLINE, "preach-inline-fmt-btn--underline");
		makeBtn("H", "Highlight", FORMAT_HIGHLIGHT, "preach-inline-fmt-btn--highlight");

		return bar;
	}

	private onSelectionChange(): void {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
			this.hide();
			return;
		}

		const selectedText = sel.toString().trim();
		if (!selectedText) {
			this.hide();
			return;
		}

		// Check the common ancestor is inside the preach body
		const range = sel.getRangeAt(0);
		const currentBody = this.bodyElGetter();
		if (!currentBody || !currentBody.contains(range.commonAncestorContainer)) {
			this.hide();
			return;
		}

		const rect = range.getBoundingClientRect();
		this.position(rect);
		this.show();
	}

	private position(rect: DOMRect): void {
		const TOOLBAR_H = 52; // approximate toolbar height including margin
		const MARGIN = 8;
		const vpW = window.innerWidth;

		const toolbarW = this.toolbarEl.offsetWidth || 200;
		const midX = rect.left + rect.width / 2;
		let left = midX - toolbarW / 2;
		left = Math.max(8, Math.min(vpW - toolbarW - 8, left));

		let top: number;
		if (rect.top > TOOLBAR_H + MARGIN) {
			top = rect.top - TOOLBAR_H - MARGIN;
		} else {
			top = rect.bottom + MARGIN;
		}

		this.toolbarEl.style.left = `${left}px`;
		this.toolbarEl.style.top = `${top}px`;
	}

	private show(): void {
		if (!this.visible) {
			this.toolbarEl.classList.add("preach-inline-format-bar--visible");
			this.visible = true;
		}
	}

	private hide(): void {
		if (this.visible) {
			this.toolbarEl.classList.remove("preach-inline-format-bar--visible");
			this.visible = false;
		}
	}

	destroy(): void {
		document.removeEventListener("selectionchange", this.selectionChangeHandler);
		this.toolbarEl.remove();
	}
}
