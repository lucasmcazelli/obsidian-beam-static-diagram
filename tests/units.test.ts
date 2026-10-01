import { describe, expect, it } from 'vitest';
import type { Dimension, UnitSystemId } from '../src/core/types';
import {
	clampDecimals,
	DEFAULT_DECIMALS,
	formatCompact,
	formatNumber,
	formatPosition,
	formatQuantity,
	hasUnit,
	isUnitSymbol,
	isUnitSystemId,
	lookupUnit,
	parseQuantity,
	parseUnitSystem,
	splitQuantity,
	TABLE_PLAIN_LIMIT,
	toDisplay,
	unitKey,
	unitSymbol,
	UNIT_SYSTEMS,
} from '../src/core/units';

const SYSTEMS: UnitSystemId[] = ['kN-m', 'N-mm', 'kip-ft', 'lb-in'];
const DIMENSIONS: Dimension[] = [
	'length',
	'force',
	'moment',
	'distributed',
	'modulus',
	'inertia',
	'sectionLength',
	'deflection',
	'stress',
	'slope',
];

/** Parses and returns the SI value, failing the test with the message on error. */
function si(raw: string, dimension: Dimension, system: UnitSystemId = 'kN-m'): number {
	const result = parseQuantity(raw, dimension, system);
	if (!result.ok) throw new Error(`Unexpected error for "${raw}": ${result.message}`);
	return result.value;
}

/** Parses and returns the error message, failing the test on success. */
function err(raw: string, dimension: Dimension, system: UnitSystemId = 'kN-m', requireUnit = false): string {
	const result = parseQuantity(raw, dimension, system, { requireUnit });
	if (result.ok) throw new Error(`Expected an error for "${raw}", got ${result.value}`);
	return result.message;
}

describe('UNIT_SYSTEMS', () => {
	it('has an entry for every id with matching id field', () => {
		for (const id of SYSTEMS) expect(UNIT_SYSTEMS[id].id).toBe(id);
	});

	it('uses only symbols the parser understands, with the right dimension', () => {
		for (const id of SYSTEMS) {
			for (const dim of DIMENSIONS) {
				const symbol = UNIT_SYSTEMS[id].symbols[dim];
				expect(isUnitSymbol(symbol), `${id} ${dim} ${symbol}`).toBe(true);
				// The symbol must be accepted for its own dimension and mean exactly 1 display unit.
				expect(toDisplay(si(`1 ${symbol}`, dim, id), dim, id)).toBeCloseTo(1, 12);
			}
		}
	});

	it('round-trips every keyword through parseUnitSystem', () => {
		for (const id of SYSTEMS) expect(parseUnitSystem(UNIT_SYSTEMS[id].keyword)).toBe(id);
	});

	it('lists the documented per-system symbols', () => {
		expect(UNIT_SYSTEMS['kN-m'].symbols).toMatchObject({
			length: 'm',
			force: 'kN',
			moment: 'kN·m',
			distributed: 'kN/m',
			sectionLength: 'mm',
			deflection: 'mm',
			stress: 'MPa',
			modulus: 'GPa',
			inertia: 'cm⁴',
			slope: 'rad',
		});
		expect(UNIT_SYSTEMS['N-mm'].symbols).toMatchObject({ length: 'mm', force: 'N', moment: 'N·mm', modulus: 'MPa', inertia: 'mm⁴' });
		expect(UNIT_SYSTEMS['kip-ft'].symbols).toMatchObject({ length: 'ft', force: 'kip', moment: 'kip·ft', distributed: 'kip/ft', sectionLength: 'in', stress: 'ksi', modulus: 'ksi', inertia: 'in⁴' });
		expect(UNIT_SYSTEMS['lb-in'].symbols).toMatchObject({ length: 'in', force: 'lb', moment: 'lb·in', distributed: 'lb/in', stress: 'psi', modulus: 'psi' });
	});
});

