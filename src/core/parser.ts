/**
 * Parser for the `beam` code block language (syntax only, no units).
 *
 * The language has one statement per line, for example:
 *
 *   length 6 m
 *   pin at 0
 *   roller at end
 *   point 10 kN down at 2 m
 *   udl 4 kN/m down from 0 to 6 m
 *
 * The parser only checks syntax. Numbers and units are kept as the raw text
 * the user typed (`RawQuantity`, `RawPosition`) and resolved later by
 * `buildModel`, which knows the unit system and the beam length. Every problem
 * is returned as a diagnostic with its line number; nothing here throws to the
 * caller. Each line reports at most one error (the first one found), because
 * follow-up errors on the same line are usually noise.
 */
import type {
	AstLoad,
	AstSection,
	BeamAst,
	Diagnostic,
	Dimension,
	ForceDirection,
	MomentDirection,
	SupportKind,
} from './types';
import { dimensionCountMessage, findSectionShape, SECTION_SHAPE_ALIASES, SECTION_SHAPES } from './sections';
import { ownValue } from './lookup';
import { isUnitSymbol, lookupUnit, parseUnitSystem, UNIT_HINTS } from './units';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Token kinds:
 * - number: "10", "-2.5e3", ".5"
 * - word:   keywords, units and names: "point", "kN/m", "kN·m", "cm^4", "counter-clockwise"
 * - sep:    dimension separators in sections: "x", "X", "×", "*"
 * - symbol: any other single character, e.g. ":", "@", ","
 */
export type TokenKind = 'number' | 'word' | 'sep' | 'symbol';

/** One token of a line, with its character range in the line. */
export interface Token {
	kind: TokenKind;
	text: string;
	/** Index of the first character in the line. */
	start: number;
	/** Index just past the last character. */
	end: number;
}

/** Tokens of one line. `error` is set when a character sequence cannot be read; tokens stop there. */
export interface TokenizeResult {
	tokens: Token[];
	error?: { message: string; start: number };
}

const LETTER = /^\p{L}$/u;
const WHITESPACE = /^\s$/;
/** Superscript digits used in units such as cm⁴ and N/mm². */
const SUPERSCRIPTS = '²³⁴';
/** Characters that may join two parts of a unit: kN/m, kN·m, kN*m, kN-m, kN.m. */
const CONNECTORS = '/·⋅*-.';
/** Signs accepted in front of a number, including the Unicode minus U+2212. */
const SIGNS = '+-\u2212';

function isDigit(ch: string | undefined): boolean {
	return ch !== undefined && ch >= '0' && ch <= '9';
}

function isLetter(ch: string | undefined): boolean {
	return ch !== undefined && LETTER.test(ch);
}

function isSuperscript(ch: string | undefined): boolean {
	return ch !== undefined && SUPERSCRIPTS.includes(ch);
}

/** True when a number starts at `i`: a digit, ".5", or a sign followed by either. */
function numberStartsAt(text: string, i: number): boolean {
	const ch = text[i];
	if (isDigit(ch)) return true;
	if (ch === '.') return isDigit(text[i + 1]);
	if (ch !== undefined && SIGNS.includes(ch)) {
		const next = text[i + 1];
		return isDigit(next) || (next === '.' && isDigit(text[i + 2]));
	}
	return false;
}

/** Returns the end index of the number starting at `i` (sign, digits, fraction, exponent). */
function scanNumber(text: string, i: number): number {
	let j = i;
	if (SIGNS.includes(text[j] ?? '')) j++;
	while (isDigit(text[j])) j++;
	if (text[j] === '.') {
		j++;
		while (isDigit(text[j])) j++;
	}
	// An exponent needs at least one digit, so "10em" stays "10" followed by "em".
	if (text[j] === 'e' || text[j] === 'E') {
		let k = j + 1;
		if (text[k] === '+' || text[k] === '-') k++;
		if (isDigit(text[k])) {
			while (isDigit(text[k])) k++;
			j = k;
		}
	}
	return j;
}

/** True when `x` at `i` separates two dimensions, as in "100x200" or "100mmx.5" (x followed by a number). */
function isGluedSeparator(text: string, i: number): boolean {
	const ch = text[i];
	if (ch !== 'x' && ch !== 'X') return false;
	const next = text[i + 1];
	return isDigit(next) || (next === '.' && isDigit(text[i + 2]));
}

