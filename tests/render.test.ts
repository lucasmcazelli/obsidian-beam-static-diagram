import { describe, expect, it } from 'vitest';
import { analyzeBeam } from '../src/core/analyze';
import { BEAM_EXAMPLES } from '../src/core/examples';
import { solveBeam } from '../src/core/solver';
import type { BeamModel, BeamResults, DiagramQuantity, MomentConvention, UnitSystemId } from '../src/core/types';
import { buildBeamScene } from '../src/render/beam-scene';
import { buildDiagramScene, segmentHitsBox, splitAtZero } from '../src/render/chart-scene';
import { arcArrow, boxesOverlap, hatchPath, packRows, placeText, sceneWidth, verticalArrow } from '../src/render/draw';
import type { Box } from '../src/render/draw';
import { createXLayout, estimateTextWidth, LAYOUT } from '../src/render/scene';
import type { Prim, Scene, SceneOptions } from '../src/render/scene';
import { escapeXml, sceneToSvgString } from '../src/render/svg-string';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Joins block lines. */
function block(...lines: string[]): string {
	return lines.join('\n');
}

/** Model, results and units of a block that must solve. */
function solve(source: string): { model: BeamModel; results: BeamResults; units: UnitSystemId } {
	const out = analyzeBeam(source, { defaultUnits: 'kN-m' });
	if (!out.model || !out.results) throw new Error(`Expected results: ${JSON.stringify(out.diagnostics)}`);
	return { model: out.model, results: out.results, units: out.units };
}

/** Scene options with sensible defaults. */
function opts(units: UnitSystemId, over: Partial<SceneOptions> = {}): SceneOptions {
	return { width: 640, units, decimals: 2, momentConvention: 'sagging-up', ...over };
}

/** Source of a bundled example. */
function example(id: string): string {
	const found = BEAM_EXAMPLES.find((e) => e.id === id);
	if (!found) throw new Error(`Missing example ${id}`);
	return found.source;
}

/** Every scene of a block: beam with and without results, and each available diagram. */
function allScenes(source: string, over: Partial<SceneOptions> = {}): Scene[] {
	const { model, results, units } = solve(source);
	const o = opts(units, over);
	const scenes = [buildBeamScene(model, results, o), buildBeamScene(model, undefined, o)];
	const quantities: DiagramQuantity[] = ['shear', 'moment', 'deflection'];
	for (const q of quantities) scenes.push(buildDiagramScene(results, q, o));
	return scenes;
}

/** Font size used by a text primitive, per styles.css. */
function fontSizeOf(prim: Prim): number {
	return /bsd-(value|dim-label|note|zero)/.test(prim.cls) ? LAYOUT.smallFontSize : LAYOUT.fontSize;
}

/** Estimated box of a text primitive from its attributes (same estimate the builders use). */
function textBox(prim: Prim): Box {
	const fs = fontSizeOf(prim);
	const w = estimateTextWidth(prim.text ?? '', fs);
	const x = Number(prim.attrs.x);
	const y = Number(prim.attrs.y);
	const anchor = prim.attrs['text-anchor'];
	const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
	return { x0, x1: x0 + w, y0: y - 0.75 * fs, y1: y + 0.25 * fs };
}

/** All numbers in a primitive's geometric attributes. */
function numbersOf(prim: Prim): number[] {
	const out: number[] = [];
	for (const [name, value] of Object.entries(prim.attrs)) {
		if (name === 'text-anchor') continue;
		if (typeof value === 'number') {
			out.push(value);
		} else if (name === 'points' || name === 'd') {
			// Any NaN or Infinity text would also fail here.
			expect(value).not.toMatch(/NaN|Infinity|undefined/);
			for (const m of value.matchAll(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g)) out.push(Number(m[0]));
		} else {
			out.push(Number(value));
		}
	}
	return out;
}

/** Text primitives with a given class. */
function texts(scene: Scene, cls: string): Prim[] {
	return scene.prims.filter((p) => p.tag === 'text' && p.cls.split(' ').includes(cls));
}

/** Parses a polyline/polygon `points` attribute. */
function parsePoints(prim: Prim | undefined): [number, number][] {
	if (!prim) return [];
	return String(prim.attrs.points)
		.split(' ')
		.map((pair) => pair.split(',').map(Number) as [number, number]);
}

/** The y of the zero axis of a diagram scene. */
function axisY(scene: Scene): number {
	const axis = scene.prims.find((p) => p.cls === 'bsd-axis');
	return Number(axis?.attrs.y1);
}

/** The diagram curve points. */
function curve(scene: Scene): [number, number][] {
	return parsePoints(scene.prims.find((p) => p.cls.split(' ').includes('bsd-curve')));
}

const ALLOWED_TAGS = new Set(['path', 'line', 'polyline', 'polygon', 'circle', 'rect', 'text']);
const WIDTHS = [200, 320, 480, 640, 1200];
const CONVENTIONS: MomentConvention[] = ['sagging-up', 'tension-side'];

