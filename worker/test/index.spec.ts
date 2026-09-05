/**
 * /ask pipeline tests (plan steps 23-24). Routing/auth paths run through
 * the real Worker via SELF.fetch; pipeline-ordering tests call handleAsk
 * directly with a stubbed Claude call — no request in this suite ever
 * reaches the Anthropic API.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { handleAsk, parseMessages, verifyClient } from '../src/index';
import { cacheGet, cacheSet } from '../src/cache';
import { DAILY_LIMIT } from '../src/rateLimit';
import type { WorkerResponse } from '../src/types';

const SECRET = 'test-app-secret'; // matches vitest.config.mts miniflare bindings

function askRequest(body: unknown, headers: Record<string, string> = {}): Request {
	return new Request('https://example.com/ask', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-App-Secret': SECRET, ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

const question = (text: string) => ({ messages: [{ role: 'user', content: text }] });
const textAnswer: WorkerResponse = { type: 'text', answer: '424 ppm (NOAA GML).' };
const stubAsk = (response: WorkerResponse = textAnswer) => vi.fn().mockResolvedValue(response);

describe('routing and client verification (SELF, real Worker)', () => {
	it('returns 404 off /ask and 405 for non-POST', async () => {
		expect((await SELF.fetch('https://example.com/', { method: 'POST' })).status).toBe(404);
		const wrongMethod = await SELF.fetch('https://example.com/ask');
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get('Allow')).toBe('POST');
	});

	it('rejects a missing or wrong X-App-Secret with 401 (step 23)', async () => {
		const noHeader = await SELF.fetch('https://example.com/ask', {
			method: 'POST',
			body: JSON.stringify(question('CO2?')),
		});
		expect(noHeader.status).toBe(401);

		const wrongHeader = await SELF.fetch('https://example.com/ask', {
			method: 'POST',
			headers: { 'X-App-Secret': 'wrong' },
			body: JSON.stringify(question('CO2?')),
		});
		expect(wrongHeader.status).toBe(401);
	});

	it('never sets CORS headers (step 6 / R10)', async () => {
		const response = await SELF.fetch('https://example.com/ask', {
			method: 'POST',
			headers: { Origin: 'https://evil.example' },
			body: '{}',
		});
		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
	});
});

describe('verifyClient (step 23)', () => {
	const request = (secret?: string) => new Request('https://example.com/ask', { headers: secret ? { 'X-App-Secret': secret } : {} });

	it('accepts only the exact secret', () => {
		expect(verifyClient(request(SECRET), env)).toBe(true);
		expect(verifyClient(request('wrong'), env)).toBe(false); // length mismatch
		expect(verifyClient(request(SECRET.slice(0, -1) + 'X'), env)).toBe(false); // same length, last char differs
		expect(verifyClient(request(), env)).toBe(false);
	});

	it('fails closed when the APP_SECRET binding is missing or empty', () => {
		expect(verifyClient(request(''), { ...env, APP_SECRET: '' })).toBe(false);
	});
});

describe('parseMessages', () => {
	it('accepts a valid history ending in a user turn', () => {
		const history = [
			{ role: 'user', content: 'CO2 level?' },
			{ role: 'assistant', content: '424 ppm (NOAA GML).' },
			{ role: 'user', content: 'And methane?' },
		];
		expect(parseMessages({ messages: history })).toEqual(history);
	});

	it('rejects missing/empty/malformed histories', () => {
		expect(parseMessages({})).toBeNull();
		expect(parseMessages({ messages: [] })).toBeNull();
		expect(parseMessages({ messages: [{ role: 'system', content: 'x' }] })).toBeNull();
		expect(parseMessages({ messages: [{ role: 'user', content: '  ' }] })).toBeNull();
		// ends in an assistant turn
		expect(
			parseMessages({
				messages: [
					{ role: 'user', content: 'q' },
					{ role: 'assistant', content: 'a' },
				],
			}),
		).toBeNull();
	});

	it('rejects a history that starts with an assistant turn (API would 400)', () => {
		expect(
			parseMessages({
				messages: [
					{ role: 'assistant', content: 'Hello!' },
					{ role: 'user', content: 'CO2?' },
				],
			}),
		).toBeNull();
	});
});

describe('handleAsk pipeline ordering (stubbed Claude)', () => {
	it('returns 400 for unparseable JSON and invalid message shapes', async () => {
		const ask = stubAsk();
		expect((await handleAsk(askRequest('{not json'), env, ask)).status).toBe(400);
		expect((await handleAsk(askRequest({ messages: [] }), env, ask)).status).toBe(400);
		expect(ask).not.toHaveBeenCalled();
	});

	it('serves a cache hit without calling Claude or charging the rate limit (step 24)', async () => {
		const messages = [{ role: 'user', content: 'Cached question? [p1]' }] as MessageParam[];
		await cacheSet(env.CLIMATE_KV, messages, textAnswer);

		const ask = stubAsk();
		const ip = '198.51.100.1';
		const response = await handleAsk(askRequest({ messages }, { 'CF-Connecting-IP': ip }), env, ask);

		expect(await response.json()).toEqual(textAnswer);
		expect(ask).not.toHaveBeenCalled();
		const day = new Date().toISOString().slice(0, 10);
		expect(await env.CLIMATE_KV.get(`rl:${ip}:${day}`)).toBeNull();
	});

	it('consumes quota on misses and returns the friendly 429 past the limit', async () => {
		const ask = stubAsk();
		const ip = '198.51.100.2';
		for (let i = 0; i < DAILY_LIMIT; i++) {
			const ok = await handleAsk(askRequest(question(`Fresh question ${i}? [p2]`), { 'CF-Connecting-IP': ip }), env, ask);
			expect(ok.status).toBe(200);
		}
		const over = await handleAsk(askRequest(question('One more? [p2]'), { 'CF-Connecting-IP': ip }), env, ask);
		expect(over.status).toBe(429);
		const overBody: { error: string } = await over.json();
		expect(overBody.error).toMatch(/daily limit/);
		expect(ask).toHaveBeenCalledTimes(DAILY_LIMIT);
	});

	it('writes single-turn answers to the cache after a miss', async () => {
		const messages = [{ role: 'user', content: 'Write-through question? [p3]' }] as MessageParam[];
		await handleAsk(askRequest({ messages }, { 'CF-Connecting-IP': '198.51.100.3' }), env, stubAsk());
		expect(await cacheGet(env.CLIMATE_KV, messages)).toEqual(textAnswer);
	});

	it('never caches refusals, so a repeat off-topic question calls Claude again', async () => {
		const refusal: WorkerResponse = { type: 'refusal', answer: 'Climate questions only.' };
		const messages = [{ role: 'user', content: 'Pizza haiku? [p4]' }] as MessageParam[];
		const ask = stubAsk(refusal);
		const ip = '198.51.100.4';
		await handleAsk(askRequest({ messages }, { 'CF-Connecting-IP': ip }), env, ask);
		await handleAsk(askRequest({ messages }, { 'CF-Connecting-IP': ip }), env, ask);
		expect(ask).toHaveBeenCalledTimes(2);
		expect(await cacheGet(env.CLIMATE_KV, messages)).toBeNull();
	});

	it('skips the cache entirely for multi-turn requests (R9)', async () => {
		const history = [
			{ role: 'user', content: 'CO2? [p5]' },
			{ role: 'assistant', content: '424 ppm (NOAA GML).' },
			{ role: 'user', content: 'How much has it risen? [p5]' },
		] as MessageParam[];
		const ask = stubAsk();
		await handleAsk(askRequest({ messages: history }, { 'CF-Connecting-IP': '198.51.100.5' }), env, ask);
		await handleAsk(askRequest({ messages: history }, { 'CF-Connecting-IP': '198.51.100.5' }), env, ask);
		// No cache read or write: both identical requests reached Claude
		expect(ask).toHaveBeenCalledTimes(2);
	});
});
