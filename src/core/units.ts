/**
 * Unit handling: parsing typed quantities into SI and formatting SI values for display.
 *
 * Everything inside the plugin is stored in SI base units (m, N, N·m, N/m,
 * Pa, m^4). This module is the only place that knows about other units:
 *
 * - `parseQuantity` turns raw text such as "10 kN" or "8000 cm^4" into SI.
 *   A bare number takes the default unit of the active unit system.
 * - `toDisplay`, `formatNumber` and `formatQuantity` turn SI values back into
 *   the display units of a unit system ("18.67 kN").
 *
 * Unit symbols are matched case-insensitively and with any product separator
 * ("kN·m", "kN*m", "kN-m", "kN.m", "kNm" are the same unit). The exceptions
 * are refused rather than guessed: "mN" and "mPa" (milli, not mega), and the
 * one-letter kip spellings ("k", "k-ft", "k/ft") inside SI blocks.
 */
import { clipText, ownValue } from './lookup';
import type { Dimension, UnitSystemId } from './types';

/** Display and default-input units of one unit system. */
export interface UnitSystemInfo {
	id: UnitSystemId;
	/** Text written after `units` by the serializer, e.g. "kN m". */
	keyword: string;
	/** Label for dropdowns, e.g. "kN, m (SI)". */
	label: string;
	/** Unit symbol used for each dimension, both for bare input numbers and for display. */
	symbols: Record<Dimension, string>;
}

/**
 * All unit systems, keyed by id. Products are written with "·" and powers with
 * superscripts ("cm⁴") so that labels read like a textbook; the parser accepts
 * the same symbols back, as well as plain-keyboard spellings ("kNm", "cm^4").
 */
export const UNIT_SYSTEMS: Record<UnitSystemId, UnitSystemInfo> = {
	'kN-m': {
		id: 'kN-m',
		keyword: 'kN m',
		label: 'kN, m (SI)',
		symbols: {
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
		},
	},
	'N-mm': {
		id: 'N-mm',
		keyword: 'N mm',
		label: 'N, mm (SI)',
		symbols: {
			length: 'mm',
			force: 'N',
			moment: 'N·mm',
			distributed: 'N/mm',
			sectionLength: 'mm',
			deflection: 'mm',
			stress: 'MPa',
			modulus: 'MPa',
			inertia: 'mm⁴',
			slope: 'rad',
		},
	},
	'kip-ft': {
		id: 'kip-ft',
		keyword: 'kip ft',
		label: 'kip, ft (US)',
		symbols: {
			length: 'ft',
			force: 'kip',
			moment: 'kip·ft',
			distributed: 'kip/ft',
			sectionLength: 'in',
			deflection: 'in',
			stress: 'ksi',
			modulus: 'ksi',
			inertia: 'in⁴',
			slope: 'rad',
		},
	},
	'lb-in': {
		id: 'lb-in',
		keyword: 'lb in',
		label: 'lb, in (US)',
		symbols: {
			length: 'in',
			force: 'lb',
			moment: 'lb·in',
			distributed: 'lb/in',
			sectionLength: 'in',
			deflection: 'in',
			stress: 'psi',
			modulus: 'psi',
			inertia: 'in⁴',
			slope: 'rad',
		},
	},
};

/** True for one of the four unit system ids (for values read from settings or other untyped sources). */
export function isUnitSystemId(value: unknown): value is UnitSystemId {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(UNIT_SYSTEMS, value);
}

/** Result of parsing a raw quantity. */
export type QuantityResult = { ok: true; value: number } | { ok: false; message: string };

/**
 * What a unit symbol physically measures. Several `Dimension`s share a class:
 * `length`, `sectionLength` and `deflection` are all lengths, `modulus` and
 * `stress` are both pressures.
 */
export type UnitClass = 'length' | 'force' | 'moment' | 'distributed' | 'pressure' | 'inertia' | 'angle';

/** A known unit: its class and how to convert one of it to SI. */
export interface UnitDef {
	cls: UnitClass;
	/** SI value of 1 unit (e.g. 1 kN = 1000 N). */
	factor: number;
	/**
	 * Set when `factor` is exactly 1/divisor for an integer divisor (mm, cm^4, ...).
	 * Dividing by 1000 is correctly rounded while multiplying by the inexact
	 * binary 0.001 is not, so 1500 mm becomes exactly 1.5 m.
	 */
	divisor?: number;
}

