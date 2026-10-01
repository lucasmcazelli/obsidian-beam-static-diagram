import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	analyzeBeam,
	DEFLECTION_UNAVAILABLE_MESSAGE,
	engineeringWarnings,
	EQUILIBRIUM_MESSAGE,
	forceScale,
	MAX_LOADS,
	MAX_NODES,
	MAX_SOURCE_CHARS,
	mergeDiagnostics,
	NO_HORIZONTAL_RESTRAINT_MESSAGE,
	sortDiagnostics,
} from '../src/core/analyze';
import { forceScale as forceScaleFromScale } from '../src/core/scale';
import { BEAM_EXAMPLES, DEFAULT_BEAM_SOURCE } from '../src/core/examples';
import type { AnalysisOutput, BeamModel, BeamResults, Diagnostic, UnitSystemId } from '../src/core/types';

/** Runs the pipeline with kN-m as the default unit system. */
function run(source: string, defaultUnits: UnitSystemId = 'kN-m'): AnalysisOutput {
	return analyzeBeam(source, { defaultUnits });
}

/** Joins block lines. */
function block(...lines: string[]): string {
	return lines.join('\n');
}

/** Results of a block that must solve, failing the test otherwise. */
function solved(source: string): BeamResults {
	const out = run(source);
	if (!out.results) throw new Error(`Expected results, got ${JSON.stringify(out.diagnostics)}`);
	return out.results;
}

/** Messages only, for compact assertions. */
function messages(out: AnalysisOutput): string[] {
	return out.diagnostics.map((d) => d.message);
}

/** Deterministic pseudo-random numbers (mulberry32), so failures are reproducible. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SIMPLY_SUPPORTED = block('length 6 m', 'pin at 0', 'roller at end', 'point 10 kN down at 2 m', 'udl 4 kN/m down from 0 to 6 m');

/**
 * The solver's mechanism message. analyzeBeam passes it through from
 * solveBeam, which owns the text; the trailing period is optional so this
 * test does not pin the solver's punctuation.
 */
const UNSTABLE = /^The beam is unstable: it can move as a mechanism\. Add a support or remove a hinge\.?$/;

describe('analyzeBeam on the bundled examples', () => {
	it.each(BEAM_EXAMPLES.map((e) => [e.id, e.source]))('%s solves with no diagnostics', (_id, source) => {
		const out = run(source);
		expect(out.diagnostics).toEqual([]);
		expect(out.model).toBeDefined();
		expect(out.results).toBeDefined();
		expect(out.results?.classification.stable).toBe(true);
	});

	it('reproduces the hand statics of the simply supported example', () => {
		const example = BEAM_EXAMPLES.find((e) => e.id === 'simply-supported');
		const results = solved(example?.source ?? '');
		const [a, b] = results.reactions;
		// R_A = (10·4 + 24·3) / 6 = 18.667 kN, R_B = 34 - R_A = 15.333 kN.
		expect((a?.fy ?? 0) / 1000).toBeCloseTo(18.667, 3);
		expect((b?.fy ?? 0) / 1000).toBeCloseTo(15.333, 3);
		// V = 0 where 18.667 - 10 - 4x = 0, x = 2.1667 m; M there = 29.389 kN·m.
		expect(results.extrema.momentMax.value / 1000).toBeCloseTo(29.389, 3);
		expect(results.extrema.momentMax.x).toBeCloseTo(2.1667, 4);
		expect(results.hasDeflection).toBe(true);
	});

	it('reports the unit system of the block, falling back to the default', () => {
		const overhang = BEAM_EXAMPLES.find((e) => e.id === 'overhang');
		expect(run(overhang?.source ?? '').units).toBe('kip-ft');
		expect(run(SIMPLY_SUPPORTED, 'N-mm').units).toBe('N-mm');
	});

	it('solves the default inserted block, deflection included', () => {
		const out = run(DEFAULT_BEAM_SOURCE);
		expect(out.diagnostics).toEqual([]);
		expect(out.results?.hasDeflection).toBe(true);
	});

	it('keeps the parsed AST in the output', () => {
		const out = run(SIMPLY_SUPPORTED);
		expect(out.ast.length).toBe('6 m');
		expect(out.ast.loads).toHaveLength(2);
	});
});

