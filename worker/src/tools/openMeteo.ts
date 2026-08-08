/**
 * Open-Meteo — city-level historical weather (plan step 12).
 *
 * One tool: get_city_temperature_history(city, start_year?, end_year?) —
 * two-stage: geocode the city name, then fetch daily mean temperatures
 * from the archive API and aggregate to annual means in the Worker
 * (a multi-decade daily series is far too large for a tool_result).
 * Cite as "Open-Meteo". Free tier is non-commercial only (R8).
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ChartPoint, ToolDataResult } from '../types';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

/** Archive API coverage starts in 1940. */
const ARCHIVE_FIRST_YEAR = 1940;
/** Default range start when the caller doesn't specify one. */
const DEFAULT_START_YEAR = 1960;
/**
 * A year needs at least this many non-null daily values to produce an
 * annual mean — excludes partial years (e.g. the current year) and
 * gap-riddled data without demanding a perfect 365.
 */
const MIN_DAYS_PER_YEAR = 330;

export interface GeocodedCity {
	name: string;
	latitude: number;
	longitude: number;
	/** e.g. "US" — included so Claude can disambiguate in its answer */
	countryCode: string;
}

interface GeocodeResponse {
	results?: {
		name?: unknown;
		latitude?: unknown;
		longitude?: unknown;
		country_code?: unknown;
	}[];
}

/** Parse a geocoding API response; throws if the city wasn't found. */
export function parseGeocodeJson(body: unknown, cityQuery: string): GeocodedCity {
	const first = (body as GeocodeResponse | null)?.results?.[0];
	if (!first) {
		throw new Error(`Open-Meteo geocoding: no results for city "${cityQuery}"`);
	}
	const { name, latitude, longitude, country_code } = first;
	if (typeof name !== 'string' || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
		throw new Error('Open-Meteo geocoding: malformed result entry');
	}
	return {
		name,
		latitude: latitude as number,
		longitude: longitude as number,
		countryCode: typeof country_code === 'string' ? country_code : '',
	};
}

interface ArchiveResponse {
	daily?: {
		time?: unknown[];
		temperature_2m_mean?: unknown[];
	};
}

/**
 * Aggregate an archive API daily series to annual mean temperatures.
 * Years with fewer than MIN_DAYS_PER_YEAR non-null values are dropped
 * (partial years would otherwise skew the mean toward their season).
 */
export function aggregateArchiveToAnnual(body: unknown): ChartPoint[] {
	const daily = (body as ArchiveResponse | null)?.daily;
	const times = daily?.time;
	const temps = daily?.temperature_2m_mean;
	if (!Array.isArray(times) || !Array.isArray(temps) || times.length !== temps.length) {
		throw new Error('Open-Meteo archive: response missing aligned daily.time/temperature_2m_mean arrays');
	}

	const byYear = new Map<number, { sum: number; count: number }>();
	for (let i = 0; i < times.length; i++) {
		const time = times[i];
		const temp = temps[i];
		if (typeof time !== 'string' || typeof temp !== 'number' || !Number.isFinite(temp)) continue;
		const year = Number(time.slice(0, 4));
		if (!Number.isInteger(year)) continue;
		const entry = byYear.get(year) ?? { sum: 0, count: 0 };
		entry.sum += temp;
		entry.count += 1;
		byYear.set(year, entry);
	}

	const points: ChartPoint[] = [];
	for (const [year, { sum, count }] of byYear) {
		if (count >= MIN_DAYS_PER_YEAR) {
			points.push({ x: year, y: Number((sum / count).toFixed(2)) });
		}
	}

	if (points.length === 0) {
		throw new Error('Open-Meteo archive: no complete years in the response');
	}
	return points.sort((a, b) => a.x - b.x);
}

export async function runCityTemperatureHistory(input: unknown): Promise<ToolDataResult> {
	const { city, start_year, end_year } = (input ?? {}) as {
		city?: unknown;
		start_year?: unknown;
		end_year?: unknown;
	};

	if (typeof city !== 'string' || city.trim().length === 0) {
		throw new Error('get_city_temperature_history: city must be a non-empty string');
	}
	// Last complete year — the current year would always be dropped as partial
	const maxYear = new Date().getUTCFullYear() - 1;
	const start = start_year === undefined ? DEFAULT_START_YEAR : Number(start_year);
	const end = end_year === undefined ? maxYear : Number(end_year);
	if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start < ARCHIVE_FIRST_YEAR || end > maxYear) {
		throw new Error(
			`get_city_temperature_history: start_year/end_year must be integers with ${ARCHIVE_FIRST_YEAR} <= start <= end <= ${maxYear}`,
		);
	}

	const geocodeResponse = await fetch(`${GEOCODE_URL}?name=${encodeURIComponent(city.trim())}&count=1`);
	if (!geocodeResponse.ok) {
		throw new Error(`Open-Meteo geocoding fetch failed: ${geocodeResponse.status}`);
	}
	const geocoded = parseGeocodeJson(await geocodeResponse.json(), city.trim());

	const archiveUrl =
		`${ARCHIVE_URL}?latitude=${geocoded.latitude}&longitude=${geocoded.longitude}` +
		`&start_date=${start}-01-01&end_date=${end}-12-31` +
		`&daily=temperature_2m_mean&timezone=auto`;
	const archiveResponse = await fetch(archiveUrl);
	if (!archiveResponse.ok) {
		throw new Error(`Open-Meteo archive fetch failed: ${archiveResponse.status}`);
	}
	const points = aggregateArchiveToAnnual(await archiveResponse.json());

	const place = geocoded.countryCode ? `${geocoded.name}, ${geocoded.countryCode}` : geocoded.name;
	return {
		source: 'Open-Meteo',
		description: `Annual mean temperature for ${place} (aggregated from daily means)`,
		unit: '°C',
		points,
	};
}

export const openMeteoToolDefinitions: Tool[] = [
	{
		name: 'get_city_temperature_history',
		description:
			'Get annual average temperature history for a named city, from Open-Meteo. ' +
			'The city name is geocoded first; the result includes the resolved city and country. ' +
			"Returns {x, y} points where x is the year and y is that year's mean temperature in °C. " +
			'Cite this data as "Open-Meteo".',
		input_schema: {
			type: 'object',
			properties: {
				city: { type: 'string', description: 'City name, e.g. "Portland" or "Berlin"' },
				start_year: {
					type: 'integer',
					minimum: ARCHIVE_FIRST_YEAR,
					description: 'First year of the range (default 1960; data begins 1940)',
				},
				end_year: {
					type: 'integer',
					description: 'Last year of the range (default: the last complete year)',
				},
			},
			required: ['city'],
		},
	},
];

export const openMeteoToolNames = ['get_city_temperature_history'];
