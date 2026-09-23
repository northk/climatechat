/**
 * SPIKE (not production code) — app-attest-design.md §8 question 3.
 * Does a Durable Object serialize a read-modify-write on a replay counter?
 *
 * Three patterns, because the answer differs between them:
 *   naive  — read, await non-storage work (crypto), write   -> BROKEN, 12/12 accepted
 *   tight  — read, write, with no await in between          -> safe, but see below
 *   gated  — the naive sequence in blockConcurrencyWhile()  -> THE RULE
 *
 * RULE (app-attest-design.md §7 pitfall 6): real code uses `checkGated`.
 * `checkTight` is kept only to document that it measures as safe; it must not
 * be used, because its safety comes from there being no yield point between
 * the read and the write rather than from any guarantee. `checkNaive` is
 * literally `checkTight` plus one await — that is the whole margin.
 */

import { DurableObject } from 'cloudflare:workers';

export class SpikeCounter extends DurableObject {
	/** BROKEN. read -> await(non-storage) -> write. The input gate is NOT held across the wait. */
	async checkNaive(presented: number, delayMs: number): Promise<boolean> {
		const stored = (await this.ctx.storage.get<number>('counter')) ?? 0;
		if (delayMs > 0) await scheduler.wait(delayMs);
		if (presented <= stored) return false;
		await this.ctx.storage.put('counter', presented);
		return true;
	}

	/** DO NOT USE. Safe only by accident of having no yield point; one added await reopens the hole. */
	async checkTight(presented: number): Promise<boolean> {
		const stored = (await this.ctx.storage.get<number>('counter')) ?? 0;
		if (presented <= stored) return false;
		await this.ctx.storage.put('counter', presented);
		return true;
	}

	/** THE RULE: the naive sequence, explicitly serialized. Safe regardless of what awaits inside. */
	async checkGated(presented: number, delayMs: number): Promise<boolean> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const stored = (await this.ctx.storage.get<number>('counter')) ?? 0;
			if (delayMs > 0) await scheduler.wait(delayMs);
			if (presented <= stored) return false;
			await this.ctx.storage.put('counter', presented);
			return true;
		});
	}

	async stored(): Promise<number> {
		return (await this.ctx.storage.get<number>('counter')) ?? 0;
	}

	async reset(): Promise<void> {
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
	}

	// ---- Q5: enrollment lifecycle and alarm-based reaping (design §5a) ----

	/** Issue a pending enrollment challenge and arm the reaper. */
	async issueChallenge(challenge: string, ttlMs: number): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.put('challenge', challenge);
			await this.ctx.storage.put('verified', false);
			await this.ctx.storage.setAlarm(Date.now() + ttlMs);
		});
	}

	/** Consume the pending challenge and promote the DO to a verified device record. */
	async completeRegistration(): Promise<boolean> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const challenge = await this.ctx.storage.get<string>('challenge');
			if (!challenge) return false;
			await this.ctx.storage.delete('challenge');
			await this.ctx.storage.put('verified', true);
			await this.ctx.storage.put('counter', 0);
			return true;
		});
	}

	/**
	 * THE STATE-BRANCHING REAPER. A DO has only one alarm, so this handler cannot
	 * assume it is the enrollment reaper — an unconditional deleteAll() here would
	 * wipe live, verified devices.
	 */
	async alarm(): Promise<void> {
		const verified = await this.ctx.storage.get<boolean>('verified');
		if (verified === true) return; // live device: leave it alone
		await this.ctx.storage.deleteAll();
	}

	async snapshot(): Promise<{ keys: string[]; verified: boolean; alarmAt: number | null }> {
		const all = await this.ctx.storage.list<unknown>();
		return {
			keys: [...all.keys()],
			verified: all.get('verified') === true,
			alarmAt: await this.ctx.storage.getAlarm(),
		};
	}
}
