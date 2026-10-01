/**
 * Shear force, bending moment and deflection diagrams.
 * STUB: to be implemented.
 */
import type { BeamResults, DiagramQuantity } from '../core/types';
import type { Scene, SceneOptions } from './scene';

/**
 * Builds one diagram aligned with the beam scene (same XLayout). Positive and
 * negative areas get different classes, extremes and zero crossings are
 * labelled, and jumps are drawn as vertical steps.
 */
export function buildDiagramScene(results: BeamResults, quantity: DiagramQuantity, options: SceneOptions): Scene {
	throw new Error('not implemented');
}
