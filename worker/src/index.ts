/**
 * ClimateChat Worker entry point (plan steps 22, 24).
 *
 * POST /ask pipeline, in this exact order:
 *   verifyClient → parse/validate body → cache read (single-turn only)
 *   → rate limit → Claude loop → cache write → JSON envelope.
 * Cache is checked BEFORE the rate limiter so a cached answer never
 * costs one of the user's 5 daily questions (Section 8.2/8.3).
 *
 * Deliberately NO CORS headers, ever (plan step 6 / R10): the iOS app
 * is a native URLSession client, so CORS never applies to it — omitting
 * the headers makes naive browser-JS abuse fail at the preflight stage.
 * Do not "fix" this by adding Access-Control-Allow-Origin.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { askClaude, logError } from './claude';
import { cacheGet, cacheSet } from './cache';
import { checkAndIncrement } from './rateLimit';
import type { WorkerResponse } from './types';

/**
 * Shared-secret client check (step 22, R10). Its own function — not
 * inlined — so swapping in Apple App Attest later is a one-function
 * change. Friction against casual scraping, not real access control.
 */
export function verifyClient(request: Request, env: Env): boolean {
	const provided = request.headers.get('X-App-Secret');
	return typeof env.APP_SECRET === 'string' && env.APP_SECRET.length > 0 && provided === env.APP_SECRET;
}

/** Validate the request body into a Claude-ready message history. */
export function parseMessages(body: unknown): MessageParam[] | null {
	const messages = (body as { messages?: unknown } | null)?.messages;
	if (!Array.isArray(messages) || messages.length === 0) return null;
	for (const message of messages) {
		const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown };
		if (role !== 'user' && role !== 'assistant') return null;
		if (typeof content !== 'string' || content.trim().length === 0) return null;
	}
	const last = messages[messages.length - 1] as { role: string };
	if (last.role !== 'user') return null;
	return messages as MessageParam[];
}

type AskFn = (messages: MessageParam[]) => Promise<WorkerResponse>;

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

	// 2. Body validation
	let body: unknown;
	try {
		body = await request.json();
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
		return Response.json({ error: "You've reached your daily limit of 5 questions. Your quota resets at midnight UTC." }, { status: 429 });
	}

	// 5. Claude loop → 6. cache write (single-turn only; never refusals)
	const response = await ask(messages);
	await cacheSet(env.CLIMATE_KV, messages, response);
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
				return askClaude(messages, (params) => client.messages.create(params));
			});
		} catch (error) {
			// Top-level catch (step 24): the R2/5xx path the iOS app maps to
			// its Worker-error state
			logError('unhandled', { message: error instanceof Error ? error.message : String(error) });
			return Response.json({ error: 'Service error — please try again.' }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
