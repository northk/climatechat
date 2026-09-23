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
					// Test-only Durable Object binding for the App Attest spike.
					// Deliberately NOT in wrangler.jsonc: a DO declared there needs a
					// `migrations` entry, which is append-only history applied on the
					// first real `wrangler deploy` and then only removable via a
					// `deleted_classes` migration. Scaffolding must not leave a
					// permanent mark on production migration history. Miniflare
					// simulates DOs locally without migrations, so tests need nothing
					// beyond this.
					durableObjects: {
						SPIKE_COUNTER: { className: 'SpikeCounter', useSQLite: true },
					},
				},
			},
		},
	},
});
