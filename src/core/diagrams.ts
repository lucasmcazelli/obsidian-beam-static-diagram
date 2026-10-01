/**
 * Sampling and extreme values of the piecewise solution.
 *
 * The solver returns exact polynomials per segment, so nothing here is an
 * approximation except the plotted samples: extremes come from the exact
 * stationary points (roots of the derivative), not from the samples.
 */
import { polyEval, polyRootsInInterval } from './polynomial';
import type { DiagramQuantity, DiagramSeries, Extrema, Extremum, Poly, Segment } from './types';

/**
 * Relative position tolerance (fraction of the beam length). Positions closer
 * than this are the same point: the solver merges key points with it and
 * evaluateAt uses it to recognise a key point.
 */
export const POSITION_TOL = 1e-9;

/** Values below this fraction of the quantity's scale are round-off and reported as exactly 0. */
const ZERO_TOL = 1e-12;

/** Two candidate extremes closer than this fraction of the scale are a tie: the first one is kept. */
const TIE_TOL = 1e-9;

/** Default number of samples per segment for plotting. */
const DEFAULT_POINTS_PER_SEGMENT = 24;

/** Polynomial fields of a segment that evaluateAt can read. */
export type SegmentField = 'q' | 'V' | 'M' | 'theta' | 'v';

/**
 * Samples a quantity for plotting. Each segment contributes `pointsPerSegment`
 * evenly spaced points including both ends, so a discontinuity between two
 * segments appears as two points with the same x (vertical step).
 * Values at round-off level (below 1e-12 of the diagram's scale) are written
 * as exactly 0 so labels never show "-0".
 * Throws for 'deflection' when the segments carry no deflection polynomials
 * (E and I were not given).
 */
export function sampleDiagram(segments: Segment[], quantity: DiagramQuantity, pointsPerSegment?: number): DiagramSeries {
	const field = fieldOf(quantity);
	const n =
		pointsPerSegment !== undefined && Number.isFinite(pointsPerSegment)
			? Math.max(2, Math.round(pointsPerSegment))
			: DEFAULT_POINTS_PER_SEGMENT;
	const zero = ZERO_TOL * fieldScale(segments, field);
	const xs: number[] = [];
	const ys: number[] = [];
	for (const seg of segments) {
		const p = polyOf(seg, field);
		const len = seg.x1 - seg.x0;
		for (let k = 0; k < n; k++) {
			const s = (len * k) / (n - 1);
			// Use x1 itself for the last sample so neighbouring segments share it exactly.
			xs.push(k === n - 1 ? seg.x1 : seg.x0 + s);
			ys.push(cleanZero(polyEval(p, s), zero));
		}
	}
	return { quantity, xs, ys };
}

/**
 * Exact extremes: V at segment ends (both sides) and where q = 0; M at segment
 * ends and at roots of V; deflection at segment ends and roots of theta.
 * `sectionModulus` (I / c) enables stressMax = max|M| / (I / c).
 *
 * Ties (values within 1e-9 of the scale) keep the first occurrence from the
 * left, so a symmetric beam reports the left of two equal peaks. Values at
 * round-off level are reported as exactly 0.
 */
export function computeExtrema(segments: Segment[], sectionModulus?: number): Extrema {
	if (segments.length === 0) throw new Error('computeExtrema: the solution has no segments');

	// V is extreme where dV/dx = q = 0, M where dM/dx = V = 0 (exact roots of
	// a line and a quadratic), deflection where theta = dv/dx = 0 (quartic).
	const shear = candidates(segments, 'V', 'q');
	const moment = candidates(segments, 'M', 'V');
	const shearPick = pickExtremes(shear, fieldScale(segments, 'V'));
	const momentPick = pickExtremes(moment, fieldScale(segments, 'M'));

	const out: Extrema = {
		shearMax: shearPick.max,
		shearMin: shearPick.min,
		momentMax: momentPick.max,
		momentMin: momentPick.min,
	};

	if (segments.every((seg) => seg.theta !== undefined && seg.v !== undefined)) {
		const defl = pickExtremes(candidates(segments, 'v', 'theta'), fieldScale(segments, 'v'));
		out.deflectionMax = defl.max;
		out.deflectionMin = defl.min;
	}

	if (sectionModulus !== undefined && Number.isFinite(sectionModulus) && sectionModulus > 0) {
		// sigma = |M|·c / I = |M| / (I / c), largest at the largest |M|.
		const peak = momentPick.absMax;
		out.stressMax = { value: peak.value / sectionModulus, x: peak.x };
	}
	return out;
}

