/**
 * SPIKE (not production code) — app-attest-design.md §8 question 3.
 *
 * Fires N concurrent RPC calls at ONE Durable Object, all presenting the same
 * next counter value. Exactly one must be accepted, or the App Attest replay
 * counter is worthless.
 *
 * Methodology note: these go through the stub (real event delivery, so input
 * gates apply). `runInDurableObject()` invokes the instance directly and
 * BYPASSES input gates — using it here reports a false race.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

function stub(name: string) {
	return env.SPIKE_COUNTER.get(env.SPIKE_COUNTER.idFromName(name));
}
const CONCURRENCY = 12;

describe('SPIKE - Durable Object counter atomicity, via stub RPC', () => {
	it('naive read -> await(crypto) -> write', async () => {
		const s = stub('naive');
		await s.reset();
		const r = await Promise.all(Array.from({ length: CONCURRENCY }, () => s.checkNaive(1, 5)));
		const accepted = r.filter(Boolean).length;
		console.log(`[DO naive] ${CONCURRENCY} concurrent claims of counter=1 -> accepted=${accepted}`);
		expect(accepted).toBeGreaterThanOrEqual(1);
	});

	// Measures as safe, but is NOT the sanctioned pattern — the test above is
	// this exact code plus one await, and it lets all 12 through. That delta is
	// why the rule is blockConcurrencyWhile, not "keep it tight".
	it('tight read -> write, no await between (safe by accident, do not rely on)', async () => {
		const s = stub('tight');
		await s.reset();
		const r = await Promise.all(Array.from({ length: CONCURRENCY }, () => s.checkTight(1)));
		const accepted = r.filter(Boolean).length;
		console.log(`[DO tight] ${CONCURRENCY} concurrent claims of counter=1 -> accepted=${accepted}`);
		expect(accepted).toBe(1);
	});

	it('THE RULE: blockConcurrencyWhile around read -> await(crypto) -> write', async () => {
		const s = stub('gated');
		await s.reset();
		const r = await Promise.all(Array.from({ length: CONCURRENCY }, () => s.checkGated(1, 5)));
		const accepted = r.filter(Boolean).length;
		console.log(`[DO gated] ${CONCURRENCY} concurrent claims of counter=1 -> accepted=${accepted}`);
		expect(accepted).toBe(1);
	});

	it('gated pattern never lets the counter go backwards', async () => {
		const s = stub('ladder');
		await s.reset();
		const values = [3, 1, 4, 1, 5, 9, 2, 6];
		await Promise.all(values.map((v) => s.checkGated(v, 2)));
		const final = await s.stored();
		console.log(`[DO gated] ladder ${values.join(',')} -> final stored=${final}`);
		expect(final).toBe(9);
		expect(await s.checkGated(9, 0)).toBe(false);
		expect(await s.checkGated(10, 0)).toBe(true);
	});
});

describe('SPIKE - the same race against KV, for contrast', () => {
	it('shows a KV read-modify-write admits many winners', async () => {
		const key = 'spike:kv-counter';
		await env.CLIMATE_KV.put(key, '0');
		const attempt = async (presented: number): Promise<boolean> => {
			const stored = Number((await env.CLIMATE_KV.get(key)) ?? '0');
			await scheduler.wait(5);
			if (presented <= stored) return false;
			await env.CLIMATE_KV.put(key, String(presented));
			return true;
		};
		const r = await Promise.all(Array.from({ length: CONCURRENCY }, () => attempt(1)));
		console.log(`[KV] ${CONCURRENCY} concurrent claims of counter=1 -> accepted=${r.filter(Boolean).length}`);
		expect(r.filter(Boolean).length).toBeGreaterThan(1);
	});
});