/** Physical class expected for each dimension. */
const DIMENSION_CLASS: Record<Dimension, UnitClass> = {
	length: 'length',
	sectionLength: 'length',
	deflection: 'length',
	force: 'force',
	moment: 'moment',
	distributed: 'distributed',
	modulus: 'pressure',
	stress: 'pressure',
	inertia: 'inertia',
	slope: 'angle',
};

// Exact conversion factors to SI. Imperial values derive from the
// international inch (0.0254 m exactly) and pound-force (4.4482216152605 N
// exactly). They are written out as literals (the double nearest to the exact
// decimal product, in shortest form) because computing the products in
// floating point can differ from the correctly rounded value in the last bit.
const LBF = 4.4482216152605;
const KIP = 4448.2216152605;
const LBF_FT = 1.3558179483314003;
const LBF_IN = 0.1129848290276167;
const KIP_FT = 1355.8179483314004;
const KIP_IN = 112.9848290276167;
const LBF_PER_FT = 14.593902937206364;
const LBF_PER_IN = 175.12683524647636;
const KIP_PER_FT = 14593.902937206363;
const KIP_PER_IN = 175126.83524647637;
const PSI = 6894.757293168361;
const KSI = 6894757.293168361;
const MSI = 6.894757293168361e9;
/** 0.0254^4 written exactly (254^4 = 4162314256). */
const IN4 = 4.162314256e-7;

/**
 * Builds every spelling of an imperial force-length product in both orders,
 * e.g. lb·ft, lbf·ft, ft·lb. Separators are stripped by `unitKey`, so one
 * spelling per order is enough.
 */
function imperialProducts(forces: string[], lengths: string[]): string[] {
	const out: string[] = [];
	for (const f of forces) {
		for (const l of lengths) {
			out.push(f + l, l + f);
		}
	}
	return out;
}

/** Builds force/length spellings, e.g. lb/ft, lbf/ft, lbs/ft. */
function perLength(forces: string[], lengths: string[]): string[] {
	const out: string[] = [];
	for (const f of forces) {
		for (const l of lengths) out.push(`${f}/${l}`);
	}
	return out;
}

const LB_NAMES = ['lb', 'lbf', 'lbs'];
const KIP_NAMES = ['kip', 'kips', 'k'];

/** Unit table: [class, SI factor, spellings]. Spellings are normalised by `unitKey`. */
const UNIT_ROWS: Array<[UnitClass, number, string[]]> = [
	// Length
	['length', 1, ['m', 'meter', 'meters', 'metre', 'metres']],
	['length', 0.01, ['cm']],
	['length', 0.001, ['mm']],
	['length', 0.0254, ['in', 'inch', 'inches']],
	['length', 0.3048, ['ft', 'foot', 'feet']],
	// Force
	['force', 1, ['N']],
	['force', 1e3, ['kN']],
	['force', 1e6, ['MN']],
	['force', LBF, LB_NAMES],
	['force', KIP, KIP_NAMES],
	// Moment (SI products are only accepted in force-length order: "m·N"
	// would be ambiguous with mN, millinewton)
	['moment', 1, ['N·m']],
	['moment', 1e3, ['kN·m']],
	['moment', 1e6, ['MN·m']],
	['moment', 1e-3, ['N·mm']],
	['moment', 1, ['kN·mm']],
	['moment', 1e3, ['MN·mm']],
	['moment', 0.01, ['N·cm']],
	['moment', 10, ['kN·cm']],
	['moment', LBF_FT, imperialProducts(LB_NAMES, ['ft'])],
	['moment', LBF_IN, imperialProducts(LB_NAMES, ['in'])],
	['moment', KIP_FT, imperialProducts(KIP_NAMES, ['ft'])],
	['moment', KIP_IN, imperialProducts(KIP_NAMES, ['in'])],
	// Distributed load
	['distributed', 1, ['N/m']],
	['distributed', 1e3, ['kN/m', 'N/mm']],
	['distributed', 1e6, ['kN/mm', 'MN/m']],
	['distributed', 100, ['N/cm']],
	['distributed', 1e5, ['kN/cm']],
	['distributed', LBF_PER_FT, [...perLength(LB_NAMES, ['ft']), 'plf']],
	['distributed', LBF_PER_IN, [...perLength(LB_NAMES, ['in']), 'pli']],
	['distributed', KIP_PER_FT, [...perLength(KIP_NAMES, ['ft']), 'klf']],
	['distributed', KIP_PER_IN, perLength(KIP_NAMES, ['in'])],
	// Pressure: Young's modulus and stress
	['pressure', 1, ['Pa', 'N/m^2']],
	['pressure', 1e3, ['kPa', 'kN/m^2']],
	['pressure', 1e6, ['MPa', 'N/mm^2', 'MN/m^2']],
	['pressure', 1e9, ['GPa', 'kN/mm^2']],
	['pressure', PSI, ['psi']],
	['pressure', KSI, ['ksi']],
	['pressure', MSI, ['Msi']],
	// Second moment of area
	['inertia', 1, ['m^4']],
	['inertia', 1e-8, ['cm^4']],
	['inertia', 1e-12, ['mm^4']],
	['inertia', IN4, ['in^4']],
	// Slope
	['angle', 1, ['rad']],
];

