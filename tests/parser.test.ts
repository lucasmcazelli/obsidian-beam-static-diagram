import { describe, expect, it } from 'vitest';
import type { BeamAst, Diagnostic } from '../src/core/types';
import { editDistance, emptyAst, parseBeamSource, positionKeyword, suggest, tokenizeLine } from '../src/core/parser';

/** Parses and asserts there are no diagnostics. */
function ok(source: string): BeamAst {
	const { ast, diagnostics } = parseBeamSource(source);
	expect(diagnostics).toEqual([]);
	return ast;
}

/** Parses and returns all diagnostics, asserting there is at least one. */
function diags(source: string): Diagnostic[] {
	const { diagnostics } = parseBeamSource(source);
	expect(diagnostics.length).toBeGreaterThan(0);
	return diagnostics;
}

/** Message of the first (and only expected) error. */
function errorOf(source: string): string {
	const d = diags(source);
	expect(d[0]?.severity).toBe('error');
	return d[0]?.message ?? '';
}

/** Token kinds and texts of a line, for compact assertions. */
function tokens(text: string): string[] {
	const result = tokenizeLine(text);
	expect(result.error).toBeUndefined();
	return result.tokens.map((t) => `${t.kind}:${t.text}`);
}

describe('tokenizeLine', () => {
	it('splits a glued number and unit and keeps offsets', () => {
		const { tokens: t } = tokenizeLine('point 10kN down @2m');
		expect(t.map((x) => `${x.kind}:${x.text}`)).toEqual([
			'word:point',
			'number:10',
			'word:kN',
			'word:down',
			'symbol:@',
			'number:2',
			'word:m',
		]);
		expect(t[1]).toMatchObject({ start: 6, end: 8 });
		expect(t[2]).toMatchObject({ start: 8, end: 10 });
	});

	it.each(['kN/m', 'kN·m', 'kN*m', 'kN-m', 'kN.m', 'kNm', 'cm^4', 'cm4', 'cm⁴', 'N/mm²', 'N/mm^2', 'ft-lb', 'counter-clockwise', 'solid-circle'])(
		'reads %s as one word',
		(word) => {
			expect(tokens(`5 ${word}`)).toEqual(['number:5', `word:${word}`]);
		},
	);

	it('reads numbers with signs, fractions and exponents', () => {
		expect(tokens('-2.5e3 .5 +3 1E-2 2.')).toEqual(['number:-2.5e3', 'number:.5', 'number:+3', 'number:1E-2', 'number:2.']);
		expect(tokens('\u22124')).toEqual(['number:\u22124']);
	});

	it('does not take a letter after e as an exponent', () => {
		expect(tokens('10em')).toEqual(['number:10', 'word:em']);
	});

	it('reads dimension separators', () => {
		expect(tokens('100x200mm')).toEqual(['number:100', 'sep:x', 'number:200', 'word:mm']);
		expect(tokens('100 X 200')).toEqual(['number:100', 'sep:X', 'number:200']);
		expect(tokens('100×200')).toEqual(['number:100', 'sep:×', 'number:200']);
		expect(tokens('100*200')).toEqual(['number:100', 'sep:*', 'number:200']);
		expect(tokens('100mmx200mm')).toEqual(['number:100', 'word:mm', 'sep:x', 'number:200', 'word:mm']);
		expect(tokens('7.1x.5')).toEqual(['number:7.1', 'sep:x', 'number:.5']);
	});

	it('keeps words that merely contain an x', () => {
		expect(tokens('box 100')).toEqual(['word:box', 'number:100']);
	});

	it('reads punctuation as one-character symbols', () => {
		expect(tokens('length: 6')).toEqual(['word:length', 'symbol::', 'number:6']);
		expect(tokens('at 2 m.')).toEqual(['word:at', 'number:2', 'word:m', 'symbol:.']);
		expect(tokens('E=2')).toEqual(['word:E', 'symbol:=', 'number:2']);
		expect(tokens('a 😀')).toEqual(['word:a', 'symbol:😀']);
	});

	it('stops with an error at a decimal comma', () => {
		const result = tokenizeLine('point 2,5 kN');
		expect(result.error?.message).toBe('Invalid number "2,5": use a dot as the decimal separator');
		expect(result.tokens.map((t) => t.text)).toEqual(['point']);
	});
});

