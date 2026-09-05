/**
 * Tool error taxonomy (plan step 16) plus the shared upstream-fetch
 * helpers that raise it (`fetchOk` / `fetchJson` / `readJsonBody`) — so
 * every handler's fetch → status-check → parse path is one line, not a
 * copy that can drift out of sync (pre-Phase-4 review finding #9).
 *
 * The tool handlers throw on failure; the loop in `claude.ts`, not the
 * handlers, owns failure *policy* (whether to retry, how to tell Claude).
 * But the failure *class* is a fact known only at the throw site, so each
 * throw carries it explicitly instead of `claude.ts` reconstructing it
 * from the message text — that scheme silently reclassified any reworded
 * validation string and filed hallucinated tool names under the
 * `tool_parse_failed` upstream-drift alarm.
 *
 * `claude.ts` maps `toolErrorClass` straight onto its structured-log
 * `class` field; a non-`ToolError` exception escaping a handler is a
 * genuine bug and logs as `unhandled`.
 */

export type ToolErrorClass =
	/** Upstream responded with a non-OK HTTP status. */
	| 'tool_fetch_failed'
	/** Upstream responded, but the body shape / columns weren't what we parse — the signal that an upstream source drifted. */
	| 'tool_parse_failed'
	/** The `tool_use` input Claude sent failed validation (bad enum, out-of-range year, unresolvable city). */
	| 'tool_input_invalid'
	/** Claude called a tool name that isn't in the registry (see Section 7 rule 9). Kept out of the drift signal. */
	| 'unknown_tool';

/** Error thrown by every tool handler, tagged with its failure class. */
export class ToolError extends Error {
	readonly toolErrorClass: ToolErrorClass;
	/** HTTP status, set only for `tool_fetch_failed`. */
	readonly upstreamStatus?: number;

	constructor(toolErrorClass: ToolErrorClass, message: string, upstreamStatus?: number) {
		super(message);
		this.name = 'ToolError';
		this.toolErrorClass = toolErrorClass;
		this.upstreamStatus = upstreamStatus;
	}
}

/**
 * `fetch` a URL, returning the response or throwing `tool_fetch_failed`
 * (carrying the HTTP status) on a non-OK status. `source` is the
 * citation-style prefix, e.g. "NOAA GML". The URL is deliberately kept
 * out of the message — an Open-Meteo URL carries a city name and
 * coordinates, and step 16's rule keeps user-derived content out of logs.
 */
export async function fetchOk(url: string, source: string): Promise<Response> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new ToolError('tool_fetch_failed', `${source} fetch failed: ${response.status}`, response.status);
	}
	return response;
}

/**
 * Parse a JSON response body, converting a `SyntaxError` (upstream sent
 * HTTP 200 with a non-JSON body — CDN error page, truncated response)
 * into a `tool_parse_failed` `ToolError`. Without this the raw
 * `SyntaxError` reaches the loop as a non-`ToolError` and is misfiled as
 * `unhandled` instead of the upstream-drift class.
 */
export async function readJsonBody(response: Response, source: string): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new ToolError('tool_parse_failed', `${source}: response body was not valid JSON`);
	}
}

/** `fetchOk` + `readJsonBody` — for the upstreams that return JSON. */
export async function fetchJson(url: string, source: string): Promise<unknown> {
	return readJsonBody(await fetchOk(url, source), source);
}
