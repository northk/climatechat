/**
 * Fixture-based parser tests for NOAA NCEI (plan Phase 2 preamble): no
 * live network calls — fixtures captured via curl (step 14).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseCagJson, parseOhcDat, nceiToolDefinitions, runOceanHeatContent, runSurfaceTemperature } from '../src/tools/noaaNcei';
import { ToolError } from '../src/tools/errors';
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
	it('skips missing departures (null, empty, blank, non-numeric) instead of turning them into 0', () => {
		const points = parseCagJson({
			data: {
				'2020': { departure: 1.01 },
				'2021': { departure: null },
				'2022': { departure: '' },
				'2023': { departure: ' ' },
				'2024': { departure: true },
				'2025': { departure: [] },
				'2026': {},
			},
		});
		expect(points).toEqual([{ x: 2020, y: 1.01 }]);
	});

	it('keeps genuine zero anomalies, as a number or a numeric string', () => {
		const points = parseCagJson({ data: { '1950': { departure: 0 }, '1951': { departure: '0' }, '1952': { departure: '-0.12' } } });
		expect(points).toEqual([
			{ x: 1950, y: 0 },
			{ x: 1951, y: 0 },
			{ x: 1952, y: -0.12 },
		]);
	});

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
	it('skips a row with a missing field rather than reading a shifted column', () => {
		const text = [
			'    YEAR      WO    WOse      NH    NHse',
			'1955.500  -3.201   1.700  -1.439   0.937',
			// WO is missing: split on whitespace would put WOse (0.719) in WO's column
			'1956.500           0.719  -1.843   0.385',
			'1957.500  -2.100   0.650  -1.500   0.400',
		].join('\n');
		expect(parseOhcDat(text, 'WO')).toEqual([
			{ x: 1955, y: -3.201 },
			{ x: 1957, y: -2.1 },
		]);
	});

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

describe('runSurfaceTemperature - year ceiling (Codex review)', () => {
	// Pinned mid-2026. NCEI 404s ranges ending in a future year, and annual
	// ranges made up only of the in-progress year (verified live 2026-09-24).
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function pinDateAndStubFetch(): string[] {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
		const urls: string[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
			urls.push(String(input instanceof Request ? input.url : input));
			return Promise.resolve(Response.json({ data: { '2024': { departure: 1.29 }, '202601': { departure: 1.09 } } }));
		});
		return urls;
	}

	it('allows monthly ranges through the current year', async () => {
		const urls = pinDateAndStubFetch();
		await runSurfaceTemperature({ start_year: 2025, end_year: 2026, scale: 'monthly' });
		expect(urls).toHaveLength(1);
		expect(urls[0]).toMatch(/\/1\/0\/2025-2026\.json$/);
	});

	it('rejects a monthly range ending next year as input, without fetching', async () => {
		const urls = pinDateAndStubFetch();
		await expect(runSurfaceTemperature({ start_year: 2025, end_year: 2027, scale: 'monthly' })).rejects.toMatchObject({
			toolErrorClass: 'tool_input_invalid',
			message: expect.stringContaining('<= 2026 (for monthly scale)') as string,
		});
		expect(urls).toHaveLength(0);
	});

	it('allows annual ranges through the last complete year', async () => {
		const urls = pinDateAndStubFetch();
		await runSurfaceTemperature({ start_year: 2020, end_year: 2025, scale: 'annual' });
		expect(urls[0]).toMatch(/\/12\/12\/2020-2025\.json$/);
	});

	it('rejects an annual range ending in the in-progress year, naming the last complete year', async () => {
		const urls = pinDateAndStubFetch();
		await expect(runSurfaceTemperature({ start_year: 2026, end_year: 2026, scale: 'annual' })).rejects.toMatchObject({
			toolErrorClass: 'tool_input_invalid',
			message: expect.stringContaining('<= 2025 (for annual scale)') as string,
		});
		expect(urls).toHaveLength(0);
	});
});

describe('runOceanHeatContent - basin validation', () => {
	it('rejects a bogus basin as tool_input_invalid before any fetch', async () => {
		await expect(runOceanHeatContent({ basin: 'mediterranean', depth: '700m' })).rejects.toThrow(/basin must be/);
	});

	it('rejects "__proto__" instead of letting it index Object.prototype', async () => {
		// Plain object indexing would return Object.prototype (truthy) and
		// slip past a `!config` check — the type guard blocks that.
		await expect(runOceanHeatContent({ basin: '__proto__', depth: '700m' })).rejects.toMatchObject({
			toolErrorClass: 'tool_input_invalid',
		});
		await expect(runOceanHeatContent({ basin: 'constructor', depth: '700m' })).rejects.toBeInstanceOf(ToolError);
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
