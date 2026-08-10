/**
 * Secrets are set via `wrangler secret put` (production) or `.dev.vars`
 * (local dev), so they don't appear in wrangler.jsonc and the generated
 * worker-configuration.d.ts doesn't know them. Global interface merging
 * adds them to Env here.
 *
 * ANTHROPIC_API_KEY lives ONLY in the Worker (R3) — never in the iOS
 * app in any form. APP_SECRET is the shared client-verification header
 * value (R10) — also present, gitignored, on the iOS side.
 */
interface Env {
	ANTHROPIC_API_KEY: string;
	APP_SECRET: string;
}
