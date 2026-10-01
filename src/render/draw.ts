/**
 * Small geometry and labelling helpers shared by the scene builders.
 *
 * Everything here returns plain data (numbers, strings, Prim objects); no DOM.
 * Coordinates are SVG pixels with y pointing DOWN, so "above the beam" means
 * a smaller y. Angles passed to the arc helpers are in degrees, measured the
 * mathematical way (counter-clockwise from +x as seen on screen), which keeps
 * "counter-clockwise couple" and "counter-clockwise arc" the same thing.
 */
import type { Dimension, UnitSystemId } from '../core/types';
import { formatCompact, toDisplay, unitSymbol } from '../core/units';
import { estimateTextWidth, LAYOUT, px } from './scene';
import type { Prim } from './scene';

/** Horizontal text anchors supported by SVG. */
export type Anchor = 'start' | 'middle' | 'end';

/** Axis-aligned box in px (x0 <= x1, y0 <= y1). */
export interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** A label whose anchor was adjusted to keep it inside the drawing. */
export interface PlacedText {
	/** Anchor x [px] to write into the `x` attribute. */
	x: number;
	/** Baseline y [px]. */
	y: number;
	anchor: Anchor;
	/** Estimated extent of the rendered text. */
	box: Box;
}

/** Labels keep at least this distance [px] from the left and right edges of the drawing. */
export const EDGE_PAD = 2;

/** Arrowhead length and half width [px]; small enough for 18 px arrow spacing. */
export const HEAD_LEN = 7;
export const HEAD_HALF = 3.5;

/**
 * Drawing width actually used for a requested container width: never below
 * LAYOUT.minWidth (the SVG scales down through its viewBox instead), and a
 * safe default when the container reports nothing usable (0 or NaN while
 * the note is still hidden).
 */
export function sceneWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(width, LAYOUT.minWidth) : LAYOUT.minWidth;
}

/** Decimals for labels: an integer in 0..6, defaulting to 2 for nonsense input. */
export function labelDecimals(decimals: number): number {
	return Number.isFinite(decimals) ? Math.max(0, Math.min(6, Math.round(decimals))) : 2;
}

/**
 * Text extent above and below the baseline as a fraction of the font size.
 * Typical interface fonts have ascenders near 0.75 em and descenders near
 * 0.25 em; SVG gives no way to measure without a DOM, so these are estimates.
 */
const ASCENT = 0.75;
const DESCENT = 0.25;

/**
 * Places a label at (x, y) with the preferred anchor. Near the left or right
 * edge the anchor switches to 'start' at EDGE_PAD or 'end' at width - EDGE_PAD,
 * so the estimated text box always stays inside [0, width].
 */
export function placeText(x: number, y: number, text: string, fontSize: number, width: number, anchor: Anchor = 'middle'): PlacedText {
	const w = estimateTextWidth(text, fontSize);
	let a = anchor;
	let ax = x;
	if (startOf(ax, w, a) < EDGE_PAD) {
		a = 'start';
		ax = EDGE_PAD;
	} else if (startOf(ax, w, a) + w > width - EDGE_PAD) {
		a = 'end';
		ax = width - EDGE_PAD;
	}
	const x0 = startOf(ax, w, a);
	return { x: ax, y, anchor: a, box: { x0, x1: x0 + w, y0: y - ASCENT * fontSize, y1: y + DESCENT * fontSize } };
}

/** Left edge of a text of width w anchored at x. */
function startOf(x: number, w: number, anchor: Anchor): number {
	return anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
}

/** True when two boxes overlap, treating boxes closer than `gap` px as overlapping. */
export function boxesOverlap(a: Box, b: Box, gap = 0): boolean {
	return a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;
}

/** A `text` primitive for a placed label. */
export function textPrim(cls: string, placed: PlacedText, text: string, tooltip?: string): Prim {
	const prim: Prim = { tag: 'text', cls, attrs: { x: px(placed.x), y: px(placed.y), 'text-anchor': placed.anchor }, text };
	if (tooltip !== undefined) prim.tooltip = tooltip;
	return prim;
}

/** A straight `line` primitive. */
export function linePrim(cls: string, x1: number, y1: number, x2: number, y2: number, tooltip?: string): Prim {
	const prim: Prim = { tag: 'line', cls, attrs: { x1: px(x1), y1: px(y1), x2: px(x2), y2: px(y2) } };
	if (tooltip !== undefined) prim.tooltip = tooltip;
	return prim;
}

/** "x,y x,y ..." for polyline and polygon `points`, rounded with px(). */
export function pointsAttr(points: ReadonlyArray<readonly [number, number]>): string {
	return points.map(([x, y]) => `${px(x)},${px(y)}`).join(' ');
}

/**
 * Filled triangular arrowhead with its tip at (tipX, tipY) pointing along
 * (dirX, dirY). The base sits HEAD_LEN back along the direction and spans
 * ±HEAD_HALF along the perpendicular (-dirY, dirX). Drawn as a polygon
 * instead of an SVG marker because markers need ids, and several beam blocks
 * share one document.
 */
export function arrowhead(cls: string, tipX: number, tipY: number, dirX: number, dirY: number, len = HEAD_LEN, half = HEAD_HALF): Prim {
	const n = Math.hypot(dirX, dirY) || 1;
	const ux = dirX / n;
	const uy = dirY / n;
	const bx = tipX - ux * len;
	const by = tipY - uy * len;
	return {
		tag: 'polygon',
		cls,
		attrs: {
			points: pointsAttr([
				[tipX, tipY],
				[bx - uy * half, by + ux * half],
				[bx + uy * half, by - ux * half],
			]),
		},
	};
}

