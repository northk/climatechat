/**
 * Rate limiter tests (plan step 19): real KV simulation via
 * vitest-pool-workers; day rollover asserted with injected dates, not
 * simulated elapsed time.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkAndIncrement, DAILY_LIMIT, readCounter } from '../src/rateLimit';

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

describe('readCounter - malformed stored values (Codex review)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('reads a valid count, and a missing key as 0 without logging', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(readCounter('3')).toBe(3);
		expect(readCounter('0')).toBe(0);
		expect(readCounter(null)).toBe(0);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it.each(['bad', 'NaN', '', '-3', '2.5', 'Infinity'])('treats %j as 0 and logs kv_counter_invalid', (stored) => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(readCounter(stored)).toBe(0);
		expect(JSON.parse(errorSpy.mock.calls[0][0] as string)).toEqual({
			class: 'kv_counter_invalid',
			message: 'rate-limit counter held a non-integer value; reset to 0',
		});
	});
});

describe('checkAndIncrement - a malformed counter no longer fails open forever', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('resets a "NaN" counter, heals the key, and enforces the limit again', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const ip = '203.0.113.9';
		const key = `rl:${ip}:2026-08-10`;
		await env.CLIMATE_KV.put(key, 'NaN');

		expect(await checkAndIncrement(env.CLIMATE_KV, ip, DAY_1)).toEqual({ allowed: true, count: 1 });
		expect(await env.CLIMATE_KV.get(key)).toBe('1');
		for (let i = 2; i <= DAILY_LIMIT; i++) {
			await checkAndIncrement(env.CLIMATE_KV, ip, DAY_1);
		}
		// Before the fix, "NaN" was written back each time and this was allowed
		expect((await checkAndIncrement(env.CLIMATE_KV, ip, DAY_1)).allowed).toBe(false);
	});
});
