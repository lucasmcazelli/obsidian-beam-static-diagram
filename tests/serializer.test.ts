import { describe, expect, it } from 'vitest';
import type { AstLoad, AstSection, BeamAst, ForceDirection, UnitSystemId } from '../src/core/types';
import { serializeBeamAst } from '../src/core/serializer';
import { emptyAst, parseBeamSource } from '../src/core/parser';
import { BEAM_EXAMPLES, DEFAULT_BEAM_SOURCE } from '../src/core/examples';

/** Removes line numbers and the comment count, which a round trip does not preserve. */
function normalize(ast: BeamAst): unknown {
	const strip = <T extends { line?: number }>(item: T): Omit<T, 'line'> => {
		const copy: T = { ...item };
		delete copy.line;
		return copy;
	};
	return {
		...ast,
		supports: ast.supports.map(strip),
		hinges: ast.hinges.map(strip),
		loads: ast.loads.map(strip),
		section: ast.section ? strip(ast.section) : undefined,
		lines: {},
		commentCount: 0,
	};
}

/** Serializes, parses again (asserting no errors) and compares. */
function expectRoundTrip(ast: BeamAst): void {
	const text = serializeBeamAst(ast);
	const { ast: again, diagnostics } = parseBeamSource(text);
	expect(diagnostics, text).toEqual([]);
	expect(normalize(again), text).toEqual(normalize(ast));
}

describe('serializeBeamAst', () => {
	it('writes statements in canonical order with explicit directions', () => {
		const ast: BeamAst = {
			...emptyAst(),
			title: 'Demo',
			units: 'kip-ft',
			length: '30 ft',
			supports: [
				{ kind: 'pin', at: '0' },
				{ kind: 'roller', at: '20 ft' },
			],
			hinges: [{ at: '10' }],
			loads: [
				{ kind: 'udl', magnitude: '1.2 kip/ft', direction: 'down', from: '0', to: '20 ft' },
				{ kind: 'point', magnitude: '5 kip', direction: 'up', at: 'end' },
				{ kind: 'moment', magnitude: '3 kip·ft', direction: 'cw', at: '5' },
				{ kind: 'linear', start: '0', end: '2', direction: 'down' },
			],
			material: 'steel',
			E: '29000 ksi',
			I: '510 in^4',
			section: { shape: 'ibeam', dims: ['6', '12', '0.25', '0.4'], unit: 'in' },
		};
		expect(serializeBeamAst(ast)).toBe(
			[
				'title Demo',
				'units kip ft',
				'length 30 ft',
				'pin at 0',
				'roller at 20 ft',
				'hinge at 10',
				'udl 1.2 kip/ft down from 0 to 20 ft',
				'point 5 kip up at end',
				'moment 3 kip·ft cw at 5',
				'linear 0 to 2 down',
				'material steel',
				'E 29000 ksi',
				'I 510 in^4',
				'section ibeam 6 x 12 x 0.25 x 0.4 in',
			].join('\n'),
		);
	});

	it('returns an empty string for an empty AST and never ends with a newline', () => {
		expect(serializeBeamAst(emptyAst())).toBe('');
		expect(serializeBeamAst({ ...emptyAst(), length: '6' })).toBe('length 6');
	});

	it.each<[UnitSystemId, string]>([
		['kN-m', 'units kN m'],
		['N-mm', 'units N mm'],
		['kip-ft', 'units kip ft'],
		['lb-in', 'units lb in'],
	])('writes units %s as the keyword', (units, line) => {
		expect(serializeBeamAst({ ...emptyAst(), units })).toBe(line);
	});

	it('omits units, title and stiffness lines that are not set', () => {
		const text = serializeBeamAst({ ...emptyAst(), length: '6', supports: [{ kind: 'fixed', at: 'start' }] });
		expect(text).toBe('length 6\nfixed at start');
	});

	it('omits an empty title', () => {
		expect(serializeBeamAst({ ...emptyAst(), title: '   ' })).toBe('');
	});

	it('writes sections with a shared unit, per-dimension units or no unit', () => {
		const section = (s: AstSection): string => serializeBeamAst({ ...emptyAst(), section: s });
		expect(section({ shape: 'rect', dims: ['100', '200'], unit: 'mm' })).toBe('section rect 100 x 200 mm');
		expect(section({ shape: 'rect', dims: ['100 mm', '20 cm'] })).toBe('section rect 100 mm x 20 cm');
		expect(section({ shape: 'circle', dims: ['4'] })).toBe('section circle 4');
	});

	it('trims raw strings without changing them', () => {
		const text = serializeBeamAst({
			...emptyAst(),
			title: '  My beam  ',
			length: ' 6 m ',
			supports: [{ kind: 'pin', at: ' 0 ' }],
			loads: [{ kind: 'point', magnitude: ' 10kN ', direction: 'down', at: ' 2 m ' }],
		});
		expect(text).toBe('title My beam\nlength 6 m\npin at 0\npoint 10kN down at 2 m');
	});

	it('writes each end of a half-specified extent so the problem stays visible', () => {
		const text = serializeBeamAst({ ...emptyAst(), loads: [{ kind: 'udl', magnitude: '1', direction: 'up', from: '2' }] });
		expect(text).toBe('udl 1 up from 2');
	});

	it('drops comments', () => {
		const { ast } = parseBeamSource('# heading\nlength 6 # trailing\npin at 0');
		expect(serializeBeamAst(ast)).toBe('length 6\npin at 0');
	});
});

