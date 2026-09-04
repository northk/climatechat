/**
 * Tool error taxonomy (plan step 16).
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
