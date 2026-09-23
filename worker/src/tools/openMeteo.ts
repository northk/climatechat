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
 *
 * Annual and monthly series are served from a per-city KV cache (R12).
 * Open-Meteo bills every 2 weeks of data as one API call, so a default
 * annual query (1960 on) costs ~1,720 of the free tier's 10,000 daily
 * calls. Each city's record is cached in two KV segments, each
 * aggregated to both series and sliced for every later request about that
 * city, whatever the question wording:
 *   - history: 1940 through the end of the year before last. Past data
 *     never changes, so it's fetched once per city per year (~2,190 calls).
 *   - recent: last year through today, refreshed daily (~52 calls).
 * Last year stays in `recent` because the archive lags real time by a few
 * days and its newest data is preliminary, revised for a couple of months
 * afterwards. Freezing late December into `history` in early January
 * would pin incomplete or superseded values for a year.
 * Weekly ranges are small (≤3 years ≈ 78 calls) and stay uncached.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ChartPoint, ToolDataResult } from '../types';
import { ToolError, fetchJson } from './errors';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

/** Archive API coverage starts in 1940. */
const ARCHIVE_FIRST_YEAR = 1940;
/** Default range start for annual queries. */
const DEFAULT_ANNUAL_START = 1960;

/**
 * `recent` segment lifetime: bounds how stale the newest complete month
 * can get, at ~52 calls per active city per day.
 */
export const RECENT_TTL_SECONDS = 24 * 60 * 60;
/**
 * `history` segment lifetime. Validity comes from the year in the key (a
 * new year means a new key, like rateLimit.ts's date-keyed counters);
 * this TTL only garbage-collects entries for cities nobody asks about.
 */
export const HISTORY_TTL_SECONDS = 400 * 24 * 60 * 60;
/** Bump the version if the cached shape or aggregation ever changes. */
const CITY_CACHE_PREFIX = 'om:v2:';

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
		// tool_input_invalid, not tool_parse_failed: an unresolved city is
		// almost always a bad/obscure query. A geocoder outage would surface
		// as a non-2xx or invalid JSON instead. (Pre-Phase-4 review #8.)
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

/** A city's full annual and monthly series, as cached (R12). */
export interface CitySeries {
	annual: ChartPoint[];
	monthly: ChartPoint[];
}

/**
 * Cache keys from the geocoded coordinates, not the query text:
 * "Portland", "portland" and "Portland, Oregon" geocode to the same point
 * and share entries. 2 decimals ≈ 1 km, finer than the archive's grid.
 * Both keys carry the current year, so the segment boundary moves at New
 * Year without ever pairing a new `history` with an old `recent` — they
 * would overlap on a year and duplicate its points.
 */
export function cityCacheKeys(city: GeocodedCity, currentYear: number): { history: string; recent: string } {
	const coords = `${city.latitude.toFixed(2)},${city.longitude.toFixed(2)}`;
	return {
		history: `${CITY_CACHE_PREFIX}hist:${currentYear}:${coords}`,
		recent: `${CITY_CACHE_PREFIX}recent:${currentYear}:${coords}`,
	};
}

function archiveUrl(city: GeocodedCity, startDate: string, endDate: string): string {
	return (
		`${ARCHIVE_URL}?latitude=${city.latitude}&longitude=${city.longitude}` +
		`&start_date=${startDate}&end_date=${endDate}` +
		`&daily=temperature_2m_mean&timezone=auto`
	);
}

/** A cached entry, or null on a miss, a KV error, or a corrupt value. */
async function readCachedSeries(kv: KVNamespace, key: string): Promise<CitySeries | null> {
	try {
		const stored = await kv.get(key);
		if (!stored) return null;
		const parsed = JSON.parse(stored) as Partial<CitySeries> | null;
		return Array.isArray(parsed?.annual) && Array.isArray(parsed?.monthly) ? (parsed as CitySeries) : null;
	} catch {
		return null;
	}
}

/**
 * One cache segment: from KV when cached, else one archive fetch for the
 * date range, aggregated both ways and written back.
 */