describe('round trip: parse(serialize(ast)) equals ast', () => {
	it.each(BEAM_EXAMPLES.map((e) => [e.id, e.source]))('example %s', (_id, source) => {
		expectRoundTrip(parseBeamSource(source).ast);
	});

	it('default block', () => {
		expectRoundTrip(parseBeamSource(DEFAULT_BEAM_SOURCE).ast);
	});

	it('hand-written variety', () => {
		const asts: BeamAst[] = [
			emptyAst(),
			{ ...emptyAst(), title: 'Beam 2,5: test @ home (v2)' },
			{ ...emptyAst(), units: 'lb-in', length: '120', supports: [{ kind: 'fixed', at: 'left' }] },
			{
				...emptyAst(),
				length: '6000 mm',
				supports: [
					{ kind: 'pin', at: 'start' },
					{ kind: 'roller', at: 'End' },
				],
				hinges: [{ at: 'mid' }, { at: '1.5' }],
				loads: [
					{ kind: 'point', magnitude: '-2.5e3 N', direction: 'down', at: '.5 m' },
					{ kind: 'moment', magnitude: '5 kN m', direction: 'ccw', at: 'centre' },
					{ kind: 'moment', magnitude: '1kNm', direction: 'cw', at: '2m' },
					{ kind: 'udl', magnitude: '4 kN/m', direction: 'up' },
					{ kind: 'udl', magnitude: '1', direction: 'down', from: 'start', to: 'mid' },
					{ kind: 'linear', start: '0', end: '6 kN/m', direction: 'down', from: '0', to: '3 m' },
				],
				material: 'stainless steel',
				E: '193 GPa',
				I: '8000 cm⁴',
				section: { shape: 'box', dims: ['100 mm', '20 cm', '10 mm'] },
			},
			{ ...emptyAst(), section: { shape: 'circle', dims: ['100'], unit: 'mm' } },
			{ ...emptyAst(), section: { shape: 'tube', dims: ['60', '5'] } },
		];
		for (const ast of asts) expectRoundTrip(ast);
	});

	it('randomly generated ASTs', () => {
		// Deterministic linear congruential generator so failures are reproducible.
		let seed = 2024;
		const rand = (): number => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
		const maybe = <T>(value: T): T | undefined => (rand() < 0.5 ? value : undefined);

		const quantities = ['10', '10 kN', '10kN', '-2.5e3 N', '.5 kip', '5 kN·m', '3 kip-ft', '4 kN/m', '0', '1e3', '+7 lb'];
		const positions = ['0', '2 m', '1500 mm', 'end', 'start', 'mid', '3.5', 'Right', '12 ft', '.25'];
		const directions: ForceDirection[] = ['down', 'up'];
		const units: Array<UnitSystemId | undefined> = [undefined, 'kN-m', 'N-mm', 'kip-ft', 'lb-in'];
		const sections: AstSection[] = [
			{ shape: 'rect', dims: ['100', '200'], unit: 'mm' },
			{ shape: 'rect', dims: ['4', '8'] },
			{ shape: 'ibeam', dims: ['150', '300', '7.1', '10.7'], unit: 'mm' },
			{ shape: 'box', dims: ['10 cm', '20 cm', '1 cm'] },
		];

		const randomLoad = (): AstLoad => {
			switch (pick(['point', 'moment', 'udl', 'linear'] as const)) {
				case 'point':
					return { kind: 'point', magnitude: pick(quantities), direction: pick(directions), at: pick(positions) };
				case 'moment':
					return { kind: 'moment', magnitude: pick(quantities), direction: pick(['cw', 'ccw'] as const), at: pick(positions) };
				case 'udl': {
					const withExtent = rand() < 0.5;
					return {
						kind: 'udl',
						magnitude: pick(quantities),
						direction: pick(directions),
						...(withExtent ? { from: pick(positions), to: pick(positions) } : {}),
					};
				}
				case 'linear': {
					const withExtent = rand() < 0.5;
					return {
						kind: 'linear',
						start: pick(quantities),
						end: pick(quantities),
						direction: pick(directions),
						...(withExtent ? { from: pick(positions), to: pick(positions) } : {}),
					};
				}
			}
		};

		for (let n = 0; n < 300; n++) {
			const ast: BeamAst = {
				...emptyAst(),
				title: maybe(pick(['A', 'Beam one', 'Test: 2,5 kN @ mid'])),
				units: pick(units),
				length: maybe(pick(quantities)),
				supports: Array.from({ length: Math.floor(rand() * 4) }, () => ({
					kind: pick(['pin', 'roller', 'fixed'] as const),
					at: pick(positions),
				})),
				hinges: Array.from({ length: Math.floor(rand() * 3) }, () => ({ at: pick(positions) })),
				loads: Array.from({ length: Math.floor(rand() * 5) }, randomLoad),
				material: maybe(pick(['steel', 'wood', 'stainless steel', 'Aluminum'])),
				E: maybe(pick(quantities)),
				I: maybe(pick(['8000 cm^4', '510 in4', '1 m⁴'])),
				section: maybe(pick(sections)),
			};
			// Optional fields must be absent rather than undefined for toEqual to match parse output.
			for (const key of ['title', 'units', 'length', 'material', 'E', 'I', 'section'] as const) {
				if (ast[key] === undefined) delete ast[key];
			}
			expectRoundTrip(ast);
		}
	});
});
