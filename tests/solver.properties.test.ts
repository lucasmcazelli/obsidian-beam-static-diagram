/**
 * Property tests: physics that must hold for ANY valid beam, checked on
 * random beams from a seeded (deterministic) generator.
 */
import { describe, expect, it } from 'vitest';
import { evaluateAt, sampleDiagram } from '../src/core/diagrams';
import { computeNodalSolution, solveBeam } from '../src/core/solver';
import { classifyBeam } from '../src/core/stability';
import type { BeamModel, BeamResults, Load, Support, SupportKind } from '../src/core/types';

// ---------------------------------------------------------------------------
// Random beam generator
// ---------------------------------------------------------------------------

/** mulberry32: tiny seeded PRNG returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type Rng = () => number;
const between = (rng: Rng, a: number, b: number): number => a + (b - a) * rng();
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;

/**
 * Positions on a 1/20 grid half of the time (so loads often land exactly on
 * supports, hinges and each other) and anywhere otherwise.
 */
function position(rng: Rng, L: number, lo = 0, hi = L): number {
	if (rng() < 0.5) {
		const i = Math.ceil((lo / L) * 20);
		const j = Math.floor((hi / L) * 20);
		if (j >= i) return (L * (i + Math.floor(rng() * (j - i + 1)))) / 20;
	}
	return between(rng, lo, hi);
}

type Layout = { supports: [SupportKind, number][]; hinges: number[] };

/** Stable support layouts (positions as fractions of L, randomised inside safe ranges). */
const LAYOUTS: ((rng: Rng) => Layout)[] = [
	() => ({ supports: [['pin', 0], ['roller', 1]], hinges: [] }),
	() => ({ supports: [['fixed', 0]], hinges: [] }),
	() => ({ supports: [['fixed', 1]], hinges: [] }),
	() => ({ supports: [['fixed', 0], ['roller', 1]], hinges: [] }),
	() => ({ supports: [['fixed', 0], ['fixed', 1]], hinges: [] }),
	(rng) => ({ supports: [['pin', between(rng, 0, 0.3)], ['roller', between(rng, 0.6, 1)]], hinges: [] }),
	(rng) => ({ supports: [['pin', 0], ['roller', between(rng, 0.3, 0.7)], ['roller', 1]], hinges: [] }),
	(rng) => ({ supports: [['pin', 0], ['roller', between(rng, 0.2, 0.4)], ['roller', between(rng, 0.6, 0.8)], ['roller', 1]], hinges: [] }),
	(rng) => ({ supports: [['fixed', 0], ['roller', 1]], hinges: [between(rng, 0.2, 0.8)] }),
	(rng) => ({ supports: [['fixed', 0], ['roller', 0.5], ['roller', 1]], hinges: [between(rng, 0.2, 0.45), between(rng, 0.55, 0.8)] }),
	() => ({ supports: [['pin', 0], ['roller', 0.5], ['roller', 1]], hinges: [0.5] }),
	(rng) => ({ supports: [['pin', 0], ['roller', 0.5], ['fixed', 1]], hinges: [between(rng, 0.1, 0.4)] }),
	(rng) => ({ supports: [['fixed', 0], ['roller', between(rng, 0.3, 0.7)], ['fixed', 1]], hinges: [] }),
];

function randomBeam(rng: Rng): BeamModel {
	const L = Math.round(between(rng, 1, 15) * 100) / 100;
	const layout = pick(rng, LAYOUTS)(rng);
	const hinges = layout.hinges.map((h) => h * L);
	const supports: Support[] = layout.supports.map(([kind, f]) => ({ kind, x: f * L })).sort((a, b) => a.x - b.x);
	const loads: Load[] = [];
	const count = 1 + Math.floor(rng() * 5);
	for (let i = 0; i < count; i++) {
		const kind = pick(rng, ['point', 'point', 'moment', 'distributed', 'distributed'] as const);
		if (kind === 'point') {
			loads.push({ kind, x: position(rng, L), fy: between(rng, -20, 20) });
		} else if (kind === 'moment') {
			let x = position(rng, L);
			// The model forbids couples on hinges: nudge it off.
			if (hinges.some((h) => Math.abs(h - x) < 1e-6 * L)) x = Math.min(L, x + 0.013 * L);
			loads.push({ kind, x, mz: between(rng, -30, 30) });
		} else {
			const x1 = position(rng, L, 0, 0.9 * L);
			const x2 = position(rng, L, x1 + 0.05 * L, L);
			loads.push({ kind, x1, x2, q1: between(rng, -10, 10), q2: rng() < 0.4 ? NaN : between(rng, -10, 10) });
			const last = loads[loads.length - 1]!;
			// Uniform about 40% of the time.
			if (last.kind === 'distributed' && Number.isNaN(last.q2)) last.q2 = last.q1;
		}
	}
	return { units: 'kN-m', length: L, supports, hinges, loads, E: 2e8, I: between(rng, 1e-5, 1e-3) };
}

