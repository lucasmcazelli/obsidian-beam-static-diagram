/**
 * Closed-form validation of the solver.
 *
 * A) The 23 cases of tests/fixtures/benchmarks.json (kN, m, EI in kN·m²,
 *    every value cross-checked with an exact rational-arithmetic solver).
 * B) Extra textbook cases (L = 5 m, w = 1000 N/m, P = 1000 N, EI = 2e5).
 * D) Robustness: near-support loads, very long and very short beams,
 *    mechanisms.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateAt } from '../src/core/diagrams';
import { polyRootsInInterval } from '../src/core/polynomial';
import { computeNodalSolution, solveBeam } from '../src/core/solver';
import { BeamAnalysisError } from '../src/core/types';
import type { BeamModel, BeamResults, Load, SupportKind } from '../src/core/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a model directly (the parser is not involved in these tests). */
function beam(
	length: number,
	supports: [SupportKind, number][],
	loads: Load[],
	options: { hinges?: number[]; EI?: number } = {},
): BeamModel {
	return {
		units: 'kN-m',
		length,
		supports: supports.map(([kind, x]) => ({ kind, x })),
		hinges: options.hinges ?? [],
		loads,
		...(options.EI !== undefined ? { E: options.EI, I: 1 } : {}),
	};
}
const point = (x: number, fy: number): Load => ({ kind: 'point', x, fy });
const couple = (x: number, mz: number): Load => ({ kind: 'moment', x, mz });
const dist = (x1: number, x2: number, q1: number, q2 = q1): Load => ({ kind: 'distributed', x1, x2, q1, q2 });

/** Forces and moments: |a - b| <= 1e-7·max(1, |b|) (the fixture stores some left limits at x - 1e-12). */
function expectForce(actual: number, expected: number, what: string): void {
	expect(Math.abs(actual - expected), `${what}: got ${actual}, expected ${expected}`).toBeLessThanOrEqual(
		1e-7 * Math.max(1, Math.abs(expected)),
	);
}
/** Deflections and slopes: relative 1e-6 with an absolute floor of 1e-12. */
function expectDeflection(actual: number, expected: number, what: string): void {
	expect(Math.abs(actual - expected), `${what}: got ${actual}, expected ${expected}`).toBeLessThanOrEqual(
		Math.max(1e-6 * Math.abs(expected), 1e-12),
	);
}
/** Locations within 0.1 mm. */
function expectX(actual: number, expected: number, what: string): void {
	expect(Math.abs(actual - expected), `${what}: got x = ${actual}, expected ${expected}`).toBeLessThanOrEqual(1e-4);
}
/** Tight relative check for exact closed forms. */
function expectRel(actual: number, expected: number, rel = 1e-9, what = ''): void {
	expect(Math.abs(actual - expected), `${what} got ${actual}, expected ${expected}`).toBeLessThanOrEqual(
		rel * Math.max(Math.abs(expected), 1e-300),
	);
}

const at = (r: BeamResults, q: 'V' | 'M' | 'theta' | 'v', x: number, side: 'left' | 'right' = 'right'): number =>
	evaluateAt(r.segments, q, x, side);

// ---------------------------------------------------------------------------
// A) Fixture benchmarks
// ---------------------------------------------------------------------------

interface FixtureValue {
	value: number;
}
interface FixtureExtremum {
	value: number;
	x: number;
}
interface FixtureDeflection {
	value_m: number;
	x: number;
}
interface FixtureKeyPoint {
	x: number;
	V_left?: number;
	V_right?: number;
	M_left?: number;
	M_right?: number;
	v?: number;
}
type FixtureLoad =
	| { type: 'point'; x: number; Fy: number }
	| { type: 'moment'; x: number; Mz_ccw: number }
	| { type: 'distributed'; x1: number; x2: number; w1: number; w2: number };
