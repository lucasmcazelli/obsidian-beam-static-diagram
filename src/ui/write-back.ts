/**
 * Writing an edited beam back into the note, and inserting new blocks.
 *
 * Saving is the one place where the plugin modifies user files, so it is
 * deliberately cautious: the block's position comes from
 * ctx.getSectionInfo() read at save time, and the edit is applied only if the
 * lines at that position still look exactly like the block that was
 * rendered. Anything unexpected (the note changed meanwhile, the block is in
 * an embed, the fence is missing) refuses the write instead of guessing.
 *
 * The line logic is pure (no Obsidian imports needed) and unit tested; the
 * Obsidian-specific part only finds the editor or file to apply it to.
 */
import { MarkdownView, type App, type MarkdownPostProcessorContext } from 'obsidian';

/** The fields of Obsidian's MarkdownSectionInformation that the splice uses. */
export interface SectionLines {
	/**
	 * Text the section was read from. Obsidian passes the whole document here,
	 * but a text holding only the block's lines is accepted too.
	 */
	text: string;
	/** 0-based line of the opening fence. */
	lineStart: number;
	/** 0-based line of the closing fence. */
	lineEnd: number;
}

/** Replace whole lines [fromLine, toLine) with `text` (which ends with a line break, or is empty). */
export interface BodyReplacement {
	fromLine: number;
	toLine: number;
	text: string;
}

/**
 * Opening fence of a beam block: optional blockquote / callout markers and
 * indentation (group 1), three or more backticks or tildes (group 2), then the
 * language "beam" followed by nothing or whitespace.
 */
const OPEN_FENCE = /^((?:[ \t]*>)*[ \t]*)(`{3,}|~{3,})[ \t]*beam(?:[ \t].*)?$/i;

/** A fence line with no info string: prefix (group 1) and fence characters (group 2). */
const CLOSE_FENCE = /^((?:[ \t]*>)*[ \t]*)(`{3,}|~{3,})[ \t]*$/;

/** Any opening fence, whatever its language: prefix (group 1) and fence characters (group 2). */
const ANY_FENCE = /^((?:[ \t]*>)*[ \t]*)(`{3,}|~{3,})/;

/** Splits text into lines on any line break style. */
function splitLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/);
}

/** Number of ">" quote markers in a line prefix (nesting depth of blockquotes and callouts). */
function quoteDepth(prefix: string): number {
	let depth = 0;
	for (const ch of prefix) if (ch === '>') depth++;
	return depth;
}

/**
 * The block's lines as they were when it was rendered, taken from the
 * section text: a slice of it when it is the whole document (Obsidian's
 * behaviour), or all of it when it holds just the block. Null when neither
 * interpretation fits the line numbers.
 */
function expectedBlockLines(section: SectionLines): string[] | null {
	const lines = splitLines(section.text);
	if (lines.length > section.lineEnd) return lines.slice(section.lineStart, section.lineEnd + 1);
	if (lines.length === section.lineEnd - section.lineStart + 1) return lines;
	return null;
}

/**
 * True when `line` closes a fence opened with `fence` at the same quote depth.
 * CommonMark: same character, at least as many of them, nothing after but spaces.
 */
function closesFence(line: string, prefix: string, fence: string): boolean {
	const match = CLOSE_FENCE.exec(line);
	if (!match) return false;
	const closing = match[2] ?? '';
	return closing[0] === fence[0] && closing.length >= fence.length && quoteDepth(match[1] ?? '') === quoteDepth(prefix);
}

/**
 * Plans replacing the body of the beam block described by `section` with
 * `body`. `lineAt(n)` returns the current text of 0-based line n without its
 * line break (undefined past the end).
 *
 * Returns null (refusing the write) unless all of these hold:
 * - the current lines lineStart..lineEnd equal the lines that were rendered;
 * - the first of them opens a beam fence and the last one closes it.
 *
 * Every new body line gets the opening fence's prefix, so a block inside a
 * blockquote or callout ("> ") or indented under a list item stays inside it.
 * Empty body lines get the prefix without trailing spaces.
 */
export function planBodyReplacement(
	lineAt: (line: number) => string | undefined,
	section: SectionLines,
	body: string,
	eol = '\n',
): BodyReplacement | null {
	const { lineStart, lineEnd } = section;
	if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 0 || lineEnd <= lineStart) return null;

	const expected = expectedBlockLines(section);
	if (!expected) return null;
	const current: string[] = [];
	for (let n = lineStart; n <= lineEnd; n++) {
		const line = lineAt(n);
		if (line === undefined) return null;
		current.push(line);
	}
	// Stale line numbers (the note changed since rendering) show up as a mismatch here.
	if (current.length !== expected.length || current.some((line, i) => line !== expected[i])) return null;

	const open = OPEN_FENCE.exec(current[0] ?? '');
	if (!open) return null;
	const prefix = open[1] ?? '';
	const fence = open[2] ?? '```';
	// An unterminated block (fence never closed) runs to the end of the note: refuse rather than eat content.
	if (!closesFence(current[current.length - 1] ?? '', prefix, fence)) return null;

	// Trailing line breaks would add empty lines before the closing fence.
	const trimmed = body.replace(/[\r\n]+$/, '');
	const text =
		trimmed.trim() === ''
			? ''
			: splitLines(trimmed)
					.map((line) => (line === '' ? prefix.trimEnd() : prefix + line) + eol)
					.join('');
	return { fromLine: lineStart + 1, toLine: lineEnd, text };
}

/**
 * Returns `text` with the body of the beam block at `section` replaced by
 * `body`, or null when the block is not where `section` says (see
 * planBodyReplacement). Line breaks are preserved: a CRLF note gets CRLF body
 * lines, and every line outside the block is left byte for byte unchanged.
 */
