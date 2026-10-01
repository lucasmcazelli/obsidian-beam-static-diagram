/**
 * Beam solver: direct stiffness method for the unknowns, then exact
 * piecewise polynomials for V, M, slope and deflection.
 *
 * Why our own engine: zero dependencies and a few KB minified, mechanisms
 * are detected explicitly (stability.ts) instead of surfacing as a singular
 * matrix, and every step below can be checked against a hand calculation
 * (tests/solver.benchmarks.test.ts compares the results with closed forms).
 *
 * Steps (straight, prismatic Euler-Bernoulli beam):
 * 1. Prepare: merge positions closer than 1e-9·L into "key points" so that
 *    near-coincident items never create zero-length pieces.
 * 2. Classify the support layout (stability.ts). Mechanisms are rejected
 *    before any matrix is built.
 * 3. Direct stiffness method (DSM) with 2 DOFs per node [v, theta], nodes
 *    only at the ends, supports and hinges. Loads between nodes enter as
 *    consistent nodal loads, which makes the nodal results exact for cubic
 *    Hermite elements. Reactions follow from R = K·u - F.
 * 4. With the reactions known the beam is statically determinate, so V and M
 *    come from a statics sweep (method of sections) as exact polynomials.
 * 5. When E and I are known, slope and deflection are obtained by
 *    integrating M / EI along the beam from the DSM values at x = 0. They
 *    are withheld (hasDeflection false) if they overflow double precision.
 *
 * Sign convention: see types.ts (forces and q up, couples counter-clockwise,
 * M sagging positive, v up, theta counter-clockwise).
 */
import { computeExtrema, findShearZeros } from './diagrams';
import { SingularMatrixError, solveLinearSystem } from './linalg';
import { polyEval, polyIntegrate, polyScale } from './polynomial';
import { classifyBeam } from './stability';
import { POSITION_TOL, RESIDUAL_TOL } from './tolerances';
import { BeamAnalysisError } from './types';
import type { BeamModel, BeamResults, Poly, Reaction, Segment, SupportKind } from './types';

/**
 * Message shown when the support layout allows rigid-body motion. It is the
 * only copy: analyzeBeam passes the BeamAnalysisError message through.
 */
export const UNSTABLE_MESSAGE = 'The beam is unstable: it can move as a mechanism. Add a support or remove a hinge';

/** Message shown when the geometry is too extreme for an accurate solution. */
const TOO_CLOSE_MESSAGE =
	'The beam could not be solved accurately: some supports or hinges are too close together. Move them apart or put them at the same position';

/**
 * Reaction forces below this fraction of the total applied load, and
 * reaction couples below this fraction of the load times L, are round-off
 * and set to exactly 0.
 */
const REACTION_ZERO_TOL = 1e-12;

/**
 * Largest slope [rad] or deflection [m] magnitude the solver returns. It is
 * far below Number.MAX_VALUE (about 1.8e308) so that later steps (unit
 * conversion, where m to mm is ×1000, root finding on derivatives, chart
 * scaling) cannot overflow either. Only an absurd E·I gets near it (about
 * 1e-295 N·m² for a 10 kN load on a 6 m span; no unit mistake comes close).
 */
const MAX_DEFLECTION_MAGNITUDE = 1e300;

// RESIDUAL_TOL (tolerances.ts) is the largest accepted equilibrium residual,
// as a fraction of the total load plus reactions. Healthy beams stay near
// 1e-15; only extreme geometry (a hinge a few micrometres from a support,
// where an element is so short that its shear is lost in round-off) gets
// close to it, and then we refuse to answer rather than show wrong numbers.

/** 3-point Gauss-Legendre rule on [-1, 1]: exact for polynomials up to degree 5. */
const GAUSS_POINTS = [-Math.sqrt(3 / 5), 0, Math.sqrt(3 / 5)];
const GAUSS_WEIGHTS = [5 / 9, 8 / 9, 5 / 9];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Solves a validated model. Throws BeamAnalysisError (from ./types) when the
 * beam is a mechanism. When E or I is missing, reactions, V and M are still
 * exact (prismatic beam) and `hasDeflection` is false. `hasDeflection` is
 * also false when E and I are given but out of double-precision range (E·I
 * itself overflows, or it is so small that the deflection would); the
 * caller can tell the two cases apart by checking model.E and model.I.
 */