/** Crowded beam: clustered loads, mixed-sign linear load, up loads, interior clamp, hinge, couples. */
const CROWDED = block(
	'length 8 m',
	'fixed at 0',
	'fixed at 5',
	'hinge at 6.5',
	'roller at 8',
	'point 12 kN down at 1',
	'point 7.5 kN down at 1.3',
	'point 4 kN up at 1.6',
	'moment 6 kNm cw at 3',
	'moment 2 kNm ccw at 3.2',
	'linear -2 to 6 kN/m down from 0 to 4',
	'udl 3 kN/m down from 2 to 8',
	'udl 1 kN/m up from 5 to 7',
	'material steel',
	'section rect 100 x 300 mm',
);

const SOURCES: [string, string][] = [...BEAM_EXAMPLES.map((e) => [e.id, e.source] as [string, string]), ['crowded', CROWDED]];

// ---------------------------------------------------------------------------
// Invariants over every scene
// ---------------------------------------------------------------------------

describe('scene invariants', () => {
	it.each(SOURCES)('%s: scenes are deterministic', (_id, source) => {
		expect(allScenes(source)).toEqual(allScenes(source));
	});

	it.each(SOURCES)('%s: all coordinates are finite at every width and convention', (_id, source) => {
		for (const width of WIDTHS) {
			for (const momentConvention of CONVENTIONS) {
				for (const scene of allScenes(source, { width, momentConvention })) {
					expect(Number.isFinite(scene.width) && Number.isFinite(scene.height)).toBe(true);
					for (const prim of scene.prims) {
						for (const n of numbersOf(prim)) expect(Number.isFinite(n)).toBe(true);
					}
				}
			}
		}
	});

	it.each(SOURCES)('%s: every text stays inside the drawing', (_id, source) => {
		for (const width of WIDTHS) {
			for (const scene of allScenes(source, { width, momentConvention: width > 400 ? 'sagging-up' : 'tension-side' })) {
				expect(scene.width).toBe(Math.max(width, LAYOUT.minWidth));
				for (const prim of scene.prims.filter((p) => p.tag === 'text')) {
					const box = textBox(prim);
					expect(box.x0, `${prim.text} in ${scene.title}`).toBeGreaterThanOrEqual(0);
					expect(box.x1, `${prim.text} in ${scene.title}`).toBeLessThanOrEqual(scene.width);
					expect(box.y0, `${prim.text} in ${scene.title}`).toBeGreaterThanOrEqual(0);
					expect(box.y1, `${prim.text} in ${scene.title}`).toBeLessThanOrEqual(scene.height);
				}
			}
		}
	});

	it.each(SOURCES)('%s: only bsd-* classes, no style, colour or id attributes', (_id, source) => {
		for (const scene of allScenes(source)) {
			for (const prim of scene.prims) {
				expect(ALLOWED_TAGS.has(prim.tag)).toBe(true);
				expect(prim.cls.length).toBeGreaterThan(0);
				for (const cls of prim.cls.split(' ')) expect(cls).toMatch(/^bsd-[a-z-]+$/);
				for (const [name, value] of Object.entries(prim.attrs)) {
					expect(['style', 'id', 'class', 'color']).not.toContain(name);
					if (['fill', 'stroke', 'stop-color'].includes(name)) expect(value).toBe('none');
				}
			}
		}
	});

	it.each(SOURCES)('%s: scenes have an accessible title and description', (_id, source) => {
		for (const scene of allScenes(source)) {
			expect(scene.title.length).toBeGreaterThan(0);
			expect(scene.desc.length).toBeGreaterThan(0);
			expect(scene.desc).not.toMatch(/NaN|undefined/);
		}
	});

	it('uses no em dash in any generated text', () => {
		const dash = String.fromCharCode(0x2014);
		for (const [, source] of SOURCES) {
			for (const scene of allScenes(source)) {
				const all = [scene.title, scene.desc, ...scene.prims.map((p) => `${p.text ?? ''}${p.tooltip ?? ''}`)].join(' ');
				expect(all.includes(dash)).toBe(false);
			}
		}
	});

	it('lines the beam and the diagrams up on the same x scale', () => {
		const { model, results, units } = solve(example('simply-supported'));
		const o = opts(units, { width: 700 });
		const layout = createXLayout(700, model.length);
		const beam = buildBeamScene(model, results, o).prims.find((p) => p.cls === 'bsd-beam');
		expect(Number(beam?.attrs.x1)).toBe(layout.left);
		expect(Number(beam?.attrs.x2)).toBe(layout.right);
		for (const q of ['shear', 'moment', 'deflection'] as DiagramQuantity[]) {
			const axis = buildDiagramScene(results, q, o).prims.find((p) => p.cls === 'bsd-axis');
			expect([Number(axis?.attrs.x1), Number(axis?.attrs.x2)]).toEqual([layout.left, layout.right]);
		}
	});

	it('lays out narrow or broken widths at the minimum width', () => {
		const { model, results, units } = solve(example('simply-supported'));
		for (const width of [0, 100, Number.NaN, Number.POSITIVE_INFINITY * 0]) {
			expect(buildBeamScene(model, results, opts(units, { width })).width).toBe(LAYOUT.minWidth);
			expect(buildDiagramScene(results, 'moment', opts(units, { width })).width).toBe(LAYOUT.minWidth);
		}
	});
});

// ---------------------------------------------------------------------------
// Beam scene
// ---------------------------------------------------------------------------