describe('suggestions', () => {
	it('counts adjacent transpositions as one edit', () => {
		expect(editDistance('lenght', 'length')).toBe(1);
		expect(editDistance('suport', 'support')).toBe(1);
		expect(editDistance('abc', 'abc')).toBe(0);
		expect(editDistance('', 'abc')).toBe(3);
	});

	it('suggests only close words', () => {
		expect(suggest('rolller', ['pin', 'roller'])).toBe('roller');
		expect(suggest('foo', ['fix', 'pin'])).toBeUndefined();
		expect(suggest('MOMNET', ['moment'])).toBe('moment');
	});
});

describe('positionKeyword', () => {
	it.each([
		['start', 'start'],
		['left', 'start'],
		['mid', 'mid'],
		['middle', 'mid'],
		['center', 'mid'],
		['centre', 'mid'],
		['end', 'end'],
		['Right', 'end'],
		[' END ', 'end'],
	])('%s -> %s', (text, key) => {
		expect(positionKeyword(text)).toBe(key);
	});

	it('returns undefined for quantities', () => {
		expect(positionKeyword('2 m')).toBeUndefined();
	});
});

describe('parseBeamSource: a complete block', () => {
	it('builds the AST with raw strings and line numbers', () => {
		const ast = ok(
			[
				'title Simply supported beam',
				'units kN m',
				'length 6 m',
				'pin at 0',
				'roller at end',
				'hinge at 3',
				'point 10 kN down at 2 m',
				'moment 5 kNm ccw at 4',
				'udl 4 kN/m down from 0 to 6 m',
				'linear 0 to 6 kN/m up from 1 to 3',
				'material steel',
				'E 200 GPa',
				'I 8000 cm^4',
				'section rect 100 x 200 mm',
			].join('\n'),
		);
		expect(ast).toEqual({
			title: 'Simply supported beam',
			units: 'kN-m',
			length: '6 m',
			supports: [
				{ kind: 'pin', at: '0', line: 4 },
				{ kind: 'roller', at: 'end', line: 5 },
			],
			hinges: [{ at: '3', line: 6 }],
			loads: [
				{ kind: 'point', magnitude: '10 kN', direction: 'down', at: '2 m', line: 7 },
				{ kind: 'moment', magnitude: '5 kNm', direction: 'ccw', at: '4', line: 8 },
				{ kind: 'udl', magnitude: '4 kN/m', direction: 'down', from: '0', to: '6 m', line: 9 },
				{ kind: 'linear', start: '0', end: '6 kN/m', direction: 'up', from: '1', to: '3', line: 10 },
			],
			material: 'steel',
			E: '200 GPa',
			I: '8000 cm^4',
			section: { shape: 'rect', dims: ['100', '200'], unit: 'mm', line: 14 },
			lines: { title: 1, units: 2, length: 3, material: 11, E: 12, I: 13 },
			commentCount: 0,
		});
	});

	it('returns an empty AST for empty input', () => {
		expect(ok('')).toEqual(emptyAst());
		expect(ok('\n\n   \n\t')).toEqual(emptyAst());
	});

	it('is order independent', () => {
		const a = ok('length 6\npin at 0\npoint 1 at 2');
		const b = ok('point 1 at 2\npin at 0\nlength 6');
		expect(a.length).toBe(b.length);
		expect(a.supports.map((s) => s.at)).toEqual(b.supports.map((s) => s.at));
		expect(a.loads.map((l) => l.kind)).toEqual(b.loads.map((l) => l.kind));
	});

	it('handles Windows and old Mac line endings', () => {
		const ast = ok('length 6\r\npin at 0\rroller at 6');
		expect(ast.supports.map((s) => s.line)).toEqual([2, 3]);
	});
});

