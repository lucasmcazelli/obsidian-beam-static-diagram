/**
 * Material presets (Young's modulus) for deflection.
 *
 * Only the elastic modulus matters for an Euler-Bernoulli beam, so a preset is
 * just a named E value with its source. Values are typical design values; a
 * user who needs a specific grade writes `E <value>` instead, which overrides
 * the preset.
 */
import { ownValue } from './lookup';
import type { MaterialId, MaterialPreset } from './types';

/** Built-in presets keyed by id. E is in Pa. */
export const MATERIALS: Record<MaterialId, MaterialPreset> = {
	steel: {
		id: 'steel',
		label: 'Structural steel',
		E: 200e9,
		source: 'AISC 360 (29,000 ksi); EN 1993-1-1 uses 210 GPa, set E to override',
	},
	stainless: {
		id: 'stainless',
		label: 'Stainless steel (austenitic)',
		E: 193e9,
		source: 'Typical austenitic grades 304/316; EN 1993-1-4 gives 200 GPa',
	},
	aluminium: {
		id: 'aluminium',
		label: 'Aluminium alloy 6061-T6',
		E: 68.9e9,
		source: 'ASM / Aluminum Design Manual (10,000 ksi); EN 1999-1-1 uses 70 GPa',
	},
	timber: {
		id: 'timber',
		label: 'Softwood timber C24',
		E: 11e9,
		source: 'EN 338:2016 class C24 mean modulus E0,mean = 11 kN/mm²',
	},
	concrete: {
		id: 'concrete',
		label: 'Concrete C30/37 (uncracked)',
		E: 33e9,
		source: 'EN 1992-1-1:2004 Table 3.1 Ecm for C30/37; cracked sections deflect more',
	},
};

/**
 * Accepted names (normalised: lower case, spaces and underscores as "-").
 * Includes US spelling "aluminum" and everyday words like "wood".
 */
const MATERIAL_ALIASES: Record<string, MaterialId> = {
	steel: 'steel',
	'structural-steel': 'steel',
	stainless: 'stainless',
	'stainless-steel': 'stainless',
	aluminium: 'aluminium',
	aluminum: 'aluminium',
	timber: 'timber',
	wood: 'timber',
	concrete: 'concrete',
};

/** Preset ids in display order, for error messages and dropdowns. */
export const MATERIAL_IDS: MaterialId[] = ['steel', 'stainless', 'aluminium', 'timber', 'concrete'];

/** Finds a preset by id or alias (e.g. "aluminum", "wood"), case-insensitive. */
export function findMaterial(name: string): MaterialPreset | undefined {
	// "Stainless steel", "stainless_steel" and "stainless-steel" are the same name.
	const key = name.trim().toLowerCase().replace(/[\s_]+/g, '-');
	const id = ownValue(MATERIAL_ALIASES, key);
	return id ? MATERIALS[id] : undefined;
}
