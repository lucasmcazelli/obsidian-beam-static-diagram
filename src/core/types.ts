/**
 * Shared types for Beam Statics.
 *
 * This file is the contract between the four layers of the plugin:
 *
 *   text  --parser-->  BeamAst  --model-->  BeamModel  --solver-->  BeamResults  --render-->  SVG
 *
 * - `BeamAst` mirrors what the user typed (raw strings, line numbers). The
 *   interactive editor edits this structure and serializes it back to text.
 * - `BeamModel` is the validated, unit-converted beam in SI base units.
 * - `BeamResults` holds reactions plus exact piecewise-polynomial V, M,
 *   slope and deflection functions.
 *
 * Nothing under `src/core` or `src/render` may import 'obsidian' or touch the
 * DOM, so all of it can be unit tested in plain Node.
 *
 * INTERNAL SIGN CONVENTION (used everywhere below this line):
 *   x      measured from the left end of the beam, positive to the right [m]
 *   forces positive UP (so gravity loads are negative) [N]
 *   q(x)   distributed load, positive UP [N/m]
 *   couples (applied and reaction) positive COUNTER-CLOCKWISE [N·m]
 *   V(x)   sum of the upward forces acting LEFT of the section (textbook positive shear)
 *   M(x)   positive when SAGGING (beam curves like a smile, bottom fibre in tension)
 *   v(x)   deflection, positive UP; theta(x) = dv/dx, positive counter-clockwise
 *   Relations: dV/dx = q, dM/dx = V, EI·v'' = M.
 *   A counter-clockwise applied couple makes M jump DOWN by its value (left to right).
 */

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** A problem found while reading or solving a beam block. */
export interface Diagnostic {
	/** Errors stop the analysis; warnings are shown next to the results. */
	severity: 'error' | 'warning';
	/** Human readable, sentence case, no trailing period required. */
	message: string;
	/** 1-based line number inside the code block, when the problem has one. */
	line?: number;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * Unit presets selectable with the `units` statement. They set the unit of
 * bare numbers and the units used to display results.
 */
export type UnitSystemId = 'kN-m' | 'N-mm' | 'kip-ft' | 'lb-in';

/**
 * Physical dimension of a quantity. `sectionLength` and `deflection` are
 * lengths with their own default/display units (mm or in).
 * `stress` and `modulus` are both pressures but may use different display
 * units (MPa and GPa in kN-m; the same unit in the other systems).
 */
export type Dimension =
	| 'length'
	| 'force'
	| 'moment'
	| 'distributed'
	| 'modulus'
	| 'inertia'
	| 'sectionLength'
	| 'deflection'
	| 'stress'
	| 'slope';

// ---------------------------------------------------------------------------
// Source level: the abstract syntax tree (what the user typed)
// ---------------------------------------------------------------------------

/** Support types. A free end is simply an end without a support. */
export type SupportKind = 'pin' | 'roller' | 'fixed';

/** Direction words accepted for forces and distributed loads. */
export type ForceDirection = 'down' | 'up';

/** Direction words accepted for couples (point moments). */
export type MomentDirection = 'cw' | 'ccw';

/**
 * Cross-section shapes with built-in formulas.
 *   rect   b x h            solid rectangle (b = width, h = depth)
 *   circle d                solid circle (d = diameter)
 *   tube   d x t            hollow circle (d = outside diameter, t = wall)
 *   box    b x h x t        hollow rectangle with uniform wall t
 *   ibeam  b x h x tw x tf  symmetric I / H section without root fillets
 */
export type SectionShape = 'rect' | 'circle' | 'tube' | 'box' | 'ibeam';

/** Built-in material presets (see materials.ts for values and sources). */
export type MaterialId = 'steel' | 'stainless' | 'aluminium' | 'timber' | 'concrete';

/**
 * A position as typed: a quantity such as "2", "2 m", "1500 mm", or one of
 * the keywords "start" / "left" (x = 0), "mid" / "middle" / "center" (x = L/2),
 * "end" / "right" (x = L). Stored as the raw string, e.g. "2 m" or "end".
 */
export type RawPosition = string;

/**
 * A number with an optional unit, exactly as typed: "10", "10 kN", "10kN",
 * "-2.5e3 N". Units are resolved later by `buildModel`.
 */
export type RawQuantity = string;

/** `pin at 0`, `roller at end`, `fixed at start` */
export interface AstSupport {
	kind: SupportKind;
	at: RawPosition;
	line?: number;
}

/** `hinge at 4` (internal moment release) */
export interface AstHinge {
	at: RawPosition;
	line?: number;
}

/** `point 10 kN down at 2 m` (direction optional, defaults to down) */
export interface AstPointLoad {
	kind: 'point';
	magnitude: RawQuantity;
	direction: ForceDirection;
	at: RawPosition;
	line?: number;
}

/** `moment 5 kNm ccw at 3` (direction REQUIRED: there is no safe default) */
export interface AstMomentLoad {
	kind: 'moment';
	magnitude: RawQuantity;
	direction: MomentDirection;
	at: RawPosition;
	line?: number;
}

/**
 * `udl 4 kN/m down from 0 to 6`.
 * `from`/`to` are optional: when both are omitted the load covers the beam.
 */
export interface AstUniformLoad {
	kind: 'udl';
	magnitude: RawQuantity;
	direction: ForceDirection;
	from?: RawPosition;
	to?: RawPosition;
	line?: number;
}

/**
 * `linear 0 to 6 kN/m down from 0 to 3` (trapezoidal or triangular load).
 * `start` acts at `from`, `end` acts at `to`.
 */
export interface AstLinearLoad {
	kind: 'linear';
	start: RawQuantity;
	end: RawQuantity;
	direction: ForceDirection;
	from?: RawPosition;
	to?: RawPosition;
	line?: number;
}

export type AstLoad = AstPointLoad | AstMomentLoad | AstUniformLoad | AstLinearLoad;

/** `section rect 100 x 200 mm`: dims as typed plus an optional shared unit. */
export interface AstSection {
	shape: SectionShape;
	/** One raw number per dimension, in the order documented on SectionShape. */
	dims: RawQuantity[];
	/** Optional trailing unit applying to every dim, e.g. "mm". */
	unit?: string;
	line?: number;
}

/**
 * Everything a beam block can contain. Statements are order independent:
 * the parser collects them into these fields. Optional fields are undefined
 * when the statement is absent.
 */
export interface BeamAst {
	title?: string;
	/** Undefined means "use the plugin default unit system". */
	units?: UnitSystemId;
	length?: RawQuantity;
	supports: AstSupport[];
	hinges: AstHinge[];
	loads: AstLoad[];
	/** Material preset id as typed (validated by buildModel). */
	material?: string;
	/** Young's modulus, e.g. "200 GPa". Overrides the material preset. */
	E?: RawQuantity;
	/** Second moment of area, e.g. "8000 cm^4". Overrides the section. */
	I?: RawQuantity;
	section?: AstSection;
	/**
	 * Line numbers of the single-valued statements that model messages point
	 * to. (Duplicate title and units lines are caught by the parser itself.)
	 */
	lines: Partial<Record<'length' | 'material' | 'E' | 'I', number>>;
	/** Number of comment lines (the editor warns that saving drops them). */
	commentCount: number;
}

// ---------------------------------------------------------------------------
// Model level: validated beam in SI base units
// ---------------------------------------------------------------------------

export interface Support {
	kind: SupportKind;
	/** Position [m]. */
	x: number;
	/** Source line, for diagnostics. */
	line?: number;
}

/** Concentrated force. `fy` is positive UP [N]. */
export interface PointLoad {
	kind: 'point';
	x: number;
	fy: number;
	line?: number;
}

/** Concentrated couple. `mz` is positive COUNTER-CLOCKWISE [N·m]. */
export interface MomentLoad {
	kind: 'moment';
	x: number;
	mz: number;
	line?: number;
}

/**
 * Linearly varying distributed load between x1 < x2. q1 acts at x1 and q2 at
 * x2, both positive UP [N/m]. A uniform load has q1 === q2.
 */
export interface DistributedLoad {
	kind: 'distributed';
	x1: number;
	x2: number;
	q1: number;
	q2: number;
	line?: number;
}

export type Load = PointLoad | MomentLoad | DistributedLoad;

export interface MaterialPreset {
	id: MaterialId;
	/** Display name, e.g. "Structural steel". */
	label: string;
	/** Young's modulus [Pa]. */
	E: number;
	/**
	 * Where the value comes from. Documentation only: the plugin UI shows
	 * `label`, not this text.
	 */
	source: string;
}

/** Section properties computed from a shape (all SI). */
export interface SectionProps {
	shape: SectionShape;
	/** Dimensions [m] in the order documented on SectionShape. */
	dims: number[];
	/** Second moment of area about the bending axis [m^4]. */
	I: number;
	/** Distance from the neutral axis to the extreme fibre [m] (symmetric shapes). */
	c: number;
	/** Cross-section area [m^2]. */
	area: number;
	/** Human readable description, e.g. "Rectangle 100 × 200 mm". Set by the model builder. */
	label: string;
}

/** A beam ready for analysis. Everything is in SI base units. */
export interface BeamModel {
	title?: string;
	/** Unit system used to read bare numbers and to display results. */
	units: UnitSystemId;
	/** Total length [m] > 0. The beam spans x = 0 .. length. */
	length: number;
	/** Distinct positions, sorted by x. */
	supports: Support[];
	/** Internal hinge positions [m], sorted, strictly inside (0, length). */
	hinges: number[];
	loads: Load[];
	/** Young's modulus [Pa], from `E` or the material preset. */
	E?: number;
	/** Second moment of area [m^4], from `I` or the section. */
	I?: number;
	/** Present when a material preset was used. */
	material?: MaterialPreset;
	/** Present when a section shape was given (enables bending stress). */
	section?: SectionProps;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Polynomial coefficients in ascending powers: p(s) = c[0] + c[1]·s + c[2]·s² + ... */
export type Poly = number[];

/**
 * One piece of the exact solution between two consecutive key points
 * (supports, hinges, point loads, couples, distributed-load ends, beam ends).
 * Inside a segment every quantity is a smooth polynomial of the local
 * coordinate s = x - x0, with s in [0, x1 - x0].
 */
export interface Segment {
	x0: number;
	x1: number;
	/** Distributed load q(s) [N/m], degree <= 1. */
	q: Poly;
	/** Shear force V(s) [N], degree <= 2. */
	V: Poly;
	/** Bending moment M(s) [N·m], degree <= 3. */
	M: Poly;
	/** Slope theta(s) [rad], degree <= 4. Present only when BeamResults.hasDeflection is true. */
	theta?: Poly;
	/** Deflection v(s) [m], degree <= 5. Present only when BeamResults.hasDeflection is true. */
	v?: Poly;
}

/** Support reaction in the internal sign convention. */
export interface Reaction {
	/** Index into BeamModel.supports. */
	supportIndex: number;
	kind: SupportKind;
	x: number;
	/** Vertical reaction force [N], positive UP. */
	fy: number;
	/** Reaction couple [N·m], positive COUNTER-CLOCKWISE. Zero unless fixed. */
	mz: number;
}

/** A value and where it occurs. */
export interface Extremum {
	value: number;
	x: number;
}

/** Quantities that can be plotted. */
export type DiagramQuantity = 'shear' | 'moment' | 'deflection';

export interface Extrema {
	/** Largest (most positive) and smallest (most negative) shear. */
	shearMax: Extremum;
	shearMin: Extremum;
	/** Largest sagging (max) and largest hogging (min) moment. */
	momentMax: Extremum;
	momentMin: Extremum;
	/** Largest upward (max) and downward (min) deflection, when EI is known. */
	deflectionMax?: Extremum;
	deflectionMin?: Extremum;
	/**
	 * Largest bending stress magnitude sigma = |M|·c / I [Pa], when a section
	 * shape is known.
	 */
	stressMax?: Extremum;
}

/** Static determinacy and stability of the support layout. */
export interface Classification {
	/** False when the beam can move as a mechanism. */
	stable: boolean;
	/** 0 = statically determinate, n > 0 = indeterminate to degree n. Null if unstable. */
	degree: number | null;
}

export interface BeamResults {
	model: BeamModel;
	classification: Classification;
	reactions: Reaction[];
	/** Contiguous pieces covering [0, length] in order. */
	segments: Segment[];
	/** Sorted distinct x positions where segments meet (includes 0 and length). */
	keyPoints: number[];
	extrema: Extrema;
	/** Positions where V changes sign (inside segments or by a jump through zero). */
	shearZeros: number[];
	/** Global equilibrium residuals after solving: sum Fy [N] and sum Mz about x = 0 [N·m]. */
	residual: { force: number; moment: number };
	/**
	 * True when slope and deflection are available: E and I given, and the
	 * results within double-precision range (see solveBeam).
	 */
	hasDeflection: boolean;
}

/** A plotted series. A jump is two consecutive points with the same x. */
export interface DiagramSeries {
	quantity: DiagramQuantity;
	/** Positions [m]. */
	xs: number[];
	/** Values in SI units (N, N·m, m). */
	ys: number[];
}

// ---------------------------------------------------------------------------
// Pipeline and display options
// ---------------------------------------------------------------------------

/** How the bending moment diagram is oriented. */
export type MomentConvention = 'sagging-up' | 'tension-side';

/**
 * Display preferences stored in the plugin settings (BeamStaticsSettings in
 * settings.ts extends this with the UI-only results table switch). The
 * renderer reads `decimals` and `momentConvention`; the analysis pipeline
 * takes its own options (AnalyzeOptions in analyze.ts).
 */
export interface DisplayOptions {
	/** Unit system used when a block has no `units` statement. */
	defaultUnits: UnitSystemId;
	/** Decimal places for displayed numbers. */
	decimals: number;
	/**
	 * 'sagging-up': positive (sagging) moment plotted above the axis (US/open textbooks).
	 * 'tension-side': moment drawn on the tension side, so sagging is plotted BELOW
	 * the axis (common in European and Brazilian structural practice).
	 */
	momentConvention: MomentConvention;
	/** Draw the deflected shape when E and I are known. */
	showDeflection: boolean;
}

/** Everything the UI needs to display one block. */
export interface AnalysisOutput {
	ast: BeamAst;
	/** Unit system in effect (block `units` statement or the default). */
	units: UnitSystemId;
	/** Present when there are no errors up to the model stage. */
	model?: BeamModel;
	/** Present when the beam was solved successfully. */
	results?: BeamResults;
	/** All errors and warnings, sorted by line (whole-beam issues last). */
	diagnostics: Diagnostic[];
}

/** Thrown by the solver for beams that cannot be analysed (e.g. mechanisms). */
export class BeamAnalysisError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BeamAnalysisError';
	}
}
