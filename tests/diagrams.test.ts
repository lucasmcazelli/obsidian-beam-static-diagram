import { describe, expect, it } from 'vitest';
import { computeExtrema, evaluateAt, findShearZeros, sampleDiagram } from '../src/core/diagrams';
import { solveBeam } from '../src/core/solver';
import type { Segment } from '../src/core/types';

/**
 * Simply supported beam, L = 4, UDL w = 2 down, EI = 1, written by hand as
 * two segments split at x = 1 (the split must not change anything):
 *   q = -2, V = 4 - 2x, M = 4x - x²,
 *   theta = -w(L³ - 6Lx² + 4x³)/24, v = -w·x(L³ - 2Lx² + x³)/24.
 * Each polynomial is re-expanded in the local coordinate s = x - x0.
 */
function ssUdl(withDeflection = true): Segment[] {
	const w = 2;
	const L = 4;
	const make = (x0: number, x1: number): Segment => {
		const V0 = (w * L) / 2 - w * x0;
		const M0 = ((w * L) / 2) * x0 - (w / 2) * x0 * x0;
		const seg: Segment = { x0, x1, q: [-w, 0], V: [V0, -w, 0], M: [M0, V0, -w / 2, 0] };
		if (withDeflection) {
			const th = (x: number): number => (-w * (L ** 3 - 6 * L * x * x + 4 * x ** 3)) / 24;
			const v = (x: number): number => (-w * x * (L ** 3 - 2 * L * x * x + x ** 3)) / 24;
			// theta' = M, theta'' = V, theta''' = q
			seg.theta = [th(x0), M0, V0 / 2, -w / 6, 0];
			seg.v = [v(x0), th(x0), M0 / 2, V0 / 6, -w / 24, 0];
		}
		return seg;
	};
	return [make(0, 1), make(1, 4)];
}

describe('evaluateAt', () => {
	const segs = ssUdl();

	it('evaluates inside segments', () => {
		expect(evaluateAt(segs, 'M', 2)).toBeCloseTo(4, 12);
		expect(evaluateAt(segs, 'V', 3)).toBeCloseTo(-2, 12);
		expect(evaluateAt(segs, 'q', 0.5)).toBe(-2);
		expect(evaluateAt(segs, 'v', 2)).toBeCloseTo((-5 * 2 * 256) / 384, 12);
	});

	it('picks the left or right segment at a key point and clamps at the ends', () => {
		// A step: V jumps from 3 to -1 at x = 1.
		const step: Segment[] = [
			{ x0: 0, x1: 1, q: [0, 0], V: [3, 0, 0], M: [0, 3, 0, 0] },
			{ x0: 1, x1: 2, q: [0, 0], V: [-1, 0, 0], M: [3, -1, 0, 0] },
		];
		expect(evaluateAt(step, 'V', 1, 'left')).toBe(3);
		expect(evaluateAt(step, 'V', 1, 'right')).toBe(-1);
		expect(evaluateAt(step, 'V', 1)).toBe(-1);
		// within 1e-9·L of the key point counts as the key point
		expect(evaluateAt(step, 'V', 1 + 1e-12, 'left')).toBe(3);
		expect(evaluateAt(step, 'V', -5, 'left')).toBe(3);
		expect(evaluateAt(step, 'V', 0, 'left')).toBe(3);
		expect(evaluateAt(step, 'V', 2, 'right')).toBe(-1);
		expect(evaluateAt(step, 'M', 99)).toBe(2);
	});

	it('throws a clear error for deflection without E and I', () => {
		expect(() => evaluateAt(ssUdl(false), 'v', 1)).toThrow(/E and I/);
		expect(() => evaluateAt([], 'M', 1)).toThrow();
	});
});

