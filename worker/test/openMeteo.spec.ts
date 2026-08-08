/**
 * Fixture-based parser tests for Open-Meteo (plan Phase 2 preamble):
 * two fixtures for the two API shapes — geocoding, then archive —
 * captured via curl (step 14). No live network calls.
 */

import { describe, it, expect } from 'vitest';
import { parseGeocodeJson, aggregateArchiveToAnnual, openMeteoToolDefinitions } from '../src/tools/openMeteo';
import geocodeRaw from './fixtures/open_meteo_geocode.json?raw';
import archiveRaw from './fixtures/open_meteo_archive.json?raw';

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

describe('aggregateArchiveToAnnual — Portland 2022-2023 fixture', () => {
	const points = aggregateArchiveToAnnual(JSON.parse(archiveRaw));

	it('aggregates 730 daily values into two annual means', () => {
		expect(points).toHaveLength(2);
		expect(points.map((p) => p.x)).toEqual([2022, 2023]);
	});

	it('produces plausible Portland annual means (roughly 10-15°C)', () => {
		for (const point of points) {
			expect(point.y).toBeGreaterThan(8);
			expect(point.y).toBeLessThan(16);
		}
	});
});

describe('aggregateArchiveToAnnual — resilience', () => {
	function syntheticYear(year: number, days: number, temp: number) {
		const time: string[] = [];
		const temps: number[] = [];
		for (let i = 0; i < days; i++) {
			// Day index only needs to be unique-ish; the parser reads the year prefix
			time.push(`${year}-01-01`);
			temps.push(temp);
		}
		return { time, temps };
	}

	it('drops partial years below the completeness threshold', () => {
		const full = syntheticYear(2020, 366, 12);
		const partial = syntheticYear(2021, 120, 20); // e.g. current-year data
		const body = {
			daily: {
				time: [...full.time, ...partial.time],
				temperature_2m_mean: [...full.temps, ...partial.temps],
			},
		};
		expect(aggregateArchiveToAnnual(body)).toEqual([{ x: 2020, y: 12 }]);
	});

	it('skips null daily values without losing the year', () => {
		const full = syntheticYear(2020, 360, 10);
		const body = {
			daily: {
				time: [...full.time, '2020-12-28', '2020-12-29'],
				temperature_2m_mean: [...full.temps, null, null],
			},
		};
		expect(aggregateArchiveToAnnual(body)).toEqual([{ x: 2020, y: 10 }]);
	});

	it('throws when the daily arrays are missing or misaligned', () => {
		expect(() => aggregateArchiveToAnnual({})).toThrow(/daily/);
		expect(() => aggregateArchiveToAnnual({ daily: { time: ['2020-01-01'], temperature_2m_mean: [] } })).toThrow(/aligned/);
	});

	it('throws when no year clears the threshold', () => {
		const partial = syntheticYear(2021, 50, 15);
		const body = { daily: { time: partial.time, temperature_2m_mean: partial.temps } };
		expect(() => aggregateArchiveToAnnual(body)).toThrow(/no complete years/);
	});
});

describe('Open-Meteo tool definition', () => {
	it('requires city, cites Open-Meteo, never mentions GML', () => {
		expect(openMeteoToolDefinitions).toHaveLength(1);
		const tool = openMeteoToolDefinitions[0];
		expect(tool.name).toBe('get_city_temperature_history');
		expect(tool.description).toContain('Open-Meteo');
		expect(tool.description).not.toContain('GML');
		const schema = tool.input_schema as { required: string[] };
		expect(schema.required).toEqual(['city']);
	});
});