describe('analyzeBeam warnings', () => {
	it('warns when no support resists horizontal movement', () => {
		const out = run(block('length 6', 'roller at 0', 'roller at 6', 'point 10 at 2'));
		expect(out.results).toBeDefined();
		expect(out.diagnostics).toEqual([{ severity: 'warning', message: NO_HORIZONTAL_RESTRAINT_MESSAGE }]);
		expect(NO_HORIZONTAL_RESTRAINT_MESSAGE).toBe(
			'No pin or fixed support: the beam is not restrained horizontally. Results assume vertical loads only',
		);
	});

	it('warns about uplift at a pin, with the line of the support', () => {
		// Overhang: 10 kN at the tip, 2 m past the roller at 4 m, pulls the pin down by 10·2/4 = 5 kN.
		const out = run(block('length 6', 'pin at 0', 'roller at 4', 'point 10 at 6'));
		expect(out.results).toBeDefined();
		expect(out.diagnostics).toEqual([
			{ severity: 'warning', message: 'Support at x = 0 m pulls the beam down (5.00 kN): it must be anchored against uplift', line: 2 },
		]);
	});

	it('formats the uplift force in the block units and with the requested decimals', () => {
		const out = analyzeBeam(block('units kip ft', 'length 6', 'pin at 0', 'roller at 4', 'point 10 at 6'), { defaultUnits: 'kN-m', decimals: 3 });
		expect(messages(out)).toEqual(['Support at x = 0 ft pulls the beam down (5.000 kip): it must be anchored against uplift']);
	});

	it('prints a large uplift force with the requested decimals, not in exponent form', () => {
		// 2e7 N: the default label limit (1e7) would print "2.00e7 N".
		const out = analyzeBeam(block('units N mm', 'length 6000', 'pin at 0', 'roller at 4000', 'point 4e7 at 6000'), { defaultUnits: 'kN-m', decimals: 2 });
		expect(messages(out)).toEqual(['Support at x = 0 mm pulls the beam down (20000000.00 N): it must be anchored against uplift']);
	});

	it('warns about uplift at a roller', () => {
		// Same overhang with the supports swapped: now the roller at 0 is pulled down.
		const out = run(block('length 6', 'pin at 4', 'roller at 0', 'point 10 at 6'));
		expect(out.results?.reactions.find((r) => r.kind === 'roller')?.fy).toBeCloseTo(-5000, 6);
		expect(messages(out)).toEqual(['Support at x = 0 m pulls the beam down (5.00 kN): it must be anchored against uplift']);
		expect(out.diagnostics[0]?.line).toBe(3);
	});

	it('does not call a pulling fixed support uplift (a clamp resists both ways)', () => {
		const out = run(block('length 3', 'fixed at 0', 'point 10 kN up at 3'));
		expect(out.results?.reactions[0]?.fy).toBeLessThan(0);
		expect(out.diagnostics).toEqual([]);
	});

	it('warns when the deflection exceeds L/50', () => {
		// 5wL⁴/(384EI) = 5·4000·6⁴ / (384·200e9·200e-8) = 0.16875 m = L/35.6, shown as L/35.
		const out = run(block('length 6', 'pin at 0', 'roller at end', 'udl 4 kN/m down', 'E 200 GPa', 'I 200 cm^4'));
		expect(out.results).toBeDefined();
		expect(out.diagnostics).toEqual([
			{
				severity: 'warning',
				message: 'Maximum deflection is L/35: check E, I and the section units (small-deflection theory is also unreliable this large)',
			},
		]);
	});

	it('does not warn below L/50', () => {
		// 8000 cm^4 gives 4.2 mm on 6 m, about L/1400.
		const out = run(block('length 6', 'pin at 0', 'roller at end', 'udl 4 kN/m down', 'E 200 GPa', 'I 8000 cm^4'));
		expect(out.diagnostics).toEqual([]);
	});

	// Regression: the warning divided the TOTAL length by the global peak, so on three 4 m spans
	// it fired only at span/16.7. It now uses the governing span, like the results table.
	it('judges the large-deflection warning per span on a continuous beam', () => {
		// The 4 m end spans peak at 1.1015 mm × 8000 / 66 = 133.5 mm: 4 / 0.1335 = L/29.96,
		// while 12 m / 0.1335 m = 90 would not have warned.
		const out = run(block('length 12', 'pin at 0', 'roller at 4', 'roller at 8', 'roller at 12', 'udl 10 down', 'E 200 GPa', 'I 66 cm^4'));
		expect(messages(out)).toEqual([
			'Maximum deflection is L/29: check E, I and the section units (small-deflection theory is also unreliable this large)',
		]);
	});

	// Regression: with E and I given but out of double-precision range the solver withholds the
	// deflection (hasDeflection false), and the block used to show no deflection and no reason.
	it('says why the deflection is missing when E and I are given but out of range', () => {
		const out = run(block('length 6', 'pin at 0', 'roller at end', 'point 10 at 2', 'E 1e-300 Pa', 'I 8000 cm^4'));
		expect(out.results?.hasDeflection).toBe(false);
		expect(out.diagnostics).toEqual([{ severity: 'warning', message: DEFLECTION_UNAVAILABLE_MESSAGE }]);
		// E·I overflowing to Infinity is withheld the same way.
		const huge = run(block('length 6', 'pin at 0', 'roller at end', 'point 10 at 2', 'E 1e200 Pa', 'I 1e200 m^4'));
		expect(huge.results?.hasDeflection).toBe(false);
		expect(messages(huge)).toEqual([DEFLECTION_UNAVAILABLE_MESSAGE]);
		// Without E or I there is nothing to explain.
		expect(run(block('length 6', 'pin at 0', 'roller at end', 'point 10 at 2')).diagnostics).toEqual([]);
	});

	it('writes deflections larger than the span as a multiple of L', () => {
		const results = solved(block('length 6', 'pin at 0', 'roller at end', 'udl 4 kN/m down', 'E 200 GPa', 'I 1 cm^4'));
		const warning = engineeringWarnings(results, 'kN-m').find((d) => d.message.startsWith('Maximum deflection'));
		expect(warning?.message).toMatch(/^Maximum deflection is \d+(\.\d)? × L: check E, I and the section units \(small-deflection theory is also unreliable this large\)$/);
	});

	it('reports an equilibrium residual above 1e-6 of the force scale', () => {
		const results = solved(SIMPLY_SUPPORTED);
		expect(engineeringWarnings(results, 'kN-m')).toEqual([]);
		const broken: BeamResults = { ...results, residual: { force: 1, moment: 0 } };
		expect(engineeringWarnings(broken, 'kN-m')).toEqual([{ severity: 'warning', message: EQUILIBRIUM_MESSAGE }]);
		const momentOff: BeamResults = { ...results, residual: { force: 0, moment: 100 } };
		expect(engineeringWarnings(momentOff, 'kN-m').map((d) => d.message)).toEqual([EQUILIBRIUM_MESSAGE]);
		const notANumber: BeamResults = { ...results, residual: { force: Number.NaN, moment: 0 } };
		expect(engineeringWarnings(notANumber, 'kN-m').map((d) => d.message)).toEqual([EQUILIBRIUM_MESSAGE]);
		expect(EQUILIBRIUM_MESSAGE).toBe('Equilibrium check failed: results may be inaccurate');
	});

	it('ignores round-off sized negative reactions', () => {
		const results = solved(SIMPLY_SUPPORTED);
		const tiny: BeamResults = {
			...results,
			reactions: results.reactions.map((r, i) => (i === 0 ? { ...r, fy: -1e-9 } : r)),
		};
		expect(engineeringWarnings(tiny, 'kN-m')).toEqual([]);
	});

	it('sorts warnings with a line before whole-beam warnings', () => {
		const out = run(block('length 6', 'roller at 0', 'roller at 4', 'point 10 at 6'));
		expect(out.diagnostics.map((d) => d.line)).toEqual([2, undefined]);
		expect(out.diagnostics[1]?.message).toBe(NO_HORIZONTAL_RESTRAINT_MESSAGE);
	});
});

