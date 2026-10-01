/**
 * Sampling and extreme values of the piecewise solution.
 * STUB: to be implemented.
 */
import type { DiagramQuantity, DiagramSeries, Extrema, Segment } from './types';

/**
 * Samples a quantity for plotting. Each segment contributes `pointsPerSegment`
 * evenly spaced points including both ends, so a discontinuity between two
 * segments appears as two points with the same x (vertical step).
 */
export function sampleDiagram(segments: Segment[], quantity: DiagramQuantity, pointsPerSegment?: number): DiagramSeries {
	throw new Error('not implemented');
}

/**
 * Exact extremes: V at segment ends (both sides) and where q = 0; M at segment
 * ends and at roots of V; deflection at segment ends and roots of theta.
 * `sectionModulus` (I / c) enables stressMax.
 */
export function computeExtrema(segments: Segment[], sectionModulus?: number): Extrema {
	throw new Error('not implemented');
}

/** Positions where V changes sign, inside segments or by a jump across zero. */
export function findShearZeros(segments: Segment[]): number[] {
	throw new Error('not implemented');
}

/** Evaluates a quantity at x. `side` picks the segment on the left or right of a key point. */
export function evaluateAt(segments: Segment[], quantity: 'q' | 'V' | 'M' | 'theta' | 'v', x: number, side?: 'left' | 'right'): number {
	throw new Error('not implemented');
}
