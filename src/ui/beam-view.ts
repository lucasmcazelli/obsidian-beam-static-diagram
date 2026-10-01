/**
 * Renders one analysed beam block into a container element: either an error
 * box, or the title, beam drawing, diagrams, warnings and results table.
 *
 * Used by the code block renderer and by the editor's live preview. It only
 * uses Obsidian's DOM helpers (createDiv, createEl, setText, ...) and never
 * parses markup strings, so every piece of user text is inserted as plain text.
 */
import { analyzeBeam } from '../core/analyze';
import { governingDeflectionRatio } from '../core/diagrams';
import { emptyAst, splitLines } from '../core/parser';
import { POSITION_TOL } from '../core/tolerances';
import type { AnalysisOutput, BeamResults, Diagnostic, Dimension, Extremum, UnitSystemId } from '../core/types';
import {
	clampDecimals,
	formatNumber,
	formatQuantity,
	formatSignificant,
	formatSpanRatio,
	TABLE_PLAIN_LIMIT,
	toDisplay,
	UNIT_SYSTEMS,
	unitSymbol,
} from '../core/units';
import { buildBeamScene } from '../render/beam-scene';
import { buildDiagramScene } from '../render/chart-scene';
import { formatResultPosition, supportName } from '../render/draw';
import type { SceneOptions } from '../render/scene';
import type { BeamStaticsSettings } from '../settings';
import { mountScene } from './mount';

/** Footer shown under every solved beam. */
export const DISCLAIMER = 'Educational tool: verify results before using them in design';

/**
 * Runs the analysis pipeline without ever throwing. analyzeBeam is documented
 * to report every problem as a diagnostic, but a bug in it must not break the
 * whole note, so an unexpected exception becomes one error diagnostic.
 *
 * `decimals` (the user's setting) is used for numbers inside warning
 * messages, so they match the drawings and the results table.
 */
export function analyzeSafely(source: string, defaultUnits: UnitSystemId, decimals?: number): AnalysisOutput {
	try {
		return analyzeBeam(source, decimals === undefined ? { defaultUnits } : { defaultUnits, decimals: clampDecimals(decimals) });
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		return {
			ast: emptyAst(),
			units: defaultUnits,
			diagnostics: [
				{ severity: 'error', message: `Something went wrong while analysing this beam (${reason}). Please report it as a bug` },
			],
		};
	}
}

/** "Line 3: message", or just the message for whole-beam problems. */
export function diagnosticText(d: Diagnostic): string {
	return d.line === undefined ? d.message : `Line ${d.line}: ${d.message}`;
}

/** One row of the results table. */
export interface ResultRow {
	label: string;
	value: string;
}

/** True when a formatted number shows as zero ("0", "0.00"), so no sign or arrow is attached to it. */
function showsAsZero(text: string): boolean {
	return /^0(\.0+)?$/.test(text);
}

/**
 * An input property (E, I) in display units with 4 significant digits
 * (formatSignificant: plain decimals down to 1e-4, exponent form below that
 * and from 1e7 up): "200 GPa", "7999 cm⁴".
 *
 * `presetDigits` rounds further first, for values that come from a material
 * preset rather than from the user: presets store one SI value (steel
 * 200 GPa), which converts to 29007.5 ksi, more precision than the preset's
 * source has. Three digits read like the handbooks (29000 ksi, aluminium
 * 9990 ksi, SI still 200 GPa); the analysis keeps the stored SI value.
 */
function formatProperty(valueSI: number, dimension: Dimension, units: UnitSystemId, presetDigits?: number): string {
	const shown = toDisplay(valueSI, dimension, units);
	const value = presetDigits === undefined ? shown : Number(shown.toPrecision(presetDigits));
	// No round-off floor: E and I are inputs (or a section's positive I), never noise, so an
	// absurd "E 1e-300 Pa" must read "1e-309 GPa", not "0 GPa", next to the warning it causes.
	return `${formatSignificant(value, 4, 0)} ${unitSymbol(dimension, units)}`;
}

/** Significant digits for E taken from a material preset (see formatProperty). */
const PRESET_DIGITS = 3;

