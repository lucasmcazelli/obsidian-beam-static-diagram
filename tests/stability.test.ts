import { describe, expect, it } from 'vitest';
import { classifyBeam } from '../src/core/stability';
import type { Support, SupportKind } from '../src/core/types';

/** Builds the layout part of a model: length, supports as [kind, x] pairs, hinges. */
function layout(length: number, supports: [SupportKind, number][], hinges: number[] = []) {
	const list: Support[] = supports.map(([kind, x]) => ({ kind, x }));
	return { length, supports: list, hinges };
}

describe('classifyBeam: mechanisms', () => {
	it.each([
		['a single roller', layout(5, [['roller', 2]])],
		['no supports at all', layout(5, [])],
		['a single pin', layout(5, [['pin', 0]])],
		['pin and roller at the same point', layout(5, [['pin', 2], ['roller', 2]])],
		['pin and roller with one hinge between them', layout(5, [['pin', 0], ['roller', 5]], [2])],
		// counting gives 4 reactions - 2 - 1 hinge... still the right part swings
		['pin 0, rollers 2 and 4, hinge 5 (L = 6)', layout(6, [['pin', 0], ['roller', 2], ['roller', 4]], [5])],
		// counting says determinate (4 - 2 - 2 = 0) but the link 1..2 is unsupported
		[
			'fixed 0, roller 0.5, hinges 1 and 2, roller 5 (L = 5)',
			layout(5, [['fixed', 0], ['roller', 0.5], ['roller', 5]], [1, 2]),
		],
		['cantilever with a hinge', layout(5, [['fixed', 0]], [3])],
		['two rollers 1e-12 m apart', layout(5, [['roller', 2], ['roller', 2 + 1e-12]])],
	])('flags %s', (_name, model) => {
		expect(classifyBeam(model)).toEqual({ stable: false, degree: null });
	});
});

describe('classifyBeam: stable layouts and degree of indeterminacy', () => {
	it.each([
		['simply supported', layout(5, [['pin', 0], ['roller', 5]]), 0],
		['cantilever', layout(5, [['fixed', 0]]), 0],
		['cantilever fixed at the right end', layout(5, [['fixed', 5]]), 0],
		['overhanging beam', layout(6, [['pin', 0], ['roller', 4]]), 0],
		['propped cantilever', layout(5, [['fixed', 0], ['roller', 5]]), 1],
		['fixed-fixed', layout(5, [['fixed', 0], ['fixed', 5]]), 2],
		['two-span continuous', layout(10, [['pin', 0], ['roller', 5], ['roller', 10]]), 1],
		['three-span continuous', layout(15, [['pin', 0], ['roller', 5], ['roller', 10], ['roller', 15]]), 2],
		['Gerber: fixed 0, hinge 3, roller 5', layout(5, [['fixed', 0], ['roller', 5]], [3]), 0],
		[
			'fixed 0, roller 1.5, hinges 1 and 2, roller 5 (supported link)',
			layout(5, [['fixed', 0], ['roller', 1.5], ['roller', 5]], [1, 2]),
			0,
		],
		['hinge directly over the middle roller of two spans', layout(10, [['pin', 0], ['roller', 5], ['roller', 10]], [5]), 0],
		['two rollers only (horizontal restraint is not modelled)', layout(5, [['roller', 0], ['roller', 5]]), 0],
		['pin and roller 1e-7 m apart (still distinct)', layout(5, [['pin', 2], ['roller', 2 + 1e-7]]), 0],
		['fixed support on a hinge clamps both sides', layout(6, [['fixed', 3]], [3]), 0],
	])('%s', (_name, model, degree) => {
		expect(classifyBeam(model)).toEqual({ stable: true, degree });
	});

	it('does not depend on the beam length (scale invariance)', () => {
		for (const L of [0.01, 1, 1000]) {
			expect(classifyBeam(layout(L, [['fixed', 0], ['roller', 0.3 * L], ['roller', L]], [0.2 * L, 0.4 * L]))).toEqual({
				stable: true,
				degree: 0,
			});
			expect(classifyBeam(layout(L, [['fixed', 0], ['roller', 0.1 * L], ['roller', L]], [0.2 * L, 0.4 * L]))).toEqual({
				stable: false,
				degree: null,
			});
		}
	});

	it('accepts unsorted hinges and supports', () => {
		expect(classifyBeam(layout(5, [['roller', 5], ['roller', 1.5], ['fixed', 0]], [2, 1]))).toEqual({
			stable: true,
			degree: 0,
		});
	});
});