describe('parseUnitSystem', () => {
	it.each([
		['kN m', 'kN-m'],
		['kN-m', 'kN-m'],
		['KN M', 'kN-m'],
		['kn-m', 'kN-m'],
		['kN, m', 'kN-m'],
		['kNm', 'kN-m'],
		['SI', 'kN-m'],
		['si', 'kN-m'],
		['N mm', 'N-mm'],
		['N-mm', 'N-mm'],
		['n mm', 'N-mm'],
		['kip ft', 'kip-ft'],
		['kip-ft', 'kip-ft'],
		['kips ft', 'kip-ft'],
		['KIP FT', 'kip-ft'],
		['US', 'kip-ft'],
		['imperial', 'kip-ft'],
		['Imperial', 'kip-ft'],
		['lb in', 'lb-in'],
		['lb-in', 'lb-in'],
		['lbf in', 'lb-in'],
		['  lb   in  ', 'lb-in'],
	])('reads %s as %s', (text, id) => {
		expect(parseUnitSystem(text)).toBe(id);
	});

	it.each(['', 'metric', 'kN ft', 'mm', 'furlongs'])('rejects %j', (text) => {
		expect(parseUnitSystem(text)).toBeNull();
	});
});

describe('parseQuantity: exact conversion factors', () => {
	// Imperial factors are written in shortest round-trip form; the longer
	// decimal products (e.g. 1355.8179483314004) parse to the very same double.
	it.each<[string, Dimension, number]>([
		// length
		['1 m', 'length', 1],
		['1 cm', 'length', 0.01],
		['1 mm', 'length', 0.001],
		['1 in', 'length', 0.0254],
		['1 ft', 'length', 0.3048],
		// force
		['1 N', 'force', 1],
		['1 kN', 'force', 1e3],
		['1 MN', 'force', 1e6],
		['1 lb', 'force', 4.4482216152605],
		['1 lbf', 'force', 4.4482216152605],
		['1 kip', 'force', 4448.2216152605],
		['1 kips', 'force', 4448.2216152605],
		// moment
		['1 N·m', 'moment', 1],
		['1 kN·m', 'moment', 1e3],
		['1 N·mm', 'moment', 1e-3],
		['1 kN·mm', 'moment', 1],
		['1 MN·m', 'moment', 1e6],
		['1 lb·ft', 'moment', 1.3558179483314003],
		['1 lb·in', 'moment', 0.1129848290276167],
		['1 kip·ft', 'moment', 1355.8179483314004],
		['1 kip·in', 'moment', 112.9848290276167],
		// distributed
		['1 N/m', 'distributed', 1],
		['1 kN/m', 'distributed', 1e3],
		['1 N/mm', 'distributed', 1e3],
		['1 kN/mm', 'distributed', 1e6],
		['1 lb/ft', 'distributed', 14.593902937206364],
		['1 plf', 'distributed', 14.593902937206364],
		['1 lb/in', 'distributed', 175.12683524647636],
		['1 pli', 'distributed', 175.12683524647636],
		['1 kip/ft', 'distributed', 14593.902937206363],
		['1 klf', 'distributed', 14593.902937206363],
		['1 kip/in', 'distributed', 175126.83524647637],
		// modulus
		['1 Pa', 'modulus', 1],
		['1 kPa', 'modulus', 1e3],
		['1 MPa', 'modulus', 1e6],
		['1 GPa', 'modulus', 1e9],
		['1 N/mm^2', 'modulus', 1e6],
		['1 N/mm2', 'modulus', 1e6],
		['1 N/mm²', 'modulus', 1e6],
		['1 kN/mm^2', 'modulus', 1e9],
		['1 kN/m^2', 'modulus', 1e3],
		['1 psi', 'modulus', 6894.757293168361],
		['1 ksi', 'modulus', 6894757.293168361],
		['1 Msi', 'modulus', 6.894757293168361e9],
		// stress shares the pressure table
		['1 MPa', 'stress', 1e6],
		['1 ksi', 'stress', 6894757.293168361],
		// inertia
		['1 m^4', 'inertia', 1],
		['1 cm^4', 'inertia', 1e-8],
		['1 mm^4', 'inertia', 1e-12],
		['1 in^4', 'inertia', 4.162314256e-7],
		['1 m4', 'inertia', 1],
		['1 cm4', 'inertia', 1e-8],
		['1 mm4', 'inertia', 1e-12],
		['1 in4', 'inertia', 4.162314256e-7],
		['1 cm⁴', 'inertia', 1e-8],
		['1 in⁴', 'inertia', 4.162314256e-7],
		// section lengths and deflections use the length table
		['1 in', 'sectionLength', 0.0254],
		['1 mm', 'deflection', 0.001],
		['1 rad', 'slope', 1],
	])('%s (%s) = %d SI', (raw, dim, expected) => {
		expect(si(raw, dim)).toBe(expected);
	});

	it('divides exactly for SI submultiples', () => {
		expect(si('1500 mm', 'length')).toBe(1.5);
		expect(si('8000 cm^4', 'inertia')).toBe(8e-5);
		expect(si('250 mm', 'sectionLength')).toBe(0.25);
	});
});