export function solveBeam(model: BeamModel): BeamResults {
	const beam = prepare(model);
	const classification = classifyBeam(classificationInput(beam));
	if (!classification.stable) throw new BeamAnalysisError(UNSTABLE_MESSAGE);

	const dsm = runStiffness(beam);
	const reactions = collectReactions(beam, dsm);
	const residual = equilibriumResidual(beam, reactions);
	checkResidual(beam, reactions, residual);
	const segments = buildSegments(beam, reactions);

	const EI = bendingStiffness(model);
	// False without a usable E·I, and also when E·I is so small that the
	// deflection overflows: the forces are still right, only theta and v are
	// withheld (see integrateDeflection).
	const hasDeflection = EI !== undefined && integrateDeflection(beam, dsm, segments, EI);

	// Bending stress needs the section's extreme fibre distance c; I is the
	// value used for the analysis (an explicit `I` overrides the section).
	const sectionI = model.I ?? model.section?.I;
	const c = model.section?.c;
	const sectionModulus = sectionI !== undefined && c !== undefined && c > 0 ? sectionI / c : undefined;

	return {
		model,
		classification,
		reactions,
		segments,
		keyPoints: beam.keys.slice(),
		extrema: computeExtrema(segments, sectionModulus),
		shearZeros: findShearZeros(segments),
		residual,
		hasDeflection,
	};
}

/**
 * Structural node values of the stiffness solution, scaled by EI because the
 * system is always solved with EI = 1 (divide by the real EI to get metres
 * and radians). Exposed for cross-checks in tests and for debugging.
 */
export interface NodalSolution {
	/** Node positions [m]: beam ends, supports and hinges. */
	x: number[];
	/** EI × deflection at each node [N·m³]. */
	vEI: number[];
	/** EI × rotation of the element ending at each node [N·m²] (the node rotation at x = 0). */
	thetaLeftEI: number[];
	/** EI × rotation of the element starting at each node; differs from thetaLeftEI only at hinges. */
	thetaRightEI: number[];
}

/** Runs only the stiffness step (after the same stability check as solveBeam). */
export function computeNodalSolution(model: BeamModel): NodalSolution {
	const beam = prepare(model);
	if (!classifyBeam(classificationInput(beam)).stable) throw new BeamAnalysisError(UNSTABLE_MESSAGE);
	const dsm = runStiffness(beam);
	return {
		x: dsm.nodeKeys.map((k) => beam.keys[k]!),
		vEI: dsm.vDof.map((d) => dsm.u[d]!),
		thetaLeftEI: dsm.thL.map((d) => dsm.u[d]!),
		thetaRightEI: dsm.thR.map((d) => dsm.u[d]!),
	};
}

// ---------------------------------------------------------------------------
// 1. Preparation: key points and snapped loads
// ---------------------------------------------------------------------------

/** A support mapped to its key point. */
interface PreparedSupport {
	/** Index into BeamModel.supports. */
	index: number;
	kind: SupportKind;
	/** Position as given in the model (reported back in the reaction). */
	x: number;
	/** Key point index. */
	k: number;
}

/** A concentrated force or couple mapped to its key point. */
interface PreparedPointItem {
	k: number;
	/** fy [N] for forces, mz [N·m] for couples. */
	value: number;
}

/** A linearly varying load whose ends are snapped to key points. */
interface PreparedDistributed {
	k1: number;
	k2: number;
	x1: number;
	x2: number;
	q1: number;
	q2: number;
}

/** The model with every position snapped to a key point (all lists may be empty). */
interface PreparedBeam {
	L: number;
	/** Sorted distinct key points, keys[0] = 0 and keys[last] = L exactly. */
	keys: number[];
	/** Key indices of internal hinges. */
	hingeKeys: Set<number>;
	supports: PreparedSupport[];
	forces: PreparedPointItem[];
	couples: PreparedPointItem[];
	distributed: PreparedDistributed[];
}

/**
 * Validates positions, merges positions closer than POSITION_TOL·L and maps
 * every item onto the resulting key points. Ends, supports and hinges are
 * placed first so they keep their exact coordinates; load positions then
 * snap onto them when they are (numerically) at the same place.
 */