const SEED = 20261001;
const COUNT = 150;
const rng = mulberry32(SEED);
const BEAMS: BeamModel[] = Array.from({ length: COUNT }, () => randomBeam(rng));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sum |forces| + |resultants| + |couples|/L [N]: the force scale for tolerances. */
function forceScale(m: BeamModel): number {
	let s = 0;
	for (const l of m.loads) {
		if (l.kind === 'point') s += Math.abs(l.fy);
		else if (l.kind === 'moment') s += Math.abs(l.mz) / m.length;
		else s += 0.5 * (Math.abs(l.q1) + Math.abs(l.q2)) * (l.x2 - l.x1);
	}
	return Math.max(s, 1e-300);
}

const near = (a: number, b: number, L: number): boolean => Math.abs(a - b) <= 1e-9 * L;

/** Largest |v| over the extremes (deflection scale for tolerances) [m]. */
function deflectionScale(r: BeamResults): number {
	return Math.max(Math.abs(r.extrema.deflectionMin!.value), Math.abs(r.extrema.deflectionMax!.value), 1e-300);
}

/** Largest |theta| at the segment ends (slope scale for tolerances) [rad]. */
function slopeScale(r: BeamResults): number {
	let m = 1e-300;
	for (const s of r.segments) {
		m = Math.max(m, Math.abs(evaluateAt([s], 'theta', s.x0)), Math.abs(evaluateAt([s], 'theta', s.x1)));
	}
	return m;
}

/** Applied plus reaction forces and couples located at x. */
function itemsAt(m: BeamModel, r: BeamResults, x: number): { force: number; couple: number } {
	let force = 0;
	let couple = 0;
	for (const l of m.loads) {
		if (l.kind === 'point' && near(l.x, x, m.length)) force += l.fy;
		if (l.kind === 'moment' && near(l.x, x, m.length)) couple += l.mz;
	}
	for (const re of r.reactions) {
		if (near(re.x, x, m.length)) {
			force += re.fy;
			couple += re.mz;
		}
	}
	return { force, couple };
}

/** Points used to compare two solutions: key points of both, plus midpoints. */
function probePoints(L: number, ...results: BeamResults[]): number[] {
	const xs = new Set<number>();
	for (const r of results) {
		for (const k of r.keyPoints) xs.add(k);
		for (const s of r.segments) xs.add(0.5 * (s.x0 + s.x1));
	}
	for (let i = 0; i <= 10; i++) xs.add((i * L) / 10);
	return [...xs].sort((a, b) => a - b);
}

function mirror(m: BeamModel): BeamModel {
	const L = m.length;
	return {
		...m,
		supports: m.supports.map((s) => ({ kind: s.kind, x: L - s.x })).sort((a, b) => a.x - b.x),
		hinges: m.hinges.map((h) => L - h).sort((a, b) => a - b),
		loads: m.loads.map((l): Load => {
			if (l.kind === 'point') return { ...l, x: L - l.x };
			// Seen in a mirror a counter-clockwise couple turns clockwise.
			if (l.kind === 'moment') return { ...l, x: L - l.x, mz: -l.mz };
			return { ...l, x1: L - l.x2, x2: L - l.x1, q1: l.q2, q2: l.q1 };
		}),
	};
}

function scaleLoads(m: BeamModel, k: number): BeamModel {
	return {
		...m,
		loads: m.loads.map((l): Load => {
			if (l.kind === 'point') return { ...l, fy: k * l.fy };
			if (l.kind === 'moment') return { ...l, mz: k * l.mz };
			return { ...l, q1: k * l.q1, q2: k * l.q2 };
		}),
	};
}