/**
 * Positions where V changes sign, inside segments or by a jump across zero.
 *
 * Walks along the beam tracking the sign of V (values within 1e-12 of the
 * scale count as zero). A sign change is reported where V left the old sign:
 * at the root for a crossing inside a segment, at the key point for a jump
 * through zero. V touching zero and coming back (or staying at zero, like the
 * unloaded tip of a cantilever) is not a sign change.
 */
export function findShearZeros(segments: Segment[]): number[] {
	if (segments.length === 0) return [];
	const zero = ZERO_TOL * fieldScale(segments, 'V');
	const span = segments[segments.length - 1]!.x1 - segments[0]!.x0;
	const eps = POSITION_TOL * span;
	const sign = (v: number): number => (Math.abs(v) <= zero ? 0 : Math.sign(v));

	const zeros: number[] = [];
	let lastSign = 0;
	// Where V most recently became zero after having a sign (null if not at zero).
	let zeroSince: number | null = null;
	const visit = (x: number, sg: number): void => {
		if (sg === 0) {
			if (lastSign !== 0 && zeroSince === null) zeroSince = x;
			return;
		}
		if (lastSign !== 0 && sg !== lastSign) {
			const at = zeroSince ?? x;
			const prev = zeros[zeros.length - 1];
			if (prev === undefined || at - prev > eps) zeros.push(at);
		}
		lastSign = sg;
		zeroSince = null;
	};

	for (const seg of segments) {
		const len = seg.x1 - seg.x0;
		// Visit the start (right limit), then alternate: the sign between two
		// roots (sampled at the midpoint) and the root itself, then the end.
		visit(seg.x0, sign(polyEval(seg.V, 0)));
		const roots = polyRootsInInterval(seg.V, 0, len).filter((r) => r > eps && r < len - eps);
		let prevS = 0;
		for (const r of roots) {
			visit(seg.x0 + 0.5 * (prevS + r), sign(polyEval(seg.V, 0.5 * (prevS + r))));
			visit(seg.x0 + r, 0);
			prevS = r;
		}
		visit(seg.x0 + 0.5 * (prevS + len), sign(polyEval(seg.V, 0.5 * (prevS + len))));
		visit(seg.x1, sign(polyEval(seg.V, len)));
	}
	return zeros;
}

/**
 * Evaluates a quantity at x. `side` picks the segment on the left or right of
 * a key point: 'left' gives the left limit (segment ending there), 'right'
 * (default) the right limit (segment starting there). Positions within
 * 1e-9·L of a key point count as that key point. x is clamped to the beam, so
 * x = 0 always reads the first segment and x = L the last one.
 * Throws for 'theta' or 'v' when deflection is not available.
 */
