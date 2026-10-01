import { describe, expect, it } from 'vitest';
import type { BeamAst, BeamModel, Diagnostic, UnitSystemId } from '../src/core/types';
import { buildModel } from '../src/core/model';
import { emptyAst, parseBeamSource } from '../src/core/parser';
import { findMaterial, MATERIAL_IDS, MATERIALS } from '../src/core/materials';

/** Parses (asserting no syntax errors) and builds. */
function build(source: string, units: UnitSystemId = 'kN-m'): ReturnType<typeof buildModel> {
	const { ast, diagnostics } = parseBeamSource(source);
	expect(diagnostics).toEqual([]);
	return buildModel(ast, units);
}

/** Builds and asserts a model with no diagnostics at all. */
function model(source: string, units: UnitSystemId = 'kN-m'): BeamModel {
	const result = build(source, units);
	expect(result.diagnostics).toEqual([]);
	if (!result.model) throw new Error('Expected a model');
	return result.model;
}

/** Builds and returns the diagnostics, asserting there is no model. */
function errors(source: string, units: UnitSystemId = 'kN-m'): Diagnostic[] {
	const result = build(source, units);
	expect(result.model).toBeUndefined();
	return result.diagnostics.filter((d) => d.severity === 'error');
}

/** Builds and returns the warnings, asserting a model was produced. */
function warnings(source: string, units: UnitSystemId = 'kN-m'): { model: BeamModel; warnings: Diagnostic[] } {
	const result = build(source, units);
	if (!result.model) throw new Error(`Expected a model, got ${JSON.stringify(result.diagnostics)}`);
	expect(result.diagnostics.every((d) => d.severity === 'warning')).toBe(true);
	return { model: result.model, warnings: result.diagnostics };
}

const BASE = 'length 6 m\npin at 0\nroller at end';

describe('buildModel: basics', () => {
	it('builds a minimal beam in SI', () => {
		expect(model(BASE)).toEqual({
			units: 'kN-m',
			length: 6,
			supports: [
				{ kind: 'pin', x: 0, line: 2 },
				{ kind: 'roller', x: 6, line: 3 },
			],
			hinges: [],
			loads: [],
		});
	});

	it('uses the block units, falling back to the default', () => {
		expect(build(BASE, 'N-mm').units).toBe('N-mm');
		expect(model('length 6000\npin at 0', 'N-mm').length).toBe(6);
		const result = build(`units kip ft\nlength 30\npin at 0`, 'kN-m');
		expect(result.units).toBe('kip-ft');
		expect(result.model?.length).toBeCloseTo(9.144, 12);
		expect(result.model?.units).toBe('kip-ft');
	});

	it('copies the title', () => {
		expect(model(`title Beam A\n${BASE}`).title).toBe('Beam A');
	});

	it('sorts supports and hinges by position', () => {
		const m = model('length 10\nroller at 10\npin at 0\nroller at 5\nhinge at 7\nhinge at 2');
		expect(m.supports.map((s) => s.x)).toEqual([0, 5, 10]);
		expect(m.supports.map((s) => s.line)).toEqual([3, 4, 2]);
		expect(m.hinges).toEqual([2, 7]);
	});
});

