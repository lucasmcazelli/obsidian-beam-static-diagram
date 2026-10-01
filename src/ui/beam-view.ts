/**
 * Renders one analysed beam block into a container element: either an error
 * box, or the title, beam drawing, diagrams, warnings and results table.
 *
 * Used by the code block renderer and by the editor's live preview. It only
 * uses Obsidian's DOM helpers (createDiv, createEl, setText, ...) and never
 * parses markup strings, so every piece of user text is inserted as plain text.
 */
import { analyzeBeam } from '../core/analyze';
import { emptyAst } from '../core/parser';
import type { AnalysisOutput, BeamResults, Diagnostic, Dimension, Extremum, UnitSystemId } from '../core/types';
import { formatCompact, formatNumber, formatQuantity, toDisplay, unitSymbol } from '../core/units';
import { buildBeamScene } from '../render/beam-scene';
import { buildDiagramScene } from '../render/chart-scene';
import { supportName } from '../render/draw';
import type { SceneOptions } from '../render/scene';
import { clampDecimals, type BeamStaticsSettings } from '../settings';
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

/** Letter name of a support (A, B, ...), shared with the drawing's tooltips. Re-exported for the UI tests. */
export { supportName };

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
 * Formats an input property (E, I) compactly: up to 3 decimals without
 * trailing zeros ("200 GPa", "6666.667 cm⁴"), switching to exponent form for
 * very large or very small numbers ("6.67e7 mm⁴"), so typed values are shown
 * as typed rather than padded to the results' decimal places.
 */
function formatProperty(valueSI: number, dimension: Dimension, units: UnitSystemId): string {
	const value = toDisplay(valueSI, dimension, units);
	const abs = Math.abs(value);
	const text = abs >= 1e7 || (abs > 0 && abs < 1e-3) ? formatNumber(value, 2) : formatCompact(value, 3);
	return `${text} ${unitSymbol(dimension, units)}`;
}

/** "structural steel" from "Structural steel": material labels read as part of a sentence. */
function lowerFirst(text: string): string {
	return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Span-to-deflection ratio, the usual serviceability measure ("L/320").
 * L is the full beam length; for a cantilever check, users compare against
 * their code's cantilever limit.
 */
function spanRatio(length: number, deflection: number): string {
	return `L/${Math.round(length / Math.abs(deflection))}`;
}

/**
 * Builds the results table rows for a solved beam (empty when unsolved).
 * Values are in the block's unit system and use `decimals` decimal places.
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

	const qty = (value: number, dimension: Dimension): string => formatQuantity(value, dimension, units, d);
	const at = (x: number): string => `at x = ${qty(x, 'length')}`;
	/** Number part of a formatted quantity, to test whether it displays as zero. */
	const shown = (value: number, dimension: Dimension): string => formatNumber(toDisplay(value, dimension, units), d);

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
	const degree = results.classification.degree;
	rows.push({
		label: 'Static determinacy',
		value:
			degree === null
				? 'Unstable'
				: degree === 0
					? 'Statically determinate'
					: `Statically indeterminate (degree ${degree})`,
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
		rows.push({
			label: 'Max deflection down',
			value: down
				? `${qty(-deflectionMin.value, 'deflection')} ${at(deflectionMin.x)} (${spanRatio(model.length, deflectionMin.value)})`
				: 'None',
		});
		// Upward deflection only matters for overhangs and uplift loads: list it only when present.
		if (deflectionMax.value > 0 && !showsAsZero(shown(deflectionMax.value, 'deflection'))) {
			rows.push({
				label: 'Max deflection up',
				value: `${qty(deflectionMax.value, 'deflection')} ${at(deflectionMax.x)} (${spanRatio(model.length, deflectionMax.value)})`,
			});
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
		rows.push({ label: 'Material', value: `E = ${formatProperty(model.E, 'modulus', units)}${note}` });
	} else if (model.material) {
		rows.push({ label: 'Material', value: model.material.label });
	}
	if (model.I !== undefined) {
		let note = '';
		if (model.section) note = analysis.ast.I !== undefined ? ` (overrides ${model.section.label})` : ` (${model.section.label})`;
		rows.push({ label: 'Section', value: `I = ${formatProperty(model.I, 'inertia', units)}${note}` });
	} else if (model.section) {
		rows.push({ label: 'Section', value: model.section.label });
	}
	if (stressMax) {
		rows.push({ label: 'Max bending stress', value: `${qty(stressMax.value, 'stress')} ${at(stressMax.x)}` });
	}
	return rows;
}

/** Splits block text into lines the same way the parser numbers them. */
function sourceLines(source: string | undefined): string[] | undefined {
	return source === undefined ? undefined : source.split(/\r\n|\r|\n/);
}

/**
 * Error box listing every error. Line errors show the offending line under
 * the message so the user can spot it without counting lines.
 */
function renderErrors(container: HTMLElement, errors: Diagnostic[], lines: string[] | undefined): void {
	const box = container.createDiv({ cls: 'bsd-error', attr: { role: 'alert' } });
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

/** Two-column table: row header (th scope=row) and value. */
function renderTable(container: HTMLElement, rows: ResultRow[]): void {
	if (rows.length === 0) return;
	const table = container.createEl('table', { cls: 'bsd-table' });
	table.createEl('caption', { text: 'Results' });
	const body = table.createEl('tbody');
	for (const row of rows) {
		const tr = body.createEl('tr');
		tr.createEl('th', { text: row.label, attr: { scope: 'row' } });
		tr.createEl('td', { text: row.value });
	}
}

/**
 * Renders `analysis` into `container` at `width` px (the caller adds the
 * `bsd-block` class and measures the width). The container is emptied first.
 *
 * With errors: an error box (`.bsd-error`, role="alert") with "Line N:
 * message" entries and, when `source` is given, the offending line text.
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
