import { describe, it, expect } from 'vitest';
import type { ChartResponse, ClaudeChartResponse, WorkerResponse } from '../src/types';

// Example payloads from plan Section 4
const claudeChart: ClaudeChartResponse = {
	type: 'chart',
	chartType: 'line',
	title: 'Global Temperature Anomaly (1880–2024)',
	xLabel: 'Year',
	yLabel: '°C anomaly vs. 1951–1980 average',
	datasets: [{ label: 'Temperature anomaly', sourceToolCallId: 'toolu_01Abc' }],
	explanation: 'The chart shows Earth has warmed approximately 1.2°C since the late 19th century.',
};

const publicChart: ChartResponse = {
	type: 'chart',
	chartType: 'line',
	title: 'Global Temperature Anomaly (1880–2024)',
	xLabel: 'Year',
	yLabel: '°C anomaly vs. 1951–1980 average',
	datasets: [
		{
			label: 'Temperature anomaly',
			data: [
				{ x: 1880, y: -0.16 },
				{ x: 1881, y: -0.08 },
			],
		},
	],
	explanation: 'The chart shows Earth has warmed approximately 1.2°C since the late 19th century.',
};

describe('response envelope types', () => {
	it('keeps the Claude-facing chart shape out of the public union at compile time', () => {
		// @ts-expect-error — ClaudeChartResponse is the internal Claude↔Worker
		// contract; sending it to the iOS app must not compile (plan Section 4)
		const leaked: WorkerResponse = claudeChart;
		expect(leaked.type).toBe('chart');
	});

	it('keeps the two chart dataset shapes mutually non-assignable', () => {
		// @ts-expect-error — metadata-only datasets must not pass as injected data
		const asPublic: ChartResponse = claudeChart;
		// @ts-expect-error — and the reverse must not compile either
		const asClaude: ClaudeChartResponse = publicChart;
		expect(asPublic.type).toBe('chart');
		expect(asClaude.type).toBe('chart');
	});

	it('narrows the WorkerResponse union by its type discriminant', () => {
		const responses: WorkerResponse[] = [
			{ type: 'text', answer: 'Global CO2 levels reached 424 ppm...' },
			{
				type: 'refusal',
				answer: 'ClimateChat only answers questions about climate change...',
			},
			publicChart,
		];

		for (const response of responses) {
			if (response.type === 'chart') {
				expect(response.datasets[0].data.length).toBeGreaterThan(0);
			} else {
				// text and refusal share the answer-only shape
				expect(response.answer.length).toBeGreaterThan(0);
			}
		}
	});
});
