/**
 * Tool registry (plan step 13): the full Claude tool list and the
 * dispatcher the Phase 3 loop calls to execute a tool_use block.
 *
 * Definition order is deliberate and must stay deterministic — tools
 * render first in the prompt, so any reordering silently invalidates
 * the Anthropic prompt cache (Section 8.5). Append new tools at the
 * end; never sort dynamically.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ToolDataResult } from '../types';
import { gmlToolDefinitions, gmlToolNames, runGmlTool } from './noaaGml';
import { nceiToolDefinitions, nceiToolNames, runNceiTool } from './noaaNcei';
import { seaIceToolDefinitions, seaIceToolNames, runArcticSeaIce } from './seaIceIndex';
import { openMeteoToolDefinitions, openMeteoToolNames, runCityTemperatureHistory } from './openMeteo';

/** All 7 tool definitions, in fixed registration order (3 GML + 2 NCEI + 1 NSIDC + 1 Open-Meteo). */
export const allToolDefinitions: Tool[] = [
	...gmlToolDefinitions,
	...nceiToolDefinitions,
	...seaIceToolDefinitions,
	...openMeteoToolDefinitions,
];

/**
 * Execute one tool call. Throws on unknown tool name, invalid input, or
 * upstream failure — the Phase 3 loop catches and returns is_error
 * tool_results to Claude (plan step 16); handlers never decide policy.
 */
export async function runTool(toolName: string, input: unknown): Promise<ToolDataResult> {
	if (gmlToolNames.includes(toolName)) return runGmlTool(toolName, input);
	if (nceiToolNames.includes(toolName)) return runNceiTool(toolName, input);
	if (seaIceToolNames.includes(toolName)) return runArcticSeaIce(input);
	if (openMeteoToolNames.includes(toolName)) return runCityTemperatureHistory(input);
	throw new Error(`Unknown tool: ${toolName}`);
}
