/**
 * Shear force, bending moment and deflection diagrams.
 *
 * Each diagram is a separate scene sharing the beam scene's XLayout, so a
 * point load drawn on the beam sits exactly above the jump it causes here.
 *
 * Layout (y grows downwards):
 *
 *   title band            "Shear force V (kN)", top left
 *   plot area             zero axis, guides at key points, filled areas,
 *                         the curve and value labels
 *
 * Vertical scale: the part of the curve above the axis and the part below
 * share the usable plot height in proportion to their size, so a diagram
 * with equal positive and negative peaks puts each at about 40% of the plot
 * height from the axis, and a one-sided diagram (the moment of a simply
 * supported beam) uses the full height instead of wasting half of it.
 */
import { evaluateAt, sampleDiagram } from '../core/diagrams';
import type { SegmentField } from '../core/diagrams';
import { polyEval } from '../core/polynomial';
import { forceScale } from '../core/scale';
import { POSITION_TOL } from '../core/tolerances';
import type { BeamResults, DiagramQuantity, Dimension, Extremum } from '../core/types';
import { formatNumber, formatQuantity, toDisplay, unitSymbol } from '../core/units';
import { boxesOverlap, formatResultPosition, labelDecimals, linePrim, pointsAttr, placeText, sceneWidth, textPrim } from './draw';
import type { Anchor, Box, PlacedText } from './draw';
import { createXLayout, estimateTextWidth, LAYOUT, px } from './scene';
import type { Prim, Scene, SceneOptions } from './scene';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** What each diagram plots and how it is labelled. */
interface QuantityInfo {
	/** Segment polynomial evaluated for key-point values. */
	field: SegmentField;
	/** Display dimension of the values. */
	dimension: Dimension;
	/** Name in the title, e.g. "Shear force". */
	name: string;
	/** Symbol in the title, e.g. "V". */
	symbol: string;
	/** Samples per segment: V is at most quadratic, M and v are cubic or higher. */
	samples: number;
	/** Accessible name of the scene. */
	sceneTitle: string;
}

const QUANTITIES: Record<DiagramQuantity, QuantityInfo> = {
	shear: { field: 'V', dimension: 'force', name: 'Shear force', symbol: 'V', samples: 24, sceneTitle: 'Shear force diagram' },
	moment: { field: 'M', dimension: 'moment', name: 'Bending moment', symbol: 'M', samples: 32, sceneTitle: 'Bending moment diagram' },
	deflection: { field: 'v', dimension: 'deflection', name: 'Deflection', symbol: 'v', samples: 32, sceneTitle: 'Deflection diagram' },
};

/** Scene height [px]. */
const HEIGHT = 150;
/** Height of the placeholder scene shown when deflection is not available, and of each extra note line. */
const NOTE_HEIGHT = 44;
const NOTE_LINE_H = 13;
/** Baseline of the first note line below the title baseline. */
const NOTE_FIRST_DY = 18;
/** Title position (top left). */
const TITLE_X = 4;
const TITLE_BASELINE = 13;
/** Value labels keep this much space below the title baseline (its descenders). */
const TITLE_CLEARANCE = 3;
/** Plot area: below the title band, above a small bottom margin. */
const PLOT_TOP = 20;
const PLOT_BOTTOM = HEIGHT - 12;
/**
 * Room kept between the plot edges and the highest / lowest point of the
 * curve, for the value labels written above or below those points.
 */
const LABEL_ROOM = 14;
/** Baseline offsets of a label written above / below a point (below = gap + text ascent). */
const ABOVE_DY = -4;
const BELOW_DY = 11;
/** Horizontal offset of labels written beside a jump (left value left of it, right value right of it). */
const SIDE_DX = 3;
/** Half length of the tick marking a zero of the shear force. */
const ZERO_TICK = 4;
/** The "0" of a flat (all zero) diagram: offset from the right end of the axis, and baseline below it. */
const ZERO_LABEL_DX = 6;
const ZERO_LABEL_DY = 3.5;
/**
 * Curves are sampled at least every this many px along the longest segment,
 * so a long single segment on a wide drawing shows no polyline facets;
 * capped so an absurd width cannot ask for millions of samples.
 */