describe('buildModel: positions', () => {
	it.each([
		['start', 0],
		['left', 0],
		['mid', 3],
		['middle', 3],
		['center', 3],
		['centre', 3],
		['end', 6],
		['right', 6],
		['END', 6],
		['2', 2],
		['2 m', 2],
		['1500 mm', 1.5],
		['150 cm', 1.5],
	])('resolves %s to x = %d', (at, x) => {
		expect(model(`length 6 m\npin at 0\npoint 1 kN at ${at}`).loads[0]).toMatchObject({ x });
	});

	it('snaps unit-conversion round-off to the beam ends', () => {
		// 36 in = 0.9143999... m while 3 ft = 0.9144000... m in floating point.
		const m = model('units kip ft\nlength 3 ft\npin at 0 in\nroller at 36 in');
		expect(m.supports[1]?.x).toBe(m.length);
	});

	it('rejects positions outside the beam, quoting the position as typed and the beam in the block units', () => {
		expect(errors(`${BASE}\npoint 1 at 7`)).toEqual([{ severity: 'error', message: 'Position 7 is outside the beam (0 to 6 m)', line: 4 }]);
		expect(errors(`${BASE}\npoint 1 at -1`)[0]?.message).toBe('Position -1 is outside the beam (0 to 6 m)');
		expect(errors('units kip ft\nlength 30\npin at 0\nroller at 40 ft')[0]?.message).toBe('Position 40 ft is outside the beam (0 to 30 ft)');
		expect(errors('length 6000\npin at 0\nroller at 6.5 m', 'N-mm')[0]?.message).toBe('Position 6.5 m is outside the beam (0 to 6000 mm)');
	});

	it('never rounds an out-of-beam position until it equals the limit', () => {
		// Regression: "at 6.0001" read "Position 6 m is outside the beam (0 to 6 m)".
		expect(errors(`${BASE}\npoint 1 at 6.0001`)[0]?.message).toBe('Position 6.0001 is outside the beam (0 to 6 m)');
		expect(errors(`${BASE}\npoint 1 at 6000.4 mm`)[0]?.message).toBe('Position 6000.4 mm is outside the beam (0 to 6 m)');
		// A bare "from" that borrows the unit of "to" is quoted with that unit.
		expect(errors(`${BASE}\nudl 1 from 7 to 8 m`)[0]?.message).toBe('Position 7 m is outside the beam (0 to 6 m)');
	});

	it('rejects a position with a non-length unit', () => {
		expect(errors(`${BASE}\npoint 1 at 2 kN`)[0]?.message).toContain('kN is not a length unit');
	});
});

describe('buildModel: sign convention', () => {
	it.each([
		['point 10 kN down at 2', -10000],
		['point 10 kN at 2', -10000],
		['point 10 kN up at 2', 10000],
		['point -10 kN down at 2', 10000],
		['point -10 kN up at 2', -10000],
	])('%s -> fy = %d N', (line, fy) => {
		expect(model(`${BASE}\n${line}`).loads[0]).toEqual({ kind: 'point', x: 2, fy, line: 4 });
	});

	it.each([
		['moment 5 kNm ccw at 3', 5000],
		['moment 5 kNm cw at 3', -5000],
		['moment -5 kNm ccw at 3', -5000],
		['moment -5 kNm cw at 3', 5000],
	])('%s -> mz = %d N·m', (line, mz) => {
		expect(model(`${BASE}\n${line}`).loads[0]).toEqual({ kind: 'moment', x: 3, mz, line: 4 });
	});

	it.each([
		['udl 4 kN/m down', -4000],
		['udl 4 kN/m', -4000],
		['udl 4 kN/m up', 4000],
		['udl -4 kN/m down', 4000],
	])('%s -> q = %d N/m over the whole beam', (line, q) => {
		expect(model(`${BASE}\n${line}`).loads[0]).toEqual({ kind: 'distributed', x1: 0, x2: 6, q1: q, q2: q, line: 4 });
	});

	it('converts linear loads and never produces -0', () => {
		const load = model(`${BASE}\nlinear 0 to 6 kN/m down from 1 to 4`).loads[0];
		expect(load).toEqual({ kind: 'distributed', x1: 1, x2: 4, q1: 0, q2: -6000, line: 4 });
		if (load?.kind === 'distributed') expect(Object.is(load.q1, 0)).toBe(true);
		expect(model(`${BASE}\nlinear 2 to -3 up`).loads[0]).toMatchObject({ q1: 2000, q2: -3000 });
	});

	it('uses the unit system for bare magnitudes', () => {
		expect(model('length 6000\npin at 0\npoint 10 at 2000', 'N-mm').loads[0]).toEqual({ kind: 'point', x: 2, fy: -10, line: 3 });
		const imperial = model('units kip ft\nlength 30\npin at 0\npoint 5 at 10').loads[0];
		expect(imperial).toMatchObject({ x: 3.048, fy: -22241.1080763025 });
	});
});

