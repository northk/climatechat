/**
 * Fixture-based parser tests for Open-Meteo (plan Phase 2 preamble):
 * two fixtures for the two API shapes — geocoding, then archive —
 * captured via curl (step 14). No live network calls.
 */

import { describe, it, expect } from 'vitest';
import { parseGeocodeJson, aggregateArchive, runCityTemperatureHistory, openMeteoToolDefinitions } from '../src/tools/openMeteo';
import geocodeRaw from './fixtures/open_meteo_geocode.json?raw';
import archiveRaw from './fixtures/open_meteo_archive.json?raw';

const archiveFixture: unknown = JSON.parse(archiveRaw);

describe('parseGeocodeJson — Portland fixture', () => {
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

describe('aggregateArchive — Portland 2022-2023 fixture', () => {
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

describe('aggregateArchive — resilience', () => {
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

describe('runCityTemperatureHistory — input validation (throws before any fetch)', () => {
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
