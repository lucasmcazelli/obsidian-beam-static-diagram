/**
 * Cross-section property formulas.
 *
 * All shapes are doubly symmetric and bend about their horizontal axis
 * (loads act in the vertical plane), so the neutral axis is at mid depth and
 * the extreme fibre distance is c = h / 2 (or d / 2 for round shapes).
 * Hollow and I shapes use "outer rectangle minus inner rectangle" (or circle).
 */
import { ownValue } from './lookup';
import type { SectionProps, SectionShape } from './types';

/** Metadata used by the parser, serializer and editor. */
export interface SectionShapeInfo {
	shape: SectionShape;
	/** Display name, e.g. "Rectangle". */
	label: string;
	/** Dimension names in order, e.g. ["b", "h"]. */
	dims: string[];
	/** Longer descriptions for the editor, e.g. ["Width b", "Depth h"]. */
	dimLabels: string[];
	/** Example dimensions as typed after the shape, e.g. "100 x 200 mm". */
	example: string;
}

/** Every built-in shape with its dimension order. */
export const SECTION_SHAPES: Record<SectionShape, SectionShapeInfo> = {
	rect: {
		shape: 'rect',
		label: 'Rectangle',
		dims: ['b', 'h'],
		dimLabels: ['Width b', 'Depth h'],
		example: '100 x 200 mm',
	},
	circle: {
		shape: 'circle',
		label: 'Solid circle',
		dims: ['d'],
		dimLabels: ['Diameter d'],
		example: '100 mm',
	},
	tube: {
		shape: 'tube',
		label: 'Circular tube',
		dims: ['d', 't'],
		dimLabels: ['Diameter d', 'Wall thickness t'],
		example: '60 x 5 mm',
	},
	box: {
		shape: 'box',
		label: 'Rectangular box',
		dims: ['b', 'h', 't'],
		dimLabels: ['Width b', 'Depth h', 'Wall thickness t'],
		example: '100 x 200 x 10 mm',
	},
	ibeam: {
		shape: 'ibeam',
		label: 'I-beam (no fillets)',
		dims: ['b', 'h', 'tw', 'tf'],
		dimLabels: ['Width b', 'Depth h', 'Web thickness tw', 'Flange thickness tf'],
		example: '150 x 300 x 7.1 x 10.7 mm',
	},
};

/**
 * Shape names accepted by the parser (lower case). Common engineering
 * abbreviations map to the built-in shapes: CHS = circular hollow section,
 * RHS/SHS = rectangular/square hollow section.
 */
export const SECTION_SHAPE_ALIASES: Record<string, SectionShape> = {
	rect: 'rect',
	rectangle: 'rect',
	circle: 'circle',
	round: 'circle',
	'solid-circle': 'circle',
	tube: 'tube',
	pipe: 'tube',
	chs: 'tube',
	box: 'box',
	rhs: 'box',
	shs: 'box',
	ibeam: 'ibeam',
	'i-beam': 'ibeam',
	i: 'ibeam',
	h: 'ibeam',
	'wide-flange': 'ibeam',
};

/** Finds a shape by name or alias, case-insensitive. */
export function findSectionShape(name: string): SectionShape | undefined {
	return ownValue(SECTION_SHAPE_ALIASES, name.trim().toLowerCase());
}

/**
 * Error text for a wrong number of dimensions, shared by the parser and
 * `computeSection`: "Rectangle needs 2 dimensions (b x h), for example: section rect 100 x 200 mm".
 */
export function dimensionCountMessage(shape: SectionShape): string {
	const info = SECTION_SHAPES[shape];
	const n = info.dims.length;
	return `${info.label} needs ${n} dimension${n === 1 ? '' : 's'} (${info.dims.join(' x ')}), for example: section ${shape} ${info.example}`;
}

/** Builds the result object; `label` is the plain shape name. */
function props(shape: SectionShape, dims: number[], I: number, c: number, area: number): SectionProps {
	return { shape, dims: [...dims], I, c, area, label: SECTION_SHAPES[shape].label };
}

