/**
 * NOAA National Centers for Environmental Information (plan step 10).
 *
 * Two tools: get_surface_temperature (Climate at a Glance JSON) and
 * get_ocean_heat_content (yearly basin .dat files). NOT the same agency
 * division as GML — cite as "NOAA NCEI (NOAAGlobalTemp)" / "NOAA NCEI",
 * never "NOAA GML" (R1, Section 7).
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ChartPoint, ToolDataResult } from '../types';
import { ToolError, readJsonBody } from './errors';

const CAG_BASE = 'https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/global/time-series/globe/land_ocean';
const OHC_BASE = 'https://www.ncei.noaa.gov/data/oceans/woa/DATA_ANALYSIS/3M_HEAT_CONTENT/DATA/basin/yearly';

export type TemperatureScale = 'monthly' | 'annual';
export type OhcBasin = 'world' | 'pacific' | 'atlantic' | 'indian';
export type OhcDepth = '700m' | '2000m';

/** Earliest year in the NOAAGlobalTemp record. */
const CAG_FIRST_YEAR = 1880;

interface CagResponse {
	description?: { units?: string };
	data?: Record<string, { departure?: unknown }>;
}

/**
 * Parse a Climate at a Glance time-series JSON body. Keys are "YYYY"
 * (annual) or "YYYYMM" (monthly); monthly x becomes a fractional year
 * centered on the month, matching the GML monthly convention.
 */
export function parseCagJson(body: unknown): ChartPoint[] {
	const data = (body as CagResponse | null)?.data;
	if (!data || typeof data !== 'object') {
		throw new ToolError('tool_parse_failed', 'NOAA NCEI CAG: response has no "data" object');
	}

	const points: ChartPoint[] = [];
	for (const [key, value] of Object.entries(data)) {
		const departure = Number(value?.departure);
		if (!Number.isFinite(departure)) continue;

		let x: number;
		if (/^\d{4}$/.test(key)) {
			x = Number(key);
		} else if (/^\d{6}$/.test(key)) {
			const year = Number(key.slice(0, 4));
			const month = Number(key.slice(4, 6));
			if (month < 1 || month > 12) continue;
			x = year + (month - 0.5) / 12;
		} else {
			continue;
		}
		points.push({ x, y: departure });
	}

	if (points.length === 0) {
		throw new ToolError('tool_parse_failed', 'NOAA NCEI CAG: no data points parsed');
	}
	return points.sort((a, b) => a.x - b.x);
}

export async function runSurfaceTemperature(input: unknown): Promise<ToolDataResult> {
	const { start_year, end_year, scale } = (input ?? {}) as {
		start_year?: unknown;
		end_year?: unknown;
		scale?: unknown;
	};

	if (scale !== 'monthly' && scale !== 'annual') {
		throw new ToolError('tool_input_invalid', 'get_surface_temperature: scale must be "monthly" or "annual"');
	}
	const start = Number(start_year);
	const end = Number(end_year);
	const maxYear = new Date().getUTCFullYear();
	if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start < CAG_FIRST_YEAR || end > maxYear + 1) {
		throw new ToolError(
			'tool_input_invalid',
			`get_surface_temperature: start_year/end_year must be integers with ${CAG_FIRST_YEAR} <= start <= end <= ${maxYear + 1}`,
		);
	}

	// Annual = 12-month averages ending in December (12/12); monthly = 1/0
	const scalePath = scale === 'annual' ? '12/12' : '1/0';
	const url = `${CAG_BASE}/${scalePath}/${start}-${end}.json`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new ToolError('tool_fetch_failed', `NOAA NCEI CAG fetch failed: ${response.status} for ${url}`, response.status);
	}

	const points = parseCagJson(await readJsonBody(response, 'NOAA NCEI CAG'));
	return {
		source: 'NOAA NCEI (NOAAGlobalTemp)',
		description: `Global land+ocean surface temperature anomaly vs. 1901–2000 average (${scale})`,
		unit: '°C',
		points,
	};
}

const OHC_BASIN_CONFIG: Record<OhcBasin, { fileCode: string; column: string; label: string }> = {
	world: { fileCode: 'w0', column: 'WO', label: 'World' },
	pacific: { fileCode: 'p0', column: 'PO', label: 'Pacific' },
	atlantic: { fileCode: 'a0', column: 'AO', label: 'Atlantic' },
	indian: { fileCode: 'i0', column: 'IO', label: 'Indian' },
};

/**
 * Guard against indexing OHC_BASIN_CONFIG with an arbitrary string:
 * `config['__proto__']` returns Object.prototype (truthy), which would
 * slip past a `!config` check. Match the value to a known key first.
 */
function isOhcBasin(value: unknown): value is OhcBasin {
	return value === 'world' || value === 'pacific' || value === 'atlantic' || value === 'indian';
}

