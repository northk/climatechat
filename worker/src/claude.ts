/**
 * Claude agentic loop (plan step 16): send → execute tool calls →
 * repeat (≤7 rounds) → parse the JSON envelope → for charts, inject
 * real data points by sourceToolCallId (Section 4).
 *
 * Never sets temperature/top_p/top_k — claude-sonnet-5 returns 400 on
 * non-default values (CLAUDE.md); determinism is steered by the system
 * prompt. Two cache_control breakpoints per request (Section 8.5): the
 * system block (covers tools + system) and the last message.
 *
 * The Anthropic call is injected (MessageCreator) so tests can script
 * responses without network; index.ts binds the real SDK client.
 */

import type {
	Message,
	MessageCreateParamsNonStreaming,
	MessageParam,
	TextBlockParam,
	ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type { ChartDataset, ClaudeChartDataset, ToolDataResult, WorkerResponse } from './types';
import { SYSTEM_PROMPT } from './prompts';
import { allToolDefinitions, runTool } from './tools/registry';

export const MODEL = 'claude-sonnet-5';
/** Sized for Sonnet 5's tokenizer — see CLAUDE.md; do not reuse old-model intuitions. */
export const MAX_TOKENS = 1536;
/**
 * Tool-use round cap (Section 2 architecture diagram). Raised 5→7 on
 * 2026-09-03: Sonnet 5 intermittently emits a stray tool_use (e.g. a
 * hallucinated chart tool — see prompts.ts rule 9) that the loop absorbs
 * as an is_error result but which still costs a round. See plan step 16.
 */
const MAX_ROUNDS = 7;

/** R2 fallback answer when Claude's output can't be turned into an envelope. */
const FALLBACK_ANSWER = 'Sorry — something went wrong while putting that answer together. Please try asking again.';

export type MessageCreator = (params: MessageCreateParamsNonStreaming) => Promise<Message>;

type ErrorClass =
	'tool_fetch_failed' | 'tool_parse_failed' | 'tool_input_invalid' | 'claude_malformed_json' | 'chart_injection_mismatch' | 'unhandled';

/**
 * Structured error logging (plan step 16): lands in Workers Logs via
 * the observability binding. Never include question text or IPs.
 */
export function logError(errorClass: ErrorClass, fields: { tool?: string; upstreamStatus?: number; message: string }): void {
	console.error(JSON.stringify({ class: errorClass, ...fields }));
}

function classifyToolError(message: string): ErrorClass {
	if (/fetch failed: \d+/.test(message)) return 'tool_fetch_failed';
	if (/must be|limited to|non-empty/.test(message)) return 'tool_input_invalid';
	return 'tool_parse_failed';
}

/** Put a cache_control breakpoint on the last content block of the last message. */
function withCacheBreakpoint(messages: MessageParam[]): MessageParam[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	const blocks: (TextBlockParam | ToolResultBlockParam)[] =
		typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : (last.content as (TextBlockParam | ToolResultBlockParam)[]);
	if (blocks.length === 0) return messages;
	const marked = blocks.map((block, i) => (i === blocks.length - 1 ? { ...block, cache_control: { type: 'ephemeral' as const } } : block));
	return [...messages.slice(0, -1), { ...last, content: marked }];
}

/**
 * Run the full tool-use loop for a conversation and return the public
 * response envelope. `messages` is the incoming user/assistant history
 * (iOS sends plain text turns).
 */
export async function askClaude(messages: MessageParam[], createMessage: MessageCreator): Promise<WorkerResponse> {
	const conversation: MessageParam[] = [...messages];
	const toolResults = new Map<string, ToolDataResult>();

	for (let round = 1; round <= MAX_ROUNDS; round++) {
		const response = await createMessage({
			model: MODEL,
			max_tokens: MAX_TOKENS,
			system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
			tools: allToolDefinitions,
			messages: withCacheBreakpoint(conversation),
		});

		// Per-round usage log: cache verification (Section 8.5) reads these
		console.log(JSON.stringify({ round, usage: response.usage }));

		if (response.stop_reason === 'tool_use') {
			conversation.push({ role: 'assistant', content: response.content });
			const results: ToolResultBlockParam[] = [];
			for (const block of response.content) {
				if (block.type !== 'tool_use') continue;
				try {
					const data = await runTool(block.name, block.input);
					toolResults.set(block.id, data);
					results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(data) });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logError(classifyToolError(message), { tool: block.name, message });
					// is_error tool_result: Claude sees the failure and answers
					// per Section 7 ("say so plainly") instead of crashing the request
					results.push({ type: 'tool_result', tool_use_id: block.id, content: message, is_error: true });
				}
			}
			// All results for a round go in ONE user message, or Claude stops
			// making parallel calls
			conversation.push({ role: 'user', content: results });
			continue;
		}

		const text = response.content
			.filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
			.map((block) => block.text)
			.join('');
		return parseEnvelope(text, toolResults);
	}

	logError('unhandled', { message: `tool-use loop exceeded ${MAX_ROUNDS} rounds without a final answer` });
	return { type: 'text', answer: FALLBACK_ANSWER };
}

