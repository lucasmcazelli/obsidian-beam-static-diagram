// @vitest-environment happy-dom
/**
 * Smoke tests for the Obsidian UI layer (src/ui, src/settings.ts, src/main.ts).
 *
 * Runs in happy-dom with the 'obsidian' module replaced by tests/__mocks__/obsidian.ts.
 * Obsidian adds DOM helpers (createDiv, setText, empty, ...) to the element
 * prototypes at runtime; installObsidianDomHelpers() below polyfills the ones
 * the UI uses.
 *
 * Tests marked "end to end" go through analyzeBeam and the real scene
 * builders; everything else checks the UI pieces on their own (the results
 * table uses the real parser, model builder and solver directly).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, MarkdownPostProcessorContext } from 'obsidian';
import { MarkdownView, TFile } from 'obsidian';
import BeamStaticsPlugin from '../src/main';
import { analyzeBeam } from '../src/core/analyze';
import { BEAM_EXAMPLES, DEFAULT_BEAM_SOURCE } from '../src/core/examples';
import { buildModel } from '../src/core/model';
import { emptyAst, parseBeamSource } from '../src/core/parser';
import { solveBeam } from '../src/core/solver';
import { SECTION_SHAPES } from '../src/core/sections';
import type { AnalysisOutput, AstLoad, SectionShape, UnitSystemId } from '../src/core/types';
import { supportName } from '../src/render/draw';
import type { Scene } from '../src/render/scene';
import { BeamStaticsSettingTab, DEFAULT_SETTINGS, normalizeSettings, type BeamStaticsSettings } from '../src/settings';
import { BeamBlockRenderChild } from '../src/ui/beam-block';
import { governingDeflectionRatio } from '../src/core/diagrams';
import { formatSignificant, formatSpanRatio } from '../src/core/units';
import { analyzeSafely, DISCLAIMER, keepTogether, renderBeamOutput, resultRows } from '../src/ui/beam-view';
import {
	BeamEditorModal,
	changeLoadKind,
	changeSectionShape,
	newSupport,
	optionalText,
	parseForForm,
	sectionForText,
	withExplicitUnits,
	WRITE_BACK_FAILED,
	type BeamEditorOptions,
} from '../src/ui/editor-modal';
import { mountScene } from '../src/ui/mount';
import { fencedBlockInsertion, findUniqueBlock, planBodyReplacement, replaceBlockSource, spliceBlockBody } from '../src/ui/write-back';

// ---------------------------------------------------------------------------
// Obsidian DOM helper polyfill
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** The subset of Obsidian's DomElementInfo / SvgElementInfo the polyfill understands. */
interface ElementInfo {
	cls?: string | string[];
	text?: string | DocumentFragment;
	attr?: Record<string, string | number | boolean | null>;
	title?: string;
	value?: string;
	type?: string;
	placeholder?: string;
	href?: string;
	prepend?: boolean;
}

function setTextOf(el: Element, value: string | DocumentFragment): void {
	if (typeof value === 'string') el.textContent = value;
	else el.replaceChildren(value);
}

/** Applies createEl options the way Obsidian does (a string option is a class name). */
function applyInfo(el: Element, info: ElementInfo | string | undefined): void {
	const o: ElementInfo = typeof info === 'string' ? { cls: info } : (info ?? {});
	const classes = Array.isArray(o.cls) ? o.cls : (o.cls ?? '').split(/\s+/);
	for (const c of classes) if (c) el.classList.add(c);
	if (o.text !== undefined) setTextOf(el, o.text);
	for (const [name, value] of Object.entries(o.attr ?? {})) if (value !== null) el.setAttribute(name, String(value));
	if (o.title !== undefined) el.setAttribute('title', o.title);
	if (o.value !== undefined) el.setAttribute('value', o.value);
	if (o.type !== undefined) el.setAttribute('type', o.type);
	if (o.placeholder !== undefined) el.setAttribute('placeholder', o.placeholder);
	if (o.href !== undefined) el.setAttribute('href', o.href);
}

/** Creates `el` under `parent` honouring `prepend`, then applies the options and callback. */
function attach<T extends Element>(parent: Node, el: T, info: ElementInfo | string | undefined, cb?: (el: T) => void): T {
	applyInfo(el, info);
	if (typeof info === 'object' && info.prepend) parent.insertBefore(el, parent.firstChild);
	else parent.appendChild(el);
	cb?.(el);
	return el;
}

function ownerDoc(node: Node): Document {
	return node.ownerDocument ?? document;
}