const SAMPLE_PX = 6;
const MAX_SAMPLES = 512;
/** Minimum spacing between two labels [px]. */
const LABEL_GAP = 2;
/**
 * A value label is not written when a label placed before it already shows
 * nearly the same number nearby: within this many px horizontally and this
 * fraction of the largest magnitude (for example "+29.33" under a point load
 * right next to the "+29.39" peak). The two sides of a jump smaller than
 * DUPLICATE_REL get one label.
 */
const DUPLICATE_PX = 40;
const DUPLICATE_REL = 0.03;
/**
 * Values below this fraction of the diagram's largest magnitude are not
 * labelled, and a diagram whose largest magnitude is below this fraction of
 * the load scale is drawn as a flat zero line.
 */
const ZERO_REL = 1e-9;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds one diagram aligned with the beam scene (same XLayout). Positive and
 * negative areas get different classes, extremes and zero crossings are
 * labelled, and jumps are drawn as vertical steps.
 *
 * With momentConvention 'tension-side' the moment diagram is drawn on the
 * tension side of the beam, so positive (sagging) values appear BELOW the
 * axis; their labels keep the sign of the internal convention ("+29.39"),
 * and the title says "tension side" so the mirrored shape is explained.
 * Shear and deflection are always drawn positive up.
 *
 * Asking for 'deflection' when the results have none returns a short scene
 * with a note instead of throwing: "add E and I" when one is missing, or a
 * plain "could not be computed" when both are given but the solver withheld
 * the deflection (out of double-precision range).
 */
