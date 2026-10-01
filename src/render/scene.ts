/**
 * Scene primitives: a tiny, DOM-free description of an SVG drawing.
 *
 * The scene builders (beam-scene.ts, chart-scene.ts) only produce plain data
 * so they can be unit tested in Node. The UI layer mounts a scene with
 * Obsidian's createSvg() helper (src/ui/mount.ts), and svg-string.ts turns it
 * into markup for tests and README screenshots.
 *
 * Colours never appear here: every primitive carries `bsd-*` CSS classes and
 * styles.css maps them to Obsidian theme variables, so light/dark themes and
 * PDF export work without re-rendering.
 */
import type { DisplayOptions, UnitSystemId } from '../core/types';

/** SVG elements used by the scenes. */
export type PrimTag = 'path' | 'line' | 'polyline' | 'polygon' | 'circle' | 'rect' | 'text';

/** One SVG element. */
export interface Prim {
	tag: PrimTag;
	/** Space separated CSS classes, each prefixed with "bsd-". */
	cls: string;
	/** SVG attributes (x, y, d, points, text-anchor, ...). Never `style` or colours. */
	attrs: Record<string, string | number>;
	/** Text content, for `text` primitives. */
	text?: string;
	/** Optional tooltip, mounted as an SVG <title> child. */
	tooltip?: string;
}

/** A complete drawing. */
export interface Scene {
	/** Drawing width and height in px (also used as the viewBox). */
	width: number;
	height: number;
	/** Accessible name (SVG <title>), e.g. "Shear force diagram". */
	title: string;
	/** Accessible description (SVG <desc>) summarising the key values. */
	desc: string;
	prims: Prim[];
}

/** Options for every scene builder. */
export interface SceneOptions extends Pick<DisplayOptions, 'decimals' | 'momentConvention'> {
	/** Available width in px (the container width). */
	width: number;
	/** Unit system used for labels. */
	units: UnitSystemId;
}

/** Fixed layout constants shared by all scenes so that x positions line up vertically. */
export const LAYOUT = {
	/** Space left of x = 0 and right of x = L, used by end labels and supports. */
	marginLeft: 56,
	marginRight: 56,
	/** Smallest width we lay out for; narrower containers scale the SVG down. */
	minWidth: 320,
	/** Font sizes in px; must match styles.css. */
	fontSize: 11,
	smallFontSize: 10,
} as const;

/** Maps beam coordinates [m] to horizontal pixels, identical for every scene of a block. */
export interface XLayout {
	/** Pixel x of the left end (x = 0). */
	left: number;
	/** Pixel x of the right end (x = length). */
	right: number;
	/** Beam length [m]. */
	length: number;
	/** Converts a position [m] to pixels. */
	toPx(x: number): number;
}

/**
 * Creates the shared horizontal mapping for a drawing `width` px wide and a
 * beam `length` m long. Widths below LAYOUT.minWidth are laid out at
 * minWidth (the SVG then scales down through its viewBox).
 */
export function createXLayout(width: number, length: number): XLayout {
	const w = Math.max(width, LAYOUT.minWidth);
	const left = LAYOUT.marginLeft;
	const right = w - LAYOUT.marginRight;
	const scale = length > 0 ? (right - left) / length : 0;
	return {
		left,
		right,
		length,
		toPx: (x: number) => left + x * scale,
	};
}

/**
 * Rough width of a text label in px. SVG cannot measure text without a DOM,
 * so label placement uses this estimate (average glyph is about 0.6 em).
 */
export function estimateTextWidth(text: string, fontSize: number = LAYOUT.fontSize): number {
	return text.length * fontSize * 0.6;
}

/** Rounds a pixel coordinate to 0.1 px so the generated markup stays short and stable. */
export function px(value: number): number {
	return Math.round(value * 10) / 10;
}