describe('analyzeBeam errors', () => {
	it('rejects a mechanism with the solver message, keeping the model for the beam drawing', () => {
		const out = run(block('length 6', 'pin at 0', 'hinge at 3', 'roller at 6', 'point 10 at 2'));
		expect(out.diagnostics).toHaveLength(1);
		expect(out.diagnostics[0]?.severity).toBe('error');
		expect(out.diagnostics[0]?.line).toBeUndefined();
		expect(out.diagnostics[0]?.message).toMatch(UNSTABLE);
		expect(out.model).toBeDefined();
		expect(out.results).toBeUndefined();
	});

	it('rejects a single pin as a mechanism', () => {
		const out = run(block('length 6', 'pin at 0', 'point 10 at 2'));
		expect(messages(out)).toHaveLength(1);
		expect(messages(out)[0]).toMatch(UNSTABLE);
	});

	it('passes solver errors through as diagnostics', () => {
		// A hinge 1e-8 m from a roller: the solver refuses rather than answer inaccurately.
		const out = run(block('length 1 m', 'pin at 0', 'roller at 0.5', 'hinge at 0.50000001', 'roller at 1', 'point 1 kN at 0.25'));
		expect(out.model).toBeDefined();
		expect(out.results).toBeUndefined();
		expect(out.diagnostics).toHaveLength(1);
		expect(out.diagnostics[0]?.severity).toBe('error');
		expect(out.diagnostics[0]?.message).toMatch(/^The beam could not be solved accurately/);
	});

	it('reports parser and model errors together, sorted by line', () => {
		const out = run(block('length 6', 'pin at 0', 'roller at 9', 'foo bar'));
		expect(out.model).toBeUndefined();
		expect(out.results).toBeUndefined();
		expect(out.diagnostics.map((d) => [d.severity, d.line])).toEqual([
			['error', 3],
			['error', 4],
		]);
		expect(out.diagnostics[0]?.message).toBe('Position 9 is outside the beam (0 to 6 m)');
		expect(out.diagnostics[1]?.message).toMatch(/^Unknown statement "foo"/);
	});

	it('does not ask for a length when the length line itself is broken', () => {
		const typo = run(block('lenght 6 m', 'pin at 0', 'roller at end'));
		expect(messages(typo)).toEqual(['Unknown statement "lenght". Did you mean "length"?']);
		const comma = run(block('length 6,5 m', 'pin at 0', 'roller at 6'));
		expect(messages(comma)).toEqual(['Invalid number "6,5": use a dot as the decimal separator']);
		const colon = run(block('length: 6,5 m', 'pin at 0', 'roller at 6'));
		expect(messages(colon).some((m) => m.startsWith('Add a length'))).toBe(false);
	});

	it('does not ask for a support when the only support line is broken', () => {
		const out = run(block('length 6', 'pinn at 0'));
		expect(messages(out)).toEqual(['Unknown statement "pinn". Did you mean "pin"?']);
	});

	it('still asks for a support when a broken line is a load, not a support', () => {
		// "point" is close to "pin" by edit distance: it must not count as a broken support.
		const out = run(block('length 6', 'point 10 kN dwn at 2'));
		expect(messages(out)).toEqual(['Unexpected "dwn". Did you mean "down"?', 'Add at least one support, for example: pin at 0']);
	});

	it('drops the deflection warning when a material or section line is broken', () => {
		const out = run(block('length 6', 'pin at 0', 'roller at 6', 'materal steel', 'section rect 100 x 200 mm'));
		expect(out.diagnostics).toHaveLength(1);
		expect(out.diagnostics[0]?.line).toBe(4);
		expect(messages(out).some((m) => m.startsWith('Deflection needs both'))).toBe(false);
	});

	it('keeps the deflection warning when nothing is broken', () => {
		const out = run(block('length 6', 'pin at 0', 'roller at 6', 'point 10 at 2', 'material steel'));
		expect(out.results).toBeDefined();
		expect(messages(out)).toEqual(['Deflection needs both a material or E, and a section or I']);
	});

	it('shows the missing-support error when the only broken line is an I alias', () => {
		// Regression: "Ix" was taken for a misspelt "fix", which hid "Add at least one support".
		const out = run(block('length 6 m', 'point 10 kN at 3', 'E 200 GPa', 'Ix 8000 cm4'));
		expect(messages(out)).toEqual(['Add at least one support, for example: pin at 0']);
	});

	it('adds no false unlined messages after a failed E, I or length line', () => {
		// Regression: the failed line left its value in the AST, giving "Add a unit to E" and
		// "E overrides the material preset" without a line number on top of the real error.
		const e = run(block('length 6', 'pin at 0', 'roller at 6', 'point 10 at 2', 'material steel', 'E 200 000 MPa', 'section rect 100 x 200 mm'));
		expect(e.diagnostics).toEqual([{ severity: 'error', message: 'Write numbers without spaces, for example 200000', line: 6 }]);
		const i = run(block('length 6', 'pin at 0', 'roller at 6', 'point 10 at 2', 'E 200 GPa', 'I 0 cm4 oops'));
		expect(i.diagnostics).toEqual([{ severity: 'error', message: 'Unexpected "oops": the statement is already complete', line: 6 }]);
		const length = run(block('length -6 m.', 'pin at 0', 'roller at end'));
		expect(length.diagnostics).toEqual([{ severity: 'error', message: 'Unexpected ".": the statement is already complete', line: 1 }]);
	});

	it('reports an empty block as missing length and support', () => {
		const out = run('');
		expect(out.diagnostics).toEqual([
			{ severity: 'error', message: 'Add a length, for example: length 6 m' },
			{ severity: 'error', message: 'Add at least one support, for example: pin at 0' },
		]);
		expect(out.units).toBe('kN-m');
	});

	it('never returns a model or results when there is an error', () => {
		const out = run(block('length 6', 'pin at 0', 'roller at 6', 'point 10 kN dwn at 2'));
		expect(out.diagnostics.some((d) => d.severity === 'error')).toBe(true);
		expect(out.model).toBeUndefined();
		expect(out.results).toBeUndefined();
	});

	it('survives nonsense options and non-string input', () => {
		const badUnits = analyzeBeam(SIMPLY_SUPPORTED, { defaultUnits: 'furlongs' as UnitSystemId, decimals: Number.NaN });
		expect(badUnits.units).toBe('kN-m');
		expect(badUnits.results).toBeDefined();
		const notText = analyzeBeam(null as unknown as string, { defaultUnits: 'kN-m' });
		expect(notText.diagnostics.length).toBeGreaterThan(0);
		expect(() => analyzeBeam(SIMPLY_SUPPORTED, undefined as unknown as { defaultUnits: UnitSystemId })).not.toThrow();
	});

	it('never throws on random input', () => {
		const rand = mulberry32(20261001);
		const pieces = [
			'length', 'pin', 'roller', 'fixed', 'hinge', 'point', 'moment', 'udl', 'linear', 'section', 'material', 'units',
			'E', 'I', 'at', 'from', 'to', 'down', 'up', 'cw', 'ccw', 'start', 'mid', 'end', 'x', '#', '//', ':', '=',
			'0', '1', '2.5', '-3', '1e309', '6,5', 'NaN', '1e-12', 'kN', 'kN/m', 'kNm', 'mm', 'GPa', 'cm^4', 'ft', 'kip',
			'steel', 'rect', 'ibeam', '100', 'x', '−', '·', String.fromCharCode(0x2014), '\u0000', '\t', '😀', 'é', '(', ')',
		];
		for (let n = 0; n < 400; n++) {
			const lines: string[] = [];
			const lineCount = Math.floor(rand() * 8);
			for (let l = 0; l < lineCount; l++) {
				const words: string[] = [];
				const wordCount = Math.floor(rand() * 7);
				for (let w = 0; w < wordCount; w++) words.push(pieces[Math.floor(rand() * pieces.length)] ?? '');
				lines.push(words.join(rand() < 0.2 ? '' : ' '));
			}
			const source = lines.join(rand() < 0.1 ? '\r\n' : '\n');
			const out = run(source);
			expect(Array.isArray(out.diagnostics)).toBe(true);
			for (const d of out.diagnostics) expect(typeof d.message).toBe('string');
			if (out.results) {
				for (const r of out.results.reactions) expect(Number.isFinite(r.fy) && Number.isFinite(r.mz)).toBe(true);
			}
		}
	});

	it('never throws on random characters', () => {
		const rand = mulberry32(7);
		for (let n = 0; n < 200; n++) {
			let text = '';
			const len = Math.floor(rand() * 120);
			for (let i = 0; i < len; i++) text += String.fromCharCode(Math.floor(rand() * 0x3000));
			expect(() => run(text)).not.toThrow();
		}
	});

	it('handles a well-formed block at the load limit', () => {
		const lines = ['length 100 m', 'pin at 0', 'roller at 100'];
		for (let i = 1; i <= MAX_LOADS; i++) lines.push(`point ${(i % 7) + 1} kN down at ${i / 2} m`);
		const out = run(lines.join('\n'));
		expect(out.results).toBeDefined();
	});
});

