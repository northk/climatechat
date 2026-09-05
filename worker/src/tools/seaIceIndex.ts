/**
 * NSIDC/NOAA Sea Ice Index (plan step 11).
 *
 * One tool: get_arctic_sea_ice(month) — monthly Arctic sea ice extent in
 * million km², one file per calendar month, yearly rows since 1979.
 * Cite as "NSIDC/NOAA Sea Ice Index" — never "NOAA GML" (R1, Section 7).
 *
 * ⚠️ The v4.0 in the URL is a versioned file name, not a stable API —
 * NSIDC has bumped it before (v1→v2→v3→v4) and will again; when that
 * happens, re-download the fixture and re-run the parser tests.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ChartPoint, ToolDataResult } from '../types';
import { ToolError, fetchOk } from './errors';

const SEA_ICE_BASE = 'https://noaadata.apps.nsidc.org/NOAA/G02135/north/monthly/data';

const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
];

/**
 * Parse an NSIDC monthly extent CSV: a header row (year, mo,
 * source_dataset, region, extent, area — cells are whitespace-padded),
 * then one row per year. x = year, y = extent (million km²).
 */
export function parseSeaIceCsv(csv: string): ChartPoint[] {
	const lines = csv
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	if (lines.length < 2) {
		throw new ToolError('tool_parse_failed', 'NSIDC sea ice CSV: no header/data rows found');
	}

	const header = lines[0].split(',').map((column) => column.trim().toLowerCase());
	const yearIndex = header.indexOf('year');
	const extentIndex = header.indexOf('extent');
	if (yearIndex === -1 || extentIndex === -1) {
		throw new ToolError('tool_parse_failed', `NSIDC sea ice CSV: expected "year" and "extent" columns, got header "${lines[0]}"`);
	}

	const points: ChartPoint[] = [];
	for (const line of lines.slice(1)) {
		const cells = line.split(',').map((cell) => cell.trim());
		const year = Number(cells[yearIndex]);
		const extent = Number(cells[extentIndex]);
		// Skip unparseable rows and NSIDC's -9999 missing-value sentinel;
		// real extent is always positive.
		if (Number.isInteger(year) && Number.isFinite(extent) && extent > 0) {
			points.push({ x: year, y: extent });
		}
	}

	if (points.length === 0) {
		throw new ToolError('tool_parse_failed', 'NSIDC sea ice CSV: header matched but no data rows parsed');
	}
	return points;
}

export async function runArcticSeaIce(input: unknown): Promise<ToolDataResult> {
	const month = Number((input as { month?: unknown } | null)?.month);
	if (!Number.isInteger(month) || month < 1 || month > 12) {
		throw new ToolError('tool_input_invalid', 'get_arctic_sea_ice: month must be an integer from 1 to 12');
	}

	const paddedMonth = String(month).padStart(2, '0');
	const url = `${SEA_ICE_BASE}/N_${paddedMonth}_extent_v4.0.csv`;
	const response = await fetchOk(url, 'NSIDC sea ice');

	const points = parseSeaIceCsv(await response.text());
	return {
		source: 'NSIDC/NOAA Sea Ice Index',
		description: `Arctic sea ice extent each ${MONTH_NAMES[month - 1]} since 1979`,
		unit: 'million km²',
		points,
	};
}

export const seaIceToolDefinitions: Tool[] = [
	{
		name: 'get_arctic_sea_ice',
		description:
			'Get Arctic sea ice extent (million square km) for one calendar month across all years since 1979, ' +
			'from the NSIDC/NOAA Sea Ice Index. Returns {x, y} points where x is the year and y is the extent. ' +
			'Use month 9 (September) for the annual minimum, month 3 (March) for the maximum. ' +
			'Cite this data as "NSIDC/NOAA Sea Ice Index".',
		input_schema: {
			type: 'object',
			properties: {
				month: {
					type: 'integer',
					minimum: 1,
					maximum: 12,
					description: 'Calendar month to get the yearly series for (1 = January … 12 = December)',
				},
			},
			required: ['month'],
		},
	},
];

export const seaIceToolNames = ['get_arctic_sea_ice'];
