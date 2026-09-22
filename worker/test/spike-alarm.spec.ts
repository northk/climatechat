/**
 * SPIKE Q5 — does alarm-based reaping actually work under workerd?
 *
 * Design §5a replaced a second (KV) storage mechanism with a DO alarm that
 * reaps abandoned enrollments. That made alarms load-bearing, and nothing had
 * verified they behave as assumed. Three claims under test:
 *
 *   1. alarm() fires and can deleteAll() an abandoned enrollment
 *   2. a VERIFIED record survives the alarm (the state-branching requirement —
 *      one alarm per DO means an unconditional reaper wipes live devices)
 *   3. setAlarm() REPLACES a pending alarm rather than queuing a second one
 */

import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

function stub(name: string) {
	return env.SPIKE_COUNTER.get(env.SPIKE_COUNTER.idFromName(name));
}

describe('SPIKE Q5 - alarm-based reaping', () => {
	it('reaps an abandoned enrollment when the alarm fires', async () => {
		const s = stub('alarm-abandoned');
		await s.reset();
		await s.issueChallenge('chal-abc', 5 * 60 * 1000);

		const before = await s.snapshot();
		console.log('[alarm] before: keys=' + JSON.stringify(before.keys) + ' alarmArmed=' + (before.alarmAt !== null));
		expect(before.keys).toContain('challenge');
		expect(before.alarmAt).not.toBeNull();

		const ran = await runDurableObjectAlarm(s);
		expect(ran).toBe(true);

		const after = await s.snapshot();
		console.log('[alarm] after reap: keys=' + JSON.stringify(after.keys) + ' alarmAt=' + after.alarmAt);
		expect(after.keys).toEqual([]);
	});

	it('leaves a VERIFIED record intact when the alarm fires', async () => {
		const s = stub('alarm-verified');
		await s.reset();
		await s.issueChallenge('chal-def', 5 * 60 * 1000);
		expect(await s.completeRegistration()).toBe(true);

		const ran = await runDurableObjectAlarm(s);
		expect(ran).toBe(true);

		const after = await s.snapshot();
		console.log('[alarm] verified survived: keys=' + JSON.stringify(after.keys) + ' verified=' + after.verified);
		// This is the test that stops a naive reaper from wiping live devices.
		expect(after.verified).toBe(true);
		expect(after.keys).toContain('counter');
	});

	it('consuming the challenge makes a second registration fail', async () => {
		const s = stub('alarm-replay');
		await s.reset();
		await s.issueChallenge('chal-ghi', 5 * 60 * 1000);
		expect(await s.completeRegistration()).toBe(true);
		expect(await s.completeRegistration()).toBe(false);
	});

	it('concurrent registrations against one challenge yield exactly one success', async () => {
		const s = stub('alarm-race');
		await s.reset();
		await s.issueChallenge('chal-jkl', 5 * 60 * 1000);
		const results = await Promise.all(Array.from({ length: 12 }, () => s.completeRegistration()));
		const wins = results.filter(Boolean).length;
		console.log(`[alarm] 12 concurrent registrations on one challenge -> ${wins} success`);
		expect(wins).toBe(1);
	});

	it('setAlarm REPLACES a pending alarm - only one alarm per DO', async () => {
		const s = stub('alarm-single');
		await s.reset();
		await s.issueChallenge('chal-1', 60 * 60 * 1000); // arm far out
		const first = (await s.snapshot()).alarmAt;
		await s.issueChallenge('chal-2', 5 * 60 * 1000); // re-arm nearer
		const second = (await s.snapshot()).alarmAt;

		console.log(`[alarm] first=${first} second=${second} replaced=${first !== second}`);
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(second).toBeLessThan(first!);

		// Firing once must exhaust it: there is no queued second alarm behind it.
		expect(await runDurableObjectAlarm(s)).toBe(true);
		expect(await runDurableObjectAlarm(s)).toBe(false);
	});
});
