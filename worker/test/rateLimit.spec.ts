/**
 * Rate limiter tests (plan step 19): real KV simulation via
 * vitest-pool-workers; day rollover asserted with injected dates, not
 * simulated elapsed time.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { checkAndIncrement, DAILY_LIMIT } from '../src/rateLimit';

const DAY_1 = new Date('2026-08-10T08:00:00Z');
const DAY_1_LATER = new Date('2026-08-10T23:59:59Z');
const DAY_2 = new Date('2026-08-11T00:00:01Z');

describe('checkAndIncrement', () => {
	it('counts one request per call and allows up to the daily limit', async () => {
		const ip = '203.0.113.1';
		for (let i = 1; i <= DAILY_LIMIT; i++) {
			const decision = await checkAndIncrement(env.CLIMATE_KV, ip, DAY_1);
			expect(decision).toEqual({ allowed: true, count: i });
		}
	});

	it('denies the request after the limit, without incrementing further', async () => {
		const ip = '203.0.113.2';
		for (let i = 0; i < DAILY_LIMIT; i++) {
			await checkAndIncrement(env.CLIMATE_KV, ip, DAY_1);
		}
		const sixth = await checkAndIncrement(env.CLIMATE_KV, ip, DAY_1_LATER);
		expect(sixth).toEqual({ allowed: false, count: DAILY_LIMIT });
		const seventh = await checkAndIncrement(env.CLIMATE_KV, ip, DAY_1_LATER);
		expect(seventh).toEqual({ allowed: false, count: DAILY_LIMIT });
	});

	it('resets on a new UTC date because the key changes', async () => {
		const ip = '203.0.113.3';
		for (let i = 0; i < DAILY_LIMIT; i++) {
			await checkAndIncrement(env.CLIMATE_KV, ip, DAY_1);
		}
		expect((await checkAndIncrement(env.CLIMATE_KV, ip, DAY_1)).allowed).toBe(false);
		// Next day: fresh key, fresh quota — no time simulation required
		expect(await checkAndIncrement(env.CLIMATE_KV, ip, DAY_2)).toEqual({ allowed: true, count: 1 });
	});

	it('tracks IPs independently', async () => {
		for (let i = 0; i < DAILY_LIMIT; i++) {
			await checkAndIncrement(env.CLIMATE_KV, '203.0.113.4', DAY_1);
		}
		expect((await checkAndIncrement(env.CLIMATE_KV, '203.0.113.4', DAY_1)).allowed).toBe(false);
		expect((await checkAndIncrement(env.CLIMATE_KV, '203.0.113.5', DAY_1)).allowed).toBe(true);
	});
});
