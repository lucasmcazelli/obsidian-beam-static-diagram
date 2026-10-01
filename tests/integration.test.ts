/**
 * Cross-module checks: things that only break when two layers disagree.
 *
 * - styles.css styles every class the scene builders emit, has no rules for
 *   classes nothing emits, and keeps its font sizes in step with LAYOUT
 *   (label placement relies on them).
 * - Text typed by the user never matches inherited object properties
 *   ("constructor", "toString") in any keyword table.
 * - analyzeBeam drops the follow-on messages of a broken line using the
 *   parser's own vocabulary and the model's own message texts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeBeam } from '../src/core/analyze';
import { BEAM_EXAMPLES, DEFAULT_BEAM_SOURCE } from '../src/core/examples';
import { ownValue } from '../src/core/lookup';
import { findMaterial } from '../src/core/materials';
import { INCOMPLETE_STIFFNESS_MESSAGE, MISSING_LENGTH_MESSAGE, MISSING_SUPPORT_MESSAGE } from '../src/core/model';
import { guessStatementType, parseBeamSource, positionKeyword } from '../src/core/parser';
import { findSectionShape } from '../src/core/sections';
import type { DiagramQuantity, MomentConvention } from '../src/core/types';
import { parseUnitSystem } from '../src/core/units';
import { buildBeamScene } from '../src/render/beam-scene';
import { buildDiagramScene } from '../src/render/chart-scene';
import { LAYOUT } from '../src/render/scene';
import type { Scene } from '../src/render/scene';

const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

/** Class names used in CSS selectors (".bsd-value", not custom properties such as --bsd-ink). */
const CSS_CLASSES = new Set(Array.from(CSS.matchAll(/\.(bsd-[a-z0-9-]+)/g), (m) => m[1] ?? ''));

/** Every TypeScript source under src/, concatenated, to find where a class is emitted. */
function sourceText(dir: URL): string {
	let text = '';
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) text += sourceText(new URL(`${entry.name}/`, dir));
		else if (entry.name.endsWith('.ts')) text += readFileSync(new URL(entry.name, dir), 'utf8');
	}
	return text;
}

/** Every scene of every example, in both moment conventions, with and without results. */
function exampleScenes(): Scene[] {
	const scenes: Scene[] = [];
	const conventions: MomentConvention[] = ['sagging-up', 'tension-side'];
	const quantities: DiagramQuantity[] = ['shear', 'moment', 'deflection'];
	for (const source of [...BEAM_EXAMPLES.map((e) => e.source), DEFAULT_BEAM_SOURCE, 'length 4\nfixed at 0\nmoment 3 kNm cw at end']) {
		const out = analyzeBeam(source, { defaultUnits: 'kN-m' });
		if (!out.model || !out.results) throw new Error(`Expected results: ${JSON.stringify(out.diagnostics)}`);
		for (const momentConvention of conventions) {
			const options = { width: 640, units: out.units, decimals: 2, momentConvention };
			scenes.push(buildBeamScene(out.model, out.results, options), buildBeamScene(out.model, undefined, options));
			for (const q of quantities) scenes.push(buildDiagramScene(out.results, q, options));
		}
	}
	return scenes;
}

/** Declared font-size (px) of the rule whose whole selector list is exactly `selector`. */
function fontSizeOf(selector: string): number | undefined {
	// Comments are removed first so a rule's selector is everything between the previous "}" and its "{".
	const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
	for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
		if ((rule[1] ?? '').trim() !== selector) continue;
		const size = /font-size:\s*([\d.]+)px/.exec(rule[2] ?? '');
		if (size?.[1]) return Number(size[1]);
	}
	return undefined;
}