export function buildDiagramScene(results: BeamResults, quantity: DiagramQuantity, options: SceneOptions): Scene {
	const info = QUANTITIES[quantity];
	const width = sceneWidth(options.width);
	const model = results.model;
	const L = Number.isFinite(model.length) && model.length > 0 ? model.length : 0;
	const layout = createXLayout(width, L);
	const units = options.units;
	const decimals = labelDecimals(options.decimals);
	const unit = unitSymbol(info.dimension, units);
	const tensionSide = quantity === 'moment' && options.momentConvention === 'tension-side';
	// Short suffix: the longest title ("Bending moment M (kip·ft), tension side") still fits 320 px.
	const titleText = `${info.name} ${info.symbol} (${unit})${tensionSide ? ', tension side' : ''}`;
	const titlePrim = textPrim('bsd-diagram-title', placeText(TITLE_X, TITLE_BASELINE, titleText, LAYOUT.fontSize, width, 'start'), titleText);

	if (quantity === 'deflection' && !results.hasDeflection) {
		const missing = model.E === undefined || model.I === undefined;
		const note = missing
			? 'Add a material (or E) and a section (or I) to see the deflection'
			: 'The deflection could not be computed: check E and I';
		// Wrapped so it also fits the narrowest layout (320 px).
		const lines = wrapWords(note, width - 2 * TITLE_X, LAYOUT.smallFontSize);
		const notes = lines.map((line, i) =>
			textPrim('bsd-note', placeText(TITLE_X, TITLE_BASELINE + NOTE_FIRST_DY + i * NOTE_LINE_H, line, LAYOUT.smallFontSize, width, 'start'), line),
		);
		return {
			width,
			height: NOTE_HEIGHT + (lines.length - 1) * NOTE_LINE_H,
			title: info.sceneTitle,
			desc: missing ? 'Deflection is not available because E or I is missing.' : 'Deflection is not available: E and I are out of range.',
			prims: [titlePrim, ...notes],
		};
	}

	const X = (x: number): number => layout.toPx(Number.isFinite(x) ? Math.min(Math.max(x, 0), L) : 0);
	const longestPx = Math.max(0, ...results.segments.map((seg) => X(seg.x1) - X(seg.x0)));
	const samples = Math.min(MAX_SAMPLES, Math.max(info.samples, Math.ceil(longestPx / SAMPLE_PX)));
	// dedupe() below drops the extra samples that land on the same pixel.
	const series = sampleDiagram(results.segments, quantity, samples);
	const { max, min } = extremaOf(results, quantity);
	// Moment on the tension side: sagging (positive) is drawn downwards.
	const dirSign = tensionSide ? -1 : 1;

	let maxAbs = Math.max(Math.abs(max.value), Math.abs(min.value));
	for (const y of series.ys) maxAbs = Math.max(maxAbs, Math.abs(y));
	const zeroTol = ZERO_REL * maxAbs;
	const flat = !(maxAbs > ZERO_REL * referenceScale(results, quantity));

	const prims: Prim[] = [];
	// Faint guides at the interior key points tie the diagram to the beam
	// drawing above. None at the beam ends: the axis ends already mark them,
	// and a dashed line would show through the end labels centred there.
	const eps = POSITION_TOL * L;
	for (const k of results.keyPoints) {
		if (k > eps && k < L - eps) prims.push(linePrim('bsd-guide', X(k), PLOT_TOP, X(k), PLOT_BOTTOM));
	}

	if (flat) {
		const axisY = 0.5 * (PLOT_TOP + PLOT_BOTTOM);
		prims.push(linePrim('bsd-axis', X(0), axisY, X(L), axisY));
		prims.push(curvePrim(quantity, [[X(0), axisY], [X(L), axisY]]));
		const zero = placeText(X(L) + ZERO_LABEL_DX, axisY + ZERO_LABEL_DY, '0', LAYOUT.smallFontSize, width, 'start');
		prims.push(textPrim('bsd-value', zero, '0'), titlePrim);
		return { width, height: HEIGHT, title: info.sceneTitle, desc: `${info.name} is zero along the whole beam.`, prims };
	}

	// --- Vertical mapping ----------------------------------------------------
	// up / down: largest extent above / below the axis in value units, after
	// the convention flip. Exact extremes are included because the samples can
	// fall just short of a peak.
	let up = 0;
	let down = 0;
	for (const v of [...series.ys, max.value, min.value]) {
		up = Math.max(up, dirSign * v);
		down = Math.max(down, -dirSign * v);
	}
	const usable = PLOT_BOTTOM - PLOT_TOP - 2 * LABEL_ROOM;
	const k = usable / (up + down);
	const axisY = PLOT_TOP + LABEL_ROOM + up * k;
	const Y = (v: number): number => axisY - dirSign * v * k;

	// --- Areas and curve -----------------------------------------------------
	const pts: CurvePoint[] = series.xs.map((x, i) => {
		const v = series.ys[i] ?? 0;
		return { X: X(x), Y: Y(v), v };
	});
	for (const region of splitAtZero(pts, axisY, zeroTol)) {
		const cls = quantity === 'deflection' ? 'bsd-area bsd-deflection-area' : region.sign > 0 ? 'bsd-area bsd-pos' : 'bsd-area bsd-neg';
		prims.push({ tag: 'polygon', cls, attrs: { points: pointsAttr(region.points) } });
	}
	prims.push(linePrim('bsd-axis', X(0), axisY, X(L), axisY));
	prims.push(curvePrim(quantity, dedupe(pts.map((p) => [p.X, p.Y] as [number, number]))));

	// --- Labels --------------------------------------------------------------
	const candidates: Candidate[] = [];
	const display = (v: number): number => toDisplay(v, info.dimension, units);
	const signed = (v: number): string => `${v > 0 ? '+' : ''}${formatNumber(display(v), decimals)}`;
	/** Placements around the curve point of value v at beam position x. */
	const near = (x: number, v: number, sides: Side[], inside: boolean): Placement[] =>
		around(X(x), Y(v), dirSign * v > 0, sides, inside);

	// Extremes worth a label: the largest positive value only if positive and
	// the most negative only if negative, so a one-signed diagram (all
	// hogging, say) emphasises its largest magnitude and not the value
	// nearest zero. This also writes a constant diagram's value once.
	const positive = max.value > zeroTol ? [max] : [];
	const negative = min.value < -zeroTol ? [min] : [];
	const shownExtremes = quantity === 'deflection' ? [...negative, ...positive] : [...positive, ...negative];
	const extremeTexts = new Set(shownExtremes.map((e) => signed(e.value)));
	/**
	 * Class of an ordinary value label: emphasised like the extremes when it
	 * shows the same number (the equal peak of a second span), so equal values
	 * never look different.
	 */
	const valueCls = (text: string): string => (extremeTexts.has(text) ? 'bsd-value bsd-extreme' : 'bsd-value');

	for (const e of shownExtremes) {
		// Deflection: "max 2.81 mm ↓ at 3.00 m" (magnitude, direction arrow and
		// position); shear and moment: the signed value, "+18.67".
		const text =
			quantity === 'deflection'
				? `max ${formatNumber(Math.abs(display(e.value)), decimals)} ${unit} ${e.value < 0 ? '↓' : '↑'} at ${formatResultPosition(e.x, units, decimals)}`
				: signed(e.value);
		candidates.push({
			text,
			cls: 'bsd-value bsd-extreme',
			priority: 0,
			required: true,
			placements: near(e.x, e.value, ['mid', 'right', 'left'], false),
			value: e.value,
			span: [X(e.x), X(e.x)],
		});
	}

	if (quantity === 'shear') {
		for (const z of results.shearZeros) {
			const x = X(z);
			prims.push(linePrim('bsd-zero', x, axisY - ZERO_TICK, x, axisY + ZERO_TICK));
			// A zero that is a jump through zero (at a support or a point load)
			// sits on a key point the beam drawing already dimensions: keep the
			// tick, skip the text, which would only crowd out the smooth zeros.
			const jump = Math.abs(evaluateAt(results.segments, 'V', z, 'left') - evaluateAt(results.segments, 'V', z, 'right'));
			if (jump > zeroTol) continue;
			// Try the empty quadrants first: when V comes down through zero the
			// curve is above the axis on the left and below it on the right.
			const leftPositive = shearPositiveLeftOf(results, z, zeroTol);
			const below = axisY + BELOW_DY;
			const above = axisY + ABOVE_DY;
			const left = (y: number): Placement => ({ x: x - SIDE_DX, y, anchor: 'end' });
			const right = (y: number): Placement => ({ x: x + SIDE_DX, y, anchor: 'start' });
			const placements = leftPositive
				? [left(below), right(above), left(above), right(below)]
				: [left(above), right(below), left(below), right(above)];
			candidates.push({ text: `x = ${formatResultPosition(z, units, decimals)}`, cls: 'bsd-value bsd-zero', priority: 1, placements });
		}
		candidates.push(...keyPointCandidates(results, 'V', L, zeroTol, maxAbs, X, near, signed, valueCls, shownExtremes));
	} else if (quantity === 'moment') {
		// M is locally extreme where V changes sign (dM/dx = V), so these are
		// the peak moments of each span, for example both spans of a
		// continuous beam even though only the first counts as the maximum.
		for (const z of results.shearZeros) {
			const v = evaluateAt(results.segments, 'M', z, 'left');
			if (!(Math.abs(v) > zeroTol)) continue;
			const text = signed(v);
			candidates.push({ text, cls: valueCls(text), priority: 1, placements: near(z, v, ['mid', 'right', 'left'], false), value: v, span: [X(z), X(z)] });
		}
		candidates.push(...keyPointCandidates(results, 'M', L, zeroTol, maxAbs, X, near, signed, valueCls, shownExtremes));
	}

	// The curve and the axis are obstacles: a label may sit inside a filled
	// area (it has a halo) but must not be crossed by a line.
	const obstacles: Segment2[] = [[X(0), axisY, X(L), axisY]];
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1];
		const b = pts[i];
		if (a && b) obstacles.push([a.X, a.Y, b.X, b.Y]);
	}
	const keyXs = results.keyPoints.map(X);
	prims.push(...placeLabels(candidates, width, obstacles, keyXs, DUPLICATE_REL * maxAbs), titlePrim);

	return { width, height: HEIGHT, title: info.sceneTitle, desc: describeDiagram(results, quantity, max, min, zeroTol, options, decimals), prims };
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

