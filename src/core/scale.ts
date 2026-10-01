/**
 * Force scale of a beam: the size of "a typical force" used to turn absolute
 * round-off into relative tolerances (is this reaction zero? is this
 * residual acceptable? how long should this load arrow be?).
 *
 * It lives in its own module, with no imports besides types, so the
 * renderers can use it without depending on the parser, the model builder
 * and the solver through the analysis pipeline.
 */
import type { BeamModel, Reaction } from './types';

/**
 * Area under |q| for a load varying linearly from q1 to q2 over `length`.
 * Same signs: trapezoid (|q1| + |q2|)/2·length. Opposite signs: the line
 * crosses zero at t = |q1| / (|q1| + |q2|) of the length, giving two
 * triangles whose areas add up to (q1² + q2²) / (2(|q1| + |q2|))·length.
 */
export function absoluteArea(q1: number, q2: number, length: number): number {
	const a = Math.abs(q1);
	const b = Math.abs(q2);
	if (q1 * q2 >= 0) return 0.5 * (a + b) * length;
	return ((a * a + b * b) / (2 * (a + b))) * length;
}

/**
 * Force scale [N] of a beam: sum of |point loads|, |couples| / L, the
 * absolute area under every distributed load and, when given, |reactions|
 * (fy plus mz / L). Zero for a beam without loads, and zero (not Infinity
 * or NaN) when the sum overflows, so callers can fall back safely.
 */
export function forceScale(model: BeamModel, reactions: readonly Reaction[] = []): number {
	const L = model.length;
	let total = 0;
	for (const load of model.loads) {
		if (load.kind === 'point') total += Math.abs(load.fy);
		else if (load.kind === 'moment') total += L > 0 ? Math.abs(load.mz) / L : 0;
		else total += absoluteArea(load.q1, load.q2, Math.abs(load.x2 - load.x1));
	}
	for (const r of reactions) total += Math.abs(r.fy) + (L > 0 ? Math.abs(r.mz) / L : 0);
	return Number.isFinite(total) ? total : 0;
}
