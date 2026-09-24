/**
 * Strict numeric parsing shared by the upstream parsers (Codex review).
 *
 * `Number()` coerces far too much: `Number(null)`, `Number("")`,
 * `Number(" ")` and `Number([])` are all 0, and `Number(true)` is 1.
 * A missing value in an upstream response would silently become a real
 * measurement, e.g. a 0.00 °C temperature anomaly. The positive-only
 * guards some parsers have (GML, NSIDC) don't cover it either: they only
 * check y, and a blank x would still become year 0.
 *
 * Genuine zeros must survive — NCEI does report 0 anomalies — so the rule
 * is about the input's *form*, not its value.
 */

/** Plain decimal notation, optionally signed and with an exponent. No hex, no "Infinity". */
const DECIMAL = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * A finite number, or a string holding exactly one decimal number
 * (surrounding whitespace allowed) → that number. Anything else — null,
 * undefined, "", blanks, booleans, arrays, "NaN", "0x10" — → null.
 */
export function parseNumber(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!DECIMAL.test(trimmed)) return null;
	const parsed = Number(trimmed);
	// A huge exponent ("1e999") passes the pattern but overflows to Infinity
	return Number.isFinite(parsed) ? parsed : null;
}