describe('comments and blank lines', () => {
	it('ignores comment-only and blank lines and counts comment lines', () => {
		const ast = ok(['# a comment', '', 'length 6 m # trailing', '// slash comment', 'pin at 0 // also trailing', '   '].join('\n'));
		expect(ast.length).toBe('6 m');
		expect(ast.supports).toHaveLength(1);
		expect(ast.commentCount).toBe(4);
		expect(ast.lines.length).toBe(3);
	});

	it('does not count lines without comments', () => {
		expect(ok('length 6\npin at 0').commentCount).toBe(0);
	});

	it('strips comments from free-text statements too', () => {
		expect(ok('title My beam # note').title).toBe('My beam');
	});
});

describe('keywords', () => {
	it('is case-insensitive', () => {
		const ast = ok('LENGTH 6 M\nPin AT 0\nROLLER @ END\nPoint 10 KN Down At 2\nMoment 1 kNm CCW At 3\nUDL 2 kN/m UP\nMATERIAL Steel\ne 200 GPa\ni 1 cm^4\nSECTION RECT 1 X 2');
		expect(ast.length).toBe('6 M');
		expect(ast.supports).toEqual([
			{ kind: 'pin', at: '0', line: 2 },
			{ kind: 'roller', at: 'END', line: 3 },
		]);
		expect(ast.loads.map((l) => l.direction)).toEqual(['down', 'ccw', 'up']);
		expect(ast.E).toBe('200 GPa');
		expect(ast.I).toBe('1 cm^4');
		expect(ast.section?.shape).toBe('rect');
	});

	it('accepts a colon (or equals sign) after the first keyword', () => {
		const ast = ok('length: 6 m\npin: at 0\nE: 200 GPa\nI = 8000 cm^4\ntitle: Beam A\nunits: N mm\nmaterial: timber\nsupport: roller at end');
		expect(ast.length).toBe('6 m');
		expect(ast.supports.map((s) => s.kind)).toEqual(['pin', 'roller']);
		expect(ast.E).toBe('200 GPa');
		expect(ast.I).toBe('8000 cm^4');
		expect(ast.title).toBe('Beam A');
		expect(ast.units).toBe('N-mm');
		expect(ast.material).toBe('timber');
	});

	it.each(['length', 'span', 'L', 'l'])('accepts %s for the length', (kw) => {
		expect(ok(`${kw} 6 m`).length).toBe('6 m');
	});

	it.each([
		['pin', 'pin'],
		['pinned', 'pin'],
		['roller', 'roller'],
		['fixed', 'fixed'],
		['clamped', 'fixed'],
		['fix', 'fixed'],
	])('accepts support keyword %s', (kw, kind) => {
		expect(ok(`${kw} at 0`).supports[0]?.kind).toBe(kind);
		expect(ok(`support ${kw} at 0`).supports[0]?.kind).toBe(kind);
		expect(ok(`${kw} support at 0`).supports[0]?.kind).toBe(kind);
	});

	it.each(['point', 'force', 'load'])('accepts %s for a point load', (kw) => {
		expect(ok(`${kw} 10 at 2`).loads[0]).toEqual({ kind: 'point', magnitude: '10', direction: 'down', at: '2', line: 1 });
	});

	it.each(['moment', 'couple'])('accepts %s for a moment', (kw) => {
		expect(ok(`${kw} 3 cw at 1`).loads[0]?.kind).toBe('moment');
	});

	it.each(['udl', 'uniform', 'distributed'])('accepts %s for a uniform load', (kw) => {
		expect(ok(`${kw} 3`).loads[0]).toEqual({ kind: 'udl', magnitude: '3', direction: 'down', line: 1 });
	});

	it.each(['linear', 'trapezoid', 'triangle', 'varying'])('accepts %s for a linear load', (kw) => {
		expect(ok(`${kw} 0 to 3`).loads[0]).toEqual({ kind: 'linear', start: '0', end: '3', direction: 'down', line: 1 });
	});

	it.each(['units', 'unit'])('accepts %s for the unit system', (kw) => {
		expect(ok(`${kw} kip ft`).units).toBe('kip-ft');
	});
});

