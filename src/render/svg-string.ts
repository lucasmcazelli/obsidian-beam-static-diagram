/**
 * Serializes a scene to SVG markup. Used by tests only; the plugin mounts
 * scenes with createSvg() (src/ui/mount.ts).
 *
 * The output is a standalone document fragment: it declares the SVG
 * namespace and carries the same `bsd-svg` class, accessible name
 * (aria-label and <title>) and description as the mounted version, and drops
 * the same attributes (isForbiddenAttribute). Two small differences remain:
 * a primitive's tooltip <title> is written before its text (mount writes the
 * text first), and a non-finite number is written as 0 (mount leaves the
 * attribute out). It contains no ids, so any number of copies can live in
 * one HTML page.
 */
import { isForbiddenAttribute, type Prim, type Scene } from './scene';

/** Attribute names we are willing to write: letters, digits, "-" and ":" (e.g. "text-anchor", "xml:space"). */
const SAFE_ATTRIBUTE = /^[A-Za-z][A-Za-z0-9:-]*$/;

/**
 * Returns a standalone `<svg>` string with escaped text and attributes:
 * `<svg xmlns=... viewBox="0 0 W H" width="W" height="H" class="bsd-svg" role="img" aria-label="title">`
 * followed by `<title>`, `<desc>` and one element per primitive.
 */
export function sceneToSvgString(scene: Scene): string {
	const w = numberText(scene.width);
	const h = numberText(scene.height);
	const head =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="bsd-svg" role="img" aria-label="${escapeXml(scene.title)}">` +
		`<title>${escapeXml(scene.title)}</title><desc>${escapeXml(scene.desc)}</desc>`;
	return `${head}${scene.prims.map(primToString).join('')}</svg>`;
}

/**
 * Escapes the five XML special characters. Used for both text content and
 * attribute values (attributes are always written in double quotes, but
 * escaping the single quote too keeps the function safe for either).
 */
export function escapeXml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => XML_ENTITIES[c] ?? c);
}

/** Replacement for each XML special character. */
const XML_ENTITIES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
};

/** One primitive as an element; tooltip becomes a <title> child, text follows it. */
function primToString(prim: Prim): string {
	const attrs = [`class="${escapeXml(prim.cls)}"`];
	for (const [name, value] of Object.entries(prim.attrs)) {
		// `class` comes from prim.cls (isForbiddenAttribute drops it with style, on* and href);
		// skip names that could break the markup.
		if (isForbiddenAttribute(name) || !SAFE_ATTRIBUTE.test(name)) continue;
		attrs.push(`${name}="${escapeXml(typeof value === 'number' ? numberText(value) : String(value))}"`);
	}
	const open = `<${prim.tag} ${attrs.join(' ')}`;
	const children = (prim.tooltip !== undefined ? `<title>${escapeXml(prim.tooltip)}</title>` : '') + (prim.text !== undefined ? escapeXml(prim.text) : '');
	return children === '' ? `${open}/>` : `${open}>${children}</${prim.tag}>`;
}

/** Numbers as plain decimal text; non-finite values (a bug upstream) become 0 so the markup stays valid. */
function numberText(value: number): string {
	return Number.isFinite(value) ? String(value) : '0';
}
