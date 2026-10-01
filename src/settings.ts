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
import type { MomentConvention, UnitSystemId } from './core/types';
import { UNIT_SYSTEMS } from './core/units';
import type BeamStaticsPlugin from './main';

/** Everything stored in the plugin's data.json. */
export interface BeamStaticsSettings {
	/** Unit system for blocks without a `units` line. */
	defaultUnits: UnitSystemId;
	/** Decimal places in labels and the results table, 0 to 6. */
	decimals: number;
	/** Which side of the axis sagging moment is drawn on. */
	momentConvention: MomentConvention;
	/** Draw the deflection diagram when E and I are known. */
	showDeflection: boolean;
	/** Show the results table under the diagrams. */
	showResultsTable: boolean;
}

/** Values used on first install and for any missing or invalid stored value. */
export const DEFAULT_SETTINGS: BeamStaticsSettings = {
	defaultUnits: 'kN-m',
	decimals: 2,
	momentConvention: 'sagging-up',
	showDeflection: true,
	showResultsTable: true,
};

/** Smallest and largest number of decimals the settings accept. */
export const DECIMALS_MIN = 0;
export const DECIMALS_MAX = 6;

/** Unit system ids in display order (the order of UNIT_SYSTEMS). */
export const UNIT_SYSTEM_IDS = Object.keys(UNIT_SYSTEMS) as UnitSystemId[];

/** True when `value` is one of the unit system ids. */
export function isUnitSystemId(value: unknown): value is UnitSystemId {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(UNIT_SYSTEMS, value);
}

/** True when `value` is a moment diagram convention. */
function isMomentConvention(value: unknown): value is MomentConvention {
	return value === 'sagging-up' || value === 'tension-side';
}

/**
 * Rounds and clamps a decimals value into 0..6. Non-numbers fall back to the
 * default. Used both when loading data and right before rendering, so a hand
 * edited data.json can never make `toFixed` throw.
 */
export function clampDecimals(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.decimals;
	return Math.min(DECIMALS_MAX, Math.max(DECIMALS_MIN, Math.round(value)));
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
				desc: 'Draw the deflected shape when a block gives a material or E, and a section or I.',
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