/**
 * Normalises a unit spelling to a lookup key: case-insensitive, superscripts
 * become digits, and "^", spaces and product separators (· ⋅ • * - .) are
 * dropped, so "kN·m", "KN-M", "kN m" and "kNm" all become "knm". Slashes are
 * kept because "kN/m" (load) and "kNm" (moment) are different units.
 */
export function unitKey(symbol: string): string {
	return symbol
		.toLowerCase()
		.replace(/²/g, '2')
		.replace(/³/g, '3')
		.replace(/⁴/g, '4')
		.replace(/[\s^·⋅•*.-]/g, '');
}

/** Lookup table built once from UNIT_ROWS. */
const UNIT_MAP: Map<string, UnitDef> = (() => {
	const map = new Map<string, UnitDef>();
	for (const [cls, factor, names] of UNIT_ROWS) {
		// Use exact division for SI submultiples (see UnitDef.divisor).
		const inverse = Math.round(1 / factor);
		const def: UnitDef = factor < 1 && inverse > 1 && 1 / inverse === factor ? { cls, factor, divisor: inverse } : { cls, factor };
		for (const name of names) map.set(unitKey(name), def);
	}
	return map;
})();

/** Finds a unit by any accepted spelling (case-insensitive), or undefined. */
export function lookupUnit(symbol: string): UnitDef | undefined {
	return UNIT_MAP.get(unitKey(symbol));
}

/** True when `text` is a recognised unit symbol of any dimension. */
export function isUnitSymbol(text: string): boolean {
	return lookupUnit(text) !== undefined;
}

/** Converts `value` expressed in `def` to SI. */
function toSI(value: number, def: UnitDef): number {
	return def.divisor !== undefined ? value / def.divisor : value * def.factor;
}

/** Converts an SI value to `def`. */
function fromSI(valueSI: number, def: UnitDef): number {
	return def.divisor !== undefined ? valueSI * def.divisor : valueSI / def.factor;
}

/** Unit definition of the default/display symbol for a dimension in a system. */
function systemUnit(dimension: Dimension, system: UnitSystemId): UnitDef {
	const def = lookupUnit(UNIT_SYSTEMS[system].symbols[dimension]);
	// Every symbol in UNIT_SYSTEMS is in UNIT_ROWS (checked by tests).
	if (!def) throw new Error(`Missing unit definition for ${dimension} in ${system}`);
	return def;
}

/** Accepted spellings after `units`, normalised by `unitSystemKey`. */
const UNIT_SYSTEM_ALIASES: Record<string, UnitSystemId> = {
	'kn m': 'kN-m',
	si: 'kN-m',
	'n mm': 'N-mm',
	'kip ft': 'kip-ft',
	'kips ft': 'kip-ft',
	'k ft': 'kip-ft',
	us: 'kip-ft',
	imperial: 'kip-ft',
	'lb in': 'lb-in',
	'lbf in': 'lb-in',
	'lbs in': 'lb-in',
};

/** Lower-cases and turns any run of separators ("-", ",", "/", "·", spaces) into one space. */
function unitSystemKey(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[\s,\-·*/]+/g, ' ')
		.trim();
}

/**
 * Parses the text after `units`, e.g. "kN m", "kN-m", "N mm", "kip ft", "lb in".
 * Also accepts "SI" (kN-m) and "US" / "imperial" (kip-ft), and the glued
 * forms "kNm", "Nmm", "kipft", "lbin". Case-insensitive. Returns null when unknown.
 */
