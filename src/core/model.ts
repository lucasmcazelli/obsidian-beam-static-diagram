/**
 * Semantic validation: AST (raw strings) -> BeamModel (SI numbers).
 *
 * This is where units are resolved, position keywords become numbers, and
 * every rule that involves more than one line is checked (positions inside
 * the beam, no two supports at one point, hinges away from fixed supports,
 * ...). Directions are converted to the internal sign convention of types.ts:
 * forces and distributed loads positive UP, couples positive COUNTER-CLOCKWISE.
 */
import type {
	AstLinearLoad,
	AstUniformLoad,
	BeamAst,
	BeamModel,
	Diagnostic,
	Dimension,
	Load,
	MaterialPreset,
	SectionProps,
	Support,
	UnitSystemId,
} from './types';
import { clipText } from './lookup';
import { findMaterial, MATERIAL_IDS } from './materials';
import { positionKeyword } from './parser';
import { computeSection, SECTION_SHAPES } from './sections';
import { POSITION_TOL } from './tolerances';
import { formatCompact, formatPosition, hasUnit, parseQuantity, splitQuantity, toDisplay, unitSymbol } from './units';

/**
 * Supported beam lengths [m]. Outside this range the solver's matrices lose
 * all precision (or overflow), and the failure would surface as a misleading
 * "supports too close together" message; no real beam is shorter than a
 * micrometre or longer than 100 km.
 */
const MIN_LENGTH = 1e-6;
const MAX_LENGTH = 1e5;

/** Whole-beam message when there is no length statement. */
export const MISSING_LENGTH_MESSAGE = 'Add a length, for example: length 6 m';

/** Whole-beam message when there is no support statement. */
export const MISSING_SUPPORT_MESSAGE = 'Add at least one support, for example: pin at 0';

/** Whole-beam warning when only one of the two stiffness inputs (E side, I side) is given. */
export const INCOMPLETE_STIFFNESS_MESSAGE = 'Deflection needs both a material or E, and a section or I';

/** Example E and I statements per unit system, for "add a unit" messages. */
const E_EXAMPLE: Record<UnitSystemId, string> = {
	'kN-m': 'E 200 GPa',
	'N-mm': 'E 200000 MPa',
	'kip-ft': 'E 29000 ksi',
	'lb-in': 'E 29000000 psi',
};
const I_EXAMPLE: Record<UnitSystemId, string> = {
	'kN-m': 'I 8000 cm^4',
	'N-mm': 'I 80000000 mm^4',
	'kip-ft': 'I 510 in^4',
	'lb-in': 'I 510 in^4',
};

/** Example section statements for "add a unit" messages. */
const SECTION_EXAMPLE: Record<UnitSystemId, string> = {
	'kN-m': 'section rect 100 x 200 mm',
	'N-mm': 'section rect 100 x 200 mm',
	'kip-ft': 'section rect 4 x 8 in',
	'lb-in': 'section rect 4 x 8 in',
};

/** "steel, stainless, aluminium, timber or concrete" */
const MATERIAL_LIST = `${MATERIAL_IDS.slice(0, -1).join(', ')} or ${MATERIAL_IDS[MATERIAL_IDS.length - 1] ?? ''}`;

/**
 * Lets a bare number borrow the unit of its partner, as in plain English:
 * "from 2 to 6 ft" means 2 ft, and "linear 2 to 6 kN/m" means 2 kN/m.
 * Keywords ("end") and numbers that already have a unit are left alone.
 */
function shareUnit(raw: string, partner: string | undefined): string {
	if (partner === undefined || hasUnit(raw)) return raw;
	const own = splitQuantity(raw);
	const other = splitQuantity(partner);
	if (!own.ok || !other.ok || other.unit === '') return raw;
	return `${own.number} ${other.unit}`;
}

/**
 * Applies a direction: returns -value when `negative`, else value. Adding 0
 * turns -0 into 0 so a zero end of a triangular load compares equal to 0.
 */
function signed(value: number, negative: boolean): number {
	return (negative ? -value : value) + 0;
}

/**
 * Sorts by line, keeping insertion order for equal lines; diagnostics without
 * a line go last. Shared with analyzeBeam (which imports it from here, since
 * analyze.ts already depends on this module).
 */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
	return diagnostics
		.map((d, index) => ({ d, index }))
		.sort((a, b) => {
			const la = a.d.line ?? Number.POSITIVE_INFINITY;
			const lb = b.d.line ?? Number.POSITIVE_INFINITY;
			return la === lb ? a.index - b.index : la - lb;
		})
		.map((entry) => entry.d);
}

