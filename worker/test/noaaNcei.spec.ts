/**
 * Fixture-based parser tests for NOAA NCEI (plan Phase 2 preamble): no
 * live network calls — fixtures captured via curl (step 14).
 */

import { describe, it, expect } from 'vitest';
import { parseCagJson, parseOhcDat, nceiToolDefinitions } from '../src/tools/noaaNcei';
import annualTempRaw from './fixtures/ncei_surface_temp_annual.json?raw';
import monthlyTempRaw from './fixtures/ncei_surface_temp_monthly.json?raw';
import ohcFixture from './fixtures/ncei_ohc_700m.dat?raw';

describe('parseCagJson - annual fixture (1880-2025)', () => {
	const points = parseCagJson(JSON.parse(annualTempRaw));

	it('parses one integer-year point per year, ascending', () => {
		expect(points.length).toBeGreaterThan(140);
		expect(points[0]).toEqual({ x: 1880, y: -0.2 });
		for (let i = 1; i < points.length; i++) {
			expect(points[i].x).toBeGreaterThan(points[i - 1].x);
		}
	});

	it('shows the expected warming signal (recent anomalies exceed early ones)', () => {
		const early = points.filter((p) => p.x < 1900);
		const recent = points.filter((p) => p.x >= 2015);
		expect(Math.max(...early.map((p) => p.y))).toBeLessThan(0.3);
		expect(Math.min(...recent.map((p) => p.y))).toBeGreaterThan(0.8);
	});
});

describe('parseCagJson - monthly fixture', () => {
	const points = parseCagJson(JSON.parse(monthlyTempRaw));

	it('parses YYYYMM keys into month-centered fractional years', () => {
		expect(points.length).toBeGreaterThan(1700);
		// January 1880 → 1880 + 0.5/12
		expect(points[0].x).toBeCloseTo(1880.0417, 3);
		expect(points[0].y).toBe(-0.4);
	});
});

describe('parseCagJson - resilience', () => {
	it('throws when the "data" object is missing', () => {
		expect(() => parseCagJson({ description: {} })).toThrow(/no "data"/);
		expect(() => parseCagJson(null)).toThrow(/no "data"/);
	});

	it('skips non-numeric departures and unrecognized keys', () => {
		const points = parseCagJson({
			data: {
				'1990': { departure: 0.3 },
				'1991': { departure: 'missing' },
				'not-a-year': { departure: 0.5 },
				'199013': { departure: 0.5 },
			},
		});
		expect(points).toEqual([{ x: 1990, y: 0.3 }]);
	});
});

describe('parseOhcDat - world 700m fixture (1955-2025)', () => {
	const points = parseOhcDat(ohcFixture, 'WO');

	it('parses integer years from the YYYY.500 midpoints', () => {
		expect(points.length).toBeGreaterThan(65);
		expect(points[0]).toEqual({ x: 1955, y: -3.201 });
		expect(points.every((p) => Number.isInteger(p.x))).toBe(true);
	});

	it('shows accumulating ocean heat (recent values far above the 1950s)', () => {
		const last = points[points.length - 1];
		expect(last.x).toBeGreaterThanOrEqual(2024);
		expect(last.y).toBeGreaterThan(15);
	});
});

describe('parseOhcDat - resilience', () => {
	it('selects the requested basin column by name', () => {
		const pacific = ['YEAR      PO    POse      NP    NPse', '1960.500  -1.877   1.321  -0.984   0.608'].join('\n');
		expect(parseOhcDat(pacific, 'PO')).toEqual([{ x: 1960, y: -1.877 }]);
	});

	it('throws when the basin column is absent (wrong file for the basin)', () => {
		const worldHeader = ['YEAR      WO    WOse', '1960.500  -1.0   0.5'].join('\n');
		expect(() => parseOhcDat(worldHeader, 'PO')).toThrow(/"PO"/);
	});

	it('throws on an HTML error page', () => {
		expect(() => parseOhcDat('<html>\n<body>404</body>\n</html>', 'WO')).toThrow(/NOAA NCEI OHC/);
	});
});

describe('NCEI tool definitions', () => {
	it('exposes both tools with correct citation names in their descriptions', () => {
		expect(nceiToolDefinitions.map((tool) => tool.name)).toEqual(['get_surface_temperature', 'get_ocean_heat_content']);
		expect(nceiToolDefinitions[0].description).toContain('NOAA NCEI (NOAAGlobalTemp)');
		expect(nceiToolDefinitions[1].description).toContain('NOAA NCEI');
		// The R1 rule: NCEI data must never be attributed to GML
		for (const tool of nceiToolDefinitions) {
			expect(tool.description).not.toContain('GML');
		}
	});
});