export function parseUnitSystem(text: string): UnitSystemId | null {
	const key = unitSystemKey(text);
	const direct = ownValue(UNIT_SYSTEM_ALIASES, key);
	if (direct) return direct;
	// Glued spelling: compare with every alias with its spaces removed.
	const glued = key.replace(/ /g, '');
	for (const [alias, id] of Object.entries(UNIT_SYSTEM_ALIASES)) {
		if (alias.includes(' ') && alias.replace(/ /g, '') === glued) return id;
	}
	return null;
}

/** "a force unit", used in "kN/m is not a force unit". */
const UNIT_KIND: Record<Dimension, string> = {
	length: 'a length unit',
	sectionLength: 'a length unit',
	deflection: 'a length unit',
	force: 'a force unit',
	moment: 'a moment unit',
	distributed: 'a distributed load unit',
	modulus: 'a modulus unit',
	stress: 'a stress unit',
	inertia: 'an inertia (second moment of area) unit',
	slope: 'an angle unit',
};

/** Typical units listed in error messages so the user knows what to type. */
export const UNIT_HINTS: Record<Dimension, string> = {
	length: 'm, mm, ft or in',
	sectionLength: 'mm, cm, m or in',
	deflection: 'mm, m or in',
	force: 'kN, N, kip or lb',
	moment: 'kN·m, N·mm, kip·ft or lb·in',
	distributed: 'kN/m, N/mm, kip/ft or lb/ft',
	modulus: 'GPa, MPa, ksi or psi',
	stress: 'MPa, kPa, ksi or psi',
	inertia: 'cm^4, mm^4, in^4 or m^4',
	slope: 'rad',
};

/** Example quantity per dimension for "add a unit" messages. */
const UNIT_EXAMPLES: Record<Dimension, string> = {
	length: '6 m',
	sectionLength: '200 mm',
	deflection: '10 mm',
	force: '10 kN',
	moment: '5 kN·m',
	distributed: '4 kN/m',
	modulus: '200 GPa',
	stress: '250 MPa',
	inertia: '8000 cm^4',
	slope: '0.01 rad',
};

/** A raw quantity split into its number text and unit text (unit may be ""). */
export type SplitQuantity = { ok: true; number: string; unit: string } | { ok: false; message: string };

/**
 * Message for a number written with a comma. Groups of exactly three digits
 * ("1,000", "12,500,000") are a thousands separator; anything else ("2,5")
 * is a decimal comma. Both are rejected rather than guessed, because reading
 * "1,000" as 1 or 1000 (or "2,5" as 2 or 25) would be silently wrong.
 */
export function commaNumberMessage(number: string): string {
	const shown = clipText(number);
	if (/^[+-]?\d{1,3}(?:,\d{3})+$/.test(number)) {
		return `Invalid number "${shown}": write numbers without separators, for example ${number.replace(/,/g, '')} (use a dot for decimals: 1.5)`;
	}
	return `Invalid number "${shown}": use a dot as the decimal separator`;
}

/**
 * Message for a typographic dash (en dash U+2013 or em dash U+2014) used
 * where a minus sign belongs, as word processors insert. It is rejected
 * rather than read as a minus: a wrong sign flips the load direction.
 */
export const DASH_MINUS_MESSAGE = 'Use a plain "-" for a minus sign, not a typographic dash';

/**
 * Splits "10 kN", "10kN" or "-2.5e3 N" into number and unit text without
 * interpreting the unit. Rejects a comma in the number ("2,5", "1,000") with
 * a hint, since silently reading it would be dangerous. A leading Unicode
 * minus (U+2212, common when copying from PDFs) is accepted as "-"; a
 * leading typographic dash is rejected (see DASH_MINUS_MESSAGE).
 */
export function splitQuantity(raw: string): SplitQuantity {
	const text = raw.trim().replace(/^\u2212/, '-');
	if (text === '') return { ok: false, message: 'Expected a number' };
	if (/^[\u2013\u2014]\.?\d/.test(text)) return { ok: false, message: DASH_MINUS_MESSAGE };
	// Every ",digits" group, so "1,000,000" is quoted whole.
	const comma = /^[+-]?\d*(?:,\d+)+/.exec(text);
	if (comma) return { ok: false, message: commaNumberMessage(comma[0]) };
	// Optional sign, digits with an optional fraction (or a bare ".5"), optional exponent.
	const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*)$/.exec(text);
	if (!match) return { ok: false, message: `Expected a number, got "${clipText(text)}"` };
	return { ok: true, number: match[1] ?? '', unit: (match[2] ?? '').trim() };
}