/**
 * Resolves units and positions, checks every cross-line rule and returns the
 * model when there are no errors. Warnings may accompany a valid model.
 *
 * Conversions to the internal sign convention:
 *   point  F down -> fy = -F,  up -> fy = +F
 *   moment M ccw  -> mz = +M,  cw -> mz = -M
 *   udl / linear w down -> q = -w, up -> q = +w
 * A negative magnitude therefore flips the direction ("point -10 kN down" is 10 kN up).
 */
export function buildModel(
	ast: BeamAst,
	defaultUnits: UnitSystemId,
): { model?: BeamModel; units: UnitSystemId; diagnostics: Diagnostic[] } {
	const units = ast.units ?? defaultUnits;
	const diagnostics: Diagnostic[] = [];
	const report = (severity: Diagnostic['severity'], message: string, line?: number): void => {
		diagnostics.push(line === undefined ? { severity, message } : { severity, message, line });
	};
	const error = (message: string, line?: number): void => report('error', message, line);
	const warn = (message: string, line?: number): void => report('warning', message, line);

	/** Parses a raw quantity, reporting failures; undefined on error. */
	const quantity = (raw: string, dimension: Dimension, line?: number, requireUnit = false): number | undefined => {
		const result = parseQuantity(raw, dimension, units, { requireUnit });
		if (!result.ok) {
			error(result.message, line);
			return undefined;
		}
		return result.value;
	};

	// --- Length -------------------------------------------------------------
	let L: number | undefined;
	if (ast.length === undefined) {
		error(MISSING_LENGTH_MESSAGE);
	} else {
		const value = quantity(ast.length, 'length', ast.lines.length);
		if (value !== undefined && value <= 0) error('The length must be greater than zero, for example: length 6 m', ast.lines.length);
		else if (value !== undefined && (value < MIN_LENGTH || value > MAX_LENGTH)) {
			error('The length is outside the supported range (1 µm to 100 km): check its unit', ast.lines.length);
		} else L = value;
	}

	/** "6 m" in the block's length unit. */
	const fmtLength = (x: number): string => formatPosition(x, units);
	/** Same position within round-off (exact comparison when the length is unknown). */
	const samePosition = (a: number, b: number): boolean => Math.abs(a - b) <= (L === undefined ? 0 : POSITION_TOL * L);

	/**
	 * Resolves a position to metres and checks it lies on the beam. Returns
	 * undefined after reporting an error, or when the length is unknown and the
	 * position is a keyword (the missing length is already reported).
	 */
	const position = (raw: string, line?: number, partner?: string): number | undefined => {
		const keyword = positionKeyword(raw);
		if (keyword) {
			if (L === undefined) return undefined;
			return keyword === 'start' ? 0 : keyword === 'mid' ? L / 2 : L;
		}
		const typed = shareUnit(raw, partner);
		let x = quantity(typed, 'length', line);
		if (x === undefined || L === undefined) return x;
		// Snap round-off at the ends so "36 in" on a 3 ft beam is exactly at the end.
		if (Math.abs(x) < POSITION_TOL * L) x = 0;
		else if (Math.abs(x - L) < POSITION_TOL * L) x = L;
		if (x < 0 || x > L) {
			// Quote the position as typed: rounding it for display could make
			// it equal the limit ("6.0001" would read "Position 6 m ... 0 to 6 m").
			error(`Position ${clipText(typed.trim())} is outside the beam (0 to ${fmtLength(L)})`, line);
			return undefined;
		}
		return x;
	};

	// --- Supports -----------------------------------------------------------
	if (ast.supports.length === 0) error(MISSING_SUPPORT_MESSAGE);
	const supports: Support[] = [];
	for (const s of ast.supports) {
		const x = position(s.at, s.line);
		if (x === undefined) continue;
		if (supports.some((other) => samePosition(other.x, x))) {
			error(`Two supports at x = ${fmtLength(x)}: remove one or move it`, s.line);
			continue;
		}
		supports.push({ kind: s.kind, x, line: s.line });
	}
	supports.sort((a, b) => a.x - b.x);

	// --- Hinges -------------------------------------------------------------
	const hinges: number[] = [];
	for (const h of ast.hinges) {
		const x = position(h.at, h.line);
		if (x === undefined) continue;
		// A hinge at an end releases nothing (the end moment is already free or
		// fixed by its support), so it is almost certainly a mistake.
		if (L !== undefined && (x <= 0 || x >= L)) {
			// "hinge at 0" usually means a hinged (pinned) support.
			error(`A hinge must be strictly inside the beam: for a pinned support write pin at ${clipText(h.at.trim())}`, h.line);
			continue;
		}
		if (hinges.some((other) => samePosition(other, x))) {
			error(`Two hinges at x = ${fmtLength(x)}: remove one`, h.line);
			continue;
		}
		// The clamp would act on both sides of the release at once: whether it
		// restrains the left part, the right part or both is undefined.
		if (supports.some((s) => s.kind === 'fixed' && samePosition(s.x, x))) {
			error('A hinge cannot sit on a fixed support: the result would be ambiguous', h.line);
			continue;
		}
		hinges.push(x);
	}
	hinges.sort((a, b) => a - b);

	// --- Loads --------------------------------------------------------------
	/** Start and end of a distributed load, the whole beam when both are omitted. */
	const extent = (load: AstUniformLoad | AstLinearLoad): [number, number] | undefined => {
		if (load.from === undefined && load.to === undefined) return L === undefined ? undefined : [0, L];
		if (load.from === undefined || load.to === undefined) {
			error('Give both "from" and "to", or neither to load the whole beam', load.line);
			return undefined;
		}
		const x1 = position(load.from, load.line, load.to);
		const x2 = position(load.to, load.line, load.from);
		if (x1 === undefined || x2 === undefined) return undefined;
		if (x1 >= x2) {
			// Quoted as typed (with a shared unit), for the same reason as in position().
			const from = clipText(shareUnit(load.from, load.to).trim());
			const to = clipText(shareUnit(load.to, load.from).trim());
			error(`The load must start before it ends: "from" (${from}) must be less than "to" (${to})`, load.line);
			return undefined;
		}
		// The solver merges each end into the nearest key point within
		// POSITION_TOL·L, so a load shorter than twice that can collapse to
		// zero length and vanish without a trace.
		if (L !== undefined && x2 - x1 <= 2 * POSITION_TOL * L) {
			error('This distributed load is too short to analyse: make it longer or use a point load', load.line);
			return undefined;
		}
		return [x1, x2];
	};

	const loads: Load[] = [];
	for (const load of ast.loads) {
		const line = load.line;
		switch (load.kind) {
			case 'point': {
				const F = quantity(load.magnitude, 'force', line);
				const x = position(load.at, line);
				if (F === undefined || x === undefined) break;
				if (F === 0) {
					warn('This point load is zero and is ignored', line);
					break;
				}
				loads.push({ kind: 'point', x, fy: signed(F, load.direction === 'down'), line });
				break;
			}
			case 'moment': {
				const M = quantity(load.magnitude, 'moment', line);
				const x = position(load.at, line);
				if (M === undefined || x === undefined) break;
				// At a hinge the couple could be applied to the left or the right
				// part, which give different results, so ask the user to choose.
				if (hinges.some((h) => samePosition(h, x))) {
					error('A moment cannot act exactly at a hinge: move it slightly to one side', line);
					break;
				}
				if (M === 0) {
					warn('This moment is zero and is ignored', line);
					break;
				}
				loads.push({ kind: 'moment', x, mz: signed(M, load.direction === 'cw'), line });
				break;
			}
			case 'udl': {
				const w = quantity(load.magnitude, 'distributed', line);
				const span = extent(load);
				if (w === undefined || span === undefined) break;
				if (w === 0) {
					warn('This distributed load is zero and is ignored', line);
					break;
				}
				const q = signed(w, load.direction === 'down');
				loads.push({ kind: 'distributed', x1: span[0], x2: span[1], q1: q, q2: q, line });
				break;
			}
			case 'linear': {
				const w1 = quantity(shareUnit(load.start, load.end), 'distributed', line);
				const w2 = quantity(shareUnit(load.end, load.start), 'distributed', line);
				const span = extent(load);
				if (w1 === undefined || w2 === undefined || span === undefined) break;
				if (w1 === 0 && w2 === 0) {
					warn('This distributed load is zero and is ignored', line);
					break;
				}
				const down = load.direction === 'down';
				loads.push({ kind: 'distributed', x1: span[0], x2: span[1], q1: signed(w1, down), q2: signed(w2, down), line });
				break;
			}
		}
	}

	// --- Stiffness: material / E and section / I ------------------------------
	let material: MaterialPreset | undefined;
	if (ast.material !== undefined) {
		material = findMaterial(ast.material);
		if (!material) {
			error(`Unknown material "${clipText(ast.material)}": use ${MATERIAL_LIST}, or give E directly, for example: ${E_EXAMPLE[units]}`, ast.lines.material);
		}
	}

	/** E and I must carry a unit: a bare "200" could mean GPa, MPa or ksi. */
	const stiffness = (raw: string, name: 'E' | 'I', dimension: Dimension, line?: number): number | undefined => {
		const parts = splitQuantity(raw);
		if (parts.ok && parts.unit === '') {
			error(`Add a unit to ${name}, for example: ${(name === 'E' ? E_EXAMPLE : I_EXAMPLE)[units]}`, line);
			return undefined;
		}
		const value = quantity(raw, dimension, line, true);
		if (value !== undefined && value <= 0) {
			error(`${name} must be greater than zero`, line);
			return undefined;
		}
		return value;
	};
	const E = ast.E !== undefined ? stiffness(ast.E, 'E', 'modulus', ast.lines.E) : undefined;
	const I = ast.I !== undefined ? stiffness(ast.I, 'I', 'inertia', ast.lines.I) : undefined;

	let section: SectionProps | undefined;
	// In kN-m and kip-ft, bare section numbers are mm or in while bare lengths
	// are m or ft, so "section rect 0.1 x 0.2" (meant as metres) would be read
	// 1000 times too small and give an I that is 1e12 too small. Like E and I,
	// the section must then say its unit. N-mm and lb-in use one length unit
	// for both and keep bare numbers.
	const bareSectionAmbiguous = unitSymbol('sectionLength', units) !== unitSymbol('length', units);
	if (ast.section && bareSectionAmbiguous && ast.section.unit === undefined && ast.section.dims.some((d) => !hasUnit(d))) {
		error(`Add a unit to the section dimensions, for example: ${SECTION_EXAMPLE[units]}`, ast.section.line);
	} else if (ast.section) {
		const s = ast.section;
		const dims: number[] = [];
		for (const raw of s.dims) {
			// A shared unit ("100 x 200 mm") applies to every bare dimension.
			const text = s.unit !== undefined && !hasUnit(raw) ? `${raw.trim()} ${s.unit}` : raw;
			const value = quantity(text, 'sectionLength', s.line);
			if (value === undefined) break;
			dims.push(value);
		}
		if (dims.length === s.dims.length) {
			const result = computeSection(s.shape, dims);
			if ('error' in result) {
				error(result.error, s.line);
			} else {
				// "Rectangle 100 × 200 mm", in the section unit of the block's system.
				// Four decimals so thin walls keep their digits ("tube 1.5 × 0.0625 in", not "0.063").
				const shown = dims.map((d) => formatCompact(toDisplay(d, 'sectionLength', units), 4)).join(' × ');
				section = { ...result, label: `${SECTION_SHAPES[s.shape].label} ${shown} ${unitSymbol('sectionLength', units)}` };
			}
		}
	}

	if (ast.E !== undefined && ast.material !== undefined) warn('E overrides the material preset', ast.lines.E);
	if (ast.I !== undefined && ast.section !== undefined) {
		warn('I overrides the I computed from the section; stress uses the section depth', ast.lines.I);
	}
	const hasModulus = ast.E !== undefined || ast.material !== undefined;
	const hasInertia = ast.I !== undefined || ast.section !== undefined;
	if (hasModulus !== hasInertia) warn(INCOMPLETE_STIFFNESS_MESSAGE);

	const sorted = sortDiagnostics(diagnostics);
	if (L === undefined || sorted.some((d) => d.severity === 'error')) return { units, diagnostics: sorted };

	const model: BeamModel = { units, length: L, supports, hinges, loads };
	if (ast.title !== undefined) model.title = ast.title;
	const modelE = E ?? material?.E;
	if (modelE !== undefined) model.E = modelE;
	const modelI = I ?? section?.I;
	if (modelI !== undefined) model.I = modelI;
	if (material) model.material = material;
	// An explicit I wins for deflection; the section still provides c for stress.
	if (section) model.section = I !== undefined ? { ...section, I } : section;
	return { model, units, diagnostics: sorted };
}