describe('buildModel: shared units', () => {
	it('lets a bare "from" borrow the unit of "to" (and the reverse)', () => {
		expect(model(`${BASE}\nudl 1 from 2 to 6 m`).loads[0]).toMatchObject({ x1: 2, x2: 6 });
		expect(model('length 6000\npin at 0\nudl 1 from 1 to 2 m', 'N-mm').loads[0]).toMatchObject({ x1: 1, x2: 2 });
		expect(model('length 6000\npin at 0\nudl 1 from 1 m to 2', 'N-mm').loads[0]).toMatchObject({ x1: 1, x2: 2 });
	});

	it('lets a bare linear start borrow the unit of the end value', () => {
		const load = model('length 6000\npin at 0\nlinear 2 to 6 kN/m', 'N-mm').loads[0];
		expect(load).toMatchObject({ q1: -2000, q2: -6000 });
	});

	it('does not share with keywords', () => {
		expect(model(`${BASE}\nudl 1 from 2 to end`).loads[0]).toMatchObject({ x1: 2, x2: 6 });
	});
});

describe('buildModel: errors', () => {
	it('requires a length', () => {
		expect(errors('pin at 0')).toEqual([{ severity: 'error', message: 'Add a length, for example: length 6 m' }]);
	});

	it('requires a positive length with a length unit', () => {
		expect(errors('length 0\npin at 0')[0]).toEqual({
			severity: 'error',
			message: 'The length must be greater than zero, for example: length 6 m',
			line: 1,
		});
		expect(errors('length -3 m\npin at 0')[0]?.message).toContain('greater than zero');
		expect(errors('length 6 kN\npin at 0')[0]?.message).toContain('kN is not a length unit');
	});

	it('rejects lengths outside the range the solver handles accurately', () => {
		// Regression: "length 1e-300 m" and "length 1e308 ft" ended in a misleading "supports too close together".
		const message = 'The length is outside the supported range (1 µm to 100 km): check its unit';
		expect(errors('length 1e-7 m\npin at 0')).toEqual([{ severity: 'error', message, line: 1 }]);
		expect(errors('length 2e5 m\npin at 0')[0]?.message).toBe(message);
		expect(errors('units kip ft\nlength 1e306 ft\npin at 0')[0]?.message).toBe(message);
		expect(model('length 0.001 mm\npin at 0').length).toBeCloseTo(1e-6, 18);
		expect(model('length 100 km'.replace(' km', '000 m') + '\npin at 0').length).toBe(1e5);
	});

	it('does not cascade from a missing length', () => {
		expect(errors('pin at 0\nroller at end\npoint 1 at mid')).toHaveLength(1);
	});

	it('requires a support', () => {
		expect(errors('length 6')).toEqual([{ severity: 'error', message: 'Add at least one support, for example: pin at 0' }]);
	});

	it('rejects two supports at the same position', () => {
		expect(errors('length 6\npin at 0\nroller at start')).toEqual([
			{ severity: 'error', message: 'Two supports at x = 0 m: remove one or move it', line: 3 },
		]);
		expect(errors('length 6\npin at 3\nroller at 3000 mm')[0]?.line).toBe(3);
	});

	it('rejects hinges at the ends, suggesting a pinned support', () => {
		expect(errors(`${BASE}\nhinge at 0`)).toEqual([
			{ severity: 'error', message: 'A hinge must be strictly inside the beam: for a pinned support write pin at 0', line: 4 },
		]);
		expect(errors(`${BASE}\nhinge at end`)[0]?.message).toBe('A hinge must be strictly inside the beam: for a pinned support write pin at end');
	});

	it('rejects two hinges at the same position', () => {
		expect(errors('length 6\nfixed at 0\nhinge at 2\nhinge at 2 m\nroller at 6')).toEqual([
			{ severity: 'error', message: 'Two hinges at x = 2 m: remove one', line: 4 },
		]);
	});

	it('rejects a hinge on a fixed support but allows one on a roller', () => {
		expect(errors('length 6\nfixed at 3\nhinge at 3')).toEqual([
			{ severity: 'error', message: 'A hinge cannot sit on a fixed support: the result would be ambiguous', line: 3 },
		]);
		expect(model('length 6\nfixed at 0\nroller at 3\nhinge at 3\nroller at 6').hinges).toEqual([3]);
	});

	it('rejects a moment exactly at a hinge', () => {
		expect(errors('length 6\nfixed at 0\nhinge at 3\nroller at 6\nmoment 5 kNm cw at 3')).toEqual([
			{ severity: 'error', message: 'A moment cannot act exactly at a hinge: move it slightly to one side', line: 5 },
		]);
		// A point load at a hinge is fine.
		expect(model('length 6\nfixed at 0\nhinge at 3\nroller at 6\npoint 5 at 3').loads).toHaveLength(1);
	});

	it('rejects a distributed load that does not start before it ends, quoting the ends as typed', () => {
		expect(errors(`${BASE}\nudl 1 from 4 to 2`)).toEqual([
			{ severity: 'error', message: 'The load must start before it ends: "from" (4) must be less than "to" (2)', line: 4 },
		]);
		expect(errors(`${BASE}\nlinear 1 to 2 from 3 to 3`)[0]?.message).toContain('must start before it ends');
		// Regression: "from 3.0001 to 3" read '"from" (3 m) must be less than "to" (3 m)'.
		expect(errors(`${BASE}\nudl 5 kN/m from 3.0001 to 3`)[0]?.message).toBe(
			'The load must start before it ends: "from" (3.0001) must be less than "to" (3)',
		);
		expect(errors(`${BASE}\nudl 1 from 4 to 2 m`)[0]?.message).toBe('The load must start before it ends: "from" (4 m) must be less than "to" (2 m)');
	});

	it('rejects a distributed load too short for the solver to keep', () => {
		// Regression: such loads passed validation and the solver dropped them silently (reactions 0).
		const message = 'This distributed load is too short to analyse: make it longer or use a point load';
		expect(errors('length 6000 m\npin at 0\nroller at end\nudl 1e6 kN/m from 2 to 2.000005')).toEqual([{ severity: 'error', message, line: 4 }]);
		expect(errors(`${BASE}\nudl 1e12 kN/m from 2 to 2.000000001`)[0]?.message).toBe(message);
		// 1.8 times the merge tolerance, straddling a support: both ends can snap to it.
		expect(errors('length 6000 m\npin at 0\nroller at 3000\nroller at end\nudl 1e9 kN/m from 2999.9999946 to 3000.0000054')[0]?.message).toBe(message);
		// Just over twice the tolerance is kept.
		expect(model(`${BASE}\nudl 1 kN/m from 2 to 2.0000000121`).loads).toHaveLength(1);
	});

	it('rejects a half-specified extent in an AST built by the editor', () => {
		const ast: BeamAst = {
			...emptyAst(),
			length: '6',
			supports: [{ kind: 'pin', at: '0' }],
			loads: [{ kind: 'udl', magnitude: '1', direction: 'down', from: '1' }],
		};
		const result = buildModel(ast, 'kN-m');
		expect(result.model).toBeUndefined();
		expect(result.diagnostics).toEqual([{ severity: 'error', message: 'Give both "from" and "to", or neither to load the whole beam' }]);
	});

	it('reports unit errors on loads', () => {
		expect(errors(`${BASE}\npoint 4 kN/m at 2`)[0]?.message).toBe('kN/m is not a force unit: use kN, N, kip or lb');
		expect(errors(`${BASE}\nmoment 4 kN cw at 2`)[0]?.message).toContain('kN is not a moment unit');
		expect(errors(`${BASE}\nudl 4 kN`)[0]?.message).toContain('kN is not a distributed load unit');
	});

	it('rejects unknown materials and lists the valid names', () => {
		expect(errors(`${BASE}\nmaterial brass\nsection rect 1 x 2 mm`)).toEqual([
			{
				severity: 'error',
				message: 'Unknown material "brass": use steel, stainless, aluminium, timber or concrete, or give E directly, for example: E 200 GPa',
				line: 4,
			},
		]);
	});

	it('requires units on E and I with examples for the unit system', () => {
		expect(errors(`${BASE}\nE 200\nI 8000 cm^4`)).toEqual([
			{ severity: 'error', message: 'Add a unit to E, for example: E 200 GPa', line: 4 },
		]);
		expect(errors(`${BASE}\nE 200 GPa\nI 8000`)).toEqual([
			{ severity: 'error', message: 'Add a unit to I, for example: I 8000 cm^4', line: 5 },
		]);
		expect(errors('units kip ft\nlength 30\npin at 0\nE 29000\nI 510 in^4')[0]?.message).toBe('Add a unit to E, for example: E 29000 ksi');
		expect(errors('length 6000\npin at 0\nE 200 GPa\nI 80', 'N-mm')[0]?.message).toBe('Add a unit to I, for example: I 80000000 mm^4');
	});

	it('requires positive E and I with the right units', () => {
		expect(errors(`${BASE}\nE 0 GPa\nI 1 cm^4`)[0]?.message).toBe('E must be greater than zero');
		expect(errors(`${BASE}\nE 200 GPa\nI -1 cm^4`)[0]?.message).toBe('I must be greater than zero');
		expect(errors(`${BASE}\nE 200 kN\nI 1 cm^4`)[0]?.message).toContain('kN is not a modulus unit');
	});

	it('reports unknown units in an AST built by the editor', () => {
		const ast: BeamAst = { ...emptyAst(), length: '6', supports: [{ kind: 'pin', at: '0' }], E: '200 GPa', I: '1 cm^3', lines: { I: 3 } };
		expect(buildModel(ast, 'kN-m').diagnostics).toEqual([
			{ severity: 'error', message: 'Unknown unit "cm^3": use cm^4, mm^4, in^4 or m^4', line: 3 },
		]);
	});

	it('rejects invalid section geometry and units', () => {
		expect(errors(`${BASE}\nmaterial steel\nsection tube 60 x 30 mm`)).toEqual([
			{ severity: 'error', message: 'The wall thickness t must be less than half the diameter d', line: 5 },
		]);
		expect(errors(`${BASE}\nmaterial steel\nsection rect 100 x 200 kN`)[0]?.message).toContain('kN is not a length unit');
		expect(errors(`${BASE}\nmaterial steel\nsection rect 0 x 200 mm`)[0]?.message).toBe('Section dimensions must be greater than zero');
	});

	it('rejects sections whose properties overflow or underflow', () => {
		// Regression: "I = Infinity cm⁴" and "I = 0 cm⁴" with the deflection silently gone.
		const message = 'The section properties cannot be computed for these dimensions: check their size and unit';
		expect(errors(`${BASE}\nmaterial steel\nsection rect 1e300 x 1e300 mm`)).toEqual([{ severity: 'error', message, line: 5 }]);
		expect(errors(`${BASE}\nmaterial steel\nsection rect 1e-200 x 1e-200 m`)[0]?.message).toBe(message);
	});

	it('requires a unit on section dimensions where bare numbers would be mm or in but lengths are m or ft', () => {
		// Regression: "section rect 0.1 x 0.2" in kN m (meant as metres) gave I = 6.67e-9 cm⁴ and
		// a deflection of 3.37e12 mm, with only a "small-deflection theory" warning.
		expect(errors(`${BASE}\nmaterial steel\nsection rect 0.1 x 0.2`)).toEqual([
			{ severity: 'error', message: 'Add a unit to the section dimensions, for example: section rect 100 x 200 mm', line: 5 },
		]);
		expect(errors('units kip ft\nlength 10\npin at 0\nE 29000 ksi\nsection rect 0.5 x 1')[0]?.message).toBe(
			'Add a unit to the section dimensions, for example: section rect 4 x 8 in',
		);
		// One bare dimension among per-dimension units is just as ambiguous.
		expect(errors(`${BASE}\nE 200 GPa\nsection rect 100 mm x 200`)[0]?.message).toContain('Add a unit to the section dimensions');
		// The missing unit is reported once, without a misleading deflection warning.
		expect(build(`${BASE}\nE 200 GPa\nsection circle 100`).diagnostics).toHaveLength(1);
	});

	it('reports every independent error, sorted by line, whole-beam issues last', () => {
		const result = build('point 1 at 2\nE 200\nhinge at 0');
		expect(result.model).toBeUndefined();
		expect(result.diagnostics.map((d) => [d.line, d.message])).toEqual([
			[2, 'Add a unit to E, for example: E 200 GPa'],
			[undefined, 'Add a length, for example: length 6 m'],
			[undefined, 'Add at least one support, for example: pin at 0'],
			[undefined, 'Deflection needs both a material or E, and a section or I'],
		]);
	});
});

