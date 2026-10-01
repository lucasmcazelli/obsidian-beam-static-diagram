/**
 * The full pipeline used by the UI: text -> AST -> model -> results, plus
 * engineering warnings.
 * STUB: to be implemented.
 */
import type { AnalysisOutput, UnitSystemId } from './types';

/** Never throws: every problem is reported in `diagnostics`. */
export function analyzeBeam(source: string, options: { defaultUnits: UnitSystemId }): AnalysisOutput {
	throw new Error('not implemented');
}
