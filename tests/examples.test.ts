import { describe, expect, it } from 'vitest';
import type { BeamModel } from '../src/core/types';
import { BEAM_EXAMPLES, DEFAULT_BEAM_SOURCE } from '../src/core/examples';
import { buildModel } from '../src/core/model';
import { parseBeamSource } from '../src/core/parser';

/** Parses and builds with the plugin default units, asserting zero diagnostics. */
function cleanModel(source: string): BeamModel {
	const { ast, diagnostics } = parseBeamSource(source);
	expect(diagnostics).toEqual([]);
	const built = buildModel(ast, 'kN-m');
	expect(built.diagnostics).toEqual([]);
	if (!built.model) throw new Error('Expected a model');
	return built.model;
}

/** Looks up an example by id. */
function example(id: string): BeamModel {
	const found = BEAM_EXAMPLES.find((e) => e.id === id);
	if (!found) throw new Error(`Missing example ${id}`);
	return cleanModel(found.source);
}

describe('BEAM_EXAMPLES', () => {
	it('has the documented examples with unique ids', () => {
		expect(BEAM_EXAMPLES.map((e) => e.id)).toEqual([
			'simply-supported',
			'cantilever',
			'overhang',
			'propped',
			'continuous',
			'gerber',
			'fixed-fixed',
		]);
		expect(BEAM_EXAMPLES.map((e) => e.name)).toEqual([
			'Simply supported beam',
			'Cantilever with triangular load',
			'Overhanging beam (US units)',
			'Propped cantilever',
			'Two-span continuous beam',
			'Beam with an internal hinge',
			'Fixed-fixed beam',
		]);
	});

	it.each(BEAM_EXAMPLES.map((e) => [e.id, e]))('%s parses and builds with zero errors and zero warnings', (_id, e) => {
		cleanModel(e.source);
	});

	it.each(BEAM_EXAMPLES.map((e) => [e.id, e]))('%s has a title line and explanatory comments', (_id, e) => {
		const lines = e.source.split('\n');
		expect(lines[0]).toBe(`title ${e.name}`);
		expect(lines.some((l) => l.trim().startsWith('#'))).toBe(true);
		expect(e.source.endsWith('\n')).toBe(false);
		// No em dash anywhere in user-facing text.
		expect(e.source.includes(String.fromCharCode(0x2014))).toBe(false);
	});

	it('simply supported beam matches the documented results', () => {
		const m = example('simply-supported');
		expect(m.length).toBe(6);
		expect(m.E).toBe(200e9);
		expect(m.section?.shape).toBe('ibeam');
		expect((m.I ?? 0) / 1e-12).toBeCloseTo(79989869.46, 1);
		// Statics by hand: moments about A give R_B, vertical equilibrium gives R_A.
		let total = 0;
		let momentAboutA = 0;
		for (const load of m.loads) {
			if (load.kind === 'point') {
				total += load.fy;
				momentAboutA += load.fy * load.x;
			} else if (load.kind === 'distributed') {
				const resultant = load.q1 * (load.x2 - load.x1);
				total += resultant;
				momentAboutA += resultant * ((load.x1 + load.x2) / 2);
			}
		}
		const RB = -momentAboutA / m.length;
		const RA = -total - RB;
		expect(RA / 1e3).toBeCloseTo(18.67, 2);
		expect(RB / 1e3).toBeCloseTo(15.33, 2);
		// Shear is zero where R_A - 10 kN - 4 kN/m x = 0 (just past the point load).
		const x0 = (RA - 10e3) / 4e3;
		expect(x0).toBeCloseTo(2.17, 2);
		const Mmax = RA * x0 - 10e3 * (x0 - 2) - (4e3 * x0 ** 2) / 2;
		expect(Mmax / 1e3).toBeCloseTo(29.39, 2);
	});

	it('cantilever has a triangular load and a ccw end moment', () => {
		const m = example('cantilever');
		expect(m.supports).toEqual([{ kind: 'fixed', x: 0, line: 4 }]);
		expect(m.loads).toEqual([
			{ kind: 'distributed', x1: 0, x2: 3, q1: 0, q2: -6000, line: 6 },
			{ kind: 'moment', x: 3, mz: 5000, line: 8 },
		]);
		expect(m.section?.label).toBe('Rectangle 100 × 200 mm');
	});

	it('overhanging beam uses US units with explicit E and I', () => {
		const m = example('overhang');
		expect(m.units).toBe('kip-ft');
		expect(m.length).toBeCloseTo(9.144, 12);
		expect(m.supports.map((s) => s.x)).toEqual([0, 20 * 0.3048]);
		expect(m.E).toBeCloseTo(29000 * 6894757.293168361, 0);
		expect(m.I).toBeCloseTo(510 * 4.162314256e-7, 15);
	});

	it('propped cantilever, continuous beam and hinged beam have no stiffness inputs', () => {
		for (const id of ['propped', 'continuous', 'gerber']) {
			const m = example(id);
			expect(m.E).toBeUndefined();
			expect(m.I).toBeUndefined();
		}
		expect(example('continuous').supports.map((s) => s.x)).toEqual([0, 6, 12]);
		expect(example('gerber').hinges).toEqual([4]);
	});

	it('fixed-fixed beam uses timber with a rectangle', () => {
		const m = example('fixed-fixed');
		expect(m.supports.map((s) => s.kind)).toEqual(['fixed', 'fixed']);
		expect(m.E).toBe(11e9);
		expect(m.I).toBeCloseTo((0.1 * 0.25 ** 3) / 12, 15);
	});
});

describe('DEFAULT_BEAM_SOURCE', () => {
	it('builds cleanly and already enables deflection', () => {
		const m = cleanModel(DEFAULT_BEAM_SOURCE);
		expect(m.E).toBeGreaterThan(0);
		expect(m.I).toBeGreaterThan(0);
		expect(m.supports).toHaveLength(2);
		expect(m.loads.length).toBeGreaterThan(0);
	});

	it('explains the syntax with comments', () => {
		expect(DEFAULT_BEAM_SOURCE.split('\n').some((l) => l.startsWith('#'))).toBe(true);
	});
});
