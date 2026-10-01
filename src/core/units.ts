/**
 * Unit handling: parsing typed quantities into SI and formatting SI values for display.
 * STUB: to be implemented.
 */
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

/** All unit systems, keyed by id. */
export declare const UNIT_SYSTEMS: Record<UnitSystemId, UnitSystemInfo>;

/** Result of parsing a raw quantity. */
export type QuantityResult = { ok: true; value: number } | { ok: false; message: string };

/**
 * Parses the text after `units`, e.g. "kN m", "kN-m", "N mm", "kip ft", "lb in".
 * Case-insensitive. Returns null when unknown.
 */
export function parseUnitSystem(text: string): UnitSystemId | null {
	throw new Error('not implemented');
}

/**
 * Parses a raw quantity such as "10", "10 kN", "10kN", "-2.5e3 N", "1,5" (rejected)
 * into SI base units for the given dimension. A bare number takes the unit
 * system's default unit for that dimension. A unit of the wrong dimension is
 * an error ("kN/m is not a force unit"). When `requireUnit` is true a bare
 * number is an error (used for E and I, where unit mistakes are common).
 */
export function parseQuantity(
	raw: string,
	dimension: Dimension,
	system: UnitSystemId,
	options?: { requireUnit?: boolean },
): QuantityResult {
	throw new Error('not implemented');
}

/** Converts an SI value to the display unit of `dimension` in `system`. */
export function toDisplay(valueSI: number, dimension: Dimension, system: UnitSystemId): number {
	throw new Error('not implemented');
}

/** Display unit symbol, e.g. "kN·m" for moment in kN-m. */
export function unitSymbol(dimension: Dimension, system: UnitSystemId): string {
	throw new Error('not implemented');
}

/**
 * Formats a number with a fixed number of decimals, never printing "-0.00".
 * Values whose magnitude is non-zero but below 10^-decimals are printed with
 * 3 significant digits in exponent form (e.g. "3.12e-4") so they never read as 0.
 */
export function formatNumber(value: number, decimals: number): string {
	throw new Error('not implemented');
}

/** Converts to display units and appends the symbol: "18.67 kN". */
export function formatQuantity(valueSI: number, dimension: Dimension, system: UnitSystemId, decimals: number): string {
	throw new Error('not implemented');
}
