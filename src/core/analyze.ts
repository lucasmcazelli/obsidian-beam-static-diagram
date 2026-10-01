/**
 * The full pipeline used by the UI: text -> AST -> model -> results, plus
 * engineering warnings.
 *
 *   size limits      (oversized blocks are refused before any work)
 *   parseBeamSource  (syntax, one error per line at most)
 *   buildModel       (units, positions, cross-line rules)
 *   solveBeam        (rejects mechanisms, then reactions and exact V, M,
 *                     slope, deflection)
 *   warnings         (uplift, no horizontal restraint, large deflection, ...)
 *
 * `analyzeBeam` never throws. Every problem, including an unexpected bug in a
 * later stage, becomes a Diagnostic, so a broken block shows a message in the
 * note instead of breaking the whole preview.
 */
import { governingDeflectionRatio } from './diagrams';
import { buildModel, INCOMPLETE_STIFFNESS_MESSAGE, MISSING_LENGTH_MESSAGE, MISSING_SUPPORT_MESSAGE, sortDiagnostics } from './model';
import { emptyAst, guessStatementType, parseBeamSource, splitLines, type StatementType } from './parser';
import { forceScale } from './scale';
import { solveBeam } from './solver';
import { RESIDUAL_TOL } from './tolerances';
import { BeamAnalysisError } from './types';
import type { AnalysisOutput, BeamAst, BeamModel, BeamResults, Diagnostic, UnitSystemId } from './types';
import { DEFAULT_DECIMALS, formatPosition, formatQuantity, formatSpanRatio, isUnitSystemId, TABLE_PLAIN_LIMIT } from './units';

// Re-exported for existing callers (tests import them from here; the
// renderers import forceScale from ./scale directly).
export { forceScale } from './scale';
export { sortDiagnostics } from './model';

// ---------------------------------------------------------------------------
// Messages and tolerances
// ---------------------------------------------------------------------------

/** Shown when the beam has only rollers. */
export const NO_HORIZONTAL_RESTRAINT_MESSAGE =
	'No pin or fixed support: the beam is not restrained horizontally. Results assume vertical loads only';

/** Shown when global equilibrium of the solved beam is off by more than RESIDUAL_TOL. */
export const EQUILIBRIUM_MESSAGE = 'Equilibrium check failed: results may be inaccurate';

/**
 * Shown when E and I are given but the solver withheld the deflection
 * because it falls outside double-precision range (an absurd E or I, or E·I
 * overflowing). Without it the deflection would vanish with no reason given.
 */
export const DEFLECTION_UNAVAILABLE_MESSAGE = 'The deflection could not be computed: check E and I';

/** Shown when a later stage fails with an unexpected error (a bug, not a user mistake). */
const INTERNAL_ERROR_MESSAGE =
	'The beam could not be analysed because of an internal error. Check the values, and please report this block if the problem persists';

/** Shown in the unlikely case that the parser itself crashes. */
const UNREADABLE_MESSAGE = 'This block could not be read: check it for unusual characters';

/**
 * A pin or roller reaction pulling down by more than this fraction of the
 * force scale is real uplift; anything smaller is solver round-off (the
 * solver already zeroes reactions below 1e-12 of the load).
 */
const UPLIFT_TOL = 1e-9;

/**
 * Deflections larger than L/50 make the small-deflection assumption of
 * Euler-Bernoulli theory (tan theta ≈ theta, no geometric stiffening)
 * questionable. Serviceability limits are usually far stricter (L/250 to
 * L/360), so a beam past L/50 is almost always an input mistake. L is the
 * governing span or cantilever (governingDeflectionRatio), the same ratio
 * the results table shows. DEFAULT_DECIMALS (units.ts) is used for numbers
 * inside messages when the caller does not say.
 */
const LARGE_DEFLECTION_RATIO = 50;

/**
 * Size limits. Analysis and especially the diagrams grow faster than linearly
 * with the number of supports, hinges and loads (dense stiffness matrices,
 * label placement against every curve sample), and the scenes are rebuilt on
 * every resize and every preview pause. A crafted or pasted block of a few
 * hundred supports could freeze Obsidian for tens of seconds each time the
 * note is opened. Textbook beams stay far below these limits.
 */
