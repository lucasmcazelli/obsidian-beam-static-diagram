/**
 * Semantic validation: AST (raw strings) -> BeamModel (SI numbers).
 * STUB: to be implemented.
 */
import type { BeamAst, BeamModel, Diagnostic, UnitSystemId } from './types';

/**
 * Resolves units and positions, checks every cross-line rule and returns the
 * model when there are no errors. Warnings may accompany a valid model.
 */
export function buildModel(
	ast: BeamAst,
	defaultUnits: UnitSystemId,
): { model?: BeamModel; units: UnitSystemId; diagnostics: Diagnostic[] } {
	throw new Error('not implemented');
}