/** True when the raw quantity has a unit after its number. */
export function hasUnit(raw: string): boolean {
	const parts = splitQuantity(raw);
	return parts.ok && parts.unit !== '';
}

/**
 * One-letter kip spellings ("10 k", "5 k-ft", "2 k/ft"). They are standard US
 * shorthand, but in an SI block "10 k" more likely means 10 kN (or ten
 * thousand newtons), a factor of 4.45 away from 10 kip. SI blocks therefore
 * require "kip" (or "kN") to be written out; "kip", "kips" and "klf" stay
 * accepted everywhere, as are all spellings in kip-ft and lb-in blocks.
 */
const SI_AMBIGUOUS_KIP = new Set(['k', 'kft', 'ftk', 'kin', 'ink', 'k/ft', 'k/in'].map(unitKey));

/** What to write instead of an ambiguous kip spelling, by unit class. */
const KIP_OR_KN: Partial<Record<UnitClass, string>> = {
	force: 'kip or kN',
	moment: 'kip·ft or kN·m',
	distributed: 'kip/ft or kN/m',
};

/**
 * Smallest non-zero SI magnitude accepted. Below it, products in the solver
 * (E·I, q·L⁴) underflow to zero or lose all precision, and the failure would
 * surface as a misleading message far from the input.
 */
const MIN_SI_MAGNITUDE = 1e-300;

/**
 * Converts a parsed number to SI and checks the result is usable. The typed
 * number is finite, but the unit factor can still overflow it ("1e308 GPa")
 * or underflow it ("5e-324 N"), which must be reported here, at the input,
 * rather than as Infinity in the table or a solver error.
 */
function convert(value: number, numberText: string, def: UnitDef): QuantityResult {
	const si = toSI(value, def);
	const shown = clipText(numberText);
	if (!Number.isFinite(si)) return { ok: false, message: `The number "${shown}" is too large in these units` };
	if (si !== 0 && Math.abs(si) < MIN_SI_MAGNITUDE) return { ok: false, message: `The number "${shown}" is too small in these units` };
	return { ok: true, value: si };
}

/**
 * Parses a raw quantity such as "10", "10 kN", "10kN", "-2.5e3 N", "1,5" (rejected)
 * into SI base units for the given dimension. A bare number takes the unit
 * system's default unit for that dimension. A unit of the wrong dimension is
 * an error ("kN/m is not a force unit"). When `requireUnit` is true a bare
 * number is an error (used for E and I, where unit mistakes are common).
 *
 * Two spellings are refused although they look like units: milli units
 * typed with a lower-case m ("mN", "mPa"; unit lookup is case-insensitive,
 * so they would otherwise read as MN and MPa, a factor of 1e9 off), and the
 * one-letter kip spellings in SI blocks (see SI_AMBIGUOUS_KIP).
 */
export function parseQuantity(
	raw: string,
	dimension: Dimension,
	system: UnitSystemId,
	options?: { requireUnit?: boolean },
): QuantityResult {
	const parts = splitQuantity(raw);
	if (!parts.ok) return parts;
	const value = Number(parts.number);
	if (!Number.isFinite(value)) return { ok: false, message: `The number "${clipText(parts.number)}" is too large` };

	if (parts.unit === '') {
		if (options?.requireUnit) {
			return { ok: false, message: `Add a unit to "${clipText(raw.trim())}", for example: ${UNIT_EXAMPLES[dimension]}` };
		}
		return convert(value, parts.number, systemUnit(dimension, system));
	}

	const unit = clipText(parts.unit);
	// Case-sensitive on purpose: all lower-case "mpa" is a common way to type MPa.
	if (/^m(?:N|Pa)/.test(parts.unit)) {
		return { ok: false, message: `Unknown unit "${unit}": milli units are not supported; for mega write a capital M (MN, MPa)` };
	}
	const def = lookupUnit(parts.unit);
	if (!def) return { ok: false, message: `Unknown unit "${unit}": use ${UNIT_HINTS[dimension]}` };
	if (def.cls !== DIMENSION_CLASS[dimension]) {
		return { ok: false, message: `${unit} is not ${UNIT_KIND[dimension]}: use ${UNIT_HINTS[dimension]}` };
	}
	if ((system === 'kN-m' || system === 'N-mm') && SI_AMBIGUOUS_KIP.has(unitKey(parts.unit))) {
		return { ok: false, message: `"${unit}" is ambiguous in an SI block: write ${KIP_OR_KN[def.cls] ?? 'kip or kN'}` };
	}
	return convert(value, parts.number, def);
}

