import { describe, expect, it } from 'vitest';
import {
	polyAdd,
	polyDerivative,
	polyEval,
	polyIntegrate,
	polyRootsInInterval,
	polyScale,
} from '../src/core/polynomial';
import type { Poly } from '../src/core/types';

/** Expands prod (s - r_i) into ascending coefficients, for building test polynomials. */
function fromRoots(roots: number[], lead = 1): Poly {
	let p: Poly = [lead];
	for (const r of roots) {
		// p·(s - r) = -r·p + s·p
		const shifted = [0, ...p];
		p = polyAdd(shifted, polyScale(p, -r));
	}
	return p;
}

function expectRoots(actual: number[], expected: number[], tol = 1e-9): void {
	expect(actual.length).toBe(expected.length);
	expected.forEach((r, i) => expect(Math.abs(actual[i]! - r)).toBeLessThanOrEqual(tol));
}

describe('basic operations', () => {
	it('evaluates with Horner, including the empty polynomial', () => {
		expect(polyEval([1, 2, 3], 2)).toBe(1 + 4 + 12);
		expect(polyEval([], 5)).toBe(0);
		expect(polyEval([7], 1e6)).toBe(7);
	});

	it('adds polynomials of different length and scales', () => {
		expect(polyAdd([1, 2], [3, 4, 5])).toEqual([4, 6, 5]);
		expect(polyScale([1, -2, 3], -2)).toEqual([-2, 4, -6]);
	});

	it('differentiates, with [0] for a constant', () => {
		expect(polyDerivative([5, 3, 2, 1])).toEqual([3, 4, 3]);
		expect(polyDerivative([5])).toEqual([0]);
		expect(polyDerivative([])).toEqual([0]);
	});

	it('integrates with an integration constant and inverts the derivative', () => {
		expect(polyIntegrate([3, 4, 3], 5)).toEqual([5, 3, 2, 1]);
		expect(polyIntegrate([2])).toEqual([0, 2]);
		const p = [1.5, -2, 0.25, 4];
		expect(polyDerivative(polyIntegrate(p, 9))).toEqual(p);
	});
});