function installObsidianDomHelpers(): void {
	const define = (target: object, name: string, value: unknown): void => {
		Object.defineProperty(target, name, { value, configurable: true, writable: true });
	};
	// The polyfill implements Obsidian's helpers, so it creates elements natively: HTML elements through
	// the XHTML namespace (same result as createElement in an HTML document).
	const html = (tag: string) =>
		function (this: Node, info?: ElementInfo | string, cb?: (el: Element) => void): Element {
			return attach(this, ownerDoc(this).createElementNS(XHTML_NS, tag), info, cb);
		};
	define(Node.prototype, 'createEl', function (this: Node, tag: string, info?: ElementInfo | string, cb?: (el: Element) => void) {
		return attach(this, ownerDoc(this).createElementNS(XHTML_NS, tag), info, cb);
	});
	define(Node.prototype, 'createDiv', html('div'));
	define(Node.prototype, 'createSpan', html('span'));
	define(Node.prototype, 'createSvg', function (this: Node, tag: string, info?: ElementInfo | string, cb?: (el: Element) => void) {
		return attach(this, ownerDoc(this).createElementNS(SVG_NS, tag), info, cb);
	});
	define(Node.prototype, 'empty', function (this: Node) {
		while (this.firstChild) this.removeChild(this.firstChild);
	});
	define(Node.prototype, 'detach', function (this: Node) {
		this.parentNode?.removeChild(this);
	});
	const detached = (create: () => Element) =>
		function (info?: ElementInfo | string, cb?: (el: Element) => void): Element {
			const el = create();
			applyInfo(el, info);
			cb?.(el);
			return el;
		};
	define(window, 'createEl', (tag: string, info?: ElementInfo | string, cb?: (el: Element) => void) =>
		detached(() => document.createElementNS(XHTML_NS, tag))(info, cb),
	);
	define(window, 'createDiv', detached(() => document.createElementNS(XHTML_NS, 'div')));
	define(window, 'createSpan', detached(() => document.createElementNS(XHTML_NS, 'span')));
	define(window, 'createSvg', (tag: string, info?: ElementInfo | string, cb?: (el: Element) => void) =>
		detached(() => document.createElementNS(SVG_NS, tag))(info, cb),
	);
	Object.defineProperty(Node.prototype, 'win', { get: () => window, configurable: true });
	Object.defineProperty(Node.prototype, 'doc', { get: () => document, configurable: true });

	define(Element.prototype, 'setText', function (this: Element, value: string | DocumentFragment) {
		setTextOf(this, value);
	});
	define(Element.prototype, 'getText', function (this: Element) {
		return this.textContent ?? '';
	});
	define(Element.prototype, 'addClass', function (this: Element, ...classes: string[]) {
		this.classList.add(...classes);
	});
	define(Element.prototype, 'removeClass', function (this: Element, ...classes: string[]) {
		this.classList.remove(...classes);
	});
	define(Element.prototype, 'toggleClass', function (this: Element, classes: string | string[], value: boolean) {
		for (const c of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(c, value);
	});
	define(Element.prototype, 'hasClass', function (this: Element, cls: string) {
		return this.classList.contains(cls);
	});
	define(Element.prototype, 'setAttr', function (this: Element, name: string, value: string | number | boolean | null) {
		if (value === null) this.removeAttribute(name);
		else this.setAttribute(name, String(value));
	});
	define(Element.prototype, 'setAttrs', function (this: Element, attrs: Record<string, string | number | boolean | null>) {
		for (const [name, value] of Object.entries(attrs)) {
			if (value === null) this.removeAttribute(name);
			else this.setAttribute(name, String(value));
		}
	});
	define(Element.prototype, 'getAttr', function (this: Element, name: string) {
		return this.getAttribute(name);
	});
	// Obsidian's toggle()/show()/hide() set display; the `hidden` attribute is an observable stand-in.
	define(HTMLElement.prototype, 'toggle', function (this: HTMLElement, show: boolean) {
		this.toggleAttribute('hidden', !show);
	});
	define(HTMLElement.prototype, 'show', function (this: HTMLElement) {
		this.removeAttribute('hidden');
	});
	define(HTMLElement.prototype, 'hide', function (this: HTMLElement) {
		this.setAttribute('hidden', '');
	});
	const setCssProps = function (this: HTMLElement | SVGElement, props: Record<string, string>) {
		for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
	};
	define(HTMLElement.prototype, 'setCssProps', setCssProps);
	define(SVGElement.prototype, 'setCssProps', setCssProps);
}

beforeAll(() => {
	installObsidianDomHelpers();
});

afterEach(() => {
	document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** parse -> model -> solve without analyzeBeam, so table tests run on real numbers today. */
function analyzeDirect(source: string, defaultUnits: UnitSystemId = 'kN-m'): AnalysisOutput {
	const { ast, diagnostics } = parseBeamSource(source);
	const built = buildModel(ast, defaultUnits);
	const output: AnalysisOutput = { ast, units: built.units, diagnostics: [...diagnostics, ...built.diagnostics] };
	if (built.model && !output.diagnostics.some((d) => d.severity === 'error')) {
		output.model = built.model;
		output.results = solveBeam(built.model);
	}
	return output;
}

function exampleSource(id: string): string {
	const example = BEAM_EXAMPLES.find((e) => e.id === id);
	if (!example) throw new Error(`missing example ${id}`);
	return example.source;
}

function rowValue(rows: { label: string; value: string }[], label: string): string | undefined {
	return rows.find((r) => r.label === label)?.value;
}

function isShown(el: Element | null): boolean {
	return el !== null && !el.hasAttribute('hidden');
}

/** The mock's MarkdownView and TFile constructors differ from the real typings (which need a leaf, or forbid `new`). */
const MockView = MarkdownView as unknown as new () => MarkdownView;
const MockFile = TFile as unknown as new (path: string) => TFile;

/** A fake app with just what blocks touch on load: the vault's rename event. */
function fakeBlockApp(extra: Record<string, unknown> = {}) {
	return { vault: { on: vi.fn(() => ({})) }, ...extra };
}

/** A fake plugin with just what the UI touches. */
function fakePlugin(settings: Partial<BeamStaticsSettings> = {}, app: object = fakeBlockApp()) {
	return {
		app,
		settings: { ...DEFAULT_SETTINGS, ...settings },
		registerBlock: vi.fn(),
		unregisterBlock: vi.fn(),
		refreshBlocks: vi.fn(),
	};
}
type FakePlugin = ReturnType<typeof fakePlugin>;
const asPlugin = (plugin: FakePlugin): BeamStaticsPlugin => plugin as unknown as BeamStaticsPlugin;

// ---------------------------------------------------------------------------
// write-back.ts (pure line logic)
// ---------------------------------------------------------------------------

describe('spliceBlockBody', () => {
	const doc = ['# Note', '', '```beam', 'length 6 m', 'pin at 0', '```', 'after'].join('\n');
	const section = { text: doc, lineStart: 2, lineEnd: 5 };

	it('replaces the body between the fences and keeps everything else', () => {
		expect(spliceBlockBody(doc, section, 'length 8 m\nroller at end')).toBe(
			['# Note', '', '```beam', 'length 8 m', 'roller at end', '```', 'after'].join('\n'),
		);
	});

	it('accepts a section text that holds only the block', () => {
		const blockOnly = { text: '```beam\nlength 6 m\npin at 0\n```', lineStart: 2, lineEnd: 5 };
		expect(spliceBlockBody(doc, blockOnly, 'length 7 m')).toBe(['# Note', '', '```beam', 'length 7 m', '```', 'after'].join('\n'));
	});

	it('drops trailing line breaks of the body and allows an empty body', () => {
		expect(spliceBlockBody(doc, section, 'length 8 m\n\n')).toBe(['# Note', '', '```beam', 'length 8 m', '```', 'after'].join('\n'));
		expect(spliceBlockBody(doc, section, '')).toBe(['# Note', '', '```beam', '```', 'after'].join('\n'));
	});

	it('prefixes new lines inside a callout or blockquote', () => {
		const callout = ['> [!note] Beam', '> ```beam', '> length 6 m', '> ```', '', 'text'].join('\n');
		const result = spliceBlockBody(callout, { text: callout, lineStart: 1, lineEnd: 3 }, 'length 8 m\n\npin at 0');
		expect(result).toBe(['> [!note] Beam', '> ```beam', '> length 8 m', '>', '> pin at 0', '> ```', '', 'text'].join('\n'));
	});

	it('handles nested quotes and indented fences', () => {
		const nested = ['> > ```beam', '> > length 6', '> > ```'].join('\n');
		expect(spliceBlockBody(nested, { text: nested, lineStart: 0, lineEnd: 2 }, 'length 9')).toBe(
			['> > ```beam', '> > length 9', '> > ```'].join('\n'),
		);
		const list = ['- item', '    ```beam', '    length 6', '    ```'].join('\n');
		expect(spliceBlockBody(list, { text: list, lineStart: 1, lineEnd: 3 }, 'length 9\npin at 0')).toBe(
			['- item', '    ```beam', '    length 9', '    pin at 0', '    ```'].join('\n'),
		);
	});

	it('keeps CRLF line endings', () => {
		const crlf = doc.split('\n').join('\r\n');
		const result = spliceBlockBody(crlf, { text: crlf, lineStart: 2, lineEnd: 5 }, 'length 8 m\nroller at end');
		expect(result).toBe(['# Note', '', '```beam', 'length 8 m', 'roller at end', '```', 'after'].join('\r\n'));
		expect(result?.replace(/\r\n/g, '')).not.toContain('\n');
	});

	it('supports tilde fences and longer fences', () => {
		const tilde = ['~~~beam', 'length 6', '~~~'].join('\n');
		expect(spliceBlockBody(tilde, { text: tilde, lineStart: 0, lineEnd: 2 }, 'length 7')).toBe(['~~~beam', 'length 7', '~~~'].join('\n'));
		const long = ['````beam', 'length 6', '`````'].join('\n');
		expect(spliceBlockBody(long, { text: long, lineStart: 0, lineEnd: 2 }, 'length 7')).toBe(['````beam', 'length 7', '`````'].join('\n'));
	});

	it('refuses when the note changed since rendering', () => {
		const shifted = `New first line\n${doc}`;
		expect(spliceBlockBody(shifted, section, 'length 8 m')).toBeNull();
		const edited = doc.replace('pin at 0', 'roller at 0');
		expect(spliceBlockBody(edited, section, 'length 8 m')).toBeNull();
	});

	it('refuses anything that is not a closed beam block', () => {
		const js = doc.replace('```beam', '```js');
		expect(spliceBlockBody(js, { text: js, lineStart: 2, lineEnd: 5 }, 'x')).toBeNull();
		const beamish = doc.replace('```beam', '```beams');
		expect(spliceBlockBody(beamish, { text: beamish, lineStart: 2, lineEnd: 5 }, 'x')).toBeNull();
		const unterminated = ['```beam', 'length 6', 'pin at 0'].join('\n');
		expect(spliceBlockBody(unterminated, { text: unterminated, lineStart: 0, lineEnd: 2 }, 'x')).toBeNull();
		const mismatched = ['~~~beam', 'length 6', '```'].join('\n');
		expect(spliceBlockBody(mismatched, { text: mismatched, lineStart: 0, lineEnd: 2 }, 'x')).toBeNull();
		expect(spliceBlockBody(doc, { text: doc, lineStart: 2, lineEnd: 9 }, 'x')).toBeNull();
		expect(spliceBlockBody(doc, { text: doc, lineStart: 5, lineEnd: 2 }, 'x')).toBeNull();
	});

	// Regression: reading view can report a whole blockquote as the block's section. The range then
	// starts with the beam fence and ends with some LATER fence, and replacing up to it deleted
	// everything in between (quoted text, other code blocks, even another beam).
	it('refuses a range that runs past the beam block, keeping the rest of the note', () => {
		const quote = ['> ```beam', '> length 6 m', '> ```', '> Some quoted text', '> ```js', '> console.log(1)', '> ```', '', 'after'].join('\n');
		expect(spliceBlockBody(quote, { text: quote, lineStart: 0, lineEnd: 6 }, 'length 8 m')).toBeNull();
		// The same block with its own range still updates.
		expect(spliceBlockBody(quote, { text: quote, lineStart: 0, lineEnd: 2 }, 'length 8 m')).toBe(quote.replace('length 6 m', 'length 8 m'));

		const twoBeams = ['> ```beam', '> length 6 m', '> pin at 0', '> ```', '> ```beam', '> length 4 m', '> ```'].join('\n');
		expect(spliceBlockBody(twoBeams, { text: twoBeams, lineStart: 0, lineEnd: 6 }, 'length 5 m')).toBeNull();

		const security = ['> ```beam', '> length 6', '> pin at 0', '> roller at end', '> ```', '> Keep this paragraph', '> ```js', '> console.log(1)', '> ```', '', 'after'].join('\n');
		expect(spliceBlockBody(security, { text: security, lineStart: 0, lineEnd: 8 }, 'length 8\npin at 0\nroller at end')).toBeNull();
		expect(spliceBlockBody(security, { text: security, lineStart: 0, lineEnd: 4 }, 'length 8\npin at 0\nroller at end')).toBe(
			security.replace('> length 6', '> length 8'),
		);

		const topLevel = ['```beam', 'length 6', '```', 'paragraph that must survive', '```', 'trailing'].join('\n');
		expect(spliceBlockBody(topLevel, { text: topLevel, lineStart: 0, lineEnd: 4 }, 'length 9')).toBeNull();
	});

	it('treats a line that leaves the blockquote as the end of the block', () => {
		// A truly empty line ends the quote, and with it the fence: "> ```" after it is another block.
		const broken = ['> ```beam', '> length 6', '', '> ```'].join('\n');
		expect(spliceBlockBody(broken, { text: broken, lineStart: 0, lineEnd: 3 }, 'length 9')).toBeNull();
		const kept = ['> ```beam', '> length 6', '>', '> ```'].join('\n');
		expect(spliceBlockBody(kept, { text: kept, lineStart: 0, lineEnd: 3 }, 'length 9')).toBe(['> ```beam', '> length 9', '> ```'].join('\n'));
	});

	it('checks the body against the rendered text when it is given', () => {
		expect(spliceBlockBody(doc, section, 'length 8 m', 'length 6 m\npin at 0\n')).toBe(
			['# Note', '', '```beam', 'length 8 m', '```', 'after'].join('\n'),
		);
		expect(spliceBlockBody(doc, section, 'length 8 m', 'length 7 m\npin at 0')).toBeNull();
	});
});

describe('planBodyReplacement and fencedBlockInsertion', () => {
	it('plans an editor edit as whole-line replacement', () => {
		const lines = ['intro', '```beam', 'length 6', '```'];
		const plan = planBodyReplacement((n) => lines[n], { text: lines.join('\n'), lineStart: 1, lineEnd: 3 }, 'length 7\npin at 0');
		expect(plan).toEqual({ fromLine: 2, toLine: 3, text: 'length 7\npin at 0\n' });
	});

	it('inserts a fence on its own line', () => {
		expect(fencedBlockInsertion('', 'length 6 m')).toBe('```beam\nlength 6 m\n```\n');
		expect(fencedBlockInsertion('   ', 'length 6 m\n')).toBe('```beam\nlength 6 m\n```\n');
		expect(fencedBlockInsertion('Some text', 'length 6 m')).toBe('\n```beam\nlength 6 m\n```\n');
		// A list item is not a quote: the block goes after it at the top level, as before.
		expect(fencedBlockInsertion('- item', 'length 6 m')).toBe('\n```beam\nlength 6 m\n```\n');
	});

	// Regression: inserting with the cursor in a callout used to end the callout at the fence.
	it('keeps an inserted block, and the rest of the line, inside a blockquote or callout', () => {
		expect(fencedBlockInsertion('> ', 'length 6 m\n\npin at 0')).toBe('```beam\n> length 6 m\n>\n> pin at 0\n> ```\n> ');
		expect(fencedBlockInsertion('>', 'length 6 m')).toBe(' ```beam\n> length 6 m\n> ```\n> ');
		expect(fencedBlockInsertion('> Some text', 'length 6 m')).toBe('\n> ```beam\n> length 6 m\n> ```\n> ');
		expect(fencedBlockInsertion('> > ', 'length 6 m')).toBe('```beam\n> > length 6 m\n> > ```\n> > ');
		// The result, typed after the cursor text, is one closed beam block inside the quote.
		const note = `> [!note]\n> ${fencedBlockInsertion('> ', 'length 6 m')}rest`;
		expect(findUniqueBlock(note.split('\n'), 'length 6 m')).toEqual({ lineStart: 1, lineEnd: 3 });
		expect(note.split('\n').every((line) => line.startsWith('>'))).toBe(true);
	});
});

describe('findUniqueBlock', () => {
	const lines = [
		'# Note',
		'```beam',
		'length 6 m',
		'```',
		'',
		'> ```beam',
		'> length 4 m',
		'>',
		'> pin at 0',
		'> ```',
		'````md',
		'```beam',
		'length 9 m',
		'```',
		'````',
		'```beam',
		'length 5 m',
		'```',
		'~~~beam',
		'length 5 m',
		'~~~',
	];

	it('finds a block by its body, inside quotes too', () => {
		expect(findUniqueBlock(lines, 'length 6 m\n')).toEqual({ lineStart: 1, lineEnd: 3 });
		expect(findUniqueBlock(lines, 'length 4 m\n\npin at 0')).toEqual({ lineStart: 5, lineEnd: 9 });
	});

	it('ignores examples inside other code blocks and refuses ambiguous or missing bodies', () => {
		expect(findUniqueBlock(lines, 'length 9 m')).toBeNull();
		expect(findUniqueBlock(lines, 'length 5 m')).toBeNull();
		expect(findUniqueBlock(lines, 'length 1 m')).toBeNull();
		expect(findUniqueBlock(['```beam', 'length 6 m'], 'length 6 m')).toBeNull();
	});
});

describe('replaceBlockSource', () => {
	const body = 'length 8 m\npin at 0\nroller at end';
	const text = ['# Beam', '```beam', 'length 6 m', '```'].join('\n');
	const ctx = (sectionText: string | null): MarkdownPostProcessorContext =>
		({
			sourcePath: 'note.md',
			getSectionInfo: () => (sectionText === null ? null : { text: sectionText, lineStart: 1, lineEnd: 3 }),
		}) as unknown as MarkdownPostProcessorContext;

	function fakeApp(options: { view?: MarkdownView; fileText?: { value: string } }): App {
		return {
			workspace: {
				getActiveViewOfType: () => null,
				getLeavesOfType: () => (options.view ? [{ view: options.view }] : []),
			},
			vault: {
				getFileByPath: (path: string) => (options.fileText ? new MockFile(path) : null),
				process: async (_file: TFile, fn: (data: string) => string) => {
					if (!options.fileText) throw new Error('no file');
					options.fileText.value = fn(options.fileText.value);
					return options.fileText.value;
				},
			},
		} as unknown as App;
	}

	it('returns false when Obsidian cannot locate the block', async () => {
		expect(await replaceBlockSource(fakeApp({}), ctx(null), createDiv(), body)).toBe(false);
	});

	it('edits through the open editor when the note is open', async () => {
		const lines = text.split('\n');
		const view = new MockView();
		view.file = new MockFile('note.md');
		const replaceRange = vi.fn((replacement: string, from: { line: number }, to: { line: number }) => {
			lines.splice(from.line, to.line - from.line, ...replacement.replace(/\n$/, '').split('\n'));
		});
		view.editor = {
			lineCount: () => lines.length,
			getLine: (n: number) => lines[n] ?? '',
			getValue: () => lines.join('\n'),
			replaceRange,
		} as unknown as MarkdownView['editor'];
		expect(await replaceBlockSource(fakeApp({ view }), ctx(text), createDiv(), body)).toBe(true);
		expect(lines).toEqual(['# Beam', '```beam', 'length 8 m', 'pin at 0', 'roller at end', '```']);

		// Without section info the block is found by its rendered body.
		expect(await replaceBlockSource(fakeApp({ view }), ctx(null), createDiv(), 'length 9 m', 'length 6 m')).toBe(false);
		expect(await replaceBlockSource(fakeApp({ view }), ctx(null), createDiv(), 'length 9 m', body)).toBe(true);
		expect(lines).toEqual(['# Beam', '```beam', 'length 9 m', '```']);
	});

	it('rewrites the file when no editor shows it, and refuses stale positions', async () => {
		const file = { value: text };
		expect(await replaceBlockSource(fakeApp({ fileText: file }), ctx(text), createDiv(), body)).toBe(true);
		expect(file.value).toBe(['# Beam', '```beam', 'length 8 m', 'pin at 0', 'roller at end', '```'].join('\n'));

		const changed = { value: `inserted line\n${text}` };
		expect(await replaceBlockSource(fakeApp({ fileText: changed }), ctx(text), createDiv(), body)).toBe(false);
		expect(changed.value).toBe(`inserted line\n${text}`);

		// The content fallback works on the file too, and is checked against its current content.
		expect(await replaceBlockSource(fakeApp({ fileText: changed }), ctx(null), createDiv(), 'length 7 m', 'length 6 m')).toBe(true);
		expect(changed.value).toBe(`inserted line\n${text.replace('length 6 m', 'length 7 m')}`);
	});

	/** A context whose section info covers lines [lineStart, lineEnd] of `sectionText`. */
	const ctxAt = (sectionText: string, lineStart: number, lineEnd: number, sourcePath = 'note.md'): MarkdownPostProcessorContext =>
		({ sourcePath, getSectionInfo: () => ({ text: sectionText, lineStart, lineEnd }) }) as unknown as MarkdownPostProcessorContext;

	/** An open editor over `lines`, edited in place. */
	function editorView(lines: string[], path = 'note.md'): MarkdownView {
		const view = new MockView();
		view.file = new MockFile(path);
		view.editor = {
			lineCount: () => lines.length,
			getLine: (n: number) => lines[n] ?? '',
			getValue: () => lines.join('\n'),
			replaceRange: (replacement: string, from: { line: number }, to: { line: number }) => {
				lines.splice(from.line, to.line - from.line, ...replacement.replace(/\n$/, '').split('\n'));
			},
		} as unknown as MarkdownView['editor'];
		return view;
	}

	// Regression: in reading view a block inside a list item gets the whole list as its section, so
	// the section's first line is "- item" and every update was refused.
	it('finds the block inside a wider section (a list in reading view)', async () => {
		const listText = ['- item', '    ```beam', '    length 6 m', '    ```', '- other'].join('\n');
		const lines = listText.split('\n');
		expect(await replaceBlockSource(fakeApp({ view: editorView(lines) }), ctxAt(listText, 0, 4), createDiv(), 'length 8 m', 'length 6 m')).toBe(true);
		expect(lines).toEqual(['- item', '    ```beam', '    length 8 m', '    ```', '- other']);

		const file = { value: listText };
		expect(await replaceBlockSource(fakeApp({ fileText: file }), ctxAt(listText, 0, 4), createDiv(), 'length 8 m', 'length 6 m')).toBe(true);
		expect(file.value).toBe(listText.replace('length 6 m', 'length 8 m'));

		// Without the rendered text there is nothing safe to go on.
		expect(await replaceBlockSource(fakeApp({ fileText: { value: listText } }), ctxAt(listText, 0, 4), createDiv(), 'length 8 m')).toBe(false);
	});

	it('updates only the edited block when the section is a whole blockquote', async () => {
		const quote = ['> ```beam', '> length 6 m', '> pin at 0', '> ```', '> Some quoted text', '> ```beam', '> length 4 m', '> ```', '', 'after'].join('\n');
		const file = { value: quote };
		// Editing the second beam: the section (lines 0..7) starts with the first one.
		expect(await replaceBlockSource(fakeApp({ fileText: file }), ctxAt(quote, 0, 7), createDiv(), 'length 5 m', 'length 4 m')).toBe(true);
		expect(file.value).toBe(quote.replace('length 4 m', 'length 5 m'));

		const lines = quote.split('\n');
		expect(await replaceBlockSource(fakeApp({ view: editorView(lines) }), ctxAt(quote, 0, 7), createDiv(), 'length 7 m', 'length 6 m\npin at 0')).toBe(true);
		expect(lines.join('\n')).toBe(quote.replace('length 6 m\n> pin at 0', 'length 7 m'));
	});

	it('falls back to the rendered text when the section info is stale', async () => {
		const changed = { value: `inserted line\n${text}` };
		expect(await replaceBlockSource(fakeApp({ fileText: changed }), ctx(text), createDiv(), 'length 9 m', 'length 6 m')).toBe(true);
		expect(changed.value).toBe(`inserted line\n${text.replace('length 6 m', 'length 9 m')}`);
	});

	it('refuses when the note is neither open nor in the vault', async () => {
		expect(await replaceBlockSource(fakeApp({}), ctx(text), createDiv(), body, 'length 6 m')).toBe(false);
	});

	// A new body that closes the fence would let the rest of it escape the block: refused on both paths.
	it('refuses a new body that would end the code block early', async () => {
		const escaping = 'length 8 m\n```\n# not part of the beam';
		const lines = text.split('\n');
		expect(await replaceBlockSource(fakeApp({ view: editorView(lines) }), ctx(text), createDiv(), escaping, 'length 6 m')).toBe(false);
		expect(lines).toEqual(text.split('\n'));
		const file = { value: text };
		expect(await replaceBlockSource(fakeApp({ fileText: file }), ctx(text), createDiv(), escaping, 'length 6 m')).toBe(false);
		expect(file.value).toBe(text);
	});

	it('finds an open editor that is not the active view', async () => {
		const lines = text.split('\n');
		expect(await replaceBlockSource(fakeApp({ view: editorView(lines) }), ctx(text), createDiv(), body)).toBe(true);
		expect(lines).toContain('roller at end');
		// A view of another note is not used: the file is rewritten instead.
		const file = { value: text };
		const other = editorView(text.split('\n'), 'other.md');
		expect(await replaceBlockSource(fakeApp({ view: other, fileText: file }), ctx(text), createDiv(), body)).toBe(true);
		expect(file.value).toContain('roller at end');
	});

	it('writes to the path it is given rather than the render-time ctx.sourcePath', async () => {
		const file = { value: text };
		const app = fakeApp({ fileText: file });
		const getFileByPath = vi.spyOn(app.vault, 'getFileByPath');
		expect(await replaceBlockSource(app, ctxAt(text, 1, 3, 'old name.md'), createDiv(), body, 'length 6 m', 'new name.md')).toBe(true);
		expect(getFileByPath).toHaveBeenCalledWith('new name.md');
		expect(file.value).toContain('length 8 m');
	});
});

// ---------------------------------------------------------------------------
// mount.ts
// ---------------------------------------------------------------------------

describe('mountScene', () => {
	const scene: Scene = {
		width: 400,
		height: 120,
		title: 'Shear force diagram',
		desc: 'Maximum shear 18.67 kN at x = 0 m',
		prims: [
			{ tag: 'line', cls: 'bsd-axis', attrs: { x1: 56, y1: 60, x2: 344, y2: 60 } },
			{
				tag: 'path',
				cls: 'bsd-area bsd-positive',
				attrs: { d: 'M 56 60 L 100 20 Z', style: 'fill: red', onclick: 'alert(1)', 'stroke-width': Number.NaN, class: 'injected' },
				tooltip: 'V = 18.67 kN',
			},
			{ tag: 'text', cls: 'bsd-label', attrs: { x: 60, y: 15, 'text-anchor': 'start' }, text: '<b>18.67</b> kN', tooltip: 'Maximum shear' },
		],
	};

	it('creates an accessible svg with one element per primitive', () => {
		const parent = createDiv();
		const svg = mountScene(parent, scene);
		expect(svg.namespaceURI).toBe(SVG_NS);
		expect(svg.parentElement).toBe(parent);
		expect(svg.getAttribute('class')).toBe('bsd-svg');
		expect(svg.getAttribute('viewBox')).toBe('0 0 400 120');
		expect(svg.getAttribute('width')).toBe('400');
		expect(svg.getAttribute('height')).toBe('120');
		expect(svg.getAttribute('role')).toBe('img');
		expect(svg.getAttribute('aria-label')).toBe('Shear force diagram');
		const [title, desc, ...prims] = Array.from(svg.children);
		expect(title?.tagName.toLowerCase()).toBe('title');
		expect(title?.textContent).toBe('Shear force diagram');
		expect(desc?.tagName.toLowerCase()).toBe('desc');
		expect(desc?.textContent).toBe('Maximum shear 18.67 kN at x = 0 m');
		expect(prims.map((p) => p.tagName.toLowerCase())).toEqual(['line', 'path', 'text']);
		expect(prims[0]?.getAttribute('x2')).toBe('344');
		expect(prims[1]?.classList.contains('bsd-positive')).toBe(true);
	});

	it('drops unsafe attributes and adds tooltips as title children', () => {
		const svg = mountScene(createDiv(), scene);
		const path = svg.querySelector('path');
		expect(path?.getAttribute('d')).toBe('M 56 60 L 100 20 Z');
		expect(path?.hasAttribute('style')).toBe(false);
		expect(path?.hasAttribute('onclick')).toBe(false);
		expect(path?.hasAttribute('stroke-width')).toBe(false);
		// prim.cls is the only source of classes: a `class` attribute must not replace it.
		expect(path?.getAttribute('class')).toBe('bsd-area bsd-positive');
		expect(path?.querySelector('title')?.textContent).toBe('V = 18.67 kN');
	});

	it('inserts label text as text, never as markup', () => {
		const svg = mountScene(createDiv(), scene);
		const text = svg.querySelector('text');
		expect(text?.querySelector('b')).toBeNull();
		expect(text?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
		expect(text?.firstChild?.textContent).toBe('<b>18.67</b> kN');
		expect(text?.getAttribute('text-anchor')).toBe('start');
		expect(text?.querySelector('title')?.textContent).toBe('Maximum shear');
	});
});

// ---------------------------------------------------------------------------
// beam-view.ts
// ---------------------------------------------------------------------------

describe('supportName', () => {
	it('names supports like spreadsheet columns', () => {
		expect([0, 1, 2, 25, 26, 27, 51, 52].map(supportName)).toEqual(['A', 'B', 'C', 'Z', 'AA', 'AB', 'AZ', 'BA']);
	});
});

describe('keepTogether', () => {
	it('glues numbers to their units, arrows to their values and "x =" to its position', () => {
		const nb = '\u00a0';
		expect(keepTogether('Support B (roller) at x = 5.00 m')).toBe(`Support B (roller) at x${nb}=${nb}5.00${nb}m`);
		expect(keepTogether('-13.80 kN·m at x = 2.00 m')).toBe(`-13.80${nb}kN·m at x${nb}=${nb}2.00${nb}m`);
		expect(keepTogether('18.67 kN ↑')).toBe(`18.67${nb}kN${nb}↑`);
		expect(keepTogether('Statically indeterminate, degree 2 (vertical loads)')).toBe(`Statically indeterminate, degree${nb}2${nb}(vertical${nb}loads)`);
		expect(keepTogether('L/299 (cantilever 1.00 m, B to free end)')).toBe(`L/299${nb}(cantilever 1.00${nb}m, B to free${nb}end)`);
		expect(keepTogether('None')).toBe('None');
	});
});

describe('analyzeSafely', () => {
	// The overhang makes the left pin pull down by 10·1/4 = 2.5 kN (moments about the roller).
	const uplift = 'length 5\npin at 0\nroller at 4\npoint 10 at 5';

	it('formats numbers in warnings with the decimals setting', () => {
		const warning = (decimals?: number): string | undefined =>
			analyzeSafely(uplift, 'kN-m', decimals).diagnostics.find((d) => d.severity === 'warning')?.message;
		expect(warning()).toContain('(2.50 kN)');
		expect(warning(0)).toContain('(3 kN)');
		expect(warning(3)).toContain('(2.500 kN)');
		// Out-of-range values are clamped like everywhere else in the UI.
		expect(warning(99)).toContain('(2.500000 kN)');
	});
});

describe('resultRows (real parser, model and solver)', () => {
	it('lists reactions, extremes, material and section for the simply supported example', () => {
		const rows = resultRows(analyzeDirect(exampleSource('simply-supported')), 2);
		expect(rowValue(rows, 'Support A (pin) at x = 0.00 m')).toBe('18.67 kN ↑');
		expect(rowValue(rows, 'Support B (roller) at x = 6.00 m')).toBe('15.33 kN ↑');
		// The degree counts vertical restraints only, and says so (Hibbeler-style counting differs).
		expect(rowValue(rows, 'Static determinacy')).toBe('Statically determinate (vertical loads)');
		expect(rowValue(rows, 'Max shear force |V|')).toBe('18.67 kN at x = 0.00 m');
		expect(rowValue(rows, 'Max sagging moment')).toBe('29.39 kN·m at x = 2.17 m');
		expect(rowValue(rows, 'Max hogging moment')).toBe('None');
		// The ratio has its own row now (see the governing ratio tests).
		expect(rowValue(rows, 'Max deflection down')).toMatch(/^\d+\.\d\d mm at x = \d\.\d\d m$/);
		expect(rowValue(rows, 'Worst deflection ratio')).toMatch(/^L\/\d+ \(span 6\.00 m, A to B\)$/);
		expect(rowValue(rows, 'Max deflection up')).toBeUndefined();
		expect(rowValue(rows, 'Material')).toBe('E = 200 GPa (structural steel)');
		// A derived I gets 4 significant digits, and the label's own parentheses are not nested.
		expect(rowValue(rows, 'Section')).toBe('I = 7999 cm⁴, I-beam (no fillets) 150 × 300 × 7.1 × 10.7 mm');
		expect(rowValue(rows, 'Max bending stress')).toMatch(/^\d+\.\d\d MPa at x = 2\.17 m$/);
	});

	it('shows the fixed-end couple with its direction', () => {
		const rows = resultRows(analyzeDirect(exampleSource('cantilever')), 2);
		// 9 kN of triangular load at 2 m (cw 18 kN·m) and a 5 kN·m ccw couple leave 13 kN·m ccw at the clamp.
		expect(rowValue(rows, 'Support A (fixed) at x = 0.00 m')).toBe('9.00 kN ↑');
		expect(rowValue(rows, 'Support A moment')).toBe('13.00 kN·m ↺ counter-clockwise');
		expect(rowValue(rows, 'Max hogging moment')).toBe('-13.00 kN·m at x = 0.00 m');
		const cw = resultRows(analyzeDirect('length 2 m\nfixed at end\npoint 10 kN down at 0'), 1);
		expect(rowValue(cw, 'Support A moment')).toBe('20.0 kN·m ↻ clockwise');
	});

	it('reports indeterminacy and uses the block units', () => {
		expect(rowValue(resultRows(analyzeDirect(exampleSource('propped')), 2), 'Static determinacy')).toBe(
			'Statically indeterminate, degree 1 (vertical loads)',
		);
		expect(rowValue(resultRows(analyzeDirect('length 6\nfixed at 0\nfixed at end\nudl 5 down'), 2), 'Static determinacy')).toBe(
			'Statically indeterminate, degree 2 (vertical loads)',
		);
		const us = resultRows(analyzeDirect(exampleSource('overhang')), 2);
		// Moments about A: 1.2·20·10 + 5·30 = 20·R_B, so R_B = 19.5 kip and R_A = 29 - 19.5 = 9.5 kip.
		expect(rowValue(us, 'Support A (pin) at x = 0.00 ft')).toBe('9.50 kip ↑');
		expect(rowValue(us, 'Support B (roller) at x = 20.00 ft')).toBe('19.50 kip ↑');
		expect(rowValue(us, 'Material')).toBe('E = 29000 ksi');
		expect(rowValue(us, 'Section')).toBe('I = 510 in⁴');
	});

	it('marks overrides of the material and the section', () => {
		const rows = resultRows(analyzeDirect('length 4\npin at 0\nroller at end\nudl 2 down\nmaterial steel\nE 210 GPa\nsection rect 100 x 200 mm\nI 5000 cm^4'), 2);
		expect(rowValue(rows, 'Material')).toBe('E = 210 GPa (overrides structural steel)');
		expect(rowValue(rows, 'Section')).toBe('I = 5000 cm⁴, overrides Rectangle 100 × 200 mm');
	});

	// Regression: the same bare-number text gives a 6 m, 6 ft or 6 mm beam depending on the viewer's
	// setting. The table now says which units are in effect and where they came from.
	it('names the unit system and flags the plugin default', () => {
		const bare = 'length 6\npin at 0\nroller at end\npoint 10 down at 2';
		expect(resultRows(analyzeDirect(bare), 2)[0]).toEqual({ label: 'Units', value: 'kN, m (SI), plugin default (add a units line to make it explicit)' });
		expect(rowValue(resultRows(analyzeDirect(bare, 'kip-ft'), 2), 'Units')).toBe('kip, ft (US), plugin default (add a units line to make it explicit)');
		expect(rowValue(resultRows(analyzeDirect(`units kip ft\n${bare}`), 2), 'Units')).toBe('kip, ft (US)');
	});

	it('shows E and I with 4 significant digits whatever the decimals setting', () => {
		const derived = resultRows(analyzeDirect('length 4\npin at 0\nroller at end\nudl 2 down\nmaterial steel\nsection rect 100 x 200 mm'), 0);
		expect(rowValue(derived, 'Section')).toBe('I = 6667 cm⁴, Rectangle 100 × 200 mm');
		// The same I-beam in N-mm (every length in the example has its own unit).
		const nmm = resultRows(analyzeDirect(`units N mm\n${exampleSource('simply-supported')}`), 2);
		expect(rowValue(nmm, 'Section')).toMatch(/^I = 7\.999e7 mm⁴, /);
		expect([7998.987, 29007.548, 2.9e7, 0.073041, 9993100.13, 200, 29000, 0, -3.2e-5, 1e-11].map((v) => formatSignificant(v))).toEqual([
			'7999',
			'29008',
			'2.9e7',
			'0.07304',
			'9993100',
			'200',
			'29000',
			'0',
			'-3.2e-5',
			'0',
		]);
	});

	// Regression: a preset's SI value converted to US units showed spurious precision (29008 ksi, 9993 ksi).
	it('rounds a preset E to 3 significant digits and keeps a typed E as typed', () => {
		const us = (material: string, extra = ''): string | undefined =>
			rowValue(resultRows(analyzeDirect(`units kip ft\nlength 20\npin at 0\nroller at end\nudl 1 down\nmaterial ${material}\nI 500 in^4${extra}`), 2), 'Material');
		expect(us('steel')).toBe('E = 29000 ksi (structural steel)');
		expect(us('aluminium')).toBe('E = 9990 ksi (aluminium alloy 6061-T6)');
		expect(us('steel', '\nE 29007.5 ksi')).toBe('E = 29008 ksi (overrides structural steel)');
		const si = resultRows(analyzeDirect('length 6\npin at 0\nroller at end\nudl 1 down\nmaterial aluminium\nI 8000 cm^4'), 2);
		expect(rowValue(si, 'Material')).toBe('E = 68.9 GPa (aluminium alloy 6061-T6)');
	});

	// Regression: an absurd E (which withholds the deflection) was shown as "E = 0 GPa".
	it('never shows a non-zero E or I as 0', () => {
		const rows = resultRows(analyzeDirect('length 6\npin at 0\nroller at end\npoint 10 at 2\nE 1e-300 Pa\nI 8000 cm^4'), 2);
		expect(rowValue(rows, 'Material')).toBe('E = 1e-309 GPa');
		expect(formatSignificant(1e-11)).toBe('0');
		expect(formatSignificant(1e-11, 4, 0)).toBe('1e-11');
		expect(formatSignificant(0, 4, 0)).toBe('0');
	});

	// Regression: table rows switched to exponent form from 1e7 ("2.00e8 N·mm" at decimals 4).
	it('prints large table values with the requested decimals', () => {
		const rows = resultRows(analyzeDirect('units N mm\nlength 4000\nfixed at 0\npoint 50000 down at end'), 4);
		expect(rowValue(rows, 'Max hogging moment')).toBe('-200000000.0000 N·mm at x = 0.0000 mm');
		// A down load at the right tip: the wall resists with a counter-clockwise couple.
		expect(rowValue(rows, 'Support A moment')).toBe('200000000.0000 N·mm ↺ counter-clockwise');
	});

	it('honours the decimals and returns nothing for an unsolved beam', () => {
		const rows = resultRows(analyzeDirect(exampleSource('simply-supported')), 0);
		// Positions keep 2 decimals even at decimals 0, so the peak is not misplaced at "x = 2 m".
		expect(rowValue(rows, 'Support A (pin) at x = 0.00 m')).toBe('19 kN ↑');
		expect(rowValue(rows, 'Max sagging moment')).toBe('29 kN·m at x = 2.17 m');
		expect(resultRows({ ast: emptyAst(), units: 'kN-m', diagnostics: [] }, 2)).toEqual([]);
	});
});

// Regression: L/delta used to divide the TOTAL length by the global peak, and rounded to the nearest
// integer. Multi-span beams and overhangs looked 1.3x to 3x better than they are, a beam failing L/360
// could read exactly "L/360", and the table could print "L/0" while the warning said "60 × L".
describe('worst deflection ratio (per span and cantilever)', () => {
	const ratioRow = (source: string, units: UnitSystemId = 'kN-m'): string | undefined =>
		rowValue(resultRows(analyzeDirect(source, units), 2), 'Worst deflection ratio');

	it('uses the span length on a continuous beam', () => {
		// Total length 12 m gave "L/10894"; the 1.10 mm peak sits in a 4 m end span: 4 / 0.0011015 = 3631.
		const source = 'length 12\npin at 0\nroller at 4\nroller at 8\nroller at 12\nudl 10 down\nE 200 GPa\nI 8000 cm^4';
		expect(ratioRow(source)).toBe('L/3631 (span 4.00 m, A to B)');
		const rows = resultRows(analyzeDirect(source), 2);
		expect(rowValue(rows, 'Max deflection down')).toBe('1.10 mm at x = 1.78 m');
	});

	it('uses the back span on an overhanging beam', () => {
		// Total length 8000 mm gave "L/1133"; the span is 6000 mm: 6000 / 7.058 = 850. The 2000 mm
		// overhang lifts 1.842 mm (L/1086), which does not govern.
		const source = 'units N mm\nlength 8000\npin at 0\nroller at 6000\nudl 25 down\npoint 12500 down at end\nmaterial steel\nsection ibeam 150 x 400 x 8 x 13';
		expect(ratioRow(source)).toBe('L/850 (span 6000.00 mm, A to B)');
		const rows = resultRows(analyzeDirect(source), 2);
		expect(rowValue(rows, 'Max deflection up')).toBe('1.84 mm at x = 8000.00 mm');
	});

	it('reports a cantilever tip that governs although it is not the largest deflection', () => {
		// Span 0..6: 7.489 mm = L/801. Overhang 6..7: 3.333 mm = L/299, which fails L/360.
		const source = 'length 7\npin at 0\nroller at 6\nudl 20 down from 0 to 6\npoint 100 down at end\nE 200 GPa\nI 8000 cm^4';
		expect(ratioRow(source)).toBe('L/299 (cantilever 1.00 m, B to free end)');
		const results = analyzeDirect(source).results;
		if (!results) throw new Error('not solved');
		const governing = governingDeflectionRatio(results);
		expect(governing).toMatchObject({ kind: 'cantilever', x0: 6, x1: 7 });
		expect(governing?.peak).toBeCloseTo(0.003333, 6);
	});

	it('names a left overhang from its free end', () => {
		expect(ratioRow('length 10\npin at 2\nroller at 8\nudl 5 down\nE 200 GPa\nI 8000 cm^4')).toBe('L/1599 (cantilever 2.00 m, free end to A)');
	});

	it('rounds down, so a failing beam never reads as passing', () => {
		// delta = 16.685 mm on 6 m is L/359.6: it fails L/360 and must not print "L/360".
		expect(ratioRow('length 6\npin at 0\nroller at end\nudl 15.82 down\nE 200 GPa\nI 8000 cm^4')).toBe('L/359 (span 6.00 m, A to B)');
	});

	it('agrees with the large-deflection warning and never prints L/0', () => {
		// A typical wrong-unit I: the tip drops 60 times the length.
		const source = 'length 6 m\nfixed at 0\npoint 10 kN at end\nE 200 GPa\nI 1 cm^4';
		expect(ratioRow(source)).toBe('60 × L (cantilever 6.00 m, A to free end)');
		const analysis = analyzeBeam(source, { defaultUnits: 'kN-m' });
		expect(analysis.diagnostics.find((d) => d.severity === 'warning')?.message).toContain('60 × L');
		const table = resultRows(analysis, 2).map((r) => r.value).join('\n');
		expect(table).not.toContain('L/0');
	});

	it('is absent without deflection results or when nothing deflects', () => {
		expect(ratioRow('length 6\npin at 0\nroller at end\nudl 5 down')).toBeUndefined();
		expect(ratioRow('length 6\npin at 0\nroller at end\nE 200 GPa\nI 8000 cm^4')).toBeUndefined();
	});

	it('formats ratios rounded down, with the "n × L" form above the length', () => {
		expect(formatSpanRatio(6, 6 / 359.6)).toBe('L/359');
		expect(formatSpanRatio(6, -6 / 300)).toBe('L/300');
		expect(formatSpanRatio(6, 12)).toBe('2 × L');
		expect(formatSpanRatio(5, 6.5)).toBe('1.3 × L');
	});
});

describe('renderBeamOutput', () => {
	it('lists errors with line numbers and the offending source line', () => {
		const container = createDiv();
		container.createDiv({ text: 'stale content' });
		const analysis: AnalysisOutput = {
			ast: emptyAst(),
			units: 'kN-m',
			diagnostics: [
				{ severity: 'error', message: 'Unknown statement "lenght". Did you mean "length"?', line: 1 },
				{ severity: 'warning', message: 'Some warning', line: 2 },
				{ severity: 'error', message: 'Add a length, for example: length 6 m' },
			],
		};
		renderBeamOutput(container, analysis, DEFAULT_SETTINGS, 600, 'lenght 6 m\npin at 0');
		expect(container.textContent).not.toContain('stale content');
		const box = container.querySelector('.bsd-error');
		// Not a live region: the box is rebuilt on every redraw and would be announced again each time.
		expect(box).not.toBeNull();
		expect(box?.hasAttribute('role')).toBe(false);
		const items = Array.from(box?.querySelectorAll('li') ?? []);
		expect(items).toHaveLength(2);
		expect(items[0]?.querySelector('.bsd-error-message')?.textContent).toBe('Line 1: Unknown statement "lenght". Did you mean "length"?');
		expect(items[0]?.querySelector('code.bsd-error-source')?.textContent).toBe('lenght 6 m');
		expect(items[1]?.textContent).toBe('Add a length, for example: length 6 m');
		expect(container.querySelector('svg')).toBeNull();
		expect(container.querySelector('.bsd-table')).toBeNull();
	});

	it('lays out title, drawings, warnings, table and disclaimer (stub scenes)', async () => {
		// Stub the scene builders for this test only, so the layout is checked independently of the renderer.
		vi.resetModules();
		const stub = (title: string): Scene => ({ width: 300, height: 50, title, desc: '', prims: [] });
		vi.doMock('../src/render/beam-scene', () => ({ buildBeamScene: () => stub('Beam') }));
		vi.doMock('../src/render/chart-scene', () => ({ buildDiagramScene: (_r: unknown, q: string) => stub(q) }));
		try {
			const view = await import('../src/ui/beam-view');
			const analysis = analyzeDirect(exampleSource('simply-supported'));
			analysis.diagnostics.push({ severity: 'warning', message: 'Check this', line: 3 });
			const container = createDiv();
			view.renderBeamOutput(container, analysis, DEFAULT_SETTINGS, 600);
			expect(container.querySelector('.bsd-title')?.textContent).toBe('Simply supported beam');
			const labels = Array.from(container.querySelectorAll('svg.bsd-svg')).map((s) => s.getAttribute('aria-label'));
			expect(labels).toEqual(['Beam', 'shear', 'moment', 'deflection']);
			expect(container.querySelector('.bsd-warnings li')?.textContent).toBe('Line 3: Check this');
			expect(container.querySelectorAll('.bsd-table th[scope="row"]').length).toBeGreaterThan(5);
			expect(container.querySelector('.bsd-table caption')?.textContent).toBe('Results');
			expect(container.lastElementChild?.className).toBe('bsd-disclaimer');
			expect(container.querySelector('.bsd-disclaimer')?.textContent).toBe(DISCLAIMER);

			const plain = createDiv();
			view.renderBeamOutput(plain, analysis, { ...DEFAULT_SETTINGS, showDeflection: false, showResultsTable: false }, 600);
			expect(plain.querySelectorAll('svg.bsd-svg')).toHaveLength(3);
			expect(plain.querySelector('.bsd-table')).toBeNull();
		} finally {
			vi.doUnmock('../src/render/beam-scene');
			vi.doUnmock('../src/render/chart-scene');
			vi.resetModules();
		}
	});

	it('end to end: draws a simple beam with svg diagrams and a results table', () => {
		const source = exampleSource('simply-supported');
		const analysis = analyzeBeam(source, { defaultUnits: 'kN-m' });
		const container = createDiv();
		container.addClass('bsd-block');
		renderBeamOutput(container, analysis, DEFAULT_SETTINGS, 640, source);
		expect(container.querySelector('.bsd-error')).toBeNull();
		const svgs = container.querySelectorAll('svg.bsd-svg');
		// Beam, shear, moment and deflection (the example has a material and a section).
		expect(svgs).toHaveLength(4);
		for (const svg of Array.from(svgs)) {
			expect(svg.getAttribute('role')).toBe('img');
			expect(svg.children.length).toBeGreaterThan(2);
		}
		const table = container.querySelector('table.bsd-table');
		expect(table).not.toBeNull();
		// Numbers, units and arrows are joined by no-break spaces so they never wrap apart.
		expect(table?.textContent).toContain('18.67\u00a0kN\u00a0↑');
		expect(table?.querySelector('th')?.textContent).toBe('Units');
		expect(container.querySelector('.bsd-disclaimer')).not.toBeNull();
	});

	it('end to end: a broken block shows the error box', () => {
		const source = 'length 6 m\npin at 0\nroller at end\npoint ten kN down at 2';
		const container = createDiv();
		renderBeamOutput(container, analyzeBeam(source, { defaultUnits: 'kN-m' }), DEFAULT_SETTINGS, 640, source);
		const box = container.querySelector('.bsd-error');
		expect(box).not.toBeNull();
		expect(box?.hasAttribute('role')).toBe(false);
		expect(box?.textContent).toContain('Line 4:');
		expect(box?.querySelector('.bsd-error-source')?.textContent).toBe('point ten kN down at 2');
		expect(container.querySelector('svg')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// editor-modal.ts: pure helpers
// ---------------------------------------------------------------------------

describe('editor helpers', () => {
	it('parses for the form only when there are no syntax errors', () => {
		const ok = parseForForm(DEFAULT_BEAM_SOURCE);
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(ok.ast.commentCount).toBe(2);
		// A missing length is a model error, not a syntax error: the form can fix it.
		expect(parseForForm('pin at 0').ok).toBe(true);
		const bad = parseForForm('length 6 m\nbogus statement');
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors[0]?.line).toBe(2);
	});

	it('converts loads between types, keeping compatible units only', () => {
		const point: AstLoad = { kind: 'point', magnitude: '10 kN', direction: 'up', at: '2 m' };
		expect(changeLoadKind(point, 'moment')).toEqual({ kind: 'moment', magnitude: '10', direction: 'cw', at: '2 m' });
		expect(changeLoadKind(point, 'udl')).toEqual({ kind: 'udl', magnitude: '10', direction: 'up' });
		const udl: AstLoad = { kind: 'udl', magnitude: '4 kN/m', direction: 'down', from: '1', to: '5' };
		expect(changeLoadKind(udl, 'linear')).toEqual({ kind: 'linear', start: '4 kN/m', end: '4 kN/m', direction: 'down', from: '1', to: '5' });
		expect(changeLoadKind(udl, 'point')).toEqual({ kind: 'point', magnitude: '4', direction: 'down', at: '1' });
		expect(changeLoadKind(udl, 'udl')).toBe(udl);
	});

	it('suggests supports and resizes sections', () => {
		const ast = emptyAst();
		expect(newSupport(ast)).toEqual({ kind: 'pin', at: '0' });
		ast.supports.push({ kind: 'pin', at: '0' });
		expect(newSupport(ast)).toEqual({ kind: 'roller', at: 'end' });
		expect(changeSectionShape(undefined, 'rect')).toEqual({ shape: 'rect', dims: ['100', '200'], unit: 'mm' });
		expect(changeSectionShape({ shape: 'rect', dims: ['120', '240'], unit: 'cm' }, 'box')).toEqual({
			shape: 'box',
			dims: ['120', '240', '10'],
			unit: 'cm',
		});
		expect(changeSectionShape({ shape: 'rect', dims: ['1', '2'] }, undefined)).toBeUndefined();
		expect(optionalText('  ')).toBeUndefined();
		expect(optionalText(' a ')).toBe('a');
	});

	// exampleDims reads the numbers back out of each shape's display example: guard every shape.
	it('fills every section shape with numeric example dimensions', () => {
		for (const shape of Object.keys(SECTION_SHAPES) as SectionShape[]) {
			const dims = changeSectionShape(undefined, shape)?.dims ?? [];
			expect(dims, shape).toHaveLength(SECTION_SHAPES[shape].dims.length);
			for (const d of dims) expect(Number.isFinite(Number(d)) && d.trim() !== '', `${shape}: "${d}"`).toBe(true);
		}
	});

	// Regression: form dims ["100", "200 cm"] (bare = mm, as the placeholder says) were written as
	// "100 x 200 cm", where a unit after the last dimension applies to all: 100 cm x 200 cm.
	it('writes the default unit on bare dimensions when only the last one has a unit', () => {
		expect(sectionForText({ shape: 'rect', dims: ['100', '200 cm'] }, 'kN-m')).toEqual({ shape: 'rect', dims: ['100 mm', '200 cm'] });
		expect(sectionForText({ shape: 'rect', dims: ['4', '8 ft'] }, 'kip-ft').dims).toEqual(['4 in', '8 ft']);
		// Nothing ambiguous: unchanged (same object).
		const shared = { shape: 'rect' as const, dims: ['100', '200'], unit: 'cm' };
		expect(sectionForText(shared, 'kN-m')).toBe(shared);
		// N-mm and lb-in use one length unit for both, so bare numbers stay bare.
		const firstOnly = { shape: 'rect' as const, dims: ['100 cm', '200'] };
		expect(sectionForText(firstOnly, 'N-mm')).toBe(firstOnly);
		const bare = { shape: 'rect' as const, dims: ['100', '200'] };
		expect(sectionForText(bare, 'N-mm')).toBe(bare);
		expect(sectionForText(bare, 'lb-in')).toBe(bare);
	});

	// Regression: bare section numbers are an error in kN-m and kip-ft blocks, so a
	// blank Dimension unit field must write the unit its placeholder shows.
	it('writes the default section unit for bare dimensions in kN-m and kip-ft', () => {
		expect(sectionForText({ shape: 'rect', dims: ['100', '200'] }, 'kN-m')).toEqual({ shape: 'rect', dims: ['100', '200'], unit: 'mm' });
		expect(sectionForText({ shape: 'rect', dims: ['100 cm', '200'] }, 'kN-m')).toEqual({ shape: 'rect', dims: ['100 cm', '200'], unit: 'mm' });
		expect(sectionForText({ shape: 'rect', dims: ['4', '8'] }, 'kip-ft').unit).toBe('in');
		// The written text analyses without errors and gives the section the form shows.
		const section = sectionForText({ shape: 'rect', dims: ['100', '200'] }, 'kN-m');
		const text = `units kN m\nlength 6\npin at 0\nroller at end\npoint 10 at 3\nmaterial steel\nsection rect ${section.dims.join(' x ')} ${section.unit ?? ''}`;
		const analysis = analyzeBeam(text, { defaultUnits: 'kN-m' });
		expect(analysis.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		expect(analysis.model?.section?.label).toBe('Rectangle 100 × 200 mm');
	});

	// Regression: blocks saved with bare numbers changed meaning with the viewer's default units.
	it('adds an explicit units line, keeping comments and layout', () => {
		expect(withExplicitUnits('length 6\npin at 0', 'kip-ft')).toBe('units kip ft\nlength 6\npin at 0');
		expect(withExplicitUnits('title Beam #1\n# note\nlength 6\r\npin at 0', 'kN-m')).toBe('title Beam #1\r\n# note\r\nunits kN m\r\nlength 6\r\npin at 0');
		expect(withExplicitUnits(DEFAULT_BEAM_SOURCE, 'N-mm')).toBe(DEFAULT_BEAM_SOURCE.replace('length 6 m', 'units N mm\nlength 6 m'));
		// Already explicit, or not readable: left alone.
		expect(withExplicitUnits('units lb in\nlength 6', 'kN-m')).toBe('units lb in\nlength 6');
		expect(withExplicitUnits('length 6\nbogus statement', 'kN-m')).toBe('length 6\nbogus statement');
		const parsed = parseBeamSource(withExplicitUnits('title Beam\nlength 6\npin at 0', 'kip-ft'));
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.ast.units).toBe('kip-ft');
	});
});

// ---------------------------------------------------------------------------
// editor-modal.ts: the modal
// ---------------------------------------------------------------------------

/** The first input or select in the setting row named `name`. */
function control<T extends Element>(root: HTMLElement, name: string, selector = 'input'): T {
	const row = Array.from(root.querySelectorAll('.setting-item')).find((r) => r.querySelector('.setting-item-name')?.textContent === name);
	const el = row?.querySelector<T>(selector);
	if (!el) throw new Error(`no ${selector} in row "${name}"`);
	return el;
}

function buttonWithText(root: HTMLElement, text: string): HTMLButtonElement {
	const button = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text);
	if (!button) throw new Error(`no button "${text}"`);
	return button;
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new Event('input'));
}

function choose(el: HTMLSelectElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new Event('change'));
}

function openEditor(options: Partial<BeamEditorOptions> = {}, plugin = fakePlugin()): BeamEditorModal {
	const modal = new BeamEditorModal({} as App, asPlugin(plugin), {
		initialSource: DEFAULT_BEAM_SOURCE,
		mode: 'insert',
		onSubmit: () => true,
		...options,
	});
	modal.open();
	return modal;
}

describe('BeamEditorModal', () => {
	it('opens on the form and derives the text from form edits', () => {
		const modal = openEditor();
		const root = modal.contentEl;
		expect(modal.titleEl.textContent).toBe('Beam editor');
		expect(modal.getTab()).toBe('form');
		expect(isShown(root.querySelector('.bsd-modal-note'))).toBe(true);
		expect(control<HTMLInputElement>(root, 'Length').value).toBe('6 m');

		type(control<HTMLInputElement>(root, 'Length'), '8 m');
		expect(modal.getSource()).toContain('length 8 m');
		// Re-serializing drops the comments, as the note warned.
		expect(modal.getSource()).not.toContain('#');

		buttonWithText(root, 'Add support').click();
		expect(modal.getSource().match(/^(pin|roller|fixed) at /gm)).toHaveLength(3);
		const removeThird = Array.from(root.querySelectorAll('.setting-item'))
			.find((r) => r.querySelector('.setting-item-name')?.textContent === 'Support 3')
			?.querySelector<HTMLElement>('[data-icon="trash-2"]');
		removeThird?.click();
		expect(modal.getSource().match(/^(pin|roller|fixed) at /gm)).toHaveLength(2);

		choose(control<HTMLSelectElement>(root, 'Load 1', 'select'), 'udl');
		expect(modal.getSource()).toContain('udl 10 down');

		choose(control<HTMLSelectElement>(root, 'Section', 'select'), 'circle');
		expect(control<HTMLInputElement>(root, 'Diameter d').value).toBe('100');
		expect(modal.getSource()).toContain('section circle 100 mm');
		modal.close();
	});

	it('switches to text and refuses to go back while the text has syntax errors', () => {
		const modal = openEditor();
		const root = modal.contentEl;
		buttonWithText(root, 'Text').click();
		expect(modal.getTab()).toBe('text');
		const textarea = root.querySelector<HTMLTextAreaElement>('textarea.bsd-modal-textarea');
		expect(textarea?.value).toBe(DEFAULT_BEAM_SOURCE);
		if (!textarea) return;

		type(textarea, 'length 6 m\nbogus statement');
		expect(modal.getSource()).toBe('length 6 m\nbogus statement');
		buttonWithText(root, 'Form').click();
		expect(modal.getTab()).toBe('text');
		const errors = root.querySelector('.bsd-modal-parse-errors');
		expect(isShown(errors)).toBe(true);
		expect(errors?.textContent).toContain('Line 2:');

		type(textarea, 'length 5 m\npin at 0\nroller at end');
		buttonWithText(root, 'Form').click();
		expect(modal.getTab()).toBe('form');
		expect(isShown(root.querySelector('.bsd-modal-parse-errors'))).toBe(false);
		expect(isShown(root.querySelector('.bsd-modal-note'))).toBe(false);
		expect(control<HTMLInputElement>(root, 'Length').value).toBe('5 m');
		modal.close();
	});

	it('opens broken text on the Text tab', () => {
		const modal = openEditor({ initialSource: 'length 6 m\nbogus statement', mode: 'update' });
		expect(modal.getTab()).toBe('text');
		expect(buttonWithText(modal.contentEl, 'Update')).toBeDefined();
		modal.close();
	});

	it('asks before an example replaces edits', () => {
		const modal = openEditor();
		const root = modal.contentEl;
		const examples = control<HTMLSelectElement>(root, 'Start from example', 'select');

		// Unchanged text: loads straight away.
		choose(examples, 'propped');
		expect(modal.getSource()).toBe(exampleSource('propped'));

		type(control<HTMLInputElement>(root, 'Length'), '9 m');
		choose(examples, 'cantilever');
		expect(isShown(root.querySelector('.bsd-modal-confirm'))).toBe(true);
		buttonWithText(root, 'Keep editing').click();
		expect(modal.getSource()).toContain('length 9 m');
		expect(examples.value).toBe('propped');

		choose(examples, 'cantilever');
		buttonWithText(root, 'Replace').click();
		expect(modal.getSource()).toBe(exampleSource('cantilever'));
		modal.close();
	});

	it('end to end: inserts valid text and closes', async () => {
		const onSubmit = vi.fn(() => true);
		const modal = openEditor({ onSubmit });
		const insert = buttonWithText(modal.contentEl, 'Insert');
		expect(insert.disabled).toBe(false);
		expect(modal.contentEl.querySelectorAll('.bsd-modal-preview svg.bsd-svg').length).toBeGreaterThan(2);
		await modal.submit();
		// Saved blocks always carry their units, so the template's bare positions keep their meaning.
		expect(onSubmit).toHaveBeenCalledWith(DEFAULT_BEAM_SOURCE.replace('length 6 m', 'units kN m\nlength 6 m'));
		expect(document.body.contains(modal.containerEl)).toBe(false);
	});

	it('end to end: saves bare numbers with the plugin default units written out', async () => {
		const onSubmit = vi.fn(() => true);
		const bare = '# my beam\nlength 20\npin at 0\nroller at end\npoint 5 down at 8';
		const modal = openEditor({ initialSource: bare, onSubmit }, fakePlugin({ defaultUnits: 'kip-ft' }));
		await modal.submit();
		expect(onSubmit).toHaveBeenCalledWith('# my beam\nunits kip ft\nlength 20\npin at 0\nroller at end\npoint 5 down at 8');
	});

	// Regression: Escape, a backdrop click or Cancel closed the editor and silently dropped the edits.
	it('asks before closing with unsaved changes', () => {
		const modal = openEditor();
		const root = modal.contentEl;
		type(control<HTMLInputElement>(root, 'Length'), '9 m');
		modal.close();
		expect(document.body.contains(modal.containerEl)).toBe(true);
		const confirm = root.querySelector<HTMLElement>('.bsd-modal-confirm');
		expect(isShown(confirm)).toBe(true);
		expect(confirm?.textContent).toContain('Discard your changes?');
		expect(confirm?.getAttribute('role')).toBe('group');
		expect(document.getElementById(confirm?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Discard your changes?');
		// The safe choice has the focus.
		expect(document.activeElement).toBe(buttonWithText(root, 'Keep editing'));

		buttonWithText(root, 'Keep editing').click();
		expect(isShown(confirm)).toBe(false);
		expect(modal.getSource()).toContain('length 9 m');

		buttonWithText(root, 'Cancel').click();
		expect(isShown(confirm)).toBe(true);
		buttonWithText(root, 'Discard').click();
		expect(document.body.contains(modal.containerEl)).toBe(false);

		// Nothing changed: closes straight away.
		const untouched = openEditor();
		untouched.close();
		expect(document.body.contains(untouched.containerEl)).toBe(false);
	});

	it('follows the tabs pattern and names every control', () => {
		const modal = openEditor();
		const root = modal.contentEl;
		const formTab = buttonWithText(root, 'Form');
		const textTab = buttonWithText(root, 'Text');
		expect(root.querySelector('#bsd-modal-form')?.getAttribute('aria-labelledby')).toBe(formTab.id);
		expect(root.querySelector('#bsd-modal-text')?.getAttribute('aria-labelledby')).toBe(textTab.id);
		expect([formTab.getAttribute('tabindex'), textTab.getAttribute('tabindex')]).toEqual(['0', '-1']);

		formTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		expect(modal.getTab()).toBe('text');
		expect(document.activeElement).toBe(textTab);
		expect([formTab.getAttribute('tabindex'), textTab.getAttribute('tabindex')]).toEqual(['-1', '0']);
		textTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		expect(modal.getTab()).toBe('form');
		expect(document.activeElement).toBe(formTab);

		// Every input and dropdown has its own accessible name (Setting does not link its label).
		choose(control<HTMLSelectElement>(root, 'Section', 'select'), 'ibeam');
		const unnamed = Array.from(root.querySelectorAll('input, select, textarea')).filter((el) => !el.getAttribute('aria-label'));
		expect(unnamed.map((el) => el.outerHTML)).toEqual([]);
		expect(root.querySelector('.bsd-modal-status')?.getAttribute('role')).toBe('status');
		modal.close();
	});

	it('keeps the form section meaning when only the last dimension has a unit', () => {
		const modal = openEditor();
		const root = modal.contentEl;
		type(control<HTMLInputElement>(root, 'Dimension unit'), '');
		type(control<HTMLInputElement>(root, 'Depth h'), '200 cm');
		// Bare 100 is mm (the placeholder), so it is written out: "100 x 200 cm" would mean 100 cm.
		expect(modal.getSource()).toContain('section rect 100 mm x 200 cm');
		modal.close();
	});

	it('keeps "#" and "//" in a title typed in the form', () => {
		const modal = openEditor();
		const title = 'Beam #1, see https://example.com/beam // v2';
		type(control<HTMLInputElement>(modal.contentEl, 'Title'), title);
		const parsed = parseForForm(modal.getSource());
		expect(parsed.ok && parsed.ast.title).toBe(title);
		modal.close();
	});

	it('end to end: stays open with an explanation when saving fails', async () => {
		const modal = openEditor({ mode: 'update', onSubmit: () => Promise.resolve(false), failureMessage: WRITE_BACK_FAILED });
		await modal.submit();
		expect(document.body.contains(modal.containerEl)).toBe(true);
		const error = modal.contentEl.querySelector('.bsd-modal-submit-error');
		expect(isShown(error)).toBe(true);
		expect(error?.textContent).toBe(WRITE_BACK_FAILED);
		modal.close();
	});

	it('edits every form field into the text', () => {
		const modal = openEditor();
		const root = modal.contentEl;
		const byLabel = <T extends Element>(label: string): T => {
			const el = root.querySelector<T>(`[aria-label="${label}"]`);
			if (!el) throw new Error(`no control labelled "${label}"`);
			return el;
		};
		type(byLabel<HTMLInputElement>('Title'), 'Edited beam');
		choose(byLabel<HTMLSelectElement>('Units'), 'kN-m');
		choose(byLabel<HTMLSelectElement>('Type of support 2'), 'fixed');
		type(byLabel<HTMLInputElement>('Position of support 2'), '5');

		buttonWithText(root, 'Add hinge').click();
		type(byLabel<HTMLInputElement>('Position of hinge 1'), '3');

		buttonWithText(root, 'Add load').click();
		type(byLabel<HTMLInputElement>('Magnitude of load 3'), '12');
		choose(byLabel<HTMLSelectElement>('Direction of load 3'), 'up');
		type(byLabel<HTMLInputElement>('Position of load 3'), '4');
		type(byLabel<HTMLInputElement>('Start position of load 2 (empty for the whole beam)'), '1');
		type(byLabel<HTMLInputElement>('End position of load 2 (empty for the whole beam)'), '5');

		choose(byLabel<HTMLSelectElement>('Type of load 1'), 'moment');
		choose(byLabel<HTMLSelectElement>('Direction of load 1'), 'ccw');
		choose(byLabel<HTMLSelectElement>('Type of load 3'), 'linear');
		type(byLabel<HTMLInputElement>('Start value of load 3'), '0');
		type(byLabel<HTMLInputElement>('End value of load 3'), '6');

		choose(byLabel<HTMLSelectElement>('Material'), 'aluminium');
		type(byLabel<HTMLInputElement>('E (elastic modulus)'), '70 GPa');
		type(byLabel<HTMLInputElement>('Width b'), '120');
		type(byLabel<HTMLInputElement>('Dimension unit'), 'mm');
		type(byLabel<HTMLInputElement>('I (second moment of area)'), '9000 cm^4');

		const source = modal.getSource();
		for (const line of [
			'title Edited beam',
			'units kN m',
			'fixed at 5',
			'hinge at 3',
			'udl 4 kN/m down from 1 to 5',
			'material aluminium',
			'E 70 GPa',
			'I 9000 cm^4',
			'section rect 120 x 200 mm',
		]) {
			expect(source.split('\n')).toContain(line);
		}
		expect(source).toMatch(/^moment .* ccw at 2 m$/m);
		expect(source).toMatch(/^linear 0 to 6 up/m);
		modal.close();
	});

	it('submits with Mod+Enter', async () => {
		const onSubmit = vi.fn(() => true);
		const modal = openEditor({ onSubmit });
		// The mock Scope records registrations (the real typings do not expose them).
		type Handler = { modifiers: string[] | null; key: string | null; func: (evt: KeyboardEvent) => unknown };
		const { handlers } = modal.scope as unknown as { handlers: Handler[] };
		const handler = handlers.find((h) => h.modifiers?.includes('Mod') === true && h.key === 'Enter');
		expect(handler).toBeDefined();
		const evt = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
		expect(handler?.func(evt)).toBe(false);
		expect(evt.defaultPrevented).toBe(true);
		await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
	});

	it('end to end: stays open with an explanation when inserting throws', async () => {
		const modal = openEditor({
			onSubmit: () => {
				throw new Error('editor gone');
			},
		});
		await modal.submit();
		expect(document.body.contains(modal.containerEl)).toBe(true);
		const error = modal.contentEl.querySelector('.bsd-modal-submit-error');
		expect(isShown(error)).toBe(true);
		expect(error?.textContent).toBe('Could not insert the beam. Copy the text from the Text tab and paste it into the note instead');
		expect(buttonWithText(modal.contentEl, 'Insert').disabled).toBe(false);
		modal.close();
	});

	it('end to end: disables the main button while the beam has errors', () => {
		const onSubmit = vi.fn(() => true);
		const modal = openEditor({ initialSource: 'pin at 0', onSubmit });
		expect(buttonWithText(modal.contentEl, 'Insert').disabled).toBe(true);
		void modal.submit();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(modal.contentEl.querySelector('.bsd-modal-preview .bsd-error')).not.toBeNull();
		modal.close();
	});
});

// ---------------------------------------------------------------------------
// beam-block.ts
// ---------------------------------------------------------------------------

describe('BeamBlockRenderChild', () => {
	const ctx = { sourcePath: 'note.md', getSectionInfo: () => null, addChild: () => undefined } as unknown as MarkdownPostProcessorContext;

	it('adds the toolbar, registers with the plugin and cleans up on unload', () => {
		const plugin = fakePlugin();
		const host = document.body.createDiv();
		const el = host.createDiv();
		const child = new BeamBlockRenderChild(el, asPlugin(plugin), exampleSource('propped'), ctx);
		child.load();
		expect(el.classList.contains('bsd-block')).toBe(true);
		const button = el.querySelector<HTMLButtonElement>('.bsd-toolbar button');
		expect(button?.getAttribute('aria-label')).toBe('Edit beam');
		expect(button?.getAttribute('data-icon')).toBe('pencil');
		expect(el.querySelector('.bsd-output')).not.toBeNull();
		expect(plugin.registerBlock).toHaveBeenCalledWith(child);

		// Presses on the button must not reach Live Preview's handlers.
		const outer = vi.fn();
		host.addEventListener('mousedown', outer);
		button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		expect(outer).not.toHaveBeenCalled();

		button?.click();
		expect(document.body.querySelector('.bsd-modal')).not.toBeNull();

		child.refresh();
		child.unload();
		expect(plugin.unregisterBlock).toHaveBeenCalledWith(child);
	});

	it('re-analyses on refresh only when a setting the analysis uses changed', () => {
		const plugin = fakePlugin();
		const el = document.body.createDiv();
		const child = new BeamBlockRenderChild(el, asPlugin(plugin), exampleSource('propped'), ctx);
		child.load();
		const analysis = (child as unknown as { analysis: unknown }).analysis;
		plugin.settings.showResultsTable = false;
		child.refresh();
		expect((child as unknown as { analysis: unknown }).analysis).toBe(analysis);
		expect(el.querySelector('.bsd-table')).toBeNull();
		plugin.settings.decimals = 3;
		child.refresh();
		expect((child as unknown as { analysis: unknown }).analysis).not.toBe(analysis);
		child.unload();
	});

	// Regression: ctx.sourcePath is captured at render time; after renaming the open note, saving
	// looked for the old path and failed until the note was reopened.
	it('end to end: saves to the note after it was renamed', async () => {
		let onRename: ((file: { path: string }, oldPath: string) => void) | undefined;
		const file = { value: ['# Note', '```beam', exampleSource('propped'), '```'].join('\n') };
		const app = {
			vault: {
				on: vi.fn((name: string, cb: (file: { path: string }, oldPath: string) => void) => {
					if (name === 'rename') onRename = cb;
					return {};
				}),
				getFileByPath: vi.fn((path: string) => (path === 'renamed.md' ? new MockFile(path) : null)),
				process: async (_file: TFile, fn: (data: string) => string) => {
					file.value = fn(file.value);
					return file.value;
				},
			},
			workspace: { getActiveViewOfType: () => null, getLeavesOfType: () => [] },
		};
		const el = document.body.createDiv();
		const child = new BeamBlockRenderChild(el, asPlugin(fakePlugin({}, app)), exampleSource('propped'), ctx);
		child.load();
		onRename?.({ path: 'other.md' }, 'unrelated.md');
		onRename?.({ path: 'renamed.md' }, 'note.md');

		child.openEditor();
		const modalEl = document.body.querySelector<HTMLElement>('.bsd-modal');
		if (!modalEl) throw new Error('no modal');
		buttonWithText(modalEl, 'Text').click();
		const textarea = modalEl.querySelector<HTMLTextAreaElement>('textarea.bsd-modal-textarea');
		if (!textarea) throw new Error('no textarea');
		type(textarea, exampleSource('propped').replace('length 6 m', 'length 7 m'));
		buttonWithText(modalEl, 'Update').click();
		await vi.waitFor(() => expect(file.value).toContain('length 7 m'));
		expect(app.vault.getFileByPath).toHaveBeenCalledWith('renamed.md');
		child.unload();
	});

	it('end to end: redraws at the real width once laid out, then only when the width changes', () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
		const observers: { callback: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
		vi.stubGlobal(
			'ResizeObserver',
			class {
				disconnect = vi.fn();
				constructor(public callback: () => void) {
					observers.push(this);
				}
				observe(): void {}
			},
		);
		// happy-dom does no layout, so the measured width is whatever the test says.
		let width = 0;
		const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
		Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => width, configurable: true });
		try {
			const el = document.body.createDiv();
			const child = new BeamBlockRenderChild(el, asPlugin(fakePlugin()), exampleSource('propped'), ctx);
			const svg = (): SVGSVGElement | null => el.querySelector('.bsd-output svg.bsd-svg');
			child.load();
			// Not laid out yet: drawn at the fallback width.
			expect(svg()?.getAttribute('width')).toBe('640');
			const observer = observers[0];
			if (!observer) throw new Error('no ResizeObserver');

			// First real size: redrawn on the next frame, without waiting for the debounce.
			width = 800;
			observer.callback();
			vi.advanceTimersByTime(20);
			expect(svg()?.getAttribute('width')).toBe('800');

			// Same width again (e.g. the redraw changed only the height): no redraw.
			const drawn = svg();
			observer.callback();
			vi.advanceTimersByTime(200);
			expect(svg()).toBe(drawn);

			// A real resize redraws once, after the debounce.
			width = 500;
			observer.callback();
			vi.advanceTimersByTime(50);
			expect(svg()).toBe(drawn);
			vi.advanceTimersByTime(60);
			expect(svg()?.getAttribute('width')).toBe('500');

			// A hidden tab reports 0: keep the last drawing.
			const before = svg();
			width = 0;
			observer.callback();
			vi.advanceTimersByTime(200);
			expect(svg()).toBe(before);

			child.unload();
			expect(observer.disconnect).toHaveBeenCalled();
		} finally {
			if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original);
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});

	it('end to end: renders the beam into the block', () => {
		const el = document.body.createDiv();
		const child = new BeamBlockRenderChild(el, asPlugin(fakePlugin()), exampleSource('propped'), ctx);
		child.load();
		expect(el.querySelector('.bsd-output .bsd-error')).toBeNull();
		expect(el.querySelectorAll('.bsd-output svg.bsd-svg').length).toBe(3);
		child.unload();
	});
});

// ---------------------------------------------------------------------------
// settings.ts and main.ts
// ---------------------------------------------------------------------------

describe('settings', () => {
	it('repairs loaded data', () => {
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
		expect(
			normalizeSettings({ defaultUnits: 'furlong', decimals: 2.6, momentConvention: 'up', showDeflection: 'yes', showResultsTable: false, extra: 1 }),
		).toEqual({ ...DEFAULT_SETTINGS, decimals: 3, showResultsTable: false });
		expect(normalizeSettings({ decimals: 99 }).decimals).toBe(6);
		expect(normalizeSettings({ decimals: -3 }).decimals).toBe(0);
		expect(normalizeSettings({ decimals: 'x' }).decimals).toBe(2);
		expect(normalizeSettings({ defaultUnits: 'kip-ft', momentConvention: 'tension-side' })).toMatchObject({
			defaultUnits: 'kip-ft',
			momentConvention: 'tension-side',
		});
	});

	it('declares one bound control per setting and redraws blocks on change', async () => {
		const plugin = new BeamStaticsPlugin({} as App, {} as never);
		const refresh = vi.spyOn(plugin, 'refreshBlocks');
		const tab = new BeamStaticsSettingTab({} as App, plugin);
		expect(tab.icon).toBe('ruler');
		const items = tab.getSettingDefinitions();
		const keys = items.map((item) => ('control' in item && item.control ? item.control.key : undefined));
		expect(keys).toEqual(['defaultUnits', 'decimals', 'momentConvention', 'showDeflection', 'showResultsTable']);
		const decimals = items[1];
		if (decimals && 'control' in decimals && decimals.control?.type === 'number') {
			expect(decimals.control.validate?.(7)).toBeTruthy();
			expect(decimals.control.validate?.(1.5)).toBeTruthy();
			expect(decimals.control.validate?.(3)).toBeUndefined();
		} else {
			throw new Error('decimals is not a number control');
		}
		await tab.setControlValue('decimals', 4);
		expect(plugin.settings.decimals).toBe(4);
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});

describe('BeamStaticsPlugin', () => {
	/** The mock Plugin exposes what was registered. */
	type Registered = {
		data: unknown;
		commands: { id: string; name: string; hotkeys?: unknown[]; editorCallback?: (editor: unknown) => void }[];
		codeBlockProcessors: Map<string, (source: string, el: HTMLElement, ctx: unknown) => void>;
		settingTabs: unknown[];
	};

	it('loads settings and registers the processor, settings tab and commands', async () => {
		const plugin = new BeamStaticsPlugin({} as App, {} as never);
		const registered = plugin as unknown as Registered;
		registered.data = { decimals: 9, defaultUnits: 'N-mm' };
		await plugin.onload();
		expect(plugin.settings).toMatchObject({ decimals: 6, defaultUnits: 'N-mm', showDeflection: true });
		expect(registered.commands.map((c) => [c.id, c.name])).toEqual([
			['insert-beam', 'Insert beam diagram'],
			['insert-beam-template', 'Insert beam block template'],
		]);
		expect(registered.commands.every((c) => c.hotkeys === undefined)).toBe(true);
		expect(registered.settingTabs).toHaveLength(1);

		const addChild = vi.fn();
		registered.codeBlockProcessors.get('beam')?.('length 6 m', createDiv(), { addChild, sourcePath: 'n.md' });
		expect(addChild.mock.calls[0]?.[0]).toBeInstanceOf(BeamBlockRenderChild);
	});

	it('inserts the template on its own line and refreshes registered blocks', async () => {
		const plugin = new BeamStaticsPlugin({} as App, {} as never);
		await plugin.onload();
		const registered = plugin as unknown as Registered;
		const replaceSelection = vi.fn();
		const editor = { getCursor: () => ({ line: 0, ch: 5 }), getRange: () => 'Hello', replaceSelection };
		registered.commands.find((c) => c.id === 'insert-beam-template')?.editorCallback?.(editor);
		expect(replaceSelection).toHaveBeenCalledWith(`\n\`\`\`beam\n${DEFAULT_BEAM_SOURCE}\n\`\`\`\n`);

		const block = { refresh: vi.fn() } as unknown as BeamBlockRenderChild;
		plugin.registerBlock(block);
		plugin.refreshBlocks();
		plugin.unregisterBlock(block);
		plugin.refreshBlocks();
		expect((block.refresh as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
	});

	it('end to end: the insert command opens the editor and inserts the block on its own line', async () => {
		const plugin = new BeamStaticsPlugin({} as App, {} as never);
		await plugin.onload();
		const registered = plugin as unknown as Registered;
		const replaceSelection = vi.fn();
		const editor = { getCursor: () => ({ line: 0, ch: 0 }), getRange: () => '', replaceSelection };
		registered.commands.find((c) => c.id === 'insert-beam')?.editorCallback?.(editor);
		const container = document.body.querySelector<HTMLElement>('.modal-container:last-child');
		expect(container?.querySelector('.modal-title')?.textContent).toBe('Beam editor');
		const insert = Array.from(container?.querySelectorAll('button') ?? []).find((b) => b.textContent === 'Insert');
		insert?.click();
		await vi.waitFor(() => expect(replaceSelection).toHaveBeenCalledTimes(1));
		expect(replaceSelection).toHaveBeenCalledWith(`\`\`\`beam\n${DEFAULT_BEAM_SOURCE.replace('length 6 m', 'units kN m\nlength 6 m')}\n\`\`\`\n`);
		expect(document.body.contains(container)).toBe(false);
	});

	// Regression: blocks belong to each note's renderer, so unloading the plugin left their observers
	// running and their edit buttons writing through the old plugin instance.
	it('stops rendered blocks when the plugin unloads', async () => {
		const observers: { disconnect: ReturnType<typeof vi.fn> }[] = [];
		vi.stubGlobal(
			'ResizeObserver',
			class {
				disconnect = vi.fn();
				constructor() {
					observers.push(this);
				}
				observe(): void {}
			},
		);
		try {
			const plugin = new BeamStaticsPlugin(fakeBlockApp() as unknown as App, {} as never);
			const registered = plugin as unknown as Registered;
			// load(), not onload(): only a loaded component runs its register() callbacks on unload.
			plugin.load();
			await vi.waitFor(() => expect(registered.codeBlockProcessors.has('beam')).toBe(true));
			const el = document.body.createDiv();
			const blockCtx = { sourcePath: 'n.md', getSectionInfo: () => null, addChild: (child: BeamBlockRenderChild) => child.load() };
			registered.codeBlockProcessors.get('beam')?.(exampleSource('propped'), el, blockCtx);
			expect(el.querySelector('.bsd-toolbar')).not.toBeNull();
			const refresh = vi.spyOn(BeamBlockRenderChild.prototype, 'refresh');

			plugin.unload();
			expect(observers[0]?.disconnect).toHaveBeenCalled();
			expect(el.querySelector('.bsd-toolbar')).toBeNull();
			// The drawing stays until the note re-renders, but no longer follows the (old) plugin.
			expect(el.querySelector('.bsd-output svg')).not.toBeNull();
			plugin.refreshBlocks();
			expect(refresh).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
		}
	});

	it('reloads settings changed on disk (Sync) and redraws', async () => {
		const plugin = new BeamStaticsPlugin({} as App, {} as never);
		const registered = plugin as unknown as Registered;
		await plugin.onload();
		expect(plugin.settings.decimals).toBe(DEFAULT_SETTINGS.decimals);
		const refresh = vi.spyOn(plugin, 'refreshBlocks');
		registered.data = { decimals: 4, defaultUnits: 'lb-in' };
		await plugin.onExternalSettingsChange();
		expect(plugin.settings).toMatchObject({ decimals: 4, defaultUnits: 'lb-in' });
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});