/** Converts an SI value to the display unit of `dimension` in `system`. */
export function toDisplay(valueSI: number, dimension: Dimension, system: UnitSystemId): number {
	return fromSI(valueSI, systemUnit(dimension, system));
}

/** Display unit symbol, e.g. "kN·m" for moment in kN-m. */
export function unitSymbol(dimension: Dimension, system: UnitSystemId): string {
	return UNIT_SYSTEMS[system].symbols[dimension];
}

/**
 * Display values below this magnitude are treated as exactly zero. The solver
 * leaves floating point round-off such as 5e-12 kN·m at a free end; no real
 * engineering result is this small in display units (mm, kN, MPa, rad).
 */
const ZERO_FLOOR = 1e-10;

/** Exponent form with 3 significant digits and no "+" ("1.23e7", "3.12e-5"). */
function toShortExponential(value: number): string {
	return value.toExponential(2).replace('e+', 'e');
}

/**
 * Default magnitude from which formatNumber switches to exponent form, so
 * diagram labels stay short ("7.81e7" rather than "78125000.00").
 */
const LABEL_PLAIN_LIMIT = 1e7;

/**
 * Exponent threshold for places with room for long numbers (the results
 * table, warning messages), passed as `maxPlain`: they print the decimals
 * the user asked for ("78125000.00 N·mm"), like every other row. Beyond
 * 1e15 a double no longer holds the digits that fixed notation would print.
 */
export const TABLE_PLAIN_LIMIT = 1e15;

/**
 * Non-zero values smaller than 10^-decimals (which would read as 0) are
 * printed with 3 significant digits: plain decimals down to this magnitude
 * ("0.00545"), exponent form below it ("3.12e-5"), where the zeros would be
 * hard to count.
 */
const SMALL_PLAIN_LIMIT = 1e-4;

/**
 * Formats a number with a fixed number of decimals, never printing "-0.00".
 *
 * - The value is first rounded to 12 significant digits, so binary round-off
 *   never decides a tie ("9.374999999999996" prints like 9.375).
 * - Magnitudes below 1e-10 are round-off noise and print as zero.
 * - Non-zero magnitudes below 10^-decimals would read as zero, so they get 3
 *   significant digits instead: "0.00545" (decimals 2), "0.500" (decimals 0),
 *   and exponent form only below 1e-4 ("3.12e-5").
 * - Magnitudes of `maxPlain` and above use exponent form with 3 significant
 *   digits ("1.23e7"). The default (1e7) keeps diagram labels short; the
 *   results table passes TABLE_PLAIN_LIMIT so it honours the decimals.
 */
export function formatNumber(raw: number, decimals: number, maxPlain: number = LABEL_PLAIN_LIMIT): string {
	if (!Number.isFinite(raw)) return String(raw);
	// Snap away binary round-off before rounding to the decimals: an exact
	// 9.375 kN reaction can come out of the solver as 9.374999999999996 and
	// would print "9.37" next to another exact .375 printed "9.38". Twelve
	// significant digits are more than the solver's own accuracy.
	const value = Number(raw.toPrecision(12));
	// toFixed accepts 0..100; anything outside a sane range is a caller bug.
	const d = Math.max(0, Math.min(20, Math.round(decimals)));
	// toFixed itself switches to exponent form at 1e21, so cap the limit there;
	// a NaN or non-positive limit falls back to the default.
	const limit = maxPlain > 0 ? Math.min(maxPlain, 1e21) : LABEL_PLAIN_LIMIT;
	const abs = Math.abs(value);
	if (abs < ZERO_FLOOR) return (0).toFixed(d);
	if (abs >= limit) return toShortExponential(value);
	if (abs < Math.pow(10, -d)) {
		// toPrecision stays in fixed notation for magnitudes down to 1e-6.
		return abs < SMALL_PLAIN_LIMIT ? toShortExponential(value) : value.toPrecision(3);
	}
	const text = value.toFixed(d);
	// Defensive: a negative value that rounds to zero must not show a minus sign.
	return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
}