/**
 * Vertical arrow from y = fromY to y = toY (tip at toY): a shaft that stops
 * where the arrowhead starts, so the line end never pokes through the tip.
 */
export function verticalArrow(shaftCls: string, headCls: string, x: number, fromY: number, toY: number, tooltip?: string): Prim[] {
	const dir = toY >= fromY ? 1 : -1;
	const length = Math.abs(toY - fromY);
	// Short arrows get a proportionally smaller head so they still read as arrows.
	const head = Math.min(HEAD_LEN, 0.6 * length);
	const half = (HEAD_HALF * head) / HEAD_LEN;
	const prims: Prim[] = [];
	if (length - head > 0.5) prims.push(linePrim(shaftCls, x, fromY, x, toY - dir * head, tooltip));
	prims.push(arrowhead(headCls, x, toY, 0, dir, head, half));
	return prims;
}

/** Point on a circle at `deg` degrees (counter-clockwise on screen, 0 = right). */
export function onCircle(cx: number, cy: number, r: number, deg: number): [number, number] {
	const t = (deg * Math.PI) / 180;
	// Screen y points down, so the mathematical sine is subtracted.
	return [cx + r * Math.cos(t), cy - r * Math.sin(t)];
}

/**
 * Curved arrow along a circle from `fromDeg` to `toDeg`, with the arrowhead
 * at `toDeg`. toDeg > fromDeg travels counter-clockwise on screen, otherwise
 * clockwise. The arc stops HEAD_LEN short of the end (angle HEAD_LEN / r) and
 * the head points along the chord of that last bit, so it sits on the arc.
 */
export function arcArrow(arcCls: string, headCls: string, cx: number, cy: number, r: number, fromDeg: number, toDeg: number, tooltip?: string): Prim[] {
	const ccw = toDeg > fromDeg;
	const headDeg = ((HEAD_LEN / r) * 180) / Math.PI;
	const stopDeg = ccw ? toDeg - headDeg : toDeg + headDeg;
	const [sx, sy] = onCircle(cx, cy, r, fromDeg);
	const [ex, ey] = onCircle(cx, cy, r, stopDeg);
	const [tx, ty] = onCircle(cx, cy, r, toDeg);
	const span = Math.abs(stopDeg - fromDeg);
	// SVG arc flags: large-arc for spans over 180 degrees; sweep-flag 1 is
	// clockwise on screen (y down), so a counter-clockwise arc uses 0.
	const d = `M ${px(sx)} ${px(sy)} A ${px(r)} ${px(r)} 0 ${span > 180 ? 1 : 0} ${ccw ? 0 : 1} ${px(ex)} ${px(ey)}`;
	const arc: Prim = { tag: 'path', cls: arcCls, attrs: { d } };
	if (tooltip !== undefined) arc.tooltip = tooltip;
	return [arc, arrowhead(headCls, tx, ty, tx - ex, ty - ey)];
}

/**
 * Path data for 45 degree hatch lines ("/") clipped to a rectangle, spaced
 * `step` px apart. Each line is x + y = c; inside the rectangle it runs over
 * y in [max(y0, c - x1), min(y1, c - x0)], which is computed exactly instead
 * of relying on an SVG clipPath (clip paths need ids).
 */
export function hatchPath(x0: number, y0: number, x1: number, y1: number, step: number): string {
	const parts: string[] = [];
	for (let c = x0 + y0 + step; c < x1 + y1; c += step) {
		const ya = Math.max(y0, c - x1);
		const yb = Math.min(y1, c - x0);
		if (yb - ya > 0.5) parts.push(`M ${px(c - ya)} ${px(ya)} L ${px(c - yb)} ${px(yb)}`);
	}
	return parts.join(' ');
}

/** A horizontal extent [x0, x1] that must not overlap others in the same row. */
export interface RowItem {
	x0: number;
	x1: number;
}

/**
 * Greedy row packing: items are taken in the given order (most important
 * first) and each goes into the lowest row where it overlaps nothing already
 * there, keeping `gap` px between neighbours. Returns the row of each item.
 * Not optimal, but stable and predictable, which matters more for labels.
 */
export function packRows(items: readonly RowItem[], gap: number): number[] {
	const rows: RowItem[][] = [];
	return items.map((item) => {
		let r = 0;
		while (rows[r]?.some((other) => item.x0 < other.x1 + gap && other.x0 < item.x1 + gap)) r++;
		(rows[r] ??= []).push(item);
		return r;
	});
}

/**
 * A typed value shown compactly in display units: "10", "2.5", "0.125".
 * Input values (loads, positions) read better without padded zeros than
 * results do, so they use up to max(decimals, 3) decimals, trailing zeros
 * removed; this also hides unit-conversion round-off (9.9999999 kip -> "10").
 */
export function formatInput(valueSI: number, dimension: Dimension, units: UnitSystemId, decimals: number): string {
	return formatCompact(toDisplay(valueSI, dimension, units), Math.max(decimals, 3));
}

/** A position with its unit: "2.5 m". */
export function formatPosition(x: number, units: UnitSystemId, decimals: number): string {
	return `${formatInput(x, 'length', units, decimals)} ${unitSymbol('length', units)}`;
}

/**
 * Letter name of the support with this index (BeamModel.supports is sorted
 * left to right): A, B, ..., Z, then AA, AB, ... like spreadsheet columns.
 * The drawing's tooltips and the results table both use it, so "support B"
 * means the same support everywhere.
 */
export function supportName(index: number): string {
	let name = '';
	// Bijective base 26: there is no "zero" letter, hence the -1 on each step.
	for (let n = Math.max(0, Math.floor(index)) + 1; n > 0; n = Math.floor((n - 1) / 26)) {
		name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
	}
	return name;
}