/** Exact largest and smallest values of the plotted quantity (SI). */
function extremaOf(results: BeamResults, quantity: DiagramQuantity): { max: Extremum; min: Extremum } {
	const e = results.extrema;
	switch (quantity) {
		case 'shear':
			return { max: e.shearMax, min: e.shearMin };
		case 'moment':
			return { max: e.momentMax, min: e.momentMin };
		case 'deflection':
			return { max: e.deflectionMax ?? { value: 0, x: 0 }, min: e.deflectionMin ?? { value: 0, x: 0 } };
	}
}

/**
 * Magnitude a diagram is compared with to decide that it is zero: the force
 * scale F of the loads and reactions for V, F·L for M and F·L³ / EI for v
 * (the order of magnitude of a deflection under those loads).
 */
function referenceScale(results: BeamResults, quantity: DiagramQuantity): number {
	const { model } = results;
	const F = forceScale(model, results.reactions);
	const L = model.length;
	switch (quantity) {
		case 'shear':
			return F;
		case 'moment':
			return F * L;
		case 'deflection': {
			const EI = (model.E ?? 0) * (model.I ?? 0);
			return EI > 0 ? (F * L * L * L) / EI : 0;
		}
	}
}

/**
 * True when V is positive just left of a zero at x. At a jump through zero
 * the left limit says it directly; at a smooth crossing the left limit is
 * (nearly) zero, so the slope decides: dV/dx = q < 0 means V decreases
 * through zero, so it was positive on the left.
 */
