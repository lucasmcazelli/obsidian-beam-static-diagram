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
import type { AnalysisOutput, AstLoad, UnitSystemId } from '../src/core/types';
import type { Scene } from '../src/render/scene';
import { BeamStaticsSettingTab, DEFAULT_SETTINGS, normalizeSettings, type BeamStaticsSettings } from '../src/settings';
import { BeamBlockRenderChild } from '../src/ui/beam-block';
import { analyzeSafely, DISCLAIMER, renderBeamOutput, resultRows, supportName } from '../src/ui/beam-view';
import {
	BeamEditorModal,
	changeLoadKind,
	changeSectionShape,
	newSupport,
	optionalText,
	parseForForm,
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

/** A fake plugin with just what the UI touches. */
function fakePlugin(settings: Partial<BeamStaticsSettings> = {}) {
	return {
		app: {},
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
				attrs: { d: 'M 56 60 L 100 20 Z', style: 'fill: red', onclick: 'alert(1)', 'stroke-width': Number.NaN },
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
		expect(rowValue(rows, 'Static determinacy')).toBe('Statically determinate');
		expect(rowValue(rows, 'Max shear force |V|')).toBe('18.67 kN at x = 0.00 m');
		expect(rowValue(rows, 'Max sagging moment')).toBe('29.39 kN·m at x = 2.17 m');
		expect(rowValue(rows, 'Max hogging moment')).toBe('None');
		expect(rowValue(rows, 'Max deflection down')).toMatch(/^\d+\.\d\d mm at x = \d\.\d\d m \(L\/\d+\)$/);
		expect(rowValue(rows, 'Max deflection up')).toBeUndefined();
		expect(rowValue(rows, 'Material')).toBe('E = 200 GPa (structural steel)');
		expect(rowValue(rows, 'Section')).toBe('I = 7998.987 cm⁴ (I-beam (no fillets) 150 × 300 × 7.1 × 10.7 mm)');
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
		expect(rowValue(resultRows(analyzeDirect(exampleSource('propped')), 2), 'Static determinacy')).toBe('Statically indeterminate (degree 1)');
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
		expect(rowValue(rows, 'Section')).toBe('I = 5000 cm⁴ (overrides Rectangle 100 × 200 mm)');
	});

	it('honours the decimals and returns nothing for an unsolved beam', () => {
		const rows = resultRows(analyzeDirect(exampleSource('simply-supported')), 0);
		expect(rowValue(rows, 'Support A (pin) at x = 0 m')).toBe('19 kN ↑');
		expect(resultRows({ ast: emptyAst(), units: 'kN-m', diagnostics: [] }, 2)).toEqual([]);
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
		expect(box?.getAttribute('role')).toBe('alert');
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
		expect(table?.textContent).toContain('18.67 kN ↑');
		expect(container.querySelector('.bsd-disclaimer')).not.toBeNull();
	});

	it('end to end: a broken block shows the error box', () => {
		const source = 'length 6 m\npin at 0\nroller at end\npoint ten kN down at 2';
		const container = createDiv();
		renderBeamOutput(container, analyzeBeam(source, { defaultUnits: 'kN-m' }), DEFAULT_SETTINGS, 640, source);
		const box = container.querySelector('.bsd-error[role="alert"]');
		expect(box).not.toBeNull();
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
		expect(onSubmit).toHaveBeenCalledWith(DEFAULT_BEAM_SOURCE);
		expect(document.body.contains(modal.containerEl)).toBe(false);
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
});
