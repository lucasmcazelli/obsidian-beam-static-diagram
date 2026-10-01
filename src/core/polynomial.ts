/**
 * Small polynomial helpers for the exact piecewise solution.
 *
 * Inside a segment every quantity (q, V, M, theta, v) is a polynomial of the
 * LOCAL coordinate s = x - x0, stored as coefficients in ascending powers:
 * p(s) = c[0] + c[1]·s + c[2]·s² + ...
 * Local coordinates keep the coefficients well scaled: powers of a global x
 * up to x^5 would lose many digits on a 1000 m beam.
 */
import type { Poly } from './types';

/** Evaluates p(s) with Horner's rule (one multiply-add per coefficient). */
export function polyEval(p: Poly, s: number): number {
	let acc = 0;
	for (let i = p.length - 1; i >= 0; i--) acc = acc * s + p[i]!;
	return acc;
}

/** Returns p + q (the result is as long as the longer input). */
export function polyAdd(p: Poly, q: Poly): Poly {
	const n = Math.max(p.length, q.length);
	const out: Poly = [];
	for (let i = 0; i < n; i++) out.push((p[i] ?? 0) + (q[i] ?? 0));
	return out;
}

/** Returns k·p. */
export function polyScale(p: Poly, k: number): Poly {
	return p.map((c) => c * k);
}

/** Returns the derivative dp/ds. A constant gives [0] so the result is never empty. */
export function polyDerivative(p: Poly): Poly {
	if (p.length <= 1) return [0];
	const out: Poly = [];
	// d/ds (c_i s^i) = i·c_i s^(i-1)
	for (let i = 1; i < p.length; i++) out.push(i * p[i]!);
	return out;
}

/** Returns the antiderivative P with P(0) = c0 (default 0). */
export function polyIntegrate(p: Poly, c0 = 0): Poly {
	const out: Poly = [c0];
	// integral of c_i s^i is c_i s^(i+1) / (i+1)
	for (let i = 0; i < p.length; i++) out.push(p[i]! / (i + 1));
	return out;
}

/**
 * Real roots of p in the closed interval [a, b], sorted ascending, without
 * duplicates.
 *
 * - Degree 1 and 2 are solved in closed form (the quadratic uses the
 *   cancellation-free formula, so a tiny leading coefficient is harmless).
 * - Degree 3 and higher are isolated with the roots of the derivative: between
 *   two consecutive critical points p is monotonic, so it has at most one root
 *   there and bisection on a sign change finds it to full precision. The
 *   critical points come from the same function applied to p' (recursion ends
 *   at the exact quadratic). Unlike plain sampling this never misses two close
 *   roots.
 * - A double root (p touches zero at a critical point) is reported when |p| is
 *   at round-off level there.
 * - The identically zero polynomial returns [] (it has no isolated roots).
 * - The coefficients are first scaled by a power of two (see
 *   normalizeScale), so the result does not depend on their magnitude.
 */
export function polyRootsInInterval(p: Poly, a: number, b: number): number[] {
	if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return [];
	const c = trimTrailingZeros(normalizeScale(p));
	const degree = c.length - 1;
	if (degree <= 0) return [];

	let candidates: number[];
	if (degree === 1) candidates = [-c[0]! / c[1]!];
	else if (degree === 2) candidates = quadraticRoots(c[0]!, c[1]!, c[2]!);
	else candidates = isolateRoots(c, a, b);

	// Accept roots that round-off pushed just outside the interval, then clamp.
	const tol = 1e-12 * (b - a);
	const inside = candidates
		.filter((r) => Number.isFinite(r) && r >= a - tol && r <= b + tol)
		.map((r) => Math.min(b, Math.max(a, r)))
		.sort((x, y) => x - y);

	const out: number[] = [];
	for (const r of inside) {
		const last = out[out.length - 1];
		if (last === undefined || r - last > tol) out.push(r);
	}
	return out;
}