describe('buildModel: warnings', () => {
	it.each([
		['point 0 kN at 2', 'This point load is zero and is ignored'],
		['moment 0 cw at 2', 'This moment is zero and is ignored'],
		['udl 0', 'This distributed load is zero and is ignored'],
		['linear 0 to 0', 'This distributed load is zero and is ignored'],
	])('ignores the zero load %s', (line, message) => {
		const result = warnings(`${BASE}\n${line}`);
		expect(result.warnings).toEqual([{ severity: 'warning', message, line: 4 }]);
		expect(result.model.loads).toEqual([]);
	});

	it('keeps a linear load with one zero end', () => {
		expect(model(`${BASE}\nlinear 0 to 1`).loads).toHaveLength(1);
	});

	it('warns that E overrides the material preset', () => {
		const result = warnings(`${BASE}\nmaterial steel\nE 210 GPa\nsection rect 100 x 200 mm`);
		expect(result.warnings).toEqual([{ severity: 'warning', message: 'E overrides the material preset', line: 5 }]);
		expect(result.model.E).toBe(210e9);
		expect(result.model.material?.id).toBe('steel');
	});

	it('warns that I overrides the section but keeps the section depth', () => {
		const result = warnings(`${BASE}\nmaterial steel\nsection rect 100 x 200 mm\nI 9000 cm^4`);
		expect(result.warnings).toEqual([
			{ severity: 'warning', message: 'I overrides the I computed from the section; stress uses the section depth', line: 6 },
		]);
		expect(result.model.I).toBeCloseTo(9e-5, 15);
		expect(result.model.section?.I).toBeCloseTo(9e-5, 15);
		expect(result.model.section?.c).toBeCloseTo(0.1, 12);
	});

	it.each(['material steel', 'E 200 GPa', 'section rect 100 x 200 mm', 'I 8000 cm^4'])(
		'warns when only %s is given',
		(line) => {
			const result = warnings(`${BASE}\n${line}`);
			expect(result.warnings).toEqual([{ severity: 'warning', message: 'Deflection needs both a material or E, and a section or I' }]);
		},
	);

	it('does not warn without any stiffness input', () => {
		expect(model(BASE).E).toBeUndefined();
	});
});

