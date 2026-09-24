/**
 * Runtime validator for the public response envelope (Section 4). The
 * TypeScript types in `types.ts` vanish at runtime, so anything that
 * crosses a trust boundary gets checked here before it reaches iOS
 * (Codex review):
 *   - Claude's result, after chart data injection (`parseEnvelope`)
 *   - answer-cache reads (`cacheGet`): an entry from an older schema, a
 *     buggy deploy, or a manual KV edit would otherwise be served as-is
 *     for up to its 24h TTL
 *
 * Strict on what iOS renders: non-empty answer / title / explanation /
 * dataset label text, at least one dataset each with at least one point,
 * and finite numbers — `JSON.stringify(NaN)` is `null`, which the iOS
 * Codable structs (non-optional Double) fail to decode. Axis labels only
 * need to be strings: an empty one is a legitimate unlabeled axis.
 */

import type { ChartDataset, ChartPoint, WorkerResponse } from './types';

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isChartPoint(value: unknown): value is ChartPoint {
	const point = value as Partial<ChartPoint> | null;
	return typeof point === 'object' && point !== null && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isChartDataset(value: unknown): value is ChartDataset {
	const dataset = value as Partial<ChartDataset> | null;
	return (
		typeof dataset === 'object' &&
		dataset !== null &&
		isNonEmptyString(dataset.label) &&
		Array.isArray(dataset.data) &&
		dataset.data.length > 0 &&
		dataset.data.every(isChartPoint)
	);
}

export function isWorkerResponse(value: unknown): value is WorkerResponse {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const envelope = value as Record<string, unknown>;
	switch (envelope.type) {
		case 'text':
		case 'refusal':
			return isNonEmptyString(envelope.answer);
		case 'chart':
			return (
				(envelope.chartType === 'line' || envelope.chartType === 'bar') &&
				isNonEmptyString(envelope.title) &&
				typeof envelope.xLabel === 'string' &&
				typeof envelope.yLabel === 'string' &&
				isNonEmptyString(envelope.explanation) &&
				Array.isArray(envelope.datasets) &&
				envelope.datasets.length > 0 &&
				envelope.datasets.every(isChartDataset)
			);
		default:
			return false;
	}
}
