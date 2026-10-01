import { describe, expect, it } from 'vitest';
import { analyzeBeam } from '../src/core/analyze';
import { evaluateAt } from '../src/core/diagrams';
import { BEAM_EXAMPLES } from '../src/core/examples';
import { solveBeam } from '../src/core/solver';
import type { BeamModel, BeamResults, DiagramQuantity, MomentConvention, UnitSystemId } from '../src/core/types';
import { formatNumber, toDisplay } from '../src/core/units';
import { buildBeamScene } from '../src/render/beam-scene';
import { buildDiagramScene, segmentHitsBox, splitAtZero } from '../src/render/chart-scene';
import { arcArrow, boxesOverlap, formatInput, hatchPath, packRows, placeText, sceneWidth, verticalArrow, verticalLine } from '../src/render/draw';
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

/** Four overlapping distributed loads (one upward): a stack of four bands. */
const STACKED = block(
	'length 8 m',
	'pin at 0',
	'roller at end',
	'udl 4 kN/m down from 0 to 6',
	'udl 2 kN/m down from 2 to 8',
	'linear 0 to 6 kN/m down from 3 to 5',
	'udl 3 kN/m up from 1 to 4',
);

/** Point loads closer together than their labels are wide, one of them upward. */
const CLOSE_POINTS = block(
	'length 6 m',
	'pin at 0',
	'roller at end',
	'point 5 kN down at 1',
	'point 5 kN down at 1.2',
	'point 5 kN down at 1.4',
	'point 8 kN down at 1.5',
	'point 3 kN down at 3',
	'point 3 kN up at 3.1',
	'point 12 kN down at 3.2',
	'point 2 kN down at 5.9',
);

/** Opposite point loads and a couple at one support, a couple at the free end. */
const SAME_X = block(
	'length 6 m',
	'pin at 0',
	'roller at 4',
	'point 10 kN down at 0',
	'point 6 kN down at 4',
	'point 4 kN up at 4',
	'moment 5 kNm ccw at 4',
	'point 8 kN down at end',
	'moment 2 kNm cw at end',
);

/** Touching patch loads narrower than their labels at small widths. */
const PATCHES = block(
	'length 10 m',
	'pin at 0',
	'roller at 10',
	'udl 2 kN/m down from 0 to 1',
	'udl 4 kN/m down from 1 to 2',
	'udl 6 kN/m down from 2 to 3',
	'udl 3 kN/m down from 3 to 3.5',
	'udl 8 kN/m down from 3.5 to 4',
	'linear 0 to 5 kN/m down from 6 to 10',
);

const SOURCES: [string, string][] = [
	...BEAM_EXAMPLES.map((e) => [e.id, e.source] as [string, string]),
	['crowded', CROWDED],
	['stacked', STACKED],
	['close-points', CLOSE_POINTS],
	['same-x', SAME_X],
	['patches', PATCHES],
];

/** The y of the beam axis in a beam scene. */
function beamAxisY(scene: Scene): number {
	return Number(scene.prims.find((p) => p.cls === 'bsd-beam')?.attrs.y1);
}

/** Length of a vertical arrowhead polygon [tip, base, base]. */
function headLength(head: Prim | undefined): number {
	const [tip, base] = parsePoints(head);
	return Math.abs((tip?.[1] ?? 0) - (base?.[1] ?? 0));
}

/** True for the head of a vertical arrow (its base is horizontal), false for couple arcs. */
function isVerticalHead(head: Prim): boolean {
	const [, b1, b2] = parsePoints(head);
	return b1?.[1] === b2?.[1] && b1?.[0] !== b2?.[0];
}

/**
 * Tip x of every distributed-load arrowhead, sorted. Point-load heads are
 * told apart by size: 9 px long, against at most 7 px for distributed loads.
 */
function distArrowXs(scene: Scene): number[] {
	return scene.prims
		.filter((p) => p.cls === 'bsd-arrowhead' && isVerticalHead(p) && headLength(p) < 8)
		.map((p) => parsePoints(p)[0]?.[0] ?? 0)
		.sort((a, b) => a - b);
}

