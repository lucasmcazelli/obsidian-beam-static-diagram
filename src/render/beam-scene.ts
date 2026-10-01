/**
 * Schematic drawing of the beam: supports, hinges, loads, reactions, dimensions.
 *
 * Vertical layout, top to bottom (y grows downwards):
 *
 *   load label rows      one row per level of overlapping labels
 *   loads                point arrows, distributed bands, couples
 *   beam                 thick line at y = beamY
 *   supports             pin / roller triangles, ground hatching
 *   reactions            arrows below the supports, value label rows
 *   dimension line       ticks at every key point, position labels
 *
 * The horizontal mapping comes from createXLayout, exactly as in the diagrams,
 * so a support drawn here sits right above the matching jump in the shear
 * diagram. Every primitive carries bsd-* classes only; colours live in styles.css.
 */
import { forceScale } from '../core/analyze';
import { POSITION_TOL } from '../core/diagrams';
import type { BeamModel, BeamResults, DistributedLoad, MomentLoad, PointLoad, Reaction, Support } from '../core/types';
import { formatQuantity, unitSymbol } from '../core/units';
import {
	arcArrow,
	boxesOverlap,
	formatInput,
	formatPosition,
	hatchPath,
	labelDecimals,
	linePrim,
	packRows,
	placeText,
	pointsAttr,
	sceneWidth,
	supportName,
	textPrim,
	verticalArrow,
} from './draw';
import type { PlacedText } from './draw';
import { createXLayout, LAYOUT, px } from './scene';
import type { Prim, Scene, SceneOptions } from './scene';

// ---------------------------------------------------------------------------
// Layout constants [px]
// ---------------------------------------------------------------------------

/** Empty space above the first label row. */
const PAD_TOP = 6;
/** Height of one load label row (11 px text plus spacing). */
const LOAD_ROW_H = 15;
/** Smallest horizontal gap between two labels in the same row. */
const LABEL_GAP = 8;
/** Half the beam stroke width (styles.css draws .bsd-beam 4 px wide). */
const BEAM_HALF = 2;
/** Length of point load arrows when nothing else is in the way. */
const POINT_LEN = 42;
/** A point arrow extends this far above the tallest distributed band, so it reads as separate. */
const POINT_OVER_DIST = 14;
/** Height of the band drawn for the largest distributed load. */
const DIST_H = 26;
/** Vertical gap between stacked (overlapping) distributed loads. */
const DIST_LEVEL_GAP = 6;
/**
 * A distributed load is drawn at least this share of DIST_H tall, so a
 * small load next to a large one stays visible.
 */
const DIST_MIN_SHARE = 0.35;
/** Target spacing of the arrows under a distributed load (18 to 28 px reads well). */
const DIST_SPACING = 22;
/** Arrows shorter than this are skipped (near the zero end of a triangular load). */
const DIST_MIN_ARROW = 6;
/** Radius of applied couple arcs around the beam axis. */
const COUPLE_R = 14;
/** Space kept above the beam even without loads: fixed-end walls and reaction arcs reach this high. */
const MIN_ABOVE = 20;
/** Pin triangle: height and half width; ground line half width; hatch depth. */
const PIN_H = 14;
const PIN_HALF = 9;
const GROUND_HALF = 14;
const HATCH_H = 6;
/** Roller triangle height and half width, roller wheel radius and wheel offset from the axis. */
const ROLLER_H = 10;
const ROLLER_HALF = 8;
const WHEEL_R = 2.5;
const WHEEL_DX = 4.5;
/** Fixed end wall: half height and hatch depth. Interior clamp block half width and half height. */
const WALL_HALF = 16;
const WALL_HATCH = 8;
const CLAMP_HALF_W = 7;
const CLAMP_HALF_H = 12;
/** Spacing of hatch strokes. */
const HATCH_STEP = 4;
/** Hinge circle radius. */
const HINGE_R = 4;
/** Depth of the support symbols below the beam (the pin with its hatching is the deepest). */
const SUPPORT_ZONE = PIN_H + HATCH_H;
/** Reaction arrows: gap below the supports, arrow length, label row height, couple arc radius. */
const REACTION_GAP = 4;
const REACTION_LEN = 26;
const REACTION_ROW_H = 13;
const REACTION_ARC_R = 20;
/** Dimension line: gap above it, tick half length, label baseline offset, bottom padding. */
const DIM_GAP = 16;
const DIM_TICK = 4;
const DIM_LABEL_DY = 14;
const PAD_BOTTOM = 5;
/** Values below this fraction of the force scale count as zero (solver round-off). */
const ZERO_TOL = 1e-9;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds the beam schematic. When `results` is given, reactions are drawn
 * (arrows with values, curved arrows for fixed-end couples).
 */
