import { describe, expect, it } from 'vitest';
import { matrixRank, SingularMatrixError, solveLinearSystem } from '../src/core/linalg';

function matVec(A: number[][], x: number[]): number[] {
	return A.map((row) => row.reduce((s, a, j) => s + a * x[j]!, 0));
}

describe('solveLinearSystem', () => {
	it('solves a small general system', () => {
		const A = [
			[2, 1, -1],
			[-3, -1, 2],
			[-2, 1, 2],
		];
		const x = solveLinearSystem(A, [8, -11, -3]);
		[2, 3, -1].forEach((v, i) => expect(x[i]).toBeCloseTo(v, 12));
	});

	it('does not modify its inputs', () => {
		const A = [
			[4, 1],
			[1, 3],
		];
		const b = [1, 2];
		const copyA = A.map((r) => r.slice());
		solveLinearSystem(A, b);
		expect(A).toEqual(copyA);
		expect(b).toEqual([1, 2]);
	});

	it('pivots when a diagonal entry is zero', () => {
		const x = solveLinearSystem(
			[
				[0, 1],
				[1, 0],
			],
			[2, 3],
		);
		expect(x).toEqual([3, 2]);
	});

	it('handles beam-like scaling (entries spanning 18 orders of magnitude)', () => {
		// Stiffness of a 1000 m element with EI = 1 next to a 1 cm element.
		const k = (L: number): number[][] => [
			[12 / L ** 3, 6 / L ** 2],
			[6 / L ** 2, 4 / L],
		];
		const big = k(0.01);
		const small = k(1000);
		const A = [
			[big[0]![0]! + small[0]![0]!, big[0]![1]!, small[0]![1]!],
			[big[1]![0]!, big[1]![1]!, 0],
			[small[1]![0]!, 0, small[1]![1]!],
		];
		const xTrue = [1e-6, -3e-4, 2.5];
		const x = solveLinearSystem(A, matVec(A, xTrue));
		xTrue.forEach((v, i) => expect(Math.abs(x[i]! - v)).toBeLessThanOrEqual(1e-9 * Math.abs(v)));
	});

	it('returns [] for an empty system', () => {
		expect(solveLinearSystem([], [])).toEqual([]);
	});

	it('throws SingularMatrixError for singular and nearly singular matrices', () => {
		expect(() =>
			solveLinearSystem(
				[
					[1, 2],
					[2, 4],
				],
				[1, 2],
			),
		).toThrow(SingularMatrixError);
		expect(() =>
			solveLinearSystem(
				[
					[1, 1],
					[1, 1 + 1e-13],
				],
				[1, 2],
			),
		).toThrow(SingularMatrixError);
		expect(() => solveLinearSystem([[0]], [1])).toThrow(SingularMatrixError);
	});

	it('rejects non-finite input and mismatched sizes', () => {
		expect(() => solveLinearSystem([[Number.NaN]], [1])).toThrow(SingularMatrixError);
		expect(() => solveLinearSystem([[1, 2]], [1])).toThrow(/square/);
		expect(() => solveLinearSystem([[1]], [1, 2])).toThrow(/square/);
	});
});

describe('matrixRank', () => {
	it('computes the rank of full, deficient, rectangular and empty matrices', () => {
		expect(
			matrixRank([
				[1, 0, 0],
				[0, 1, 0],
				[0, 0, 1],
			]),
		).toBe(3);
		expect(
			matrixRank([
				[1, 2, 3],
				[4, 5, 6],
				[5, 7, 9],
			]),
		).toBe(2);
		expect(
			matrixRank([
				[1, 0.5, 0, 0],
				[0, 0, 1, 0.25],
			]),
		).toBe(2);
		expect(
			matrixRank([
				[0, 0],
				[0, 0],
			]),
		).toBe(0);
		expect(matrixRank([])).toBe(0);
	});

	it('uses the tolerance to ignore round-off sized pivots', () => {
		const A = [
			[1, 0.4],
			[1, 0.4 + 1e-12],
		];
		expect(matrixRank(A)).toBe(1);
		expect(matrixRank(A, 1e-15)).toBe(2);
	});

	it('does not modify its input', () => {
		const A = [
			[2, 4],
			[1, 3],
		];
		matrixRank(A);
		expect(A).toEqual([
			[2, 4],
			[1, 3],
		]);
	});
});