function prepare(model: BeamModel): PreparedBeam {
	const L = model.length;
	if (!(Number.isFinite(L) && L > 0)) {
		throw new BeamAnalysisError('The beam length must be a positive number, for example: length 6 m');
	}
	const eps = POSITION_TOL * L;
	const place = (x: number): number => {
		if (!Number.isFinite(x) || x < -eps || x > L + eps) {
			throw new BeamAnalysisError('A support, hinge or load lies outside the beam: place it between the start and the end');
		}
		// Snap to the exact ends so that 0 and L stay exact key points.
		return x <= eps ? 0 : x >= L - eps ? L : x;
	};
	const finite = (v: number): number => {
		if (!Number.isFinite(v)) throw new BeamAnalysisError('A load value is not a finite number: check the load magnitudes');
		return v;
	};

	// Structural positions: clusters keep their first (smallest) member.
	const structural = [0, L, ...model.supports.map((s) => place(s.x)), ...model.hinges.map(place)].sort((a, b) => a - b);
	const keys: number[] = [];
	for (const x of structural) {
		const last = keys[keys.length - 1];
		if (last === undefined || x - last > eps) keys.push(x);
	}

	// Load positions join an existing key point when within eps of it.
	const loadXs: number[] = [];
	for (const load of model.loads) {
		if (load.kind === 'distributed') loadXs.push(place(load.x1), place(load.x2));
		else loadXs.push(place(load.x));
	}
	for (const x of loadXs.sort((a, b) => a - b)) {
		if (!keys.some((k) => Math.abs(k - x) <= eps)) keys.push(x);
	}
	keys.sort((a, b) => a - b);

	// Index of the key point a (placed) position was merged into.
	const keyOf = (x: number): number => {
		const px = place(x);
		let best = 0;
		for (let i = 1; i < keys.length; i++) {
			if (Math.abs(keys[i]! - px) < Math.abs(keys[best]! - px)) best = i;
		}
		return best;
	};

	const lastKey = keys.length - 1;
	const hingeKeys = new Set<number>();
	for (const h of model.hinges) {
		const k = keyOf(h);
		// A hinge merged into an end would release nothing: ignore it.
		if (k > 0 && k < lastKey) hingeKeys.add(k);
	}

	const supports = model.supports.map((s, index) => ({ index, kind: s.kind, x: s.x, k: keyOf(s.x) }));
	const forces: PreparedPointItem[] = [];
	const couples: PreparedPointItem[] = [];
	const distributed: PreparedDistributed[] = [];
	for (const load of model.loads) {
		if (load.kind === 'point') {
			forces.push({ k: keyOf(load.x), value: finite(load.fy) });
		} else if (load.kind === 'moment') {
			couples.push({ k: keyOf(load.x), value: finite(load.mz) });
		} else {
			const a = keyOf(Math.min(load.x1, load.x2));
			const b = keyOf(Math.max(load.x1, load.x2));
			// Keep q1 at the left end even if the ends were given in reverse.
			const [q1, q2] = load.x1 <= load.x2 ? [load.q1, load.q2] : [load.q2, load.q1];
			// Shorter than the merge tolerance: no length, no resultant.
			if (b <= a) continue;
			distributed.push({ k1: a, k2: b, x1: keys[a]!, x2: keys[b]!, q1: finite(q1), q2: finite(q2) });
		}
	}
	return { L, keys, hingeKeys, supports, forces, couples, distributed };
}

/** The prepared layout in the shape classifyBeam expects (snapped positions). */
function classificationInput(beam: PreparedBeam): Pick<BeamModel, 'length' | 'supports' | 'hinges'> {
	return {
		length: beam.L,
		supports: beam.supports.map((s) => ({ kind: s.kind, x: beam.keys[s.k]! })),
		hinges: [...beam.hingeKeys].sort((a, b) => a - b).map((k) => beam.keys[k]!),
	};
}

/** EI [N·m²] when both E and I are usable, otherwise undefined (no deflection). */
function bendingStiffness(model: BeamModel): number | undefined {
	const { E, I } = model;
	if (E === undefined || I === undefined) return undefined;
	const EI = E * I;
	return Number.isFinite(EI) && EI > 0 ? EI : undefined;
}