export const MAX_SOURCE_CHARS = 20000;
/** Most supports plus hinges per beam (see MAX_SOURCE_CHARS). */
export const MAX_NODES = 50;
/** Most loads per beam (see MAX_SOURCE_CHARS). */
export const MAX_LOADS = 100;

/** Example point load per unit system, for the "no loads yet" hint. */
const LOAD_EXAMPLE: Record<UnitSystemId, string> = {
	'kN-m': 'point 10 kN at 2 m',
	'N-mm': 'point 10000 N at 2000 mm',
	'kip-ft': 'point 5 kip at 10 ft',
	'lb-in': 'point 500 lb at 24 in',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options of analyzeBeam. */
export interface AnalyzeOptions {
	/** Unit system used when the block has no `units` statement. */
	defaultUnits: UnitSystemId;
	/** Decimals for numbers inside warning messages (default 2). */
	decimals?: number;
}

/**
 * Runs the whole pipeline on the text of one beam block.
 *
 * The model builder runs even when the parser reported errors (statements
 * that failed to parse are simply missing from the AST), so the user sees
 * every problem at once instead of fixing them one by one. Model messages
 * that are only a consequence of a broken line (for example "Add a length"
 * when the length line has a typo) are dropped.
 *
 * Never throws: every problem is reported in `diagnostics`.
 */
export function analyzeBeam(source: string, options: AnalyzeOptions): AnalysisOutput {
	// Defensive: the UI is typed, but a bad settings file could hand us anything.
	const text = typeof source === 'string' ? source : '';
	const defaultUnits: UnitSystemId = isUnitSystemId(options?.defaultUnits) ? options.defaultUnits : 'kN-m';
	const requested = options?.decimals;
	const decimals = typeof requested === 'number' && Number.isFinite(requested) ? requested : DEFAULT_DECIMALS;

	// --- 0. Size limit, before any work (see MAX_SOURCE_CHARS) -----------------
	if (text.length > MAX_SOURCE_CHARS) {
		const message = `This block is too long to analyse (more than ${MAX_SOURCE_CHARS} characters): split it into several beams`;
		return { ast: emptyAst(), units: defaultUnits, diagnostics: [{ severity: 'error', message }] };
	}

	// --- 1. Syntax -----------------------------------------------------------
	let ast: BeamAst;
	let parseDiagnostics: Diagnostic[];
	try {
		const parsed = parseBeamSource(text);
		ast = parsed.ast;
		parseDiagnostics = parsed.diagnostics;
	} catch {
		ast = emptyAst();
		parseDiagnostics = [{ severity: 'error', message: UNREADABLE_MESSAGE }];
	}

	// Statement counts are checked before the model is built and solved: the
	// solver's memory grows with the square of the number of supports and hinges.
	const tooMany = countLimitErrors(ast);
	if (tooMany.length > 0) {
		const units: UnitSystemId = isUnitSystemId(ast.units) ? ast.units : defaultUnits;
		return { ast, units, diagnostics: sortDiagnostics(mergeDiagnostics(parseDiagnostics, tooMany)) };
	}

	// --- 2. Model ------------------------------------------------------------
	let units: UnitSystemId = isUnitSystemId(ast.units) ? ast.units : defaultUnits;
	let model: BeamModel | undefined;
	let modelDiagnostics: Diagnostic[];
	try {
		const built = buildModel(ast, defaultUnits);
		units = built.units;
		model = built.model;
		modelDiagnostics = dropConsequences(built.diagnostics, parseDiagnostics, text);
	} catch {
		modelDiagnostics = [{ severity: 'error', message: INTERNAL_ERROR_MESSAGE }];
	}

	const diagnostics = mergeDiagnostics(parseDiagnostics, modelDiagnostics);
	const finish = (extra: { model?: BeamModel; results?: BeamResults }, more: Diagnostic[] = []): AnalysisOutput => ({
		ast,
		units,
		...extra,
		diagnostics: sortDiagnostics(mergeDiagnostics(diagnostics, more)),
	});

	// The contract: `model` only when nothing up to the model stage failed.
	if (!model || diagnostics.some((d) => d.severity === 'error')) {
		const missing: Diagnostic[] = !model && !diagnostics.some((d) => d.severity === 'error')
			? [{ severity: 'error', message: INTERNAL_ERROR_MESSAGE }]
			: [];
		return finish({}, missing);
	}

	// --- 3. Solve ------------------------------------------------------------
	// solveBeam checks stability itself (on the positions it actually uses)
	// and throws a BeamAnalysisError with the user-facing "unstable" message.
	let results: BeamResults;
	try {
		results = solveBeam(model);
	} catch (err) {
		// BeamAnalysisError messages are written for users (mechanism, supports
		// too close together, ...); anything else is a bug.
		const message = err instanceof BeamAnalysisError ? err.message : INTERNAL_ERROR_MESSAGE;
		return finish({ model }, [{ severity: 'error', message }]);
	}

	// --- 4. Engineering warnings ---------------------------------------------
	let warnings: Diagnostic[];
	try {
		warnings = engineeringWarnings(results, units, decimals);
	} catch {
		// Warnings are advisory: losing them must never hide valid results.
		warnings = [];
	}
	// A beam without any load solves to all zeros, which looks like a bug.
	// Loads that were given but are zero already have their own warning.
	if (ast.loads.length === 0) {
		warnings.push({ severity: 'warning', message: `No loads yet: add one, for example ${LOAD_EXAMPLE[units]}` });
	}
	return finish({ model, results }, warnings);
}

/** Errors for a block over the statement limits (MAX_NODES, MAX_LOADS), or none. */
function countLimitErrors(ast: BeamAst): Diagnostic[] {
	const out: Diagnostic[] = [];
	const nodes = ast.supports.length + ast.hinges.length;
	if (nodes > MAX_NODES) {
		out.push({ severity: 'error', message: `Too many supports and hinges (${nodes}): the limit is ${MAX_NODES} per beam` });
	}
	if (ast.loads.length > MAX_LOADS) {
		out.push({ severity: 'error', message: `Too many loads (${ast.loads.length}): the limit is ${MAX_LOADS} per beam` });
	}
	return out;
}

/**
 * Warnings that need the solved beam:
 * - no pin or fixed support (nothing resists horizontal loads);
 * - a pin or roller that must pull the beam down (needs an anchor against uplift);
 * - equilibrium residual above 1e-6 of the force scale;
 * - E and I given but the deflection withheld (out of double-precision range);
 * - worst span or cantilever deflection above L/50 (small-deflection theory
 *   breaks down).
 * Exported for tests; `analyzeBeam` calls it after a successful solve.
 */
export function engineeringWarnings(results: BeamResults, units: UnitSystemId, decimals: number = DEFAULT_DECIMALS): Diagnostic[] {
	const { model } = results;
	const out: Diagnostic[] = [];
	const warn = (message: string, line?: number): void => {
		out.push(line === undefined ? { severity: 'warning', message } : { severity: 'warning', message, line });
	};

	// Rollers only: the 1D beam model ignores axial forces, so the results are
	// still right for vertical loads, but the real structure could slide away.
	if (model.supports.length > 0 && model.supports.every((s) => s.kind === 'roller')) {
		warn(NO_HORIZONTAL_RESTRAINT_MESSAGE);
	}

	const scale = forceScale(model, results.reactions);

	// Uplift: fy is positive UP, so a negative pin or roller reaction pulls the
	// beam down. A fixed support is a clamp and resists either way by design.
	for (const r of results.reactions) {
		if (r.kind === 'fixed' || !(r.fy < -UPLIFT_TOL * scale)) continue;
		const where = formatPosition(r.x, units);
		// A message has room for every digit: no exponent form below 1e15.
		const amount = formatQuantity(-r.fy, 'force', units, decimals, TABLE_PLAIN_LIMIT);
		warn(`Support at x = ${where} pulls the beam down (${amount}): it must be anchored against uplift`, model.supports[r.supportIndex]?.line);
	}

	// The solver refuses residuals of this size itself, so this is a last
	// line of defence that stays useful if the solver changes.
	const { force, moment } = results.residual;
	const residualTooLarge =
		!Number.isFinite(force) ||
		!Number.isFinite(moment) ||
		Math.abs(force) > RESIDUAL_TOL * scale ||
		Math.abs(moment) > RESIDUAL_TOL * scale * model.length;
	if (residualTooLarge) warn(EQUILIBRIUM_MESSAGE);

	if (!results.hasDeflection && model.E !== undefined && model.I !== undefined) {
		warn(DEFLECTION_UNAVAILABLE_MESSAGE);
	}

	// Per span and cantilever, like the results table (see governingDeflectionRatio).
	const governing = governingDeflectionRatio(results);
	if (governing && governing.ratio < LARGE_DEFLECTION_RATIO) {
		// Past L/50 the usual cause is a unit mistake in E, I or the section,
		// so point there first.
		const ratio = formatSpanRatio(governing.x1 - governing.x0, governing.peak);
		warn(`Maximum deflection is ${ratio}: check E, I and the section units (small-deflection theory is also unreliable this large)`);
	}
	return out;
}

/**
 * Merges diagnostic lists, dropping repeats of the same message on the same
 * line (the parser and the model builder occasionally describe one problem
 * twice). When the repeats differ in severity the error wins.
 */
export function mergeDiagnostics(...lists: Diagnostic[][]): Diagnostic[] {
	const out: Diagnostic[] = [];
	const seen = new Map<string, number>();
	for (const list of lists) {
		for (const d of list) {
			const key = `${d.line ?? ''}\u0000${d.message}`;
			const index = seen.get(key);
			if (index === undefined) {
				seen.set(key, out.length);
				out.push({ ...d });
			} else if (d.severity === 'error') {
				const existing = out[index];
				if (existing) existing.severity = 'error';
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Statement groups whose absence buildModel reports as a whole-beam message. */
type StatementCategory = 'length' | 'support' | 'stiffness';

/**
 * The group of every parser statement type, or null for statements whose
 * absence is not reported. Keyed by the parser's own StatementType, so the
 * compiler flags this table when a statement is added. Keywords and aliases
 * are resolved by the parser (guessStatementType), which stays the authority
 * on syntax: "point" is an exact keyword there, never a misspelt "pin".
 */
const STATEMENT_CATEGORIES: Record<StatementType, StatementCategory | null> = {
	title: null,
	units: null,
	length: 'length',
	support: 'support',
	pin: 'support',
	roller: 'support',
	fixed: 'support',
	hinge: null,
	point: null,
	moment: null,
	udl: null,
	linear: null,
	material: 'stiffness',
	E: 'stiffness',
	I: 'stiffness',
	section: 'stiffness',
};

/**
 * Whole-beam model messages that a broken line can cause, keyed by the
 * category of statement that line was meant to be. The texts are buildModel's
 * own exported constants, so they cannot drift apart.
 */
const CONSEQUENCES: Record<StatementCategory, string> = {
	length: MISSING_LENGTH_MESSAGE,
	support: MISSING_SUPPORT_MESSAGE,
	stiffness: INCOMPLETE_STIFFNESS_MESSAGE,
};

/**
 * Removes whole-beam model diagnostics that only exist because a line
 * failed to parse: when "lenght 6 m" has a typo, the parser already reports
 * it, and "Add a length" on top of it would send the user looking for a
 * missing line that is in fact there.
 */
function dropConsequences(modelDiagnostics: Diagnostic[], parseDiagnostics: Diagnostic[], source: string): Diagnostic[] {
	if (parseDiagnostics.length === 0) return modelDiagnostics;
	const lines = splitLines(source);
	const broken = new Set<StatementCategory>();
	for (const d of parseDiagnostics) {
		if (d.severity !== 'error' || d.line === undefined) continue;
		const category = categoryOf(lines[d.line - 1] ?? '');
		if (category) broken.add(category);
	}
	if (broken.size === 0) return modelDiagnostics;
	return modelDiagnostics.filter((d) => {
		if (d.line !== undefined) return true;
		for (const category of broken) {
			if (d.message === CONSEQUENCES[category]) return false;
		}
		return true;
	});
}

/** Category of the statement a line starts with, allowing for a typo in the keyword. */
function categoryOf(line: string): StatementCategory | undefined {
	// First word, without an optional ":" or "=" glued to it ("length: 6 m").
	const word = line.trim().split(/[\s:=]+/)[0] ?? '';
	if (word === '') return undefined;
	const type = guessStatementType(word);
	return type === undefined ? undefined : (STATEMENT_CATEGORIES[type] ?? undefined);
}
