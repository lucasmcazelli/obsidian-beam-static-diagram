/**
 * Schematic drawing of the beam: supports, hinges, loads, reactions, dimensions.
 *
 * Vertical layout, top to bottom (y grows downwards):
 *
 *   load label rows      point-load and couple labels, one row per level of
 *                        overlap; a label pushed up a row gets a leader line
 *                        down to its arrow
 *   loads                point arrows, couples and distributed bands, each band
 *                        with a label line right above its outline
 *   beam                 thick line at y = beamY
 *   supports             pin / roller triangles, ground hatching
 *   reactions            arrows below the supports, value label rows
 *   dimension line       ticks at every key point, position labels
 *
 * The horizontal mapping comes from createXLayout, exactly as in the diagrams,
 * so a support drawn here sits right above the matching jump in the shear
 * diagram. Every primitive carries bsd-* classes only; colours live in styles.css.
 */
import { forceScale } from '../core/scale';
import { POSITION_TOL } from '../core/tolerances';
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
	verticalLine,
} from './draw';
import type { ArrowStyle, Box, PlacedText } from './draw';
import { createXLayout, LAYOUT, px } from './scene';
import type { Prim, Scene, SceneOptions } from './scene';

// ---------------------------------------------------------------------------
// Layout constants [px]
// ---------------------------------------------------------------------------

/** Empty space above the first label row. */
const PAD_TOP = 6;
/** Height of one load label row (11 px text plus spacing). */
const LOAD_ROW_H = 15;
/** A row label's baseline sits this far above the bottom of its row (room for descenders). */
const LOAD_LABEL_DESCENT = 4;
/** Gap between the lowest label row and the top of the loads. */
const LOAD_TOP_GAP = 2;
/** Smallest horizontal gap between two labels in the same row. */
const LABEL_GAP = 8;
/** Half the beam stroke width (styles.css draws .bsd-beam 4 px wide). */
const BEAM_HALF = 2;
/** Arrows that touch the beam stop this far above its top edge, so the tip stays visible. */
const ARROW_TIP_GAP = 1;
/** Length of point load arrows when nothing else is in the way. */
const POINT_LEN = 42;
/** A point arrow extends this far above the tallest distributed band, so it reads as separate. */
const POINT_OVER_DIST = 14;
/**
 * Point-load arrowheads are larger than the 7 px heads of distributed-load
 * arrows (and their shafts thicker, see .bsd-point in styles.css), so a point
 * load inside a distributed load still stands out.
 */
const POINT_HEAD_LEN = 9;
const POINT_HEAD_HALF = 4.5;
/**
 * A distributed-load arrow is left out when it would fall closer than this
 * to a point-load arrow: the head half widths (4.5 + 3.5 px) plus a 2 px gap,
 * so the two heads never touch. At a band end the point arrow replaces the
 * end arrow.
 */
const POINT_CLEAR = 10;
/**
 * Point loads closer than COINCIDENT_PX (in practice: at the same position)
 * are spread COINCIDENT_DX apart, so each keeps its own arrow instead of two
 * loads drawing one double-headed line.
 */
const COINCIDENT_PX = 2;
const COINCIDENT_DX = 8;
/** A leader from a higher label row down to its point arrow starts this far below the label's baseline. */
const LEADER_GAP = 3;
/** Where a leader or point arrow passes a label it is left out over the label's box grown by this much. */
const LEADER_GAP_PAD = 1;
/** Height of the band drawn for the largest distributed load. */
const DIST_H = 26;
/**
 * Every distributed band has a label line this tall right above its outline,
 * so stacked (overlapping) bands sit DIST_H + DIST_LABEL_H apart and each
 * label stays next to its own band.
 */
const DIST_LABEL_H = LOAD_ROW_H;
/** A distributed-load label's baseline sits this far above the highest point of the outline under it. */
const DIST_LABEL_GAP = 4;
/** Where along a band its label is tried, in order (share of the band length from its left end). */
const BAND_LABEL_SPOTS = [0.5, 0.25, 0.75] as const;
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
/** Room kept above an applied couple arc for its stroke and arrowhead. */
const COUPLE_CLEARANCE = 2;
/**
 * Applied couple arcs [degrees, counter-clockwise from +x]: about 270 degrees
 * with the gap at the bottom, where the supports are. At a support the arc
 * is shortened to 220 degrees so its ends (and the arrowhead) stay clear of
 * the support symbol.
 */