// ---------------------------------------------------------------------------
// 3. Direct stiffness method
// ---------------------------------------------------------------------------

/** Assembled and solved stiffness system (EI = 1). */
interface StiffnessResult {
	/** Key indices of the structural nodes, ascending. */
	nodeKeys: number[];
	/** DOF index of each node's deflection. */
	vDof: number[];
	/** DOF index of the rotation seen by the element ending at the node. */
	thL: number[];
	/** DOF index of the rotation seen by the element starting at the node (= thL except at hinges). */
	thR: number[];
	/** Global stiffness matrix and consistent load vector. */
	K: number[][];
	F: number[];
	/** Displacements times EI (restrained DOFs are 0). */
	u: number[];
}

/**
 * Hermite cubic shape functions of a beam element of length Le at local
 * position a (xi = a/Le): v(a) = N1·v1 + N2·th1 + N3·v2 + N4·th2.
 */
function hermite(a: number, Le: number): [number, number, number, number] {
	const xi = a / Le;
	const xi2 = xi * xi;
	const xi3 = xi2 * xi;
	return [1 - 3 * xi2 + 2 * xi3, Le * (xi - 2 * xi2 + xi3), 3 * xi2 - 2 * xi3, Le * (xi3 - xi2)];
}

/** Derivatives dN_i/da of the Hermite shape functions (rotation interpolation). */
function hermiteSlope(a: number, Le: number): [number, number, number, number] {
	const xi = a / Le;
	const xi2 = xi * xi;
	return [(-6 * xi + 6 * xi2) / Le, 1 - 4 * xi + 3 * xi2, (6 * xi - 6 * xi2) / Le, 3 * xi2 - 2 * xi];
}

/**
 * Euler-Bernoulli element stiffness for DOFs [v1, th1, v2, th2] with EI = 1:
 *   (1/Le³)·[[ 12,   6Le,  -12,   6Le ],
 *            [ 6Le,  4Le², -6Le,  2Le² ],
 *            [-12,  -6Le,   12,  -6Le ],
 *            [ 6Le,  2Le², -6Le,  4Le² ]]
 */
function elementStiffness(Le: number): number[][] {
	const c = 1 / (Le * Le * Le);
	const t = 12 * c; // translation terms
	const tr = 6 * Le * c; // translation-rotation coupling
	const rNear = 4 * Le * Le * c; // rotation, same end
	const rFar = 2 * Le * Le * c; // rotation, opposite end (carry-over)
	return [
		[t, tr, -t, tr],
		[tr, rNear, -tr, rFar],
		[-t, -tr, t, -tr],
		[tr, rFar, -tr, rNear],
	];
}

/**
 * Builds and solves K·u = F with EI = 1.
 *
 * For a prismatic beam without springs or settlements the reactions, V and M
 * do not depend on EI, and displacements scale exactly with 1/EI, so solving
 * once with EI = 1 serves both the force results and (after dividing by the
 * real EI) the deflection.
 *
 * Nodes sit only at the ends, supports and hinges, never at load points:
 * a load very close to a support would otherwise create a tiny, badly
 * conditioned element. At a hinge node the rotation is split in two DOFs
 * (thL for the element on the left, thR for the one on the right), which is
 * exactly a moment release.
 */