describe('buildBeamScene', () => {
	const ss = solve(example('simply-supported'));
	const scene = buildBeamScene(ss.model, ss.results, opts(ss.units));

	it('stays within a sensible height', () => {
		expect(scene.height).toBeGreaterThanOrEqual(120);
		expect(scene.height).toBeLessThanOrEqual(240);
	});

	it('labels loads in plain units', () => {
		expect(texts(scene, 'bsd-load-label').map((p) => p.text)).toEqual(['10 kN', '4 kN/m']);
		const cantilever = solve(example('cantilever'));
		const labels = texts(buildBeamScene(cantilever.model, cantilever.results, opts(cantilever.units)), 'bsd-load-label').map((p) => p.text);
		expect(labels).toEqual(['0 → 6 kN/m', '5 kN·m']);
	});

	it('draws reactions with values only when results are given', () => {
		expect(texts(scene, 'bsd-reaction-label').map((p) => p.text)).toEqual(['18.67 kN', '15.33 kN']);
		const heads = scene.prims.filter((p) => p.cls === 'bsd-arrowhead bsd-reaction-head');
		expect(heads).toHaveLength(2);
		const bare = buildBeamScene(ss.model, undefined, opts(ss.units));
		expect(bare.prims.some((p) => p.cls.includes('bsd-reaction'))).toBe(false);
		expect(bare.height).toBeLessThan(scene.height);
	});

	it('points upward reactions up, towards the support', () => {
		const head = scene.prims.find((p) => p.cls === 'bsd-arrowhead bsd-reaction-head');
		const [tip, b1, b2] = parsePoints(head);
		// The tip is the highest point (smallest y) of the triangle.
		expect(tip?.[1]).toBeLessThan(b1?.[1] ?? 0);
		expect(tip?.[1]).toBeLessThan(b2?.[1] ?? 0);
	});

	it('draws a downward reaction pointing down', () => {
		const overhang = solve(block('length 6', 'pin at 0', 'roller at 4', 'point 10 at 6'));
		const s = buildBeamScene(overhang.model, overhang.results, opts(overhang.units));
		const heads = s.prims.filter((p) => p.cls === 'bsd-arrowhead bsd-reaction-head').map(parsePoints);
		// The pin pulls down: its arrow tip is below its base.
		const pinHead = heads[0] ?? [];
		expect(pinHead[0]?.[1]).toBeGreaterThan(pinHead[1]?.[1] ?? 0);
		expect(texts(s, 'bsd-reaction-label')[0]?.text).toBe('5.00 kN');
	});

	it('draws fixed-end couples as curved arrows with a direction symbol', () => {
		const ff = solve(example('fixed-fixed'));
		const s = buildBeamScene(ff.model, ff.results, opts(ff.units));
		const labels = texts(s, 'bsd-reaction-label').map((p) => p.text);
		expect(labels).toContain('↺ 8.89 kN·m');
		expect(labels).toContain('↻ 4.44 kN·m');
		const arcs = s.prims.filter((p) => p.tag === 'path' && p.cls === 'bsd-reaction');
		expect(arcs).toHaveLength(2);
		// SVG sweep flag: 0 = counter-clockwise on screen (left end), 1 = clockwise (right end).
		expect(String(arcs[0]?.attrs.d)).toMatch(/A 20 20 0 0 0 /);
		expect(String(arcs[1]?.attrs.d)).toMatch(/A 20 20 0 0 1 /);
	});

	it('draws fixed ends as walls hatched on the outside', () => {
		const ff = solve(example('fixed-fixed'));
		const s = buildBeamScene(ff.model, undefined, opts(ff.units));
		const layout = createXLayout(640, 6);
		const hatches = s.prims.filter((p) => p.cls === 'bsd-hatch').map((p) => numbersOf(p).filter((_, i) => i % 2 === 0));
		expect(hatches).toHaveLength(2);
		expect(Math.max(...(hatches[0] ?? []))).toBeLessThanOrEqual(layout.left);
		expect(Math.min(...(hatches[1] ?? []))).toBeGreaterThanOrEqual(layout.right);
		expect(s.prims.filter((p) => p.cls === 'bsd-ground' && p.tag === 'line')).toHaveLength(2);
	});

	it('draws pins, rollers, interior clamps and hinges', () => {
		const crowded = solve(CROWDED);
		const s = buildBeamScene(crowded.model, crowded.results, opts(crowded.units));
		expect(s.prims.filter((p) => p.tag === 'rect' && p.cls === 'bsd-support')).toHaveLength(1);
		expect(s.prims.filter((p) => p.cls === 'bsd-hinge')).toHaveLength(1);
		// Roller: a triangle and two wheels.
		expect(s.prims.filter((p) => p.tag === 'circle' && p.cls === 'bsd-support')).toHaveLength(2);
		expect(scene.prims.filter((p) => p.tag === 'polygon' && p.cls === 'bsd-support')).toHaveLength(2);
	});

	it('puts tooltips on supports, loads and reactions', () => {
		const tips = scene.prims.map((p) => p.tooltip).filter((t): t is string => t !== undefined);
		expect(tips.some((t) => t.startsWith('Support A (pin) at x = 0 m'))).toBe(true);
		expect(tips.some((t) => t.startsWith('Support B (roller) at x = 6 m'))).toBe(true);
		expect(tips).toContain('Point load 10 kN down at x = 2 m');
		expect(tips).toContain('Uniform load 4 kN/m down from x = 0 m to 6 m');
		expect(tips).toContain('Reaction at support A (x = 0 m): 18.67 kN up');
		const cantilever = solve(example('cantilever'));
		const cTips = buildBeamScene(cantilever.model, cantilever.results, opts(cantilever.units)).prims.map((p) => p.tooltip ?? '');
		expect(cTips).toContain('Moment 5 kN·m counter-clockwise at x = 3 m');
		expect(cTips).toContain('Linearly varying load 0 → 6 kN/m down from x = 0 m to 3 m');
		expect(cTips.some((t) => t.startsWith('Support A (fixed) at x = 0 m'))).toBe(true);
		expect(cTips.some((t) => t.startsWith('Reaction moment at support A (x = 0 m): 13.00 kN·m'))).toBe(true);
	});

	it('spaces distributed-load arrows 18 to 28 px apart, at least 3 per load', () => {
		const heads = scene.prims.filter((p) => p.cls === 'bsd-arrowhead').map((p) => parsePoints(p)[0]?.[0] ?? 0);
		// 25 udl arrows plus the point load arrow.
		const xs = [...new Set(heads)].sort((a, b) => a - b);
		const gaps = xs.slice(1).map((x, i) => x - (xs[i] ?? 0));
		// The point load arrow at 2 m lands on a udl arrow position, so every gap is a udl gap.
		expect(Math.max(...gaps)).toBeLessThanOrEqual(28);
		expect(Math.min(...gaps)).toBeGreaterThanOrEqual(18);
		const short = solve(block('length 6', 'pin at 0', 'roller at 6', 'udl 2 kN/m down from 1 to 1.1'));
		const shortScene = buildBeamScene(short.model, undefined, opts(short.units));
		expect(shortScene.prims.filter((p) => p.cls === 'bsd-arrowhead').length).toBeGreaterThanOrEqual(3);
	});

	it('scales distributed loads: a triangle starts at zero height, a small load keeps 35%', () => {
		const tri = solve(example('cantilever'));
		const s = buildBeamScene(tri.model, undefined, opts(tri.units));
		const outline = parsePoints(s.prims.find((p) => p.tag === 'polyline' && p.cls === 'bsd-load'));
		const band = parsePoints(s.prims.find((p) => p.cls === 'bsd-dist'));
		const base = band[0]?.[1] ?? 0;
		expect(outline[0]?.[1]).toBe(base);
		expect(base - (outline[1]?.[1] ?? 0)).toBeCloseTo(26, 0);

		const mixed = solve(block('length 6', 'pin at 0', 'roller at 6', 'udl 10 kN/m down from 0 to 3', 'udl 1 kN/m down from 3 to 6'));
		const m = buildBeamScene(mixed.model, undefined, opts(mixed.units));
		const outlines = m.prims.filter((p) => p.tag === 'polyline' && p.cls === 'bsd-load').map(parsePoints);
		const bands = m.prims.filter((p) => p.cls === 'bsd-dist').map(parsePoints);
		const height = (i: number): number => (bands[i]?.[0]?.[1] ?? 0) - (outlines[i]?.[0]?.[1] ?? 0);
		expect(height(0)).toBeCloseTo(26, 0);
		expect(height(1)).toBeCloseTo(0.35 * 26, 0);
	});

	it('draws a sign-changing load with arrows both ways and a zero in its outline', () => {
		const s = solve(block('length 4', 'pin at 0', 'roller at 4', 'linear -2 to 6 kN/m down'));
		const scene2 = buildBeamScene(s.model, undefined, opts(s.units));
		const outline = parsePoints(scene2.prims.find((p) => p.tag === 'polyline' && p.cls === 'bsd-load'));
		expect(outline).toHaveLength(3);
		const heads = scene2.prims.filter((p) => p.cls === 'bsd-arrowhead').map(parsePoints);
		const down = heads.filter((h) => (h[0]?.[1] ?? 0) > (h[1]?.[1] ?? 0)).length;
		const up = heads.filter((h) => (h[0]?.[1] ?? 0) < (h[1]?.[1] ?? 0)).length;
		expect(down).toBeGreaterThan(0);
		expect(up).toBeGreaterThan(0);
		expect(texts(scene2, 'bsd-load-label')[0]?.text).toBe('-2 → 6 kN/m');
	});

	it('stacks overlapping distributed loads instead of drawing them on top of each other', () => {
		const s = solve(block('length 6', 'pin at 0', 'roller at 6', 'udl 2 kN/m down from 0 to 4', 'udl 2 kN/m down from 2 to 6'));
		const bands = buildBeamScene(s.model, undefined, opts(s.units))
			.prims.filter((p) => p.cls === 'bsd-dist')
			.map((p) => parsePoints(p)[0]?.[1] ?? 0);
		expect(bands).toHaveLength(2);
		expect(bands[0]).not.toBe(bands[1]);
	});

	it('keeps load labels, reaction labels and dimension labels from overlapping', () => {
		const crowded = solve(CROWDED);
		for (const width of [320, 640]) {
			const s = buildBeamScene(crowded.model, crowded.results, opts(crowded.units, { width }));
			for (const cls of ['bsd-load-label', 'bsd-reaction-label', 'bsd-dim-label']) {
				const boxes = texts(s, cls).map(textBox);
				for (let i = 0; i < boxes.length; i++) {
					for (let j = i + 1; j < boxes.length; j++) {
						expect(boxesOverlap(boxes[i] as Box, boxes[j] as Box), `${cls} ${i} ${j} at ${width}`).toBe(false);
					}
				}
			}
			// Every load still has a label.
			expect(texts(s, 'bsd-load-label')).toHaveLength(crowded.model.loads.length);
		}
	});

	it('grows taller when labels need extra rows', () => {
		const one = solve(block('length 6', 'pin at 0', 'roller at 6', 'point 1 kN at 3'));
		const many = solve(block('length 6', 'pin at 0', 'roller at 6', 'point 1 kN at 3', 'point 2 kN at 3.05', 'point 3 kN at 3.1'));
		const h1 = buildBeamScene(one.model, undefined, opts(one.units)).height;
		const h3 = buildBeamScene(many.model, undefined, opts(many.units)).height;
		expect(h3).toBeGreaterThan(h1);
	});

	it('labels the dimension line with key positions, ends first', () => {
		const labels = texts(scene, 'bsd-dim-label').map((p) => p.text);
		expect(labels).toEqual(['0 m', '6 m', '2 m']);
		const ticks = scene.prims.find((p) => p.tag === 'path' && p.cls === 'bsd-dim');
		expect(String(ticks?.attrs.d).match(/M /g)).toHaveLength(3);
		const us = solve(example('overhang'));
		const usLabels = texts(buildBeamScene(us.model, us.results, opts(us.units)), 'bsd-dim-label').map((p) => p.text);
		expect(usLabels).toEqual(['0 ft', '30 ft', '20 ft']);
	});

	it('describes the beam in words', () => {
		expect(scene.desc).toContain('Beam 6 m long.');
		expect(scene.desc).toContain('A (pin) at 0 m');
		expect(scene.desc).toContain('point load 10 kN down at x = 2 m');
		expect(scene.desc).toContain('Reactions: A 18.67 kN up, B 15.33 kN up.');
		expect(scene.title).toBe('Simply supported beam: beam, supports and loads');
		const untitled = solve(block('length 6', 'pin at 0', 'roller at 6'));
		const bare = buildBeamScene(untitled.model, untitled.results, opts(untitled.units));
		expect(bare.title).toBe('Beam, supports and loads');
		expect(bare.desc).toContain('No loads.');
	});
});

