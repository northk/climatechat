/**
 * Fixture-based parser tests for Open-Meteo (plan Phase 2 preamble):
 * two fixtures for the two API shapes — geocoding, then archive —
 * captured via curl (step 14). No live network calls.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	parseGeocodeJson,
	aggregateArchive,
	runCityTemperatureHistory,
	openMeteoToolDefinitions,
	cityCacheKeys,
	HISTORY_TTL_SECONDS,
	RECENT_TTL_SECONDS,
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
	// Pin "today" so the Portland 2022-2023 fixture straddles the segment
	// boundary: history = 1940..2022, recent = 2023..today. Only Date is
	// faked — real timers keep the async test machinery working.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	type Daily = { time: string[]; temperature_2m_mean: (number | null)[] };
	const fixtureDaily = (archiveFixture as { daily: Daily }).daily;

	/** Synthetic 2021-2025 daily series, flat per year (10 °C in 2021, +1 each year), so annual means are exact. */
	function syntheticDaily(): Daily {
		const daily: Daily = { time: [], temperature_2m_mean: [] };
		for (let day = new Date('2021-01-01T00:00:00Z'); day.getUTCFullYear() <= 2025; day.setUTCDate(day.getUTCDate() + 1)) {
			daily.time.push(day.toISOString().slice(0, 10));
			daily.temperature_2m_mean.push(10 + day.getUTCFullYear() - 2021);
		}
		return daily;
	}

	/**
	 * Stub both Open-Meteo endpoints: the geocoder resolves to `latitude`
	 * (unique per test, so no two tests share cache keys) and the archive
	 * serves `data`'s days within the requested start/end dates, like the
	 * real API. Records each archive request's date range.
	 */
	function stubOpenMeteo(latitude: number, data: Daily = fixtureDaily) {
		const archiveRanges: string[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.hostname.startsWith('geocoding-api')) {
				return Promise.resolve(Response.json({ results: [{ name: 'Portland', latitude, longitude: -122.67621, country_code: 'US' }] }));
			}
			const start = url.searchParams.get('start_date') ?? '';
			const end = url.searchParams.get('end_date') ?? '';
			archiveRanges.push(`${start}..${end}`);
			const keep = data.time.map((day) => day >= start && day <= end);
			return Promise.resolve(
				Response.json({
					daily: {
						time: data.time.filter((_, i) => keep[i]),
						temperature_2m_mean: data.temperature_2m_mean.filter((_, i) => keep[i]),
					},
				}),
			);
		});
		return archiveRanges;
	}

	const keysFor = (latitude: number, year = 2024) =>
		cityCacheKeys({ name: 'Portland', latitude, longitude: -122.67621, countryCode: 'US' }, year);

	it('fills both segments on a miss, then serves annual AND monthly from KV', async () => {
		const archiveRanges = stubOpenMeteo(10.11);

		const annual = await runCityTemperatureHistory({ city: 'Portland' }, env.CLIMATE_KV);
		expect(archiveRanges.sort()).toEqual(['1940-01-01..2022-12-31', '2023-01-01..2024-06-15']);
		expect(annual.points.map((point) => point.x)).toEqual([2022, 2023]);
		expect(await env.CLIMATE_KV.get(keysFor(10.11).history)).not.toBeNull();
		expect(await env.CLIMATE_KV.get(keysFor(10.11).recent)).not.toBeNull();

		// Different wording, different granularity — same geocoded point, no refetch
		const monthly = await runCityTemperatureHistory(
			{ city: 'portland, oregon', granularity: 'monthly', start_year: 2023, end_year: 2023 },
			env.CLIMATE_KV,
		);
		expect(archiveRanges).toHaveLength(2);
		expect(monthly.points).toHaveLength(12);
		expect(monthly.points.every((point) => Math.floor(point.x) === 2023)).toBe(true);
		expect(monthly.source).toBe('Open-Meteo');
	});

	it('the next day, refetches only the small recent segment, never the history', async () => {
		const archiveRanges = stubOpenMeteo(10.12);
		await runCityTemperatureHistory({ city: 'Portland' }, env.CLIMATE_KV);
		// Stand-in for the recent segment's 24h expiry
		await env.CLIMATE_KV.delete(keysFor(10.12).recent);
		vi.setSystemTime(new Date('2024-06-16T12:00:00Z'));

		const result = await runCityTemperatureHistory({ city: 'Portland' }, env.CLIMATE_KV);
		expect(archiveRanges).toEqual(expect.arrayContaining(['2023-01-01..2024-06-16']));
		expect(archiveRanges).toHaveLength(3);
		expect(result.points.map((point) => point.x)).toEqual([2022, 2023]);
	});

	it('at New Year, moves the boundary: both segments refetch under the new year keys', async () => {
		const archiveRanges = stubOpenMeteo(10.13, syntheticDaily());
		const before = await runCityTemperatureHistory({ city: 'Portland', start_year: 2021 }, env.CLIMATE_KV);
		expect(before.points).toEqual([
			{ x: 2021, y: 10 },
			{ x: 2022, y: 11 },
			{ x: 2023, y: 12 },
		]);

		vi.setSystemTime(new Date('2025-01-10T12:00:00Z'));
		const after = await runCityTemperatureHistory({ city: 'Portland', start_year: 2021 }, env.CLIMATE_KV);
		expect(archiveRanges.slice(2).sort()).toEqual(['1940-01-01..2023-12-31', '2024-01-01..2025-01-10']);
		expect(await env.CLIMATE_KV.get(keysFor(10.13, 2025).history)).not.toBeNull();
		// 2023 moved from recent into history and 2024 is now complete —
		// exactly one point per year, nothing from 2024's segments reused
		expect(after.points).toEqual([
			{ x: 2021, y: 10 },
			{ x: 2022, y: 11 },
			{ x: 2023, y: 12 },
			{ x: 2024, y: 13 },
		]);
	});

	it('waits for both segments before failing, leaving no fetch or KV write in flight', async () => {
		// The fixture has no data for the recent segment's range at this
		// date, so that segment throws while history is still being fetched
		// and written. The tool must not reject until both have settled.
		// (Promise.all used to reject early, which vitest-pool-workers caught
		// as "Isolated storage failed" from the still-running KV write.)
		vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
		stubOpenMeteo(10.14);
		await expect(runCityTemperatureHistory({ city: 'Portland', start_year: 2020 }, env.CLIMATE_KV)).rejects.toMatchObject({
			toolErrorClass: 'tool_parse_failed',
		});
		expect(await env.CLIMATE_KV.get(keysFor(10.14, 2025).history)).not.toBeNull();
	});

	it('concatenates the segments exactly: same points as aggregating the whole range at once', async () => {
		stubOpenMeteo(10.22);
		const input = { city: 'Portland', granularity: 'monthly', start_year: 2022, end_year: 2023 };
		const fromFetch = await runCityTemperatureHistory(input, env.CLIMATE_KV);
		const fromCache = await runCityTemperatureHistory(input, env.CLIMATE_KV);
		expect(fromFetch.points).toEqual(aggregateArchive(archiveFixture, 'monthly'));
		expect(fromCache).toEqual(fromFetch);
	});

	it('keeps history far longer than recent', async () => {
		stubOpenMeteo(10.23);
		await runCityTemperatureHistory({ city: 'Portland' }, env.CLIMATE_KV);
		const listed = await env.CLIMATE_KV.list({ prefix: 'om:v2:' });
		const expiration = (key: string) => listed.keys.find((entry) => entry.name === key)?.expiration ?? 0;
		const gap = expiration(keysFor(10.23).history) - expiration(keysFor(10.23).recent);
		expect(gap).toBe(HISTORY_TTL_SECONDS - RECENT_TTL_SECONDS);
	});

	it('leaves weekly uncached, fetching only the requested range each time', async () => {
		const archiveRanges = stubOpenMeteo(10.33);
		const input = { city: 'Portland', granularity: 'weekly', start_year: 2022, end_year: 2023 };
		await runCityTemperatureHistory(input, env.CLIMATE_KV);
		await runCityTemperatureHistory(input, env.CLIMATE_KV);
		expect(archiveRanges).toEqual(['2022-01-01..2023-12-31', '2022-01-01..2023-12-31']);
		expect(await env.CLIMATE_KV.get(keysFor(10.33).history)).toBeNull();
	});

	/** The structured logs written so far, parsed. */
	function loggedErrors(errorSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
		return errorSpy.mock.calls.map((call) => JSON.parse(call[0] as string) as Record<string, unknown>);
	}

	it('logs nothing on an ordinary miss and fill', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		stubOpenMeteo(10.41);
		await runCityTemperatureHistory({ city: 'Portland' }, env.CLIMATE_KV);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it('treats a corrupt cache entry as a miss, logs it, and refetches that segment only', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const archiveRanges = stubOpenMeteo(10.44);
		await runCityTemperatureHistory({ city: 'Portland' }, env.CLIMATE_KV);
		await env.CLIMATE_KV.put(keysFor(10.44).history, '{"annual":');
		const result = await runCityTemperatureHistory({ city: 'Portland' }, env.CLIMATE_KV);
		expect(archiveRanges.slice(2)).toEqual(['1940-01-01..2022-12-31']);
		expect(result.points).toHaveLength(2);
		expect(loggedErrors(errorSpy)).toEqual([
			{ class: 'kv_cache_failed', tool: 'get_city_temperature_history', message: 'history segment entry corrupt, refetching' },
		]);
	});

	/** A KV binding whose reads and/or writes throw, like an exhausted write quota or a KV outage. */
	function failingKv({ get, put }: { get?: boolean; put?: boolean }): KVNamespace {
		return {
			get: () => (get ? Promise.reject(new TypeError('KV GET failed: 500')) : Promise.resolve(null)),
			put: () => (put ? Promise.reject(new Error('KV put() limit exceeded for the day.')) : Promise.resolve()),
		} as unknown as KVNamespace;
	}

	it('still answers when KV writes fail, logging kv_cache_failed without the coordinates', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		stubOpenMeteo(10.45);
		const result = await runCityTemperatureHistory({ city: 'Portland' }, failingKv({ put: true }));
		expect(result.points.map((point) => point.x)).toEqual([2022, 2023]);

		const logged = loggedErrors(errorSpy);
		expect(logged.map((entry) => entry.message).sort()).toEqual([
			'history segment write failed (Error)',
			'recent segment write failed (Error)',
		]);
		expect(logged.every((entry) => entry.class === 'kv_cache_failed')).toBe(true);
		const raw = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
		expect(raw).not.toContain('10.45');
		expect(raw).not.toContain('-122');
	});

	it('still answers when KV reads fail, logging each as kv_cache_failed', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const archiveRanges = stubOpenMeteo(10.46);
		const result = await runCityTemperatureHistory({ city: 'Portland' }, failingKv({ get: true }));
		expect(result.points).toHaveLength(2);
		expect(archiveRanges).toHaveLength(2);
		expect(
			loggedErrors(errorSpy)
				.map((entry) => entry.message)
				.sort(),
		).toEqual(['history segment read failed (TypeError)', 'recent segment read failed (TypeError)']);
	});

	it('when both segments fail, throws the history error and logs the recent one instead of dropping it', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.hostname.startsWith('geocoding-api')) {
				return Promise.resolve(
					Response.json({ results: [{ name: 'Portland', latitude: 10.47, longitude: -122.67621, country_code: 'US' }] }),
				);
			}
			// History (starts 1940) is rate-limited; recent gets a non-JSON body — two different classes
			return Promise.resolve(
				url.searchParams.get('start_date') === '1940-01-01'
					? new Response('rate limited', { status: 429 })
					: new Response('<html>maintenance</html>', { status: 200 }),
			);
		});

		await expect(runCityTemperatureHistory({ city: 'Portland' }, env.CLIMATE_KV)).rejects.toMatchObject({
			toolErrorClass: 'tool_fetch_failed',
			upstreamStatus: 429,
		});
		expect(loggedErrors(errorSpy)).toEqual([
			{
				class: 'tool_parse_failed',
				tool: 'get_city_temperature_history',
				message: 'recent segment also failed: Open-Meteo archive: response body was not valid JSON',
			},
		]);
	});

	it('still answers without a KV binding, fetching every time', async () => {
		const archiveRanges = stubOpenMeteo(10.55);
		await runCityTemperatureHistory({ city: 'Portland' });
		await runCityTemperatureHistory({ city: 'Portland' });
		expect(archiveRanges).toHaveLength(4);
	});

	it('throws tool_parse_failed when the cached series has nothing in the requested range', async () => {
		stubOpenMeteo(10.66);
		await expect(runCityTemperatureHistory({ city: 'Portland', start_year: 2000, end_year: 2010 }, env.CLIMATE_KV)).rejects.toMatchObject({
			toolErrorClass: 'tool_parse_failed',
		});
	});
});
