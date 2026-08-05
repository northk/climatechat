import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('POST /ask (Phase 1 echo stub)', () => {
	it('echoes a JSON body back', async () => {
		const payload = { messages: [{ role: 'user', content: 'What is the current CO2 level?' }] };
		const response = await SELF.fetch('https://example.com/ask', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ echo: payload });
	});

	it('rejects a malformed JSON body with 400', async () => {
		const response = await SELF.fetch('https://example.com/ask', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{not json',
		});
		expect(response.status).toBe(400);
	});

	it('rejects non-POST methods with 405', async () => {
		const response = await SELF.fetch('https://example.com/ask');
		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('POST');
	});

	it('returns 404 for unknown paths', async () => {
		const response = await SELF.fetch('https://example.com/', { method: 'POST' });
		expect(response.status).toBe(404);
	});

	it('never sets CORS headers (plan step 6 / R10)', async () => {
		const response = await SELF.fetch('https://example.com/ask', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
			body: JSON.stringify({ probe: true }),
		});
		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
	});
});
