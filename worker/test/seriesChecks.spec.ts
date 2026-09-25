/**
 * Series sanity checks (Codex review): minimum record counts and wide
 * plausible ranges, applied in each tool after parsing. The key property
 * is two-sided — every real captured response must PASS (floors and
 * ranges never reject real data), while a truncated response or a unit
 * change must FAIL as tool_parse_failed, the drift signal.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkSeries } from '../src/tools/parse';
import { runTool } from '../src/tools/registry';
import co2AnnualCsv from './fixtures/co2_annmean_gl.csv?raw';
import co2MonthlyCsv from './fixtures/co2_mm_gl.csv?raw';
import seaIceCsv from './fixtures/nsidc_sea_ice.csv?raw';
import ohcDat from './fixtures/ncei_ohc_700m.dat?raw';
import tempAnnualJson from './fixtures/ncei_surface_temp_annual.json?raw';
import tempMonthlyJson from './fixtures/ncei_surface_temp_monthly.json?raw';

/** The error `fn` throws, or undefined if it doesn't throw. */
function thrownBy(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe('checkSeries', () => {
	const points = [
		{ x: 1, y: 10 },
		{ x: 2, y: 20 },
		{ x: 3, y: 30 },
	];

	it('returns the series unchanged when it is long enough and in range', () => {
		expect(checkSeries(points, { source: 'Test', unit: 'u', range: [0, 100], minPoints: 3 })).toBe(points);
	});

	it('skips the count check when no floor is given (range-requested series)', () => {
		expect(checkSeries(points.slice(0, 1), { source: 'Test', unit: 'u', range: [0, 100] })).toHaveLength(1);
	});

	it('rejects a series shorter than its floor', () => {
		expect(thrownBy(() => checkSeries(points, { source: 'Test', unit: 'u', range: [0, 100], minPoints: 4 }))).toMatchObject({
			toolErrorClass: 'tool_parse_failed',
			message: 'Test: only 3 data points, expected at least 4 — possible upstream format change',
		});
	});

	it('rejects a value outside the range, naming it', () => {
		expect(thrownBy(() => checkSeries(points, { source: 'Test', unit: 'u', range: [0, 25] }))).toMatchObject({
			toolErrorClass: 'tool_parse_failed',
			message: 'Test: value 30 u is outside the plausible range 0 to 25 — possible upstream unit or format change',
		});
	});
});

/** Serve one fixed body to every fetch. */
function serve(body: string): void {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
}

/** Multiply one column of a CSV or whitespace-delimited table — a simulated upstream unit change. */
function scaleColumn(text: string, column: string, factor: number, delimiter: ',' | 'whitespace'): string {
	const split = (line: string) => (delimiter === ',' ? line.split(',') : line.trim().split(/\s+/));
	const join = (cells: string[]) => cells.join(delimiter === ',' ? ',' : '  ');
	const lines = text.split('\n');
	const headerIndex = lines.findIndex((line) => split(line).some((cell) => cell.trim().toLowerCase() === column.toLowerCase()));
	const col = split(lines[headerIndex]).findIndex((cell) => cell.trim().toLowerCase() === column.toLowerCase());
	return lines
		.map((line, i) => {
			if (i <= headerIndex || line.trim() === '' || line.startsWith('#')) return line;
			const cells = split(line);
			const value = Number(cells[col]);
			if (Number.isFinite(value) && value > -900) cells[col] = String(value * factor);
			return join(cells);
		})
		.join('\n');
}

describe('real captured responses pass every tool check', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('GML CO2, annual (47 rows) and monthly', async () => {
		serve(co2AnnualCsv);
		expect((await runTool('get_co2_levels', { granularity: 'annual' })).points.length).toBeGreaterThan(40);
		vi.restoreAllMocks();
		serve(co2MonthlyCsv);
		expect((await runTool('get_co2_levels', { granularity: 'monthly' })).points.length).toBeGreaterThan(480);
	});

	it('NSIDC sea ice (January)', async () => {
		serve(seaIceCsv);
		expect((await runTool('get_arctic_sea_ice', { month: 1 })).points.length).toBeGreaterThanOrEqual(40);
	});

	it('NCEI ocean heat, world 0–700m (71 rows)', async () => {
		serve(ohcDat);
		expect((await runTool('get_ocean_heat_content', { basin: 'world', depth: '700m' })).points.length).toBe(71);
	});

	it('NCEI surface temperature, annual and monthly', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
		serve(tempAnnualJson);
		expect((await runTool('get_surface_temperature', { start_year: 1880, end_year: 2025, scale: 'annual' })).points.length).toBeGreaterThan(
			100,
		);
		vi.restoreAllMocks();
		serve(tempMonthlyJson);
		expect(
			(await runTool('get_surface_temperature', { start_year: 1880, end_year: 2026, scale: 'monthly' })).points.length,
		).toBeGreaterThan(1000);
	});
});

describe('simulated upstream drift fails as tool_parse_failed', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	const drift = { toolErrorClass: 'tool_parse_failed' };

	it('a truncated GML file (10 rows)', async () => {
		serve(
			co2AnnualCsv
				.split('\n')
				.filter((line) => !/^\d{4},/.test(line) || Number(line.slice(0, 4)) < 1989)
				.join('\n'),
		);
		await expect(runTool('get_co2_levels', { granularity: 'annual' })).rejects.toMatchObject({
			...drift,
			message: expect.stringMatching(/^NOAA GML CO2 \(annual\): only 10 data points, expected at least 40/) as string,
		});
	});

	it('GML switching CO2 from ppm to ppb (×1000)', async () => {
		serve(scaleColumn(co2AnnualCsv, 'mean', 1000, ','));
		await expect(runTool('get_co2_levels', { granularity: 'annual' })).rejects.toMatchObject(drift);
	});

	it('NSIDC switching to thousand km² (×1000)', async () => {
		serve(scaleColumn(seaIceCsv, 'extent', 1000, ','));
		await expect(runTool('get_arctic_sea_ice', { month: 1 })).rejects.toMatchObject(drift);
	});

	it('NCEI ocean heat switching to 10²¹ J (×10)', async () => {
		serve(scaleColumn(ohcDat, 'WO', 10, 'whitespace'));
		await expect(runTool('get_ocean_heat_content', { basin: 'world', depth: '700m' })).rejects.toMatchObject(drift);
	});

	it('NCEI surface temperature reported in kelvin', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
		const kelvin = JSON.parse(tempAnnualJson) as { data: Record<string, { departure: number }> };
		for (const entry of Object.values(kelvin.data)) entry.departure += 273.15;
		serve(JSON.stringify(kelvin));
		await expect(runTool('get_surface_temperature', { start_year: 1880, end_year: 2025, scale: 'annual' })).rejects.toMatchObject(drift);
	});
});