describe('sampleDiagram', () => {
	it('samples both ends of every segment (default 24 points per segment)', () => {
		const s = sampleDiagram(ssUdl(), 'moment');
		expect(s.quantity).toBe('moment');
		expect(s.xs).toHaveLength(48);
		expect(s.ys).toHaveLength(48);
		expect(s.xs[0]).toBe(0);
		expect(s.xs[23]).toBe(1);
		expect(s.xs[24]).toBe(1);
		expect(s.xs[47]).toBe(4);
		expect(s.ys[47]).toBe(0);
		// sorted (non-decreasing) positions
		for (let i = 1; i < s.xs.length; i++) expect(s.xs[i]!).toBeGreaterThanOrEqual(s.xs[i - 1]!);
	});

	it('draws a jump as two points with the same x', () => {
		const step: Segment[] = [
			{ x0: 0, x1: 1, q: [0, 0], V: [3, 0, 0], M: [0, 3, 0, 0] },
			{ x0: 1, x1: 2, q: [0, 0], V: [-1, 0, 0], M: [3, -1, 0, 0] },
		];
		const s = sampleDiagram(step, 'shear', 3);
		expect(s.xs).toEqual([0, 0.5, 1, 1, 1.5, 2]);
		expect(s.ys).toEqual([3, 3, 3, -1, -1, -1]);
	});

	it('clamps the point count to at least 2 and samples deflection', () => {
		const s = sampleDiagram(ssUdl(), 'deflection', 1);
		expect(s.xs).toEqual([0, 1, 1, 4]);
		expect(s.ys[0]).toBe(0);
		expect(s.ys[3]).toBe(0);
		expect(s.ys[1]).toBeLessThan(0);
	});

	it('writes round-off sized values as exactly 0', () => {
		// Pure couple on a cantilever: V is round-off next to a 20 N·m moment.
		const segs: Segment[] = [{ x0: 0, x1: 1, q: [0, 0], V: [1e-17, 0, 0], M: [-20, 1e-17, 0, 0] }];
		const s = sampleDiagram(segs, 'shear', 2);
		expect(s.ys).toEqual([0, 0]);
		expect(Object.is(sampleDiagram([{ x0: 0, x1: 1, q: [0, 0], V: [-0, 0, 0], M: [1, 0, 0, 0] }], 'shear', 2).ys[0], 0)).toBe(true);
	});

	it('throws for deflection when it is not available', () => {
		expect(() => sampleDiagram(ssUdl(false), 'deflection')).toThrow(/E and I/);
	});
});

describe('computeExtrema', () => {
	it('finds the moment peak at the root of V and the deflection peak at the root of theta', () => {
		const ex = computeExtrema(ssUdl());
		expect(ex.momentMax.value).toBeCloseTo(4, 12);
		expect(ex.momentMax.x).toBeCloseTo(2, 12);
		expect(ex.momentMin).toEqual({ value: 0, x: 0 });
		expect(ex.shearMax).toEqual({ value: 4, x: 0 });
		expect(ex.shearMin).toEqual({ value: -4, x: 4 });
		expect(ex.deflectionMin!.value).toBeCloseTo((-5 * 2 * 256) / 384, 12);
		expect(ex.deflectionMin!.x).toBeCloseTo(2, 9);
		expect(ex.deflectionMax).toEqual({ value: 0, x: 0 });
		expect(ex.stressMax).toBeUndefined();
	});

	it('finds a shear peak where q changes sign inside a segment', () => {
		// q = 1 - s on [0, 2], V = s - s²/2: V is largest (0.5) at s = 1
		const segs: Segment[] = [{ x0: 0, x1: 2, q: [1, -1], V: [0, 1, -0.5], M: [0, 0, 0.5, -1 / 6] }];
		const ex = computeExtrema(segs);
		expect(ex.shearMax.value).toBeCloseTo(0.5, 14);
		expect(ex.shearMax.x).toBeCloseTo(1, 14);
		expect(ex.shearMin).toEqual({ value: 0, x: 0 });
	});

	it('omits deflection without theta and v, and computes stress from the section modulus', () => {
		const ex = computeExtrema(ssUdl(false), 0.5);
		expect(ex.deflectionMax).toBeUndefined();
		expect(ex.deflectionMin).toBeUndefined();
		// |M|max = 4 at x = 2, sigma = 4 / 0.5
		expect(ex.stressMax!.value).toBeCloseTo(8, 12);
		expect(ex.stressMax!.x).toBeCloseTo(2, 12);
		expect(computeExtrema(ssUdl(false), 0).stressMax).toBeUndefined();
	});

	it('uses the hogging moment for stress when it is the larger magnitude', () => {
		const segs: Segment[] = [
			{ x0: 0, x1: 1, q: [0, 0], V: [1, 0, 0], M: [-10, 1, 0, 0] },
			{ x0: 1, x1: 2, q: [0, 0], V: [1, 0, 0], M: [-9, 1, 0, 0] },
		];
		const ex = computeExtrema(segs, 2);
		expect(ex.stressMax).toEqual({ value: 5, x: 0 });
	});

	it('keeps the first occurrence on ties, including round-off ties', () => {
		const segs: Segment[] = [
			{ x0: 0, x1: 1, q: [0, 0], V: [0, 0, 0], M: [5, 0, 0, 0] },
			{ x0: 1, x1: 2, q: [0, 0], V: [0, 0, 0], M: [5 + 1e-14, 0, 0, 0] },
		];
		const ex = computeExtrema(segs);
		expect(ex.momentMax.x).toBe(0);
		expect(ex.momentMin.x).toBe(0);
	});

	it('reports round-off sized values as exactly 0 (never -0)', () => {
		const segs: Segment[] = [{ x0: 0, x1: 2, q: [0, 0], V: [-1e-15, 0, 0], M: [-20, -1e-15, 0, 0] }];
		const ex = computeExtrema(segs);
		expect(Object.is(ex.shearMax.value, 0)).toBe(true);
		expect(Object.is(ex.shearMin.value, 0)).toBe(true);
		expect(ex.momentMin.value).toBe(-20);
	});

	it('throws for an empty solution', () => {
		expect(() => computeExtrema([])).toThrow();
	});
});