describe('analyzeBeam size limits', () => {
	/** A valid block with `supports` rollers after a pin, `hinges` hinges and `loads` point loads. */
	function sized(supports: number, hinges: number, loads: number): string {
		const lines = ['length 1000 m', 'pin at 0'];
		for (let i = 1; i < supports; i++) lines.push(`roller at ${i * 10} m`);
		// One hinge just right of each support keeps the beam stable.
		for (let i = 1; i <= hinges; i++) lines.push(`hinge at ${i * 10 + 1} m`);
		for (let i = 1; i <= loads; i++) lines.push(`point 1 kN at ${i * 0.5 + 0.25} m`);
		return lines.join('\n');
	}

	it('analyses a block at the support, hinge and load limits', () => {
		// MAX_NODES supports and hinges in total: 30 supports, 20 hinges.
		const out = run(sized(30, MAX_NODES - 30, MAX_LOADS));
		expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		expect(out.results).toBeDefined();
	});

	it('refuses more supports and hinges than the limit before building the model', () => {
		// Regression: a few hundred supports froze the app for tens of seconds per render.
		const out = run(sized(31, MAX_NODES - 30, 1));
		expect(out.diagnostics).toEqual([{ severity: 'error', message: `Too many supports and hinges (${MAX_NODES + 1}): the limit is ${MAX_NODES} per beam` }]);
		expect(out.model).toBeUndefined();
		expect(out.ast.supports).toHaveLength(31);
	});

	it('refuses more loads than the limit, keeping parse errors', () => {
		const out = run(`${sized(2, 0, MAX_LOADS + 1)}\nlenght 6`);
		expect(out.diagnostics.map((d) => d.message)).toEqual([
			'Unknown statement "lenght". Did you mean "length"?',
			`Too many loads (${MAX_LOADS + 1}): the limit is ${MAX_LOADS} per beam`,
		]);
		expect(out.model).toBeUndefined();
	});

	it('refuses an over-long block before parsing it, in the default units', () => {
		const comment = `# ${'x'.repeat(MAX_SOURCE_CHARS)}`;
		const out = analyzeBeam(`${SIMPLY_SUPPORTED}\n${comment}`, { defaultUnits: 'kip-ft' });
		expect(out.diagnostics).toEqual([
			{ severity: 'error', message: `This block is too long to analyse (more than ${MAX_SOURCE_CHARS} characters): split it into several beams` },
		]);
		expect(out.units).toBe('kip-ft');
		expect(out.ast.loads).toEqual([]);
		// Exactly at the limit is fine.
		const padded = `${SIMPLY_SUPPORTED}\n#`.padEnd(MAX_SOURCE_CHARS, 'x');
		expect(padded.length).toBe(MAX_SOURCE_CHARS);
		expect(run(padded).results).toBeDefined();
	});
});