/** Highest point (smallest y) of a band's outline between x0 and x1, clamped to the band. */
function outlineTopUnder(band: Prim, x0: number, x1: number): number {
	// Band polygon: [a, base], outline vertices..., [b, base].
	const outline = parsePoints(band).slice(1, -1);
	const a = outline[0]?.[0] ?? 0;
	const b = outline[outline.length - 1]?.[0] ?? 0;
	const at = (x: number): number => {
		const cx = Math.min(b, Math.max(a, x));
		for (let i = 1; i < outline.length; i++) {
			const p = outline[i - 1] as [number, number];
			const q = outline[i] as [number, number];
			if (cx >= p[0] && cx <= q[0]) return q[0] === p[0] ? Math.min(p[1], q[1]) : p[1] + ((q[1] - p[1]) * (cx - p[0])) / (q[0] - p[0]);
		}
		return outline[0]?.[1] ?? 0;
	};
	const inside = outline.filter((pt) => pt[0] > x0 && pt[0] < x1).map((pt) => pt[1]);
	return Math.min(at(x0), at(x1), ...inside);
}

/** The distributed-load band polygon and its label, matched through their shared tooltip. */
function bandAndLabel(scene: Scene, tooltipStart: string): { band: Prim; label: Prim } {
	const band = scene.prims.find((p) => p.cls === 'bsd-dist' && (p.tooltip ?? '').startsWith(tooltipStart));
	const label = texts(scene, 'bsd-load-label').find((p) => (p.tooltip ?? '').startsWith(tooltipStart));
	if (!band || !label) throw new Error(`Missing band or label for ${tooltipStart}`);
	return { band, label };
}