const COUPLE_ARC: readonly [number, number] = [-45, 225];
const COUPLE_ARC_AT_SUPPORT: readonly [number, number] = [-20, 200];
/** Distributed-load arrows closer than this to an applied couple would cross its arc. */
const COUPLE_CLEAR = COUPLE_R + 4;
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
/** A distributed-load end arrow that would lie on a fixed-end wall line is moved this far into the band. */
const WALL_INSET = 3;
/** Spacing of hatch strokes. */
const HATCH_STEP = 4;
/** Hinge circle radius. */
const HINGE_R = 4;
/** Distributed-load arrows closer than this to a hinge would point into its circle. */
const HINGE_CLEAR = HINGE_R + 3;
/** Depth of the support symbols below the beam (the pin with its hatching is the deepest). */
const SUPPORT_ZONE = PIN_H + HATCH_H;
/** Reaction arrows: gap below the supports, arrow length, label row height, couple arc radius. */
const REACTION_GAP = 4;
const REACTION_LEN = 26;
const REACTION_ROW_H = 13;
const REACTION_ARC_R = 20;
/** Baseline of the first reaction label row below the arrow ends, and the descent kept below the last row. */
const REACTION_LABEL_DY = 12;
const REACTION_LABEL_DESCENT = 3;
/**
 * Distributed-load arrows closer than this to an interior clamp would run
 * into the clamp block or into the ends of its reaction arc (radius
 * REACTION_ARC_R, ends 45 degrees above the axis, plus the arrowhead).
 */
