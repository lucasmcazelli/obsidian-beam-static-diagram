/**
 * Small polynomial helpers. Coefficients are in ascending powers.
 * STUB: to be implemented.
 */
import type { Poly } from './types';

/** Evaluates p(s) with Horner's rule. */
export function polyEval(p: Poly, s: number): number {
	throw new Error('not implemented');
}

/** Returns p + q. */
export function polyAdd(p: Poly, q: Poly): Poly {
	throw new Error('not implemented');
}

/** Returns k·p. */
export function polyScale(p: Poly, k: number): Poly {
	throw new Error('not implemented');
}

/** Returns the derivative dp/ds. */
export function polyDerivative(p: Poly): Poly {
	throw new Error('not implemented');
}

/** Returns the antiderivative P with P(0) = c0. */
export function polyIntegrate(p: Poly, c0?: number): Poly {
	throw new Error('not implemented');
}

/**
 * Real roots of p in the closed interval [a, b], sorted ascending, without
 * duplicates. Exact for degree <= 2; sampling plus bisection otherwise.
 */
export function polyRootsInInterval(p: Poly, a: number, b: number): number[] {
	throw new Error('not implemented');
}
