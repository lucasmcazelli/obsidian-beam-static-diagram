/**
 * Plugin settings: the stored shape, defaults, validation of loaded data and
 * the settings tab.
 *
 * The tab is declarative (getSettingDefinitions, Obsidian 1.13+): every
 * control is bound to a key of `plugin.settings`, and Obsidian reads, writes
 * and persists the value itself. We only hook `setControlValue` so that open
 * beam blocks redraw as soon as a setting changes.
 */
import { PluginSettingTab, type App, type SettingDefinitionItem } from 'obsidian';
import type { DisplayOptions, MomentConvention, UnitSystemId } from './core/types';
import { clampDecimals, DECIMALS_MAX, DECIMALS_MIN, DEFAULT_DECIMALS, isUnitSystemId, UNIT_SYSTEMS } from './core/units';
import type BeamStaticsPlugin from './main';

// The decimals helpers and isUnitSystemId live in core/units.ts so the pure
// renderers can use them too (this file imports obsidian). Re-exported here
// for the UI modules that already import them from settings.
export { clampDecimals, DECIMALS_MAX, DECIMALS_MIN, isUnitSystemId };

/**
 * Everything stored in the plugin's data.json: the shared display options
 * (default units, decimals 0 to 6, moment convention, deflection diagram on
 * or off) plus the UI-only results table switch.
 */
export interface BeamStaticsSettings extends DisplayOptions {
	/** Show the results table under the diagrams. */
	showResultsTable: boolean;
}

/** Values used on first install and for any missing or invalid stored value. */
export const DEFAULT_SETTINGS: BeamStaticsSettings = {
	defaultUnits: 'kN-m',
	decimals: DEFAULT_DECIMALS,
	momentConvention: 'sagging-up',
	showDeflection: true,
	showResultsTable: true,
};

/** Unit system ids in display order (the order of UNIT_SYSTEMS). */
export const UNIT_SYSTEM_IDS = Object.keys(UNIT_SYSTEMS) as UnitSystemId[];

/** True when `value` is a moment diagram convention. */
function isMomentConvention(value: unknown): value is MomentConvention {
	return value === 'sagging-up' || value === 'tension-side';
}

/**
 * Builds valid settings from whatever `loadData()` returned: null on first
 * install, an object from an older version, or a hand-edited file. Unknown
 * keys are dropped and every invalid value is replaced by its default.
 */
export function normalizeSettings(data: unknown): BeamStaticsSettings {
	const raw: Partial<Record<keyof BeamStaticsSettings, unknown>> = typeof data === 'object' && data !== null ? data : {};
	return {
		defaultUnits: isUnitSystemId(raw.defaultUnits) ? raw.defaultUnits : DEFAULT_SETTINGS.defaultUnits,
		decimals: raw.decimals === undefined ? DEFAULT_SETTINGS.decimals : clampDecimals(raw.decimals),
		momentConvention: isMomentConvention(raw.momentConvention) ? raw.momentConvention : DEFAULT_SETTINGS.momentConvention,
		showDeflection: typeof raw.showDeflection === 'boolean' ? raw.showDeflection : DEFAULT_SETTINGS.showDeflection,
		showResultsTable: typeof raw.showResultsTable === 'boolean' ? raw.showResultsTable : DEFAULT_SETTINGS.showResultsTable,
	};
}

/** Keys of the settings object, so a typo in a control key is a type error. */
type SettingKey = keyof BeamStaticsSettings;

/** Settings tab built from declarative definitions. */
export class BeamStaticsSettingTab extends PluginSettingTab {
	private readonly plugin: BeamStaticsPlugin;

	constructor(app: App, plugin: BeamStaticsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		// Settings sidebar icon (Obsidian 1.11+); without it the plugin gets the generic one.
		this.icon = 'ruler';
	}

	/** One control per setting; Obsidian binds each to `plugin.settings[key]`. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const unitOptions: Record<string, string> = {};
		for (const id of UNIT_SYSTEM_IDS) unitOptions[id] = UNIT_SYSTEMS[id].label;

		const items: SettingDefinitionItem<SettingKey>[] = [
			{
				name: 'Default units',
				desc: 'Used by blocks without a units line: numbers typed without a unit are read in these units, and results are shown in them.',
				control: { type: 'dropdown', key: 'defaultUnits', options: unitOptions, defaultValue: DEFAULT_SETTINGS.defaultUnits },
			},
			{
				name: 'Decimal places',
				desc: `Number of decimals in diagram labels and the results table (${DECIMALS_MIN} to ${DECIMALS_MAX}).`,
				control: {
					type: 'number',
					key: 'decimals',
					min: DECIMALS_MIN,
					max: DECIMALS_MAX,
					step: 1,
					defaultValue: DEFAULT_SETTINGS.decimals,
					// The number input allows typing anything; reject values toFixed() and the layout cannot use.
					validate: (value: number) =>
						Number.isInteger(value) && value >= DECIMALS_MIN && value <= DECIMALS_MAX
							? undefined
							: `Enter a whole number from ${DECIMALS_MIN} to ${DECIMALS_MAX}`,
				},
			},
			{
				name: 'Moment diagram',
				desc: 'Which side of the axis sagging bending moment is drawn on. The values and their signs stay the same.',
				control: {
					type: 'dropdown',
					key: 'momentConvention',
					options: {
						'sagging-up': 'Sagging positive, drawn above the axis',
						'tension-side': 'Drawn on the tension side (sagging below)',
					},
					defaultValue: DEFAULT_SETTINGS.momentConvention,
				},
			},
			{
				name: 'Show deflection diagram',
				desc: 'Draw the deflected shape when a block sets a material or the elastic modulus, and a section or the second moment of area.',
				control: { type: 'toggle', key: 'showDeflection', defaultValue: DEFAULT_SETTINGS.showDeflection },
			},
			{
				name: 'Show results table',
				desc: 'List the reactions, maximum values and section data under the diagrams.',
				control: { type: 'toggle', key: 'showResultsTable', defaultValue: DEFAULT_SETTINGS.showResultsTable },
			},
		];
		return items;
	}

	/**
	 * Lets Obsidian store and save the value, then redraws every open beam
	 * block so the change is visible without reopening the note.
	 */
	override async setControlValue(key: string, value: unknown): Promise<void> {
		await super.setControlValue(key, value);
		this.plugin.refreshBlocks();
	}
}