/**
 * Computes I, c and area for a shape. `dims` are in metres, in the order of
 * SECTION_SHAPES[shape].dims. Returns an error message for impossible
 * geometry (non-positive dims, wall thicker than half the section, ...).
 * The returned `label` is a plain shape name; the model builder replaces it
 * with a unit-aware description.
 *
 * Formulas (I about the horizontal centroidal axis):
 * - rect b x h:          I = b h^3 / 12,                        A = b h
 * - circle d:            I = pi d^4 / 64,                       A = pi d^2 / 4
 * - tube d x t:          I = pi (d^4 - di^4) / 64, di = d - 2t, A = pi (d^2 - di^2) / 4
 * - box b x h x t:       I = (b h^3 - (b - 2t)(h - 2t)^3) / 12, A = b h - (b - 2t)(h - 2t)
 * - ibeam b x h x tw x tf: I = (b h^3 - (b - tw)(h - 2tf)^3) / 12, A = 2 b tf + (h - 2tf) tw
 *
 * The I-beam formula ignores the root fillets between web and flanges, so it
 * slightly underestimates rolled sections: IPE 300 (150 x 300 x 7.1 x 10.7)
 * gives 7999 cm^4 against the catalogue 8356 cm^4 (about 4.3% less). For
 * rolled profiles, enter the catalogue value with `I` instead.
 *
 * Dimensions near the limits of double precision can overflow I (it grows
 * with the fourth power of the size) to Infinity or underflow it to 0, which
 * would silently disable deflection or print "I = Infinity"; such results
 * are returned as an error instead.
 */
export function computeSection(shape: SectionShape, dims: number[]): SectionProps | { error: string } {
	if (dims.length !== SECTION_SHAPES[shape].dims.length) return { error: dimensionCountMessage(shape) };
	if (dims.some((d) => !Number.isFinite(d) || d <= 0)) {
		return { error: 'Section dimensions must be greater than zero' };
	}
	const result = shapeProps(shape, dims);
	if ('error' in result) return result;
	const usable = (v: number): boolean => Number.isFinite(v) && v > 0;
	if (!usable(result.I) || !usable(result.area)) {
		return { error: 'The section properties cannot be computed for these dimensions: check their size and unit' };
	}
	return result;
}

/** The formulas of computeSection, for dimensions already checked to be positive and finite. */
function shapeProps(shape: SectionShape, dims: number[]): SectionProps | { error: string } {
	switch (shape) {
		case 'rect': {
			const [b = 0, h = 0] = dims;
			return props(shape, dims, (b * h ** 3) / 12, h / 2, b * h);
		}
		case 'circle': {
			const [d = 0] = dims;
			return props(shape, dims, (Math.PI * d ** 4) / 64, d / 2, (Math.PI * d ** 2) / 4);
		}
		case 'tube': {
			const [d = 0, t = 0] = dims;
			// t = d/2 would be a solid circle; larger walls overlap the centre.
			if (t >= d / 2) return { error: 'The wall thickness t must be less than half the diameter d' };
			const di = d - 2 * t;
			return props(shape, dims, (Math.PI * (d ** 4 - di ** 4)) / 64, d / 2, (Math.PI * (d ** 2 - di ** 2)) / 4);
		}
		case 'box': {
			const [b = 0, h = 0, t = 0] = dims;
			if (t >= Math.min(b, h) / 2) {
				return { error: 'The wall thickness t must be less than half of both the width b and the depth h' };
			}
			const bi = b - 2 * t;
			const hi = h - 2 * t;
			return props(shape, dims, (b * h ** 3 - bi * hi ** 3) / 12, h / 2, b * h - bi * hi);
		}
		case 'ibeam': {
			const [b = 0, h = 0, tw = 0, tf = 0] = dims;
			if (tw >= b) return { error: 'The web thickness tw must be less than the width b' };
			if (2 * tf >= h) return { error: 'Twice the flange thickness tf must be less than the depth h' };
			// The two voids beside the web form one (b - tw) x (h - 2tf) rectangle.
			const hw = h - 2 * tf;
			return props(shape, dims, (b * h ** 3 - (b - tw) * hw ** 3) / 12, h / 2, 2 * b * tf + hw * tw);
		}
	}
}