// ---------------------------------------------------------------------------
// Diagram scenes
// ---------------------------------------------------------------------------

describe('buildDiagramScene', () => {
	const ss = solve(example('simply-supported'));
	const o = opts(ss.units);
	const shear = buildDiagramScene(ss.results, 'shear', o);
	const moment = buildDiagramScene(ss.results, 'moment', o);
	const deflection = buildDiagramScene(ss.results, 'deflection', o);
	const layout = createXLayout(640, 6);

	it('titles each diagram with its symbol and unit', () => {
		expect(texts(shear, 'bsd-diagram-title')[0]?.text).toBe('Shear force V (kN)');
		expect(texts(moment, 'bsd-diagram-title')[0]?.text).toBe('Bending moment M (kN·m)');
		expect(texts(deflection, 'bsd-diagram-title')[0]?.text).toBe('Deflection v (mm)');
		const us = solve(example('overhang'));
		expect(texts(buildDiagramScene(us.results, 'moment', opts(us.units)), 'bsd-diagram-title')[0]?.text).toBe('Bending moment M (kip·ft)');
		expect([shear.height, moment.height, deflection.height].every((h) => h >= 130 && h <= 160)).toBe(true);
	});

	it('fills positive and negative areas with different classes', () => {
		const cls = (s: Scene): string[] => s.prims.filter((p) => p.cls.includes('bsd-area')).map((p) => p.cls);
		expect(cls(shear)).toContain('bsd-area bsd-pos');
		expect(cls(shear)).toContain('bsd-area bsd-neg');
		// Simply supported: sagging everywhere.
		expect(cls(moment).every((c) => c === 'bsd-area bsd-pos')).toBe(true);
		const propped = solve(example('propped'));
		const pm = cls(buildDiagramScene(propped.results, 'moment', opts(propped.units)));
		expect(pm).toContain('bsd-area bsd-pos');
		expect(pm).toContain('bsd-area bsd-neg');
		expect(cls(deflection).every((c) => c === 'bsd-area bsd-deflection-area')).toBe(true);
		expect(deflection.prims.some((p) => p.cls === 'bsd-curve bsd-deflection-curve')).toBe(true);
	});

	it('draws a jump at a point load as two points with the same x', () => {
		const pts = curve(shear);
		const x2 = Math.round(layout.toPx(2) * 10) / 10;
		const jump = pts.findIndex((p, i) => p[0] === x2 && pts[i + 1]?.[0] === x2);
		expect(jump).toBeGreaterThanOrEqual(0);
		expect(pts[jump]?.[1]).not.toBe(pts[jump + 1]?.[1]);
	});

	it('draws positive shear above the axis and negative below', () => {
		const pts = curve(shear);
		const y0 = axisY(shear);
		expect(pts[0]?.[1]).toBeLessThan(y0);
		expect(pts[pts.length - 1]?.[1]).toBeGreaterThan(y0);
	});

	it('flips the moment diagram in pixel space for the tension-side convention', () => {
		const sag = curve(moment);
		const tension = buildDiagramScene(ss.results, 'moment', opts(ss.units, { momentConvention: 'tension-side' }));
		const ten = curve(tension);
		expect(sag.length).toBe(ten.length);
		const ySag = axisY(moment);
		const yTen = axisY(tension);
		// Sagging is above the axis by default, below it on the tension side.
		expect(sag.every((p) => p[1] <= ySag + 0.05)).toBe(true);
		expect(ten.every((p) => p[1] >= yTen - 0.05)).toBe(true);
		// Same shape, mirrored about the axis.
		sag.forEach((p, i) => expect(ySag - p[1]).toBeCloseTo((ten[i]?.[1] ?? 0) - yTen, 0));
		// The label keeps the sign of the internal convention.
		expect(texts(tension, 'bsd-extreme').map((p) => p.text)).toEqual(['+29.39']);
		expect(tension.desc).toContain('tension side');
	});

	it('leaves shear and deflection unflipped on the tension side', () => {
		const tOpts = opts(ss.units, { momentConvention: 'tension-side' });
		expect(buildDiagramScene(ss.results, 'shear', tOpts)).toEqual(shear);
		expect(buildDiagramScene(ss.results, 'deflection', tOpts)).toEqual(deflection);
	});

	it('labels extremes with signs and marks the zero shear position', () => {
		expect(texts(shear, 'bsd-extreme').map((p) => p.text)).toEqual(['+18.67', '-15.33']);
		expect(texts(moment, 'bsd-extreme').map((p) => p.text)).toEqual(['+29.39']);
		const zero = texts(shear, 'bsd-zero');
		expect(zero.map((p) => p.text)).toEqual(['x = 2.17 m']);
		const tick = shear.prims.find((p) => p.tag === 'line' && p.cls === 'bsd-zero');
		expect(Number(tick?.attrs.x1)).toBeCloseTo(layout.toPx(2 + 1 / 6), 0);
	});

	it('labels values on both sides of a jump', () => {
		const values = texts(shear, 'bsd-value').map((p) => p.text);
		expect(values).toContain('+10.67');
		expect(values).toContain('+0.67');
	});

	it('does not repeat an extreme value as a key-point label', () => {
		for (const s of [shear, moment]) {
			const values = texts(s, 'bsd-value').map((p) => p.text);
			expect(new Set(values).size).toBe(values.length);
		}
		// "+29.33" under the point load sits right next to the "+29.39" peak.
		expect(texts(moment, 'bsd-value').map((p) => p.text)).not.toContain('+29.33');
	});

	it('labels the peak moment of every span (moment at each zero of the shear)', () => {
		const cont = solve(example('continuous'));
		const m = buildDiagramScene(cont.results, 'moment', opts(cont.units));
		const values = texts(m, 'bsd-value').map((p) => p.text);
		expect(values.filter((v) => v === '+12.66')).toHaveLength(2);
		expect(values).toContain('-22.50');
	});

	it('keeps diagram labels apart and off the curve', () => {
		for (const [id, source] of SOURCES) {
			const { results, units } = solve(source);
			for (const q of ['shear', 'moment', 'deflection'] as DiagramQuantity[]) {
				for (const width of [320, 640]) {
					for (const momentConvention of CONVENTIONS) {
						const s = buildDiagramScene(results, q, opts(units, { width, momentConvention }));
						const labels = s.prims.filter((p) => p.tag === 'text' && p.cls.includes('bsd-value'));
						const boxes = labels.map(textBox);
						for (let i = 0; i < boxes.length; i++) {
							for (let j = i + 1; j < boxes.length; j++) expect(boxesOverlap(boxes[i] as Box, boxes[j] as Box)).toBe(false);
						}
						// Ordinary labels never sit on the curve (the builder tests unrounded
						// points, so shrink the box a little against rounding).
						const pts = curve(s);
						labels.forEach((label, i) => {
							if (label.cls.includes('bsd-extreme')) return;
							const b = boxes[i] as Box;
							const inner: Box = { x0: b.x0 + 0.3, y0: b.y0 + 0.3, x1: b.x1 - 0.3, y1: b.y1 - 0.3 };
							for (let k = 1; k < pts.length; k++) {
								const a = pts[k - 1] as [number, number];
								const c = pts[k] as [number, number];
								expect(segmentHitsBox([a[0], a[1], c[0], c[1]], inner), `${id} ${q} "${label.text}"`).toBe(false);
							}
						});
					}
				}
			}
		}
	});

	it('labels the deflection extreme with direction and position', () => {
		expect(texts(deflection, 'bsd-extreme').map((p) => p.text)).toEqual(['max 6.62 mm ↓ at 2.90 m']);
		expect(deflection.desc).toBe('Largest downward deflection 6.62 mm at x = 2.90 m.');
		const us = solve(example('overhang'));
		const usd = texts(buildDiagramScene(us.results, 'deflection', opts(us.units)), 'bsd-extreme').map((p) => p.text);
		expect(usd).toHaveLength(2);
		expect(usd[0]).toMatch(/^max 0\.15 in ↓ at 8\.85 ft$/);
		expect(usd[1]).toMatch(/^max .* in ↑ at 21\.44 ft$/);
	});

	it('summarises the values for screen readers', () => {
		expect(shear.desc).toBe('Shear force ranges from -15.33 kN at x = 6.00 m to 18.67 kN at x = 0.00 m. It changes sign at x = 2.17 m.');
		expect(moment.desc).toBe('Largest sagging moment 29.39 kN·m at x = 2.17 m. Sagging moments are drawn above the axis.');
		const propped = solve(example('propped'));
		expect(buildDiagramScene(propped.results, 'moment', opts(propped.units)).desc).toContain('Largest hogging moment 22.50 kN·m at x = 0.00 m.');
	});

	it('draws guides at every key point', () => {
		expect(shear.prims.filter((p) => p.cls === 'bsd-guide')).toHaveLength(ss.results.keyPoints.length);
	});

	it('draws a flat line labelled 0 when the diagram is zero', () => {
		const model: BeamModel = { units: 'kN-m', length: 6, supports: [{ kind: 'pin', x: 0 }, { kind: 'roller', x: 6 }], hinges: [], loads: [] };
		const results = solveBeam(model);
		const s = buildDiagramScene(results, 'shear', opts('kN-m'));
		expect(s.prims.some((p) => p.cls.includes('bsd-area'))).toBe(false);
		expect(curve(s)).toHaveLength(2);
		expect(texts(s, 'bsd-value').map((p) => p.text)).toEqual(['0']);
		expect(s.desc).toBe('Shear force is zero along the whole beam.');
		// Cantilever with only an end couple: V is zero up to round-off, and a
		// counter-clockwise couple at the free end bends it into a smile, M = +8.
		const couple = solve(block('length 4', 'fixed at 0', 'moment 8 kNm ccw at 4', 'material steel', 'section rect 100 x 200 mm'));
		const v = buildDiagramScene(couple.results, 'shear', opts(couple.units));
		expect(texts(v, 'bsd-value').map((p) => p.text)).toEqual(['0']);
		const m = buildDiagramScene(couple.results, 'moment', opts(couple.units));
		expect(m.prims.filter((p) => p.cls === 'bsd-area bsd-pos')).toHaveLength(1);
		// Constant diagram: max and min coincide, so the value is written once.
		expect(texts(m, 'bsd-value').map((p) => p.text)).toEqual(['+8.00']);
	});

	it('returns a note instead of throwing when deflection is not available', () => {
		const gerber = solve(example('gerber'));
		expect(gerber.results.hasDeflection).toBe(false);
		for (const width of [320, 640]) {
			const s = buildDiagramScene(gerber.results, 'deflection', opts(gerber.units, { width }));
			expect(s.height).toBeLessThan(80);
			const notes = texts(s, 'bsd-note');
			expect(notes.length).toBeGreaterThan(0);
			expect(notes.map((p) => p.text).join(' ')).toBe('Add a material (or E) and a section (or I) to see the deflection');
			for (const p of notes) expect(textBox(p).x1).toBeLessThanOrEqual(s.width);
		}
	});

	it('respects the decimals option', () => {
		const three = buildDiagramScene(ss.results, 'shear', opts(ss.units, { decimals: 3 }));
		expect(texts(three, 'bsd-extreme').map((p) => p.text)).toEqual(['+18.667', '-15.333']);
		const zero = buildDiagramScene(ss.results, 'shear', opts(ss.units, { decimals: 0 }));
		expect(texts(zero, 'bsd-extreme').map((p) => p.text)).toEqual(['+19', '-15']);
	});
});

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

