/**
 * Per-IP daily rate limit (plan step 18): KV counter keyed by the
 * current UTC date — `rl:{ip}:{YYYY-MM-DD}` — so "reset" just means a
 * new day means a new key. Trivially testable by injecting a date;
 * no elapsed-time simulation needed. The 429 response itself is the
 * /ask handler's job (step 24); this module only decides.
 *
 * SUPERSEDED-IN-PLAN (2026-09-23, plan 8.3): once App Attest ships, the
 * `/ask` quota is keyed by App Attest `keyId` and lives in the per-device
 * Durable Object, not here — which also removes a KV write per request
 * (R4) and makes the check atomic, closing the race noted below. This
 * module stays live for the transition window while `X-App-Secret` is
 * still the auth mechanism, then retires with it. Enrollment throttling
 * stays per-IP permanently (pre-auth; see app-attest-design.md §5a).
 * Do not invest in extending this file — extend the DO counter instead.
 */

/** Free-tier questions per IP per day (Section 8.3). */
export const DAILY_LIMIT = 5;

/**
 * Old keys are garbage-collected by TTL; the *reset* semantics come
 * from the date in the key, never from this TTL.
 */
const KEY_GC_SECONDS = 2 * 24 * 60 * 60;

export interface RateLimitDecision {
	allowed: boolean;
	/** Requests counted today including this one (when allowed). */
	count: number;
}

/**
 * Check the caller's daily quota and consume one request if allowed.
 * Read-then-write isn't atomic — two simultaneous requests can both
 * pass at the boundary. Acceptable at this scale (R4: ~500-1,000
 * req/day total); the hard spend cap (8.1) backstops abuse.
 */
export async function checkAndIncrement(kv: KVNamespace, ip: string, now: Date = new Date()): Promise<RateLimitDecision> {
	const day = now.toISOString().slice(0, 10);
	const key = `rl:${ip}:${day}`;

	const current = Number((await kv.get(key)) ?? '0');
	if (current >= DAILY_LIMIT) {
		return { allowed: false, count: current };
	}
	await kv.put(key, String(current + 1), { expirationTtl: KEY_GC_SECONDS });
	return { allowed: true, count: current + 1 };
}
