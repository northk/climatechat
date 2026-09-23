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
import { ToolError } from './tools/errors';
import { logError, type ErrorClass } from './log';
import { isWorkerResponse } from './validate';
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
/**
 * Wall-clock budget for the whole agent loop — every Claude call plus
 * every tool round (Codex review). The SDK's own default is a 10-minute
 * timeout per attempt, which would let a stalled API recreate the
 * silent hang this app exists to avoid. 45s sits under iOS URLSession's
 * 60s default request timeout, so the app gets the Worker's answer
 * rather than its own timeout; typical requests take 3-8s. Tool fetches
 * have their own 5s cap (tools/errors.ts FETCH_TIMEOUT_MS).
 */
export const LOOP_BUDGET_MS = 45_000;

/**
 * R2 fallback answer when Claude's output can't be turned into an
 * envelope. Exported so `cache.ts` can refuse to cache a degraded
 * response by identity (8.2) — a transient failure must not be served
 * from KV for up to the TTL.
 */
export const FALLBACK_ANSWER = 'Sorry — something went wrong while putting that answer together. Please try asking again.';

export type MessageCreator = (params: MessageCreateParamsNonStreaming, options: { signal: AbortSignal }) => Promise<Message>;

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
 * (iOS sends plain text turns). `deadline` is injectable so tests can
 * abort it; production uses LOOP_BUDGET_MS. `kv` is handed to the tools
 * for the Open-Meteo city series cache (R12).
 */
export async function askClaude(
	messages: MessageParam[],
	createMessage: MessageCreator,
	{ deadline = AbortSignal.timeout(LOOP_BUDGET_MS), kv }: { deadline?: AbortSignal; kv?: KVNamespace } = {},
): Promise<WorkerResponse> {
	const conversation: MessageParam[] = [...messages];
	const toolResults = new Map<string, ToolDataResult>();

	for (let round = 1; round <= MAX_ROUNDS; round++) {
		let response: Message;
		try {
			response = await createMessage(
				{
					model: MODEL,
					max_tokens: MAX_TOKENS,
					system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
					tools: allToolDefinitions,
					messages: withCacheBreakpoint(conversation),
				},
				{ signal: deadline },
			);
		} catch (error) {
			// Out of budget (mid-call, or already spent by earlier rounds —
			// an aborted signal rejects immediately): same outcome as running
			// out of rounds below, a never-cached fallback. Any other API
			// error still propagates to index.ts's 500 path.
			if (deadline.aborted) {
				logError('claude_timeout', { message: `agent loop exceeded its ${LOOP_BUDGET_MS}ms budget in round ${round}` });
				return { type: 'text', answer: FALLBACK_ANSWER };
			}
			throw error;
		}

		// Per-round usage log: cache verification (Section 8.5) reads these
		console.log(JSON.stringify({ round, usage: response.usage }));

		if (response.stop_reason === 'tool_use') {
			conversation.push({ role: 'assistant', content: response.content });
			const toolUses = response.content.filter((block): block is Extract<typeof block, { type: 'tool_use' }> => block.type === 'tool_use');
			// Run a round's tool calls concurrently — they're independent, and
			// all results go back in ONE tool_result message keyed by
			// tool_use_id regardless of order, so serial execution would just
			// sum the upstream latencies (R4). Each call has its own try/catch,
			// so Promise.all never rejects; results stay in call order.
			const results: ToolResultBlockParam[] = await Promise.all(
				toolUses.map(async (block): Promise<ToolResultBlockParam> => {
					try {
						const data = await runTool(block.name, block.input, kv);
						toolResults.set(block.id, data);
						return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(data) };
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						// The class is carried on the ToolError from the throw site
						// (tools/errors.ts); anything else escaping a handler is a bug.
						const errorClass: ErrorClass = error instanceof ToolError ? error.toolErrorClass : 'unhandled';
						const upstreamStatus = error instanceof ToolError ? error.upstreamStatus : undefined;
						logError(errorClass, { tool: block.name, upstreamStatus, message });
						// is_error tool_result: Claude sees the failure and answers
						// per Section 7 ("say so plainly") instead of crashing the request
						return { type: 'tool_result', tool_use_id: block.id, content: message, is_error: true };
					}
				}),
			);
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
 * Parse Claude's final text into the public envelope (Section 4), then
 * validate the result — after chart data injection — with the same
 * strict validator the answer cache applies to KV reads (`validate.ts`).
 * Malformed or invalid output degrades to the R2 fallback text envelope,
 * never a crash. Exported for direct testing.
 */
export function parseEnvelope(text: string, toolResults: Map<string, ToolDataResult>): WorkerResponse {
	const envelope = buildEnvelope(text, toolResults);
	if (isWorkerResponse(envelope)) return envelope;
	// e.g. an empty answer, or a chart with an empty title — well-formed
	// JSON that would still render as a broken bubble or card in iOS
	logError('claude_malformed_json', { message: `envelope failed validation (type ${(envelope as { type: string }).type})` });
	return { type: 'text', answer: FALLBACK_ANSWER };
}

/** Parse + chart data injection, before validation. */
function buildEnvelope(text: string, toolResults: Map<string, ToolDataResult>): WorkerResponse {
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
		// ANY unparseable output degrades to the fallback — prose included
		// (Codex review). Output that broke rule 5 can't be trusted to have
		// honored the other Section 7 rules either: it may be an off-topic
		// answer that skipped the refusal envelope, or prose wrapped around
		// JSON. Serving it as a text answer would also make it cacheable for
		// up to 24h; the fallback never is (8.2).
		return { type: 'text', answer: FALLBACK_ANSWER };
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
					// A mismatched ID means Claude's linkage to real tool data broke in
					// this response, so its prose explanation can't be trusted either
					// (Section 7 rule 1) — degrade to the generic fallback, not the
					// explanation text, so nothing ungrounded gets served or cached.
					return { type: 'text', answer: FALLBACK_ANSWER };
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