describe('parseQuantity: spellings', () => {
	it.each(['kN·m', 'kN*m', 'kN-m', 'kN.m', 'kNm', 'KNM', 'kn·m', 'kN m', 'kN⋅m'])('accepts moment spelling %s', (u) => {
		expect(si(`2 ${u}`, 'moment')).toBe(2000);
	});

	it.each([
		['ft-lb', 1.3558179483314003],
		['ft·lbf', 1.3558179483314003],
		['ft-kip', 1355.8179483314004],
		['in-lb', 0.1129848290276167],
		['in-kip', 112.9848290276167],
		['kip-in', 112.9848290276167],
		['lbf-in', 0.1129848290276167],
	])('accepts imperial moment %s', (u, factor) => {
		expect(si(`1 ${u}`, 'moment')).toBe(factor);
	});

	it('accepts the one-letter kip spellings in US blocks', () => {
		for (const system of ['kip-ft', 'lb-in'] as const) {
			expect(si('1 k', 'force', system)).toBe(4448.2216152605);
			expect(si('1 K', 'force', system)).toBe(4448.2216152605);
			expect(si('1 k-ft', 'moment', system)).toBe(1355.8179483314004);
			expect(si('1 ft-k', 'moment', system)).toBe(1355.8179483314004);
			expect(si('1 k-in', 'moment', system)).toBe(112.9848290276167);
			expect(si('1 k/ft', 'distributed', system)).toBe(14593.902937206363);
			expect(si('1 k/in', 'distributed', system)).toBe(175126.83524647637);
		}
	});

	it('refuses the one-letter kip spellings in SI blocks, where "10 k" may mean kN', () => {
		// Regression: "point 10k down at 3000" in N mm silently read 10 kip = 44.48 kN.
		for (const system of ['kN-m', 'N-mm'] as const) {
			expect(err('10 k', 'force', system)).toBe('"k" is ambiguous in an SI block: write kip or kN');
			expect(err('10k', 'force', system)).toBe('"k" is ambiguous in an SI block: write kip or kN');
			expect(err('10 K', 'force', system)).toBe('"K" is ambiguous in an SI block: write kip or kN');
			expect(err('5 k-ft', 'moment', system)).toBe('"k-ft" is ambiguous in an SI block: write kip·ft or kN·m');
			expect(err('5 in-k', 'moment', system)).toContain('ambiguous in an SI block');
			expect(err('2 k/ft', 'distributed', system)).toBe('"k/ft" is ambiguous in an SI block: write kip/ft or kN/m');
			expect(err('2 k/in', 'distributed', system)).toContain('ambiguous in an SI block');
		}
		// Written-out kip units stay accepted everywhere, including SI blocks.
		expect(si('10 kip', 'force', 'kN-m')).toBe(44482.216152605);
		expect(si('10 kips', 'force', 'N-mm')).toBe(44482.216152605);
		expect(si('1 kip-ft', 'moment', 'kN-m')).toBe(1355.8179483314004);
		expect(si('1 klf', 'distributed', 'kN-m')).toBe(14593.902937206363);
		// A unit of the wrong dimension still gets the dimension message first.
		expect(err('6 k', 'length', 'kN-m')).toContain('k is not a length unit');
	});

	it('refuses milli units typed with a lower-case m instead of reading them as mega', () => {
		// Regression: "10 mN" read as 10 MN (1e7 N), a factor of 1e9 off.
		expect(err('10 mN', 'force')).toBe('Unknown unit "mN": milli units are not supported; for mega write a capital M (MN, MPa)');
		expect(err('10 mN·m', 'moment')).toContain('milli units are not supported');
		expect(err('10 mN/m', 'distributed')).toContain('milli units are not supported');
		expect(err('200 mPa', 'modulus')).toContain('milli units are not supported');
		// All lower case keeps the common reading as mega, and mm is untouched.
		expect(si('200 mpa', 'modulus')).toBe(200e6);
		expect(si('3 mn', 'force')).toBe(3e6);
		expect(si('3 MN', 'force')).toBe(3e6);
		expect(si('5 mm', 'length')).toBe(0.005);
	});

	it('is case-insensitive', () => {
		expect(si('3 KN', 'force')).toBe(3000);
		expect(si('3 kn', 'force')).toBe(3000);
		expect(si('200 gpa', 'modulus')).toBe(200e9);
		expect(si('200 mpa', 'modulus')).toBe(200e6);
		expect(si('2 KIP/FT', 'distributed')).toBe(2 * 14593.902937206363);
		expect(si('5 MM', 'length')).toBe(0.005);
	});

	it('accepts glued and spaced units, signs, exponents and leading dots', () => {
		expect(si('10kN', 'force')).toBe(10000);
		expect(si('10 kN', 'force')).toBe(10000);
		expect(si('  10   kN  ', 'force')).toBe(10000);
		expect(si('-2.5e3 N', 'force')).toBe(-2500);
		expect(si('+4 kN', 'force')).toBe(4000);
		expect(si('.5 m', 'length')).toBe(0.5);
		expect(si('1.5E2 mm', 'length')).toBe(0.15);
		expect(si('2. m', 'length')).toBe(2);
		expect(si('\u22123 kN', 'force')).toBe(-3000);
	});

	it('uses the system default unit for bare numbers', () => {
		expect(si('10', 'force', 'kN-m')).toBe(10000);
		expect(si('10', 'force', 'N-mm')).toBe(10);
		expect(si('10', 'force', 'kip-ft')).toBe(44482.216152605);
		expect(si('10', 'force', 'lb-in')).toBe(44.482216152605);
		expect(si('6', 'length', 'kN-m')).toBe(6);
		expect(si('6000', 'length', 'N-mm')).toBe(6);
		expect(si('100', 'sectionLength', 'kN-m')).toBe(0.1);
		expect(si('4', 'sectionLength', 'kip-ft')).toBe(4 * 0.0254);
		expect(si('5', 'moment', 'kN-m')).toBe(5000);
		expect(si('5', 'distributed', 'N-mm')).toBe(5000);
		expect(si('200', 'modulus', 'kN-m')).toBe(200e9);
		expect(si('8000', 'inertia', 'kN-m')).toBe(8e-5);
	});
});