/**
 * Returns p scaled by a power of two so that its largest coefficient is
 * about 1 (p itself when it is zero or not finite). The roots are the same,
 * but the quadratic formula no longer squares coefficients beyond 1e154
 * (c1² overflows to Infinity, the discriminant becomes NaN) or below 1e-154
 * (c1² underflows to 0 and every quadratic looks like a double root). An
 * extreme E (1e200 Pa, or 1e-150 Pa) puts the slope polynomial in that
 * range, and the deflection extreme of a simply supported beam then came
 * out 5 % low and at the wrong position.
 * Multiplying by a power of two is exact, so for ordinary coefficients every
 * root is bit for bit what it was without the scaling.
 */
function normalizeScale(p: Poly): Poly {
	let max = 0;
	for (const c of p) max = Math.max(max, Math.abs(c));
	if (!(max > 0 && Number.isFinite(max))) return p;
	// Clamped so the factor itself stays a normal double (2^±1022). The
	// caller trims afterwards: a negligible leading term may underflow to 0.
	const exponent = Math.max(-1022, Math.min(1022, -Math.round(Math.log2(max))));
	if (exponent === 0) return p;
	const factor = 2 ** exponent;
	return p.map((c) => c * factor);
}

/** Drops exactly-zero highest-order coefficients so the degree is the true degree. */
function trimTrailingZeros(p: Poly): Poly {
	let n = p.length;
	while (n > 0 && p[n - 1] === 0) n--;
	return p.slice(0, n);
}

/**
 * Real roots of c2·s² + c1·s + c0 (c2 != 0), in any order.
 * Uses q = -(c1 + sign(c1)·sqrt(disc)) / 2, roots q/c2 and c0/q, which avoids
 * subtracting two nearly equal numbers (Numerical Recipes, section 5.6).
 */
function quadraticRoots(c0: number, c1: number, c2: number): number[] {
	const disc = c1 * c1 - 4 * c2 * c0;
	// A double root often comes out with a discriminant of -1e-17 instead of 0:
	// anything within round-off of zero is treated as exactly zero.
	const discTol = 8 * Number.EPSILON * (c1 * c1 + 4 * Math.abs(c2 * c0));
	if (disc < -discTol) return [];
	const sq = disc > 0 ? Math.sqrt(disc) : 0;
	const q = -0.5 * (c1 + (c1 >= 0 ? sq : -sq));
	// q is zero only when c1 = 0 and disc = 0, i.e. c0 = 0 too: double root at 0.
	if (q === 0) return [0];
	return [q / c2, c0 / q];
}

/** Roots of a polynomial of degree >= 3 in [a, b], isolated by its critical points. */
function isolateRoots(c: Poly, a: number, b: number): number[] {
	const critical = polyRootsInInterval(polyDerivative(c), a, b);
	const breaks = [a, ...critical.filter((x) => x > a && x < b), b];
	// Horner's rounding error is about degree·eps·sum(|c_i|·|s|^i): values below
	// that are indistinguishable from zero (this is how double roots show up).
	const degree = c.length - 1;
	const value = (s: number): number => {
		const v = polyEval(c, s);
		let magnitude = 0;
		for (let i = c.length - 1; i >= 0; i--) magnitude = magnitude * Math.abs(s) + Math.abs(c[i]!);
		return Math.abs(v) <= 4 * degree * Number.EPSILON * magnitude ? 0 : v;
	};

	const roots: number[] = [];
	let left = breaks[0]!;
	let fLeft = value(left);
	for (let k = 1; k < breaks.length; k++) {
		const right = breaks[k]!;
		const fRight = value(right);
		if (fLeft === 0) roots.push(left);
		else if (fRight !== 0 && (fLeft < 0) !== (fRight < 0)) roots.push(bisect(c, left, right, fLeft));
		left = right;
		fLeft = fRight;
	}
	if (fLeft === 0) roots.push(left);
	return roots;
}

/** Bisection on [lo, hi] where p(lo) = fLo and p changes sign; runs to full double precision. */
function bisect(c: Poly, lo: number, hi: number, fLo: number): number {
	for (let it = 0; it < 200; it++) {
		const mid = 0.5 * (lo + hi);
		// Stop when the interval can no longer be split in floating point.
		if (mid <= lo || mid >= hi) break;
		const fMid = polyEval(c, mid);
		if (fMid === 0) return mid;
		if ((fMid < 0) === (fLo < 0)) {
			lo = mid;
			fLo = fMid;
		} else {
			hi = mid;
		}
	}
	return 0.5 * (lo + hi);
}