describe('analyzeBeam hints', () => {
	it('hints at adding a load when the beam has none, in the block units', () => {
		// Regression: an unloaded beam solved silently with every value 0.00.
		expect(run(block('length 6 m', 'pin at 0', 'roller at end')).diagnostics).toEqual([
			{ severity: 'warning', message: 'No loads yet: add one, for example point 10 kN at 2 m' },
		]);
		expect(messages(run(block('units kip ft', 'length 20', 'pin at 0', 'roller at end')))).toEqual([
			'No loads yet: add one, for example point 5 kip at 10 ft',
		]);
	});

	it('does not add the hint when the loads are zero (they have their own warning)', () => {
		const out = run(block('length 6 m', 'pin at 0', 'roller at end', 'point 0 kN at 2'));
		expect(messages(out)).toEqual(['This point load is zero and is ignored']);
	});
});

describe('analyzeBeam with failing stages', () => {
	afterEach(() => {
		vi.doUnmock('../src/core/solver');
		vi.resetModules();
	});

	it('turns an unexpected solver crash into an error diagnostic', async () => {
		vi.resetModules();
		vi.doMock('../src/core/solver', () => ({
			solveBeam: () => {
				throw new TypeError('boom');
			},
		}));
		const mod = await import('../src/core/analyze');
		const out = mod.analyzeBeam(SIMPLY_SUPPORTED, { defaultUnits: 'kN-m' });
		expect(out.model).toBeDefined();
		expect(out.results).toBeUndefined();
		expect(out.diagnostics).toHaveLength(1);
		expect(out.diagnostics[0]?.severity).toBe('error');
		expect(out.diagnostics[0]?.message).toMatch(/internal error/);
	});
});

