/**
 * Beam solver: direct stiffness method for the unknowns, then exact
 * piecewise polynomials for V, M, slope and deflection.
 * STUB: to be implemented.
 */
import type { BeamModel, BeamResults } from './types';

/**
 * Solves a validated model. Throws BeamAnalysisError (from ./types) when the
 * beam is a mechanism. When E or I is missing, reactions, V and M are still
 * exact (prismatic beam) and `hasDeflection` is false.
 */
export function solveBeam(model: BeamModel): BeamResults {
	throw new Error('not implemented');
}