describe('styles.css and the renderer agree', () => {
	it('styles every class the scene builders emit', () => {
		const emitted = new Set<string>();
		for (const scene of exampleScenes()) {
			emitted.add('bsd-svg');
			for (const prim of scene.prims) for (const cls of prim.cls.split(/\s+/)) if (cls) emitted.add(cls);
		}
		const missing = [...emitted].filter((cls) => !CSS_CLASSES.has(cls));
		expect(missing).toEqual([]);
		// The other way round: every class of the "SVG diagram" section is drawn by some example
		// (bsd-block is the container the UI adds, not a scene class).
		const svgSection = CSS.slice(CSS.indexOf('2. SVG diagram'), CSS.indexOf('3. Block UI'));
		const svgClasses = new Set(Array.from(svgSection.matchAll(/\.(bsd-[a-z0-9-]+)/g), (m) => m[1] ?? ''));
		svgClasses.delete('bsd-block');
		expect([...svgClasses].filter((cls) => !emitted.has(cls))).toEqual([]);
	});

	it('has no rules for classes that nothing emits', () => {
		const src = sourceText(new URL('../src/', import.meta.url));
		const unused = [...CSS_CLASSES].filter((cls) => !src.includes(cls));
		expect(unused).toEqual([]);
	});

	it('keeps label font sizes in step with LAYOUT', () => {
		expect(fontSizeOf('.bsd-block .bsd-svg')).toBe(LAYOUT.fontSize);
		expect(fontSizeOf('.bsd-block .bsd-load-label')).toBe(LAYOUT.fontSize);
		expect(fontSizeOf('.bsd-block .bsd-reaction-label')).toBe(LAYOUT.fontSize);
		expect(fontSizeOf('.bsd-block .bsd-diagram-title')).toBe(LAYOUT.fontSize);
		expect(fontSizeOf('.bsd-block .bsd-value')).toBe(LAYOUT.smallFontSize);
		expect(fontSizeOf('.bsd-block .bsd-dim-label')).toBe(LAYOUT.smallFontSize);
		expect(fontSizeOf('.bsd-block .bsd-note')).toBe(LAYOUT.smallFontSize);
	});

	it('takes colours from theme variables outside the print section', () => {
		const screen = CSS.slice(0, CSS.indexOf('@media print'));
		// rgb() is allowed only around a theme variable: Obsidian's --callout-color is an
		// "r, g, b" triple that nothing but rgb() can consume. Literal colours still fail.
		expect(screen).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\((?!\s*var\(--)|hsla?\(/i);
		expect(screen).toMatch(/rgb\(var\(--callout-color\)\)/);
		expect('color: rgb(0, 0, 0)').toMatch(/#[0-9a-f]{3,8}\b|rgba?\((?!\s*var\(--)|hsla?\(/i);
		expect(CSS).not.toContain('!important');
	});
});

describe('user text never matches inherited object properties', () => {
	const inherited = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

	it('ownValue only sees own keys', () => {
		const table: Record<string, number> = { a: 1 };
		expect(ownValue(table, 'a')).toBe(1);
		for (const key of inherited) expect(ownValue(table, key)).toBeUndefined();
	});

	it('keyword lookups reject inherited names', () => {
		for (const word of inherited) {
			expect(guessStatementType(word)).toBeUndefined();
			expect(positionKeyword(word)).toBeUndefined();
			expect(findSectionShape(word)).toBeUndefined();
			expect(findMaterial(word)).toBeUndefined();
			expect(parseUnitSystem(word)).toBeNull();
		}
	});

	it('reports a clear error for every statement that uses one', () => {
		const cases: [string, string][] = [
			['constructor 5', 'Unknown statement "constructor"'],
			['units constructor', 'Unknown unit system "constructor"'],
			['section constructor 1 x 2', 'Unknown section shape "constructor"'],
			['support constructor at 0', 'Expected a support type after "support"'],
			['pin at constructor', 'Expected a position after "at"'],
			['point 10 valueOf at 2', 'Unknown unit "valueOf"'],
		];
		for (const [line, message] of cases) {
			const { diagnostics } = parseBeamSource(line);
			expect(diagnostics, line).toHaveLength(1);
			expect(diagnostics[0]?.message, line).toContain(message);
		}
		const out = analyzeBeam('length 6\npin at 0\nroller at end\nmaterial constructor\nsection rect 100 x 200 mm', { defaultUnits: 'kN-m' });
		expect(out.diagnostics.map((d) => d.message)).toEqual([expect.stringContaining('Unknown material "constructor"')]);
	});
});

describe('follow-on messages of a broken line', () => {
	it('recognises keywords, aliases and typos with the parser vocabulary', () => {
		expect(guessStatementType('Length')).toBe('length');
		expect(guessStatementType('span')).toBe('length');
		expect(guessStatementType('lenght')).toBe('length');
		expect(guessStatementType('clamped')).toBe('fixed');
		expect(guessStatementType('rolelr')).toBe('roller');
		expect(guessStatementType('point')).toBe('point');
		expect(guessStatementType('e')).toBe('E');
		expect(guessStatementType('Ix')).toBe('I');
		expect(guessStatementType('zzzzzz')).toBeUndefined();
	});

	it('drops exactly the model messages a broken line explains', () => {
		const messages = (source: string): string[] => analyzeBeam(source, { defaultUnits: 'kN-m' }).diagnostics.map((d) => d.message);
		expect(messages('lenght 6 m\npin at 0\nroller at end')).not.toContain(MISSING_LENGTH_MESSAGE);
		expect(messages('length 6 m\nrolelr at 0')).not.toContain(MISSING_SUPPORT_MESSAGE);
		expect(messages('length 6 m\npin at 0\nroller at end\nmaterial steel\nsectoin rect 1 x 2')).not.toContain(INCOMPLETE_STIFFNESS_MESSAGE);
		// The "EI" hint counts as a broken stiffness line, the "free" hint as no statement at all.
		expect(messages('length 6 m\npin at 0\nroller at end\nmaterial steel\nEI 16000 kNm2')).not.toContain(INCOMPLETE_STIFFNESS_MESSAGE);
		expect(messages('length 6 m\nfree at end')).toContain(MISSING_SUPPORT_MESSAGE);
		// A broken load line does not explain a missing length or support.
		const unrelated = messages('pointt 10 at 2');
		expect(unrelated).toContain(MISSING_LENGTH_MESSAGE);
		expect(unrelated).toContain(MISSING_SUPPORT_MESSAGE);
	});
});