interface FixtureCase {
	id: string;
	description: string;
	L: number;
	EI: number;
	supports: { id: string; type: SupportKind; x: number }[];
	hinges: number[];
	loads: FixtureLoad[];
	expected: {
		reactions: Record<string, { Fy: FixtureValue; Mz_ccw?: FixtureValue }>;
		key_points: FixtureKeyPoint[];
		V_abs_max?: number;
		M_max?: FixtureExtremum;
		M_min?: FixtureExtremum;
		M_internal_at_x0?: number;
		M_zero_crossing_x?: number;
		M_jump?: { x: number; M_left: number; M_right: number };
		deflection_min?: FixtureDeflection;
		deflection_max_up?: FixtureDeflection;
		deflection_at?: FixtureDeflection[];
		slope_at_x0_rad?: number;
		slope_at_tip_rad?: number;
	};
}

const fixture = JSON.parse(readFileSync(new URL('./fixtures/benchmarks.json', import.meta.url), 'utf8')) as {
	meta: { sign_convention: Record<string, string> };
	cases: FixtureCase[];
};

/** Fixture case -> model, with E = EI and I = 1 (kN, m: consistent units). */
function fixtureModel(c: FixtureCase): BeamModel {
	const loads: Load[] = c.loads.map((l) => {
		switch (l.type) {
			case 'point':
				return point(l.x, l.Fy);
			case 'moment':
				return couple(l.x, l.Mz_ccw);
			case 'distributed':
				return dist(l.x1, l.x2, l.w1, l.w2);
		}
	});
	return beam(
		c.L,
		c.supports.map((s) => [s.type, s.x]),
		loads,
		{ hinges: c.hinges, EI: c.EI },
	);
}