export function evaluateAt(segments: Segment[], quantity: SegmentField, x: number, side: 'left' | 'right' = 'right'): number {
	const first = segments[0];
	const last = segments[segments.length - 1];
	if (first === undefined || last === undefined) throw new Error('evaluateAt: the solution has no segments');
	const eps = POSITION_TOL * (last.x1 - first.x0);

	if (x <= first.x0 + eps) return polyEval(polyOf(first, quantity), 0);
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const len = seg.x1 - seg.x0;
		if (Math.abs(x - seg.x1) <= eps) {
			// At the key point that ends this segment: choose the side.
			const next = segments[i + 1];
			if (side === 'left' || next === undefined) return polyEval(polyOf(seg, quantity), len);
			return polyEval(polyOf(next, quantity), 0);
		}
		if (x < seg.x1) return polyEval(polyOf(seg, quantity), Math.max(0, x - seg.x0));
	}
	return polyEval(polyOf(last, quantity), last.x1 - last.x0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Segment field plotted for each diagram quantity. */
function fieldOf(quantity: DiagramQuantity): SegmentField {
	switch (quantity) {
		case 'shear':
			return 'V';
		case 'moment':
			return 'M';
		case 'deflection':
			return 'v';
	}
}

/** The polynomial of one field, with a clear error when deflection is missing. */
function polyOf(seg: Segment, field: SegmentField): Poly {
	const p = seg[field];
	if (p === undefined) {
		throw new Error('Deflection is not available: give E and I, or a material and a section');
	}
	return p;
}

/** Largest |value| of a field over all segment ends (both sides), 0 if the field is missing. */
function maxAbsAtEnds(segments: Segment[], field: SegmentField): number {
	let m = 0;
	for (const seg of segments) {
		const p = seg[field];
		if (p === undefined) return 0;
		m = Math.max(m, Math.abs(polyEval(p, 0)), Math.abs(polyEval(p, seg.x1 - seg.x0)));
	}
	return m;
}

/**
 * Magnitude used to decide what counts as zero for a field. It mixes related
 * quantities (V with M/L and q·L, M with V·L and q·L², v with theta·L) so a
 * diagram that is zero up to round-off (for example V under a pure end
 * couple, about 1e-15) is still recognised as zero.
 */
function fieldScale(segments: Segment[], field: SegmentField): number {
	const span = segments.length > 0 ? segments[segments.length - 1]!.x1 - segments[0]!.x0 : 0;
	const force = Math.max(
		maxAbsAtEnds(segments, 'V'),
		span > 0 ? maxAbsAtEnds(segments, 'M') / span : 0,
		maxAbsAtEnds(segments, 'q') * span,
	);
	switch (field) {
		case 'q':
			return span > 0 ? force / span : 0;
		case 'V':
			return force;
		case 'M':
			return force * span;
		case 'theta':
		case 'v': {
			const v = Math.max(maxAbsAtEnds(segments, 'v'), maxAbsAtEnds(segments, 'theta') * span);
			return field === 'v' ? v : span > 0 ? v / span : 0;
		}
	}
}

/** Replaces round-off sized values (and -0) with exactly 0. */
function cleanZero(value: number, zero: number): number {
	return Math.abs(value) <= zero ? 0 : value;
}

/**
 * Candidate extreme points of `field`, in order along the beam: both ends of
 * every segment and the roots of `derivative` inside it.
 */
function candidates(segments: Segment[], field: SegmentField, derivative: SegmentField): Extremum[] {
	const out: Extremum[] = [];
	for (const seg of segments) {
		const p = polyOf(seg, field);
		const dp = polyOf(seg, derivative);
		const len = seg.x1 - seg.x0;
		out.push({ value: polyEval(p, 0), x: seg.x0 });
		for (const r of polyRootsInInterval(dp, 0, len)) {
			if (r > 0 && r < len) out.push({ value: polyEval(p, r), x: seg.x0 + r });
		}
		out.push({ value: polyEval(p, len), x: seg.x1 });
	}
	return out;
}

/** Largest, smallest and largest-magnitude candidates, first occurrence winning ties. */
function pickExtremes(list: Extremum[], scale: number): { max: Extremum; min: Extremum; absMax: Extremum } {
	const zero = ZERO_TOL * scale;
	const tie = TIE_TOL * scale;
	const clean = list.map((c) => ({ value: cleanZero(c.value, zero), x: c.x }));
	let max = clean[0]!;
	let min = clean[0]!;
	let absMax = clean[0]!;
	for (const c of clean) {
		// Strictly better by more than the tie tolerance, otherwise keep the earlier point.
		if (c.value > max.value + tie) max = c;
		if (c.value < min.value - tie) min = c;
		if (Math.abs(c.value) > Math.abs(absMax.value) + tie) absMax = c;
	}
	return { max: { ...max }, min: { ...min }, absMax: { value: Math.abs(absMax.value), x: absMax.x } };
}
