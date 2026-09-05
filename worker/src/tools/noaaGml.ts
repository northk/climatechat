/**
 * NOAA Global Monitoring Laboratory — greenhouse gases only (plan step 9).
 *
 * Three tools: get_co2_levels, get_methane_levels, get_nitrous_oxide_levels.
 * Flat CSV files, no API key. Cite as "NOAA GML" — GML does NOT publish
 * temperature, sea ice, or ocean heat data (those are NCEI/NSIDC; see R1).
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ChartPoint, ToolDataResult } from '../types';
import { ToolError, fetchOk } from './errors';

const GML_BASE = 'https://gml.noaa.gov/webdata/ccgg/trends';

export type GmlGranularity = 'monthly' | 'annual';

interface GasConfig {
	toolName: string;
	/** Path segment and file prefix, e.g. "co2" → co2/co2_mm_gl.csv */
	slug: string;
	gasLabel: string;
	unit: 'ppm' | 'ppb';
}

const GASES: GasConfig[] = [
	{ toolName: 'get_co2_levels', slug: 'co2', gasLabel: 'CO2', unit: 'ppm' },
	{ toolName: 'get_methane_levels', slug: 'ch4', gasLabel: 'CH4', unit: 'ppb' },
	{ toolName: 'get_nitrous_oxide_levels', slug: 'n2o', gasLabel: 'N2O', unit: 'ppb' },
];

function gmlUrl(slug: string, granularity: GmlGranularity): string {
	const file = granularity === 'monthly' ? `${slug}_mm_gl.csv` : `${slug}_annmean_gl.csv`;
	return `${GML_BASE}/${slug}/${file}`;
}

/**
 * Parse a GML trends CSV (either shape) into chart points.
 *
 * Layout: `#` comment lines, then a header row, then data rows.
 * Monthly x = the `decimal` column (fractional year), y = `average`;
 * annual x = `year`, y = `mean`. Columns are located by header name, not
 * position, so upstream column additions don't break parsing.
 */
export function parseGmlCsv(csv: string, granularity: GmlGranularity): ChartPoint[] {
	const lines = csv
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith('#'));

	if (lines.length < 2) {
		throw new ToolError('tool_parse_failed', 'NOAA GML CSV: no header/data rows found');
	}

	const header = lines[0].split(',').map((column) => column.trim().toLowerCase());
	const xName = granularity === 'monthly' ? 'decimal' : 'year';
	const yName = granularity === 'monthly' ? 'average' : 'mean';
	const xIndex = header.indexOf(xName);
	const yIndex = header.indexOf(yName);

	if (xIndex === -1 || yIndex === -1) {
		throw new ToolError('tool_parse_failed', `NOAA GML CSV: expected "${xName}" and "${yName}" columns, got header "${lines[0]}"`);
	}

	const points: ChartPoint[] = [];
	for (const line of lines.slice(1)) {
		const cells = line.split(',');
		const x = Number(cells[xIndex]);
		const y = Number(cells[yIndex]);
		// Skip unparseable rows and GML's negative missing-value sentinels
		// (e.g. -999.99); real concentrations are always positive.
		if (Number.isFinite(x) && Number.isFinite(y) && y > 0) {
			points.push({ x, y });
		}
	}

	if (points.length === 0) {
		throw new ToolError('tool_parse_failed', 'NOAA GML CSV: header matched but no data rows parsed');
	}

	return points;
}

function isGmlGranularity(value: unknown): value is GmlGranularity {
	return value === 'monthly' || value === 'annual';
}

/**
 * Execute one of the three GML tools. `input` is Claude's raw tool input
 * (untrusted — validated here).
 */
export async function runGmlTool(toolName: string, input: unknown): Promise<ToolDataResult> {
	const gas = GASES.find((candidate) => candidate.toolName === toolName);
	if (!gas) {
		throw new ToolError('unknown_tool', `Unknown NOAA GML tool: ${toolName}`);
	}

	const granularity = (input as { granularity?: unknown } | null)?.granularity;
	if (!isGmlGranularity(granularity)) {
		throw new ToolError('tool_input_invalid', `${toolName}: granularity must be "monthly" or "annual"`);
	}

	const response = await fetchOk(gmlUrl(gas.slug, granularity), 'NOAA GML');
	const points = parseGmlCsv(await response.text(), granularity);
	return {
		source: 'NOAA GML',
		description: `Global atmospheric ${gas.gasLabel} (${granularity} mean)`,
		unit: gas.unit,
		points,
	};
}

function gasToolDefinition(gas: GasConfig): Tool {
	return {
		name: gas.toolName,
		description:
			`Get global atmospheric ${gas.gasLabel} concentration (${gas.unit}) from NOAA GML. ` +
			`Returns a time series of {x, y} points where x is the year (fractional ` +
			`for monthly data) and y is the concentration in ${gas.unit}. ` +
			`Cite this data as "NOAA GML".`,
		input_schema: {
			type: 'object',
			properties: {
				granularity: {
					type: 'string',
					enum: ['monthly', 'annual'],
					description: 'monthly = one point per month (fractional-year x); annual = one point per year',
				},
			},
			required: ['granularity'],
		},
	};
}

/** Claude tool definitions for the three GML tools (registered in registry.ts). */
export const gmlToolDefinitions: Tool[] = GASES.map(gasToolDefinition);

/** Tool names this module handles (used by the registry dispatcher). */
export const gmlToolNames: string[] = GASES.map((gas) => gas.toolName);