function runStiffness(beam: PreparedBeam): StiffnessResult {
	const { keys } = beam;
	const lastKey = keys.length - 1;
	const nodeSet = new Set<number>([0, lastKey, ...beam.hingeKeys, ...beam.supports.map((s) => s.k)]);
	const nodeKeys = [...nodeSet].sort((a, b) => a - b);
	const nodeOfKey = new Map<number, number>(nodeKeys.map((k, i) => [k, i]));

	// DOF numbering.
	let ndof = 0;
	const vDof: number[] = [];
	const thL: number[] = [];
	const thR: number[] = [];
	for (const k of nodeKeys) {
		vDof.push(ndof++);
		const left = ndof++;
		thL.push(left);
		thR.push(beam.hingeKeys.has(k) ? ndof++ : left);
	}

	const K = Array.from({ length: ndof }, () => new Array<number>(ndof).fill(0));
	const F = new Array<number>(ndof).fill(0);

	const elementCount = nodeKeys.length - 1;
	const elementDofs = (e: number): number[] => [vDof[e]!, thR[e]!, vDof[e + 1]!, thL[e + 1]!];
	const addLoads = (e: number, f: readonly number[]): void => {
		elementDofs(e).forEach((d, i) => {
			F[d]! += f[i]!;
		});
	};
	// Element holding a point item at key k: the one starting at or before k,
	// so an item on a node goes to the element on its right (the last element
	// for x = L). Each point item is therefore applied exactly once.
	const elementOfKey = (k: number): number => {
		let e = 0;
		while (e < elementCount - 1 && nodeKeys[e + 1]! <= k) e++;
		return e;
	};

	for (let e = 0; e < elementCount; e++) {
		const xa = keys[nodeKeys[e]!]!;
		const Le = keys[nodeKeys[e + 1]!]! - xa;
		const ke = elementStiffness(Le);
		const dofs = elementDofs(e);
		for (let i = 0; i < 4; i++) {
			const row = K[dofs[i]!]!;
			for (let j = 0; j < 4; j++) row[dofs[j]!]! += ke[i]![j]!;
		}

		// Consistent loads of distributed loads overlapping this element:
		// f_i = integral of N_i(x)·q(x) over the overlap. N_i is cubic and q
		// linear, so the degree-4 integrand is integrated exactly by 3-point
		// Gauss-Legendre (exact up to degree 5). A load end inside the element
		// is fine: the overlap is where q is a single straight line.
		const xb = xa + Le;
		for (const d of beam.distributed) {
			const lo = Math.max(xa, d.x1);
			const hi = Math.min(xb, d.x2);
			if (!(hi > lo)) continue;
			const slope = (d.q2 - d.q1) / (d.x2 - d.x1);
			const half = 0.5 * (hi - lo);
			const f = [0, 0, 0, 0];
			for (let g = 0; g < 3; g++) {
				const x = lo + half * (1 + GAUSS_POINTS[g]!);
				const q = d.q1 + slope * (x - d.x1);
				const N = hermite(x - xa, Le);
				for (let i = 0; i < 4; i++) f[i]! += GAUSS_WEIGHTS[g]! * half * q * N[i]!;
			}
			addLoads(e, f);
		}
	}

	// Point force P at local a: f = P·N(a), i.e.
	// P·[b²(3a+b)/Le³, a·b²/Le², a²(a+3b)/Le³, -a²·b/Le²] with b = Le - a.
	for (const p of beam.forces) {
		const e = elementOfKey(p.k);
		const xa = keys[nodeKeys[e]!]!;
		const Le = keys[nodeKeys[e + 1]!]! - xa;
		addLoads(e, hermite(keys[p.k]! - xa, Le).map((n) => p.value * n));
	}
	// Couple C (CCW) at local a does work C·theta(a), so f = C·N'(a), i.e.
	// C·[-6ab/Le³, b(b-2a)/Le², 6ab/Le³, a(a-2b)/Le²]. A couple on a hinge
	// node (the model forbids it) would act on the part to the right.
	for (const c of beam.couples) {
		const e = elementOfKey(c.k);
		const xa = keys[nodeKeys[e]!]!;
		const Le = keys[nodeKeys[e + 1]!]! - xa;
		addLoads(e, hermiteSlope(keys[c.k]! - xa, Le).map((n) => c.value * n));
	}

	// Restraints: pin and roller fix v; fixed also fixes the rotation(s).
	const restrained = new Set<number>();
	for (const s of beam.supports) {
		const n = nodeOfKey.get(s.k)!;
		restrained.add(vDof[n]!);
		if (s.kind === 'fixed') {
			// On a hinge node a clamp holds both sides (see classifyBeam).
			restrained.add(thL[n]!);
			restrained.add(thR[n]!);
		}
	}

	const free: number[] = [];
	for (let d = 0; d < ndof; d++) if (!restrained.has(d)) free.push(d);
	const Kff = free.map((i) => free.map((j) => K[i]![j]!));
	const Ff = free.map((i) => F[i]!);
	let uf: number[];
	try {
		uf = solveLinearSystem(Kff, Ff);
	} catch (err) {
		// classifyBeam already rejected mechanisms, so this means extreme
		// geometry (for example two supports almost on top of each other).
		if (err instanceof SingularMatrixError) {
			throw new BeamAnalysisError(TOO_CLOSE_MESSAGE);
		}
		throw err;
	}
	const u = new Array<number>(ndof).fill(0);
	free.forEach((d, i) => {
		u[d] = uf[i]!;
	});
	return { nodeKeys, vDof, thL, thR, K, F, u };
}

