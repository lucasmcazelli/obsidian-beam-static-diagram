/**
 * Turns an AST back into canonical block text (used by the interactive editor).
 *
 * The output is designed so that parsing it again gives the same AST (apart
 * from line numbers and the comment count): raw quantities are written back
 * unchanged, directions are always explicit, and statements follow one fixed
 * order. Comments cannot be represented in the AST and are dropped, which is
 * why the editor warns before saving a block that has comments.
 */
import type { AstLoad, BeamAst } from './types';
import { UNIT_SYSTEMS } from './units';

/** " from 0 to 6 m", or "" when the load covers the whole beam. */
function extent(from: string | undefined, to: string | undefined): string {
	// Each end is written when present, so a half-specified extent from the
	// editor surfaces as a parse error instead of being silently dropped.
	let text = '';
	if (from !== undefined) text += ` from ${from.trim()}`;
	if (to !== undefined) text += ` to ${to.trim()}`;
	return text;
}

/** One load statement. */
function loadLine(load: AstLoad): string {
	switch (load.kind) {
		case 'point':
			return `point ${load.magnitude.trim()} ${load.direction} at ${load.at.trim()}`;
		case 'moment':
			return `moment ${load.magnitude.trim()} ${load.direction} at ${load.at.trim()}`;
		case 'udl':
			return `udl ${load.magnitude.trim()} ${load.direction}${extent(load.from, load.to)}`;
		case 'linear':
			return `linear ${load.start.trim()} to ${load.end.trim()} ${load.direction}${extent(load.from, load.to)}`;
	}
}

/**
 * Serializes an AST to block text (no fences), one statement per line, ending without a newline.
 * Order: title, units, length, supports, hinges, loads, material, E, I, section.
 */
export function serializeBeamAst(ast: BeamAst): string {
	const lines: string[] = [];
	const title = ast.title?.trim();
	if (title) lines.push(`title ${title}`);
	// Only write units when the block chose them; otherwise the plugin default applies.
	if (ast.units) lines.push(`units ${UNIT_SYSTEMS[ast.units].keyword}`);
	if (ast.length !== undefined) lines.push(`length ${ast.length.trim()}`);
	for (const support of ast.supports) lines.push(`${support.kind} at ${support.at.trim()}`);
	for (const hinge of ast.hinges) lines.push(`hinge at ${hinge.at.trim()}`);
	for (const load of ast.loads) lines.push(loadLine(load));
	if (ast.material !== undefined) lines.push(`material ${ast.material.trim()}`);
	if (ast.E !== undefined) lines.push(`E ${ast.E.trim()}`);
	if (ast.I !== undefined) lines.push(`I ${ast.I.trim()}`);
	if (ast.section) {
		const { shape, dims, unit } = ast.section;
		const unitText = unit ? ` ${unit.trim()}` : '';
		lines.push(`section ${shape} ${dims.map((d) => d.trim()).join(' x ')}${unitText}`);
	}
	return lines.join('\n');
}