/** Asserts that a distributed-load label sits right above its band: above the outline under it, within its 15 px label line. */
function expectLabelOnBand(scene: Scene, tooltipStart: string): void {
	const { band, label } = bandAndLabel(scene, tooltipStart);
	const box = textBox(label);
	const top = outlineTopUnder(band, box.x0, box.x1);
	expect(box.y1, tooltipStart).toBeLessThanOrEqual(top);
	expect(Number(label.attrs.y), tooltipStart).toBeGreaterThan(top - 15);
}

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
		// Applied couples show their sense like reaction couples do.
		expect(labels).toEqual(['0 → 6 kN/m', '↺ 5 kN·m']);
		const cw = solve(block('length 4', 'pin at 0', 'roller at 4', 'moment 3 kNm cw at 2'));
		expect(texts(buildBeamScene(cw.model, undefined, opts(cw.units)), 'bsd-load-label').map((p) => p.text)).toEqual(['↻ 3 kN·m']);
	});

	it('never labels a small non-zero load as 0', () => {
		// 0.4 N and 0.3 N·m in a kN-m block used to read "0 kN" and "0 kN·m".
		const tiny = solve(block('length 6', 'pin at 0', 'roller at 6', 'point 4 kN at 1', 'point 0.4 N at 3', 'moment 0.3 Nm cw at 2'));
		const labels = texts(buildBeamScene(tiny.model, tiny.results, opts(tiny.units)), 'bsd-load-label').map((p) => p.text);
		expect(labels).toContain('0.000400 kN');
		expect(labels).toContain('↻ 0.000300 kN·m');
		expect(labels.some((t) => /(^|\s)0 kN/.test(t ?? ''))).toBe(false);
	});

	it('draws reactions with values only when results are given', () => {
		// The support letter ties each value to its row in the results table.
		expect(texts(scene, 'bsd-reaction-label').map((p) => p.text)).toEqual(['A 18.67 kN', 'B 15.33 kN']);
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
		expect(texts(s, 'bsd-reaction-label')[0]?.text).toBe('A 5.00 kN');
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
		const xs = distArrowXs(scene);
		const pointX = createXLayout(640, 6).toPx(2);
		const gaps = xs.slice(1).map((x, i) => x - (xs[i] ?? 0));
		// The udl arrow at 2 m gives way to the point load arrow: that one gap
		// spans two spacings, every other gap is a plain udl gap.
		const across = gaps.filter((_, i) => (xs[i] ?? 0) < pointX && (xs[i + 1] ?? 0) > pointX);
		const plain = gaps.filter((_, i) => !((xs[i] ?? 0) < pointX && (xs[i + 1] ?? 0) > pointX));
		expect(across).toHaveLength(1);
		expect(across[0]).toBeCloseTo(44, 0);
		expect(Math.max(...plain)).toBeLessThanOrEqual(28);
		expect(Math.min(...plain)).toBeGreaterThanOrEqual(18);
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
		for (const [id, source] of [['crowded', CROWDED], ['stacked', STACKED], ['close-points', CLOSE_POINTS], ['same-x', SAME_X], ['patches', PATCHES]]) {
			const crowded = solve(source ?? '');
			for (const width of [320, 640]) {
				const s = buildBeamScene(crowded.model, crowded.results, opts(crowded.units, { width }));
				for (const cls of ['bsd-load-label', 'bsd-reaction-label', 'bsd-dim-label']) {
					const boxes = texts(s, cls).map(textBox);
					for (let i = 0; i < boxes.length; i++) {
						for (let j = i + 1; j < boxes.length; j++) {
							expect(boxesOverlap(boxes[i] as Box, boxes[j] as Box), `${id} ${cls} ${i} ${j} at ${width}`).toBe(false);
						}
					}
				}
				// Every load still has a label.
				expect(texts(s, 'bsd-load-label'), `${id} at ${width}`).toHaveLength(crowded.model.loads.length);
			}
		}
	});

	it('grows taller when labels need extra rows', () => {
		const one = solve(block('length 6', 'pin at 0', 'roller at 6', 'point 1 kN at 3'));
		const many = solve(block('length 6', 'pin at 0', 'roller at 6', 'point 1 kN at 3', 'point 2 kN at 3.05', 'point 3 kN at 3.1'));
		const h1 = buildBeamScene(one.model, undefined, opts(one.units)).height;
		const h3 = buildBeamScene(many.model, undefined, opts(many.units)).height;
		expect(h3).toBeGreaterThan(h1);
	});

	it('makes a point load inside a distributed load stand out', () => {
		const shafts = scene.prims.filter((p) => p.cls === 'bsd-load bsd-point');
		const x = Number(shafts[0]?.attrs.x1);
		expect(x).toBeCloseTo(createXLayout(640, 6).toPx(2), 1);
		// Its head is larger than the 7 px heads of the distributed-load arrows...
		const pointHead = scene.prims.find((p) => p.cls === 'bsd-arrowhead' && parsePoints(p)[0]?.[0] === x && headLength(p) > 8);
		expect(headLength(pointHead)).toBeCloseTo(9, 1);
		// ...and no distributed-load arrow is drawn on it or within 10 px of it.
		const xs = distArrowXs(scene);
		expect(xs.length).toBeGreaterThan(20);
		expect(xs.every((d) => Math.abs(d - x) >= 10)).toBe(true);

		// At a band end the point arrow replaces the end arrow.
		const ends = solve(block('length 20 m', 'pin at 2', 'roller at 7', 'roller at 13', 'roller at 18', 'udl 5 kN/m down', 'point 10 kN down at 0', 'point 10 kN down at 20'));
		const layout = createXLayout(640, 20);
		const endXs = distArrowXs(buildBeamScene(ends.model, undefined, opts(ends.units)));
		expect(endXs.every((d) => d - layout.left >= 10 && layout.right - d >= 10)).toBe(true);
	});

	it('writes each distributed-load label right above its own band, also in a stack', () => {
		const st = solve(STACKED);
		const dl = solve(block('length 8 m', 'pin at 0', 'roller at end', 'udl 3 kN/m down', 'udl 5 kN/m down from 0 to 4'));
		for (const width of [320, 640]) {
			const s = buildBeamScene(st.model, st.results, opts(st.units, { width }));
			for (const tip of ['Uniform load 4 kN/m', 'Uniform load 2 kN/m', 'Linearly varying load 0 → 6 kN/m', 'Uniform load 3 kN/m']) expectLabelOnBand(s, tip);
			// Dead load over the span with a partial live load stacked on it.
			const d = buildBeamScene(dl.model, dl.results, opts(dl.units, { width }));
			expectLabelOnBand(d, 'Uniform load 3 kN/m');
			expectLabelOnBand(d, 'Uniform load 5 kN/m');
		}
	});

	it('keeps a distributed-load label off the point-load arrows', () => {
		const v = solve(block('length 6 m', 'pin at 0', 'roller at end', 'udl 20 kN/m down', 'point 2 kN down at 3', 'point 15 kN down at 4.5'));
		for (const width of [320, 640]) {
			const s = buildBeamScene(v.model, v.results, opts(v.units, { width }));
			// The band middle is the 2 kN load's position: the label moves aside
			// instead of stacking above that load's label.
			expectLabelOnBand(s, 'Uniform load 20 kN/m');
			const box = textBox(bandAndLabel(s, 'Uniform load 20 kN/m').label);
			for (const shaft of s.prims.filter((p) => p.cls === 'bsd-load bsd-point')) {
				const x = Number(shaft.attrs.x1);
				expect(x < box.x0 - 8 || x > box.x1 + 8, `arrow at ${x} vs ${box.x0}..${box.x1}`).toBe(true);
			}
		}
	});

	it('moves band labels that do not fit next to each other into the label rows', () => {
		const pt = solve(PATCHES);
		const s = buildBeamScene(pt.model, undefined, opts(pt.units, { width: 320 }));
		const labels = texts(s, 'bsd-load-label');
		expect(labels).toHaveLength(6);
		// At 320 px the 0.5 m patches are far narrower than their labels.
		const beamTop = beamAxisY(s) - 2;
		const inRows = labels.filter((p) => textBox(p).y1 < beamTop - 26 - 15);
		expect(inRows.length).toBeGreaterThan(0);
	});

	it('spreads point loads at one position into separate, labelled arrows', () => {
		const sx = solve(SAME_X);
		const s = buildBeamScene(sx.model, sx.results, opts(sx.units));
		const x4 = createXLayout(640, 6).toPx(4);
		const shafts = [...new Set(s.prims.filter((p) => p.cls === 'bsd-load bsd-point').map((p) => Number(p.attrs.x1)))]
			.filter((x) => Math.abs(x - x4) < 10)
			.sort((a, b) => a - b);
		expect(shafts).toHaveLength(2);
		expect((shafts[1] ?? 0) - (shafts[0] ?? 0)).toBeCloseTo(8, 1);
		// One up and one down: each label says which, in the arrows' left-to-right order.
		const down = texts(s, 'bsd-load-label').find((p) => p.text === '6 kN ↓');
		const up = texts(s, 'bsd-load-label').find((p) => p.text === '4 kN ↑');
		expect(Number(down?.attrs.x)).toBeLessThan(Number(up?.attrs.x));
		// Two loads in the same direction: two arrows, no symbols needed.
		const twin = solve(block('length 6', 'pin at 0', 'roller at 6', 'point 3 kN at 2', 'point 3 kN at 2'));
		const t = buildBeamScene(twin.model, undefined, opts(twin.units));
		expect(new Set(t.prims.filter((p) => p.cls === 'bsd-load bsd-point').map((p) => p.attrs.x1)).size).toBe(2);
		expect(texts(t, 'bsd-load-label').map((p) => p.text)).toEqual(['3 kN', '3 kN']);
	});

	it('connects a label pushed into a higher row to its own arrow', () => {
		const cp = solve(CLOSE_POINTS);
		for (const width of [320, 640]) {
			const s = buildBeamScene(cp.model, undefined, opts(cp.units, { width }));
			const labels = texts(s, 'bsd-load-label');
			const boxes = labels.map(textBox);
			const rowZero = Math.max(...labels.map((p) => Number(p.attrs.y)));
			const leaders = s.prims.filter((p) => p.cls === 'bsd-load bsd-leader');
			const raised = labels.filter((p) => Number(p.attrs.y) < rowZero);
			expect(raised.length, `at ${width}`).toBeGreaterThan(0);
			for (const label of raised) {
				// Its leader starts 3 px under the label, at the arrow of the same load.
				const own = leaders.filter((l) => l.tooltip === label.tooltip && Math.abs(Number(l.attrs.y1) - Number(label.attrs.y) - 3) < 0.2);
				expect(own, `${label.text} at ${width}`).toHaveLength(1);
				const shaft = s.prims.find((p) => p.cls === 'bsd-load bsd-point' && p.tooltip === label.tooltip);
				expect(Number(own[0]?.attrs.x1)).toBe(Number(shaft?.attrs.x1));
			}
			// Leaders pass behind other labels, never through their text.
			for (const l of leaders) {
				const x = Number(l.attrs.x1);
				const ya = Math.min(Number(l.attrs.y1), Number(l.attrs.y2));
				const yb = Math.max(Number(l.attrs.y1), Number(l.attrs.y2));
				for (const b of boxes) expect(x > b.x0 && x < b.x1 && ya < b.y1 && yb > b.y0).toBe(false);
			}
		}
	});

	it('keeps couple arcs clear of supports, distributed-load arrows, hinges and walls', () => {
		// Couples at a pin and a roller: the arc ends stay above the support symbols.
		const cs = solve(block('length 8 m', 'pin at 0', 'roller at end', 'moment 10 kNm cw at 0', 'moment 10 kNm ccw at end', 'moment 5 kNm ccw at 3'));
		const s = buildBeamScene(cs.model, undefined, opts(cs.units));
		const axis = beamAxisY(s);
		const layout = createXLayout(640, 8);
		s.prims.forEach((p, i) => {
			if (p.cls !== 'bsd-load bsd-moment') return;
			const [sx, sy] = String(p.attrs.d).split(' ').slice(1, 3).map(Number);
			const headYs = parsePoints(s.prims[i + 1]).map((pt) => pt[1]);
			const lowest = Math.max(sy ?? 0, ...headYs);
			const atSupport = Math.abs((sx ?? 0) - layout.left) < 20 || Math.abs((sx ?? 0) - layout.right) < 20;
			// 220 degree arc at a support (ends 20 degrees below the axis), 270 elsewhere (45 degrees).
			if (atSupport) expect(lowest).toBeLessThanOrEqual(axis + 14 * Math.sin((20 * Math.PI) / 180) + 0.2);
			else expect(lowest).toBeGreaterThan(axis + 9);
		});

		// No distributed-load arrow under the end couple of the cantilever...
		const cant = solve(example('cantilever'));
		const cx = createXLayout(640, 3).toPx(3);
		expect(distArrowXs(buildBeamScene(cant.model, undefined, opts(cant.units))).every((x) => Math.abs(x - cx) >= 18)).toBe(true);
		// ...pointing into a hinge...
		const ger = solve(example('gerber'));
		const hx = createXLayout(640, ger.model.length).toPx(ger.model.hinges[0] ?? 0);
		expect(distArrowXs(buildBeamScene(ger.model, undefined, opts(ger.units))).every((x) => Math.abs(x - hx) >= 7)).toBe(true);
		// ...or lying on a fixed-end wall: the end arrow moves 3 px into the band.
		const prop = solve(example('propped'));
		const first = distArrowXs(buildBeamScene(prop.model, undefined, opts(prop.units)))[0];
		expect(first).toBeCloseTo(createXLayout(640, 6).left + 3, 1);
	});

	it('draws the reaction couple of an interior clamp below the beam, clear of the loads', () => {
		const v = solve(block('length 10 m', 'roller at 0', 'fixed at 5', 'roller at 10', 'udl 6 kN/m down', 'point 10 kN down at 2'));
		const s = buildBeamScene(v.model, v.results, opts(v.units));
		const axis = beamAxisY(s);
		const arc = s.prims.find((p) => p.tag === 'path' && p.cls === 'bsd-reaction');
		const nums = String(arc?.attrs.d).match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
		// "M sx sy A r r 0 large sweep ex ey": both ends above the axis, so the
		// 270 degree arc runs below the beam with its gap at the top.
		expect(nums[1]).toBeLessThan(axis);
		expect(nums[nums.length - 1]).toBeLessThan(axis);
		expect(nums[5]).toBe(1);
		const clamp = createXLayout(640, 10).toPx(5);
		expect(distArrowXs(s).every((x) => Math.abs(x - clamp) >= 22)).toBe(true);
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

	it('says in the moment title when the tension-side convention is active', () => {
		const t = buildDiagramScene(ss.results, 'moment', opts(ss.units, { momentConvention: 'tension-side' }));
		const title = texts(t, 'bsd-diagram-title')[0];
		expect(title?.text).toBe('Bending moment M (kN·m), tension side');
		expect(texts(buildDiagramScene(ss.results, 'shear', opts(ss.units, { momentConvention: 'tension-side' })), 'bsd-diagram-title')[0]?.text).toBe('Shear force V (kN)');
		// The longest title still fits the narrowest layout.
		const us = solve(example('overhang'));
		const narrow = buildDiagramScene(us.results, 'moment', opts(us.units, { width: 320, momentConvention: 'tension-side' }));
		expect(textBox(texts(narrow, 'bsd-diagram-title')[0] as Prim).x1).toBeLessThanOrEqual(320);
	});

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

	it('never writes a key-point value over a neighbouring key point', () => {
		// Loads 0.1 m apart: "+30.15" (M at 1.4 m) used to sit across the 1.2 m guide.
		const cp = solve(CLOSE_POINTS);
		const signed = (v: number): string => `${v > 0 ? '+' : ''}${formatNumber(toDisplay(v, 'moment', cp.units), 2)}`;
		for (const width of [320, 640, 1100]) {
			const m = buildDiagramScene(cp.results, 'moment', opts(cp.units, { width }));
			const lay = createXLayout(width, cp.model.length);
			for (const label of m.prims.filter((p) => p.tag === 'text' && p.cls === 'bsd-value')) {
				const box = textBox(label);
				for (const k of cp.results.keyPoints) {
					const kx = lay.toPx(k);
					if (!(kx > box.x0 + 2 && kx < box.x1 - 2)) continue;
					// A label may only cover the key point whose value it shows.
					const own = [signed(evaluateAt(cp.results.segments, 'M', k, 'left')), signed(evaluateAt(cp.results.segments, 'M', k, 'right'))];
					expect(own, `"${label.text}" over x = ${k} at ${width}`).toContain(label.text);
				}
			}
		}
	});

	it('marks shear zeros at jumps with a tick only, keeping the text for smooth zeros', () => {
		const three = solve(block('length 20 m', 'pin at 2', 'roller at 7', 'roller at 13', 'roller at 18', 'udl 5 kN/m down', 'point 10 kN down at 0', 'point 10 kN down at 20'));
		const v = buildDiagramScene(three.results, 'shear', opts(three.units));
		// Seven zeros: four at the supports (jumps through zero), three in the spans.
		expect(three.results.shearZeros).toHaveLength(7);
		expect(v.prims.filter((p) => p.tag === 'line' && p.cls === 'bsd-zero')).toHaveLength(7);
		expect(texts(v, 'bsd-zero').map((p) => p.text)).toEqual(['x = 5.31 m', 'x = 10.00 m', 'x = 14.69 m']);
	});

	it('writes a constant run once and emphasises only the largest magnitude', () => {
		// A couple splits the constant shear into two segments: one "+3.00" for the run.
		const cc = solve(block('length 4 m', 'fixed at 0', 'moment 10 kNm cw at end', 'moment 4 kNm ccw at 1.5', 'point 3 kN down at 2.5'));
		const v = buildDiagramScene(cc.results, 'shear', opts(cc.units));
		expect(texts(v, 'bsd-value').map((p) => p.text)).toEqual(['+3.00']);
		// All hogging: only the most negative moment is bold, not the "max" -9.00 nearest zero.
		const m = buildDiagramScene(cc.results, 'moment', opts(cc.units));
		expect(texts(m, 'bsd-extreme').map((p) => p.text)).toEqual(['-13.50']);
		expect(texts(m, 'bsd-value').map((p) => p.text)).toContain('-9.00');
		// Equal values look the same: both span peaks of the continuous beam are bold.
		const cont = solve(example('continuous'));
		const cm = buildDiagramScene(cont.results, 'moment', opts(cont.units));
		expect(texts(cm, 'bsd-extreme').map((p) => p.text).sort()).toEqual(['+12.66', '+12.66', '-22.50']);
	});

	it('does not take a cubic moment with equal samples for a constant one', () => {
		// M = 5 at x = 0, 3 and 6 m, but +8.46 and +1.54 in between: not constant,
		// so each end gets its own "+5.00" instead of one label for a "step".
		const probe = solve(block('length 6 m', 'pin at 0', 'roller at 6', 'linear -6 to 6 kN/m down from 0 to 6', 'moment 5 kNm cw at 0', 'moment 5 kNm ccw at 6'));
		const m = buildDiagramScene(probe.results, 'moment', opts(probe.units));
		const fives = texts(m, 'bsd-value').filter((p) => p.text === '+5.00');
		// One at each end (centred on it, or written just beside it).
		expect(fives).toHaveLength(2);
		expect(Math.abs(Number(fives[0]?.attrs.x) - layout.left)).toBeLessThanOrEqual(3);
		expect(Math.abs(Number(fives[1]?.attrs.x) - layout.right)).toBeLessThanOrEqual(3);
		expect(texts(m, 'bsd-value').map((p) => p.text)).toContain('+1.54');
	});

	it('writes nearly equal values side by side only once', () => {
		// 0.01 kN and a 0.02 kN·m couple next to 1000 kN: the steps are invisible.
		const tiny = solve(block('length 6 m', 'pin at 0', 'roller at end', 'point 0.01 kN down at 2', 'point 1000 kN down at 4', 'udl 0.05 kN/m down from 0 to 3', 'moment 0.02 kNm cw at 1'));
		const v = texts(buildDiagramScene(tiny.results, 'shear', opts(tiny.units)), 'bsd-value').map((p) => p.text);
		expect(v.filter((t) => t === '+333.35' || t === '+333.34')).toHaveLength(1);
		const m = texts(buildDiagramScene(tiny.results, 'moment', opts(tiny.units)), 'bsd-value').map((p) => p.text);
		expect(m.filter((t) => t === '+333.42' || t === '+333.44')).toHaveLength(1);
	});

	it('samples long segments densely enough to look smooth', () => {
		const lin = solve(block('length 8 m', 'pin at 0', 'roller at end', 'linear -4 to 6 kN/m down from 0 to 8'));
		const pts = curve(buildDiagramScene(lin.results, 'moment', opts(lin.units, { width: 1100 })));
		const steps = pts.slice(1).map((p, i) => p[0] - (pts[i]?.[0] ?? 0));
		// At most 6 px between samples (plus the 0.1 px rounding of the markup).
		expect(Math.max(...steps)).toBeLessThanOrEqual(6.15);
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

	it('draws guides at the interior key points only', () => {
		const guides = shear.prims.filter((p) => p.cls === 'bsd-guide').map((p) => Number(p.attrs.x1));
		// Key points 0, 2 and 6 m: the beam ends are marked by the axis ends,
		// and a guide there would show through the end labels.
		expect(ss.results.keyPoints).toEqual([0, 2, 6]);
		expect(guides).toEqual([Math.round(layout.toPx(2) * 10) / 10]);
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

	// Regression: with E and I given but out of range the note said "add a material", which was wrong.
	it('says the deflection could not be computed when E and I are given but out of range', () => {
		const absurd = solve(block('length 6', 'pin at 0', 'roller at end', 'point 10 at 2', 'E 1e-300 Pa', 'I 8000 cm^4'));
		expect(absurd.results.hasDeflection).toBe(false);
		const s = buildDiagramScene(absurd.results, 'deflection', opts(absurd.units, { width: 320 }));
		expect(texts(s, 'bsd-note').map((p) => p.text).join(' ')).toBe('The deflection could not be computed: check E and I');
		expect(s.desc).toBe('Deflection is not available: E and I are out of range.');
	});

	it('respects the decimals option', () => {
		const three = buildDiagramScene(ss.results, 'shear', opts(ss.units, { decimals: 3 }));
		expect(texts(three, 'bsd-extreme').map((p) => p.text)).toEqual(['+18.667', '-15.333']);
		const zero = buildDiagramScene(ss.results, 'shear', opts(ss.units, { decimals: 0 }));
		expect(texts(zero, 'bsd-extreme').map((p) => p.text)).toEqual(['+19', '-15']);
	});

	// Regression: at decimals 0 the 2.17 m shear zero read "x = 2 m", which is not where the peak moment is.
	it('keeps at least 2 decimals for computed positions at low decimals', () => {
		const zero = buildDiagramScene(ss.results, 'shear', opts(ss.units, { decimals: 0 }));
		expect(texts(zero, 'bsd-zero').map((p) => p.text)).toEqual(['x = 2.17 m']);
		expect(zero.desc).toContain('It changes sign at x = 2.17 m.');
		const moment = buildDiagramScene(ss.results, 'moment', opts(ss.units, { decimals: 1 }));
		expect(moment.desc).toBe('Largest sagging moment 29.4 kN·m at x = 2.17 m. Sagging moments are drawn above the axis.');
		const deflection = buildDiagramScene(ss.results, 'deflection', opts(ss.units, { decimals: 0 }));
		expect(texts(deflection, 'bsd-extreme').map((p) => p.text)).toEqual(['max 7 mm ↓ at 2.90 m']);
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

	it('formats typed values compactly without turning small ones into 0', () => {
		expect(formatInput(4000, 'force', 'kN-m', 2)).toBe('4');
		expect(formatInput(2500, 'force', 'kN-m', 2)).toBe('2.5');
		// 0.4 N in kN: three decimals would print "0".
		expect(formatInput(0.4, 'force', 'kN-m', 2)).toBe('0.000400');
		expect(formatInput(-0.4, 'force', 'kN-m', 2)).toBe('-0.000400');
		expect(formatInput(0.003, 'force', 'kN-m', 2)).toBe('3.00e-6');
		// Round-off stays 0.
		expect(formatInput(1e-14, 'force', 'kN-m', 2)).toBe('0');
		expect(formatInput(0, 'force', 'kN-m', 2)).toBe('0');
	});

	it('leaves gaps in arrow shafts and lines, and sizes heads on request', () => {
		const pieces = verticalLine('bsd-load', 5, 0, 100, [[20, 30], [60, 50]]).map((p) => [p.attrs.y1, p.attrs.y2]);
		expect(pieces).toEqual([[0, 20], [30, 50], [60, 100]]);
		// Upwards: same pieces, in the direction of travel.
		const up = verticalLine('bsd-load', 5, 100, 0, [[20, 30]]).map((p) => [p.attrs.y1, p.attrs.y2]);
		expect(up).toEqual([[100, 30], [20, 0]]);
		// A gap covering everything leaves nothing; pieces of 0.5 px or less are dropped.
		expect(verticalLine('bsd-load', 5, 0, 10, [[-1, 9.6]])).toHaveLength(0);
		const arrow = verticalArrow('bsd-load', 'bsd-arrowhead', 50, 0, 60, 'tip', { headLen: 9, headHalf: 4.5, gaps: [[10, 20]] });
		expect(arrow.filter((p) => p.tag === 'line').map((p) => [p.attrs.y1, p.attrs.y2])).toEqual([[0, 10], [20, 51]]);
		const head = parsePoints(arrow[arrow.length - 1]);
		expect(head).toEqual([[50, 60], [45.5, 51], [54.5, 51]]);
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
				// Same filter as the mounted SVG (isForbiddenAttribute): no inline style, handlers or links.
				{ tag: 'rect', cls: 'bsd-support', attrs: { x: 0, y: 0, width: 1, height: 1, style: 'fill:red', onclick: 'x()', href: 'https://example.com', 'xlink:href': '#a' } },
			],
		};
		const svg = sceneToSvgString(scene);
		expect(
			svg.startsWith(
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 100" width="320" height="100" class="bsd-svg" role="img" aria-label="A &amp; B &lt;beam&gt;">',
			),
		).toBe(true);
		expect(svg).toContain('<rect class="bsd-support" x="0" y="0" width="1" height="1"/>');
		expect(svg).not.toMatch(/style=|onclick|href/);
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