describe('A) fixture benchmarks', () => {
	it('uses the same sign convention as the solver', () => {
		const sc = fixture.meta.sign_convention;
		expect(sc.Fy).toMatch(/\+up/);
		expect(sc.Mz_ccw).toMatch(/counter-clockwise/);
		expect(sc.M).toMatch(/sagging/);
		expect(fixture.cases).toHaveLength(23);
	});

	it.each(fixture.cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
		const r = solveBeam(fixtureModel(c));
		const e = c.expected;
		expect(r.classification.stable).toBe(true);
		expect(r.hasDeflection).toBe(true);

		// Reactions, matched to the fixture's support ids by order.
		c.supports.forEach((s, i) => {
			const exp = e.reactions[s.id]!;
			const got = r.reactions[i]!;
			expect(got.supportIndex).toBe(i);
			expectForce(got.fy, exp.Fy.value, `reaction ${s.id} Fy`);
			if (exp.Mz_ccw !== undefined) expectForce(got.mz, exp.Mz_ccw.value, `reaction ${s.id} Mz`);
			if (s.type !== 'fixed') expect(got.mz).toBe(0);
		});

		for (const kp of e.key_points) {
			if (kp.V_left !== undefined) expectForce(at(r, 'V', kp.x, 'left'), kp.V_left, `V(${kp.x}-)`);
			if (kp.V_right !== undefined) expectForce(at(r, 'V', kp.x, 'right'), kp.V_right, `V(${kp.x}+)`);
			if (kp.M_left !== undefined) expectForce(at(r, 'M', kp.x, 'left'), kp.M_left, `M(${kp.x}-)`);
			if (kp.M_right !== undefined) expectForce(at(r, 'M', kp.x, 'right'), kp.M_right, `M(${kp.x}+)`);
			if (kp.v !== undefined) expectDeflection(at(r, 'v', kp.x), kp.v, `v(${kp.x})`);
		}

		const ex = r.extrema;
		if (e.V_abs_max !== undefined) {
			expectForce(Math.max(Math.abs(ex.shearMax.value), Math.abs(ex.shearMin.value)), e.V_abs_max, 'max |V|');
		}
		if (e.M_max !== undefined) {
			expectForce(ex.momentMax.value, e.M_max.value, 'M max');
			expectX(ex.momentMax.x, e.M_max.x, 'M max');
		}
		if (e.M_min !== undefined) {
			expectForce(ex.momentMin.value, e.M_min.value, 'M min');
			expectX(ex.momentMin.x, e.M_min.x, 'M min');
		}
		if (e.M_internal_at_x0 !== undefined) expectForce(at(r, 'M', 0), e.M_internal_at_x0, 'M(0+)');
		if (e.M_zero_crossing_x !== undefined) {
			// First root of M along the beam.
			const firstRoot = r.segments
				.flatMap((s) => polyRootsInInterval(s.M, 0, s.x1 - s.x0).map((t) => s.x0 + t))
				.find((x) => x > 1e-9);
			expect(firstRoot).toBeDefined();
			expectX(firstRoot!, e.M_zero_crossing_x, 'M zero crossing');
		}
		if (e.M_jump !== undefined) {
			expectForce(at(r, 'M', e.M_jump.x, 'left'), e.M_jump.M_left, 'M jump left');
			expectForce(at(r, 'M', e.M_jump.x, 'right'), e.M_jump.M_right, 'M jump right');
		}
		if (e.deflection_min !== undefined) {
			expectDeflection(ex.deflectionMin!.value, e.deflection_min.value_m, 'deflection min');
			expectX(ex.deflectionMin!.x, e.deflection_min.x, 'deflection min');
		}
		if (e.deflection_max_up !== undefined) {
			expectDeflection(ex.deflectionMax!.value, e.deflection_max_up.value_m, 'deflection max');
			expectX(ex.deflectionMax!.x, e.deflection_max_up.x, 'deflection max');
		}
		for (const d of e.deflection_at ?? []) expectDeflection(at(r, 'v', d.x), d.value_m, `v(${d.x})`);
		if (e.slope_at_x0_rad !== undefined) expectDeflection(at(r, 'theta', 0), e.slope_at_x0_rad, 'theta(0)');
		if (e.slope_at_tip_rad !== undefined) expectDeflection(at(r, 'theta', c.L), e.slope_at_tip_rad, 'theta(L)');

		// Global equilibrium.
		expect(Math.abs(r.residual.force)).toBeLessThan(1e-9);
		expect(Math.abs(r.residual.moment)).toBeLessThan(1e-9);
	});

	it('SS-M-mid: deflection extremes at L/(2√3) (up) and L - L/(2√3) (down)', () => {
		const c = fixture.cases.find((k) => k.id === 'SS-M-mid')!;
		const r = solveBeam(fixtureModel(c));
		const xUp = c.L / (2 * Math.sqrt(3));
		expectX(r.extrema.deflectionMax!.x, xUp, 'up');
		expectX(r.extrema.deflectionMin!.x, c.L - xUp, 'down');
		expectDeflection(r.extrema.deflectionMax!.value, -r.extrema.deflectionMin!.value, 'antisymmetry');
	});

	it('PROP-UDL: max deflection 0.0054161 wL⁴/EI at 0.578465 L from the fixed end', () => {
		const c = fixture.cases.find((k) => k.id === 'PROP-UDL')!;
		const r = solveBeam(fixtureModel(c));
		const w = 5;
		expectRel(-r.extrema.deflectionMin!.value / ((w * c.L ** 4) / c.EI), 0.0054161, 1e-4, 'coefficient');
		expectX(r.extrema.deflectionMin!.x / c.L, 0.578465, 'relative position');
	});

	it('GERBER-UDL: reaction couple at the fixed end is counter-clockwise, M(0+) is hogging', () => {
		const c = fixture.cases.find((k) => k.id === 'GERBER-UDL')!;
		const r = solveBeam(fixtureModel(c));
		expectForce(r.reactions[0]!.mz, 30, 'Mz');
		expectForce(at(r, 'M', 0), -30, 'M(0+)');
		expectForce(at(r, 'M', 2), 0, 'M at hinge');
	});
});