describe('parseQuantity: errors', () => {
	it('rejects a decimal comma with a hint', () => {
		expect(err('2,5', 'force')).toBe('Invalid number "2,5": use a dot as the decimal separator');
		expect(err('1,5 kN', 'force')).toContain('use a dot as the decimal separator');
		expect(err('1,25 kN', 'force')).toContain('use a dot as the decimal separator');
	});

	it('explains a thousands separator instead of suggesting a decimal dot', () => {
		// Regression: "1,000" was answered with "use a dot as the decimal separator", nudging toward 1.000 = 1.
		expect(err('1,000 N', 'force')).toBe('Invalid number "1,000": write numbers without separators, for example 1000 (use a dot for decimals: 1.5)');
		expect(err('12,500,000 N', 'force')).toContain('for example 12500000');
		expect(err('-1,000', 'force')).toContain('for example -1000');
	});

	it('refuses a typographic dash as a minus sign', () => {
		// Regression: an en dash (U+2013) from a word processor gave a vague "Expected a number".
		expect(err('\u201310 kN', 'force')).toBe('Use a plain "-" for a minus sign, not a typographic dash');
		expect(err('\u2014.5 kN', 'force')).toBe('Use a plain "-" for a minus sign, not a typographic dash');
	});

	it('rejects a unit of the wrong dimension', () => {
		expect(err('4 kN/m', 'force')).toBe('kN/m is not a force unit: use kN, N, kip or lb');
		expect(err('10 kN', 'distributed')).toContain('kN is not a distributed load unit');
		expect(err('2 m', 'moment')).toContain('m is not a moment unit');
		expect(err('8000 cm', 'inertia')).toContain('not an inertia');
		expect(err('200 kN', 'modulus')).toContain('kN is not a modulus unit');
		expect(err('3 kN', 'length')).toContain('kN is not a length unit');
		expect(err('3 GPa', 'sectionLength')).toContain('not a length unit');
	});

	it('rejects unknown units and lists valid ones', () => {
		expect(err('10 kNN', 'force')).toBe('Unknown unit "kNN": use kN, N, kip or lb');
		expect(err('2 furlongs', 'length')).toContain('m, mm, ft or in');
	});

	it('rejects bare numbers when a unit is required', () => {
		expect(err('200', 'modulus', 'kN-m', true)).toBe('Add a unit to "200", for example: 200 GPa');
		expect(err('8000', 'inertia', 'kN-m', true)).toContain('8000 cm^4');
		expect(parseQuantity('200 GPa', 'modulus', 'kN-m', { requireUnit: true })).toEqual({ ok: true, value: 200e9 });
	});

	it('rejects empty text, missing numbers and overflow', () => {
		expect(err('', 'force')).toBe('Expected a number');
		expect(err('kN', 'force')).toBe('Expected a number, got "kN"');
		expect(err('1e999 N', 'force')).toContain('too large');
	});

	it('checks the value after unit conversion, not only the typed number', () => {
		// Regression: "E 1e308 GPa" became Infinity and silently disabled deflection.
		expect(err('1e308 GPa', 'modulus')).toBe('The number "1e308" is too large in these units');
		expect(err('1e308 kN', 'force')).toBe('The number "1e308" is too large in these units');
		// A bare number goes through the system unit too (kN in kN-m).
		expect(err('1e308', 'force')).toBe('The number "1e308" is too large in these units');
		expect(err('5e-324 N', 'force')).toBe('The number "5e-324" is too small in these units');
		expect(err('1e-300 mm', 'length')).toBe('The number "1e-300" is too small in these units');
		// Zero and ordinary small values are fine.
		expect(si('0 kN', 'force')).toBe(0);
		expect(si('1e-12 kN', 'force')).toBe(1e-9);
	});

	it('shortens long user text quoted in messages', () => {
		const junk = 'a'.repeat(300);
		const message = err(`10 ${junk}`, 'force');
		expect(message).toBe(`Unknown unit "${'a'.repeat(30)}...": use kN, N, kip or lb`);
	});
});

