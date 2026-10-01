import { describe, expect, it } from 'vitest';
import type { SectionProps, SectionShape } from '../src/core/types';
import { computeSection, dimensionCountMessage, findSectionShape, SECTION_SHAPES } from '../src/core/sections';

const MM = 1e-3;
const MM4 = 1e-12;

/** Computes a section from dims in mm, failing the test on an error. */
function section(shape: SectionShape, dimsMm: number[]): SectionProps {
	const result = computeSection(shape, dimsMm.map((d) => d * MM));
	if ('error' in result) throw new Error(result.error);
	return result;
}

/** Returns the error message, failing the test on success. */
function sectionError(shape: SectionShape, dimsMm: number[]): string {
	const result = computeSection(shape, dimsMm.map((d) => d * MM));
	if (!('error' in result)) throw new Error(`Expected an error for ${shape} ${dimsMm.join(' x ')}`);
	return result.error;
}

describe('computeSection: verified values', () => {
	it('rectangle 100 x 200 mm', () => {
		const s = section('rect', [100, 200]);
		expect(s.I / MM4).toBeCloseTo(66666666.67, 1);
		expect(s.c).toBeCloseTo(0.1, 12);
		expect(s.area).toBeCloseTo(0.02, 12);
		// Elastic section modulus W = I / c
		expect(s.I / s.c / 1e-9).toBeCloseTo(666666.67, 1);
	});

	it('solid circle 100 mm', () => {
		const s = section('circle', [100]);
		expect(s.I / MM4).toBeCloseTo(4908738.521, 2);
		expect(s.c).toBeCloseTo(0.05, 12);
		expect(s.area).toBeCloseTo((Math.PI * 0.1 ** 2) / 4, 12);
	});

	it('circular tube 60 x 5 mm', () => {
		const s = section('tube', [60, 5]);
		expect(s.I / MM4).toBeCloseTo((Math.PI * (60 ** 4 - 50 ** 4)) / 64, 3);
		expect(s.I / MM4).toBeCloseTo(329376.355, 2);
		expect(s.c).toBeCloseTo(0.03, 12);
		expect(s.area / 1e-6).toBeCloseTo((Math.PI * (60 ** 2 - 50 ** 2)) / 4, 6);
	});

	it('rectangular box 100 x 200 x 10 mm', () => {
		const s = section('box', [100, 200, 10]);
		expect(s.I / MM4).toBeCloseTo(27786666.67, 1);
		expect(s.c).toBeCloseTo(0.1, 12);
		expect(s.area / 1e-6).toBeCloseTo(100 * 200 - 80 * 180, 6);
	});

	it('I-beam 150 x 300 x 7.1 x 10.7 mm (IPE 300 without fillets)', () => {
		const s = section('ibeam', [150, 300, 7.1, 10.7]);
		expect(s.I / MM4).toBeCloseTo(79989869.46, 1);
		expect(s.c).toBeCloseTo(0.15, 12);
		expect(s.area / 1e-6).toBeCloseTo(2 * 150 * 10.7 + (300 - 2 * 10.7) * 7.1, 6);
		// The catalogue value (8356 cm^4) includes root fillets: about 4.3% more.
		expect(8356e4 / (s.I / MM4)).toBeCloseTo(1.0446, 3);
	});

	it('returns the shape, dims in metres and a plain label', () => {
		const s = section('rect', [100, 200]);
		expect(s.shape).toBe('rect');
		expect(s.dims[0]).toBeCloseTo(0.1, 12);
		expect(s.dims[1]).toBeCloseTo(0.2, 12);
		expect(s.label).toBe('Rectangle');
	});
});

