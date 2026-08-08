/**
 * Response envelope types for the Worker → iOS contract (plan Section 4).
 *
 * The Worker always returns one of the three shapes in `WorkerResponse`.
 * iOS Codable structs must match these exactly (CLAUDE.md).
 *
 * `ClaudeChartResponse` is deliberately NOT part of `WorkerResponse`: it is
 * the internal Claude↔Worker contract in which Claude names *which* tool
 * call's data to chart (`sourceToolCallId`) without re-typing data points.
 * The Worker resolves those IDs against tool results and injects real
 * `data` arrays, producing the public `ChartResponse`. Keeping the two as
 * distinct types means accidentally sending the Claude-facing shape to the
 * iOS app fails to compile rather than failing at runtime.
 */

export interface TextResponse {
	type: 'text';
	answer: string;
}

/**
 * Off-topic refusal (plan Section 7). Same shape as `TextResponse` apart
 * from the discriminant; no tool call is ever made for a refusal.
 */
export interface RefusalResponse {
	type: 'refusal';
	answer: string;
}

export type ChartType = 'line' | 'bar';

export interface ChartPoint {
	x: number;
	y: number;
}

/**
 * The structured JSON every tool handler returns as its tool_result
 * (plan Phase 2 preamble — never raw CSV). Phase 3's chart injection
 * reads `points` straight out of this by `sourceToolCallId`, and the
 * `source` string is what Claude must cite verbatim (Section 7).
 */
export interface ToolDataResult {
	/** Exact citation name, e.g. "NOAA GML" — never attribute across sources */
	source: string;
	/** Human-readable series description, e.g. "Atmospheric CO2 (monthly mean)" */
	description: string;
	/** Measurement unit, e.g. "ppm" */
	unit: string;
	points: ChartPoint[];
}

/** Claude-facing dataset: names the source tool call, never the data. */
export interface ClaudeChartDataset {
	label: string;
	sourceToolCallId: string;
}

/** Public dataset: real data points, injected by the Worker. */
export interface ChartDataset {
	label: string;
	data: ChartPoint[];
}

interface ChartResponseBase {
	type: 'chart';
	chartType: ChartType;
	title: string;
	xLabel: string;
	yLabel: string;
	explanation: string;
}

/** The metadata-only chart shape Claude is allowed to emit. Internal. */
export interface ClaudeChartResponse extends ChartResponseBase {
	datasets: ClaudeChartDataset[];
}

/** The expanded chart shape the iOS app receives. */
export interface ChartResponse extends ChartResponseBase {
	datasets: ChartDataset[];
}

/** Everything the Worker may send to the iOS app. */
export type WorkerResponse = TextResponse | RefusalResponse | ChartResponse;