describe('polyRootsInInterval', () => {
	it('solves linear equations inside and outside the interval', () => {
		expectRoots(polyRootsInInterval([-2, 1], 0, 5), [2]);
		expect(polyRootsInInterval([-7, 1], 0, 5)).toEqual([]);
	});

	it('includes roots exactly on the interval ends', () => {
		expectRoots(polyRootsInInterval([-2, 1], 2, 5), [2]);
		expectRoots(polyRootsInInterval(fromRoots([0, 3]), 0, 3), [0, 3]);
	});

	it('solves quadratics: two roots, a double root, no real roots', () => {
		expectRoots(polyRootsInInterval(fromRoots([1, 4]), 0, 5), [1, 4]);
		expectRoots(polyRootsInInterval(fromRoots([2, 2]), 0, 5), [2]);
		expect(polyRootsInInterval([1, 0, 1], -10, 10)).toEqual([]);
	});

	it('is accurate when the leading coefficient is tiny (no cancellation)', () => {
		// 1e-20 s² + s - 1 = 0 has a root extremely close to 1
		expectRoots(polyRootsInInterval([-1, 1, 1e-20], 0, 2), [1], 1e-15);
		// and a nearly linear quadratic with roots 1e-9 and 1e9 stays accurate for the small one
		const p = fromRoots([1e-9, 1e9]);
		expectRoots(polyRootsInInterval(p, 0, 1), [1e-9], 1e-20);
	});

	it('ignores exactly-zero leading coefficients', () => {
		expectRoots(polyRootsInInterval([-3, 1, 0, 0], 0, 5), [3]);
	});

	it('returns [] for constants, the zero polynomial and empty intervals', () => {
		expect(polyRootsInInterval([0, 0, 0], 0, 1)).toEqual([]);
		expect(polyRootsInInterval([2], 0, 1)).toEqual([]);
		expect(polyRootsInInterval([-2, 1], 5, 0)).toEqual([]);
	});

	it('finds every root of cubics, quartics and quintics', () => {
		expectRoots(polyRootsInInterval(fromRoots([1, 2, 3]), 0, 4), [1, 2, 3], 1e-12);
		expectRoots(polyRootsInInterval(fromRoots([-2, 0.5, 3, 9], 2.5), 0, 4), [0.5, 3], 1e-12);
		expectRoots(polyRootsInInterval(fromRoots([0.5, 1.5, 2.5, 3.5, 4.5]), 0, 5), [0.5, 1.5, 2.5, 3.5, 4.5], 1e-11);
	});

	it('separates two roots closer than any sampling grid would', () => {
		// Close roots are ill-conditioned (error ~ eps / separation), hence 1e-8.
		const p = fromRoots([1, 1 + 1e-6, 3, -2]);
		expectRoots(polyRootsInInterval(p, 0, 4), [1, 1 + 1e-6, 3], 1e-8);
	});

	it('reports a double root of a quartic (touching zero)', () => {
		const p = fromRoots([2, 2, 5, -1]);
		expectRoots(polyRootsInInterval(p, 0, 4), [2], 1e-7);
	});

	it('returns sorted roots without duplicates', () => {
		const roots = polyRootsInInterval(fromRoots([3, 1, 2, 1]), 0, 4);
		expect(roots).toEqual([...roots].sort((a, b) => a - b));
		expect(new Set(roots).size).toBe(roots.length);
		expectRoots(roots, [1, 2, 3], 1e-7);
	});

	it('works on badly scaled local coordinates (long segments)', () => {
		// roots at 100 and 900 on a 1000 m segment
		expectRoots(polyRootsInInterval(fromRoots([100, 900, 2000, -50]), 0, 1000), [100, 900], 1e-8);
		// and on a 1 cm segment
		expectRoots(polyRootsInInterval(fromRoots([0.002, 0.007, 0.5]), 0, 0.01), [0.002, 0.007], 1e-15);
	});

	it.each([1e200, 1e-200, 1e300, 1e-300, 1e155, 1e-155])('does not depend on the magnitude of the coefficients (×%s)', (k) => {
		// Regression: c1² overflowed (k = 1e200) or underflowed (k = 1e-200) in
		// the quadratic formula, so the roots of k·(s - 1)(s - 4) came out wrong.
		expectRoots(polyRootsInInterval(polyScale(fromRoots([1, 4]), k), 0, 5), [1, 4], 1e-12);
		expectRoots(polyRootsInInterval(polyScale(fromRoots([2, 2]), k), 0, 5), [2], 1e-7);
		expect(polyRootsInInterval(polyScale([1, 0, 1], k), -10, 10)).toEqual([]);
		// Higher degrees recurse through the quadratic for their critical points.
		expectRoots(polyRootsInInterval(polyScale(fromRoots([0.5, 1.5, 2.5, 3.5, 4.5]), k), 0, 5), [0.5, 1.5, 2.5, 3.5, 4.5], 1e-11);
		expectRoots(polyRootsInInterval(polyScale([-2, 1], k), 0, 5), [2]);
	});

	it('gives exactly the same roots after scaling by a power of two (the normalisation is exact)', () => {
		for (const p of [fromRoots([1, 4]), fromRoots([0.5, 1.5, 2.5, 3.5, 4.5]), fromRoots([1, 1 + 1e-6, 3, -2]), [-1, 1, 1e-20]]) {
			const roots = polyRootsInInterval(p, 0, 5);
			expect(polyRootsInInterval(polyScale(p, 2 ** 40), 0, 5)).toEqual(roots);
			expect(polyRootsInInterval(polyScale(p, 2 ** -40), 0, 5)).toEqual(roots);
		}
	});
});