const solved = BEAMS.map((m) => ({ m, r: solveBeam(m) }));

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe(`random beams (seed ${SEED}, ${COUNT} beams)`, () => {
	it('cover hinges, clamps, couples and loads exactly on supports', () => {
		const onSupport = BEAMS.filter((m) =>
			m.loads.some((l) => l.kind === 'point' && m.supports.some((s) => near(s.x, l.x, m.length))),
		);
		expect(BEAMS.filter((m) => m.hinges.length > 0).length).toBeGreaterThan(20);
		expect(BEAMS.filter((m) => m.supports.some((s) => s.kind === 'fixed')).length).toBeGreaterThan(40);
		expect(BEAMS.filter((m) => m.loads.some((l) => l.kind === 'moment')).length).toBeGreaterThan(40);
		expect(onSupport.length).toBeGreaterThan(5);
		expect(BEAMS.filter((m) => classifyBeam(m).degree! > 0).length).toBeGreaterThan(30);
	});

	it('are all stable by construction', () => {
		for (const { m, r } of solved) {
			expect(classifyBeam(m).stable).toBe(true);
			expect(r.classification.stable).toBe(true);
		}
	});

	it('satisfy global equilibrium (residual and an independent recomputation)', () => {
		for (const { m, r } of solved) {
			const F = forceScale(m);
			const L = m.length;
			expect(Math.abs(r.residual.force)).toBeLessThan(1e-9 * F);
			expect(Math.abs(r.residual.moment)).toBeLessThan(1e-9 * F * L);
			let fy = 0;
			let mz = 0;
			for (const l of m.loads) {
				if (l.kind === 'point') {
					fy += l.fy;
					mz += l.fy * l.x;
				} else if (l.kind === 'moment') {
					mz += l.mz;
				} else {
					const a = l.x2 - l.x1;
					const W = 0.5 * (l.q1 + l.q2) * a;
					fy += W;
					mz += W * l.x1 + (a * a * (l.q1 + 2 * l.q2)) / 6;
				}
			}
			for (const re of r.reactions) {
				fy += re.fy;
				mz += re.fy * re.x + re.mz;
			}
			expect(Math.abs(fy)).toBeLessThan(1e-9 * F);
			expect(Math.abs(mz)).toBeLessThan(1e-9 * F * L);
		}
	});

	it('jump in V by the force and in M by minus the couple at every key point', () => {
		for (const { m, r } of solved) {
			const F = forceScale(m);
			const L = m.length;
			for (const x of r.keyPoints) {
				const { force, couple } = itemsAt(m, r, x);
				// Outside the beam V = M = 0, so the end values are the jumps themselves.
				const Vl = x === 0 ? 0 : evaluateAt(r.segments, 'V', x, 'left');
				const Vr = x === L ? 0 : evaluateAt(r.segments, 'V', x, 'right');
				const Ml = x === 0 ? 0 : evaluateAt(r.segments, 'M', x, 'left');
				const Mr = x === L ? 0 : evaluateAt(r.segments, 'M', x, 'right');
				expect(Math.abs(Vr - Vl - force)).toBeLessThan(1e-9 * F);
				expect(Math.abs(Mr - Ml + couple)).toBeLessThan(1e-9 * F * L);
			}
		}
	});

	it('have M = 0 at hinges and at ends without a clamp or a couple', () => {
		for (const { m, r } of solved) {
			const tol = 1e-9 * forceScale(m) * m.length;
			for (const h of m.hinges) {
				expect(Math.abs(evaluateAt(r.segments, 'M', h, 'left'))).toBeLessThan(tol);
				expect(Math.abs(evaluateAt(r.segments, 'M', h, 'right'))).toBeLessThan(tol);
			}
			for (const [x, side] of [
				[0, 'right'],
				[m.length, 'left'],
			] as const) {
				const clamped = m.supports.some((s) => s.kind === 'fixed' && near(s.x, x, m.length));
				const couple = m.loads.some((l) => l.kind === 'moment' && near(l.x, x, m.length));
				if (!clamped && !couple) expect(Math.abs(evaluateAt(r.segments, 'M', x, side))).toBeLessThan(tol);
			}
		}
	});

	it('satisfy dV/dx = q, dM/dx = V, dtheta/dx = M/EI and dv/dx = theta (finite differences)', () => {
		for (const { m, r } of solved) {
			const F = forceScale(m);
			const L = m.length;
			const EI = m.E! * m.I!;
			const thetaScale = (F * L * L) / EI;
			for (const s of r.segments) {
				const len = s.x1 - s.x0;
				if (len < 1e-3 * L) continue;
				const x = s.x0 + 0.37 * len;
				const h = 1e-3 * len;
				const d = (q: 'V' | 'M' | 'theta' | 'v'): number =>
					(evaluateAt(r.segments, q, x + h) - evaluateAt(r.segments, q, x - h)) / (2 * h);
				expect(Math.abs(d('V') - evaluateAt(r.segments, 'q', x))).toBeLessThan(1e-6 * F);
				expect(Math.abs(d('M') - evaluateAt(r.segments, 'V', x))).toBeLessThan(1e-6 * F);
				expect(Math.abs(d('theta') - evaluateAt(r.segments, 'M', x) / EI)).toBeLessThan((1e-6 * F * L) / EI);
				expect(Math.abs(d('v') - evaluateAt(r.segments, 'theta', x))).toBeLessThan(1e-6 * thetaScale);
			}
		}
	});

	it('obey superposition: results(A + B) = results(A) + results(B)', () => {
		for (const { m } of solved.slice(0, 60)) {
			if (m.loads.length < 2) continue;
			const half = Math.ceil(m.loads.length / 2);
			const a = solveBeam({ ...m, loads: m.loads.slice(0, half) });
			const b = solveBeam({ ...m, loads: m.loads.slice(half) });
			const ab = solveBeam(m);
			const F = forceScale(m);
			const L = m.length;
			ab.reactions.forEach((re, i) => {
				expect(Math.abs(re.fy - a.reactions[i]!.fy - b.reactions[i]!.fy)).toBeLessThan(1e-9 * F);
				expect(Math.abs(re.mz - a.reactions[i]!.mz - b.reactions[i]!.mz)).toBeLessThan(1e-9 * F * L);
			});
			const vScale = deflectionScale(ab);
			for (const x of probePoints(L, a, b, ab)) {
				for (const side of ['left', 'right'] as const) {
					const sum = (q: 'V' | 'M' | 'v'): number => evaluateAt(a.segments, q, x, side) + evaluateAt(b.segments, q, x, side);
					expect(Math.abs(evaluateAt(ab.segments, 'V', x, side) - sum('V'))).toBeLessThan(1e-9 * F);
					expect(Math.abs(evaluateAt(ab.segments, 'M', x, side) - sum('M'))).toBeLessThan(1e-9 * F * L);
					expect(Math.abs(evaluateAt(ab.segments, 'v', x, side) - sum('v'))).toBeLessThan(1e-8 * vScale);
				}
			}
		}
	});

	it('are mirror symmetric: V and theta flip sign, M and v do not, couples flip', () => {
		for (const { m, r } of solved.slice(0, 80)) {
			const mm = mirror(m);
			const rm = solveBeam(mm);
			const F = forceScale(m);
			const L = m.length;
			r.reactions.forEach((re) => {
				const twin = rm.reactions.find((t) => near(t.x, L - re.x, L))!;
				expect(Math.abs(re.fy - twin.fy)).toBeLessThan(1e-9 * F);
				expect(Math.abs(re.mz + twin.mz)).toBeLessThan(1e-9 * F * L);
			});
			const vScale = deflectionScale(r);
			const thScale = slopeScale(r);
			for (const x of probePoints(L, r)) {
				expect(Math.abs(evaluateAt(r.segments, 'V', x, 'right') + evaluateAt(rm.segments, 'V', L - x, 'left'))).toBeLessThan(1e-9 * F);
				expect(Math.abs(evaluateAt(r.segments, 'M', x, 'right') - evaluateAt(rm.segments, 'M', L - x, 'left'))).toBeLessThan(
					1e-9 * F * L,
				);
				expect(Math.abs(evaluateAt(r.segments, 'v', x) - evaluateAt(rm.segments, 'v', L - x))).toBeLessThan(1e-8 * vScale);
				expect(
					Math.abs(evaluateAt(r.segments, 'theta', x, 'right') + evaluateAt(rm.segments, 'theta', L - x, 'left')),
				).toBeLessThan(1e-8 * thScale);
			}
		}
	});

	it('scale linearly: doubling the loads doubles every result', () => {
		for (const { m, r } of solved.slice(0, 60)) {
			const r2 = solveBeam(scaleLoads(m, 2));
			const F = forceScale(m);
			const L = m.length;
			r.reactions.forEach((re, i) => {
				expect(Math.abs(r2.reactions[i]!.fy - 2 * re.fy)).toBeLessThan(1e-12 * F);
				expect(Math.abs(r2.reactions[i]!.mz - 2 * re.mz)).toBeLessThan(1e-12 * F * L);
			});
			const vScale = deflectionScale(r);
			for (const x of probePoints(L, r)) {
				expect(Math.abs(evaluateAt(r2.segments, 'M', x) - 2 * evaluateAt(r.segments, 'M', x))).toBeLessThan(1e-12 * F * L);
				expect(Math.abs(evaluateAt(r2.segments, 'v', x) - 2 * evaluateAt(r.segments, 'v', x))).toBeLessThan(1e-12 * vScale);
			}
		}
	});

	it('doubling EI halves the deflection and leaves the forces unchanged', () => {
		for (const { m, r } of solved.slice(0, 60)) {
			const r2 = solveBeam({ ...m, E: 2 * m.E! });
			const vScale = deflectionScale(r);
			r.reactions.forEach((re, i) => expect(r2.reactions[i]!.fy).toBe(re.fy));
			for (const x of probePoints(m.length, r)) {
				expect(Math.abs(evaluateAt(r2.segments, 'v', x) - 0.5 * evaluateAt(r.segments, 'v', x))).toBeLessThan(1e-12 * vScale);
			}
		}
	});

	it('have v = 0 at supports, theta = 0 at clamps, and the marched slope matches the stiffness solution', () => {
		for (const { m, r } of solved) {
			const EI = m.E! * m.I!;
			const L = m.length;
			const vScale = deflectionScale(r);
			const thScale = slopeScale(r);
			for (const s of m.supports) {
				expect(Math.abs(evaluateAt(r.segments, 'v', s.x))).toBeLessThan(1e-9 * vScale);
				if (s.kind === 'fixed') {
					if (s.x > 0) expect(Math.abs(evaluateAt(r.segments, 'theta', s.x, 'left'))).toBeLessThan(1e-9 * thScale);
					if (s.x < L) expect(Math.abs(evaluateAt(r.segments, 'theta', s.x, 'right'))).toBeLessThan(1e-9 * thScale);
				}
			}
			const nodal = computeNodalSolution(m);
			nodal.x.forEach((x, i) => {
				expect(Math.abs(evaluateAt(r.segments, 'v', x) - nodal.vEI[i]! / EI)).toBeLessThan(1e-9 * vScale);
				if (x > 0) expect(Math.abs(evaluateAt(r.segments, 'theta', x, 'left') - nodal.thetaLeftEI[i]! / EI)).toBeLessThan(1e-8 * thScale);
				if (x < L) expect(Math.abs(evaluateAt(r.segments, 'theta', x, 'right') - nodal.thetaRightEI[i]! / EI)).toBeLessThan(1e-8 * thScale);
			});
		}
	});

	it('report extremes that bound every plotted sample', () => {
		for (const { m, r } of solved) {
			const F = forceScale(m);
			const L = m.length;
			const ex = r.extrema;
			const shear = sampleDiagram(r.segments, 'shear', 40).ys;
			const moment = sampleDiagram(r.segments, 'moment', 40).ys;
			const defl = sampleDiagram(r.segments, 'deflection', 40).ys;
			const vScale = deflectionScale(r);
			expect(Math.max(...shear)).toBeLessThanOrEqual(ex.shearMax.value + 1e-9 * F);
			expect(Math.min(...shear)).toBeGreaterThanOrEqual(ex.shearMin.value - 1e-9 * F);
			expect(Math.max(...moment)).toBeLessThanOrEqual(ex.momentMax.value + 1e-9 * F * L);
			expect(Math.min(...moment)).toBeGreaterThanOrEqual(ex.momentMin.value - 1e-9 * F * L);
			expect(Math.max(...defl)).toBeLessThanOrEqual(ex.deflectionMax!.value + 1e-9 * vScale);
			expect(Math.min(...defl)).toBeGreaterThanOrEqual(ex.deflectionMin!.value - 1e-9 * vScale);
			// and the reported values are attained at the reported positions
			expect(Math.abs(evaluateAt(r.segments, 'v', ex.deflectionMin!.x) - ex.deflectionMin!.value)).toBeLessThan(1e-9 * vScale);
		}
	});

	it('report shear zeros where V really changes sign', () => {
		for (const { m, r } of solved) {
			const F = forceScale(m);
			const L = m.length;
			for (const x of r.shearZeros) {
				const h = 1e-6 * L;
				const before = evaluateAt(r.segments, 'V', Math.max(0, x - h), 'left');
				const after = evaluateAt(r.segments, 'V', Math.min(L, x + h), 'right');
				// Opposite signs on both sides (or zero within the tolerance).
				expect(before * after).toBeLessThanOrEqual(1e-6 * F * F);
			}
		}
	});
});
