/**
 * Parser for the `beam` code block language (syntax only, no units).
 * STUB: to be implemented.
 */
import type { BeamAst, Diagnostic } from './types';

/** Parses block text into an AST. Never throws: problems become diagnostics with line numbers. */
export function parseBeamSource(source: string): { ast: BeamAst; diagnostics: Diagnostic[] } {
	throw new Error('not implemented');
}

/** An empty AST (no statements). */
export function emptyAst(): BeamAst {
	return { supports: [], hinges: [], loads: [], lines: {}, commentCount: 0 };
}
