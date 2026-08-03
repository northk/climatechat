/**
 * ClimateChat Worker entry point.
 *
 * Routes POST /ask. Phase 1 stub: echoes the request body back; the real
 * pipeline (verifyClient → cache → rate limit → Claude → cache write)
 * arrives in Phase 3.
 *
 * Deliberately NO CORS headers, ever (plan step 6 / R10): the iOS app is a
 * native URLSession client, so CORS never applies to it — omitting the
 * headers makes naive browser-JS abuse fail at the preflight stage before
 * a request reaches this Worker. Do not "fix" this by adding
 * Access-Control-Allow-Origin.
 */

export default {
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname !== '/ask') {
			return Response.json({ error: 'Not found' }, { status: 404 });
		}

		if (request.method !== 'POST') {
			return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } });
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
		}

		// Phase 1 stub: echo the parsed body back
		return Response.json({ echo: body });
	},
} satisfies ExportedHandler<Env>;
