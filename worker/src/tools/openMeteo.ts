/**
 * Open-Meteo — city-level historical weather (plan step 12).
 *
 * One tool: get_city_temperature_history(city, granularity?, start_year?,
 * end_year?) — two-stage: geocode the city name, then fetch daily mean
 * temperatures from the archive API and aggregate in the Worker to the
 * requested granularity (annual / monthly / weekly). Aggregation exists
 * because a raw multi-decade daily series is far too large for a
 * tool_result; the span caps below keep every response bounded instead
 * of forcing everything to annual. Cite as "Open-Meteo". Free tier is
 * non-commercial only (R8).
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ChartPoint, ToolDataResult } from '../types';
import { ToolError } from './errors';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

/** Archive API coverage starts in 1940. */
const ARCHIVE_FIRST_YEAR = 1940;
/** Default range start for annual queries. */
const DEFAULT_ANNUAL_START = 1960;

export type CityGranularity = 'annual' | 'monthly' | 'weekly';

/**
 * Span caps (inclusive, in years) keep the aggregated series bounded:
 * weekly ≤ 3 years ≈ 157 points, monthly ≤ 30 years = 360 points,
 * annual = full record ≈ 85 points. A too-wide request throws; Claude
 * sees the error via is_error and can narrow the range or switch
 * granularity.
 */
const MAX_SPAN_YEARS: Record<CityGranularity, number> = {
	annual: Number.POSITIVE_INFINITY,
	monthly: 30,
	weekly: 3,
};

/**
 * A bucket needs at least this many non-null daily values to produce a
 * mean — drops partial periods (the in-progress year/month/week) so
 * they can't skew a mean with only part of a season, while tolerating
 * occasional missing days.
 */