/**
 * Parse a yearly OHC basin .dat file: whitespace-delimited, header row
 * of column names (YEAR, then basin/hemisphere columns with standard
 * errors). x = integer year (the file's YYYY.500 midpoints floored),
 * y = the requested basin column.
 */
export function parseOhcDat(text: string, basinColumn: string): ChartPoint[] {
	const lines = text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	if (lines.length < 2) {
		throw new ToolError('tool_parse_failed', 'NOAA NCEI OHC: no header/data rows found');
	}

	const header = lines[0].split(/\s+/);
	const yearIndex = header.indexOf('YEAR');
	const basinIndex = header.indexOf(basinColumn);
	if (yearIndex === -1 || basinIndex === -1) {
		throw new ToolError('tool_parse_failed', `NOAA NCEI OHC: expected "YEAR" and "${basinColumn}" columns, got header "${lines[0]}"`);
	}

	const points: ChartPoint[] = [];
	for (const line of lines.slice(1)) {
		const cells = line.split(/\s+/);
		const year = Number(cells[yearIndex]);
		const value = Number(cells[basinIndex]);
		if (Number.isFinite(year) && Number.isFinite(value)) {
			points.push({ x: Math.floor(year), y: value });
		}
	}

	if (points.length === 0) {
		throw new ToolError('tool_parse_failed', 'NOAA NCEI OHC: header matched but no data rows parsed');
	}
	return points;
}

export async function runOceanHeatContent(input: unknown): Promise<ToolDataResult> {
	const { basin, depth } = (input ?? {}) as { basin?: unknown; depth?: unknown };

	if (!isOhcBasin(basin)) {
		throw new ToolError('tool_input_invalid', 'get_ocean_heat_content: basin must be "world", "pacific", "atlantic", or "indian"');
	}
	const basinConfig = OHC_BASIN_CONFIG[basin];
	if (depth !== '700m' && depth !== '2000m') {
		throw new ToolError('tool_input_invalid', 'get_ocean_heat_content: depth must be "700m" or "2000m"');
	}

	const url = `${OHC_BASE}/h22-${basinConfig.fileCode}-${depth === '700m' ? '700' : '2000'}m.dat`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new ToolError('tool_fetch_failed', `NOAA NCEI OHC fetch failed: ${response.status} for ${url}`, response.status);
	}

	const points = parseOhcDat(await response.text(), basinConfig.column);
	return {
		source: 'NOAA NCEI',
		description: `${basinConfig.label} ocean heat content anomaly, 0–${depth} (annual)`,
		unit: '10²² J',
		points,
	};
}

export const nceiToolDefinitions: Tool[] = [
	{
		name: 'get_surface_temperature',
		description:
			'Get global land+ocean surface temperature anomaly (°C vs. the 1901–2000 average) from NOAA NCEI. ' +
			'Returns {x, y} points where x is the year (fractional for monthly data) and y is the anomaly in °C. ' +
			'Cite this data as "NOAA NCEI (NOAAGlobalTemp)".',
		input_schema: {
			type: 'object',
			properties: {
				start_year: { type: 'integer', minimum: CAG_FIRST_YEAR, description: 'First year of the range (1880 or later)' },
				end_year: { type: 'integer', description: 'Last year of the range' },
				scale: {
					type: 'string',
					enum: ['monthly', 'annual'],
					description: 'monthly = one point per month; annual = one point per year',
				},
			},
			required: ['start_year', 'end_year', 'scale'],
		},
	},
	{
		name: 'get_ocean_heat_content',
		description:
			'Get ocean heat content anomaly (10²² joules) from NOAA NCEI, annual since 1955. ' +
			'Returns {x, y} points where x is the year and y is the heat content anomaly. ' +
			'Cite this data as "NOAA NCEI".',
		input_schema: {
			type: 'object',
			properties: {
				basin: {
					type: 'string',
					enum: ['world', 'pacific', 'atlantic', 'indian'],
					description: 'Ocean basin ("world" for the global ocean)',
				},
				depth: {
					type: 'string',
					enum: ['700m', '2000m'],
					description: 'Integration depth: upper 700m or upper 2000m',
				},
			},
			required: ['basin', 'depth'],
		},
	},
];

export const nceiToolNames = ['get_surface_temperature', 'get_ocean_heat_content'];

/** Dispatch an NCEI tool call (used by registry.ts). */
export async function runNceiTool(toolName: string, input: unknown): Promise<ToolDataResult> {
	if (toolName === 'get_surface_temperature') return runSurfaceTemperature(input);
	if (toolName === 'get_ocean_heat_content') return runOceanHeatContent(input);
	throw new ToolError('unknown_tool', `Unknown NOAA NCEI tool: ${toolName}`);
}
