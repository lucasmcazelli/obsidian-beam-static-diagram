/**
 * Dense linear algebra for small systems (tens of unknowns).
 *
 * A beam model has at most a few dozen structural nodes, so the stiffness
 * matrix is tiny and plain Gaussian elimination on a dense array is both the
 * simplest and the fastest option (no sparse storage, no dependencies).
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
 *
 * Why the scaling: beam stiffness terms mix 12EI/L³ (translations) with
 * 4EI/L (rotations), which differ by many orders of magnitude on very long or
 * very short beams. After scaling by d_i = 1/sqrt(|A_ii|) every nonzero
 * diagonal entry is 1, so one dimensionless pivot tolerance works for a
 * 0.01 m beam and a 1000 m beam alike. The scaling is undone on the result:
 * A x = b  <=>  (D A D)(D^-1 x) = D b  with D = diag(d_i).
 */
export function solveLinearSystem(A: number[][], b: number[], relTol = 1e-10): number[] {
	const n = b.length;
	if (A.length !== n || A.some((row) => row.length !== n)) {
		throw new Error('solveLinearSystem: A must be square with as many rows as b has entries');
	}
	if (n === 0) return [];
	if (!A.every((row) => row.every(Number.isFinite)) || !b.every(Number.isFinite)) {
		throw new SingularMatrixError('Matrix or right-hand side contains a non-finite number');
	}

	// d_i = 1/sqrt(|A_ii|), or 1 for a zero diagonal (nothing to normalise).
	const d = A.map((row, i) => {
		const aii = Math.abs(row[i]!);
		return aii > 0 ? 1 / Math.sqrt(aii) : 1;
	});
	const M = A.map((row, i) => row.map((v, j) => v * d[i]! * d[j]!));
	const y = b.map((v, i) => v * d[i]!);

	// Forward elimination with partial pivoting (largest |entry| in the column).
	for (let k = 0; k < n; k++) {
		let p = k;
		for (let i = k + 1; i < n; i++) {
			if (Math.abs(M[i]![k]!) > Math.abs(M[p]![k]!)) p = i;
		}
		if (!(Math.abs(M[p]![k]!) > relTol)) {
			throw new SingularMatrixError(`Singular matrix (pivot ${k} is zero after scaling)`);
		}
		if (p !== k) {
			[M[k], M[p]] = [M[p]!, M[k]!];
			[y[k], y[p]] = [y[p]!, y[k]!];
		}
		const rowK = M[k]!;
		const pivot = rowK[k]!;
		for (let i = k + 1; i < n; i++) {
			const rowI = M[i]!;
			const f = rowI[k]! / pivot;
			if (f === 0) continue;
			for (let j = k; j < n; j++) rowI[j]! -= f * rowK[j]!;
			y[i]! -= f * y[k]!;
		}
	}

	// Back substitution on the upper triangular system.
	const z = new Array<number>(n).fill(0);
	for (let i = n - 1; i >= 0; i--) {
		const rowI = M[i]!;
		let s = y[i]!;
		for (let j = i + 1; j < n; j++) s -= rowI[j]! * z[j]!;
		z[i] = s / rowI[i]!;
	}
	// Undo the scaling: x = D z.
	return z.map((v, i) => v * d[i]!);
}

/**
 * Numerical rank by Gaussian elimination with partial pivoting. A pivot with
 * |value| <= `tol` (absolute, default 1e-9) counts as zero, which suits
 * matrices whose entries are of order 1, like the constraint matrix of the
 * stability check (entries 0, ±1 and ±x/L). Does not modify its input.
 */
export function matrixRank(A: number[][], tol = 1e-9): number {
	const M = A.map((row) => row.slice());
	const rows = M.length;
	const cols = rows > 0 ? Math.max(...M.map((r) => r.length)) : 0;
	let rank = 0;
	for (let c = 0; c < cols && rank < rows; c++) {
		let p = rank;
		for (let i = rank + 1; i < rows; i++) {
			if (Math.abs(M[i]![c] ?? 0) > Math.abs(M[p]![c] ?? 0)) p = i;
		}
		// No usable pivot in this column: it adds nothing to the rank.
		if (!(Math.abs(M[p]![c] ?? 0) > tol)) continue;
		[M[rank], M[p]] = [M[p]!, M[rank]!];
		const rowR = M[rank]!;
		for (let i = rank + 1; i < rows; i++) {
			const rowI = M[i]!;
			const f = (rowI[c] ?? 0) / rowR[c]!;
			if (f === 0) continue;
			for (let j = c; j < cols; j++) rowI[j] = (rowI[j] ?? 0) - f * (rowR[j] ?? 0);
		}
		rank++;
	}
	return rank;
}
