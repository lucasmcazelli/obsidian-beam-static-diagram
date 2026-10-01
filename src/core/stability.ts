/**
 * Kinematic stability and static determinacy of the support layout.
 *
 * Counting rules (reactions - 2 - hinges) are not enough: "pin at 0, rollers
 * at 2 and 4, hinge at 5" on a 6 m beam counts as determinate but the part
 * right of the hinge can swing freely. So instead we look at the rigid-body
 * motions directly:
 *
 * - Hinges split the beam into parts. With no bending deformation each part k
 *   can only translate and rotate: v_k(x) = v0_k + th_k·(x/L), two degrees
 *   of freedom per part. Dividing by L keeps every matrix entry in [-1, 1]
 *   whatever the beam length, so a fixed tolerance is meaningful.
 * - Every support and hinge forbids some of these motions (one row each).
 * - The beam is stable when the only allowed motion is zero, i.e. the
 *   constraint matrix has full column rank 2·parts. Extra rows beyond that
 *   are redundant restraints: their number is the degree of indeterminacy.
 */
import { matrixRank } from './linalg';
import { POSITION_TOL } from './tolerances';
import type { BeamModel, Classification } from './types';

// POSITION_TOL (tolerances.ts, a fraction of L) matches supports with hinges,
// the same tolerance the solver uses to merge key points.

/** Absolute rank tolerance: matrix entries are 0, ±1 or ±x/L, all of order 1. */
const RANK_TOL = 1e-9;

/**
 * Treats each hinge-separated part as a rigid body with two degrees of
 * freedom (vertical translation and rotation). Supports and hinges add
 * constraint rows. Stable when rank = 2 × parts; degree = rows - 2 × parts.
 * Independent of loads and of EI.
 *
 * Rows:
 * - pin or roller at x: v_k(x) = 0 for the part k containing x;
 * - fixed at x: additionally th_k = 0;
 * - hinge at xh between parts k and k+1: v_k(xh) - v_{k+1}(xh) = 0.
 * A support exactly at a hinge belongs to the part on its LEFT; the hinge row
 * then also pins the right part there. A fixed support at a hinge clamps both
 * sides (it adds a rotation row for each part), matching the solver, which
 * restrains both rotations of a hinge node.
 */
export function classifyBeam(model: Pick<BeamModel, 'length' | 'supports' | 'hinges'>): Classification {
	const L = model.length;
	const eps = POSITION_TOL * L;
	// Hinges strictly inside the beam, sorted and without near-duplicates.
	const hinges: number[] = [];
	for (const h of [...model.hinges].sort((a, b) => a - b)) {
		const last = hinges[hinges.length - 1];
		if (h > eps && h < L - eps && (last === undefined || h - last > eps)) hinges.push(h);
	}
	const parts = hinges.length + 1;
	const cols = 2 * parts;

	// Part index of position x: the number of hinges strictly to its left, so a
	// support sitting on a hinge (within tolerance) goes to the left part.
	const partOf = (x: number): number => {
		let k = 0;
		while (k < hinges.length && x > hinges[k]! + eps) k++;
		return k;
	};
	const isAtHinge = (x: number, k: number): boolean => k < hinges.length && Math.abs(x - hinges[k]!) <= eps;
	const newRow = (): number[] => new Array<number>(cols).fill(0);

	const rows: number[][] = [];
	for (const s of model.supports) {
		const k = partOf(s.x);
		// v_k(x) = v0_k + th_k·(x/L) = 0
		const r = newRow();
		r[2 * k] = 1;
		r[2 * k + 1] = s.x / L;
		rows.push(r);
		if (s.kind === 'fixed') {
			const rot = newRow();
			rot[2 * k + 1] = 1;
			rows.push(rot);
			if (isAtHinge(s.x, k)) {
				// Clamp on a hinge: the right part cannot rotate either.
				const rotRight = newRow();
				rotRight[2 * (k + 1) + 1] = 1;
				rows.push(rotRight);
			}
		}
	}
	hinges.forEach((xh, i) => {
		// Both parts meet at the hinge: v_i(xh) - v_{i+1}(xh) = 0.
		const r = newRow();
		r[2 * i] = 1;
		r[2 * i + 1] = xh / L;
		r[2 * (i + 1)] = -1;
		r[2 * (i + 1) + 1] = -xh / L;
		rows.push(r);
	});

	const rank = rows.length > 0 ? matrixRank(rows, RANK_TOL) : 0;
	const stable = rank === cols;
	return { stable, degree: stable ? rows.length - cols : null };
}
