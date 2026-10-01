/**
 * Dense linear algebra for small systems (tens of unknowns).
 * STUB: to be implemented.
 */

/** Thrown when a system has no unique solution. */
export class SingularMatrixError extends Error {
	constructor(message = 'Singular matrix') {
		super(message);
		this.name = 'SingularMatrixError';
	}
}

/**
 * Solves A·x = b. Uses symmetric Jacobi scaling (D^-1/2 A D^-1/2) followed by
 * Gaussian elimination with partial pivoting. Does not modify its inputs.
 * Throws SingularMatrixError when a scaled pivot is below `relTol`.
 */
export function solveLinearSystem(A: number[][], b: number[], relTol?: number): number[] {
	throw new Error('not implemented');
}

/** Numerical rank by Gaussian elimination with partial pivoting. */
export function matrixRank(A: number[][], tol?: number): number {
	throw new Error('not implemented');
}
