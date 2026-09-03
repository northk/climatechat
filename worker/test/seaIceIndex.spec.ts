/**
 * Fixture-based parser tests for the NSIDC Sea Ice Index (plan Phase 2
 * preamble): no live network calls — fixture captured via curl (step 14)
 * from the January (N_01) v4.0 file.
 */

import { describe, it, expect } from 'vitest';
import { parseSeaIceCsv, seaIceToolDefinitions } from '../src/tools/seaIceIndex';
import seaIceFixture from './fixtures/nsidc_sea_ice.csv?raw';

describe('parseSeaIceCsv - January fixture (1979-2026)', () => {
	const points = parseSeaIceCsv(seaIceFixture);

	it('parses one point per year with whitespace-padded cells handled', () => {
		expect(points.length).toBeGreaterThan(45);
		expect(points[0]).toEqual({ x: 1979, y: 15.41 });
		const last = points[points.length - 1];
		expect(last.x).toBeGreaterThanOrEqual(2025);
	});

	it('shows the declining-extent signal (recent Januaries below 1980s)', () => {
		const eighties = points.filter((p) => p.x >= 1980 && p.x < 1990);
		const recent = points.filter((p) => p.x >= 2020);
		const eightiesMin = Math.min(...eighties.map((p) => p.y));
		const recentMax = Math.max(...recent.map((p) => p.y));
		expect(recentMax).toBeLessThan(eightiesMin);
	});
});

describe('parseSeaIceCsv - resilience', () => {
	it('skips -9999 missing-value sentinel rows', () => {
		const withSentinel = [
			'year, mo,source_dataset, region, extent, area',
			'1987,  1, NSIDC-0051, N, 15.06, 12.06',
			'1988,  1, NSIDC-0051, N, -9999, -9999',
			'1989,  1, NSIDC-0051, N, 14.94, 11.85',
		].join('\n');
		expect(parseSeaIceCsv(withSentinel)).toEqual([
			{ x: 1987, y: 15.06 },
			{ x: 1989, y: 14.94 },
		]);
	});

	it('locates columns by header name, not position', () => {
		const reordered = ['extent, year', '13.5, 2020'].join('\n');
		expect(parseSeaIceCsv(reordered)).toEqual([{ x: 2020, y: 13.5 }]);
	});

	it('throws on an HTML error page (e.g. after a future v5.0 rename)', () => {
		const html = '<html>\n<body><h1>404 Not Found</h1></body>\n</html>';
		expect(() => parseSeaIceCsv(html)).toThrow(/NSIDC sea ice CSV/);
	});
});

describe('sea ice tool definition', () => {
	it('requires an integer month 1-12 and cites the Sea Ice Index', () => {
		expect(seaIceToolDefinitions).toHaveLength(1);
		const tool = seaIceToolDefinitions[0];
		expect(tool.name).toBe('get_arctic_sea_ice');
		expect(tool.description).toContain('NSIDC/NOAA Sea Ice Index');
		expect(tool.description).not.toContain('GML');
		const schema = tool.input_schema as {
			properties: { month: { minimum: number; maximum: number } };
			required: string[];
		};
		expect(schema.properties.month.minimum).toBe(1);
		expect(schema.properties.month.maximum).toBe(12);
		expect(schema.required).toEqual(['month']);
	});
});