/** Returns the end index of the word starting at `i` (which is a letter). */
function scanWord(text: string, i: number): number {
	let j = i + 1;
	while (j < text.length) {
		const ch = text[j];
		const next = text[j + 1];
		// "mmx200": stop before a separator so "100mmx200mm" reads as two dimensions.
		if (isGluedSeparator(text, j)) break;
		if (isLetter(ch) || isDigit(ch) || ch === '_' || isSuperscript(ch)) {
			j++;
		} else if (ch === '^' && (isDigit(next) || isSuperscript(next))) {
			j++;
		} else if (ch !== undefined && CONNECTORS.includes(ch) && isLetter(next)) {
			// A connector only joins letters, so "m." at the end of a sentence stays "m".
			j++;
		} else {
			break;
		}
	}
	return j;
}

/**
 * Splits one line (comments already removed) into tokens. A number is
 * followed by its unit as a separate token whether or not they are glued
 * ("10kN" and "10 kN" give the same two tokens). A decimal comma ("2,5")
 * stops tokenizing with an error, because reading it as 2 or 25 would be
 * silently wrong.
 */
export function tokenizeLine(text: string): TokenizeResult {
	const tokens: Token[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i] ?? '';
		if (WHITESPACE.test(ch)) {
			i++;
			continue;
		}
		if (numberStartsAt(text, i)) {
			const end = scanNumber(text, i);
			if (text[end] === ',' && isDigit(text[end + 1])) {
				let k = end + 1;
				while (isDigit(text[k])) k++;
				return {
					tokens,
					error: { message: `Invalid number "${text.slice(i, k)}": use a dot as the decimal separator`, start: i },
				};
			}
			tokens.push({ kind: 'number', text: text.slice(i, end), start: i, end });
			i = end;
			continue;
		}
		if (ch === '×' || ch === '*' || isGluedSeparator(text, i)) {
			tokens.push({ kind: 'sep', text: ch, start: i, end: i + 1 });
			i++;
			continue;
		}
		if (isLetter(ch)) {
			const end = scanWord(text, i);
			const word = text.slice(i, end);
			// A lone "x" is the dimension separator in "100 x 200".
			tokens.push({ kind: word === 'x' || word === 'X' ? 'sep' : 'word', text: word, start: i, end });
			i = end;
			continue;
		}
		// Anything else is a one-character symbol. Read a whole code point so
		// characters outside the BMP (emoji) are reported intact.
		const symbol = String.fromCodePoint(text.codePointAt(i) ?? 0);
		tokens.push({ kind: 'symbol', text: symbol, start: i, end: i + symbol.length });
		i += symbol.length;
	}
	return { tokens };
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/**
 * Optimal string alignment distance (Levenshtein plus adjacent transposition),
 * so "lenght" is one edit away from "length".
 */
export function editDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const d: number[][] = [];
	for (let i = 0; i < rows; i++) {
		const row: number[] = [];
		for (let j = 0; j < cols; j++) row.push(i === 0 ? j : j === 0 ? i : 0);
		d.push(row);
	}
	const at = (i: number, j: number): number => d[i]?.[j] ?? 0;
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				best = Math.min(best, at(i - 2, j - 2) + 1);
			}
			const row = d[i];
			if (row) row[j] = best;
		}
	}
	return at(a.length, b.length);
}

/**
 * Closest candidate to `word` (case-insensitive), or undefined when nothing is
 * close. Short words allow only one edit, otherwise "foo" would match "fix".
 */