describe('analyze helpers', () => {
	it('merges diagnostics, removing repeats on the same line and letting errors win', () => {
		const a: Diagnostic[] = [
			{ severity: 'warning', message: 'Same', line: 2 },
			{ severity: 'error', message: 'Other', line: 3 },
		];
		const b: Diagnostic[] = [
			{ severity: 'error', message: 'Same', line: 2 },
			{ severity: 'error', message: 'Same', line: 4 },
			{ severity: 'warning', message: 'Whole beam' },
			{ severity: 'warning', message: 'Whole beam' },
		];
		expect(mergeDiagnostics(a, b)).toEqual([
			{ severity: 'error', message: 'Same', line: 2 },
			{ severity: 'error', message: 'Other', line: 3 },
			{ severity: 'error', message: 'Same', line: 4 },
			{ severity: 'warning', message: 'Whole beam' },
		]);
		// Inputs are not modified.
		expect(a[0]?.severity).toBe('warning');
	});

	it('sorts by line, stable, whole-beam diagnostics last', () => {
		const list: Diagnostic[] = [
			{ severity: 'warning', message: 'w' },
			{ severity: 'error', message: 'b', line: 5 },
			{ severity: 'error', message: 'a', line: 1 },
			{ severity: 'warning', message: 'c', line: 5 },
		];
		expect(sortDiagnostics(list).map((d) => d.message)).toEqual(['a', 'b', 'c', 'w']);
	});

	it('re-exports the force scale of the dependency-free scale module', () => {
		expect(forceScale).toBe(forceScaleFromScale);
	});

	it('computes the force scale from loads and reactions', () => {
		const model: BeamModel = {
			units: 'kN-m',
			length: 4,
			supports: [],
			hinges: [],
			loads: [
				{ kind: 'point', x: 1, fy: -10 },
				{ kind: 'moment', x: 2, mz: 8 },
				// Changes sign at a quarter of its length: |area| = 0.5·2·1 + 0.5·6·3 = 10.
				{ kind: 'distributed', x1: 0, x2: 4, q1: -2, q2: 6 },
				{ kind: 'distributed', x1: 0, x2: 2, q1: -3, q2: -3 },
			],
		};
		expect(forceScale(model)).toBeCloseTo(10 + 8 / 4 + 10 + 6, 12);
		expect(forceScale(model, [{ supportIndex: 0, kind: 'fixed', x: 0, fy: 5, mz: -4 }])).toBeCloseTo(28 + 5 + 1, 12);
		expect(forceScale({ ...model, loads: [] })).toBe(0);
	});
});