const CLAMP_CLEAR = REACTION_ARC_R + 2;
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
	/** Where a support at x [m] sits: at the left end, at the right end or in between. */
	const placeOf = (x: number): SupportPlace => (x <= eps ? 'left' : x >= L - eps ? 'right' : 'inside');

	const points = model.loads.filter((l): l is PointLoad => l.kind === 'point');
	const couples = model.loads.filter((l): l is MomentLoad => l.kind === 'moment');
	const distributed = model.loads.filter((l): l is DistributedLoad => l.kind === 'distributed');
	const pointArrows = pointArrowXs(points, X);

	// --- Heights of the load drawings -------------------------------------
	const levels = distributedLevels(distributed, eps);
	const levelCount = levels.length > 0 ? Math.max(...levels) + 1 : 0;
	// Each band has its own label line above it, which sets the stack pitch.
	const levelPitch = DIST_H + DIST_LABEL_H;
	const distStack = levelCount > 0 ? levelCount * DIST_H + (levelCount - 1) * DIST_LABEL_H : 0;
	const distZone = levelCount > 0 ? distStack + DIST_LABEL_H : 0;
	// Point arrows start above every distributed band so they never hide inside one.
	const pointLen = points.length > 0 ? Math.max(POINT_LEN, distStack + POINT_OVER_DIST) : 0;
	const coupleAbove = couples.length > 0 ? COUPLE_R + COUPLE_CLEARANCE - BEAM_HALF : 0;
	const loadZone = Math.max(MIN_ABOVE, pointLen, distZone, coupleAbove);

	// --- Distributed-load labels: each right above its own band -----------
	// Placed before the label rows exist, so with y measured from the beam
	// top (beamTop = 0) and shifted once the layout is known. Kept clear of
	// the point arrows, and for the lowest band of the couple arcs. A label
	// that finds no spot clear of the other labels (patch loads narrower than
	// their labels) goes to the label rows instead of overlapping.
	const qmax = Math.max(0, ...distributed.map((d) => Math.max(Math.abs(d.q1), Math.abs(d.q2))));
	const bands = distributed.map((d) => bandOf(d, qmax, X));
	const baseOffsets = distributed.map((_, i) => -(levels[i] ?? 0) * levelPitch);
	const pointSpans: Span[] = pointArrows.map((a) => [a.x, a.x]);
	const coupleSpans: Span[] = couples.map((c) => [X(c.x) - COUPLE_R, X(c.x) + COUPLE_R]);
	const bandLabels: { placed: PlacedText; text: string; tooltip: string }[] = [];
	const rowLabels: RowLabel[] = collectRowLabels(points, pointArrows, couples, units, decimals, pos, X);
	distributed.forEach((d, i) => {
		const band = bands[i];
		if (!band) return;
		const level = levels[i] ?? 0;
		const text = distributedText(d, units, decimals);
		const tooltip = distributedTooltip(d, units, decimals, pos);
		const sameLevel = bands.filter((_, k) => (levels[k] ?? 0) === level);
		const avoid = level === 0 ? [...pointSpans, ...coupleSpans] : pointSpans;
		const taken = bandLabels.map((l) => l.placed.box);
		const placed = placeBandLabel(text, band, sameLevel, baseOffsets[i] ?? 0, avoid, taken, width);
		if (placed) bandLabels.push({ placed, text, tooltip });
		else rowLabels.push({ x: 0.5 * (band.a + band.b), text, tooltip });
	});

	// --- Point-load, couple and left-over band labels, packed into rows -----
	rowLabels.sort((a, b) => a.x - b.x);
	const rows = packRows(
		rowLabels.map((l) => placeText(l.x, 0, l.text, LAYOUT.fontSize, width).box),
		LABEL_GAP,
	);
	const rowCount = rows.length > 0 ? Math.max(...rows) + 1 : 0;

	// --- Vertical positions -----------------------------------------------
	const labelsBottom = PAD_TOP + rowCount * LOAD_ROW_H;
	const loadTop = rowCount > 0 ? labelsBottom + LOAD_TOP_GAP : PAD_TOP;
	const beamTop = loadTop + loadZone;
	const beamY = beamTop + BEAM_HALF;
	const beamBottom = beamY + BEAM_HALF;
	const supportBottom = beamBottom + SUPPORT_ZONE;
	/** Baseline of label row `row`: row 0 sits just above the loads, further rows stack upwards. */
	const rowBaseline = (row: number): number => labelsBottom - LOAD_LABEL_DESCENT - row * LOAD_ROW_H;

	const back: Prim[] = [];
	const front: Prim[] = [];
	const labels: Prim[] = [];
	/** Load labels with their anchor x, written left to right at the end. */
	const loadLabels: { x: number; prim: Prim }[] = [];
	/** Boxes of every load label placed so far, for the collision tests below. */
	const labelBoxes: Box[] = [];

	const rowPlaced = rowLabels.map((l, i) => placeText(l.x, rowBaseline(rows[i] ?? 0), l.text, LAYOUT.fontSize, width));
	rowLabels.forEach((l, i) => {
		const placed = rowPlaced[i];
		if (!placed) return;
		loadLabels.push({ x: placed.x, prim: textPrim('bsd-load-label', placed, l.text, l.tooltip) });
		labelBoxes.push(placed.box);
	});
	for (const l of bandLabels) {
		// Shift from the beam-top frame to the drawing.
		const { box } = l.placed;
		const placed: PlacedText = { ...l.placed, y: l.placed.y + beamTop, box: { ...box, y0: box.y0 + beamTop, y1: box.y1 + beamTop } };
		loadLabels.push({ x: placed.x, prim: textPrim('bsd-load-label', placed, l.text, l.tooltip) });
		labelBoxes.push(placed.box);
	}

	// --- Distributed loads (fill behind the beam, arrows in front) ---------
	const bases = baseOffsets.map((offset) => beamTop + offset);
	// Distributed-load arrows are left out where they would run into something
	// at the same x. Point arrows cross every band; couples, hinges and clamps
	// sit on the beam, so only the lowest band (level 0) reaches them.
	const pointClear: Clearance[] = pointArrows.map((a) => ({ x: a.x, r: POINT_CLEAR }));
	const beamClear: Clearance[] = [
		...couples.map((c) => ({ x: X(c.x), r: COUPLE_CLEAR })),
		...model.hinges.map((h) => ({ x: X(h), r: HINGE_CLEAR })),
		...model.supports.filter((s) => s.kind === 'fixed' && placeOf(s.x) === 'inside').map((s) => ({ x: X(s.x), r: CLAMP_CLEAR })),
	];
	const walls = model.supports.filter((s) => s.kind === 'fixed' && placeOf(s.x) !== 'inside').map((s) => X(s.x));
	distributed.forEach((d, i) => {
		const band = bands[i];
		if (!band) return;
		const lowest = (levels[i] ?? 0) === 0;
		const skip = lowest ? [...pointClear, ...beamClear] : pointClear;
		drawDistributed(band, bases[i] ?? beamTop, back, front, distributedTooltip(d, units, decimals, pos), skip, lowest ? walls : []);
	});

	// --- Beam --------------------------------------------------------------
	const beam = linePrim('bsd-beam', X(0), beamY, X(L), beamY);
	beam.tooltip = `Beam, ${pos(L)} long`;
	back.push(beam);

	// --- Supports and hinges ------------------------------------------------
	model.supports.forEach((s, i) => {
		drawSupport(s, X(s.x), beamY, beamBottom, placeOf(s.x), supportTooltip(s, i, pos), back);
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
	const labelOfPoint = new Map<number, number>();
	rowLabels.forEach((l, j) => {
		if (l.point !== undefined) labelOfPoint.set(l.point, j);
	});
	/** Vertical extents of the labels a vertical line at x passes, other than `own`, padded. */
	const gapsAt = (x: number, own?: Box): [number, number][] =>
		labelBoxes
			.filter((b) => b !== own && b.x0 - LEADER_GAP_PAD <= x && x <= b.x1 + LEADER_GAP_PAD)
			.map((b): [number, number] => [b.y0 - LEADER_GAP_PAD, b.y1 + LEADER_GAP_PAD]);
	points.forEach((p, i) => {
		const x = pointArrows[i]?.x ?? X(p.x);
		const far = beamTop - pointLen;
		const near = beamTop - ARROW_TIP_GAP;
		const tooltip = pointTooltip(p, units, decimals, pos);
		// A band label that found no spot clear of every arrow leaves a gap in
		// the shaft rather than being struck through.
		const style: ArrowStyle = { headLen: POINT_HEAD_LEN, headHalf: POINT_HEAD_HALF, gaps: gapsAt(x) };
		// Down loads end at the top of the beam; up loads start there and point away.
		front.push(
			...(p.fy < 0
				? verticalArrow('bsd-load bsd-point', 'bsd-arrowhead', x, far, near, tooltip, style)
				: verticalArrow('bsd-load bsd-point', 'bsd-arrowhead', x, near, far, tooltip, style)),
		);
		// A label pushed into a higher row (loads closer than a label width)
		// gets a thin leader down to its arrow, so it never floats above someone
		// else's arrow. Where the leader passes another label it is left out
		// instead of striking through the text.
		const j = labelOfPoint.get(i);
		const row = j === undefined ? 0 : (rows[j] ?? 0);
		if (j === undefined || row === 0) return;
		front.push(...verticalLine('bsd-load bsd-leader', x, rowBaseline(row) + LEADER_GAP, far, gapsAt(x, rowPlaced[j]?.box), tooltip));
	});
	for (const c of couples) {
		// The head shows the sense of rotation; see COUPLE_ARC for the shapes.
		const atSupport = model.supports.some((s) => Math.abs(s.x - c.x) <= eps);
		const [a, b] = atSupport ? COUPLE_ARC_AT_SUPPORT : COUPLE_ARC;
		const [from, to] = c.mz > 0 ? [a, b] : [b, a];
		front.push(...arcArrow('bsd-load bsd-moment', 'bsd-arrowhead', X(c.x), beamY, COUPLE_R, from, to, coupleTooltip(c, units, decimals, pos)));
	}
	// Left to right, so the text order in the SVG follows the drawing.
	labels.push(...loadLabels.sort((a, b) => a.x - b.x).map((l) => l.prim));

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
			// The letter ties the value to its row in the results table; tooltips
			// alone would not do on touch screens.
			items.push({ x, text: `${name} ${force}`, tooltip });
			reactionSummary.push(`${name} ${force}${direction}`);

			if (r.kind === 'fixed' && Math.abs(r.mz) > ZERO_TOL * scale * L) {
				const couple = formatQuantity(Math.abs(r.mz), 'moment', units, decimals);
				const sense = r.mz > 0 ? 'counter-clockwise' : 'clockwise';
				const coupleTip = `Reaction moment at support ${name} (x = ${pos(r.x)}): ${couple} ${sense}`;
				front.push(...reactionCoupleArc(r, placeOf(r.x), x, beamY, coupleTip));
				// The open circle arrow ties the label to the curved arrow at the support.
				coupleItems.push({ x, text: `${r.mz > 0 ? '↺' : '↻'} ${couple}`, tooltip: coupleTip });
				reactionSummary.push(`${name} ${couple} ${sense}`);
			}
		}
		// Force labels first so they take the row right under the arrows.
		const all = [...items.sort((a, b) => a.x - b.x), ...coupleItems.sort((a, b) => a.x - b.x)];
		const placed = all.map((item) => placeText(item.x, 0, item.text, LAYOUT.fontSize, width));
		const reactionRowOf = packRows(
			placed.map((p) => p.box),
			LABEL_GAP,
		);
		const firstBaseline = reactionBottom + REACTION_LABEL_DY;
		all.forEach((item, i) => {
			const p = placed[i];
			if (!p) return;
			const y = firstBaseline + (reactionRowOf[i] ?? 0) * REACTION_ROW_H;
			labels.push(textPrim('bsd-reaction-label', { ...p, y }, item.text, item.tooltip));
		});
		const reactionRows = reactionRowOf.length > 0 ? Math.max(...reactionRowOf) + 1 : 0;
		reactionsBottom = reactionRows > 0 ? firstBaseline + (reactionRows - 1) * REACTION_ROW_H + REACTION_LABEL_DESCENT : reactionBottom;
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

/** Where a support sits along the beam. */
type SupportPlace = 'left' | 'right' | 'inside';

/** Something drawn at pixel x that distributed-load arrows keep r px away from. */
interface Clearance {
	x: number;
	r: number;
}

/** A horizontal pixel range [x0, x1] that a label keeps clear of. */
type Span = [number, number];

/**
 * A label for the label rows before placement (a point load, a couple, or a
 * band label that did not fit on its band): anchor x [px], text, tooltip
 * and, for a point load, its index.
 */
interface RowLabel {
	x: number;
	text: string;
	tooltip: string;
	point?: number;
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
 * Pixel x of every point-load arrow, and whether its load shares its
 * position with a load of the other direction. Loads whose x differ by less
 * than COINCIDENT_PX form a group; a group of n is spread symmetrically,
 * COINCIDENT_DX apart (left to right, ties in input order), so loads at one
 * position (dead plus live, or one up and one down) keep one arrow each.
 */
function pointArrowXs(points: readonly PointLoad[], X: (x: number) => number): { x: number; mixed: boolean }[] {
	const out = points.map((p) => ({ x: X(p.x), mixed: false }));
	const order = out.map((o, i) => ({ x: o.x, i })).sort((a, b) => a.x - b.x || a.i - b.i);
	let start = 0;
	for (let k = 1; k <= order.length; k++) {
		const prev = order[k - 1];
		const cur = order[k];
		if (cur && prev && cur.x - prev.x < COINCIDENT_PX) continue;
		// order[start..k) is one group.
		const group = order.slice(start, k);
		const down = group.filter((g) => (points[g.i]?.fy ?? 0) < 0).length;
		const mixed = down > 0 && down < group.length;
		group.forEach((g, j) => {
			out[g.i] = { x: g.x + (j - (group.length - 1) / 2) * COINCIDENT_DX, mixed };
		});
		start = k;
	}
	return out;
}

/** Geometry of one distributed load, shared by its drawing and its label. */
interface Band {
	/** Left and right end [px]. */
	a: number;
	b: number;
	/** Intensity at the left and right end (model sign: positive up). */
	qa: number;
	qb: number;
	/** False when every distributed load is zero: nothing is drawn, only the label. */
	drawn: boolean;
	/** Drawn height [px] of the outline above the band base for intensity q. */
	h: (q: number) => number;
}

/**
 * Band geometry of a distributed load. Arrow length is proportional to |q|,
 * scaled by the largest |q| of all distributed loads (qmax). A load whose
 * peak is below DIST_MIN_SHARE of qmax is scaled up as a whole (factor k) so
 * it stays visible, which keeps the shape of a triangular load exact.
 */
function bandOf(d: DistributedLoad, qmax: number, X: (x: number) => number): Band {
	// Left end first, whatever order the model gave.
	const [xa, qa, xb, qb] = d.x1 <= d.x2 ? [d.x1, d.q1, d.x2, d.q2] : [d.x2, d.q2, d.x1, d.q1];
	const peak = Math.max(Math.abs(qa), Math.abs(qb));
	if (!(qmax > 0) || !(peak > 0)) return { a: X(xa), b: X(xb), qa, qb, drawn: false, h: () => 0 };
	const k = Math.max(1, (DIST_MIN_SHARE * qmax) / peak);
	return { a: X(xa), b: X(xb), qa, qb, drawn: true, h: (q) => (DIST_H * Math.abs(q) * k) / qmax };
}

/** Intensity of a band at pixel x: linear between its ends, clamped to the band. */
function bandQ(band: Band, x: number): number {
	const len = band.b - band.a;
	// A zero-length band (a point at this scale): take its larger end.
	if (!(len > 0)) return Math.abs(band.qa) >= Math.abs(band.qb) ? band.qa : band.qb;
	const t = Math.min(1, Math.max(0, (x - band.a) / len));
	return band.qa + (band.qb - band.qa) * t;
}

/**
 * Draws one distributed load whose band sits on y = base: a translucent fill
 * (bsd-dist), the top outline (bsd-load) and a row of arrows (about
 * DIST_SPACING apart, at least 3 before any are left out). A load that
 * changes sign is drawn with arrows pointing down where q < 0 and up where
 * q > 0.
 *
 * Arrows within a Clearance of `skip` are left out (a point-load arrow
 * replaces them; a couple arc, hinge or clamp would be crossed), and an end
 * arrow on one of the fixed-end `walls` [px] is moved WALL_INSET into the band.
 */
function drawDistributed(
	band: Band,
	base: number,
	back: Prim[],
	front: Prim[],
	tooltip: string,
	skip: readonly Clearance[],
	walls: readonly number[],
): void {
	if (!band.drawn) return;
	const { a, b, qa, qb, h } = band;

	// Outline through both ends and, for a sign change, the zero at
	// t = qa / (qa - qb) along the load (where the linear q(x) vanishes).
	const outline: [number, number][] = [[a, base - h(qa)]];
	if (qa * qb < 0) outline.push([a + ((b - a) * qa) / (qa - qb), base]);
	outline.push([b, base - h(qb)]);

	back.push({ tag: 'polygon', cls: 'bsd-dist', attrs: { points: pointsAttr([[a, base], ...outline, [b, base]]) }, tooltip });
	front.push({ tag: 'polyline', cls: 'bsd-load', attrs: { points: pointsAttr(outline) } });

	// A band end on a wall: within a pixel of it (both are X() of positions within the merge tolerance).
	const onWall = (x: number): boolean => walls.some((w) => Math.abs(w - x) < 1);
	const n = Math.max(3, Math.round((b - a) / DIST_SPACING) + 1);
	for (let i = 0; i < n; i++) {
		let x = a + ((b - a) * i) / (n - 1);
		if (i === 0 && onWall(a)) x += WALL_INSET;
		if (i === n - 1 && onWall(b)) x -= WALL_INSET;
		if (skip.some((c) => Math.abs(c.x - x) < c.r)) continue;
		const q = bandQ(band, x);
		const len = h(q);
		if (len < DIST_MIN_ARROW) continue;
		// q < 0 is a downward load: arrow from the outline down to the band base.
		const arrow =
			q < 0
				? verticalArrow('bsd-load', 'bsd-arrowhead', x, base - len, base - ARROW_TIP_GAP)
				: verticalArrow('bsd-load', 'bsd-arrowhead', x, base - ARROW_TIP_GAP, base - len);
		front.push(...arrow);
	}
}

/**
 * Places a distributed-load label right above its own band, so it reads as
 * belonging to that band even in a stack. `base` is the band's base y. The
 * spots in BAND_LABEL_SPOTS are tried in order: the first whose box keeps
 * LABEL_GAP clear of every span in `avoid` (point-load arrows, couple arcs)
 * and of the labels in `taken` wins; failing that, the first clear of the
 * labels. Returns undefined when every spot overlaps a label, and the
 * caller moves the label to the label rows.
 *
 * The baseline sits DIST_LABEL_GAP above the highest outline under the
 * label among the bands of its level (`sameLevel`, its own included): a
 * sloping outline, or a taller patch load next to a narrow one, would
 * otherwise cut into the text. |q| is linear on each side of a sign change,
 * so a band's highest point under the box is at one of the box ends clamped
 * to the band. Bands of other levels never reach the label line.
 */
function placeBandLabel(
	text: string,
	band: Band,
	sameLevel: readonly Band[],
	base: number,
	avoid: readonly Span[],
	taken: readonly Box[],
	width: number,
): PlacedText | undefined {
	const spot = (t: number): PlacedText => {
		const x = band.a + (band.b - band.a) * t;
		const { box } = placeText(x, 0, text, LAYOUT.fontSize, width);
		let top = 0;
		for (const other of sameLevel) {
			const x0 = Math.max(box.x0, other.a);
			const x1 = Math.min(box.x1, other.b);
			if (x0 > x1) continue;
			top = Math.max(top, other.h(bandQ(other, x0)), other.h(bandQ(other, x1)));
		}
		return placeText(x, base - top - DIST_LABEL_GAP, text, LAYOUT.fontSize, width);
	};
	const spots = BAND_LABEL_SPOTS.map(spot);
	const clearOfSpans = (p: PlacedText): boolean => avoid.every(([s0, s1]) => p.box.x1 + LABEL_GAP <= s0 || p.box.x0 - LABEL_GAP >= s1);
	// LABEL_GAP applies sideways only: bands of a stack have their labels a few px apart vertically by design.
	const clearOfLabels = (p: PlacedText): boolean =>
		!taken.some((t) => p.box.x0 < t.x1 + LABEL_GAP && t.x0 < p.box.x1 + LABEL_GAP && p.box.y0 < t.y1 && t.y0 < p.box.y1);
	return spots.find((p) => clearOfSpans(p) && clearOfLabels(p)) ?? spots.find(clearOfLabels);
}

/**
 * Labels of the point loads (at their arrows) and couples, for the label
 * rows. Up and down loads sharing a position get an arrow symbol each, since
 * the labels would otherwise not say which is which.
 */
function collectRowLabels(
	points: readonly PointLoad[],
	arrows: readonly { x: number; mixed: boolean }[],
	couples: readonly MomentLoad[],
	units: SceneOptions['units'],
	decimals: number,
	pos: (x: number) => string,
	X: (x: number) => number,
): RowLabel[] {
	const out: RowLabel[] = [];
	points.forEach((p, i) => {
		const arrow = arrows[i];
		const value = `${formatInput(Math.abs(p.fy), 'force', units, decimals)} ${unitSymbol('force', units)}`;
		const text = arrow?.mixed ? `${value} ${p.fy < 0 ? '↓' : '↑'}` : value;
		out.push({ x: arrow?.x ?? X(p.x), text, tooltip: pointTooltip(p, units, decimals, pos), point: i });
	});
	for (const c of couples) {
		out.push({ x: X(c.x), text: coupleText(c, units, decimals), tooltip: coupleTooltip(c, units, decimals, pos) });
	}
	return out;
}

/**
 * "↺ 5 kN·m": the open circle arrow gives the sense of rotation, as on the
 * reaction couples, so it does not rest on a 7 px arrowhead alone.
 */
function coupleText(c: MomentLoad, units: SceneOptions['units'], decimals: number): string {
	return `${c.mz > 0 ? '↺' : '↻'} ${formatInput(Math.abs(c.mz), 'moment', units, decimals)} ${unitSymbol('moment', units)}`;
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
	where: SupportPlace,
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
 * crosses the loads. mz > 0 is counter-clockwise: on the left side of a
 * circle that means travelling downwards (120 to 240 degrees), on the right
 * side upwards (-60 to 60 degrees). An interior clamp gets a 270 degree arc
 * from 135 to 405 (= 45) degrees: below the beam, with its gap at the top
 * where the loads are, so it does not run through distributed-load arrows.
 */
function reactionCoupleArc(r: Reaction, where: SupportPlace, x: number, beamY: number, tooltip: string): Prim[] {
	const ccw = r.mz > 0;
	const [a, b] = where === 'left' ? [120, 240] : where === 'right' ? [-60, 60] : [135, 405];
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