describe('findShearZeros', () => {
	it('reports a crossing inside a segment', () => {
		const zeros = findShearZeros(ssUdl());
		expect(zeros).toHaveLength(1);
		expect(zeros[0]).toBeCloseTo(2, 14);
	});

	it('reports a jump through zero at the key point', () => {
		const step: Segment[] = [
			{ x0: 0, x1: 1, q: [0, 0], V: [3, 0, 0], M: [0, 3, 0, 0] },
			{ x0: 1, x1: 2, q: [0, 0], V: [-1, 0, 0], M: [3, -1, 0, 0] },
		];
		expect(findShearZeros(step)).toEqual([1]);
	});

	it('reports where V reaches zero before changing sign', () => {
		// V = 1 - s reaches 0 at the key point x = 1, then jumps to -2
		const segs: Segment[] = [
			{ x0: 0, x1: 1, q: [-1, 0], V: [1, -1, 0], M: [0, 1, -0.5, 0] },
			{ x0: 1, x1: 2, q: [0, 0], V: [-2, 0, 0], M: [0.5, -2, 0, 0] },
		];
		expect(findShearZeros(segs)).toEqual([1]);
	});

	it('ignores V touching zero and V staying at zero', () => {
		// V = (s - 1)² touches zero at s = 1 without changing sign
		const touch: Segment[] = [{ x0: 0, x1: 2, q: [-2, 2], V: [1, -2, 1], M: [0, 1, -1, 1 / 3] }];
		expect(findShearZeros(touch)).toEqual([]);
		// cantilever with a load at 4: V = 10 then exactly 0 up to the tip
		const tip: Segment[] = [
			{ x0: 0, x1: 4, q: [0, 0], V: [10, 0, 0], M: [-40, 10, 0, 0] },
			{ x0: 4, x1: 6, q: [0, 0], V: [0, 0, 0], M: [0, 0, 0, 0] },
		];
		expect(findShearZeros(tip)).toEqual([]);
		expect(findShearZeros([])).toEqual([]);
	});

	it('finds every sign change of a solved beam (two-span continuous)', () => {
		const r = solveBeam({
			units: 'kN-m',
			length: 12,
			supports: [
				{ kind: 'pin', x: 0 },
				{ kind: 'roller', x: 6 },
				{ kind: 'roller', x: 12 },
			],
			hinges: [],
			loads: [{ kind: 'distributed', x1: 0, x2: 12, q1: -5, q2: -5 }],
		});
		expect(r.shearZeros).toHaveLength(3);
		[2.25, 6, 9.75].forEach((x, i) => expect(r.shearZeros[i]).toBeCloseTo(x, 12));
	});
});
