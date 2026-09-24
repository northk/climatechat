/**
 * The runtime envelope validator (Codex review): the one check shared by
 * Claude results (parseEnvelope) and answer-cache reads (cacheGet).
 */

import { describe, it, expect } from 'vitest';
import { isWorkerResponse } from '../src/validate';

const chart = {
	type: 'chart',
	chartType: 'line',
	title: 'Global CO2',
	xLabel: 'Year',
	yLabel: 'ppm',
	explanation: 'CO2 has risen since 1979 (NOAA GML).',
	datasets: [
		{
			label: 'CO2',
			data: [
				{ x: 1979, y: 336.85 },
				{ x: 1980, y: 338.91 },
			],
		},
	],
};

/** A copy of the valid chart with one change applied. */
function chartWith(change: (copy: Record<string, unknown>) => void): unknown {
	const copy = structuredClone(chart) as Record<string, unknown>;
	change(copy);
	return copy;
}

describe('isWorkerResponse - accepts', () => {
	it('text and refusal envelopes with a non-empty answer', () => {
		expect(isWorkerResponse({ type: 'text', answer: '424 ppm (NOAA GML)' })).toBe(true);
		expect(isWorkerResponse({ type: 'refusal', answer: 'I only answer climate questions.' })).toBe(true);
	});

	it('a line or bar chart with finite points', () => {
		expect(isWorkerResponse(chart)).toBe(true);
		expect(isWorkerResponse(chartWith((c) => (c.chartType = 'bar')))).toBe(true);
	});

	it('empty axis labels — an unlabeled axis is legitimate', () => {
		expect(isWorkerResponse(chartWith((c) => ((c.xLabel = ''), (c.yLabel = ''))))).toBe(true);
	});
});

describe('isWorkerResponse - rejects', () => {
	it.each([null, undefined, 'text', 42, [], [{ type: 'text', answer: 'hi' }]])('a non-object: %j', (value) => {
		expect(isWorkerResponse(value)).toBe(false);
	});

	it('an unknown or missing type', () => {
		expect(isWorkerResponse({ type: 'markdown', answer: 'hi' })).toBe(false);
		expect(isWorkerResponse({ answer: 'hi' })).toBe(false);
	});

	it('an empty, blank, or non-string answer', () => {
		expect(isWorkerResponse({ type: 'text', answer: '' })).toBe(false);
		expect(isWorkerResponse({ type: 'text', answer: '   ' })).toBe(false);
		expect(isWorkerResponse({ type: 'refusal', answer: 42 })).toBe(false);
		expect(isWorkerResponse({ type: 'text' })).toBe(false);
	});

	it('an unsupported chart type', () => {
		expect(isWorkerResponse(chartWith((c) => (c.chartType = 'pie')))).toBe(false);
	});

	it('an empty title or explanation, or a non-string axis label', () => {
		expect(isWorkerResponse(chartWith((c) => (c.title = '')))).toBe(false);
		expect(isWorkerResponse(chartWith((c) => (c.explanation = ' ')))).toBe(false);
		expect(isWorkerResponse(chartWith((c) => (c.yLabel = null)))).toBe(false);
	});

	it('Claude-facing chart metadata (sourceToolCallId, no data) — never sent to iOS', () => {
		expect(isWorkerResponse(chartWith((c) => (c.datasets = [{ label: 'CO2', sourceToolCallId: 'toolu_1' }])))).toBe(false);
	});

	it('no datasets, a dataset with no points, or an empty dataset label', () => {
		expect(isWorkerResponse(chartWith((c) => (c.datasets = [])))).toBe(false);
		expect(isWorkerResponse(chartWith((c) => (c.datasets = [{ label: 'CO2', data: [] }])))).toBe(false);
		expect(isWorkerResponse(chartWith((c) => (c.datasets = [{ label: '', data: [{ x: 1, y: 2 }] }])))).toBe(false);
	});

	it.each([
		['NaN', { x: 1979, y: NaN }],
		['Infinity', { x: Infinity, y: 1 }],
		['null (what JSON.stringify makes of NaN)', { x: 1979, y: null }],
		['a numeric string', { x: '1979', y: 1 }],
		['a missing coordinate', { x: 1979 }],
	])('a point with %s', (_name, point) => {
		expect(isWorkerResponse(chartWith((c) => (c.datasets = [{ label: 'CO2', data: [{ x: 1978, y: 335 }, point] }])))).toBe(false);
	});
});
