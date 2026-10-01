/**
 * Schematic drawing of the beam: supports, hinges, loads, reactions, dimensions.
 * STUB: to be implemented.
 */
import type { BeamModel, BeamResults } from '../core/types';
import type { Scene, SceneOptions } from './scene';

/**
 * Builds the beam schematic. When `results` is given, reactions are drawn
 * (arrows with values, curved arrows for fixed-end couples).
 */
export function buildBeamScene(model: BeamModel, results: BeamResults | undefined, options: SceneOptions): Scene {
	throw new Error('not implemented');
}