const MIN_DAYS_PER_BUCKET: Record<CityGranularity, number> = {
	annual: 330,
	monthly: 25,
	weekly: 6,
};

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
		throw new ToolError('tool_input_invalid', `Open-Meteo geocoding: no results for city "${cityQuery}"`);
	}
	const { name, latitude, longitude, country_code } = first;
	if (typeof name !== 'string' || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
		throw new ToolError('tool_parse_failed', 'Open-Meteo geocoding: malformed result entry');
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

/** Fractional-year x for a UTC date — same convention as the GML/NCEI monthly series. */
function fractionalYear(date: Date): number {
	const year = date.getUTCFullYear();
	const yearStart = Date.UTC(year, 0, 1);
	const nextYearStart = Date.UTC(year + 1, 0, 1);
	return year + (date.getTime() - yearStart) / (nextYearStart - yearStart);
}

/**
 * Aggregate an archive API daily series into annual, monthly, or weekly
 * (Monday-start) mean temperatures. x is the integer year for annual,
 * a fractional year otherwise. Buckets below MIN_DAYS_PER_BUCKET are
 * dropped, so a trailing in-progress period never skews the series.
 */
export function aggregateArchive(body: unknown, granularity: CityGranularity): ChartPoint[] {
	const daily = (body as ArchiveResponse | null)?.daily;
	const times = daily?.time;
	const temps = daily?.temperature_2m_mean;
	if (!Array.isArray(times) || !Array.isArray(temps) || times.length !== temps.length) {
		throw new ToolError('tool_parse_failed', 'Open-Meteo archive: response missing aligned daily.time/temperature_2m_mean arrays');
	}

	const buckets = new Map<string, { sum: number; count: number; x: number }>();
	for (let i = 0; i < times.length; i++) {
		const time = times[i];
		const temp = temps[i];
		if (typeof time !== 'string' || typeof temp !== 'number' || !Number.isFinite(temp)) continue;
		const date = new Date(`${time}T00:00:00Z`);
		if (Number.isNaN(date.getTime())) continue;

		let key: string;
		let x: number;
		if (granularity === 'annual') {
			const year = date.getUTCFullYear();
			key = String(year);
			x = year;
		} else if (granularity === 'monthly') {
			const year = date.getUTCFullYear();
			const month = date.getUTCMonth() + 1;
			key = `${year}-${month}`;
			x = year + (month - 0.5) / 12;
		} else {
			// Weekly: bucket by the Monday that starts the date's week
			const monday = new Date(date);
			monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
			key = monday.toISOString().slice(0, 10);
			x = fractionalYear(monday);
		}

		const bucket = buckets.get(key) ?? { sum: 0, count: 0, x };
		bucket.sum += temp;
		bucket.count += 1;
		buckets.set(key, bucket);
	}

	const minDays = MIN_DAYS_PER_BUCKET[granularity];
	const points: ChartPoint[] = [];
	for (const { sum, count, x } of buckets.values()) {
		if (count >= minDays) {
			points.push({ x: Number(x.toFixed(3)), y: Number((sum / count).toFixed(2)) });
		}
	}

	if (points.length === 0) {
		throw new ToolError('tool_parse_failed', `Open-Meteo archive: no complete ${granularity} periods in the response`);
	}
	return points.sort((a, b) => a.x - b.x);
}

function isCityGranularity(value: unknown): value is CityGranularity {
	return value === 'annual' || value === 'monthly' || value === 'weekly';
}

export async function runCityTemperatureHistory(input: unknown): Promise<ToolDataResult> {
	const {
		city,
		granularity: rawGranularity,
		start_year,
		end_year,
	} = (input ?? {}) as {
		city?: unknown;
		granularity?: unknown;
		start_year?: unknown;
		end_year?: unknown;
	};

	if (typeof city !== 'string' || city.trim().length === 0) {
		throw new ToolError('tool_input_invalid', 'get_city_temperature_history: city must be a non-empty string');
	}
	const granularity = rawGranularity === undefined ? 'annual' : rawGranularity;
	if (!isCityGranularity(granularity)) {
		throw new ToolError('tool_input_invalid', 'get_city_temperature_history: granularity must be "annual", "monthly", or "weekly"');
	}

	// Annual means need complete years, so the current year is excluded;
	// weekly/monthly may include it — each complete week/month stands alone,
	// which is what makes "this year vs last year so far" answerable.
	const currentYear = new Date().getUTCFullYear();
	const maxYear = granularity === 'annual' ? currentYear - 1 : currentYear;
	const end = end_year === undefined ? maxYear : Number(end_year);
	let start: number;
	if (start_year !== undefined) {
		start = Number(start_year);
	} else if (granularity === 'annual') {
		start = DEFAULT_ANNUAL_START;
	} else if (granularity === 'monthly') {
		start = end - (MAX_SPAN_YEARS.monthly - 1);
	} else {
		start = end - 1; // weekly default: this period and the previous year
	}

	if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start < ARCHIVE_FIRST_YEAR || end > maxYear) {
		throw new ToolError(
			'tool_input_invalid',
			`get_city_temperature_history: start_year/end_year must be integers with ${ARCHIVE_FIRST_YEAR} <= start <= end <= ${maxYear} (for ${granularity} granularity)`,
		);
	}
	const spanYears = end - start + 1;
	if (spanYears > MAX_SPAN_YEARS[granularity]) {
		throw new ToolError(
			'tool_input_invalid',
			`get_city_temperature_history: ${granularity} granularity is limited to a ${MAX_SPAN_YEARS[granularity]}-year span (got ${spanYears}); narrow the range or use a coarser granularity`,
		);
	}

	const geocodeResponse = await fetch(`${GEOCODE_URL}?name=${encodeURIComponent(city.trim())}&count=1`);
	if (!geocodeResponse.ok) {
		throw new ToolError('tool_fetch_failed', `Open-Meteo geocoding fetch failed: ${geocodeResponse.status}`, geocodeResponse.status);
	}
	const geocoded = parseGeocodeJson(await geocodeResponse.json(), city.trim());

	// Clamp to today when the range includes the current year — the archive
	// API rejects future dates
	const today = new Date().toISOString().slice(0, 10);
	const endDate = end === currentYear ? today : `${end}-12-31`;
	const archiveUrl =
		`${ARCHIVE_URL}?latitude=${geocoded.latitude}&longitude=${geocoded.longitude}` +
		`&start_date=${start}-01-01&end_date=${endDate}` +
		`&daily=temperature_2m_mean&timezone=auto`;
	const archiveResponse = await fetch(archiveUrl);
	if (!archiveResponse.ok) {
		throw new ToolError('tool_fetch_failed', `Open-Meteo archive fetch failed: ${archiveResponse.status}`, archiveResponse.status);
	}
	const points = aggregateArchive(await archiveResponse.json(), granularity);

	const place = geocoded.countryCode ? `${geocoded.name}, ${geocoded.countryCode}` : geocoded.name;
	return {
		source: 'Open-Meteo',
		description: `${granularity[0].toUpperCase()}${granularity.slice(1)} mean temperature for ${place} (aggregated from daily means)`,
		unit: '°C',
		points,
	};
}

export const openMeteoToolDefinitions: Tool[] = [
	{
		name: 'get_city_temperature_history',
		description:
			'Get average temperature history for a named city, from Open-Meteo. ' +
			'The city name is geocoded first; the result includes the resolved city and country. ' +
			'Returns {x, y} points where y is the mean temperature in °C and x is the year ' +
			'(fractional for monthly/weekly points). Granularity is capped by range span: ' +
			'weekly up to a 3-year span, monthly up to 30 years, annual for the full record since 1940. ' +
			'Weekly and monthly ranges may include the current year (complete periods so far); ' +
			'annual covers complete years only. Cite this data as "Open-Meteo".',
		input_schema: {
			type: 'object',
			properties: {
				city: { type: 'string', description: 'City name, e.g. "Portland" or "Berlin"' },
				granularity: {
					type: 'string',
					enum: ['annual', 'monthly', 'weekly'],
					description:
						'annual = one point per complete year (default); monthly = one point per month; weekly = one point per Monday-start week',
				},
				start_year: {
					type: 'integer',
					minimum: ARCHIVE_FIRST_YEAR,
					description: 'First year of the range (data begins 1940). Defaults: annual 1960, monthly last 30 years, weekly last 2 years',
				},
				end_year: {
					type: 'integer',
					description: 'Last year of the range (default: current year for weekly/monthly, last complete year for annual)',
				},
			},
			required: ['city'],
		},
	},
];

export const openMeteoToolNames = ['get_city_temperature_history'];
