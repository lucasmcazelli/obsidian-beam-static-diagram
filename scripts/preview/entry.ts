/**
 * Page script of the browser preview (preview/index.html).
 *
 * Renders every built-in example in the light and dark themes with the REAL
 * renderer (src/ui/beam-view.ts), plus a text box that redraws a block as
 * you type. The controls at the top change the settings the plugin would
 * pass (units, decimals, moment convention, ...) and the drawing width.
 *
 * Screenshot mode: `index.html?example=<id>&theme=light&width=760` renders
 * one panel only (id="shot"), with no page chrome, for README images.
 * `example=playground` renders DEFAULT_BEAM_SOURCE; `source=<text>` (URL
 * encoded) renders any block.
 *
 * Like the plugin, the page builds DOM only with element helpers and
 * textContent; nothing is parsed as markup.
 *
 * Development tool only (npm run preview): never bundled into the plugin.
 */
import './polyfill';
import { BEAM_EXAMPLES, DEFAULT_BEAM_SOURCE } from '../../src/core/examples';
import type { MomentConvention, UnitSystemId } from '../../src/core/types';
import { UNIT_SYSTEMS } from '../../src/core/units';
import { DEFAULT_SETTINGS, UNIT_SYSTEM_IDS, type BeamStaticsSettings } from '../../src/settings';
import { analyzeSafely, renderBeamOutput } from '../../src/ui/beam-view';

type Theme = 'light' | 'dark';

/** Drawing width used when nothing else is asked for [px]. */
const DEFAULT_WIDTH = 640;

/** Delay between the last keystroke in the text box and the redraw [ms]. */
const TYPING_DELAY_MS = 150;

/** What the page renders with: the plugin settings plus preview-only options. */
interface PreviewOptions {
	settings: BeamStaticsSettings;
	width: number;
	themes: Theme[];
}

/** Clamps a width to something the renderer and the page layout handle well. */
function clampWidth(value: number): number {
	return Number.isFinite(value) ? Math.min(1600, Math.max(280, Math.round(value))) : DEFAULT_WIDTH;
}

/**
 * Renders `source` into a new themed panel under `parent`, exactly as a beam
 * block would appear in a note with these settings.
 */
function renderPanel(parent: HTMLElement, source: string, theme: Theme, options: PreviewOptions): HTMLElement {
	const { settings, width } = options;
	const panel = parent.createDiv({ cls: ['panel', `theme-${theme}`] });
	// The panel adds 16 px of padding on each side around the drawing width.
	panel.style.width = `${width + 32}px`;
	const block = panel.createDiv({ cls: 'bsd-block' });
	const analysis = analyzeSafely(source, settings.defaultUnits, settings.decimals);
	renderBeamOutput(block, analysis, settings, width, source);
	return panel;
}

/** Light and/or dark panels for one block. */
function renderPanels(parent: HTMLElement, source: string, options: PreviewOptions): void {
	parent.empty();
	for (const theme of options.themes) renderPanel(parent, source, theme, options);
}

// ---------------------------------------------------------------------------
// Screenshot mode
// ---------------------------------------------------------------------------

/** Renders a single panel when the URL asks for one; returns false otherwise. */
function renderShot(params: URLSearchParams): boolean {
	const id = params.get('example');
	const custom = params.get('source');
	if (id === null && custom === null) return false;

	const source =
		custom ?? (id === 'playground' ? DEFAULT_BEAM_SOURCE : BEAM_EXAMPLES.find((example) => example.id === id)?.source);
	document.body.empty();
	document.body.addClass('shot');
	if (source === undefined) {
		const known = BEAM_EXAMPLES.map((e) => e.id).join(', ');
		document.body.createEl('p', { text: `Unknown example "${id ?? ''}". Known: playground, ${known}`, attr: { id: 'shot' } });
		return true;
	}
	const theme: Theme = params.get('theme') === 'dark' ? 'dark' : 'light';
	const width = clampWidth(Number(params.get('width') ?? DEFAULT_WIDTH));
	const units = params.get('units');
	const settings: BeamStaticsSettings = {
		...DEFAULT_SETTINGS,
		...(units !== null && (UNIT_SYSTEM_IDS as string[]).includes(units) ? { defaultUnits: units as UnitSystemId } : {}),
		...(params.get('moment') === 'tension-side' ? { momentConvention: 'tension-side' as MomentConvention } : {}),
	};
	const panel = renderPanel(document.body, source, theme, { settings, width, themes: [theme] });
	panel.id = 'shot';
	return true;
}

// ---------------------------------------------------------------------------
// Interactive page
// ---------------------------------------------------------------------------

/** Element with an id from the page template, typed. */
function byId<T extends HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) throw new Error(`Preview page is missing #${id}`);
	return el as T;
}

/** Wires the controls, the text box and the example list. */
function renderPage(): void {
	const width = byId<HTMLInputElement>('width');
	const units = byId<HTMLSelectElement>('units');
	const decimals = byId<HTMLInputElement>('decimals');
	const moment = byId<HTMLSelectElement>('moment');
	const deflection = byId<HTMLInputElement>('deflection');
	const table = byId<HTMLInputElement>('table');
	const themes = byId<HTMLSelectElement>('themes');
	const input = byId<HTMLTextAreaElement>('source');
	const playground = byId<HTMLElement>('playground');
	const examples = byId<HTMLElement>('examples');

	for (const id of UNIT_SYSTEM_IDS) units.createEl('option', { text: UNIT_SYSTEMS[id].label, value: id });
	units.value = DEFAULT_SETTINGS.defaultUnits;
	width.value = String(DEFAULT_WIDTH);
	decimals.value = String(DEFAULT_SETTINGS.decimals);
	moment.value = DEFAULT_SETTINGS.momentConvention;
	deflection.checked = DEFAULT_SETTINGS.showDeflection;
	table.checked = DEFAULT_SETTINGS.showResultsTable;
	input.value = DEFAULT_BEAM_SOURCE;

	/** Current control values. The renderer clamps decimals itself, like in the plugin. */
	const read = (): PreviewOptions => ({
		settings: {
			defaultUnits: units.value as UnitSystemId,
			decimals: Number(decimals.value),
			momentConvention: moment.value as MomentConvention,
			showDeflection: deflection.checked,
			showResultsTable: table.checked,
		},
		width: clampWidth(Number(width.value)),
		themes: themes.value === 'both' ? ['light', 'dark'] : [themes.value as Theme],
	});

	// One container per example, filled by drawExamples().
	const exampleTargets = BEAM_EXAMPLES.map((example) => {
		examples.createEl('h2', { text: `${example.name} (${example.id})` });
		const details = examples.createEl('details');
		details.createEl('summary', { text: 'Source' });
		details.createEl('pre', { text: example.source });
		return { source: example.source, target: examples.createDiv({ cls: 'panels' }) };
	});

	const drawPlayground = (): void => renderPanels(playground, input.value, read());
	const drawExamples = (): void => {
		const options = read();
		for (const { source, target } of exampleTargets) renderPanels(target, source, options);
	};
	const drawAll = (): void => {
		drawPlayground();
		drawExamples();
	};

	for (const control of [width, units, decimals, moment, deflection, table, themes]) {
		control.addEventListener('change', drawAll);
	}
	let timer = 0;
	input.addEventListener('input', () => {
		window.clearTimeout(timer);
		timer = window.setTimeout(drawPlayground, TYPING_DELAY_MS);
	});
	drawAll();
}

if (!renderShot(new URLSearchParams(window.location.search))) renderPage();