async function getSegment(
	city: GeocodedCity,
	kv: KVNamespace | undefined,
	key: string,
	startDate: string,
	endDate: string,
	ttlSeconds: number,
): Promise<CitySeries> {
	if (kv) {
		const cached = await readCachedSeries(kv, key);
		if (cached) return cached;
	}
	const body = await fetchJson(archiveUrl(city, startDate, endDate), 'Open-Meteo archive');
	const segment: CitySeries = { annual: aggregateArchive(body, 'annual'), monthly: aggregateArchive(body, 'monthly') };
	if (kv) {
		try {
			await kv.put(key, JSON.stringify(segment), { expirationTtl: ttlSeconds });
		} catch {
			// A failed write (e.g. the free tier's 1,000 writes/day, R4) only
			// costs the next request a refetch; the answer itself is fine
		}
	}
	return segment;
}

/**
 * The city's full annual + monthly series, 1940 → today: `history` +
 * `recent` concatenated. The split falls on a year boundary, so no annual
 * or monthly bucket spans it and concatenating is exact. `kv` is optional
 * so unit tests can exercise the tool without a binding; production
 * always passes it (index.ts → askClaude → runTool).
 */
async function getCitySeries(city: GeocodedCity, kv: KVNamespace | undefined): Promise<CitySeries> {
	const currentYear = new Date().getUTCFullYear();
	const keys = cityCacheKeys(city, currentYear);
	// Clamp to today — the archive API rejects future dates
	const today = new Date().toISOString().slice(0, 10);
	// allSettled, not all: if one segment fails, Promise.all would reject
	// while the other's fetch and KV write are still running, leaving work
	// in flight after the tool has already failed. Wait for both, then
	// surface the first failure.
	const [history, recent] = await Promise.allSettled([
		getSegment(city, kv, keys.history, `${ARCHIVE_FIRST_YEAR}-01-01`, `${currentYear - 2}-12-31`, HISTORY_TTL_SECONDS),
		getSegment(city, kv, keys.recent, `${currentYear - 1}-01-01`, today, RECENT_TTL_SECONDS),
	]);
	if (history.status === 'rejected') throw history.reason;
	if (recent.status === 'rejected') throw recent.reason;
	return {
		annual: [...history.value.annual, ...recent.value.annual],
		monthly: [...history.value.monthly, ...recent.value.monthly],
	};
}

/**
 * Points whose year falls in [start, end]. Monthly x values are
 * fractional (month-centered), so compare on the integer year.
 */
export function sliceSeries(points: ChartPoint[], start: number, end: number): ChartPoint[] {
	return points.filter((point) => Math.floor(point.x) >= start && Math.floor(point.x) <= end);
}

function isCityGranularity(value: unknown): value is CityGranularity {
	return value === 'annual' || value === 'monthly' || value === 'weekly';
}

export async function runCityTemperatureHistory(input: unknown, kv?: KVNamespace): Promise<ToolDataResult> {
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

	const geocodeUrl = `${GEOCODE_URL}?name=${encodeURIComponent(city.trim())}&count=1`;
	const geocoded = parseGeocodeJson(await fetchJson(geocodeUrl, 'Open-Meteo geocoding'), city.trim());

	let points: ChartPoint[];
	if (granularity === 'weekly') {
		// Clamp to today when the range includes the current year — the
		// archive API rejects future dates
		const today = new Date().toISOString().slice(0, 10);
		const endDate = end === currentYear ? today : `${end}-12-31`;
		points = aggregateArchive(await fetchJson(archiveUrl(geocoded, `${start}-01-01`, endDate), 'Open-Meteo archive'), 'weekly');
	} else {
		points = sliceSeries((await getCitySeries(geocoded, kv))[granularity], start, end);
		if (points.length === 0) {
			// Same outcome as the uncached path, where aggregateArchive throws
			// on a range with no complete period (e.g. monthly, current year,
			// in the first days of January)
			throw new ToolError('tool_parse_failed', `Open-Meteo archive: no complete ${granularity} periods in the requested range`);
		}
	}

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
