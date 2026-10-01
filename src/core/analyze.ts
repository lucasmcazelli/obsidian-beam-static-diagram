/**
 * The full pipeline used by the UI: text -> AST -> model -> results, plus
 * engineering warnings.
 *
 *   parseBeamSource  (syntax, one error per line at most)
 *   buildModel       (units, positions, cross-line rules)
 *   classifyBeam     (mechanisms are rejected before solving)
 *   solveBeam        (reactions and exact V, M, slope, deflection)
 *   warnings         (uplift, no horizontal restraint, large deflection, ...)
 *
 * `analyzeBeam` never throws. Every problem, including an unexpected bug in a
 * later stage, becomes a Diagnostic, so a broken block shows a message in the
 * note instead of breaking the whole preview.
 */
import { buildModel, INCOMPLETE_STIFFNESS_MESSAGE, MISSING_LENGTH_MESSAGE, MISSING_SUPPORT_MESSAGE } from './model';
import { emptyAst, guessStatementType, parseBeamSource, type StatementType } from './parser';
import { solveBeam } from './solver';
import { classifyBeam } from './stability';
import { BeamAnalysisError } from './types';
import type { AnalysisOutput, BeamAst, BeamModel, BeamResults, Diagnostic, Reaction, UnitSystemId } from './types';
import { formatCompact, formatQuantity, toDisplay, UNIT_SYSTEMS, unitSymbol } from './units';

// ---------------------------------------------------------------------------
// Messages and tolerances
// ---------------------------------------------------------------------------

/** Shown when the support layout lets the beam move as a rigid mechanism (same text as the solver). */
export const UNSTABLE_MESSAGE = 'The beam is unstable: it can move as a mechanism. Add a support or remove a hinge.';

/** Shown when the beam has only rollers. */
export const NO_HORIZONTAL_RESTRAINT_MESSAGE =
	'No pin or fixed support: the beam is not restrained horizontally. Results assume vertical loads only.';

/** Shown when global equilibrium of the solved beam is off by more than RESIDUAL_TOL. */
export const EQUILIBRIUM_MESSAGE = 'Equilibrium check failed: results may be inaccurate';

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
 * Largest acceptable equilibrium residual as a fraction of the force scale
 * (moment residual: of force scale × L). Healthy beams stay near 1e-15.
 */
const RESIDUAL_TOL = 1e-6;

/**
 * Deflections larger than L/50 make the small-deflection assumption of
 * Euler-Bernoulli theory (tan theta ≈ theta, no geometric stiffening)
 * questionable. Serviceability limits are usually far stricter (L/250 to
 * L/360), so a beam past L/50 is almost always an input mistake.
 */
const LARGE_DEFLECTION_RATIO = 50;

/** Decimals used for numbers inside messages when the caller does not say. */
const DEFAULT_DECIMALS = 2;

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
	const defaultUnits: UnitSystemId = isUnitSystem(options?.defaultUnits) ? options.defaultUnits : 'kN-m';
	const decimals = Number.isFinite(options?.decimals) ? (options.decimals as number) : DEFAULT_DECIMALS;

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

	// --- 2. Model ------------------------------------------------------------
	let units: UnitSystemId = isUnitSystem(ast.units) ? ast.units : defaultUnits;
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

	// --- 3. Stability --------------------------------------------------------
	try {
		if (!classifyBeam(model).stable) return finish({ model }, [{ severity: 'error', message: UNSTABLE_MESSAGE }]);
	} catch {
		return finish({ model }, [{ severity: 'error', message: INTERNAL_ERROR_MESSAGE }]);
	}

	// --- 4. Solve ------------------------------------------------------------
	let results: BeamResults;
	try {
		results = solveBeam(model);
	} catch (err) {
		// BeamAnalysisError messages are written for users (mechanism, supports
		// too close together, ...); anything else is a bug.
		const message = err instanceof BeamAnalysisError ? err.message : INTERNAL_ERROR_MESSAGE;
		return finish({ model }, [{ severity: 'error', message }]);
	}

	// --- 5. Engineering warnings ---------------------------------------------
	let warnings: Diagnostic[];
	try {
		warnings = engineeringWarnings(results, units, decimals);
	} catch {
		// Warnings are advisory: losing them must never hide valid results.
		warnings = [];
	}
	return finish({ model, results }, warnings);
}

/**
 * Warnings that need the solved beam:
 * - no pin or fixed support (nothing resists horizontal loads);
 * - a pin or roller that must pull the beam down (needs an anchor against uplift);
 * - equilibrium residual above 1e-6 of the force scale;
 * - maximum deflection above L/50 (small-deflection theory breaks down).
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
		const amount = formatQuantity(-r.fy, 'force', units, decimals);
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

	if (results.hasDeflection) {
		const { deflectionMax, deflectionMin } = results.extrema;
		const peak = Math.max(Math.abs(deflectionMax?.value ?? 0), Math.abs(deflectionMin?.value ?? 0));
		if (peak > model.length / LARGE_DEFLECTION_RATIO) {
			warn(`Maximum deflection is ${spanRatio(model.length, peak)}: small-deflection theory may be inaccurate`);
		}
	}
	return out;
}

/**
 * Force scale [N] of a beam, used for relative tolerances everywhere a
 * result has to be compared with "zero": sum of |point loads|, |couples| / L,
 * the absolute area under every distributed load and, when given, |reactions|
 * (fy plus mz / L). Zero for a beam without loads.
 */
export function forceScale(model: BeamModel, reactions: readonly Reaction[] = []): number {
	const L = model.length;
	let total = 0;
	for (const load of model.loads) {
		if (load.kind === 'point') total += Math.abs(load.fy);
		else if (load.kind === 'moment') total += L > 0 ? Math.abs(load.mz) / L : 0;
		else total += absoluteArea(load.q1, load.q2, Math.abs(load.x2 - load.x1));
	}
	for (const r of reactions) total += Math.abs(r.fy) + (L > 0 ? Math.abs(r.mz) / L : 0);
	return Number.isFinite(total) ? total : 0;
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

/** Sorts by line number (stable for equal lines); diagnostics without a line go last. */
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True for one of the four unit system ids. */
function isUnitSystem(value: unknown): value is UnitSystemId {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(UNIT_SYSTEMS, value);
}

/** "6 m": a position in the block's length unit, without trailing zeros. */
function formatPosition(x: number, units: UnitSystemId): string {
	return `${formatCompact(toDisplay(x, 'length', units))} ${unitSymbol('length', units)}`;
}

/**
 * Area under |q| for a load varying linearly from q1 to q2 over `length`.
 * Same signs: trapezoid (|q1| + |q2|)/2·length. Opposite signs: the line
 * crosses zero at t = |q1| / (|q1| + |q2|) of the length, giving two
 * triangles whose areas add up to (q1² + q2²) / (2(|q1| + |q2|))·length.
 */
function absoluteArea(q1: number, q2: number, length: number): number {
	const a = Math.abs(q1);
	const b = Math.abs(q2);
	if (q1 * q2 >= 0) return 0.5 * (a + b) * length;
	return ((a * a + b * b) / (2 * (a + b))) * length;
}

/**
 * Deflection as a fraction of the span, the way engineers quote it: "L/35".
 * Rounded DOWN so the shown ratio is never more flattering than the truth
 * (L/35.6 reads L/35). A deflection larger than the span reads "1.3 × L".
 */
function spanRatio(length: number, deflection: number): string {
	const n = length / deflection;
	return n >= 1 ? `L/${Math.floor(n)}` : `${formatCompact(deflection / length, 1)} × L`;
}

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
	const lines = source.split(/\r\n|\r|\n/);
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