/** "structural steel" from "Structural steel": material labels read as part of a sentence. */
function lowerFirst(text: string): string {
	return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Builds the results table rows for a solved beam (empty when unsolved).
 * Values are in the block's unit system and use `decimals` decimal places;
 * E and I use 4 significant digits instead (see formatSignificant). Rows:
 * units, reactions, determinacy, extremes, the worst deflection ratio
 * (see governingDeflectionRatio), material, section and stress.
 *
 * Sign handling (internal convention from types.ts: forces up, couples
 * counter-clockwise, sagging moment positive):
 * - reactions are shown as a magnitude plus an arrow (↑ ↓) or rotation (↺ ↻),
 *   which reads unambiguously without knowing the sign convention;
 * - moments keep their sign (sagging +, hogging -) to match the diagram labels;
 * - deflections are magnitudes, the row label says down or up.
 */
export function resultRows(analysis: AnalysisOutput, decimals: number): ResultRow[] {
	const results: BeamResults | undefined = analysis.results;
	if (!results) return [];
	const units = analysis.units;
	const d = clampDecimals(decimals);
	const model = results.model;
	const rows: ResultRow[] = [];

	// The table has room for long numbers: fixed decimals up to TABLE_PLAIN_LIMIT
	// ("200000000.0000 N·mm"), not the diagram labels' exponent form from 1e7.
	const qty = (value: number, dimension: Dimension): string => formatQuantity(value, dimension, units, d, TABLE_PLAIN_LIMIT);
	// Computed positions keep at least 2 decimals (formatResultPosition), so "decimals 0" still locates the peak.
	const at = (x: number): string => `at x = ${formatResultPosition(x, units, d, TABLE_PLAIN_LIMIT)}`;
	/** Number part of a formatted quantity, to test whether it displays as zero. */
	const shown = (value: number, dimension: Dimension): string => formatNumber(toDisplay(value, dimension, units), d, TABLE_PLAIN_LIMIT);

	// --- Units. Bare numbers follow the plugin setting when the block has no units line, so the same
	// note reads differently on another device or after a settings change: say so where it is seen.
	const unitLabel = UNIT_SYSTEMS[units].label;
	rows.push({
		label: 'Units',
		value: analysis.ast.units === undefined ? `${unitLabel}, plugin default (add a units line to make it explicit)` : unitLabel,
	});

	// --- Reactions, named A, B, C... left to right (model.supports is sorted by x).
	for (const r of results.reactions) {
		const name = `Support ${supportName(r.supportIndex)}`;
		const force = qty(Math.abs(r.fy), 'force');
		const arrow = showsAsZero(shown(Math.abs(r.fy), 'force')) ? '' : r.fy > 0 ? ' ↑' : ' ↓';
		rows.push({ label: `${name} (${r.kind}) ${at(r.x)}`, value: force + arrow });
		if (r.kind === 'fixed') {
			const couple = qty(Math.abs(r.mz), 'moment');
			// Positive mz is counter-clockwise in the internal convention.
			const turn = showsAsZero(shown(Math.abs(r.mz), 'moment')) ? '' : r.mz > 0 ? ' ↺ counter-clockwise' : ' ↻ clockwise';
			rows.push({ label: `${name} moment`, value: couple + turn });
		}
	}

	// --- Determinacy. Results only exist for stable beams; "Unstable" is a defensive fallback.
	// The degree counts vertical and rotational restraints only (the model carries no axial
	// forces), so a pin-pin beam is determinate here while textbooks that count horizontal
	// reactions call it indeterminate to degree 1. The qualifier says which count this is.
	const degree = results.classification.degree;
	rows.push({
		label: 'Static determinacy',
		value:
			degree === null
				? 'Unstable'
				: degree === 0
					? 'Statically determinate (vertical loads)'
					: `Statically indeterminate, degree ${degree} (vertical loads)`,
	});

	// --- Extremes.
	const { shearMax, shearMin, momentMax, momentMin, deflectionMax, deflectionMin, stressMax } = results.extrema;
	const shear: Extremum = Math.abs(shearMin.value) > Math.abs(shearMax.value) ? shearMin : shearMax;
	rows.push({ label: 'Max shear force |V|', value: `${qty(Math.abs(shear.value), 'force')} ${at(shear.x)}` });

	const sagging = momentMax.value > 0 && !showsAsZero(shown(momentMax.value, 'moment'));
	rows.push({ label: 'Max sagging moment', value: sagging ? `${qty(momentMax.value, 'moment')} ${at(momentMax.x)}` : 'None' });
	const hogging = momentMin.value < 0 && !showsAsZero(shown(-momentMin.value, 'moment'));
	rows.push({ label: 'Max hogging moment', value: hogging ? `${qty(momentMin.value, 'moment')} ${at(momentMin.x)}` : 'None' });

	if (results.hasDeflection && deflectionMin && deflectionMax) {
		const down = deflectionMin.value < 0 && !showsAsZero(shown(-deflectionMin.value, 'deflection'));
		rows.push({ label: 'Max deflection down', value: down ? `${qty(-deflectionMin.value, 'deflection')} ${at(deflectionMin.x)}` : 'None' });
		// Upward deflection only matters for overhangs and uplift loads: list it only when present.
		if (deflectionMax.value > 0 && !showsAsZero(shown(deflectionMax.value, 'deflection'))) {
			rows.push({ label: 'Max deflection up', value: `${qty(deflectionMax.value, 'deflection')} ${at(deflectionMax.x)}` });
		}
		// One ratio for the whole beam, taken per span and cantilever (governingDeflectionRatio in
		// core/diagrams.ts, shared with the large-deflection warning).
		const governing = governingDeflectionRatio(results);
		if (governing) {
			// Region ends named like the drawing: support letters, or "free end".
			const end = (x: number): string => {
				const index = model.supports.findIndex((s) => Math.abs(s.x - x) <= POSITION_TOL * model.length);
				return index < 0 ? 'free end' : supportName(index);
			};
			const where = `${governing.kind} ${qty(governing.x1 - governing.x0, 'length')}, ${end(governing.x0)} to ${end(governing.x1)}`;
			rows.push({ label: 'Worst deflection ratio', value: `${formatSpanRatio(governing.x1 - governing.x0, governing.peak)} (${where})` });
		}
	}

	// --- Stiffness inputs actually used. buildModel stores the explicit E / I in
	// model.E / model.I (and even in model.section.I), so overrides are detected
	// from the AST, which still says what the user typed.
	if (model.E !== undefined) {
		let note = '';
		if (model.material) {
			const name = lowerFirst(model.material.label);
			note = analysis.ast.E !== undefined ? ` (overrides ${name})` : ` (${name})`;
		}
		// E from a preset (no typed E) is rounded to the preset's own precision.
		const fromPreset = model.material !== undefined && analysis.ast.E === undefined;
		rows.push({ label: 'Material', value: `E = ${formatProperty(model.E, 'modulus', units, fromPreset ? PRESET_DIGITS : undefined)}${note}` });
	} else if (model.material) {
		rows.push({ label: 'Material', value: model.material.label });
	}
	if (model.I !== undefined) {
		// A comma rather than parentheses: section labels have their own ("I-beam (no fillets) ...").
		let note = '';
		if (model.section) note = analysis.ast.I !== undefined ? `, overrides ${model.section.label}` : `, ${model.section.label}`;
		rows.push({ label: 'Section', value: `I = ${formatProperty(model.I, 'inertia', units)}${note}` });
	} else if (model.section) {
		rows.push({ label: 'Section', value: model.section.label });
	}
	if (stressMax) {
		rows.push({ label: 'Max bending stress', value: `${qty(stressMax.value, 'stress')} ${at(stressMax.x)}` });
	}
	return rows;
}

/** Splits block text into lines the same way the parser numbers them (the parser's own splitLines). */
function sourceLines(source: string | undefined): string[] | undefined {
	return source === undefined ? undefined : splitLines(source);
}

/**
 * Error box listing every error. Line errors show the offending line under
 * the message so the user can spot it without counting lines.
 *
 * Deliberately not role="alert": the box is rebuilt on every redraw (each
 * typing pause in the editor, each resize, each settings change), and an
 * alert would make screen readers announce it again every time. The editor
 * has its own status line as the live region.
 */
function renderErrors(container: HTMLElement, errors: Diagnostic[], lines: string[] | undefined): void {
	const box = container.createDiv({ cls: 'bsd-error' });
	box.createDiv({
		cls: 'bsd-error-heading',
		text: errors.length === 1 ? 'Fix this problem to draw the beam:' : `Fix these ${errors.length} problems to draw the beam:`,
	});
	const list = box.createEl('ul', { cls: 'bsd-error-list' });
	for (const error of errors) {
		const item = list.createEl('li');
		item.createSpan({ cls: 'bsd-error-message', text: diagnosticText(error) });
		const lineText = error.line === undefined ? undefined : lines?.[error.line - 1];
		if (lineText !== undefined && lineText.trim() !== '') {
			item.createEl('code', { cls: 'bsd-error-source', text: lineText.trim() });
		}
	}
}

/** Small list of warnings (results are still valid but deserve attention). */
function renderWarnings(container: HTMLElement, warnings: Diagnostic[]): void {
	if (warnings.length === 0) return;
	const list = container.createEl('ul', { cls: 'bsd-warnings', attr: { 'aria-label': 'Warnings' } });
	for (const warning of warnings) list.createEl('li', { text: diagnosticText(warning) });
}

/** No-break space (U+00A0). */
const NBSP = '\u00a0';

/**
 * Glues the pieces of a table cell that must not wrap apart on a narrow
 * screen: a number and the unit or word after it ("5.00 m", "degree 2"),
 * an arrow and its value ("18.67 kN ↑"), "x = ", and the short phrases
 * "vertical loads" and "free end". Other spaces still wrap. Display only:
 * resultRows keeps plain spaces.
 */
export function keepTogether(text: string): string {
	return text
		.replace(/(\d) (?=\S)/g, `$1${NBSP}`)
		.replace(/ (?=[↑↓↺↻])/g, NBSP)
		.replace(/\bdegree (?=\d)/g, `degree${NBSP}`)
		.replace(/\bx = /g, `x${NBSP}=${NBSP}`)
		.replace(/\b(vertical|free) (loads|end)\b/g, `$1${NBSP}$2`);
}

/** Two-column table: row header (th scope=row) and value. */
function renderTable(container: HTMLElement, rows: ResultRow[]): void {
	if (rows.length === 0) return;
	const table = container.createEl('table', { cls: 'bsd-table' });
	table.createEl('caption', { text: 'Results' });
	const body = table.createEl('tbody');
	for (const row of rows) {
		const tr = body.createEl('tr');
		tr.createEl('th', { text: keepTogether(row.label), attr: { scope: 'row' } });
		tr.createEl('td', { text: keepTogether(row.value) });
	}
}

/**
 * Renders `analysis` into `container` at `width` px (the caller adds the
 * `bsd-block` class and measures the width). The container is emptied first.
 *
 * With errors: an error box (`.bsd-error`, deliberately not a live region,
 * see renderErrors) with "Line N: message" entries and, when `source` is
 * given, the offending line text.
 * Otherwise: optional title, the beam drawing, shear and moment diagrams, the
 * deflection diagram (when available and enabled), warnings, the results
 * table (when enabled) and a disclaimer.
 *
 * If a scene builder throws, the container shows that error instead of a
 * half-drawn block, so one bad beam never breaks the rest of the note.
 */
export function renderBeamOutput(
	container: HTMLElement,
	analysis: AnalysisOutput,
	settings: BeamStaticsSettings,
	width: number,
	source?: string,
): void {
	container.empty();
	const lines = sourceLines(source);
	const errors = analysis.diagnostics.filter((d) => d.severity === 'error');
	const results = analysis.results;
	if (errors.length > 0 || !results) {
		// No results without an error diagnostic would be an analyzeBeam bug; still say something useful.
		renderErrors(container, errors.length > 0 ? errors : [{ severity: 'error', message: 'This beam could not be analysed' }], lines);
		return;
	}

	const decimals = clampDecimals(settings.decimals);
	const options: SceneOptions = {
		width: Math.max(1, Math.floor(width)),
		units: analysis.units,
		decimals,
		momentConvention: settings.momentConvention,
	};
	try {
		if (results.model.title) container.createDiv({ cls: 'bsd-title', text: results.model.title });
		mountScene(container, buildBeamScene(results.model, results, options));
		mountScene(container, buildDiagramScene(results, 'shear', options));
		mountScene(container, buildDiagramScene(results, 'moment', options));
		if (results.hasDeflection && settings.showDeflection) {
			mountScene(container, buildDiagramScene(results, 'deflection', options));
		}
	} catch (e) {
		container.empty();
		const reason = e instanceof Error ? e.message : String(e);
		renderErrors(container, [{ severity: 'error', message: `Something went wrong while drawing this beam (${reason}). Please report it as a bug` }], lines);
		return;
	}

	renderWarnings(container, analysis.diagnostics.filter((d) => d.severity === 'warning'));
	if (settings.showResultsTable) renderTable(container, resultRows(analysis, decimals));
	container.createDiv({ cls: 'bsd-disclaimer', text: DISCLAIMER });
}