export function suggest(word: string, candidates: readonly string[], maxDistance?: number): string | undefined {
	const w = word.toLowerCase();
	const limit = maxDistance ?? (w.length <= 3 ? 1 : 2);
	let best: string | undefined;
	let bestDistance = Infinity;
	for (const candidate of candidates) {
		const distance = editDistance(w, candidate.toLowerCase());
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return bestDistance <= limit ? best : undefined;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Statement types; every keyword and alias maps onto one of these. */
export type StatementType =
	| 'title'
	| 'units'
	| 'length'
	| 'support'
	| 'pin'
	| 'roller'
	| 'fixed'
	| 'hinge'
	| 'point'
	| 'moment'
	| 'udl'
	| 'linear'
	| 'material'
	| 'E'
	| 'I'
	| 'section';

/** First word of a line (lower case) to statement type. Canonical names come first (used for suggestions). */
const KEYWORDS: Record<string, StatementType> = {
	title: 'title',
	units: 'units',
	length: 'length',
	support: 'support',
	pin: 'pin',
	roller: 'roller',
	fixed: 'fixed',
	hinge: 'hinge',
	point: 'point',
	moment: 'moment',
	udl: 'udl',
	linear: 'linear',
	material: 'material',
	section: 'section',
	e: 'E',
	i: 'I',
	// Aliases
	unit: 'units',
	span: 'length',
	l: 'length',
	pinned: 'pin',
	clamped: 'fixed',
	fix: 'fixed',
	force: 'point',
	load: 'point',
	couple: 'moment',
	uniform: 'udl',
	distributed: 'udl',
	trapezoid: 'linear',
	triangle: 'linear',
	varying: 'linear',
};

/** Keywords offered as "Did you mean" suggestions (single letters would match almost anything). */
const SUGGESTABLE_KEYWORDS = Object.keys(KEYWORDS).filter((k) => k.length >= 3);

const SUPPORT_KINDS: Record<string, SupportKind> = {
	pin: 'pin',
	pinned: 'pin',
	roller: 'roller',
	fixed: 'fixed',
	clamped: 'fixed',
	fix: 'fixed',
};

/** Statements that may appear once; the value is the name used in messages. */
type SingleName = 'title' | 'units' | 'length' | 'material' | 'E' | 'I' | 'section';
const SINGLE: Partial<Record<StatementType, SingleName>> = {
	title: 'title',
	units: 'units',
	length: 'length',
	material: 'material',
	E: 'E',
	I: 'I',
	section: 'section',
};

const FORCE_DIRECTIONS: Record<string, ForceDirection> = {
	down: 'down',
	downward: 'down',
	downwards: 'down',
	up: 'up',
	upward: 'up',
	upwards: 'up',
};

const MOMENT_DIRECTIONS: Record<string, MomentDirection> = {
	cw: 'cw',
	clockwise: 'cw',
	ccw: 'ccw',
	counterclockwise: 'ccw',
	'counter-clockwise': 'ccw',
	anticlockwise: 'ccw',
	'anti-clockwise': 'ccw',
};

const POSITION_KEYWORDS: Record<string, 'start' | 'mid' | 'end'> = {
	start: 'start',
	left: 'start',
	mid: 'mid',
	middle: 'mid',
	center: 'mid',
	centre: 'mid',
	end: 'end',
	right: 'end',
};

/**
 * Resolves a position keyword, case-insensitive: "start"/"left" (x = 0),
 * "mid"/"middle"/"center"/"centre" (x = L/2), "end"/"right" (x = L).
 * Returns undefined for anything else (for example a quantity such as "2 m").
 */
export function positionKeyword(text: string): 'start' | 'mid' | 'end' | undefined {
	return ownValue(POSITION_KEYWORDS, text.trim().toLowerCase());
}

/** Words that may follow a number inside a load statement (used to tell a typo from an unknown unit). */
const CLAUSE_WORDS = ['at', 'from', 'to', ...Object.keys(FORCE_DIRECTIONS), ...Object.keys(MOMENT_DIRECTIONS), ...Object.keys(POSITION_KEYWORDS)];

// ---------------------------------------------------------------------------
// Line parsing helpers
// ---------------------------------------------------------------------------

/** Internal: aborts the current line with a message. Caught in parseBeamSource. */
class LineError extends Error {}

/** Message for a token left over after a complete statement. */
function unexpectedMessage(t: Token): string {
	if (t.text === ',' || t.text === ';') return `Unexpected "${t.text}": write one statement per line`;
	return `Unexpected "${t.text}" at the end of the line`;
}

/** Reads tokens of one line from left to right. */
class Cursor {
	constructor(
		readonly tokens: Token[],
		readonly text: string,
		public pos: number,
	) {}

	peek(): Token | undefined {
		return this.tokens[this.pos];
	}

	next(): void {
		this.pos++;
	}

	atEnd(): boolean {
		return this.pos >= this.tokens.length;
	}

	/** True when the next token is the given word (case-insensitive). */
	isWord(word: string): boolean {
		const t = this.peek();
		return t !== undefined && t.kind === 'word' && t.text.toLowerCase() === word;
	}

	/** Fails when tokens remain. */
	expectEnd(): void {
		const t = this.peek();
		if (t) throw new LineError(unexpectedMessage(t));
	}
}

/** True for "at" or "@". */
function isAt(t: Token): boolean {
	return (t.kind === 'word' && t.text.toLowerCase() === 'at') || (t.kind === 'symbol' && t.text === '@');
}

/** Lower-cased text of a word token, or "" for other tokens. */
function wordOf(t: Token): string {
	return t.kind === 'word' ? t.text.toLowerCase() : '';
}

/** True for words built like a unit: "kN/mm", "cm^4", "kN·m", "m2". */
function looksLikeUnit(word: string): boolean {
	return /[/^·⋅*\d²³⁴]/.test(word);
}

/**
 * Reads a number and its optional unit and returns the raw text, e.g. "10 kN"
 * or "10kN" (whitespace collapsed to one space). The next word is taken as the
 * unit only when it is a known unit symbol, so in "10 kN down" the direction
 * stays a separate token. "5 kN m" (force and length written apart) is joined
 * into one moment unit.
 *
 * A word that is not a unit is reported as an unknown unit when it is glued
 * to the number ("10kNN"), is built like a unit ("kN/mmm"), or sits between
 * the number and the rest of the statement without resembling a statement
 * word ("10 tons at 2"). A plain last word ("pin at 0 foo") is left for the
 * statement to report as unexpected.
 */
function readQuantity(p: Cursor, missingMessage: string, dimension: Dimension): string {
	const t = p.peek();
	if (!t || t.kind !== 'number') throw new LineError(missingMessage);
	p.next();
	let end = t.end;
	const u = p.peek();
	if (u && u.kind === 'word') {
		if (isUnitSymbol(u.text)) {
			p.next();
			end = u.end;
			const u2 = p.peek();
			if (u2 && u2.kind === 'word' && isUnitSymbol(u2.text) && lookupUnit(u.text + u2.text)?.cls === 'moment') {
				p.next();
				end = u2.end;
			}
		} else {
			const glued = u.start === t.end;
			const midStatement = p.tokens[p.pos + 1] !== undefined && suggest(u.text, CLAUSE_WORDS, 1) === undefined;
			if (glued || looksLikeUnit(u.text) || midStatement) {
				throw new LineError(`Unknown unit "${u.text}": use ${UNIT_HINTS[dimension]}`);
			}
		}
	}
	return p.text.slice(t.start, end).replace(/\s+/g, ' ');
}

/** Reads a position after `keyword` ("at", "from" or "to"): a quantity or a position keyword. */
function readPosition(p: Cursor, keyword: string): string {
	const t = p.peek();
	if (t && t.kind === 'word') {
		if (positionKeyword(t.text)) {
			p.next();
			return t.text;
		}
		const close = suggest(t.text, Object.keys(POSITION_KEYWORDS));
		if (close) throw new LineError(`Unknown position "${t.text}". Did you mean "${close}"?`);
	}
	if (t && t.kind === 'number') return readQuantity(p, '', 'length');
	throw new LineError(`Expected a position after "${keyword}", for example: ${keyword} 2 m or ${keyword} end`);
}

/** Consumes "at" or "@", or fails with the standard message. */
function expectAt(p: Cursor): void {
	const t = p.peek();
	if (t && isAt(t)) {
		p.next();
		return;
	}
	throw new LineError('Expected "at" followed by a position');
}

type LoadKind = AstLoad['kind'];

/** Optional parts of a load statement, in any order after the magnitude. */
interface LoadClauses {
	direction?: string;
	at?: string;
	from?: string;
	to?: string;
}

/** Message for a token that fits nowhere in a load statement. */
function unexpectedInLoad(t: Token, kind: LoadKind, clauses: LoadClauses): string {
	const words =
		kind === 'moment'
			? ['at', ...Object.keys(MOMENT_DIRECTIONS)]
			: kind === 'point'
				? ['at', 'down', 'up']
				: ['from', 'to', 'down', 'up'];
	const close = t.kind === 'word' ? suggest(t.text, words) : undefined;
	if (close) return `Unexpected "${t.text}". Did you mean "${close}"?`;
	// A stray token before the position usually means the "at" was forgotten: "point 10 kN 2 m".
	if ((kind === 'point' || kind === 'moment') && clauses.at === undefined) return 'Expected "at" followed by a position';
	if (kind === 'moment' && clauses.direction === undefined) return 'Moment needs a direction: cw or ccw';
	return unexpectedMessage(t);
}

/**
 * Reads the direction, "at <pos>" and "from <pos> to <pos>" clauses of a load,
 * accepted in any order after the magnitude ("point 10 kN at 2 m down" works too).
 * Each clause may appear once. Checks the clauses each load kind requires.
 */
function readLoadClauses(p: Cursor, kind: LoadKind): LoadClauses {
	const out: LoadClauses = {};
	const isMoment = kind === 'moment';
	const isDistributed = kind === 'udl' || kind === 'linear';
	while (!p.atEnd()) {
		const t = p.peek();
		if (!t) break;
		const w = wordOf(t);
		const force = ownValue(FORCE_DIRECTIONS, w);
		const moment = ownValue(MOMENT_DIRECTIONS, w);
		if (force || moment) {
			if (isMoment && force) throw new LineError('Moment needs a direction: cw or ccw');
			if (!isMoment && moment) throw new LineError('Use down or up for the direction of a force or distributed load');
			if (out.direction !== undefined) throw new LineError('The direction is given twice: keep only one');
			out.direction = force ?? moment;
			p.next();
		} else if (isAt(t)) {
			if (isDistributed) {
				throw new LineError('A distributed load uses "from" and "to" instead of "at", for example: from 0 to 6 m');
			}
			if (out.at !== undefined) throw new LineError('The position is given twice: keep only one "at"');
			p.next();
			out.at = readPosition(p, 'at');
		} else if (w === 'from') {
			if (!isDistributed) {
				throw new LineError(
					`A ${isMoment ? 'moment' : 'point load'} acts at one position: use "at", for example: at 2 m`,
				);
			}
			if (out.from !== undefined) throw new LineError('"from" is given twice: keep only one "from ... to ..."');
			p.next();
			out.from = readPosition(p, 'from');
			if (!p.isWord('to')) {
				throw new LineError('Expected "to" followed by the end position, for example: from 0 to 6 m');
			}
			p.next();
			out.to = readPosition(p, 'to');
		} else if (w === 'to' && isDistributed) {
			throw new LineError('Expected "from" before "to", for example: from 0 to 6 m');
		} else {
			throw new LineError(unexpectedInLoad(t, kind, out));
		}
	}
	if (isMoment && out.direction === undefined) throw new LineError('Moment needs a direction: cw or ccw');
	if (!isDistributed && out.at === undefined) throw new LineError('Expected "at" followed by a position');
	return out;
}

/** Parses "section <shape> <dims>" after the keyword. */
function readSection(p: Cursor, line: number): AstSection {
	const t = p.peek();
	if (!t || t.kind !== 'word') {
		throw new LineError('Expected a section shape, for example: section rect 100 x 200 mm');
	}
	const shape = findSectionShape(t.text);
	if (!shape) {
		const close = suggest(t.text, Object.keys(SECTION_SHAPE_ALIASES));
		throw new LineError(
			close
				? `Unknown section shape "${t.text}". Did you mean "${close}"?`
				: `Unknown section shape "${t.text}": use rect, circle, tube, box or ibeam`,
		);
	}
	p.next();
	const example = `section ${shape} ${SECTION_SHAPES[shape].example}`;
	const parts: Array<{ number: string; unit?: string; raw: string }> = [];
	for (;;) {
		const n = p.peek();
		if (!n || n.kind !== 'number') {
			throw new LineError(
				parts.length === 0
					? `Expected the section dimensions, for example: ${example}`
					: `Expected a number after "x", for example: ${example}`,
			);
		}
		p.next();
		let unit: string | undefined;
		let end = n.end;
		const u = p.peek();
		if (u && u.kind === 'word') {
			if (!isUnitSymbol(u.text)) throw new LineError(`Unknown unit "${u.text}": use ${UNIT_HINTS.sectionLength}`);
			unit = u.text;
			end = u.end;
			p.next();
		}
		parts.push({ number: n.text, unit, raw: p.text.slice(n.start, end).replace(/\s+/g, ' ') });
		const s = p.peek();
		if (!s) break;
		if (s.kind === 'sep') {
			p.next();
			continue;
		}
		if (s.kind === 'number') throw new LineError(`Separate the dimensions with x, for example: ${example}`);
		throw new LineError(unexpectedMessage(s));
	}
	if (parts.length !== SECTION_SHAPES[shape].dims.length) throw new LineError(dimensionCountMessage(shape));
	// A unit written only after the last dimension applies to all of them
	// ("100 x 200 mm"); otherwise each dimension keeps its own unit (or none).
	const last = parts[parts.length - 1];
	const unitCount = parts.filter((part) => part.unit !== undefined).length;
	if (unitCount === 1 && last?.unit !== undefined) {
		return { shape, dims: parts.map((part) => part.number), unit: last.unit, line };
	}
	return { shape, dims: parts.map((part) => part.raw), line };
}

/**
 * The statement a line starting with `word` was meant to be: the statement of
 * its keyword or alias (case-insensitive) or, failing that, of the keyword it
 * is a likely typo of, by the same rule as the "Did you mean" message.
 * Undefined when nothing is close. analyzeBeam uses it to recognise what a
 * line that failed to parse was supposed to say.
 */
export function guessStatementType(word: string): StatementType | undefined {
	const lower = word.toLowerCase();
	const exact = ownValue(KEYWORDS, lower);
	if (exact) return exact;
	const close = suggest(lower, SUGGESTABLE_KEYWORDS);
	return close === undefined ? undefined : ownValue(KEYWORDS, close);
}

/** Message for an unknown first word, with a suggestion when one is close. */
function unknownStatementMessage(word: string): string {
	const close = suggest(word, SUGGESTABLE_KEYWORDS);
	if (close) return `Unknown statement "${word}". Did you mean "${close}"?`;
	return `Unknown statement "${word}". Start the line with a keyword such as length, pin, roller, fixed, point, udl or moment`;
}

/** Splits a line into code and comment. "#" or "//" starts a comment that runs to the end of the line. */
function splitComment(line: string): { code: string; hasComment: boolean } {
	const hash = line.indexOf('#');
	const slashes = line.indexOf('//');
	let cut = hash;
	if (slashes >= 0 && (cut < 0 || slashes < cut)) cut = slashes;
	return cut < 0 ? { code: line, hasComment: false } : { code: line.slice(0, cut), hasComment: true };
}

/** Parses one non-empty line into `ast`. Throws LineError on the first problem. */
function parseStatement(code: string, line: number, ast: BeamAst, firstLines: Partial<Record<SingleName, number>>): void {
	const { tokens, error } = tokenizeLine(code);
	const head = tokens[0];
	if (!head || head.kind !== 'word') {
		if (error && (!head || error.start <= head.start)) throw new LineError(error.message);
		throw new LineError('Expected a statement keyword at the start of the line, for example: length 6 m');
	}
	const keyword = head.text.toLowerCase();
	const type = ownValue(KEYWORDS, keyword);
	if (!type) throw new LineError(unknownStatementMessage(head.text));

	const single = SINGLE[type];
	if (single) {
		const first = firstLines[single];
		if (first !== undefined) throw new LineError(`${single} is defined twice (lines ${first} and ${line})`);
		firstLines[single] = line;
	}

	// An optional ":" (or "=") may follow the keyword: "length: 6 m".
	let pos = 1;
	const after = tokens[1];
	if (after && after.kind === 'symbol' && (after.text === ':' || after.text === '=')) pos = 2;

	// Free-text statements read the raw rest of the line, so a title may
	// contain anything (even "2,5") without tripping the tokenizer.
	const restStart = tokens[pos - 1]?.end ?? head.end;
	const rest = code.slice(restStart).trim();
	switch (type) {
		case 'title':
			if (rest === '') throw new LineError('Add the title text, for example: title Simply supported beam');
			ast.title = rest;
			ast.lines.title = line;
			return;
		case 'units': {
			if (rest === '') throw new LineError('Add a unit system, for example: units kN m');
			const id = parseUnitSystem(rest);
			if (!id) throw new LineError(`Unknown unit system "${rest}": use kN m, N mm, kip ft or lb in`);
			ast.units = id;
			ast.lines.units = line;
			return;
		}
		case 'material':
			if (rest === '') throw new LineError('Add a material name, for example: material steel');
			ast.material = rest;
			ast.lines.material = line;
			return;
		default:
			break;
	}

	// Token-based statements: a tokenizer error is the root cause, report it first.
	if (error) throw new LineError(error.message);
	const p = new Cursor(tokens, code, pos);

	switch (type) {
		case 'length':
			ast.length = readQuantity(p, 'Expected a number for the length, for example: length 6 m', 'length');
			p.expectEnd();
			ast.lines.length = line;
			return;
		case 'E':
			ast.E = readQuantity(p, 'Expected a number for E, for example: E 200 GPa', 'modulus');
			p.expectEnd();
			ast.lines.E = line;
			return;
		case 'I':
			ast.I = readQuantity(p, 'Expected a number for I, for example: I 8000 cm^4', 'inertia');
			p.expectEnd();
			ast.lines.I = line;
			return;
		case 'support':
		case 'pin':
		case 'roller':
		case 'fixed': {
			let kind = ownValue(SUPPORT_KINDS, keyword);
			if (type === 'support') {
				const t = p.peek();
				kind = t ? ownValue(SUPPORT_KINDS, wordOf(t)) : undefined;
				if (!kind) throw new LineError('Expected a support type after "support": pin, roller or fixed');
				p.next();
			} else if (p.isWord('support')) {
				// "pin support at 0" reads naturally, so allow it.
				p.next();
			}
			if (!kind) throw new LineError('Expected a support type: pin, roller or fixed');
			expectAt(p);
			const at = readPosition(p, 'at');
			p.expectEnd();
			ast.supports.push({ kind, at, line });
			return;
		}
		case 'hinge': {
			expectAt(p);
			const at = readPosition(p, 'at');
			p.expectEnd();
			ast.hinges.push({ at, line });
			return;
		}
		case 'point': {
			const magnitude = readQuantity(p, 'Expected a number for the magnitude', 'force');
			const c = readLoadClauses(p, 'point');
			ast.loads.push({
				kind: 'point',
				magnitude,
				direction: (c.direction as ForceDirection | undefined) ?? 'down',
				at: c.at ?? '',
				line,
			});
			return;
		}
		case 'moment': {
			const magnitude = readQuantity(p, 'Expected a number for the magnitude', 'moment');
			const c = readLoadClauses(p, 'moment');
			ast.loads.push({
				kind: 'moment',
				magnitude,
				direction: (c.direction as MomentDirection | undefined) ?? 'ccw',
				at: c.at ?? '',
				line,
			});
			return;
		}
		case 'udl': {
			const magnitude = readQuantity(p, 'Expected a number for the magnitude', 'distributed');
			const c = readLoadClauses(p, 'udl');
			ast.loads.push({
				kind: 'udl',
				magnitude,
				direction: (c.direction as ForceDirection | undefined) ?? 'down',
				...(c.from !== undefined ? { from: c.from, to: c.to } : {}),
				line,
			});
			return;
		}
		case 'linear': {
			const example = 'for example: linear 0 to 6 kN/m';
			const start = readQuantity(p, `Expected a number for the start value, ${example}`, 'distributed');
			if (!p.isWord('to')) throw new LineError(`Expected "to" and the end value, ${example}`);
			p.next();
			const end = readQuantity(p, `Expected a number for the end value, ${example}`, 'distributed');
			const c = readLoadClauses(p, 'linear');
			ast.loads.push({
				kind: 'linear',
				start,
				end,
				direction: (c.direction as ForceDirection | undefined) ?? 'down',
				...(c.from !== undefined ? { from: c.from, to: c.to } : {}),
				line,
			});
			return;
		}
		case 'section':
			ast.section = readSection(p, line);
			return;
		default:
			// title, units and material returned above.
			return;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parses block text into an AST. Never throws: problems become diagnostics with line numbers. */
export function parseBeamSource(source: string): { ast: BeamAst; diagnostics: Diagnostic[] } {
	const ast = emptyAst();
	const diagnostics: Diagnostic[] = [];
	const firstLines: Partial<Record<SingleName, number>> = {};
	const lines = source.split(/\r\n|\r|\n/);
	lines.forEach((text, index) => {
		const line = index + 1;
		const { code, hasComment } = splitComment(text);
		// Trailing comments count too: the editor warns that saving drops them.
		if (hasComment) ast.commentCount++;
		if (code.trim() === '') return;
		try {
			parseStatement(code, line, ast, firstLines);
		} catch (e) {
			const message = e instanceof LineError ? e.message : 'This line could not be read';
			diagnostics.push({ severity: 'error', message, line });
		}
	});
	return { ast, diagnostics };
}

/** An empty AST (no statements). */
export function emptyAst(): BeamAst {
	return { supports: [], hinges: [], loads: [], lines: {}, commentCount: 0 };
}
