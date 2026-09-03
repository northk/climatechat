/**
 * Fixture-based parser tests (plan Phase 2 preamble): no live network
 * calls — fixtures were captured via curl from the real endpoints
 * (step 14). If an upstream format changes, re-download the fixture and
 * re-run to pinpoint the break.
 */

import { describe, it, expect } from 'vitest';
import { parseGmlCsv, gmlToolDefinitions } from '../src/tools/noaaGml';
// Tests run inside workerd (no node:fs); Vite's ?raw imports inline the
// fixture files as strings at build time instead.
import monthlyFixture from './fixtures/co2_mm_gl.csv?raw';
import annualFixture from './fixtures/co2_annmean_gl.csv?raw';

describe('parseGmlCsv - monthly shape (co2_mm_gl.csv fixture)', () => {
	const points = parseGmlCsv(monthlyFixture, 'monthly');

	it('parses the full series with fractional-year x values', () => {
		// Fixture spans 1979 to mid-2026: sanity-check bounds, not exact count
		expect(points.length).toBeGreaterThan(500);
		expect(points[0]).toEqual({ x: 1979.042, y: 336.56 });
	});

	it('produces strictly ascending x and plausible CO2 values', () => {
		for (let i = 0; i < points.length; i++) {
			if (i > 0) expect(points[i].x).toBeGreaterThan(points[i - 1].x);
			expect(points[i].y).toBeGreaterThan(300);
			expect(points[i].y).toBeLessThan(500);
		}
	});
});

describe('parseGmlCsv - annual shape (co2_annmean_gl.csv fixture)', () => {
	const points = parseGmlCsv(annualFixture, 'annual');

	it('parses integer-year points', () => {
		expect(points.length).toBeGreaterThan(40);
		expect(points[0]).toEqual({ x: 1979, y: 336.85 });
		expect(Number.isInteger(points[0].x)).toBe(true);
	});
});

describe('parseGmlCsv - resilience', () => {
	it('locates columns by header name, not position', () => {
		const reordered = ['average,year,month,decimal', '340.5,1980,1,1980.042'].join('\n');
		expect(parseGmlCsv(reordered, 'monthly')).toEqual([{ x: 1980.042, y: 340.5 }]);
	});

	it('skips missing-value sentinel rows', () => {
		const withSentinel = ['year,month,decimal,average', '1980,1,1980.042,340.5', '1980,2,1980.125,-999.99', '1980,3,1980.208,341.1'].join(
			'\n',
		);
		expect(parseGmlCsv(withSentinel, 'monthly')).toEqual([
			{ x: 1980.042, y: 340.5 },
			{ x: 1980.208, y: 341.1 },
		]);
	});

	it('throws on an HTML error page instead of CSV', () => {
		const singleLine = '<html><body>404</body></html>';
		expect(() => parseGmlCsv(singleLine, 'monthly')).toThrow(/NOAA GML CSV/);
		const multiLine = '<html>\n<body>\n<h1>404 Not Found</h1>\n</body>\n</html>';
		expect(() => parseGmlCsv(multiLine, 'monthly')).toThrow(/NOAA GML CSV/);
	});

	it('throws when the header matches but no rows parse', () => {
		expect(() => parseGmlCsv('year,mean\nnot,numbers', 'annual')).toThrow(/no data rows/);
	});

	it('throws on the wrong granularity for the shape', () => {
		// Annual file has no "decimal"/"average" columns
		expect(() => parseGmlCsv(annualFixture, 'monthly')).toThrow(/columns/);
	});
});

describe('GML tool definitions', () => {
	it('exposes the three greenhouse-gas tools with a required granularity enum', () => {
		expect(gmlToolDefinitions.map((tool) => tool.name)).toEqual(['get_co2_levels', 'get_methane_levels', 'get_nitrous_oxide_levels']);
		for (const tool of gmlToolDefinitions) {
			expect(tool.description).toContain('NOAA GML');
			const schema = tool.input_schema as {
				properties: { granularity: { enum: string[] } };
				required: string[];
			};
			expect(schema.properties.granularity.enum).toEqual(['monthly', 'annual']);
			expect(schema.required).toEqual(['granularity']);
		}
	});
});