/**
 * Support reactions R_d = sum_j K[d][j]·u[j] - F[d] on the restrained DOFs
 * (the force the support must add so that K·u = F + R holds). A fixed
 * support's couple is the sum over its rotation DOF(s).
 *
 * When two supports share a node (closer than the merge tolerance) the
 * split between them is statically indeterminate; the whole reaction is
 * reported on the first one and 0 on the other.
 * Reactions at round-off level become 0: forces below 1e-12 of the total
 * load, couples below 1e-12 of the total load times L (the same force-to-
 * couple scaling as checkResidual, so the threshold keeps its meaning on
 * long beams, where the round-off in a couple grows with L).
 */
function collectReactions(beam: PreparedBeam, dsm: StiffnessResult): Reaction[] {
	const { K, F, u } = dsm;
	const restraintForce = (d: number): number => {
		const row = K[d]!;
		let s = -F[d]!;
		for (let j = 0; j < row.length; j++) s += row[j]! * u[j]!;
		return s;
	};
	const zeroForce = REACTION_ZERO_TOL * totalLoad(beam);
	const zeroCouple = zeroForce * beam.L;
	const clean = (v: number, zero: number): number => (Math.abs(v) <= zero ? 0 : v);

	const forceTaken = new Set<number>();
	const coupleTaken = new Set<number>();
	const nodeOfKey = new Map<number, number>(dsm.nodeKeys.map((k, i) => [k, i]));
	return beam.supports.map((s) => {
		const n = nodeOfKey.get(s.k)!;
		let fy = 0;
		let mz = 0;
		if (!forceTaken.has(n)) {
			forceTaken.add(n);
			fy = restraintForce(dsm.vDof[n]!);
		}
		if (s.kind === 'fixed' && !coupleTaken.has(n)) {
			coupleTaken.add(n);
			mz = restraintForce(dsm.thL[n]!);
			if (dsm.thR[n] !== dsm.thL[n]) mz += restraintForce(dsm.thR[n]!);
		}
		return { supportIndex: s.index, kind: s.kind, x: s.x, fy: clean(fy, zeroForce), mz: clean(mz, zeroCouple) };
	});
}

/** Sum of |forces| + |couples|/L + |distributed resultants|: a force scale for tolerances [N]. */
function totalLoad(beam: PreparedBeam): number {
	let t = 0;
	for (const p of beam.forces) t += Math.abs(p.value);
	for (const c of beam.couples) t += Math.abs(c.value) / beam.L;
	for (const d of beam.distributed) t += 0.5 * (Math.abs(d.q1) + Math.abs(d.q2)) * (d.x2 - d.x1);
	return t;
}

// ---------------------------------------------------------------------------
// 4. Exact V and M by a statics sweep
// ---------------------------------------------------------------------------

/**
 * Builds q, V and M as polynomials of the local coordinate s on every
 * segment between consecutive key points, by the method of sections: cut the
 * beam at x = x0 + s and sum everything on the left.
 *
 *   V(s) = sum of point forces and reactions at x <= x0
 *          + resultant of the distributed loads between 0 and x0 + s
 *   M(s) = sum of F_i·(x0 + s - x_i) - sum of couples C_j at x <= x0
 *          + moment of the distributed loads about the section
 *
 * A counter-clockwise couple on the left part makes M jump down (that is the
 * minus sign). Items at x0 are included, items at x1 are not, so evaluating
 * at s = x1 - x0 gives the left limit at x1: a fixed right end shows its
 * hogging moment instead of 0. Degrees: q <= 1, V <= 2, M <= 3.
 */
