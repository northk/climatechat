/**
 * KV answer cache (plan step 20): keyed by a normalized question hash,
 * SINGLE-TURN questions only — a question-text hash can't distinguish
 * two follow-ups with identical wording in different conversations
 * (R9), so any multi-turn request bypasses both read and write.
 * Refusals are never written: cheap to regenerate, and each unique
 * off-topic question would burn one of the 1,000 daily KV writes (R4).
 * A degraded answer (FALLBACK_ANSWER) is never written either — it's a
 * transient failure, not an answer (8.2).
 */

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { FALLBACK_ANSWER } from './claude';
import type { WorkerResponse } from './types';

/** Current-state and city questions: data updates daily at most (8.2). */
const CURRENT_TTL_SECONDS = 60 * 60;
/** Long-term trend questions: the answer is the same every day (8.2). */
const TREND_TTL_SECONDS = 24 * 60 * 60;

/**
 * The single-turn gate (R9): returns the question text when the request
 * is exactly one user turn with plain string content, else null.
 */
export function cacheableQuestion(messages: MessageParam[]): string | null {
	if (messages.length !== 1) return null;
	const only = messages[0];
	if (only.role !== 'user' || typeof only.content !== 'string') return null;
	const text = only.content.trim();
	return text.length > 0 ? text : null;
}

/**
 * TTL selection (8.2): long-term-trend phrasings get 24h — the answer
 * doesn't change day to day; everything else (current-state and
 * city-specific questions) gets 1h. Keyword heuristic, deliberately
 * simple: misclassification costs at most a stale-by-hours answer,
 * bounded by the 24h ceiling.
 */
export function selectTtl(question: string): number {
	const trendPattern =
		/\b(since|history|historical|over time|trend|changed|change over|past \d+|last \d+ (years|decades)|century|decades)\b/i;
	return trendPattern.test(question) ? TREND_TTL_SECONDS : CURRENT_TTL_SECONDS;
}

/** Normalize so trivial phrasing variants share a cache entry. */
function normalize(question: string): string {
	return question.toLowerCase().replace(/\s+/g, ' ').trim();
}

async function cacheKey(question: string): Promise<string> {
	const bytes = new TextEncoder().encode(normalize(question));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `q:${hex}`;
}

/** Read a cached envelope; null on miss or any multi-turn request. */
export async function cacheGet(kv: KVNamespace, messages: MessageParam[]): Promise<WorkerResponse | null> {
	const question = cacheableQuestion(messages);
	if (!question) return null;
	const stored = await kv.get(await cacheKey(question));
	if (!stored) return null;
	try {
		return JSON.parse(stored) as WorkerResponse;
	} catch {
		// A corrupt entry behaves like a miss; it will be overwritten
		return null;
	}
}

/**
 * Write an envelope to the cache. No-op for multi-turn requests (R9),
 * for refusals, and for the degraded FALLBACK_ANSWER (8.2) — the last
 * one so a transient failure isn't replayed to every caller for up to
 * the 24h trend TTL.
 */
export async function cacheSet(kv: KVNamespace, messages: MessageParam[], response: WorkerResponse): Promise<void> {
	const question = cacheableQuestion(messages);
	if (!question || response.type === 'refusal') return;
	if (response.type === 'text' && response.answer === FALLBACK_ANSWER) return;
	await kv.put(await cacheKey(question), JSON.stringify(response), {
		expirationTtl: selectTtl(question),
	});
}
