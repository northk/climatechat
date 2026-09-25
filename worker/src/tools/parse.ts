/**
 * Strict numeric parsing shared by the upstream parsers (Codex review).
 *
 * `Number()` alone coerces far too much: `Number(null)`, `Number("")`,
 * `Number(" ")` and `Number([])` are all 0, and `Number(true)` is 1.
 * A missing value in an upstream response would silently become a real
 * measurement, e.g. a 0.00 °C temperature anomaly. The positive-only
 * guards some parsers have (GML, NSIDC) don't cover it either: they only
 * check y, and a blank x would still become year 0. `parseFloat()` is no
 * better — it reads a numeric prefix, so "1.2C" would become 1.2.
 *
 * Genuine zeros must survive — NCEI does report 0 anomalies — so the rule
 * is about the input's *form*, not its value.
 */

import type { ChartPoint } from '../types';
import { ToolError } from './errors';

/**
 * A finite number, or a non-blank string that `Number()` converts in full
 * to a finite number → that number. Anything else — null, undefined, "",
 * blanks, booleans, arrays, "NaN", "Infinity", "1.2C", "1e999" (overflows
 * to Infinity) — → null.
 *
 * `Number()` also accepts hex / binary / octal strings ("0x10" → 16).
 * Harmless here: no upstream sends them, and one that did would still be
 * a real value, not a missing one turned into 0 — the bug this guards.
 */
export function parseNumber(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	// The blank check is what `Number()` lacks: it converts "" and "  " to 0
	if (typeof value !== 'string' || value.trim() === '') return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Sanity limits for one returned series (Codex review). The parsers only
 * fail when *zero* points survive, so an upstream change that breaks most
 * rows — or switches units, which is the likelier drift — would otherwise
 * produce a thin or wrongly-scaled chart that looks normal, now labeled
 * with our unit (Section 4). Failing here files it as tool_parse_failed,
 * the drift signal, instead.
 */
export interface SeriesLimits {
	/** Citation-style prefix for the error, e.g. "NOAA GML CO2 (annual)" */
	source: string;
	unit: string;
	/**
	 * Plausible y range, deliberately wide: it must never reject real data,
	 * only catch a unit or scale change (ppm→ppb, °C→K, km²→thousand km²).
	 */
	range: [min: number, max: number];
	/**
	 * Fewest points a healthy response has — only for series that always
	 * return their full record, set ~85% of the count measured live. Omit
	 * for range-requested series, where the count depends on the request.
	 */
	minPoints?: number;
}

/** Throw tool_parse_failed if the series is implausibly short or any value is out of range; else return it. */
export function checkSeries(points: ChartPoint[], limits: SeriesLimits): ChartPoint[] {
	const { source, unit, range, minPoints } = limits;
	if (minPoints !== undefined && points.length < minPoints) {
		throw new ToolError(
			'tool_parse_failed',
			`${source}: only ${points.length} data points, expected at least ${minPoints} — possible upstream format change`,
		);
	}
	const [min, max] = range;
	const outlier = points.find((point) => point.y < min || point.y > max);
	if (outlier) {
		throw new ToolError(
			'tool_parse_failed',
			`${source}: value ${outlier.y} ${unit} is outside the plausible range ${min} to ${max} — possible upstream unit or format change`,
		);
	}
	return points;
}