describe('isUnitSystemId', () => {
	it('accepts exactly the four ids', () => {
		for (const id of SYSTEMS) expect(isUnitSystemId(id)).toBe(true);
		for (const value of ['kN m', 'si', 'constructor', '', 3, undefined, null]) expect(isUnitSystemId(value)).toBe(false);
	});
});

describe('splitQuantity and hasUnit', () => {
	it('splits number and unit', () => {
		expect(splitQuantity('10kN')).toEqual({ ok: true, number: '10', unit: 'kN' });
		expect(splitQuantity(' -2.5e3  N ')).toEqual({ ok: true, number: '-2.5e3', unit: 'N' });
		expect(splitQuantity('6')).toEqual({ ok: true, number: '6', unit: '' });
		expect(hasUnit('6')).toBe(false);
		expect(hasUnit('6 m')).toBe(true);
		expect(hasUnit('end')).toBe(false);
	});
});

describe('unit lookup', () => {
	it('normalises separators, case and superscripts', () => {
		expect(unitKey('kN·m')).toBe('knm');
		expect(unitKey('KN-M')).toBe('knm');
		expect(unitKey('cm⁴')).toBe('cm4');
		expect(unitKey('cm^4')).toBe('cm4');
		expect(unitKey('N/mm²')).toBe('n/mm2');
	});

	it('distinguishes load per length from moment', () => {
		expect(lookupUnit('kN/m')?.cls).toBe('distributed');
		expect(lookupUnit('kNm')?.cls).toBe('moment');
		expect(lookupUnit('kN/m^2')?.cls).toBe('pressure');
	});

	it('does not treat statement words as units', () => {
		for (const word of ['at', 'down', 'up', 'cw', 'ccw', 'from', 'to', 'end', 'x', 'start', 'mid']) {
			expect(isUnitSymbol(word), word).toBe(false);
		}
	});
});

