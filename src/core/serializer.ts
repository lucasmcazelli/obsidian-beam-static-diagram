/**
 * Turns an AST back into canonical block text (used by the interactive editor).
 * STUB: to be implemented.
 */
import type { BeamAst } from './types';

/** Serializes an AST to block text (no fences), one statement per line, ending without a newline. */
export function serializeBeamAst(ast: BeamAst): string {
	throw new Error('not implemented');
}
