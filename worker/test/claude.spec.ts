/**
 * Chart-injection and loop tests for claude.ts (plan step 17): scripted
 * mock responses stand in for the Anthropic API; tool execution uses
 * the real registry (validation errors need no network). No live Claude
 * calls in the suite.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { askClaude, parseEnvelope, MODEL, MAX_TOKENS } from '../src/claude';
import type { ToolDataResult } from '../src/types';

const usage = { input_tokens: 100, output_tokens: 50 };

function textResponse(text: string): Message {
	return {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: MODEL,
		content: [{ type: 'text', text, citations: null }],
		stop_reason: 'end_turn',
		stop_sequence: null,
		usage,
	} as unknown as Message;
}

function toolUseResponse(blocks: { id: string; name: string; input: unknown }[]): Message {
	return {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: MODEL,
		content: blocks.map((block) => ({ type: 'tool_use', ...block })),
		stop_reason: 'tool_use',
		stop_sequence: null,
		usage,
	} as unknown as Message;
}

/** Scripted MessageCreator: returns the queued responses in order and records calls. */
function scriptedCreator(responses: Message[]) {
	const calls: MessageCreateParamsNonStreaming[] = [];
	const create = vi.fn((params: MessageCreateParamsNonStreaming) => {
		calls.push(params);
		const next = responses.shift();
		if (!next) throw new Error('scripted creator ran out of responses');
		return Promise.resolve(next);
	});
	return { create, calls };
}

const user = (text: string) => [{ role: 'user' as const, content: text }];

const sampleResult: ToolDataResult = {
	source: 'NOAA GML',
	description: 'Global atmospheric CO2 (annual mean)',
	unit: 'ppm',
	points: [
		{ x: 1979, y: 336.85 },
		{ x: 1980, y: 338.91 },
	],
};

describe('askClaude - request shape', () => {
	it('never sets temperature/top_p/top_k, uses the pinned model and max_tokens, and marks two cache breakpoints', async () => {
		const { create, calls } = scriptedCreator([textResponse('{"type":"text","answer":"ok"}')]);
		await askClaude(user('What is the current CO2 level?'), create);

		const params = calls[0];
		expect(params).not.toHaveProperty('temperature');
		expect(params).not.toHaveProperty('top_p');
		expect(params).not.toHaveProperty('top_k');
		expect(params.model).toBe(MODEL);
		expect(params.max_tokens).toBe(MAX_TOKENS);
		expect(params.tools).toHaveLength(7);

		const system = params.system as { cache_control?: unknown }[];
		expect(system[system.length - 1].cache_control).toEqual({ type: 'ephemeral' });
		const lastMessage = params.messages[params.messages.length - 1];
		const lastBlock = (lastMessage.content as { cache_control?: unknown }[]).at(-1);
		expect(lastBlock?.cache_control).toEqual({ type: 'ephemeral' });
	});
});