function isChartDatasetList(value: unknown): value is ClaudeChartDataset[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(entry: unknown) =>
				typeof (entry as ClaudeChartDataset).label === 'string' && typeof (entry as ClaudeChartDataset).sourceToolCallId === 'string',
		)
	);
}

/**
 * Parse Claude's final text into the public envelope (Section 4).
 * Malformed output degrades to the R2 fallback text envelope — never a
 * crash. Exported for direct testing.
 */
export function parseEnvelope(text: string, toolResults: Map<string, ToolDataResult>): WorkerResponse {
	// Defensive: strip a markdown fence if Claude wraps the JSON despite rule 5
	const trimmed = text
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '');

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		logError('claude_malformed_json', { message: `unparseable final response (${trimmed.length} chars)` });
		// If Claude answered in prose despite rule 5, the prose is still an
		// answer; a truncated JSON fragment is not
		const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
		return { type: 'text', answer: looksLikeJson || trimmed.length === 0 ? FALLBACK_ANSWER : trimmed };
	}

	const envelope = parsed as { type?: unknown; answer?: unknown };
	if ((envelope.type === 'text' || envelope.type === 'refusal') && typeof envelope.answer === 'string') {
		return { type: envelope.type, answer: envelope.answer };
	}

	if (envelope.type === 'chart') {
		const chart = parsed as {
			chartType?: unknown;
			title?: unknown;
			xLabel?: unknown;
			yLabel?: unknown;
			datasets?: unknown;
			explanation?: unknown;
		};
		const valid =
			(chart.chartType === 'line' || chart.chartType === 'bar') &&
			typeof chart.title === 'string' &&
			typeof chart.xLabel === 'string' &&
			typeof chart.yLabel === 'string' &&
			typeof chart.explanation === 'string' &&
			isChartDatasetList(chart.datasets);
		if (valid) {
			const datasets: ChartDataset[] = [];
			for (const dataset of chart.datasets as ClaudeChartDataset[]) {
				const result = toolResults.get(dataset.sourceToolCallId);
				if (!result) {
					logError('chart_injection_mismatch', {
						message: `sourceToolCallId ${dataset.sourceToolCallId} has no matching tool_result`,
					});
					// R2 fallback: the explanation is still a sourced answer
					return { type: 'text', answer: (chart.explanation as string) || FALLBACK_ANSWER };
				}
				datasets.push({ label: dataset.label, data: result.points });
			}
			return {
				type: 'chart',
				chartType: chart.chartType as 'line' | 'bar',
				title: chart.title as string,
				xLabel: chart.xLabel as string,
				yLabel: chart.yLabel as string,
				datasets,
				explanation: chart.explanation as string,
			};
		}
	}

	logError('claude_malformed_json', { message: 'parsed JSON does not match any response format' });
	return { type: 'text', answer: FALLBACK_ANSWER };
}
