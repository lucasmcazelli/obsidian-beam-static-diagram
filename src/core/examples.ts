/**
 * Ready-made example blocks (editor templates, README, tests).
 *
 * Every example parses and builds without errors or warnings (checked by
 * tests/examples.test.ts), and its comments explain the syntax it uses, so a
 * new user can learn the language by inserting one and editing it.
 */

/** One example block. */
export interface BeamExample {
	id: string;
	/** Sentence-case name shown in the editor, e.g. "Simply supported beam". */
	name: string;
	/** Block text without fences. */
	source: string;
}

/** Joins lines with "\n" (block text never ends with a newline). */
function block(...lines: string[]): string {
	return lines.join('\n');
}

/** All examples, from the simplest to the most advanced. */
export const BEAM_EXAMPLES: BeamExample[] = [
	{
		// Expected: R_A = 18.67 kN, R_B = 15.33 kN, Mmax = 29.39 kN·m at x = 2.17 m.
		id: 'simply-supported',
		name: 'Simply supported beam',
		source: block(
			'title Simply supported beam',
			'# Bare numbers use the default units (kN and m unless changed)',
			'length 6 m',
			'pin at 0',
			'roller at end',
			'# Point loads point down unless you write "up"',
			'point 10 kN down at 2 m',
			'udl 4 kN/m down from 0 to 6 m',
			'# Material and section turn on the deflection diagram',
			'material steel',
			'section ibeam 150 x 300 x 7.1 x 10.7 mm',
		),
	},
	{
		id: 'cantilever',
		name: 'Cantilever with triangular load',
		source: block(
			'title Cantilever with triangular load',
			'length 3 m',
			'# A cantilever has one fixed support and a free end',
			'fixed at start',
			'# A linear load goes from its start value to its end value',
			'linear 0 to 6 kN/m down from 0 to 3 m',
			'# Moments need a direction: cw (clockwise) or ccw (counter-clockwise)',
			'moment 5 kNm ccw at end',
			'material steel',
			'section rect 100 x 200 mm',
		),
	},
	{
		id: 'overhang',
		name: 'Overhanging beam (US units)',
		source: block(
			'title Overhanging beam (US units)',
			'# US customary units: kip and ft, sections in in',
			'units kip ft',
			'length 30 ft',
			'pin at 0',
			'roller at 20 ft',
			'udl 1.2 kip/ft down from 0 to 20 ft',
			'point 5 kip down at end',
			'# E and I can be given directly instead of a material and a section',
			'E 29000 ksi',
			'I 510 in^4',
		),
	},
	{
		id: 'propped',
		name: 'Propped cantilever',
		source: block(
			'title Propped cantilever',
			'# One redundant support: the solver handles indeterminate beams',
			'length 6 m',
			'fixed at 0',
			'roller at 6',
			'# Without "from" and "to" a uniform load covers the whole beam',
			'udl 5 kN/m down',
		),
	},
	{
		id: 'continuous',
		name: 'Two-span continuous beam',
		source: block(
			'title Two-span continuous beam',
			'length 12 m',
			'pin at 0',
			'# Add as many supports as you need',
			'roller at 6',
			'roller at 12',
			'udl 5 kN/m down',
		),
	},
	{
		id: 'gerber',
		name: 'Beam with an internal hinge',
		source: block(
			'title Beam with an internal hinge',
			'length 10 m',
			'fixed at 0',
			'# A hinge releases the bending moment: M = 0 there',
			'hinge at 4',
			'roller at 10',
			'point 8 kN down at 2',
			'udl 3 kN/m down from 4 to 10',
		),
	},
	{
		id: 'fixed-fixed',
		name: 'Fixed-fixed beam',
		source: block(
			'title Fixed-fixed beam',
			'length 6 m',
			'# Both ends clamped: end moments appear at the supports',
			'fixed at start',
			'fixed at end',
			'point 10 kN down at 2',
			'# Timber C24 with a 100 x 250 mm rectangle',
			'material timber',
			'section rect 100 x 250 mm',
		),
	},
];

/** Text inserted by the "Insert beam" command. */
export const DEFAULT_BEAM_SOURCE: string = block(
	'title My beam',
	'# One statement per line; lines starting with # are comments',
	'length 6 m',
	'pin at 0',
	'roller at end',
	'point 10 kN down at 2 m',
	'udl 4 kN/m down',
	'# Material and section enable the deflection diagram',
	'material steel',
	'section rect 100 x 200 mm',
);
