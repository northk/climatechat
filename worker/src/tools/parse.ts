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