describe('drawing helpers', () => {
	it('splits a curve into same-sign regions at interpolated zero crossings', () => {
		const pts = [
			{ X: 0, Y: 40, v: 10 },
			{ X: 10, Y: 60, v: -10 },
			{ X: 20, Y: 60, v: -10 },
			{ X: 20, Y: 40, v: 10 },
			{ X: 30, Y: 50, v: 0 },
		];
		const regions = splitAtZero(pts, 50, 1e-9);
		expect(regions.map((r) => r.sign)).toEqual([1, -1, 1]);
		expect(regions[0]?.points).toEqual([[0, 50], [0, 40], [5, 50]]);
		// A jump through zero closes the region at the jump itself.
		expect(regions[1]?.points).toEqual([[5, 50], [10, 60], [20, 60], [20, 50]]);
		expect(regions[2]?.points).toEqual([[20, 50], [20, 40], [30, 50]]);
	});

	it('detects segments crossing a box', () => {
		const box: Box = { x0: 10, y0: 10, x1: 20, y1: 20 };
		expect(segmentHitsBox([0, 15, 30, 15], box)).toBe(true);
		expect(segmentHitsBox([0, 0, 30, 30], box)).toBe(true);
		expect(segmentHitsBox([12, 12, 13, 13], box)).toBe(true);
		expect(segmentHitsBox([0, 0, 30, 0], box)).toBe(false);
		expect(segmentHitsBox([0, 25, 25, 50], box)).toBe(false);
		expect(segmentHitsBox([15, 0, 15, 5], box)).toBe(false);
	});

	it('switches text anchors near the edges', () => {
		expect(placeText(320, 10, 'abc', 10, 640).anchor).toBe('middle');
		const left = placeText(1, 10, 'a long label', 10, 640);
		expect(left.anchor).toBe('start');
		expect(left.box.x0).toBeGreaterThanOrEqual(0);
		const right = placeText(639, 10, 'a long label', 10, 640, 'start');
		expect(right.anchor).toBe('end');
		expect(right.box.x1).toBeLessThanOrEqual(640);
	});

	it('packs intervals into the lowest free row', () => {
		expect(packRows([{ x0: 0, x1: 10 }, { x0: 5, x1: 15 }, { x0: 20, x1: 30 }, { x0: 8, x1: 12 }], 2)).toEqual([0, 1, 0, 2]);
		expect(packRows([], 2)).toEqual([]);
	});

	it('clips hatch lines to their rectangle', () => {
		const d = hatchPath(0, 0, 20, 6, 4);
		const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
		expect(nums.length).toBeGreaterThan(0);
		for (let i = 0; i < nums.length; i += 2) {
			expect(nums[i]).toBeGreaterThanOrEqual(0);
			expect(nums[i]).toBeLessThanOrEqual(20);
			expect(nums[i + 1]).toBeGreaterThanOrEqual(0);
			expect(nums[i + 1]).toBeLessThanOrEqual(6);
		}
	});

	it('builds arrows whose head points in the direction of travel', () => {
		const [shaft, head] = verticalArrow('bsd-load', 'bsd-arrowhead', 50, 10, 50);
		expect(shaft?.tag).toBe('line');
		expect(Number(shaft?.attrs.y2)).toBeLessThan(50);
		const tip = parsePoints(head)[0];
		expect(tip).toEqual([50, 50]);
		const ccw = arcArrow('bsd-load', 'bsd-arrowhead', 100, 100, 14, -45, 225);
		expect(String(ccw[0]?.attrs.d)).toMatch(/A 14 14 0 1 0 /);
		const cw = arcArrow('bsd-load', 'bsd-arrowhead', 100, 100, 14, 225, -45);
		expect(String(cw[0]?.attrs.d)).toMatch(/A 14 14 0 1 1 /);
	});

	it('sanitizes scene widths', () => {
		expect(sceneWidth(800)).toBe(800);
		expect(sceneWidth(10)).toBe(LAYOUT.minWidth);
		expect(sceneWidth(Number.NaN)).toBe(LAYOUT.minWidth);
	});
});