function shearPositiveLeftOf(results: BeamResults, x: number, zeroTol: number): boolean {
	const left = evaluateAt(results.segments, 'V', x, 'left');
	if (Math.abs(left) > zeroTol) return left > 0;
	return evaluateAt(results.segments, 'q', x, 'left') <= 0;
}

/** One sampled point: pixel position and value (SI). */
interface CurvePoint {
	X: number;
	Y: number;
	v: number;
}

/** A closed area between the curve and the axis where the value keeps one sign. */
interface Region {
	sign: 1 | -1;
	points: [number, number][];
}

/**
 * Splits the sampled curve into same-sign regions closed along the axis.
 * A sign change between two samples is located by linear interpolation,
 * x_c = x_a + (x_b - x_a)·v_a / (v_a - v_b); for a jump (same x) that is the
 * jump itself. Samples within zeroTol of zero lie on the axis and end a
 * region. Each region starts and ends on the axis, so a curve that starts
 * away from zero (a reaction at x = 0) gets a vertical edge there.
 */
export function splitAtZero(pts: readonly CurvePoint[], axisY: number, zeroTol: number): Region[] {
	const regions: Region[] = [];
	let cur: Region | null = null;
	let prev: CurvePoint | null = null;
	for (const p of pts) {
		const s = Math.abs(p.v) <= zeroTol ? 0 : p.v > 0 ? 1 : -1;
		if (cur && s !== cur.sign) {
			let xc = p.X;
			if (s !== 0 && prev) xc = prev.X + ((p.X - prev.X) * prev.v) / (prev.v - p.v);
			cur.points.push([xc, axisY]);
			regions.push(cur);
			cur = s === 0 ? null : { sign: s, points: [[xc, axisY], [p.X, p.Y]] };
		} else if (!cur && s !== 0) {
			// The previous sample (if any) was on the axis: start the region there.
			cur = { sign: s, points: [[prev ? prev.X : p.X, axisY], [p.X, p.Y]] };
		} else if (cur) {
			cur.points.push([p.X, p.Y]);
		}
		prev = p;
	}
	if (cur && prev) {
		cur.points.push([prev.X, axisY]);
		regions.push(cur);
	}
	return regions;
}

/** Drops consecutive points that round to the same pixel (jumps keep both ends: their y differs). */
function dedupe(points: [number, number][]): [number, number][] {
	const out: [number, number][] = [];
	for (const p of points) {
		const last = out[out.length - 1];
		if (last && px(last[0]) === px(p[0]) && px(last[1]) === px(p[1])) continue;
		out.push(p);
	}
	return out;
}

/** Splits text at spaces into lines whose estimated width fits `maxWidth` (a single long word gets its own line). */
function wrapWords(text: string, maxWidth: number, fontSize: number): string[] {
	const lines: string[] = [];
	let line = '';
	for (const word of text.split(' ')) {
		const next = line === '' ? word : `${line} ${word}`;
		if (line !== '' && estimateTextWidth(next, fontSize) > maxWidth) {
			lines.push(line);
			line = word;
		} else {
			line = next;
		}
	}
	if (line !== '') lines.push(line);
	return lines;
}