describe('computeSection: invalid geometry', () => {
	it('rejects a wrong number of dimensions', () => {
		expect(sectionError('rect', [100])).toBe('Rectangle needs 2 dimensions (b x h), for example: section rect 100 x 200 mm');
		expect(sectionError('circle', [100, 5])).toContain('needs 1 dimension (d)');
		expect(sectionError('ibeam', [1, 2, 3])).toContain('needs 4 dimensions (b x h x tw x tf)');
	});

	it('rejects zero, negative and non-finite dimensions', () => {
		expect(sectionError('rect', [0, 200])).toBe('Section dimensions must be greater than zero');
		expect(sectionError('circle', [-10])).toBe('Section dimensions must be greater than zero');
		expect(computeSection('rect', [Number.NaN, 0.2])).toEqual({ error: 'Section dimensions must be greater than zero' });
	});

	it('rejects a tube wall of half the diameter or more', () => {
		expect(sectionError('tube', [60, 30])).toContain('less than half the diameter');
		expect(sectionError('tube', [60, 40])).toContain('less than half the diameter');
		expect(section('tube', [60, 29.9]).I).toBeGreaterThan(0);
	});

	it('rejects a box wall of half the smaller side or more', () => {
		expect(sectionError('box', [100, 200, 50])).toContain('wall thickness t');
		expect(sectionError('box', [200, 100, 50])).toContain('wall thickness t');
		expect(section('box', [100, 200, 49]).I).toBeGreaterThan(0);
	});

	it('rejects an I-beam web as wide as the flange or flanges filling the depth', () => {
		expect(sectionError('ibeam', [150, 300, 150, 10])).toContain('web thickness tw');
		expect(sectionError('ibeam', [150, 300, 7, 150])).toContain('flange thickness tf');
	});
});

describe('computeSection: properties out of floating-point range', () => {
	// Regression: 1e308 m dims gave I = Infinity and 1e-200 m dims gave I = 0, both silently.
	const message = 'The section properties cannot be computed for these dimensions: check their size and unit';

	it('rejects an I that overflows to Infinity', () => {
		const result = computeSection('rect', [1e300, 1e300]);
		expect(result).toEqual({ error: message });
		expect(computeSection('circle', [1e100])).toEqual({ error: message });
	});

	it('rejects an I or area that underflows to zero', () => {
		expect(computeSection('rect', [1e-200, 1e-200])).toEqual({ error: message });
		expect(computeSection('box', [1e-90, 1e-90, 1e-91])).toEqual({ error: message });
	});

	it('still accepts very small and very large real sections', () => {
		expect('error' in computeSection('rect', [1e-6, 1e-6])).toBe(false);
		expect('error' in computeSection('rect', [100, 100])).toBe(false);
	});
});

describe('SECTION_SHAPES metadata', () => {
	it('has sentence-case labels and dimension names', () => {
		expect(SECTION_SHAPES.rect).toMatchObject({ label: 'Rectangle', dims: ['b', 'h'], dimLabels: ['Width b', 'Depth h'] });
		expect(SECTION_SHAPES.circle).toMatchObject({ label: 'Solid circle', dims: ['d'], dimLabels: ['Diameter d'] });
		expect(SECTION_SHAPES.tube).toMatchObject({ label: 'Circular tube', dims: ['d', 't'], dimLabels: ['Diameter d', 'Wall thickness t'] });
		expect(SECTION_SHAPES.box).toMatchObject({ label: 'Rectangular box', dims: ['b', 'h', 't'] });
		expect(SECTION_SHAPES.ibeam).toMatchObject({
			label: 'I-beam (no fillets)',
			dims: ['b', 'h', 'tw', 'tf'],
			dimLabels: ['Width b', 'Depth h', 'Web thickness tw', 'Flange thickness tf'],
		});
	});

	it('keeps one label per dimension and a shape field matching its key', () => {
		for (const [key, info] of Object.entries(SECTION_SHAPES)) {
			expect(info.shape).toBe(key);
			expect(info.dimLabels).toHaveLength(info.dims.length);
		}
	});

	it('formats the dimension count message from the metadata', () => {
		expect(dimensionCountMessage('box')).toBe('Rectangular box needs 3 dimensions (b x h x t), for example: section box 100 x 200 x 10 mm');
	});
});

describe('findSectionShape', () => {
	it.each([
		['rect', 'rect'],
		['Rectangle', 'rect'],
		['circle', 'circle'],
		['round', 'circle'],
		['solid-circle', 'circle'],
		['tube', 'tube'],
		['pipe', 'tube'],
		['CHS', 'tube'],
		['box', 'box'],
		['rhs', 'box'],
		['SHS', 'box'],
		['ibeam', 'ibeam'],
		['I', 'ibeam'],
		['h', 'ibeam'],
		['wide-flange', 'ibeam'],
		['i-beam', 'ibeam'],
	])('maps %s to %s', (name, shape) => {
		expect(findSectionShape(name)).toBe(shape);
	});

	it('returns undefined for unknown shapes', () => {
		expect(findSectionShape('triangle')).toBeUndefined();
	});
});
