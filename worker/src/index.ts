/**
 * ClimateChat Worker entry point (plan steps 22, 24).
 *
 * POST /ask pipeline, in this exact order:
 *   verifyClient → parse/validate body → cache read (single-turn only)
 *   → rate limit → Claude loop → cache write → JSON envelope.
 * Cache is checked BEFORE the rate limiter so a cached answer never
 * costs one of the user's daily questions (Section 8.2/8.3).
 *
 * Deliberately NO CORS headers, ever (plan step 6 / R10): the iOS app
 * is a native URLSession client, so CORS never applies to it — omitting
 * the headers makes naive browser-JS abuse fail at the preflight stage.
 * Do not "fix" this by adding Access-Control-Allow-Origin.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { askClaude, type AskResult } from './claude';
import { logError } from './log';
import { cacheGet, cacheSet } from './cache';
import { checkAndIncrement, DAILY_LIMIT } from './rateLimit';

/**
 * Input-size limits (plan steps 47/49, pulled forward from Phase 6 —
 * see Codex review finding on unbounded input). The client (once built
 * in Phase 4) is expected to enforce these too, but the Worker cannot
 * trust that: the shared secret is extractable from a compiled app
 * (R10), so a direct caller could otherwise submit arbitrarily large
 * messages or history and either blow up the Anthropic bill / context
 * window, or burn a rate-limit slot on a request that was always going
 * to fail.
 */
export const MAX_USER_MESSAGE_LENGTH = 500; // plan Section 8.4 — the actual typed question
export const MAX_MESSAGE_LENGTH = 8000; // generous ceiling for any message (bounds a forged/oversized assistant turn too)
export const MAX_MESSAGES = 21; // plan step 49: 10 history exchanges + the new question
export const MAX_BODY_LENGTH = 120_000; // headroom over MAX_MESSAGES worth of MAX_MESSAGE_LENGTH content plus JSON overhead

// SPIKE scaffolding — Durable Object classes must be exported from the entry
// module. Remove along with src/spikeCounter.ts when the spike is torn down.
export { SpikeCounter } from './spikeCounter';

/** Constant-time string compare — no first-mismatch timing oracle on the secret. */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}

/**
 * Shared-secret client check (step 22, R10). Its own function — not
 * inlined — so swapping in Apple App Attest later is a one-function
 * change. Friction against casual scraping, not real access control.
 */
export function verifyClient(request: Request, env: Env): boolean {
	const provided = request.headers.get('X-App-Secret');
	if (typeof env.APP_SECRET !== 'string' || env.APP_SECRET.length === 0 || provided === null) return false;
	return timingSafeEqual(provided, env.APP_SECRET);
}

/** Validate the request body into a Claude-ready message history. */
export function parseMessages(body: unknown): MessageParam[] | null {
	const messages = (body as { messages?: unknown } | null)?.messages;
	if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return null;
	for (const message of messages) {
		const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown };
		if (role !== 'user' && role !== 'assistant') return null;
		if (typeof content !== 'string' || content.trim().length === 0) return null;
		if (content.length > MAX_MESSAGE_LENGTH) return null;
		if (role === 'user' && content.length > MAX_USER_MESSAGE_LENGTH) return null;
	}
	// The API merges consecutive same-role turns, so alternation isn't
	// required — but the first turn must be `user` and so must the last
	// (a real answer can't come before a question). Reject anything else
	// here rather than spending a rate-limit slot and a Claude call on a
	// request the API will 400.
	if ((messages[0] as { role: string }).role !== 'user') return null;
	if ((messages[messages.length - 1] as { role: string }).role !== 'user') return null;
	return messages as MessageParam[];
}

type AskFn = (messages: MessageParam[]) => Promise<AskResult>;

/**
 * The /ask pipeline with the Claude call injected, so tests can stub it
 * and cover ordering (cache before rate limit, refusals uncached)
 * without network. The default export binds the real SDK.
 */
export async function handleAsk(request: Request, env: Env, ask: AskFn): Promise<Response> {
	// 1. Client verification — before touching KV at all
	if (!verifyClient(request, env)) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	// 2. Body validation. Read as text first so oversized bodies are
	// rejected against the actual bytes received, not a client-supplied
	// (and spoofable) Content-Length header, and before the CPU cost of
	// JSON.parse on a huge payload.
	const rawBody = await request.text();
	if (rawBody.length > MAX_BODY_LENGTH) {
		return Response.json({ error: `Request body too large (max ${MAX_BODY_LENGTH} characters)` }, { status: 413 });
	}
	let body: unknown;
	try {
		body = JSON.parse(rawBody);
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const messages = parseMessages(body);
	if (!messages) {
		return Response.json(
			{ error: 'Body must be {"messages": [{"role": "user" | "assistant", "content": "..."}]} ending with a user turn' },
			{ status: 400 },
		);
	}

	// 3. Cache read (single-turn only, R9) — a hit never touches the
	// rate limiter, so cached answers are free to the user
	const cached = await cacheGet(env.CLIMATE_KV, messages);
	if (cached) {
		return Response.json(cached);
	}

	// 4. Rate limit (5/day per IP, Section 8.3)
	const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
	const decision = await checkAndIncrement(env.CLIMATE_KV, ip);
	if (!decision.allowed) {
		return Response.json(
			{ error: `You've reached your daily limit of ${DAILY_LIMIT} questions. Your quota resets at midnight UTC.` },
			{ status: 429 },
		);
	}

	// 5. Claude loop → 6. cache write (single-turn only; never refusals,
	// never an answer from a request where a data source failed — it may
	// say "couldn't retrieve", which stops being true once the source is back)
	const { response, upstreamFailed } = await ask(messages);
	if (!upstreamFailed) {
		await cacheSet(env.CLIMATE_KV, messages, response);
	}
	return Response.json(response);
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== '/ask') {
			return Response.json({ error: 'Not found' }, { status: 404 });
		}
		if (request.method !== 'POST') {
			return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } });
		}

		try {
			return await handleAsk(request, env, (messages) => {
				const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
				return askClaude(messages, (params, options) => client.messages.create(params, options), { kv: env.CLIMATE_KV });
			});
		} catch (error) {
			// Top-level catch (step 24): the R2/5xx path the iOS app maps to
			// its Worker-error state
			logError('unhandled', { message: error instanceof Error ? error.message : String(error) });
			return Response.json({ error: 'Service error — please try again.' }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