describe('positions', () => {
	it('accepts "at" and "@" with or without spaces', () => {
		expect(ok('pin @0').supports[0]?.at).toBe('0');
		expect(ok('pin @ 2 m').supports[0]?.at).toBe('2 m');
		expect(ok('pin at 2m').supports[0]?.at).toBe('2m');
	});

	it.each(['start', 'left', 'mid', 'middle', 'center', 'centre', 'end', 'right'])('keeps the keyword %s raw', (kw) => {
		expect(ok(`hinge at ${kw}`).hinges[0]?.at).toBe(kw);
	});

	it('reports a missing or unknown position', () => {
		expect(errorOf('pin at')).toBe('Expected a position after "at", for example: at 2 m or at end');
		expect(errorOf('pin at ned')).toBe('Unknown position "ned". Did you mean "end"?');
		expect(errorOf('pin at somewhere')).toContain('Expected a position after "at"');
	});
});

describe('quantities', () => {
	it.each([
		['10', '10'],
		['10kN', '10kN'],
		['10 kN', '10 kN'],
		['10    kN', '10 kN'],
		['-2.5e3 N', '-2.5e3 N'],
		['.5 kip', '.5 kip'],
		['5 kN·m', '5 kN·m'],
	])('keeps magnitude %j as %j', (typed, raw) => {
		expect(ok(`force ${typed} at 1`).loads[0]).toMatchObject({ magnitude: raw });
	});

	it('takes the next word as the unit only when it is a unit', () => {
		expect(ok('point 10 kN down at 2').loads[0]).toMatchObject({ magnitude: '10 kN', direction: 'down' });
		expect(ok('point 10 down at 2').loads[0]).toMatchObject({ magnitude: '10', direction: 'down' });
	});

	it('joins a force and a length written apart into a moment unit', () => {
		expect(ok('moment 5 kN m cw at 1').loads[0]).toMatchObject({ magnitude: '5 kN m', direction: 'cw' });
		expect(ok('moment 5 kip ft cw at 1').loads[0]).toMatchObject({ magnitude: '5 kip ft' });
	});

	it('rejects a decimal comma with a hint', () => {
		expect(errorOf('length 2,5 m')).toBe('Invalid number "2,5": use a dot as the decimal separator');
		expect(errorOf('point 1,5 kN at 1')).toContain('use a dot as the decimal separator');
	});

	it('reports unknown units', () => {
		expect(errorOf('point 10kNN at 2')).toBe('Unknown unit "kNN": use kN, N, kip or lb');
		expect(errorOf('point 10 tons at 2')).toBe('Unknown unit "tons": use kN, N, kip or lb');
		expect(errorOf('udl 4 kN/mm2x')).toBe('Unknown unit "kN/mm2x": use kN/m, N/mm, kip/ft or lb/ft');
		expect(errorOf('moment 5 kNmm2 cw at 1')).toContain('Unknown unit "kNmm2"');
		// A plain trailing word is simply unexpected.
		expect(errorOf('length 6 furlongs')).toBe('Unexpected "furlongs" at the end of the line');
	});
});

