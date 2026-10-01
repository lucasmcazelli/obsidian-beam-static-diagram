/**
 * Cross-section property formulas.
 * STUB: to be implemented.
 */
import type { SectionProps, SectionShape } from './types';

/** Metadata used by the parser, serializer and editor. */
export interface SectionShapeInfo {
	shape: SectionShape;
	/** Display name, e.g. "Rectangle". */
	label: string;
	/** Dimension names in order, e.g. ["b", "h"]. */
	dims: string[];
	/** Longer descriptions for the editor, e.g. ["Width b", "Depth h"]. */
	dimLabels: string[];
}

export declare const SECTION_SHAPES: Record<SectionShape, SectionShapeInfo>;

/**
 * Computes I, c and area for a shape. `dims` are in metres, in the order of
 * SECTION_SHAPES[shape].dims. Returns an error message for impossible
 * geometry (non-positive dims, wall thicker than half the section, ...).
 * The returned `label` is a plain shape name; the model builder replaces it
 * with a unit-aware description.
 */
export function computeSection(shape: SectionShape, dims: number[]): SectionProps | { error: string } {
	throw new Error('not implemented');
}