// ---------------------------------------------------------------------------
// B) Extra closed-form cases
// ---------------------------------------------------------------------------

describe('B) closed-form cases (L = 5, w = 1000 N/m down, P = 1000 N down, EI = 2e5)', () => {
	const L = 5;
	const w = 1000;
	const P = 1000;
	const EI = 2e5;
	const udl = dist(0, L, -w);

	it('simply supported UDL: one element, exact midspan deflection -5wL⁴/(384EI)', () => {
		const m = beam(L, [['pin', 0], ['roller', L]], [udl], { EI });
		expect(computeNodalSolution(m).x).toEqual([0, L]);
		const r = solveBeam(m);
		expectRel(r.reactions[0]!.fy, (w * L) / 2);
		expectRel(r.reactions[1]!.fy, (w * L) / 2);
		expectRel(at(r, 'M', L / 2), (w * L * L) / 8);
		expectRel(at(r, 'v', L / 2), (-5 * w * L ** 4) / (384 * EI));
		expectRel(r.extrema.deflectionMin!.value, (-5 * w * L ** 4) / (384 * EI));
		expectX(r.extrema.deflectionMin!.x, L / 2, 'midspan');
		expect(r.classification).toEqual({ stable: true, degree: 0 });
	});

	it('fixed-fixed UDL: M(0) = -wL²/12, M(L/2) = wL²/24, v(L/2) = -wL⁴/(384EI)', () => {
		const r = solveBeam(beam(L, [['fixed', 0], ['fixed', L]], [udl], { EI }));
		expectRel(at(r, 'M', 0), (-w * L * L) / 12);
		expectRel(at(r, 'M', L, 'left'), (-w * L * L) / 12);
		expectRel(at(r, 'M', L / 2), (w * L * L) / 24);
		expectRel(at(r, 'v', L / 2), (-w * L ** 4) / (384 * EI));
		expectRel(r.reactions[0]!.mz, (w * L * L) / 12);
		expectRel(r.reactions[1]!.mz, (-w * L * L) / 12);
		expect(r.classification.degree).toBe(2);
	});

	it('cantilever tip load: v(L) = -PL³/(3EI), v(L/2) = -P(L/2)²(3L - L/2)/(6EI)', () => {
		const r = solveBeam(beam(L, [['fixed', 0]], [point(L, -P)], { EI }));
		expectRel(at(r, 'M', 0), -P * L);
		expectRel(at(r, 'v', L), (-P * L ** 3) / (3 * EI));
		expectRel(at(r, 'v', L / 2), (-P * (L / 2) ** 2 * (3 * L - L / 2)) / (6 * EI));
		expectRel(at(r, 'theta', L), (-P * L * L) / (2 * EI));
	});

	it('cantilever fixed at the right end (mirror): hogging moment shows at x = L', () => {
		const r = solveBeam(beam(L, [['fixed', L]], [point(0, -P)], { EI }));
		expectRel(r.reactions[0]!.fy, P);
		expectRel(r.reactions[0]!.mz, -P * L);
		expectRel(at(r, 'M', L, 'left'), -P * L);
		expectRel(at(r, 'v', 0), (-P * L ** 3) / (3 * EI));
		expectRel(at(r, 'theta', 0), (P * L * L) / (2 * EI));
		expect(Math.abs(at(r, 'v', L))).toBeLessThan(1e-15);
	});

	it('simply supported triangular load 0 -> w: RA = wL/6, M(L/√3) = wL²/(9√3)', () => {
		const r = solveBeam(beam(L, [['pin', 0], ['roller', L]], [dist(0, L, 0, -w)], { EI }));
		expectRel(r.reactions[0]!.fy, (w * L) / 6);
		expectRel(r.reactions[1]!.fy, (w * L) / 3);
		expectRel(at(r, 'M', L / Math.sqrt(3)), (w * L * L) / (9 * Math.sqrt(3)));
		expectRel(r.extrema.momentMax.value, (w * L * L) / (9 * Math.sqrt(3)));
		expectX(r.extrema.momentMax.x, L / Math.sqrt(3), 'M max');
		// v(x) = -(w x / (360 EI L))(3x⁴ - 10L²x² + 7L⁴)
		const x = 0.3 * L;
		expectRel(at(r, 'v', x), (-(w * x) / (360 * EI * L)) * (3 * x ** 4 - 10 * L * L * x * x + 7 * L ** 4));
	});

	it('simply supported CCW couple 1000 at a = 2: RA = +200, M(2-) = 400, M(2+) = -600', () => {
		const r = solveBeam(beam(L, [['pin', 0], ['roller', L]], [couple(2, 1000)], { EI }));
		expectRel(r.reactions[0]!.fy, 200);
		expectRel(r.reactions[1]!.fy, -200);
		expectRel(at(r, 'M', 2, 'left'), 400);
		expectRel(at(r, 'M', 2, 'right'), -600);
		expectRel(at(r, 'V', 1), 200);
		expectRel(at(r, 'V', 4), 200);
	});

	it('Gerber (fixed 0, hinge 3, roller 5, UDL): RB = 1000, M(3) = 0, RA = 4000, M(0+) = -7500', () => {
		const r = solveBeam(beam(L, [['fixed', 0], ['roller', L]], [udl], { EI, hinges: [3] }));
		expectRel(r.reactions[1]!.fy, 1000);
		expectRel(r.reactions[0]!.fy, 4000);
		expectRel(r.reactions[0]!.mz, 7500);
		expectRel(at(r, 'M', 0), -7500);
		expect(Math.abs(at(r, 'M', 3, 'left'))).toBeLessThan(1e-9);
		expect(Math.abs(at(r, 'M', 3, 'right'))).toBeLessThan(1e-9);
		expect(r.classification).toEqual({ stable: true, degree: 0 });
		// The slope jumps at the hinge but the deflection does not.
		expect(Math.abs(at(r, 'theta', 3, 'left') - at(r, 'theta', 3, 'right'))).toBeGreaterThan(1e-6);
		expectRel(at(r, 'v', 3, 'left'), at(r, 'v', 3, 'right'), 1e-12);
	});

	it('two equal spans 5 + 5 with UDL: middle reaction 6250, M over the middle support -3125', () => {
		const r = solveBeam(beam(10, [['pin', 0], ['roller', 5], ['roller', 10]], [dist(0, 10, -w)], { EI }));
		expectRel(r.reactions[1]!.fy, 6250);
		expectRel(r.reactions[0]!.fy, 1875);
		expectRel(at(r, 'M', 5), -3125);
		expect(r.classification.degree).toBe(1);
		expect(Math.abs(at(r, 'v', 5))).toBeLessThan(1e-15);
		expect(Math.abs(at(r, 'theta', 5))).toBeLessThan(1e-15);
	});

	it('hinge directly over the middle support of two spans: R = 2500 / 5000 / 2500', () => {
		const r = solveBeam(beam(10, [['pin', 0], ['roller', 5], ['roller', 10]], [dist(0, 10, -w)], { EI, hinges: [5] }));
		expectRel(r.reactions[0]!.fy, 2500);
		expectRel(r.reactions[1]!.fy, 5000);
		expectRel(r.reactions[2]!.fy, 2500);
		expect(Math.abs(at(r, 'M', 5))).toBeLessThan(1e-9);
		expect(r.classification).toEqual({ stable: true, degree: 0 });
		// Two independent simply supported spans: slopes ±wl³/(24EI) at the hinge.
		expectRel(at(r, 'theta', 5, 'left'), (w * 125) / (24 * EI));
		expectRel(at(r, 'theta', 5, 'right'), (-w * 125) / (24 * EI));
	});

	it('simply supported partial trapezoid 2 -> 6 N/m (down) on [1, 4]: RB = 6.6', () => {
		const r = solveBeam(beam(L, [['pin', 0], ['roller', L]], [dist(1, 4, -2, -6)]));
		expectRel(r.reactions[1]!.fy, 6.6);
		expectRel(r.reactions[0]!.fy, 5.4);
		expectRel(at(r, 'V', L, 'left'), -6.6);
		expect(r.hasDeflection).toBe(false);
		expect(r.segments.every((s) => s.v === undefined && s.theta === undefined)).toBe(true);
	});

	it('propped cantilever UDL: RA = 5wL/8, RB = 3wL/8, M(0) = -wL²/8, M(5L/8) = 9wL²/128', () => {
		const r = solveBeam(beam(L, [['fixed', 0], ['roller', L]], [udl], { EI }));
		expectRel(r.reactions[0]!.fy, (5 * w * L) / 8);
		expectRel(r.reactions[1]!.fy, (3 * w * L) / 8);
		expectRel(at(r, 'M', 0), (-w * L * L) / 8);
		expectRel(r.extrema.momentMax.value, (9 * w * L * L) / 128);
		expectX(r.extrema.momentMax.x, (5 * L) / 8, 'M max');
	});

	it('point items exactly on structural nodes are applied once', () => {
		// Load on a support goes straight into the reaction.
		let r = solveBeam(beam(L, [['pin', 0], ['roller', L]], [point(0, -P), point(L, -2 * P)]));
		expectRel(r.reactions[0]!.fy, P);
		expectRel(r.reactions[1]!.fy, 2 * P);
		expect(r.extrema.momentMax.value).toBe(0);
		expect(r.extrema.momentMin.value).toBe(0);
		expect(at(r, 'V', L / 2)).toBe(0);

		// Load on a hinge (shared deflection DOF).
		r = solveBeam(beam(L, [['fixed', 0], ['roller', L]], [point(3, -P)], { hinges: [3], EI }));
		expect(Math.abs(r.reactions[1]!.fy)).toBeLessThan(1e-9);
		expectRel(r.reactions[0]!.fy, P);
		expectRel(r.reactions[0]!.mz, 3 * P);
		expectRel(at(r, 'v', 3), (-P * 27) / (3 * EI));

		// Couple on a fixed support is taken by the support couple.
		r = solveBeam(beam(L, [['fixed', 0]], [couple(0, 500)], { EI }));
		expectRel(r.reactions[0]!.mz, -500);
		expect(r.extrema.momentMax.value).toBe(0);
		expect(r.extrema.momentMin.value).toBe(0);
		expect(r.extrema.deflectionMin!.value).toBe(0);

		// Couple at a free end: constant moment.
		r = solveBeam(beam(L, [['fixed', 0]], [couple(L, 500)], { EI }));
		expectRel(at(r, 'M', 0), 500);
		expectRel(at(r, 'M', L, 'left'), 500);
		expectRel(at(r, 'v', L), (500 * L * L) / (2 * EI));
	});
});