describe('point loads', () => {
	it('defaults to down and accepts up and its variants', () => {
		expect(ok('point 10 at 2').loads[0]).toMatchObject({ direction: 'down' });
		expect(ok('point 10 up at 2').loads[0]).toMatchObject({ direction: 'up' });
		expect(ok('point 10 upward at 2').loads[0]).toMatchObject({ direction: 'up' });
		expect(ok('point 10 downwards at 2').loads[0]).toMatchObject({ direction: 'down' });
	});

	it('accepts the direction after the position', () => {
		expect(ok('point 10 kN at 2 m up').loads[0]).toMatchObject({ magnitude: '10 kN', direction: 'up', at: '2 m' });
	});

	it('keeps a negative magnitude raw (buildModel flips it)', () => {
		expect(ok('point -10 kN down at 2').loads[0]).toMatchObject({ magnitude: '-10 kN', direction: 'down' });
	});

	it('reports missing pieces precisely', () => {
		expect(errorOf('point down at 2')).toBe('Expected a number for the magnitude');
		expect(errorOf('point 10 kN')).toBe('Expected "at" followed by a position');
		expect(errorOf('point 10 kN 2 m')).toBe('Expected "at" followed by a position');
		expect(errorOf('point 10 kN down')).toBe('Expected "at" followed by a position');
	});

	it('suggests a fix for a misspelled word', () => {
		expect(errorOf('point 10 kN dwn at 2')).toBe('Unexpected "dwn". Did you mean "down"?');
		expect(errorOf('point 10 dwon at 2')).toBe('Unexpected "dwon". Did you mean "down"?');
	});

	it('rejects clauses that do not belong to a point load', () => {
		expect(errorOf('point 10 cw at 2')).toBe('Use down or up for the direction of a force or distributed load');
		expect(errorOf('point 10 from 0 to 2')).toContain('acts at one position');
		expect(errorOf('point 10 down up at 2')).toContain('direction is given twice');
		expect(errorOf('point 10 at 2 at 3')).toContain('position is given twice');
	});

	it('reports leftovers at the end of the line', () => {
		expect(errorOf('point 10 kN down at 2 foo')).toBe('Unexpected "foo" at the end of the line');
		expect(errorOf('point 10 kN down at 2, 3')).toBe('Unexpected ",": write one statement per line');
	});
});

describe('moments', () => {
	it.each([
		['cw', 'cw'],
		['clockwise', 'cw'],
		['ccw', 'ccw'],
		['counterclockwise', 'ccw'],
		['counter-clockwise', 'ccw'],
		['anticlockwise', 'ccw'],
		['anti-clockwise', 'ccw'],
		['CCW', 'ccw'],
	])('reads direction %s as %s', (word, dir) => {
		expect(ok(`moment 5 kNm ${word} at 1`).loads[0]).toMatchObject({ direction: dir });
	});

	it('requires a direction', () => {
		expect(errorOf('moment 5 kNm at 3')).toBe('Moment needs a direction: cw or ccw');
		expect(errorOf('moment 5 kNm')).toBe('Moment needs a direction: cw or ccw');
		expect(errorOf('moment 5 kNm down at 3')).toBe('Moment needs a direction: cw or ccw');
	});

	it('requires a position', () => {
		expect(errorOf('moment 5 kNm cw')).toBe('Expected "at" followed by a position');
	});

	it('suggests a misspelled direction', () => {
		expect(errorOf('moment 5 kNm clokwise at 2')).toBe('Unexpected "clokwise". Did you mean "clockwise"?');
	});
});

