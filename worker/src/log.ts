/**
 * Structured error logging (plan step 16), in its own module so tool
 * handlers can log without importing `claude.ts` — that would be a cycle
 * (claude.ts → tools/registry.ts → tools/openMeteo.ts → claude.ts).
 *
 * Lands in Workers Logs via the observability binding. Never include
 * question text, IPs, or other user-derived content (a city name, its
 * coordinates, a URL carrying either) — the class, tool name and status
 * carry the diagnosis.
 */

import type { ToolErrorClass } from './tools/errors';

export type ErrorClass =
	| ToolErrorClass
	| 'claude_malformed_json'
	| 'chart_injection_mismatch'
	| 'claude_timeout'
	/** A KV read/write for a data cache failed, or held a corrupt entry. Never fails the answer — it only costs a refetch (R12). */
	| 'kv_cache_failed'
	| 'unhandled';

export function logError(errorClass: ErrorClass, fields: { tool?: string; upstreamStatus?: number; message: string }): void {
	console.error(JSON.stringify({ class: errorClass, ...fields }));
}