describe('buildModel: stiffness', () => {
	it('takes E from the material and I from the section', () => {
		const m = model(`${BASE}\nmaterial timber\nsection rect 100 x 250 mm`);
		expect(m.E).toBe(11e9);
		expect(m.material).toEqual(MATERIALS.timber);
		expect(m.I).toBeCloseTo((0.1 * 0.25 ** 3) / 12, 15);
		expect(m.section).toMatchObject({ shape: 'rect', c: 0.125, label: 'Rectangle 100 × 250 mm' });
		expect(m.section?.area).toBeCloseTo(0.025, 12);
	});

	it('uses explicit E and I', () => {
		const m = model('units kip ft\nlength 30 ft\npin at 0\nroller at 20 ft\nE 29000 ksi\nI 510 in^4');
		expect(m.E).toBeCloseTo(29000 * 6894757.293168361, 0);
		expect(m.I).toBeCloseTo(510 * 4.162314256e-7, 15);
		expect(m.section).toBeUndefined();
		expect(m.material).toBeUndefined();
	});

	it('labels sections in the section unit of the block', () => {
		expect(model(`${BASE}\nE 200 GPa\nsection rect 10 x 20 cm`).section?.label).toBe('Rectangle 100 × 200 mm');
		expect(model(`${BASE}\nE 200 GPa\nsection ibeam 150 x 300 x 7.1 x 10.7 mm`).section?.label).toBe(
			'I-beam (no fillets) 150 × 300 × 7.1 × 10.7 mm',
		);
		expect(model('units kip ft\nlength 10\npin at 0\nE 29000 ksi\nsection rect 4 x 8 in').section?.label).toBe('Rectangle 4 × 8 in');
		expect(model(`${BASE}\nE 200 GPa\nsection rect 100 mm x 0.2 m`).section?.label).toBe('Rectangle 100 × 200 mm');
	});

	it('uses the default section unit for bare dimensions where it equals the length unit', () => {
		expect(model('length 6000\npin at 0\nE 200000 MPa\nsection circle 100', 'N-mm').section?.dims).toEqual([0.1]);
		expect(model('units lb in\nlength 120\npin at 0\nE 29000 ksi\nsection circle 4').section?.dims[0]).toBeCloseTo(0.1016, 12);
		// A shared unit after the last dimension covers the bare ones.
		expect(model(`${BASE}\nE 200 GPa\nsection rect 100 x 200 mm`).section?.dims).toEqual([0.1, 0.2]);
	});
});

