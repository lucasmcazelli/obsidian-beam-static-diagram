/**
 * Safe handling of text typed by the user.
 *
 * Keyword tables: the parser and the unit, material and section readers map
 * what the user typed to values through plain object tables. Indexing such a
 * table with arbitrary text also finds the properties every object inherits:
 * `table['constructor']` is Object's constructor function, which is truthy,
 * so a line such as "constructor 5" or "units constructor" would be taken
 * for a valid statement and fail later in a confusing way. Every lookup keyed
 * by user text goes through `ownValue`, which only sees the table's own keys.
 *
 * Messages: diagnostics quote what the user typed, and the error box repeats
 * the source line as well. `clipText` keeps a quoted token short, so a
 * pasted 300-character word does not fill the box twice.
 */

/**
 * Value stored under `key` in `table` itself, or undefined. Inherited
 * properties ("constructor", "toString", "__proto__", ...) are ignored.
 */
export function ownValue<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** Longest user text quoted in a message before it is shortened. */
const MAX_QUOTED = 30;

/**
 * User text for quoting in a message: unchanged when short, otherwise the
 * first `max` characters followed by "...". Never cuts a character outside
 * the BMP (emoji) in half.
 */
export function clipText(text: string, max: number = MAX_QUOTED): string {
	if (text.length <= max) return text;
	let cut = max;
	// A high surrogate at the cut would leave half a character behind.
	const code = text.charCodeAt(cut - 1);
	if (code >= 0xd800 && code <= 0xdbff) cut--;
	return `${text.slice(0, cut)}...`;
}