function buildSegments(beam: PreparedBeam, reactions: Reaction[]): Segment[] {
	const { keys } = beam;
	const forces: PreparedPointItem[] = [...beam.forces];
	const couples: PreparedPointItem[] = [...beam.couples];
	beam.supports.forEach((s, i) => {
		const r = reactions[i]!;
		if (r.fy !== 0) forces.push({ k: s.k, value: r.fy });
		if (r.mz !== 0) couples.push({ k: s.k, value: r.mz });
	});

	const segments: Segment[] = [];
	for (let i = 0; i < keys.length - 1; i++) {
		const x0 = keys[i]!;
		const x1 = keys[i + 1]!;
		const q: Poly = [0, 0];
		const V: Poly = [0, 0, 0];
		const M: Poly = [0, 0, 0, 0];

		for (const f of forces) {
			if (f.k > i) continue;
			// F at x_f contributes F to V and F·(x0 - x_f + s) to M.
			V[0]! += f.value;
			M[0]! += f.value * (x0 - keys[f.k]!);
			M[1]! += f.value;
		}
		for (const c of couples) {
			if (c.k <= i) M[0]! -= c.value;
		}
		for (const d of beam.distributed) {
			if (d.k1 > i) continue; // starts at or right of x1: nothing on the left yet
			const slope = (d.q2 - d.q1) / (d.x2 - d.x1);
			if (d.k2 <= i) {
				// Entirely left of the section. Resultant W = (q1 + q2)/2·a and its
				// moment about x2: integral of q(t)(x2 - t) dt = a²(2q1 + q2)/6,
				// with a = x2 - x1; about the section add W·(x0 - x2 + s).
				const a = d.x2 - d.x1;
				const W = 0.5 * (d.q1 + d.q2) * a;
				V[0]! += W;
				M[0]! += (a * a * (2 * d.q1 + d.q2)) / 6 + W * (x0 - d.x2);
				M[1]! += W;
			} else {
				// Covers this segment. Part between x1 and x0 (length a, q from q1
				// to qa): resultant (q1 + qa)/2·a, moment about x0 a²(2q1 + qa)/6.
				const a = x0 - d.x1;
				const qa = d.q1 + slope * a;
				const Wa = 0.5 * (d.q1 + qa) * a;
				V[0]! += Wa;
				M[0]! += (a * a * (2 * d.q1 + qa)) / 6;
				M[1]! += Wa;
				// Part inside the segment, q(t) = qa + slope·t for t in [0, s]:
				// integral of q = qa·s + slope·s²/2 (into V) and
				// integral of q(t)(s - t) dt = qa·s²/2 + slope·s³/6 (into M).
				q[0]! += qa;
				q[1]! += slope;
				V[1]! += qa;
				V[2]! += 0.5 * slope;
				M[2]! += 0.5 * qa;
				M[3]! += slope / 6;
			}
		}
		segments.push({ x0, x1, q, V, M });
	}
	return segments;
}

// ---------------------------------------------------------------------------
// 5. Slope and deflection
// ---------------------------------------------------------------------------

/**
 * Adds theta and v polynomials to every segment by marching from x = 0:
 *   theta(s) = theta_start + integral of M/EI ds   (EI·v'' = M)
 *   v(s)     = v_start + integral of theta ds
 * Start values at x = 0 are the DSM nodal values divided by the real EI
 * (the system was solved with EI = 1). Deflection is continuous everywhere;
 * the slope jumps at a hinge, so it restarts there from the DSM rotation of
 * the element on the right (thR). Degrees: theta <= 4, v <= 5.
 *
 * Returns true on success. Returns false, and removes theta and v from
 * every segment, when a slope or deflection is not finite or could exceed
 * MAX_DEFLECTION_MAGNITUDE (see polyBound). That takes an absurdly small
 * but positive EI, such as "E 1e-300 Pa": 1/EI overflows and the values
 * become Infinity or NaN. Left in place, NaN extremes would read as "zero
 * deflection" in the diagram and the table with no warning, a silent wrong
 * result. Without theta and v, computeExtrema skips the deflection and the
 * caller reports it as unavailable instead.
 */