export function spliceBlockBody(text: string, section: SectionLines, body: string): string | null {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	// Start offset of every line, splitting on "\n"; a CRLF's "\r" stays at the end of its line.
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
	const lineAt = (n: number): string | undefined => {
		const start = starts[n];
		if (start === undefined) return undefined;
		const next = starts[n + 1];
		const end = next === undefined ? text.length : next - 1;
		return text.slice(start, end).replace(/\r$/, '');
	};

	const plan = planBodyReplacement(lineAt, section, body, eol);
	if (!plan) return null;
	const from = starts[plan.fromLine];
	const to = starts[plan.toLine];
	if (from === undefined || to === undefined) return null;
	return text.slice(0, from) + plan.text + text.slice(to);
}

/** Block text with line breaks unified and trailing line breaks dropped, for comparing bodies. */
function normalizeBody(text: string): string {
	return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

/** A body line without the block's quote / indentation prefix, or null when it lacks the prefix. */
function stripPrefix(line: string, prefix: string): string | null {
	if (line.startsWith(prefix)) return line.slice(prefix.length);
	// An empty line inside a quote is often just ">" without the trailing space.
	if (line === prefix.trimEnd()) return '';
	return null;
}

/**
 * Finds the beam block in `lines` whose body is exactly `body`, for when
 * Obsidian cannot tell where a rendered block is. Returns its fence lines
 * only when exactly one block matches: with no match, or two identical
 * blocks, there is no safe choice. Other fenced code blocks are skipped
 * whole, so a beam example quoted inside them is never matched.
 */
export function findUniqueBlock(lines: readonly string[], body: string): { lineStart: number; lineEnd: number } | null {
	const wanted = normalizeBody(body);
	let found: { lineStart: number; lineEnd: number } | null = null;
	let matches = 0;
	for (let i = 0; i < lines.length; i++) {
		const open = ANY_FENCE.exec(lines[i] ?? '');
		if (!open) continue;
		const prefix = open[1] ?? '';
		const fence = open[2] ?? '```';
		let end = -1;
		for (let j = i + 1; j < lines.length; j++) {
			if (closesFence(lines[j] ?? '', prefix, fence)) {
				end = j;
				break;
			}
		}
		// An unclosed fence runs to the end of the note: nothing after it is a block.
		if (end < 0) break;
		if (OPEN_FENCE.test(lines[i] ?? '')) {
			const bodyLines = lines.slice(i + 1, end).map((line) => stripPrefix(line, prefix));
			if (bodyLines.every((line) => line !== null) && normalizeBody(bodyLines.join('\n')) === wanted) {
				matches++;
				found = { lineStart: i, lineEnd: end };
			}
		}
		i = end;
	}
	return matches === 1 ? found : null;
}

/**
 * Text to insert at the cursor for a new block: the fenced body followed by
 * a line break. A fence only opens a code block at the start of a line, so a
 * line break is added first when there is text before the cursor.
 */
export function fencedBlockInsertion(textBeforeCursor: string, body: string): string {
	const lead = textBeforeCursor.trim() === '' ? '' : '\n';
	return `${lead}\`\`\`beam\n${body.replace(/[\r\n]+$/, '')}\n\`\`\`\n`;
}

/** The open Markdown view showing `path`, preferring the active one. */
function findMarkdownView(app: App, path: string): MarkdownView | null {
	const active = app.workspace.getActiveViewOfType(MarkdownView);
	if (active?.file?.path === path) return active;
	for (const leaf of app.workspace.getLeavesOfType('markdown')) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file?.path === path) return view;
	}
	return null;
}

/**
 * Replaces the body of the beam block rendered into `el` with `newBody`.
 * Resolves true when the note was changed, false when the block could not be
 * located safely (embedded block, canvas, note edited meanwhile, ...).
 *
 * The block is located with ctx.getSectionInfo(el). When Obsidian cannot
 * provide it and `oldBody` (the block text as rendered) is given, the block
 * is instead found by content: the single beam block in the note whose body
 * equals `oldBody` (see findUniqueBlock).
 *
 * When the note is open in an editor the edit goes through the editor, so it
 * joins the undo history and never races with unsaved typing. Otherwise the
 * file is rewritten atomically with vault.process, re-checking the block
 * inside the callback against the file's current content.
 */
export async function replaceBlockSource(
	app: App,
	ctx: MarkdownPostProcessorContext,
	el: HTMLElement,
	newBody: string,
	oldBody?: string,
): Promise<boolean> {
	// Line numbers go stale as soon as the note changes, so read them now, not at render time.
	const info = ctx.getSectionInfo(el);
	if (!info && oldBody === undefined) return false;
	/** Fallback: where the block is in `text` (the note's current content), found by its body. */
	const byContent = (text: string): SectionLines | null => {
		const found = oldBody === undefined ? null : findUniqueBlock(splitLines(text), oldBody);
		return found ? { text, ...found } : null;
	};

	const view = findMarkdownView(app, ctx.sourcePath);
	if (view) {
		const editor = view.editor;
		const section = info ?? byContent(editor.getValue());
		if (!section) return false;
		const count = editor.lineCount();
		const plan = planBodyReplacement((n) => (n < count ? editor.getLine(n) : undefined), section, newBody);
		if (!plan) return false;
		editor.replaceRange(plan.text, { line: plan.fromLine, ch: 0 }, { line: plan.toLine, ch: 0 });
		return true;
	}

	const file = app.vault.getFileByPath(ctx.sourcePath);
	if (!file) return false;
	let changed = false;
	await app.vault.process(file, (data) => {
		const section = info ?? byContent(data);
		const next = section ? spliceBlockBody(data, section, newBody) : null;
		if (next === null) return data;
		changed = true;
		return next;
	});
	return changed;
}