export function buildBeamScene(model: BeamModel, results: BeamResults | undefined, options: SceneOptions): Scene {
	const width = sceneWidth(options.width);
	const L = Number.isFinite(model.length) && model.length > 0 ? model.length : 0;
	const layout = createXLayout(width, L);
	const units = options.units;
	const decimals = labelDecimals(options.decimals);
	const eps = POSITION_TOL * L;
	/** Beam position [m] to px, clamped to the beam so bad input never yields NaN. */
	const X = (x: number): number => layout.toPx(Number.isFinite(x) ? Math.min(Math.max(x, 0), L) : 0);
	const pos = (x: number): string => formatPosition(x, units, decimals);

	const points = model.loads.filter((l): l is PointLoad => l.kind === 'point');
	const couples = model.loads.filter((l): l is MomentLoad => l.kind === 'moment');
	const distributed = model.loads.filter((l): l is DistributedLoad => l.kind === 'distributed');

	// --- Heights of the load drawings -------------------------------------
	const levels = distributedLevels(distributed, eps);
	const levelCount = levels.length > 0 ? Math.max(...levels) + 1 : 0;
	const distStack = levelCount > 0 ? levelCount * DIST_H + (levelCount - 1) * DIST_LEVEL_GAP : 0;
	// Point arrows start above every distributed band so they never hide inside one.
	const pointLen = points.length > 0 ? Math.max(POINT_LEN, distStack + POINT_OVER_DIST) : 0;
	const coupleAbove = couples.length > 0 ? COUPLE_R + 2 - BEAM_HALF : 0;
	const loadZone = Math.max(MIN_ABOVE, pointLen, distStack, coupleAbove);

	// --- Load labels, packed into rows ------------------------------------
	const loadLabels = collectLoadLabels(points, couples, distributed, units, decimals, pos).sort((a, b) => a.x - b.x);
	const loadPlaced = loadLabels.map((l) => placeText(X(l.x), 0, l.text, LAYOUT.fontSize, width));
	const loadRows = packRows(
		loadPlaced.map((p) => p.box),
		LABEL_GAP,
	);
	const rowCount = loadRows.length > 0 ? Math.max(...loadRows) + 1 : 0;

	// --- Vertical positions -----------------------------------------------
	const labelsBottom = PAD_TOP + rowCount * LOAD_ROW_H;
	const loadTop = rowCount > 0 ? labelsBottom + 2 : PAD_TOP;
	const beamTop = loadTop + loadZone;
	const beamY = beamTop + BEAM_HALF;
	const beamBottom = beamY + BEAM_HALF;
	const supportBottom = beamBottom + SUPPORT_ZONE;

	const back: Prim[] = [];
	const front: Prim[] = [];
	const labels: Prim[] = [];

	// --- Distributed loads (fill behind the beam, arrows in front) ---------
	const qmax = Math.max(0, ...distributed.map((d) => Math.max(Math.abs(d.q1), Math.abs(d.q2))));
	distributed.forEach((d, i) => {
		const base = beamTop - (levels[i] ?? 0) * (DIST_H + DIST_LEVEL_GAP);
		drawDistributed(d, base, qmax, X, back, front, distributedTooltip(d, units, decimals, pos));
	});

	// --- Beam --------------------------------------------------------------
	const beam = linePrim('bsd-beam', X(0), beamY, X(L), beamY);
	beam.tooltip = `Beam, ${pos(L)} long`;
	back.push(beam);

	// --- Supports and hinges ------------------------------------------------
	model.supports.forEach((s, i) => {
		drawSupport(s, X(s.x), beamY, beamBottom, s.x <= eps ? 'left' : s.x >= L - eps ? 'right' : 'inside', supportTooltip(s, i, pos), back);
	});
	for (const h of model.hinges) {
		back.push({
			tag: 'circle',
			cls: 'bsd-hinge',
			attrs: { cx: px(X(h)), cy: px(beamY), r: HINGE_R },
			tooltip: `Internal hinge at x = ${pos(h)}: the bending moment is zero here`,
		});
	}

	// --- Point loads and couples -------------------------------------------
	for (const p of points) {
		const x = X(p.x);
		// Down loads end at the top of the beam; up loads start there and point away.
		const tooltip = pointTooltip(p, units, decimals, pos);
		const arrow =
			p.fy < 0
				? verticalArrow('bsd-load', 'bsd-arrowhead', x, beamTop - pointLen, beamTop - 1, tooltip)
				: verticalArrow('bsd-load', 'bsd-arrowhead', x, beamTop - 1, beamTop - pointLen, tooltip);
		front.push(...arrow);
	}
	for (const c of couples) {
		// About 270 degrees around the load point with the gap at the bottom
		// (where the supports are); the head shows the sense of rotation.
		const [from, to] = c.mz > 0 ? [-45, 225] : [225, -45];
		front.push(...arcArrow('bsd-load bsd-moment', 'bsd-arrowhead', X(c.x), beamY, COUPLE_R, from, to, coupleTooltip(c, units, decimals, pos)));
	}

	// Load labels: row 0 sits just above the loads, further rows stack upwards.
	loadLabels.forEach((l, i) => {
		const row = loadRows[i] ?? 0;
		const placed = loadPlaced[i];
		if (!placed) return;
		const y = labelsBottom - 4 - row * LOAD_ROW_H;
		labels.push(textPrim('bsd-load-label', { ...placed, y }, l.text, l.tooltip));
	});

	// --- Reactions ----------------------------------------------------------
	let reactionsBottom = supportBottom;
	const reactionSummary: string[] = [];
	if (results) {
		const scale = forceScale(model, results.reactions);
		const reactionTop = supportBottom + REACTION_GAP;
		const reactionBottom = reactionTop + REACTION_LEN;
		const items: { x: number; text: string; tooltip: string }[] = [];
		const coupleItems: { x: number; text: string; tooltip: string }[] = [];
		for (const r of results.reactions) {
			const x = X(r.x);
			// Same letter as the results table: "support A" is the leftmost support.
			const name = supportName(r.supportIndex);
			const fyZero = Math.abs(r.fy) <= ZERO_TOL * scale;
			const force = formatQuantity(fyZero ? 0 : Math.abs(r.fy), 'force', units, decimals);
			const direction = fyZero ? '' : r.fy > 0 ? ' up' : ' down';
			const tooltip = `Reaction at support ${name} (x = ${pos(r.x)}): ${force}${direction}`;
			if (!fyZero) {
				// fy > 0 pushes the beam up: the arrow points up, towards the support.
				front.push(
					...(r.fy > 0
						? verticalArrow('bsd-reaction', 'bsd-arrowhead bsd-reaction-head', x, reactionBottom, reactionTop, tooltip)
						: verticalArrow('bsd-reaction', 'bsd-arrowhead bsd-reaction-head', x, reactionTop, reactionBottom, tooltip)),
				);
			}
			items.push({ x, text: force, tooltip });
			reactionSummary.push(`${name} ${force}${direction}`);

			if (r.kind === 'fixed' && Math.abs(r.mz) > ZERO_TOL * scale * L) {
				const where = r.x <= eps ? 'left' : r.x >= L - eps ? 'right' : 'inside';
				const couple = formatQuantity(Math.abs(r.mz), 'moment', units, decimals);
				const sense = r.mz > 0 ? 'counter-clockwise' : 'clockwise';
				const coupleTip = `Reaction moment at support ${name} (x = ${pos(r.x)}): ${couple} ${sense}`;
				front.push(...reactionCoupleArc(r, where, x, beamY, coupleTip));
				// The open circle arrow ties the label to the curved arrow at the support.
				coupleItems.push({ x, text: `${r.mz > 0 ? '↺' : '↻'} ${couple}`, tooltip: coupleTip });
				reactionSummary.push(`${name} ${couple} ${sense}`);
			}
		}
		// Force labels first so they take the row right under the arrows.
		const all = [...items.sort((a, b) => a.x - b.x), ...coupleItems.sort((a, b) => a.x - b.x)];
		const placed = all.map((item) => placeText(item.x, 0, item.text, LAYOUT.fontSize, width));
		const rows = packRows(
			placed.map((p) => p.box),
			LABEL_GAP,
		);
		all.forEach((item, i) => {
			const p = placed[i];
			if (!p) return;
			const y = reactionBottom + 12 + (rows[i] ?? 0) * REACTION_ROW_H;
			labels.push(textPrim('bsd-reaction-label', { ...p, y }, item.text, item.tooltip));
		});
		const reactionRows = rows.length > 0 ? Math.max(...rows) + 1 : 0;
		reactionsBottom = reactionRows > 0 ? reactionBottom + 12 + (reactionRows - 1) * REACTION_ROW_H + 3 : reactionBottom;
	}

	// --- Dimension line -----------------------------------------------------
	const dimY = reactionsBottom + DIM_GAP;
	const dims = dimensionPrims(model, L, eps, dimY, width, X, units, decimals);

	const prims = [...back, ...front, ...dims, ...labels];
	return {
		width,
		height: px(dimY + DIM_LABEL_DY + PAD_BOTTOM),
		title: model.title ? `${model.title}: beam, supports and loads` : 'Beam, supports and loads',
		desc: describeBeam(model, L, units, decimals, pos, reactionSummary),
		prims,
	};
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

/** A load label before placement: centre x [m], text and tooltip. */
interface LoadLabel {
	x: number;
	text: string;
	tooltip: string;
}

/**
 * Stacking level of every distributed load: greedy interval packing on
 * [x1, x2], so overlapping loads are drawn one above the other instead of on
 * top of each other. Loads that merely touch share a level.
 */
function distributedLevels(loads: readonly DistributedLoad[], eps: number): number[] {
	const order = loads.map((d, i) => ({ i, a: Math.min(d.x1, d.x2), b: Math.max(d.x1, d.x2) })).sort((p, q) => p.a - q.a);
	const levelEnds: number[] = [];
	const levels = new Array<number>(loads.length).fill(0);
	for (const item of order) {
		let lv = 0;
		while ((levelEnds[lv] ?? Number.NEGATIVE_INFINITY) > item.a + eps) lv++;
		levelEnds[lv] = item.b;
		levels[item.i] = lv;
	}
	return levels;
}

/**
 * Draws one distributed load whose band sits on y = base:
 * a translucent fill (bsd-dist), the top outline (bsd-load) and a row of
 * arrows (at least 3, about DIST_SPACING apart).
 *
 * Arrow length is proportional to |q| at that point, scaled by the largest
 * |q| of all distributed loads (qmax). A load whose peak is below 35% of
 * qmax is scaled up as a whole (factor k) so it stays visible, which keeps
 * the shape of a triangular load exact. A load that changes sign is drawn
 * with arrows pointing down where q < 0 and up where q > 0.
 */
function drawDistributed(
	d: DistributedLoad,
	base: number,
	qmax: number,
	X: (x: number) => number,
	back: Prim[],
	front: Prim[],
	tooltip: string,
): void {
	// Left end first, whatever order the model gave.
	const [xa, qa, xb, qb] = d.x1 <= d.x2 ? [d.x1, d.q1, d.x2, d.q2] : [d.x2, d.q2, d.x1, d.q1];
	const a = X(xa);
	const b = X(xb);
	const peak = Math.max(Math.abs(qa), Math.abs(qb));
	if (!(qmax > 0) || !(peak > 0)) return;
	const k = Math.max(1, (DIST_MIN_SHARE * qmax) / peak);
	const h = (q: number): number => (DIST_H * Math.abs(q) * k) / qmax;

	// Outline through both ends and, for a sign change, the zero at
	// t = qa / (qa - qb) along the load (where the linear q(x) vanishes).
	const outline: [number, number][] = [[a, base - h(qa)]];
	if (qa * qb < 0) outline.push([a + ((b - a) * qa) / (qa - qb), base]);
	outline.push([b, base - h(qb)]);

	back.push({ tag: 'polygon', cls: 'bsd-dist', attrs: { points: pointsAttr([[a, base], ...outline, [b, base]]) }, tooltip });
	front.push({ tag: 'polyline', cls: 'bsd-load', attrs: { points: pointsAttr(outline) } });

	const n = Math.max(3, Math.round((b - a) / DIST_SPACING) + 1);
	for (let i = 0; i < n; i++) {
		const t = i / (n - 1);
		const x = a + (b - a) * t;
		const q = qa + (qb - qa) * t;
		const len = h(q);
		if (len < DIST_MIN_ARROW) continue;
		// q < 0 is a downward load: arrow from the outline down to the band base.
		const arrow =
			q < 0
				? verticalArrow('bsd-load', 'bsd-arrowhead', x, base - len, base - 1)
				: verticalArrow('bsd-load', 'bsd-arrowhead', x, base - 1, base - len);
		front.push(...arrow);
	}
}

/** Label texts and tooltips for every load, centred on the load (distributed: on its middle). */
function collectLoadLabels(
	points: readonly PointLoad[],
	couples: readonly MomentLoad[],
	distributed: readonly DistributedLoad[],
	units: SceneOptions['units'],
	decimals: number,
	pos: (x: number) => string,
): LoadLabel[] {
	const out: LoadLabel[] = [];
	for (const p of points) {
		out.push({ x: p.x, text: `${formatInput(Math.abs(p.fy), 'force', units, decimals)} ${unitSymbol('force', units)}`, tooltip: pointTooltip(p, units, decimals, pos) });
	}
	for (const d of distributed) {
		out.push({ x: 0.5 * (d.x1 + d.x2), text: distributedText(d, units, decimals), tooltip: distributedTooltip(d, units, decimals, pos) });
	}
	for (const c of couples) {
		out.push({ x: c.x, text: `${formatInput(Math.abs(c.mz), 'moment', units, decimals)} ${unitSymbol('moment', units)}`, tooltip: coupleTooltip(c, units, decimals, pos) });
	}
	return out;
}

/**
 * Values of a distributed load as shown to the user, left end first, signed
 * relative to its main direction (the direction of the larger end): "4" for
 * a uniform load, "0 → 6" for a triangle, "-2 → 4" for a load changing sign.
 */
function distributedValues(d: DistributedLoad, units: SceneOptions['units'], decimals: number): { text: string; down: boolean } {
	const [qa, qb] = d.x1 <= d.x2 ? [d.q1, d.q2] : [d.q2, d.q1];
	const main = Math.abs(qa) >= Math.abs(qb) ? qa : qb;
	const down = main < 0;
	// Model values are positive UP; flip so the main direction reads positive.
	const show = (q: number): string => formatInput(down ? -q : q, 'distributed', units, decimals);
	const text = qa === qb ? show(qa) : `${show(qa)} → ${show(qb)}`;
	return { text, down };
}

/** "4 kN/m" or "0 → 6 kN/m". */
function distributedText(d: DistributedLoad, units: SceneOptions['units'], decimals: number): string {
	return `${distributedValues(d, units, decimals).text} ${unitSymbol('distributed', units)}`;
}

/** "Point load 10 kN down at x = 2 m". */
function pointTooltip(p: PointLoad, units: SceneOptions['units'], decimals: number, pos: (x: number) => string): string {
	const value = `${formatInput(Math.abs(p.fy), 'force', units, decimals)} ${unitSymbol('force', units)}`;
	return `Point load ${value} ${p.fy < 0 ? 'down' : 'up'} at x = ${pos(p.x)}`;
}

/** "Moment 5 kN·m counter-clockwise at x = 3 m". */
function coupleTooltip(c: MomentLoad, units: SceneOptions['units'], decimals: number, pos: (x: number) => string): string {
	const value = `${formatInput(Math.abs(c.mz), 'moment', units, decimals)} ${unitSymbol('moment', units)}`;
	return `Moment ${value} ${c.mz > 0 ? 'counter-clockwise' : 'clockwise'} at x = ${pos(c.x)}`;
}

/** "Uniform load 4 kN/m down from x = 0 m to 6 m" or "Linearly varying load 0 → 6 kN/m down ...". */
function distributedTooltip(d: DistributedLoad, units: SceneOptions['units'], decimals: number, pos: (x: number) => string): string {
	const { down } = distributedValues(d, units, decimals);
	const kind = d.q1 === d.q2 ? 'Uniform load' : 'Linearly varying load';
	const from = pos(Math.min(d.x1, d.x2));
	const to = pos(Math.max(d.x1, d.x2));
	return `${kind} ${distributedText(d, units, decimals)} ${down ? 'down' : 'up'} from x = ${from} to ${to}`;
}

// ---------------------------------------------------------------------------
// Supports and reactions
// ---------------------------------------------------------------------------

/**
 * "Support A (pin) at x = 0 m: ..." describing what the support restrains.
 * Named like the rows of the results table, so the two can be matched up.
 */
function supportTooltip(s: Support, index: number, pos: (x: number) => string): string {
	const where = `Support ${supportName(index)} (${s.kind}) at x = ${pos(s.x)}`;
	switch (s.kind) {
		case 'pin':
			return `${where}: holds the beam in place but lets it rotate`;
		case 'roller':
			return `${where}: holds the beam vertically only`;
		case 'fixed':
			return `${where}: prevents movement and rotation`;
	}
}

/**
 * Draws one support below the beam (or, for a fixed end, as a wall across
 * the beam end with hatching on the outside).
 */
function drawSupport(
	s: Support,
	x: number,
	beamY: number,
	beamBottom: number,
	where: 'left' | 'right' | 'inside',
	tooltip: string,
	out: Prim[],
): void {
	if (s.kind === 'pin') {
		const baseY = beamBottom + PIN_H;
		out.push({
			tag: 'polygon',
			cls: 'bsd-support',
			attrs: { points: pointsAttr([[x, beamBottom], [x - PIN_HALF, baseY], [x + PIN_HALF, baseY]]) },
			tooltip,
		});
		out.push(linePrim('bsd-ground', x - GROUND_HALF, baseY, x + GROUND_HALF, baseY));
		out.push({ tag: 'path', cls: 'bsd-hatch', attrs: { d: hatchPath(x - GROUND_HALF, baseY, x + GROUND_HALF, baseY + HATCH_H, HATCH_STEP) } });
		return;
	}
	if (s.kind === 'roller') {
		const baseY = beamBottom + ROLLER_H;
		out.push({
			tag: 'polygon',
			cls: 'bsd-support',
			attrs: { points: pointsAttr([[x, beamBottom], [x - ROLLER_HALF, baseY], [x + ROLLER_HALF, baseY]]) },
			tooltip,
		});
		for (const dx of [-WHEEL_DX, WHEEL_DX]) {
			out.push({ tag: 'circle', cls: 'bsd-support', attrs: { cx: px(x + dx), cy: px(baseY + WHEEL_R), r: WHEEL_R } });
		}
		out.push(linePrim('bsd-ground', x - GROUND_HALF, baseY + 2 * WHEEL_R, x + GROUND_HALF, baseY + 2 * WHEEL_R));
		return;
	}
	if (where === 'inside') {
		// An interior clamp: a hatched block the beam passes through.
		const x0 = x - CLAMP_HALF_W;
		const y0 = beamY - CLAMP_HALF_H;
		out.push({
			tag: 'rect',
			cls: 'bsd-support',
			attrs: { x: px(x0), y: px(y0), width: 2 * CLAMP_HALF_W, height: 2 * CLAMP_HALF_H },
			tooltip,
		});
		out.push({ tag: 'path', cls: 'bsd-hatch', attrs: { d: hatchPath(x0, y0, x + CLAMP_HALF_W, beamY + CLAMP_HALF_H, HATCH_STEP) } });
		return;
	}
	// Fixed end: a wall perpendicular to the beam, hatched on the outside.
	const wall = linePrim('bsd-ground', x, beamY - WALL_HALF, x, beamY + WALL_HALF, tooltip);
	const hx0 = where === 'left' ? x - WALL_HATCH : x;
	out.push(wall);
	out.push({ tag: 'path', cls: 'bsd-hatch', attrs: { d: hatchPath(hx0, beamY - WALL_HALF, hx0 + WALL_HATCH, beamY + WALL_HALF, HATCH_STEP) } });
}

/**
 * Curved arrow for a fixed-support couple. At an end it sits on the outside
 * of the wall (left of a left end, right of a right end) so it never
 * crosses the loads; an interior clamp gets a 270 degree arc like an applied
 * couple. mz > 0 is counter-clockwise: on the left side of a circle that
 * means travelling downwards (120 to 240 degrees), on the right side upwards
 * (-60 to 60 degrees).
 */
function reactionCoupleArc(r: Reaction, where: 'left' | 'right' | 'inside', x: number, beamY: number, tooltip: string): Prim[] {
	const ccw = r.mz > 0;
	const [a, b] = where === 'left' ? [120, 240] : where === 'right' ? [-60, 60] : [-45, 225];
	const [from, to] = ccw ? [a, b] : [b, a];
	return arcArrow('bsd-reaction', 'bsd-arrowhead bsd-reaction-head', x, beamY, REACTION_ARC_R, from, to, tooltip);
}

// ---------------------------------------------------------------------------
// Dimension line and description
// ---------------------------------------------------------------------------

/**
 * Dimension line with a tick at every key point and position labels.
 * Labels that would overlap are skipped by priority: beam ends first, then
 * supports, hinges, point loads and couples, and distributed-load ends last.
 */
function dimensionPrims(
	model: BeamModel,
	L: number,
	eps: number,
	dimY: number,
	width: number,
	X: (x: number) => number,
	units: SceneOptions['units'],
	decimals: number,
): Prim[] {
	const candidates: { x: number; priority: number }[] = [
		{ x: 0, priority: 0 },
		{ x: L, priority: 0 },
		...model.supports.map((s) => ({ x: s.x, priority: 1 })),
		...model.hinges.map((h) => ({ x: h, priority: 2 })),
	];
	for (const load of model.loads) {
		if (load.kind === 'distributed') candidates.push({ x: load.x1, priority: 4 }, { x: load.x2, priority: 4 });
		else candidates.push({ x: load.x, priority: 3 });
	}
	// One tick per position (within the solver's merge tolerance), keeping its best priority.
	const ticks: { x: number; priority: number }[] = [];
	for (const c of candidates.filter((c) => Number.isFinite(c.x)).sort((a, b) => a.priority - b.priority)) {
		if (!ticks.some((t) => Math.abs(t.x - c.x) <= eps)) ticks.push(c);
	}

	const prims: Prim[] = [linePrim('bsd-dim', X(0), dimY, X(L), dimY)];
	const d = [...ticks]
		.sort((a, b) => a.x - b.x)
		.map((t) => `M ${px(X(t.x))} ${px(dimY - DIM_TICK)} L ${px(X(t.x))} ${px(dimY + DIM_TICK)}`)
		.join(' ');
	prims.push({ tag: 'path', cls: 'bsd-dim', attrs: { d } });

	const accepted: PlacedText[] = [];
	for (const t of ticks) {
		const text = formatPosition(t.x, units, decimals);
		const placed = placeText(X(t.x), dimY + DIM_LABEL_DY, text, LAYOUT.smallFontSize, width);
		if (accepted.some((other) => boxesOverlap(placed.box, other.box, 4))) continue;
		accepted.push(placed);
		prims.push(textPrim('bsd-dim-label', placed, text));
	}
	return prims;
}

/** Screen reader summary: length, supports, hinges, loads and (when solved) reactions. */
function describeBeam(
	model: BeamModel,
	L: number,
	units: SceneOptions['units'],
	decimals: number,
	pos: (x: number) => string,
	reactions: readonly string[],
): string {
	const parts: string[] = [`Beam ${pos(L)} long.`];
	if (model.supports.length > 0) {
		parts.push(`Supports: ${model.supports.map((s, i) => `${supportName(i)} (${s.kind}) at ${pos(s.x)}`).join(', ')}.`);
	}
	if (model.hinges.length > 0) parts.push(`Hinges at ${model.hinges.map(pos).join(', ')}.`);
	const loads = model.loads.map((load) => {
		if (load.kind === 'point') return pointTooltip(load, units, decimals, pos).replace('Point load', 'point load');
		if (load.kind === 'moment') return coupleTooltip(load, units, decimals, pos).replace('Moment', 'moment');
		return distributedTooltip(load, units, decimals, pos).replace(/^Uniform/, 'uniform').replace(/^Linearly/, 'linearly');
	});
	parts.push(loads.length > 0 ? `Loads: ${loads.join('; ')}.` : 'No loads.');
	if (reactions.length > 0) parts.push(`Reactions: ${reactions.join(', ')}.`);
	return parts.join(' ');
}