// ---------------------------------------------------------------------------
// SVG serialization
// ---------------------------------------------------------------------------

describe('sceneToSvgString', () => {
	it('writes a standalone svg with title, description and escaped content', () => {
		const scene: Scene = {
			width: 320,
			height: 100,
			title: 'A & B <beam>',
			desc: 'Say "hi" & \'bye\'',
			prims: [
				{ tag: 'text', cls: 'bsd-value', attrs: { x: 10, y: 20, 'text-anchor': 'start' }, text: '<b>&"\'</b>', tooltip: 'x < 2 & y > 1' },
				{ tag: 'line', cls: 'bsd-axis', attrs: { x1: 0, y1: 0, x2: 10, y2: 0, 'data-note': 'a"b' } },
				{ tag: 'circle', cls: 'bsd-hinge', attrs: { cx: 1, cy: 2, r: 3, 'onload="x"': 'bad', class: 'evil' } },
			],
		};
		const svg = sceneToSvgString(scene);
		expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 100" width="320" height="100" class="bsd-svg" role="img">')).toBe(true);
		expect(svg).toContain('<title>A &amp; B &lt;beam&gt;</title>');
		expect(svg).toContain('<desc>Say &quot;hi&quot; &amp; &#39;bye&#39;</desc>');
		expect(svg).toContain('<text class="bsd-value" x="10" y="20" text-anchor="start"><title>x &lt; 2 &amp; y &gt; 1</title>&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;</text>');
		expect(svg).toContain('<line class="bsd-axis" x1="0" y1="0" x2="10" y2="0" data-note="a&quot;b"/>');
		expect(svg).toContain('<circle class="bsd-hinge" cx="1" cy="2" r="3"/>');
		expect(svg).not.toContain('onload');
		expect(svg).not.toContain('evil');
		expect(svg.endsWith('</svg>')).toBe(true);
	});

	it('escapes the five XML special characters', () => {
		expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
		expect(escapeXml('plain kN·m → ↺')).toBe('plain kN·m → ↺');
	});

	it('serializes every example scene into well-formed markup', () => {
		for (const [, source] of SOURCES) {
			for (const scene of allScenes(source)) {
				const svg = sceneToSvgString(scene);
				// One element per primitive plus the root, title and desc.
				const opened = (svg.match(/<(svg|title|desc|path|line|polyline|polygon|circle|rect|text)[ >]/g) ?? []).length;
				const tooltips = scene.prims.filter((p) => p.tooltip !== undefined).length;
				expect(opened).toBe(scene.prims.length + 3 + tooltips);
				expect(svg).not.toMatch(/NaN|undefined|style=|id=/);
			}
		}
	});

	it('writes non-finite numbers as 0 to keep the markup valid', () => {
		const svg = sceneToSvgString({ width: Number.NaN, height: 10, title: 't', desc: 'd', prims: [{ tag: 'circle', cls: 'bsd-hinge', attrs: { cx: Number.POSITIVE_INFINITY, cy: 0, r: 1 } }] });
		expect(svg).toContain('viewBox="0 0 0 10"');
		expect(svg).toContain('cx="0"');
	});
});
