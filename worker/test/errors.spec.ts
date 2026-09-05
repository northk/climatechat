/**
 * Shared upstream-fetch helpers (plan step 16 / review finding #9):
 * fetchOk / fetchJson / readJsonBody all raise a ToolError carrying the
 * right class so claude.ts never has to guess it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolError, fetchOk, fetchJson, readJsonBody } from '../src/tools/errors';

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

	it('fetchJson chains the fetch and the parse', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"results":[]}', { status: 200 }));
		expect(await fetchJson('https://example.test/g', 'Open-Meteo geocoding')).toEqual({ results: [] });
	});
});
