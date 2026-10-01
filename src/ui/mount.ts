/**
 * Mounts a DOM-free Scene (src/render/scene.ts) as a live SVG element.
 *
 * Only Obsidian's createSvg() and setText() helpers are used: no markup
 * strings are ever parsed, so user text in labels (titles, units) can never
 * be interpreted as HTML or SVG.
 */
import { isForbiddenAttribute, type Prim, type Scene } from '../render/scene';

/** Copies a primitive's attributes, skipping forbidden names and non-finite numbers. */
function primAttributes(prim: Prim): Record<string, string | number> {
	const attrs: Record<string, string | number> = {};
	for (const [name, value] of Object.entries(prim.attrs)) {
		if (isForbiddenAttribute(name)) continue;
		// NaN or Infinity would make the browser drop the whole element with a console error.
		if (typeof value === 'number' && !Number.isFinite(value)) continue;
		attrs[name] = value;
	}
	return attrs;
}

/**
 * Appends `scene` to `parent` as
 * `<svg class="bsd-svg" viewBox="0 0 W H" width=W height=H role="img" aria-label=title>`
 * with `<title>` and `<desc>` children (the accessible name and description)
 * followed by one element per primitive. A primitive's tooltip becomes an SVG
 * `<title>` child, which browsers show on hover.
 *
 * The SVG gets explicit width and height so it renders at 1:1 scale; CSS
 * (max-width: 100%, height: auto) scales it down in narrower containers
 * while the viewBox keeps the proportions.
 */
export function mountScene(parent: HTMLElement, scene: Scene): SVGSVGElement {
	const svg = parent.createSvg('svg', {
		cls: 'bsd-svg',
		attr: {
			viewBox: `0 0 ${scene.width} ${scene.height}`,
			width: scene.width,
			height: scene.height,
			role: 'img',
			'aria-label': scene.title,
		},
	});
	svg.createSvg('title').setText(scene.title);
	svg.createSvg('desc').setText(scene.desc);

	for (const prim of scene.prims) {
		const el = svg.createSvg(prim.tag, { cls: prim.cls, attr: primAttributes(prim) });
		// setText replaces all children, so it must run before the tooltip <title> is added.
		if (prim.text !== undefined) el.setText(prim.text);
		if (prim.tooltip) el.createSvg('title').setText(prim.tooltip);
	}
	return svg;
}
