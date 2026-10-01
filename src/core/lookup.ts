/**
 * Safe lookups in the plugin's keyword tables.
 *
 * The parser and the unit, material and section readers map what the user
 * typed to values through plain object tables. Indexing such a table with
 * arbitrary text also finds the properties every object inherits:
 * `table['constructor']` is Object's constructor function, which is truthy,
 * so a line such as "constructor 5" or "units constructor" would be taken
 * for a valid statement and fail later in a confusing way. Every lookup keyed
 * by user text goes through `ownValue`, which only sees the table's own keys.
 */

/**
 * Value stored under `key` in `table` itself, or undefined. Inherited
 * properties ("constructor", "toString", "__proto__", ...) are ignored.
 */
export function ownValue<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