describe('askClaude - tool-use loop', () => {
	it('executes a tool call and returns the expanded chart envelope with injected data (step 17 core case)', async () => {
		// Round 1: Claude calls get_co2_levels. We can't let the real handler
		// fetch, so the tool call uses an invalid granularity... no — this is
		// the happy path: use a valid input but stub fetch at the module level.
		// Simpler and honest: intercept globalThis.fetch with the fixture CSV.
		const csv = 'year,mean,unc\n1979,336.85,0.10\n1980,338.91,0.07';
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(csv, { status: 200 }));

		const chartJson = JSON.stringify({
			type: 'chart',
			chartType: 'line',
			title: 'Global CO2 (annual)',
			xLabel: 'Year',
			yLabel: 'CO2 (ppm)',
			datasets: [{ label: 'CO2', sourceToolCallId: 'toolu_01' }],
			explanation: 'CO2 rose from 336.85 to 338.91 ppm (NOAA GML).',
		});
		const { create, calls } = scriptedCreator([
			toolUseResponse([{ id: 'toolu_01', name: 'get_co2_levels', input: { granularity: 'annual' } }]),
			textResponse(chartJson),
		]);

		const result = await askClaude(user('Chart CO2 since 1979'), create);
		fetchSpy.mockRestore();

		expect(result).toEqual({
			type: 'chart',
			chartType: 'line',
			title: 'Global CO2 (annual)',
			xLabel: 'Year',
			yLabel: 'CO2 (ppm)',
			datasets: [
				{
					label: 'CO2',
					data: [
						{ x: 1979, y: 336.85 },
						{ x: 1980, y: 338.91 },
					],
				},
			],
			explanation: 'CO2 rose from 336.85 to 338.91 ppm (NOAA GML).',
		});

		// Round 2's request must carry the structured tool_result back
		const round2 = calls[1];
		const toolResultMsg = round2.messages[round2.messages.length - 1];
		const blocks = toolResultMsg.content as { type: string; tool_use_id?: string; is_error?: boolean }[];
		expect(blocks[0].type).toBe('tool_result');
		expect(blocks[0].tool_use_id).toBe('toolu_01');
		expect(blocks[0].is_error).toBeUndefined();
	});

	it('turns a throwing tool handler into an is_error tool_result and keeps looping (step 17 failure case)', async () => {
		const { create, calls } = scriptedCreator([
			// Invalid granularity: the real registry throws before any fetch
			toolUseResponse([{ id: 'toolu_02', name: 'get_co2_levels', input: { granularity: 'weekly' } }]),
			textResponse('{"type":"text","answer":"I could not retrieve CO2 data right now."}'),
		]);

		const result = await askClaude(user('CO2 level?'), create);
		expect(result).toEqual({ type: 'text', answer: 'I could not retrieve CO2 data right now.' });

		const round2 = calls[1];
		const blocks = round2.messages[round2.messages.length - 1].content as {
			type: string;
			is_error?: boolean;
			content?: string;
		}[];
		expect(blocks[0].type).toBe('tool_result');
		expect(blocks[0].is_error).toBe(true);
		expect(blocks[0].content).toMatch(/granularity/);
	});

	it('falls back to the text envelope after the round cap instead of looping forever', async () => {
		const endless = Array.from({ length: 9 }, (_, i) =>
			toolUseResponse([{ id: `toolu_${i}`, name: 'get_co2_levels', input: { granularity: 'weekly' } }]),
		);
		const { create } = scriptedCreator(endless);
		const result = await askClaude(user('CO2?'), create);
		expect(result.type).toBe('text');
		expect(create).toHaveBeenCalledTimes(7);
	});

	it('passes text and refusal envelopes straight through', async () => {
		const { create } = scriptedCreator([
			textResponse('{"type":"refusal","answer":"ClimateChat only answers climate questions. Try: what is the current CO2 level?"}'),
		]);
		const result = await askClaude(user('Write me a haiku about pizza'), create);
		expect(result.type).toBe('refusal');
	});

	it("dispatches a round's tool calls concurrently and returns all results in one message", async () => {
		let started = 0;
		let openGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			started++;
			await gate; // hold every fetch open until the test releases it
			return new Response('year,mean,unc\n1979,336.85,0.10\n1980,338.91,0.07', { status: 200 });
		});

		const { create, calls } = scriptedCreator([
			toolUseResponse([
				{ id: 'a', name: 'get_co2_levels', input: { granularity: 'annual' } },
				{ id: 'b', name: 'get_methane_levels', input: { granularity: 'annual' } },
			]),
			textResponse('{"type":"text","answer":"done"}'),
		]);

		const done = askClaude(user('compare CO2 and methane trends'), create);
		await new Promise((resolve) => setTimeout(resolve, 0)); // let both mapped fns reach their await
		expect(started).toBe(2); // sequential execution would show 1 here
		openGate();
		await done;
		fetchSpy.mockRestore();

		const toolResultMsg = calls[1].messages[calls[1].messages.length - 1];
		const blocks = toolResultMsg.content as { type: string; tool_use_id: string }[];
		expect(blocks.map((block) => block.tool_use_id)).toEqual(['a', 'b']);
	});
});

