/**
 * Kinematic stability and static determinacy of the support layout.
 * STUB: to be implemented.
 */
import type { BeamModel, Classification } from './types';

/**
 * Treats each hinge-separated part as a rigid body with two degrees of
 * freedom (vertical translation and rotation). Supports and hinges add
 * constraint rows. Stable when rank = 2 × parts; degree = rows - 2 × parts.
 * Independent of loads and of EI.
 */
export function classifyBeam(model: Pick<BeamModel, 'length' | 'supports' | 'hinges'>): Classification {
	throw new Error('not implemented');
}