describe('toDisplay and unitSymbol', () => {
	it('converts SI values to display units', () => {
		expect(toDisplay(18666.67, 'force', 'kN-m')).toBeCloseTo(18.66667, 10);
		expect(toDisplay(29390, 'moment', 'kN-m')).toBeCloseTo(29.39, 10);
		expect(toDisplay(0.0123, 'deflection', 'kN-m')).toBeCloseTo(12.3, 10);
		expect(toDisplay(8e-5, 'inertia', 'kN-m')).toBeCloseTo(8000, 8);
		expect(toDisplay(200e9, 'modulus', 'kN-m')).toBe(200);
		expect(toDisplay(200e9, 'modulus', 'N-mm')).toBe(200000);
		expect(toDisplay(4448.2216152605, 'force', 'kip-ft')).toBe(1);
		expect(toDisplay(0.3048, 'length', 'kip-ft')).toBe(1);
		expect(toDisplay(6, 'length', 'N-mm')).toBe(6000);
	});

	it('returns the display symbols', () => {
		expect(unitSymbol('moment', 'kN-m')).toBe('kN·m');
		expect(unitSymbol('inertia', 'N-mm')).toBe('mm⁴');
		expect(unitSymbol('deflection', 'kip-ft')).toBe('in');
		expect(unitSymbol('slope', 'lb-in')).toBe('rad');
	});
});

describe('formatNumber', () => {
	it('prints fixed decimals', () => {
		expect(formatNumber(18.666666, 2)).toBe('18.67');
		expect(formatNumber(-15.333, 2)).toBe('-15.33');
		expect(formatNumber(3, 0)).toBe('3');
		expect(formatNumber(2.5, 3)).toBe('2.500');
	});

	it('never prints -0', () => {
		expect(formatNumber(-0, 2)).toBe('0.00');
		expect(formatNumber(0, 2)).toBe('0.00');
		expect(formatNumber(-1e-15, 2)).toBe('0.00');
		expect(formatNumber(5e-12, 2)).toBe('0.00');
	});

	it('uses 3 significant digits in plain decimals for small values that would read as zero', () => {
		// Regression: the overhang example showed "5.45e-3 in" and decimals 0 showed reactions as "5.00e-1 kN".
		expect(formatNumber(0.00545, 2)).toBe('0.00545');
		expect(formatNumber(-0.0025, 2)).toBe('-0.00250');
		expect(formatNumber(0.000833, 2)).toBe('0.000833');
		expect(formatNumber(0.000312, 2)).toBe('0.000312');
		expect(formatNumber(-0.000312, 2)).toBe('-0.000312');
		expect(formatNumber(0.004, 2)).toBe('0.00400');
		expect(formatNumber(0.0001, 2)).toBe('0.000100');
		expect(formatNumber(0.5, 0)).toBe('0.500');
		expect(formatNumber(0.6667, 0)).toBe('0.667');
		expect(formatNumber(0.000123, 3)).toBe('0.000123');
		// At or above 10^-decimals the fixed form is kept, whatever the digits.
		expect(formatNumber(0.01, 2)).toBe('0.01');
		expect(formatNumber(0.00123, 3)).toBe('0.001');
		expect(formatNumber(1.4, 0)).toBe('1');
		// More decimals than the value needs: plain fixed decimals, even below 1e-4.
		expect(formatNumber(0.00005, 6)).toBe('0.000050');
	});

	it('uses exponent form below 1e-4 when the decimals would hide the value', () => {
		expect(formatNumber(0.0000312, 2)).toBe('3.12e-5');
		expect(formatNumber(-0.0000312, 0)).toBe('-3.12e-5');
		expect(formatNumber(4e-5, 2)).toBe('4.00e-5');
	});

	it('uses exponent form for very large values by default (diagram labels)', () => {
		expect(formatNumber(12345678, 2)).toBe('1.23e7');
		expect(formatNumber(-2e9, 1)).toBe('-2.00e9');
		expect(formatNumber(9999999, 0)).toBe('9999999');
	});

	it('prints large values with fixed decimals below a larger limit (results table)', () => {
		// Regression: a 2e8 N·mm moment printed "2.00e8" next to "100000.0000 N" at decimals 4.
		expect(formatNumber(2e8, 4, TABLE_PLAIN_LIMIT)).toBe('200000000.0000');
		expect(formatNumber(78125000, 2, TABLE_PLAIN_LIMIT)).toBe('78125000.00');
		expect(formatNumber(-1.005e7, 0, TABLE_PLAIN_LIMIT)).toBe('-10050000');
		expect(formatNumber(2e15, 2, TABLE_PLAIN_LIMIT)).toBe('2.00e15');
		expect(formatQuantity(2e5, 'moment', 'N-mm', 4, TABLE_PLAIN_LIMIT)).toBe('200000000.0000 N·mm');
		// Same value with the default limit stays short.
		expect(formatQuantity(2e5, 'moment', 'N-mm', 4)).toBe('2.00e8 N·mm');
	});

	it('falls back to the default limit for a nonsense limit and caps it where toFixed stops', () => {
		expect(formatNumber(12345678, 2, Number.NaN)).toBe('1.23e7');
		expect(formatNumber(12345678, 2, -1)).toBe('1.23e7');
		expect(formatNumber(1e22, 0, Number.POSITIVE_INFINITY)).toBe('1.00e22');
	});

	it('passes non-finite values through', () => {
		expect(formatNumber(Number.NaN, 2)).toBe('NaN');
		expect(formatNumber(Number.POSITIVE_INFINITY, 2)).toBe('Infinity');
	});
});