describe('distributed loads', () => {
	it('covers the whole beam without from/to', () => {
		const load = ok('udl 4 kN/m').loads[0];
		expect(load).toEqual({ kind: 'udl', magnitude: '4 kN/m', direction: 'down', line: 1 });
		expect(load && 'from' in load).toBe(false);
	});

	it('reads from/to in any position after the magnitude', () => {
		expect(ok('udl 4 kN/m from 1 m to end up').loads[0]).toMatchObject({ from: '1 m', to: 'end', direction: 'up' });
		expect(ok('udl 4 from start to mid').loads[0]).toMatchObject({ from: 'start', to: 'mid' });
	});

	it('requires from and to together', () => {
		expect(errorOf('udl 4 from 0')).toBe('Expected "to" followed by the end position, for example: from 0 to 6 m');
		expect(errorOf('udl 4 to 6')).toBe('Expected "from" before "to", for example: from 0 to 6 m');
	});

	it('rejects "at" on a distributed load', () => {
		expect(errorOf('udl 4 at 2')).toContain('uses "from" and "to" instead of "at"');
	});

	it('reads linear loads', () => {
		expect(ok('linear 0 to 6 kN/m down from 0 to 3 m').loads[0]).toEqual({
			kind: 'linear',
			start: '0',
			end: '6 kN/m',
			direction: 'down',
			from: '0',
			to: '3 m',
			line: 1,
		});
		expect(ok('linear 2 kN/m to 4 kN/m up').loads[0]).toMatchObject({ start: '2 kN/m', end: '4 kN/m', direction: 'up' });
	});

	it('reports missing linear values', () => {
		expect(errorOf('linear 6 kN/m')).toBe('Expected "to" and the end value, for example: linear 0 to 6 kN/m');
		expect(errorOf('linear to 6')).toContain('Expected a number for the start value');
		expect(errorOf('linear 0 to')).toContain('Expected a number for the end value');
		expect(errorOf('udl from 0 to 6')).toBe('Expected a number for the magnitude');
	});
});

describe('supports and hinges', () => {
	it('reports a missing at', () => {
		expect(errorOf('pin 0')).toBe('Expected "at" followed by a position');
		expect(errorOf('hinge 4')).toBe('Expected "at" followed by a position');
		expect(errorOf('roller')).toBe('Expected "at" followed by a position');
	});

	it('requires a support type after "support"', () => {
		expect(errorOf('support at 0')).toBe('Expected a support type after "support": pin, roller or fixed');
		expect(errorOf('support')).toBe('Expected a support type after "support": pin, roller or fixed');
	});

	it('rejects leftovers', () => {
		expect(errorOf('pin at 0 foo')).toBe('Unexpected "foo" at the end of the line');
		expect(errorOf('hinge at 4 5')).toBe('Unexpected "5" at the end of the line');
	});

	it('allows several supports and hinges', () => {
		const ast = ok('pin at 0\nroller at 6\nroller at 12\nhinge at 3\nhinge at 9');
		expect(ast.supports).toHaveLength(3);
		expect(ast.hinges).toHaveLength(2);
	});
});

describe('title, units and material', () => {
	it('reads the title as free text', () => {
		expect(ok('title Beam 2,5 m: test @ home').title).toBe('Beam 2,5 m: test @ home');
		expect(errorOf('title')).toBe('Add the title text, for example: title Simply supported beam');
	});

	it.each([
		['kN m', 'kN-m'],
		['kN-m', 'kN-m'],
		['SI', 'kN-m'],
		['N mm', 'N-mm'],
		['kip-ft', 'kip-ft'],
		['kips ft', 'kip-ft'],
		['US', 'kip-ft'],
		['imperial', 'kip-ft'],
		['lb in', 'lb-in'],
		['lbf-in', 'lb-in'],
	])('reads units %s', (text, id) => {
		const ast = ok(`units ${text}`);
		expect(ast.units).toBe(id);
		expect(ast.lines.units).toBe(1);
	});

	it('rejects unknown unit systems', () => {
		expect(errorOf('units furlongs')).toBe('Unknown unit system "furlongs": use kN m, N mm, kip ft or lb in');
		expect(errorOf('units')).toBe('Add a unit system, for example: units kN m');
	});

	it('keeps the material name as typed (validated later)', () => {
		expect(ok('material Aluminum').material).toBe('Aluminum');
		expect(ok('material stainless steel').material).toBe('stainless steel');
		expect(ok('material unobtainium').material).toBe('unobtainium');
		expect(errorOf('material')).toBe('Add a material name, for example: material steel');
	});

	it('reads E and I raw', () => {
		const ast = ok('E 29000 ksi\nI 510 in^4');
		expect(ast.E).toBe('29000 ksi');
		expect(ast.I).toBe('510 in^4');
		expect(ok('E 200').E).toBe('200');
		expect(ok('I 8000cm⁴').I).toBe('8000cm⁴');
		expect(errorOf('E steel')).toBe('Expected a number for E, for example: E 200 GPa');
		expect(errorOf('I')).toBe('Expected a number for I, for example: I 8000 cm^4');
		expect(errorOf('length')).toBe('Expected a number for the length, for example: length 6 m');
		expect(errorOf('E 200 GPa 3')).toBe('Unexpected "3" at the end of the line');
		expect(errorOf('I 1 cm^3')).toBe('Unknown unit "cm^3": use cm^4, mm^4, in^4 or m^4');
	});
});

