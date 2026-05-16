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

export class FormatManager {
	private app: App;
	private file: TFile | null;
	private blocks: Block[] = [];
	private active = false;

	// The selection captured on pointerdown (before focus changes clear it)
	private capturedSelection: { text: string; blockIndex: number } | null = null;

	// Callbacks wired by PreachView
	onActivate: (() => void) | null = null;
	onDeactivate: (() => void) | null = null;

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

	isActive(): boolean {
		return this.active;
	}

	activate(): void {
		this.active = true;
		this.capturedSelection = null;
		this.onActivate?.();
	}

	deactivate(): void {
		this.active = false;
		this.capturedSelection = null;
		this.onDeactivate?.();
	}

	/**
	 * Called from a pointerdown handler on a format button.
	 * Must read window.getSelection() immediately - before focus changes lose it.
	 * The anchor node is walked up to find the enclosing .preach-block.
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
				// Bail if selection is inside a scripture expansion
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
			// Spans multiple blocks - bail silently
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

		// Find selected text in the source block
		let sourceIdx = sourceContent.indexOf(selectedText);

		if (sourceIdx === -1) {
			// Fuzzy fallback: strip common markdown markers from source before searching.
			// This handles the case where user selects rendered text like "bold" from
			// source "**bold**" - the rendered DOM strips the markers.
			const stripped = sourceContent.replace(/[*_~=]/g, "");
			const strippedIdx = stripped.indexOf(selectedText);
			if (strippedIdx !== -1) {
				// Map the stripped index back to source index by counting non-stripped chars
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
			// Still not found - bail with a warning rather than corrupting the file
			console.warn("preach-md format: could not locate selected text in source block, ignoring");
			return;
		}

		const absoluteStart = block.startOffset + sourceIdx;
		const absoluteEnd = absoluteStart + selectedText.length;

		// Note: re-applying the same wrapper (e.g. bolding already-bold text) will
		// produce doubled markers (****text****). This is a known limitation for v1.
		// A future version can detect and toggle. Do not attempt to auto-toggle here.

		await this.app.vault.process(this.file, (data) => {
			return (
				data.slice(0, absoluteStart) +
				wrapper.open +
				data.slice(absoluteStart, absoluteEnd) +
				wrapper.close +
				data.slice(absoluteEnd)
			);
		});

		// Clear the capture after a successful apply
		this.capturedSelection = null;
	}
}
