/**
 * Material presets (Young's modulus) for deflection.
 * STUB: to be implemented.
 */
import type { MaterialId, MaterialPreset } from './types';

/** Built-in presets keyed by id. */
export declare const MATERIALS: Record<MaterialId, MaterialPreset>;

/** Finds a preset by id or alias (e.g. "aluminum", "wood"), case-insensitive. */
export function findMaterial(name: string): MaterialPreset | undefined {
	throw new Error('not implemented');
}