describe('materials', () => {
	it('defines the documented presets', () => {
		expect(MATERIAL_IDS).toEqual(['steel', 'stainless', 'aluminium', 'timber', 'concrete']);
		expect(MATERIALS.steel).toMatchObject({ id: 'steel', label: 'Structural steel', E: 200e9 });
		expect(MATERIALS.stainless).toMatchObject({ label: 'Stainless steel (austenitic)', E: 193e9 });
		expect(MATERIALS.aluminium).toMatchObject({ label: 'Aluminium alloy 6061-T6', E: 68.9e9 });
		expect(MATERIALS.timber).toMatchObject({ label: 'Softwood timber C24', E: 11e9 });
		expect(MATERIALS.concrete).toMatchObject({ label: 'Concrete C30/37 (uncracked)', E: 33e9 });
		for (const id of MATERIAL_IDS) {
			expect(MATERIALS[id].id).toBe(id);
			expect(MATERIALS[id].source.length).toBeGreaterThan(10);
		}
	});

	it.each([
		['steel', 'steel'],
		['Steel', 'steel'],
		['structural steel', 'steel'],
		['stainless', 'stainless'],
		['stainless-steel', 'stainless'],
		['Stainless Steel', 'stainless'],
		['aluminium', 'aluminium'],
		['aluminum', 'aluminium'],
		['ALUMINUM', 'aluminium'],
		['timber', 'timber'],
		['wood', 'timber'],
		['concrete', 'concrete'],
		[' concrete ', 'concrete'],
	])('finds %j as %s', (name, id) => {
		expect(findMaterial(name)?.id).toBe(id);
	});

	it('returns undefined for unknown names', () => {
		expect(findMaterial('brass')).toBeUndefined();
		expect(findMaterial('')).toBeUndefined();
	});
});
