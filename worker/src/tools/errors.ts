/**
 * Tool error taxonomy (plan step 16) plus the shared upstream-fetch
 * helpers that raise it (`fetchOk` / `fetchJson` / `readTextBody` / `readJsonBody`) — so
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
	/** Upstream unavailable: non-OK HTTP status, network failure, timeout, or the body read dying mid-stream. */
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
 * Deadline for each upstream data fetch, body read included (plan step
 * 46, pulled forward — Codex review). A stalled NOAA/NSIDC/Open-Meteo
 * endpoint must fail fast as a `tool_fetch_failed` Claude can report,
 * not hang the whole request.
 */
export const FETCH_TIMEOUT_MS = 5_000;

/**
 * Describe a rejected fetch or body read without its message — a native
 * network error can echo the URL, which step 16's rule keeps out of logs.
 */
function describeFailure(error: unknown): string {
	if (error instanceof Error && error.name === 'TimeoutError') return `timed out after ${FETCH_TIMEOUT_MS}ms`;
	return `network error (${error instanceof Error ? error.name : 'unknown'})`;
}

/**
 * `fetch` a URL, returning the response or throwing `tool_fetch_failed`:
 * on a non-OK status (carrying the HTTP status), and on a rejected fetch
 * — DNS failure, connection reset, TLS error, timeout — which would
 * otherwise escape as a native exception and be misfiled as `unhandled`.
 * `source` is the citation-style prefix, e.g. "NOAA GML". The URL is
 * deliberately kept out of the message — an Open-Meteo URL carries a city
 * name and coordinates, and step 16's rule keeps user-derived content out
 * of logs. The timeout signal stays attached to the body stream, so it
 * bounds the later body read too.
 */
export async function fetchOk(url: string, source: string): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (error) {
		throw new ToolError('tool_fetch_failed', `${source} fetch failed: ${describeFailure(error)}`);
	}
	if (!response.ok) {
		throw new ToolError('tool_fetch_failed', `${source} fetch failed: ${response.status}`, response.status);
	}
	return response;
}

/**
 * Read a response body as text. A failure here is the connection dying
 * (or timing out) mid-body — an availability problem, so it's
 * `tool_fetch_failed`, not the `tool_parse_failed` drift signal.
 */
export async function readTextBody(response: Response, source: string): Promise<string> {
	try {
		return await response.text();
	} catch (error) {
		throw new ToolError('tool_fetch_failed', `${source} body read failed: ${describeFailure(error)}`);
	}
}

/**
 * Parse a JSON response body. The body is read first (`readTextBody`) so
 * a dropped connection stays `tool_fetch_failed`; only a body that
 * arrived intact but isn't JSON (CDN error page, maintenance HTML) becomes
 * `tool_parse_failed`. Without this the raw `SyntaxError` reaches the loop
 * as a non-`ToolError` and is misfiled as `unhandled`.
 */
export async function readJsonBody(response: Response, source: string): Promise<unknown> {
	const text = await readTextBody(response, source);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new ToolError('tool_parse_failed', `${source}: response body was not valid JSON`);
	}
}

/** `fetchOk` + `readJsonBody` — for the upstreams that return JSON. */
export async function fetchJson(url: string, source: string): Promise<unknown> {
	return readJsonBody(await fetchOk(url, source), source);
}
