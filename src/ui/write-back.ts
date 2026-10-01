/**
 * Writing an edited beam back into the note, and inserting new blocks.
 *
 * Saving is the one place where the plugin modifies user files, so it is
 * deliberately cautious. The block is located in one of two ways, both read
 * at save time against the note's current content:
 * - ctx.getSectionInfo(el), when its lines are exactly one closed beam block
 *   whose body is the text that was rendered;
 * - otherwise, the single beam block whose body equals the rendered text,
 *   searched first inside the section Obsidian reported (reading view reports
 *   a whole list or blockquote as one section) and then in the whole note.
 *   This also finds blocks in embeds and in notes that changed meanwhile.
 * The write is refused when neither finds exactly one block: no match, two
 * identical blocks, an unclosed fence, or a range that holds more than one
 * block. Nothing is ever guessed.
 *
 * A note open in an editor is edited through the editor (undoable). Any
 * other note, an embedded one included, is rewritten with vault.process,
 * which Obsidian's undo does not cover.
 *
 * The line logic is pure (no Obsidian imports needed) and unit tested; the
 * Obsidian-specific part only finds the editor or file to apply it to.
 */
import { MarkdownView, type App, type MarkdownPostProcessorContext } from 'obsidian';
// The parser's own line splitter, so a line number here is the line number in its messages.
import { splitLines } from '../core/parser';

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

/** The blockquote / callout markers at the start of a line ("> > "), possibly empty. */
const QUOTE_MARKERS = /^(?:[ \t]*>)*/;

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
 * - the first of them opens a beam fence and the last one closes it;
 * - no line in between closes that fence first, or ends the blockquote that
 *   holds it, so the range is exactly one block (reading view can report a
 *   whole blockquote as the section, and replacing up to its last fence
 *   would delete everything after the beam);
 * - when `oldBody` (the block text as rendered) is given, the lines in
 *   between, without their prefix, are exactly that text;
 * - no line of the new `body` would close the fence itself, which would end
 *   the block early and spill the rest of the body into the note. (The
 *   editor only submits text that parses, and a fence line never does, so
 *   this is a second line of defence.)
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
	oldBody?: string,
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

	// The range must hold exactly one block. A fence closed early means the last line closes some
	// other block; a line with fewer ">" markers ends the blockquote and with it the fence.
	const depth = quoteDepth(prefix);
	const inner = current.slice(1, -1);
	for (const line of inner) {
		if (closesFence(line, prefix, fence) || quoteDepth(QUOTE_MARKERS.exec(line)?.[0] ?? '') < depth) return null;
	}
	if (oldBody !== undefined) {
		const stripped = inner.map((line) => stripPrefix(line, prefix));
		if (stripped.some((line) => line === null) || normalizeBody(stripped.join('\n')) !== normalizeBody(oldBody)) return null;
	}

	// Trailing line breaks would add empty lines before the closing fence.
	const trimmed = body.replace(/[\r\n]+$/, '');
	if (splitLines(trimmed).some((line) => closesFence(prefix + line, prefix, fence))) return null;
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
 * planBodyReplacement, which also explains `oldBody`). Line breaks are
 * preserved: a CRLF note gets CRLF body lines, and every line outside the
 * block is left byte for byte unchanged.
 */