/** The diagram line; deflection gets its own colour class. */
function curvePrim(quantity: DiagramQuantity, points: [number, number][]): Prim {
	const cls = quantity === 'deflection' ? 'bsd-curve bsd-deflection-curve' : 'bsd-curve';
	return { tag: 'polyline', cls, attrs: { points: pointsAttr(points) } };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** One way to place a label: anchor x and baseline y [px], and the text anchor. */
interface Placement {
	x: number;
	y: number;
	anchor: Anchor;
}

/** Horizontal position of a label relative to its point: centred, left of it or right of it. */
type Side = 'mid' | 'left' | 'right';

/** A line segment [x1, y1, x2, y2] in px that labels must not cross. */
type Segment2 = [number, number, number, number];

/** A label waiting for placement. Lower priority numbers are placed first. */
interface Candidate {
	text: string;
	cls: string;
	priority: number;
	/** Placements to try in order; the first free one wins. */
	placements: Placement[];
	/** Keep the label (at its first placement) even when every placement collides. */
	required?: boolean;
	/** The value shown (SI), for the near-duplicate test in placeLabels. */
	value?: number;
	/**
	 * Pixel range [x0, x1] of the curve the value belongs to: one point, or a
	 * whole constant run. Needed with `value`.
	 */
	span?: [number, number];
	/**
	 * A key-point value: its box must not cover another key point (outside
	 * `span`), where it would read as that point's value. Extremes and shear
	 * zeros may: their text says where they are, or they are required.
	 */
	stayOnSpan?: boolean;
}

/**
 * Placements around a curve point at (x, y) px. "Outside" is away from the
 * axis (above for a point drawn above it), where a label normally belongs;
 * with `inside` the same sides are offered again between the point and the
 * axis, for points where the curve itself blocks the outside (a sloping
 * line right next to a jump).
 */
function around(x: number, y: number, outsideUp: boolean, sides: Side[], inside: boolean): Placement[] {
	const at = (side: Side, baseline: number): Placement =>
		side === 'mid'
			? { x, y: baseline, anchor: 'middle' }
			: side === 'left'
				? { x: x - SIDE_DX, y: baseline, anchor: 'end' }
				: { x: x + SIDE_DX, y: baseline, anchor: 'start' };
	const outY = y + (outsideUp ? ABOVE_DY : BELOW_DY);
	const inY = y + (outsideUp ? BELOW_DY : ABOVE_DY);
	const list = sides.map((side) => at(side, outY));
	if (inside) list.push(...sides.map((side) => at(side, inY)));
	return list;
}

/**
 * Values at key points (supports, point loads, load ends, beam ends). Where
 * the value jumps, the left limit is written left of the step and the right
 * limit right of it; otherwise one label goes next to the point, on whichever
 * side the curve leaves free. A jump smaller than DUPLICATE_REL of the
 * largest magnitude gets one label, like no jump: two nearly equal numbers
 * side by side would only clutter.
 *
 * A run of constant segments with one value (V between point loads, M
 * under a pure couple, also when a couple splits the run into two segments)
 * gets ONE label for the whole step, tried at its start, its end and its
 * middle, instead of the same number at every key point. Zero values are
 * skipped (they sit on the axis), and so are runs that contain an extreme of
 * the same value; repeats of a nearby label are dropped in placeLabels.
 */
function keyPointCandidates(
	results: BeamResults,
	field: SegmentField,
	L: number,
	zeroTol: number,
	maxAbs: number,
	X: (x: number) => number,
	near: (x: number, v: number, sides: Side[], inside: boolean) => Placement[],
	signed: (v: number) => string,
	valueCls: (text: string) => string,
	extremes: readonly Extremum[],
): Candidate[] {
	const out: Candidate[] = [];
	const eps = POSITION_TOL * L;
	const segments = results.segments;
	const meaningful = (v: number | undefined): v is number => v !== undefined && Math.abs(v) > zeroTol;
	const candidate = (v: number, x0: number, x1: number, placements: Placement[]): Candidate => {
		const text = signed(v);
		return { text, cls: valueCls(text), priority: 2, placements, value: v, span: [X(x0), X(x1)], stayOnSpan: true };
	};

	// Constant segments: every non-constant term is negligible over the
	// segment, sum |c_i| len^i <= zeroTol for i >= 1 (s runs from 0 to len).
	// Testing coefficients, not a few samples: a cubic M can take the same
	// value at both ends and in the middle and still bulge in between.
	const constant = segments.map((seg) => {
		const p = seg[field];
		if (!p) return false;
		const len = seg.x1 - seg.x0;
		let drift = 0;
		for (let i = 1; i < p.length; i++) drift += Math.abs(p[i] ?? 0) * Math.pow(len, i);
		return drift <= zeroTol;
	});

	// Runs of consecutive constant segments with the same value.
	for (let i = 0; i < segments.length; ) {
		const p = segments[i]?.[field];
		if (!constant[i] || !p) {
			i++;
			continue;
		}
		const v = polyEval(p, 0);
		let j = i;
		while (j + 1 < segments.length && constant[j + 1] === true && Math.abs(polyEval(segments[j + 1]?.[field] ?? [0], 0) - v) <= zeroTol) j++;
		const x0 = segments[i]?.x0 ?? 0;
		const x1 = segments[j]?.x1 ?? x0;
		i = j + 1;
		if (!meaningful(v)) continue;
		const covered = extremes.some((e) => e.x >= x0 - eps && e.x <= x1 + eps && Math.abs(e.value - v) <= zeroTol);
		if (covered) continue;
		const placements = [...near(x0, v, ['right'], false), ...near(x1, v, ['left'], false), ...near(0.5 * (x0 + x1), v, ['mid'], true)];
		out.push(candidate(v, x0, x1, placements));
	}

	const add = (v: number | undefined, x: number, sides: Side[]): void => {
		if (!meaningful(v)) return;
		out.push(candidate(v, x, x, near(x, v, sides, true)));
	};
	results.keyPoints.forEach((k, j) => {
		// Key point j ends segment j - 1 and starts segment j.
		const hasLeft = k > eps && j > 0;
		const hasRight = k < L - eps && j < segments.length;
		const left = hasLeft ? evaluateAt(segments, field, k, 'left') : undefined;
		const right = hasRight ? evaluateAt(segments, field, k, 'right') : undefined;
		const leftConstant = hasLeft && constant[j - 1] === true;
		const rightConstant = hasRight && constant[j] === true;
		if (left === undefined || right === undefined || Math.abs(left - right) <= zeroTol) {
			// No jump: a constant neighbour already labels this value.
			if (leftConstant || rightConstant) return;
			add(right ?? left, k, ['mid', 'left', 'right']);
		} else if (Math.abs(left - right) <= DUPLICATE_REL * maxAbs) {
			// A tiny jump: one label, unless a constant neighbour already shows
			// (nearly) this value.
			if (leftConstant || rightConstant) return;
			add(right, k, ['mid', 'left', 'right']);
		} else {
			if (!leftConstant) add(left, k, ['left']);
			if (!rightConstant) add(right, k, ['right']);
		}
	});
	return out;
}

/**
 * Liang-Barsky test: does the segment (x1, y1)-(x2, y2) touch the box?
 * The segment is P(t) = P1 + t·(P2 - P1), t in [0, 1]; each box edge cuts
 * the allowed t range from one side, and the segment hits the box when a
 * non-empty range is left.
 */
export function segmentHitsBox(seg: Segment2, box: Box): boolean {
	const [x1, y1, x2, y2] = seg;
	const dx = x2 - x1;
	const dy = y2 - y1;
	const p = [-dx, dx, -dy, dy];
	const q = [x1 - box.x0, box.x1 - x1, y1 - box.y0, box.y1 - y1];
	let t0 = 0;
	let t1 = 1;
	for (let i = 0; i < 4; i++) {
		const pi = p[i] ?? 0;
		const qi = q[i] ?? 0;
		if (pi === 0) {
			// Parallel to this edge: outside it means no hit at all.
			if (qi < 0) return false;
			continue;
		}
		const t = qi / pi;
		if (pi < 0) {
			if (t > t1) return false;
			t0 = Math.max(t0, t);
		} else {
			if (t < t0) return false;
			t1 = Math.min(t1, t);
		}
	}
	return true;
}

/**
 * Greedy collision avoidance: candidates are placed by priority (extremes,
 * then shear zeros and span peaks, then key-point values), each trying its
 * placements in order. A placement is free when it stays inside the drawing
 * below the title band, overlaps no label placed before, is not crossed by
 * the curve or the axis, and, for a key-point value (`stayOnSpan`), covers
 * no other key point of `keyXs` [px], where it would read as that point's
 * value. A label with no free placement is dropped, except required ones
 * (extremes), which take their first placement anyway: losing the peak value
 * would be worse than a tight fit.
 *
 * A value within `duplicateTol` (SI) of an accepted label's value, whose
 * curve span is within DUPLICATE_PX of that label's, is dropped as a repeat.
 */
function placeLabels(candidates: Candidate[], width: number, obstacles: readonly Segment2[], keyXs: readonly number[], duplicateTol: number): Prim[] {
	const sorted = candidates.map((c, i) => ({ c, i })).sort((a, b) => a.c.priority - b.c.priority || a.i - b.i);
	const accepted: PlacedText[] = [];
	const acceptedValues: { value: number; span: [number, number] }[] = [];
	const prims: Prim[] = [];
	/** Pixel gap between two spans (0 when they overlap). */
	const spanGap = (a: [number, number], b: [number, number]): number => Math.max(0, a[0] - b[1], b[0] - a[1]);
	const repeats = (c: Candidate): boolean =>
		c.value !== undefined &&
		c.span !== undefined &&
		acceptedValues.some((o) => Math.abs(o.value - (c.value ?? 0)) <= duplicateTol && spanGap(o.span, c.span ?? o.span) <= DUPLICATE_PX);
	const free = (c: Candidate, placed: PlacedText): boolean =>
		placed.box.y0 >= TITLE_BASELINE + TITLE_CLEARANCE &&
		placed.box.y1 <= HEIGHT &&
		!accepted.some((other) => boxesOverlap(placed.box, other.box, LABEL_GAP)) &&
		!obstacles.some((seg) => segmentHitsBox(seg, placed.box)) &&
		!(c.stayOnSpan && c.span && coversOtherKeyPoint(placed.box, c.span, keyXs));
	for (const { c } of sorted) {
		if (!c.required && repeats(c)) continue;
		const options = c.placements.map((p) => placeText(p.x, p.y, c.text, LAYOUT.smallFontSize, width, p.anchor));
		const chosen = options.find((o) => free(c, o)) ?? (c.required ? options[0] : undefined);
		if (!chosen) continue;
		accepted.push(chosen);
		if (c.value !== undefined && c.span) acceptedValues.push({ value: c.value, span: c.span });
		prims.push(textPrim(c.cls, chosen, c.text));
	}
	return prims;
}

/**
 * True when a key point outside `span` (by more than 1 px) lies inside the
 * box, more than 2 px from its edges: a label there sits over that point's
 * guide and reads as its value (the "+30.16" of x = 1.4 m drawn across the
 * x = 1.2 m guide).
 */
function coversOtherKeyPoint(box: Box, span: [number, number], keyXs: readonly number[]): boolean {
	return keyXs.some((kx) => (kx < span[0] - 1 || kx > span[1] + 1) && kx > box.x0 + 2 && kx < box.x1 - 2);
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

/** Screen reader summary of the extremes (and shear zeros) in words. */
function describeDiagram(
	results: BeamResults,
	quantity: DiagramQuantity,
	max: Extremum,
	min: Extremum,
	zeroTol: number,
	options: SceneOptions,
	decimals: number,
): string {
	const units = options.units;
	const dim = QUANTITIES[quantity].dimension;
	const q = (v: number): string => formatQuantity(v, dim, units, decimals);
	const at = (x: number): string => formatResultPosition(x, units, decimals);
	const meaningful = (e: Extremum): boolean => Math.abs(e.value) > zeroTol;

	if (quantity === 'shear') {
		let text = `Shear force ranges from ${q(min.value)} at x = ${at(min.x)} to ${q(max.value)} at x = ${at(max.x)}.`;
		if (results.shearZeros.length > 0) text += ` It changes sign at x = ${results.shearZeros.map(at).join(', ')}.`;
		return text;
	}
	if (quantity === 'moment') {
		const parts: string[] = [];
		if (meaningful(max) && max.value > 0) parts.push(`Largest sagging moment ${q(max.value)} at x = ${at(max.x)}.`);
		if (meaningful(min) && min.value < 0) parts.push(`Largest hogging moment ${q(-min.value)} at x = ${at(min.x)}.`);
		parts.push(
			options.momentConvention === 'tension-side'
				? 'Drawn on the tension side: sagging moments below the axis.'
				: 'Sagging moments are drawn above the axis.',
		);
		return parts.join(' ');
	}
	const parts: string[] = [];
	if (meaningful(min) && min.value < 0) parts.push(`Largest downward deflection ${q(-min.value)} at x = ${at(min.x)}.`);
	if (meaningful(max) && max.value > 0) parts.push(`Largest upward deflection ${q(max.value)} at x = ${at(max.x)}.`);
	return parts.join(' ');
}