describe('sections', () => {
	it.each([
		['section rect 100 x 200 mm', 'rect', ['100', '200'], 'mm'],
		['section rectangle 100x200mm', 'rect', ['100', '200'], 'mm'],
		['section rect 100 X 200', 'rect', ['100', '200'], undefined],
		['section rect 100 × 200 cm', 'rect', ['100', '200'], 'cm'],
		['section rect 100*200 in', 'rect', ['100', '200'], 'in'],
		['section circle 100 mm', 'circle', ['100'], 'mm'],
		['section round 4', 'circle', ['4'], undefined],
		['section solid-circle 4', 'circle', ['4'], undefined],
		['section tube 60 x 5 mm', 'tube', ['60', '5'], 'mm'],
		['section pipe 60 x 5', 'tube', ['60', '5'], undefined],
		['section chs 60 x 5', 'tube', ['60', '5'], undefined],
		['section box 100 x 200 x 10 mm', 'box', ['100', '200', '10'], 'mm'],
		['section rhs 100 x 200 x 10', 'box', ['100', '200', '10'], undefined],
		['section shs 100 x 100 x 10', 'box', ['100', '100', '10'], undefined],
		['section ibeam 150 x 300 x 7.1 x 10.7 mm', 'ibeam', ['150', '300', '7.1', '10.7'], 'mm'],
		['section i 150 x 300 x 7.1 x 10.7', 'ibeam', ['150', '300', '7.1', '10.7'], undefined],
		['section H 150 x 300 x 7.1 x 10.7', 'ibeam', ['150', '300', '7.1', '10.7'], undefined],
		['section wide-flange 8 x 12 x 0.25 x 0.4 in', 'ibeam', ['8', '12', '0.25', '0.4'], 'in'],
	])('%s', (source, shape, dims, unit) => {
		const section = ok(source).section;
		expect(section).toEqual(unit === undefined ? { shape, dims, line: 1 } : { shape, dims, unit, line: 1 });
	});

	it('keeps per-dimension units on each dimension', () => {
		expect(ok('section rect 100 mm x 20 cm').section).toEqual({ shape: 'rect', dims: ['100 mm', '20 cm'], line: 1 });
		expect(ok('section rect 100mmx200mm').section).toEqual({ shape: 'rect', dims: ['100mm', '200mm'], line: 1 });
		expect(ok('section rect 100 mm x 200').section).toEqual({ shape: 'rect', dims: ['100 mm', '200'], line: 1 });
	});

	it('reports wrong dimension counts with an example', () => {
		expect(errorOf('section rect 100 mm')).toBe('Rectangle needs 2 dimensions (b x h), for example: section rect 100 x 200 mm');
		expect(errorOf('section ibeam 1 x 2 x 3')).toContain('needs 4 dimensions');
	});

	it('reports unknown shapes with a suggestion when close', () => {
		expect(errorOf('section rectt 1 x 2')).toBe('Unknown section shape "rectt". Did you mean "rect"?');
		expect(errorOf('section hexagon 1')).toBe('Unknown section shape "hexagon": use rect, circle, tube, box or ibeam');
		expect(errorOf('section')).toBe('Expected a section shape, for example: section rect 100 x 200 mm');
	});

	it('reports malformed dimension lists', () => {
		expect(errorOf('section rect')).toBe('Expected the section dimensions, for example: section rect 100 x 200 mm');
		expect(errorOf('section rect 100 x')).toBe('Expected a number after "x", for example: section rect 100 x 200 mm');
		expect(errorOf('section rect 100 200')).toBe('Separate the dimensions with x, for example: section rect 100 x 200 mm');
		expect(errorOf('section rect 100 x 200 millimetres')).toContain('Unknown unit "millimetres"');
		expect(errorOf('section rect 100 x 200 mm foo')).toContain('Unexpected "foo"');
	});
});