export function spliceBlockBody(text: string, section: SectionLines, body: string, oldBody?: string): string | null {
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

	const plan = planBodyReplacement(lineAt, section, body, eol, oldBody);
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
 *
 * When the cursor is inside a blockquote or callout ("> " before it), every
 * new line repeats those markers, so the block and the rest of the cursor's
 * line stay inside it. Only the ">" markers are repeated, not indentation:
 * four spaces at the top level would turn the fence into an indented code
 * block.
 */
export function fencedBlockInsertion(textBeforeCursor: string, body: string): string {
	const quote = QUOTE_MARKERS.exec(textBeforeCursor)?.[0] ?? '';
	const markers = quote === '' ? '' : `${quote} `;
	const rest = textBeforeCursor.slice(quote.length);
	let lead = '';
	if (rest.trim() !== '') lead = `\n${markers}`; // Text before the cursor: start a new line (inside the quote).
	else if (quote !== '' && !rest.endsWith(' ')) lead = ' '; // A bare ">" still needs its space.
	const lines = splitLines(body.replace(/[\r\n]+$/, '')).map((line) => (line === '' ? quote : markers + line));
	return `${lead}\`\`\`beam\n${lines.join('\n')}\n${markers}\`\`\`\n${markers}`;
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
 * located safely (canvas, note edited so that the block is ambiguous, ...).
 *
 * `oldBody` is the block text as rendered. `sourcePath` is the note the
 * block belongs to; it defaults to ctx.sourcePath, which is captured at
 * render time and goes stale when the note is renamed, so the block passes
 * the path it keeps up to date.
 *
 * The block is located with ctx.getSectionInfo(el) when those lines are
 * exactly the rendered block (see planBodyReplacement). Otherwise, and only
 * when `oldBody` is given, it is the single beam block whose body equals
 * `oldBody` (see findUniqueBlock): first inside the reported section, which
 * in reading view can be a whole list or blockquote, then in the whole note.
 * No match, or two identical blocks, refuses the write.
 *
 * When the note is open in an editor the edit goes through the editor, so it
 * joins the undo history and never races with unsaved typing. Otherwise the
 * file is rewritten atomically with vault.process, locating the block again
 * inside the callback against the file's current content (no undo).
 */
export async function replaceBlockSource(
	app: App,
	ctx: MarkdownPostProcessorContext,
	el: HTMLElement,
	newBody: string,
	oldBody?: string,
	sourcePath: string = ctx.sourcePath,
): Promise<boolean> {
	// Line numbers go stale as soon as the note changes, so read them now, not at render time.
	const info = ctx.getSectionInfo(el);
	if (!info && oldBody === undefined) return false;

	/**
	 * Where the block is in `text` (the note's current content, whose line n is
	 * `lineAt(n)`), or null when it cannot be told safely.
	 */
	const locate = (text: string, lineAt: (n: number) => string | undefined): SectionLines | null => {
		if (info && planBodyReplacement(lineAt, info, newBody, '\n', oldBody)) return info;
		if (oldBody === undefined) return null;
		const lines = splitLines(text);
		if (info) {
			// The section may hold the block plus other content (a list or blockquote in reading view).
			const inSection = findUniqueBlock(lines.slice(info.lineStart, info.lineEnd + 1), oldBody);
			if (inSection) return { text, lineStart: info.lineStart + inSection.lineStart, lineEnd: info.lineStart + inSection.lineEnd };
		}
		const found = findUniqueBlock(lines, oldBody);
		return found ? { text, ...found } : null;
	};

	const view = findMarkdownView(app, sourcePath);
	if (view) {
		const editor = view.editor;
		const count = editor.lineCount();
		const lineAt = (n: number): string | undefined => (n >= 0 && n < count ? editor.getLine(n) : undefined);
		const section = locate(editor.getValue(), lineAt);
		if (!section) return false;
		const plan = planBodyReplacement(lineAt, section, newBody, '\n', oldBody);
		if (!plan) return false;
		editor.replaceRange(plan.text, { line: plan.fromLine, ch: 0 }, { line: plan.toLine, ch: 0 });
		return true;
	}

	const file = app.vault.getFileByPath(sourcePath);
	if (!file) return false;
	let changed = false;
	await app.vault.process(file, (data) => {
		const lines = splitLines(data);
		const section = locate(data, (n) => lines[n]);
		const next = section ? spliceBlockBody(data, section, newBody, oldBody) : null;
		if (next === null) return data;
		changed = true;
		return next;
	});
	return changed;
}