describe('askClaude - error classification (step 16)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Run one tool_use round that fails, then a text round, and return the logged error object. */
	async function loggedErrorFor(block: { id: string; name: string; input: unknown }): Promise<Record<string, unknown>> {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { create } = scriptedCreator([
			toolUseResponse([block]),
			textResponse('{"type":"text","answer":"The data could not be retrieved."}'),
		]);
		await askClaude(user('climate question'), create);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		return JSON.parse(errorSpy.mock.calls[0][0] as string) as Record<string, unknown>;
	}

	it('files a hallucinated tool name as unknown_tool, not tool_parse_failed', async () => {
		const logged = await loggedErrorFor({ id: 't1', name: 'get_rainfall_totals', input: {} });
		expect(logged.class).toBe('unknown_tool');
		expect(logged.tool).toBe('get_rainfall_totals');
	});

	it('files bad tool input as tool_input_invalid', async () => {
		const logged = await loggedErrorFor({ id: 't2', name: 'get_co2_levels', input: { granularity: 'hourly' } });
		expect(logged.class).toBe('tool_input_invalid');
	});

	it('files an upstream non-OK status as tool_fetch_failed with the status', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }));
		const logged = await loggedErrorFor({ id: 't3', name: 'get_co2_levels', input: { granularity: 'annual' } });
		expect(logged.class).toBe('tool_fetch_failed');
		expect(logged.upstreamStatus).toBe(503);
	});

	it('files an unparseable upstream body as tool_parse_failed', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>not a csv</html>', { status: 200 }));
		const logged = await loggedErrorFor({ id: 't4', name: 'get_co2_levels', input: { granularity: 'annual' } });
		expect(logged.class).toBe('tool_parse_failed');
		expect(logged.upstreamStatus).toBeUndefined();
	});

	it('files an invalid-JSON body from a JSON upstream as tool_parse_failed, not unhandled', async () => {
		// HTTP 200 + a non-JSON body: response.json() throws a native
		// SyntaxError. readJsonBody must wrap it as a ToolError so it lands
		// in the drift class, not 'unhandled'.
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>maintenance</html>', { status: 200 }));
		const logged = await loggedErrorFor({
			id: 't5',
			name: 'get_surface_temperature',
			input: { start_year: 2000, end_year: 2010, scale: 'annual' },
		});
		expect(logged.class).toBe('tool_parse_failed');
	});
});

describe('parseEnvelope - malformed output (R2)', () => {
	const noResults = new Map<string, ToolDataResult>();

	it('returns prose as a text answer when Claude ignored the JSON rule', () => {
		const result = parseEnvelope('CO2 is rising according to NOAA GML.', noResults);
		expect(result).toEqual({ type: 'text', answer: 'CO2 is rising according to NOAA GML.' });
	});

	it('returns the generic fallback for truncated JSON', () => {
		const result = parseEnvelope('{"type":"chart","chartType":"li', noResults);
		expect(result.type).toBe('text');
		expect((result as { answer: string }).answer).toMatch(/something went wrong/);
	});

	it('strips a markdown fence before parsing', () => {
		const result = parseEnvelope('```json\n{"type":"text","answer":"424 ppm (NOAA GML)"}\n```', noResults);
		expect(result).toEqual({ type: 'text', answer: '424 ppm (NOAA GML)' });
	});

	it('falls back on a JSON object that matches no format', () => {
		const result = parseEnvelope('{"kind":"text","body":"hi"}', noResults);
		expect(result.type).toBe('text');
		expect((result as { answer: string }).answer).toMatch(/something went wrong/);
	});

	it('degrades a chart with an unmatched sourceToolCallId to the explanation text (step 17 mismatch case)', () => {
		const results = new Map([['toolu_real', sampleResult]]);
		const chart = JSON.stringify({
			type: 'chart',
			chartType: 'line',
			title: 'T',
			xLabel: 'x',
			yLabel: 'y',
			datasets: [{ label: 'CO2', sourceToolCallId: 'toolu_hallucinated' }],
			explanation: 'CO2 has risen since 1979 (NOAA GML).',
		});
		const result = parseEnvelope(chart, results);
		expect(result).toEqual({ type: 'text', answer: 'CO2 has risen since 1979 (NOAA GML).' });
	});

	it('injects data for a valid chart with multiple datasets', () => {
		const other: ToolDataResult = { ...sampleResult, source: 'NOAA NCEI', points: [{ x: 1979, y: 0.1 }] };
		const results = new Map([
			['toolu_a', sampleResult],
			['toolu_b', other],
		]);
		const chart = JSON.stringify({
			type: 'chart',
			chartType: 'line',
			title: 'T',
			xLabel: 'x',
			yLabel: 'y',
			datasets: [
				{ label: 'CO2', sourceToolCallId: 'toolu_a' },
				{ label: 'Anomaly', sourceToolCallId: 'toolu_b' },
			],
			explanation: 'Both series rose.',
		});
		const result = parseEnvelope(chart, results);
		expect(result.type).toBe('chart');
		const datasets = (result as { datasets: { data: unknown[] }[] }).datasets;
		expect(datasets[0].data).toHaveLength(2);
		expect(datasets[1].data).toHaveLength(1);
	});
});
