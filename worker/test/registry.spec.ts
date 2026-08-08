import { describe, it, expect } from 'vitest';
import { allToolDefinitions, runTool } from '../src/tools/registry';

describe('tool registry', () => {
	it('registers all 7 tools in the fixed plan order (3 GML + 2 NCEI + 1 NSIDC + 1 Open-Meteo)', () => {
		// Exact order matters: tools render first in the prompt, so any
		// reordering silently invalidates the prompt cache (Section 8.5).
		expect(allToolDefinitions.map((tool) => tool.name)).toEqual([
			'get_co2_levels',
			'get_methane_levels',
			'get_nitrous_oxide_levels',
			'get_surface_temperature',
			'get_ocean_heat_content',
			'get_arctic_sea_ice',
			'get_city_temperature_history',
		]);
	});

	it('every tool has a description and an object input schema', () => {
		for (const tool of allToolDefinitions) {
			expect(tool.description && tool.description.length).toBeGreaterThan(20);
			expect((tool.input_schema as { type: string }).type).toBe('object');
		}
	});

	it('rejects unknown tool names', async () => {
		await expect(runTool('get_stock_prices', {})).rejects.toThrow(/Unknown tool/);
	});

	it('dispatches to the right module (validation errors prove routing, no network needed)', async () => {
		// Each handler validates input before any fetch, so a distinctive
		// per-module validation error shows the call reached the right handler.
		await expect(runTool('get_co2_levels', { granularity: 'weekly' })).rejects.toThrow(/granularity/);
		await expect(runTool('get_surface_temperature', { start_year: 1700, end_year: 1800, scale: 'annual' })).rejects.toThrow(/1880/);
		await expect(runTool('get_arctic_sea_ice', { month: 13 })).rejects.toThrow(/month/);
		await expect(runTool('get_city_temperature_history', { city: '  ' })).rejects.toThrow(/city/);
	});
});
