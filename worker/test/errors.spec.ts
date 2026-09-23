/**
 * Shared upstream-fetch helpers (plan step 16 / review finding #9):
 * fetchOk / fetchJson / readJsonBody all raise a ToolError carrying the
 * right class so claude.ts never has to guess it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolError, FETCH_TIMEOUT_MS, fetchOk, fetchJson, readJsonBody, readTextBody } from '../src/tools/errors';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('fetchOk', () => {
	it('returns the response on a 2xx', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
		const response = await fetchOk('https://example.test/x', 'Test source');
		expect(await response.text()).toBe('ok');
	});

	it('throws tool_fetch_failed with the status on a non-2xx, and keeps the URL out of the message', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }));
		await expect(fetchOk('https://example.test/secret-path?city=Portland', 'NOAA GML')).rejects.toMatchObject({
			toolErrorClass: 'tool_fetch_failed',
			upstreamStatus: 503,
			message: 'NOAA GML fetch failed: 503',
		});
	});

	it('passes a timeout signal to fetch', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
		await fetchOk('https://example.test/x', 'Test source');
		expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
	});

	it('wraps a rejected fetch (DNS, reset, TLS) as tool_fetch_failed with no status, keeping the native message out', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network connection lost to https://example.test/?city=Portland'));
		await expect(fetchOk('https://example.test/?city=Portland', 'Open-Meteo archive')).rejects.toMatchObject({
			toolErrorClass: 'tool_fetch_failed',
			upstreamStatus: undefined,
			message: 'Open-Meteo archive fetch failed: network error (TypeError)',
		});
	});

	it('reports a timeout as tool_fetch_failed, naming the deadline', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
		await expect(fetchOk('https://example.test/x', 'NOAA GML')).rejects.toMatchObject({
			toolErrorClass: 'tool_fetch_failed',
			message: `NOAA GML fetch failed: timed out after ${FETCH_TIMEOUT_MS}ms`,
		});
	});
});

/** A 200 response whose body stream dies partway through. */
function brokenBodyResponse(): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('year,mean'));
			controller.error(new TypeError('connection reset'));
		},
	});
	return new Response(body, { status: 200 });
}

describe('readTextBody', () => {
	it('returns the body text', async () => {
		expect(await readTextBody(new Response('a,b', { status: 200 }), 'Test')).toBe('a,b');
	});

	it('turns a body read that dies mid-stream into tool_fetch_failed, not the parse-drift class', async () => {
		await expect(readTextBody(brokenBodyResponse(), 'NSIDC sea ice')).rejects.toMatchObject({
			toolErrorClass: 'tool_fetch_failed',
			message: 'NSIDC sea ice body read failed: network error (TypeError)',
		});
	});
});

describe('readJsonBody / fetchJson', () => {
	it('parses a JSON body', async () => {
		const parsed = await readJsonBody(new Response('{"a":1}', { status: 200 }), 'Test');
		expect(parsed).toEqual({ a: 1 });
	});

	it('turns an invalid-JSON body into tool_parse_failed, not a raw SyntaxError', async () => {
		await expect(readJsonBody(new Response('<html>maintenance</html>', { status: 200 }), 'Open-Meteo archive')).rejects.toBeInstanceOf(
			ToolError,
		);
		await expect(readJsonBody(new Response('<html>', { status: 200 }), 'Open-Meteo archive')).rejects.toMatchObject({
			toolErrorClass: 'tool_parse_failed',
		});
	});

	it('files a body that dies mid-stream as tool_fetch_failed, not tool_parse_failed', async () => {
		await expect(readJsonBody(brokenBodyResponse(), 'Open-Meteo archive')).rejects.toMatchObject({
			toolErrorClass: 'tool_fetch_failed',
		});
	});

	it('fetchJson chains the fetch and the parse', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"results":[]}', { status: 200 }));
		expect(await fetchJson('https://example.test/g', 'Open-Meteo geocoding')).toEqual({ results: [] });
	});
});