describe('duplicate single-valued statements', () => {
	it.each([
		['title A', 'title B', 'title'],
		['units kN m', 'units N mm', 'units'],
		['length 6', 'span 7', 'length'],
		['material steel', 'material timber', 'material'],
		['E 200 GPa', 'E 210 GPa', 'E'],
		['I 1 cm^4', 'I 2 cm^4', 'I'],
		['section rect 1 x 2', 'section circle 3', 'section'],
	])('reports %s defined twice', (first, second, name) => {
		const d = diags(`${first}\npin at 0\n\n${second}`);
		expect(d).toEqual([{ severity: 'error', message: `${name} is defined twice (lines 1 and 4)`, line: 4 }]);
	});

	it('keeps the first definition', () => {
		const { ast } = parseBeamSource('length 6\nlength 7');
		expect(ast.length).toBe('6');
		expect(ast.lines.length).toBe(1);
	});
});

describe('unknown statements', () => {
	it.each([
		['suport at 0', 'support'],
		['lenght 6', 'length'],
		['rolller at 6', 'roller'],
		['momnet 5 cw at 1', 'moment'],
		['materail steel', 'material'],
		['secton rect 1 x 2', 'section'],
		['hinje at 2', 'hinge'],
		['udk 4', 'udl'],
	])('%s suggests %s', (source, suggestion) => {
		const word = source.split(' ')[0] ?? '';
		expect(errorOf(source)).toBe(`Unknown statement "${word}". Did you mean "${suggestion}"?`);
	});

	it('lists keywords when nothing is close', () => {
		expect(errorOf('foo bar')).toBe(
			'Unknown statement "foo". Start the line with a keyword such as length, pin, roller, fixed, point, udl or moment',
		);
	});

	it('requires a keyword at the start of a line', () => {
		expect(errorOf('6 m')).toBe('Expected a statement keyword at the start of the line, for example: length 6 m');
		expect(errorOf(': length 6')).toContain('Expected a statement keyword');
		expect(errorOf('2,5')).toContain('use a dot as the decimal separator');
	});
});

describe('diagnostics', () => {
	it('reports every bad line with its line number and keeps the good ones', () => {
		const { ast, diagnostics } = parseBeamSource('length 6\npin 0\nroller at 6\npoint at 2\n# comment\nmoment 5 at 3');
		expect(diagnostics.map((d) => d.line)).toEqual([2, 4, 6]);
		expect(diagnostics.every((d) => d.severity === 'error')).toBe(true);
		expect(ast.supports).toEqual([{ kind: 'roller', at: '6', line: 3 }]);
		expect(ast.loads).toEqual([]);
		expect(ast.length).toBe('6');
	});

	it('never throws on arbitrary input', () => {
		// Deterministic pseudo-random strings over a hostile alphabet.
		const alphabet = 'ab xX×*@:#/,.-+0123456789eEkNmcw^⁴²😀\t\n=;';
		let seed = 12345;
		const rand = (): number => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		const words = ['point', 'udl', 'linear', 'section', 'rect', 'at', 'from', 'to', 'pin', 'moment', 'cw', 'kN', 'm', 'x'];
		for (let n = 0; n < 500; n++) {
			let text = '';
			const len = Math.floor(rand() * 40);
			for (let i = 0; i < len; i++) {
				text += rand() < 0.3 ? ` ${words[Math.floor(rand() * words.length)] ?? ''} ` : alphabet[Math.floor(rand() * alphabet.length)] ?? '';
			}
			expect(() => parseBeamSource(text)).not.toThrow();
		}
	});
});