describe('formatCompact and formatQuantity', () => {
	it('trims trailing zeros', () => {
		expect(formatCompact(6)).toBe('6');
		expect(formatCompact(7.1)).toBe('7.1');
		expect(formatCompact(100.00000000000001)).toBe('100');
		expect(formatCompact(0.25)).toBe('0.25');
		expect(formatCompact(-0.0001)).toBe('0');
		expect(formatCompact(1.23456, 2)).toBe('1.23');
	});

	it('formats SI values with display units', () => {
		expect(formatQuantity(18666.666, 'force', 'kN-m', 2)).toBe('18.67 kN');
		expect(formatQuantity(29390, 'moment', 'kN-m', 2)).toBe('29.39 kN·m');
		expect(formatQuantity(0.0254, 'deflection', 'kip-ft', 3)).toBe('1.000 in');
		expect(formatQuantity(4000, 'distributed', 'N-mm', 1)).toBe('4.0 N/mm');
		expect(formatQuantity(-0, 'force', 'kN-m', 2)).toBe('0.00 kN');
	});
});

describe('formatNumber round-off snapping', () => {
	// Regression: two exact .375 reactions printed differently ("9.37 kN" next to "19.38 kN")
	// because one came out of the solver as 9.374999999999996.
	it('rounds a value one ulp below a tie like the tie itself', () => {
		expect(formatNumber(9.374999999999996, 2)).toBe('9.38');
		expect(formatNumber(19.375, 2)).toBe('19.38');
		expect(formatQuantity(9374.999999999996, 'force', 'kN-m', 2)).toBe('9.38 kN');
		// Real differences beyond 12 significant digits are not invented.
		expect(formatNumber(9.3749, 2)).toBe('9.37');
		expect(formatNumber(-2.4999999999999996, 0)).toBe('-3');
	});
});

describe('formatPosition and clampDecimals', () => {
	it('writes a position in the length unit without trailing zeros', () => {
		expect(formatPosition(6, 'kN-m')).toBe('6 m');
		expect(formatPosition(1.524, 'kip-ft')).toBe('5 ft');
		expect(formatPosition(0.0254 * 30, 'kip-ft')).toBe('2.5 ft');
		expect(formatPosition(2.16666, 'N-mm', 1)).toBe('2166.7 mm');
	});

	it('clamps decimals into 0..6 and falls back to the default', () => {
		expect([-1, 0, 2.4, 2.6, 6, 9].map((d) => clampDecimals(d))).toEqual([0, 0, 2, 3, 6, 6]);
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '3', undefined, null]) expect(clampDecimals(bad)).toBe(DEFAULT_DECIMALS);
		expect(DEFAULT_DECIMALS).toBe(2);
	});
});
