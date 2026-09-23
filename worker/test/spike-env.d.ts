/**
 * SPIKE — test-only type for the App Attest spike's Durable Object binding.
 *
 * The binding is declared in vitest.config.mts (miniflare.durableObjects), not
 * in wrangler.jsonc, so it never reaches the deployable config and never needs
 * a `migrations` entry. Because it is absent from wrangler.jsonc it is also
 * absent from the generated worker-configuration.d.ts, so ProvidedEnv has to be
 * augmented here for the spike tests to typecheck.
 *
 * Delete alongside src/spikeCounter.ts when the spike is torn down.
 */

import type { SpikeCounter } from '../src/spikeCounter';

declare module 'cloudflare:test' {
	interface ProvidedEnv {
		SPIKE_COUNTER: DurableObjectNamespace<SpikeCounter>;
	}
}