/**
 * Short form for messages and labels: at most `maxDecimals` decimals with
 * trailing zeros removed ("6", "7.1", "0.25"). Never prints "-0".
 */
export function formatCompact(value: number, maxDecimals = 3): string {
	if (!Number.isFinite(value)) return String(value);
	let text = value.toFixed(maxDecimals);
	if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
	return text === '-0' ? '0' : text;
}

/**
 * Converts to display units and appends the symbol: "18.67 kN". `maxPlain`
 * is passed to formatNumber (exponent form from that magnitude on).
 */
export function formatQuantity(
	valueSI: number,
	dimension: Dimension,
	system: UnitSystemId,
	decimals: number,
	maxPlain?: number,
): string {
	return `${formatNumber(toDisplay(valueSI, dimension, system), decimals, maxPlain)} ${unitSymbol(dimension, system)}`;
}

/**
 * A position with its unit for messages: "6 m", "2.5 ft" (at most
 * `maxDecimals` decimals, trailing zeros removed).
 */
export function formatPosition(x: number, system: UnitSystemId, maxDecimals = 3): string {
	return `${formatCompact(toDisplay(x, 'length', system), maxDecimals)} ${unitSymbol('length', system)}`;
}

/**
 * At least `digits` significant digits, without trailing zeros: "7999",
 * "6667", "0.07304", "29008" (the integer part is never rounded off). From
 * 1e7 up, and below 1e-4, exponent form without "+": "7.999e7", "2.9e7".
 * Magnitudes below `zeroFloor` (default 1e-10, like formatNumber) are
 * round-off and print as "0"; pass 0 for values that are never round-off.
 *
 * Used for input properties (E, I), whose own digits matter more than the
 * results' decimal places: a typed "200 GPa" stays "200", and a derived
 * I = 7998.987 cm⁴ reads "7999" instead of carrying spurious digits.
 */
export function formatSignificant(value: number, digits = 4, zeroFloor: number = ZERO_FLOOR): string {
	if (!Number.isFinite(value)) return String(value);
	const abs = Math.abs(value);
	if (abs === 0 || abs < zeroFloor) return '0';
	if (abs >= 1e7 || abs < 1e-4) {
		const [mantissa = '', exponent = ''] = value.toExponential(digits - 1).split('e');
		return `${trimZeros(mantissa)}e${exponent.replace('+', '')}`;
	}
	return trimZeros(value.toFixed(Math.max(0, digits - 1 - Math.floor(Math.log10(abs)))));
}

/** Trailing zeros of a decimal fraction ("2.900" -> "2.9", "200.0" -> "200"); integers are left alone. */
function trimZeros(text: string): string {
	return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * Deflection as a fraction of a length, the way engineers quote it: "L/359".
 * Rounded DOWN so the ratio is never more flattering than the truth (L/359.6
 * reads L/359, so it never seems to pass an L/360 limit it fails). A
 * deflection larger than the length reads "1.3 × L". The sign of
 * `deflection` is ignored; it must not be zero.
 *
 * The results table and the large-deflection warning both use it, so they
 * always agree.
 */
export function formatSpanRatio(length: number, deflection: number): string {
	const d = Math.abs(deflection);
	const n = length / d;
	return n >= 1 ? `L/${Math.floor(n)}` : `${formatCompact(d / length, 1)} × L`;
}

/** Smallest and largest number of decimals the display accepts (settings and renderers). */
export const DECIMALS_MIN = 0;
export const DECIMALS_MAX = 6;
/** Decimals used when none (or nonsense) is given. */
export const DEFAULT_DECIMALS = 2;

/**
 * Rounds and clamps a decimals value into DECIMALS_MIN..DECIMALS_MAX.
 * Non-numbers fall back to DEFAULT_DECIMALS. Used when loading settings and
 * again right before rendering, so a hand-edited data.json can never make
 * `toFixed` throw or blow up the layout.
 */
export function clampDecimals(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DECIMALS;
	return Math.min(DECIMALS_MAX, Math.max(DECIMALS_MIN, Math.round(value)));
}
