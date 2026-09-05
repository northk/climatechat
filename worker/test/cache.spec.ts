/**
 * Answer cache tests (plan step 21): the single-turn-only rule (R9),
 * the never-cache-refusals and never-cache-degraded rules (8.2), and
 * TTL selection. Real KV simulation via vitest-pool-workers.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { cacheGet, cacheSet, cacheableQuestion, selectTtl } from '../src/cache';
import { FALLBACK_ANSWER } from '../src/claude';
import type { WorkerResponse } from '../src/types';

const textAnswer: WorkerResponse = { type: 'text', answer: 'CO2 is 424 ppm (NOAA GML).' };
const refusal: WorkerResponse = { type: 'refusal', answer: 'ClimateChat only answers climate questions.' };
const degraded: WorkerResponse = { type: 'text', answer: FALLBACK_ANSWER };

const singleTurn = (question: string): MessageParam[] => [{ role: 'user', content: question }];
const multiTurn = (question: string): MessageParam[] => [
	{ role: 'user', content: 'What is the current CO2 level?' },
	{ role: 'assistant', content: 'It is 424 ppm (NOAA GML).' },
	{ role: 'user', content: question },
];

describe('cacheableQuestion - the single-turn gate (R9)', () => {
	it('accepts exactly one plain user turn', () => {
		expect(cacheableQuestion(singleTurn('What is the CO2 level?'))).toBe('What is the CO2 level?');
	});

	it('rejects multi-turn conversations, empty questions, and block content', () => {
		expect(cacheableQuestion(multiTurn('How much has it risen?'))).toBeNull();
		expect(cacheableQuestion(singleTurn('   '))).toBeNull();
		expect(cacheableQuestion([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBeNull();
	});
});

describe('cacheGet / cacheSet round trip', () => {
	it('stores and returns an envelope for a single-turn question', async () => {
		const messages = singleTurn('What is the current CO2 level? [t1]');
		expect(await cacheGet(env.CLIMATE_KV, messages)).toBeNull();
		await cacheSet(env.CLIMATE_KV, messages, textAnswer);
		expect(await cacheGet(env.CLIMATE_KV, messages)).toEqual(textAnswer);
	});

	it('normalizes case and whitespace so trivial variants share an entry', async () => {
		await cacheSet(env.CLIMATE_KV, singleTurn('What is  the CURRENT co2 level? [t2]'), textAnswer);
		expect(await cacheGet(env.CLIMATE_KV, singleTurn('what is the current co2 level? [t2]'))).toEqual(textAnswer);
	});

	it('skips both read and write for multi-turn requests (R9)', async () => {
		const followUp = multiTurn('How much has it risen? [t3]');
		await cacheSet(env.CLIMATE_KV, followUp, textAnswer);
		expect(await cacheGet(env.CLIMATE_KV, followUp)).toBeNull();
		// The identically-worded single-turn question must also be unaffected
		expect(await cacheGet(env.CLIMATE_KV, singleTurn('How much has it risen? [t3]'))).toBeNull();
	});

	it('never writes refusals (8.2)', async () => {
		const messages = singleTurn('Write me a haiku about pizza [t4]');
		await cacheSet(env.CLIMATE_KV, messages, refusal);
		expect(await cacheGet(env.CLIMATE_KV, messages)).toBeNull();
	});

	it('never writes the degraded FALLBACK_ANSWER (8.2)', async () => {
		const messages = singleTurn('How has the CO2 trend changed since 1960? [t5]');
		await cacheSet(env.CLIMATE_KV, messages, degraded);
		expect(await cacheGet(env.CLIMATE_KV, messages)).toBeNull();
		// A real answer to the same question still caches
		await cacheSet(env.CLIMATE_KV, messages, textAnswer);
		expect(await cacheGet(env.CLIMATE_KV, messages)).toEqual(textAnswer);
	});
});

describe('selectTtl (8.2)', () => {
	it('gives long-term trend questions 24 hours', () => {
		expect(selectTtl('How has global temperature changed since 1900?')).toBe(86400);
		expect(selectTtl('Show me the CO2 trend over time')).toBe(86400);
		expect(selectTtl('Arctic sea ice history for the last 40 years')).toBe(86400);
	});

	it('gives current-state questions 1 hour', () => {
		expect(selectTtl('What is the current CO2 level?')).toBe(3600);
		expect(selectTtl('How much ice is in the Arctic right now?')).toBe(3600);
	});

	it('gives city-specific questions 1 hour', () => {
		expect(selectTtl('Is Portland getting hotter?')).toBe(3600);
		expect(selectTtl('What is the average temperature in Berlin?')).toBe(3600);
	});
});