// ---------------------------------------------------------------------------
// D) Robustness
// ---------------------------------------------------------------------------

describe('D) robustness', () => {
	it('point load 1e-4·L from a support: relative error < 1e-8', () => {
		const L = 5;
		for (const d of [1e-4 * L, 1e-6 * L]) {
			// Overhang pin 0, roller 2, UDL 1000 down, P = 1000 down at 2 + d.
			const r = solveBeam(beam(L, [['pin', 0], ['roller', 2]], [dist(0, L, -1000), point(2 + d, -1000)]));
			expectRel(r.reactions[1]!.fy, 7250 + 500 * d, 1e-8, 'R2');
			expectRel(r.reactions[0]!.fy, -1250 - 500 * d, 1e-8, 'R0');
			// Cantilever with the load next to the clamp: v(L) = -P a²(3L - a)/(6EI).
			const EI = 2e5;
			const c = solveBeam(beam(L, [['fixed', 0]], [point(d, -1000)], { EI }));
			expectRel(at(c, 'v', L), (-1000 * d * d * (3 * L - d)) / (6 * EI), 1e-8, 'tip deflection');
			// Indeterminate version keeps equilibrium.
			const t = solveBeam(beam(L, [['fixed', 0], ['roller', 2], ['fixed', L]], [dist(0, L, -1000), point(2 + d, -1000)]));
			const sum = t.reactions.reduce((s, x) => s + x.fy, 0);
			expectRel(sum, 6000, 1e-12, 'sum of reactions');
		}
	});

	it.each([1000, 0.01, 5000])('L = %s: continuous and Gerber beams solve with exact scaled results', (L) => {
		const w = 3;
		const EI = 2e11 * 8e-5;
		// Two equal spans: 3/8 wl, 5/4 wl, 3/8 wl.
		const l = L / 2;
		const r = solveBeam(beam(L, [['pin', 0], ['roller', l], ['roller', L]], [dist(0, L, -w)], { EI }));
		expectRel(r.reactions[0]!.fy, (3 / 8) * w * l, 1e-9, 'R0');
		expectRel(r.reactions[1]!.fy, (5 / 4) * w * l, 1e-9, 'R1');
		expectRel(at(r, 'M', l), (-w * l * l) / 8, 1e-9, 'M over support');
		expectRel(r.extrema.deflectionMin!.value, (-0.0054161 * w * l ** 4) / EI, 1e-4, 'max deflection');
		// Gerber with a supported link at the same proportions as the stability tests.
		const g = solveBeam(
			beam(L, [['fixed', 0], ['roller', 0.3 * L], ['roller', L]], [dist(0, L, -w)], { hinges: [0.2 * L, 0.4 * L], EI }),
		);
		expect(g.classification).toEqual({ stable: true, degree: 0 });
		expect(Math.abs(at(g, 'M', 0.2 * L))).toBeLessThan(1e-9 * w * L * L);
		expect(Math.abs(at(g, 'M', 0.4 * L))).toBeLessThan(1e-9 * w * L * L);
		expect(Math.abs(g.residual.force)).toBeLessThan(1e-12 * w * L);
		// Four spans, fixed ends.
		const f = solveBeam(
			beam(
				L,
				[
					['fixed', 0],
					['roller', 0.25 * L],
					['roller', 0.5 * L],
					['roller', 0.75 * L],
					['fixed', L],
				],
				[dist(0, L, -w), point(0.6 * L, -w * L)],
				{ EI },
			),
		);
		expect(f.classification.degree).toBe(5);
		expect(Math.abs(f.residual.force)).toBeLessThan(1e-12 * 2 * w * L);
		expect(Math.abs(f.residual.moment)).toBeLessThan(1e-12 * 2 * w * L * L);
		for (const s of [0, 0.25, 0.5, 0.75, 1]) expect(Math.abs(at(f, 'v', s * L))).toBeLessThan(1e-9 * Math.abs(f.extrema.deflectionMin!.value));
	});

	it('works with realistic SI magnitudes (N, m, Pa, m^4)', () => {
		// 6 m steel beam, E = 200 GPa, I = 8000 cm^4, UDL 5 kN/m.
		const m: BeamModel = {
			units: 'kN-m',
			length: 6,
			supports: [
				{ kind: 'pin', x: 0 },
				{ kind: 'roller', x: 6 },
			],
			hinges: [],
			loads: [dist(0, 6, -5000)],
			E: 200e9,
			I: 8e-5,
		};
		const r = solveBeam(m);
		expectRel(r.extrema.deflectionMin!.value, -0.0052734375, 1e-9);
	});

	it.each([
		['a single roller', beam(5, [['roller', 2]], [dist(0, 5, -1)])],
		['no supports', beam(5, [], [dist(0, 5, -1)])],
		['pin and roller with a hinge between them', beam(5, [['pin', 0], ['roller', 5]], [dist(0, 5, -1)], { hinges: [2] })],
		[
			'fixed 0, roller 0.5, hinges 1 and 2, roller 5',
			beam(5, [['fixed', 0], ['roller', 0.5], ['roller', 5]], [dist(0, 5, -1)], { hinges: [1, 2] }),
		],
		['pin 0, rollers 2 and 4, hinge 5 (L = 6)', beam(6, [['pin', 0], ['roller', 2], ['roller', 4]], [], { hinges: [5] })],
		['two rollers closer than the merge tolerance', beam(5000, [['roller', 2000], ['roller', 2000.0000001]], [dist(0, 5000, -1)])],
	])('mechanism: %s throws BeamAnalysisError', (_name, m) => {
		expect(() => solveBeam(m)).toThrow(BeamAnalysisError);
		expect(() => solveBeam(m)).toThrow('The beam is unstable: it can move as a mechanism. Add a support or remove a hinge.');
	});

	it('supports and hinges very close together: accurate, or a clear error (never silent nonsense)', () => {
		// Reference values from scripts/oracle/beam_exact.py (exact fractions; its couples are clockwise).
		const udl = dist(0, 5, -1000);
		const d = 1e-5 * 5;
		const h = solveBeam(beam(5, [['fixed', 0], ['roller', 2], ['roller', 5]], [udl], { hinges: [2 + d] }));
		expectRel(h.reactions[0]!.fy, 1249.94375, 1e-8, 'R0');
		expectRel(h.reactions[0]!.mz, 499.9625, 1e-8, 'M0');
		expectRel(h.reactions[1]!.fy, 2250.08125, 1e-8, 'R1');
		expectRel(h.reactions[2]!.fy, 1499.975, 1e-8, 'R2');
		const s = solveBeam(beam(5, [['pin', 0], ['roller', 2], ['roller', 2 + d], ['roller', 5]], [udl]));
		expectRel(s.reactions[1]!.fy, -12498072.89973948, 1e-9, 'close rollers R1');
		expectRel(s.reactions[2]!.fy, 12501197.897570206, 1e-9, 'close rollers R2');
		// A hinge 50 nm from a support: the element in between is too short for
		// double precision, so the self-check refuses to answer.
		const bad = beam(5, [['fixed', 0], ['roller', 2], ['roller', 5]], [udl], { hinges: [2 + 1e-8 * 5] });
		expect(() => solveBeam(bad)).toThrow(BeamAnalysisError);
		expect(() => solveBeam(bad)).toThrow(/too close together/);
	});

	it('rejects positions outside the beam and a non-positive length', () => {
		expect(() => solveBeam(beam(5, [['pin', 0], ['roller', 5]], [point(6, -1)]))).toThrow(BeamAnalysisError);
		expect(() => solveBeam(beam(0, [['pin', 0]], []))).toThrow(BeamAnalysisError);
	});

	it('merges a load within 1e-9·L of a support onto the support', () => {
		const r = solveBeam(beam(5, [['pin', 0], ['roller', 5]], [point(5 - 1e-12, -10), point(2, -10)]));
		expect(r.keyPoints).toEqual([0, 2, 5]);
		expectRel(r.reactions[1]!.fy, 14);
	});

	it('beam without loads gives zero everywhere', () => {
		const r = solveBeam(beam(5, [['fixed', 0], ['roller', 5]], [], { EI: 1 }));
		expect(r.reactions.map((x) => [x.fy, x.mz])).toEqual([
			[0, 0],
			[0, 0],
		]);
		expect(r.extrema.momentMax).toEqual({ value: 0, x: 0 });
		expect(r.extrema.deflectionMin).toEqual({ value: 0, x: 0 });
		expect(r.shearZeros).toEqual([]);
	});
});
