import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					// Test-only secret values; production uses `wrangler secret put`
					bindings: {
						APP_SECRET: 'test-app-secret',
						ANTHROPIC_API_KEY: 'test-anthropic-key-never-used',
					},
				},
			},
		},
	},
});
