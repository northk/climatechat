/**
 * Fixture-based parser tests for Open-Meteo (plan Phase 2 preamble):
 * two fixtures for the two API shapes — geocoding, then archive —
 * captured via curl (step 14). No live network calls.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	parseGeocodeJson,
	aggregateArchive,
	runCityTemperatureHistory,
	openMeteoToolDefinitions,
	cityCacheKey,
	sliceSeries,
} from '../src/tools/openMeteo';
import geocodeRaw from './fixtures/open_meteo_geocode.json?raw';
import archiveRaw from './fixtures/open_meteo_archive.json?raw';

const archiveFixture: unknown = JSON.parse(archiveRaw);

describe('parseGeocodeJson - Portland fixture', () => {
	it('extracts the resolved city, coordinates, and country', () => {
		const city = parseGeocodeJson(JSON.parse(geocodeRaw), 'Portland');
		expect(city.name).toBe('Portland');
		expect(city.countryCode).toBe('US');
		expect(city.latitude).toBeCloseTo(45.52, 1);
		expect(city.longitude).toBeCloseTo(-122.68, 1);
	});

	it('throws a descriptive error when the city is not found', () => {
		// The geocoding API returns {} (no results key) for unknown names
		expect(() => parseGeocodeJson({}, 'Xyzzyville')).toThrow(/no results for city "Xyzzyville"/);
		expect(() => parseGeocodeJson({ results: [] }, 'Xyzzyville')).toThrow(/no results/);
	});

	it('throws on a malformed result entry', () => {
		expect(() => parseGeocodeJson({ results: [{ name: 'X' }] }, 'X')).toThrow(/malformed/);
	});
});

describe('aggregateArchive - Portland 2022-2023 fixture', () => {
	it('annual: aggregates 730 daily values into two annual means', () => {
		const points = aggregateArchive(archiveFixture, 'annual');
		expect(points).toHaveLength(2);
		expect(points.map((p) => p.x)).toEqual([2022, 2023]);
		for (const point of points) {
			expect(point.y).toBeGreaterThan(8);
			expect(point.y).toBeLessThan(16);
		}
	});

	it('monthly: produces 24 month-centered points with a seasonal signal', () => {
		const points = aggregateArchive(archiveFixture, 'monthly');
		expect(points).toHaveLength(24);
		// January 2022 is centered at 2022 + 0.5/12
		expect(points[0].x).toBeCloseTo(2022.042, 2);
		const january2022 = points[0];
		const july2022 = points[6];
		expect(july2022.x).toBeCloseTo(2022.542, 2);
		// Portland summers are much warmer than winters
		expect(july2022.y).toBeGreaterThan(january2022.y + 5);
	});

	it('weekly: produces ~104 Monday-start weeks with plausible temperatures', () => {
		const points = aggregateArchive(archiveFixture, 'weekly');
		// Two years ≈ 104 complete weeks; partial edge weeks are dropped
		expect(points.length).toBeGreaterThanOrEqual(102);
		expect(points.length).toBeLessThanOrEqual(106);
		for (let i = 0; i < points.length; i++) {
			if (i > 0) expect(points[i].x).toBeGreaterThan(points[i - 1].x);
			expect(points[i].y).toBeGreaterThan(-10);
			expect(points[i].y).toBeLessThan(35);
		}
	});
});

describe('aggregateArchive - resilience', () => {
	function syntheticDays(dates: string[], temp: number) {
		return { time: dates, temps: dates.map(() => temp) };
	}

	function fullYearDates(year: number): string[] {
		const dates: string[] = [];
		const date = new Date(Date.UTC(year, 0, 1));
		while (date.getUTCFullYear() === year) {
			dates.push(date.toISOString().slice(0, 10));
			date.setUTCDate(date.getUTCDate() + 1);
		}
		return dates;
	}

	it('annual: drops partial years below the completeness threshold', () => {
		const full = syntheticDays(fullYearDates(2020), 12);
		const partial = syntheticDays(fullYearDates(2021).slice(0, 120), 20);
		const body = {
			daily: {
				time: [...full.time, ...partial.time],
				temperature_2m_mean: [...full.temps, ...partial.temps],
			},
		};
		expect(aggregateArchive(body, 'annual')).toEqual([{ x: 2020, y: 12 }]);
	});

	it('weekly: drops the trailing incomplete week but keeps complete ones', () => {
		// Mon 2024-01-01 .. Sun 2024-01-14 = two complete weeks, then 3 days
		const dates = fullYearDates(2024).slice(0, 17);
		const body = { daily: { time: dates, temperature_2m_mean: dates.map(() => 5) } };
		const points = aggregateArchive(body, 'weekly');
		expect(points).toHaveLength(2);
		expect(points[0].x).toBeCloseTo(2024, 2);
	});

	it('skips null daily values without losing the bucket', () => {
		const full = syntheticDays(fullYearDates(2020).slice(0, 362), 10);
		const body = {
			daily: {
				time: [...full.time, '2020-12-29', '2020-12-30'],
				temperature_2m_mean: [...full.temps, null, null],
			},
		};
		expect(aggregateArchive(body, 'annual')).toEqual([{ x: 2020, y: 10 }]);
	});

	it('throws when the daily arrays are missing or misaligned', () => {
		expect(() => aggregateArchive({}, 'annual')).toThrow(/daily/);
		expect(() => aggregateArchive({ daily: { time: ['2020-01-01'], temperature_2m_mean: [] } }, 'annual')).toThrow(/aligned/);
	});

	it('throws when no period clears the threshold', () => {
		const partial = syntheticDays(fullYearDates(2021).slice(0, 3), 15);
		const body = { daily: { time: partial.time, temperature_2m_mean: partial.temps } };
		expect(() => aggregateArchive(body, 'monthly')).toThrow(/no complete monthly periods/);
	});
});

describe('runCityTemperatureHistory - input validation (throws before any fetch)', () => {
	it('rejects an invalid granularity', async () => {
		await expect(runCityTemperatureHistory({ city: 'Portland', granularity: 'daily' })).rejects.toThrow(/granularity must be/);
	});

	it('enforces the weekly 3-year span cap', async () => {
		await expect(runCityTemperatureHistory({ city: 'Portland', granularity: 'weekly', start_year: 2020, end_year: 2023 })).rejects.toThrow(
			/3-year span/,
		);
	});

	it('enforces the monthly 30-year span cap', async () => {
		await expect(runCityTemperatureHistory({ city: 'Portland', granularity: 'monthly', start_year: 1980, end_year: 2020 })).rejects.toThrow(
			/30-year span/,
		);
	});

	it('rejects an annual range ending in the incomplete current year', async () => {
		const currentYear = new Date().getUTCFullYear();
		await expect(
			runCityTemperatureHistory({ city: 'Portland', granularity: 'annual', start_year: 2020, end_year: currentYear }),
		).rejects.toThrow(/end/);
	});
});

describe('Open-Meteo tool definition', () => {
	it('requires city, offers the three granularities, cites Open-Meteo', () => {
		expect(openMeteoToolDefinitions).toHaveLength(1);
		const tool = openMeteoToolDefinitions[0];
		expect(tool.name).toBe('get_city_temperature_history');
		expect(tool.description).toContain('Open-Meteo');
		expect(tool.description).not.toContain('GML');
		const schema = tool.input_schema as {
			properties: { granularity: { enum: string[] } };
			required: string[];
		};
		expect(schema.properties.granularity.enum).toEqual(['annual', 'monthly', 'weekly']);
		expect(schema.required).toEqual(['city']);
	});
});

describe('sliceSeries', () => {
	it('keeps monthly points by their integer year, both ends inclusive', () => {
		const points = [
			{ x: 2021.958, y: 1 },
			{ x: 2022.042, y: 2 },
			{ x: 2022.958, y: 3 },
			{ x: 2023.042, y: 4 },
		];
		expect(sliceSeries(points, 2022, 2022)).toEqual([
			{ x: 2022.042, y: 2 },
			{ x: 2022.958, y: 3 },
		]);
	});
});

describe('runCityTemperatureHistory - city series cache (R12)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * Stub both Open-Meteo endpoints: the geocoder resolves to `latitude`
	 * (unique per test, so no two tests share a cache key) and the archive
	 * serves the Portland 2022-2023 fixture. Records the archive URLs hit.
	 */
	function stubOpenMeteo(latitude: number) {
		const archiveUrls: string[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes('geocoding-api')) {
				return Promise.resolve(Response.json({ results: [{ name: 'Portland', latitude, longitude: -122.67621, country_code: 'US' }] }));
			}
			archiveUrls.push(url);
			return Promise.resolve(new Response(archiveRaw, { status: 200 }));
		});
		return archiveUrls;
	}

	const cacheKeyFor = (latitude: number) => cityCacheKey({ name: 'Portland', latitude, longitude: -122.67621, countryCode: 'US' });

	it('fetches the full record from 1940 once, then serves annual AND monthly from KV', async () => {
		const archiveUrls = stubOpenMeteo(10.11);

		const annual = await runCityTemperatureHistory({ city: 'Portland' }, env.CLIMATE_KV);
		expect(archiveUrls).toHaveLength(1);
		expect(archiveUrls[0]).toContain('start_date=1940-01-01');
		expect(annual.points.map((point) => point.x)).toEqual([2022, 2023]);
		expect(await env.CLIMATE_KV.get(cacheKeyFor(10.11))).not.toBeNull();

		// Different wording, different granularity — same geocoded point, no refetch
		const monthly = await runCityTemperatureHistory(
			{ city: 'portland, oregon', granularity: 'monthly', start_year: 2023, end_year: 2023 },
			env.CLIMATE_KV,
		);
		expect(archiveUrls).toHaveLength(1);
		expect(monthly.points).toHaveLength(12);
		expect(monthly.points.every((point) => Math.floor(point.x) === 2023)).toBe(true);
		expect(monthly.source).toBe('Open-Meteo');
	});

	it('returns the same points from the cache as from the fetch that filled it', async () => {
		stubOpenMeteo(10.22);
		const input = { city: 'Portland', granularity: 'monthly', start_year: 2022, end_year: 2023 };
		const fromFetch = await runCityTemperatureHistory(input, env.CLIMATE_KV);
		const fromCache = await runCityTemperatureHistory(input, env.CLIMATE_KV);
		expect(fromCache).toEqual(fromFetch);
		expect(fromFetch.points).toEqual(aggregateArchive(archiveFixture, 'monthly'));
	});

	it('leaves weekly uncached, fetching only the requested range each time', async () => {
		const archiveUrls = stubOpenMeteo(10.33);
		const input = { city: 'Portland', granularity: 'weekly', start_year: 2022, end_year: 2023 };
		await runCityTemperatureHistory(input, env.CLIMATE_KV);
		await runCityTemperatureHistory(input, env.CLIMATE_KV);
		expect(archiveUrls).toHaveLength(2);
		expect(archiveUrls[0]).toContain('start_date=2022-01-01');
		expect(await env.CLIMATE_KV.get(cacheKeyFor(10.33))).toBeNull();
	});

	it('treats a corrupt cache entry as a miss and refetches', async () => {
		const archiveUrls = stubOpenMeteo(10.44);
		await env.CLIMATE_KV.put(cacheKeyFor(10.44), '{"annual":');
		const result = await runCityTemperatureHistory({ city: 'Portland' }, env.CLIMATE_KV);
		expect(archiveUrls).toHaveLength(1);
		expect(result.points).toHaveLength(2);
	});

	it('still answers without a KV binding, fetching every time', async () => {
		const archiveUrls = stubOpenMeteo(10.55);
		await runCityTemperatureHistory({ city: 'Portland' });
		await runCityTemperatureHistory({ city: 'Portland' });
		expect(archiveUrls).toHaveLength(2);
	});

	it('throws tool_parse_failed when the cached series has nothing in the requested range', async () => {
		stubOpenMeteo(10.66);
		await expect(runCityTemperatureHistory({ city: 'Portland', start_year: 2000, end_year: 2010 }, env.CLIMATE_KV)).rejects.toMatchObject({
			toolErrorClass: 'tool_parse_failed',
		});
	});
});