function integrateDeflection(beam: PreparedBeam, dsm: StiffnessResult, segments: Segment[], EI: number): boolean {
	const nodeOfKey = new Map<number, number>(dsm.nodeKeys.map((k, i) => [k, i]));
	let theta0 = dsm.u[dsm.thR[0]!]! / EI;
	let v0 = dsm.u[dsm.vDof[0]!]! / EI;
	let representable = true;
	segments.forEach((seg, i) => {
		if (i > 0 && beam.hingeKeys.has(i)) theta0 = dsm.u[dsm.thR[nodeOfKey.get(i)!]!]! / EI;
		const theta = polyIntegrate(polyScale(seg.M, 1 / EI), theta0);
		const v = polyIntegrate(theta, v0);
		seg.theta = theta;
		seg.v = v;
		const len = seg.x1 - seg.x0;
		// The start values are the constant coefficients, so a bad marched
		// value fails the next segment's bound; the last segment's bound
		// covers its own end value.
		if (!(polyBound(theta, len) <= MAX_DEFLECTION_MAGNITUDE && polyBound(v, len) <= MAX_DEFLECTION_MAGNITUDE)) {
			representable = false;
		}
		theta0 = polyEval(theta, len);
		v0 = polyEval(v, len);
	});
	if (!representable) {
		for (const seg of segments) {
			delete seg.theta;
			delete seg.v;
		}
	}
	return representable;
}

/**
 * Upper bound of |p(s)| for s in [0, len]: sum of |c_i|·r^i with
 * r = max(1, len). It also bounds every partial result of Horner's rule
 * (polyEval) on that interval, so no evaluation there can exceed it (or
 * overflow while it is finite). NaN or Infinity when a coefficient is NaN
 * or infinite.
 */
function polyBound(p: Poly, len: number): number {
	const r = Math.max(1, len);
	let bound = 0;
	let power = 1;
	for (const c of p) {
		// Skip zeros: 0 × Infinity would be NaN if r^i ever overflowed.
		if (c !== 0) bound += Math.abs(c) * power;
		power *= r;
	}
	return bound;
}

// ---------------------------------------------------------------------------
// Equilibrium check
// ---------------------------------------------------------------------------

/**
 * Global equilibrium of the solved beam: sum of all vertical forces (applied,
 * distributed resultants and reactions) and sum of moments about x = 0
 * (couples plus F·x, counter-clockwise positive). Both should be round-off.
 */
function equilibriumResidual(beam: PreparedBeam, reactions: Reaction[]): { force: number; moment: number } {
	const { keys } = beam;
	let force = 0;
	let moment = 0;
	for (const p of beam.forces) {
		force += p.value;
		moment += p.value * keys[p.k]!;
	}
	for (const c of beam.couples) moment += c.value;
	for (const d of beam.distributed) {
		// Trapezoid resultant W and centroid xc = x1 + a(q1 + 2q2)/(3(q1 + q2));
		// W·xc is written without the division so q1 + q2 = 0 is fine:
		// W·xc = W·x1 + a²(q1 + 2q2)/6.
		const a = d.x2 - d.x1;
		const W = 0.5 * (d.q1 + d.q2) * a;
		force += W;
		moment += W * d.x1 + (a * a * (d.q1 + 2 * d.q2)) / 6;
	}
	beam.supports.forEach((s, i) => {
		const r = reactions[i]!;
		force += r.fy;
		moment += r.fy * keys[s.k]! + r.mz;
	});
	return { force, moment };
}

/**
 * Self-check of the solution: throws BeamAnalysisError when global
 * equilibrium is violated by more than RESIDUAL_TOL of the forces involved.
 * The scale includes the reactions because two supports very close together
 * legitimately carry huge opposite reactions, whose sum has a larger (but
 * still relatively tiny) round-off error.
 */
function checkResidual(beam: PreparedBeam, reactions: Reaction[], residual: { force: number; moment: number }): void {
	let scale = totalLoad(beam);
	for (const r of reactions) scale += Math.abs(r.fy) + Math.abs(r.mz) / beam.L;
	const ok = Math.abs(residual.force) <= RESIDUAL_TOL * scale && Math.abs(residual.moment) <= RESIDUAL_TOL * scale * beam.L;
	if (!ok) throw new BeamAnalysisError(TOO_CLOSE_MESSAGE);
}
