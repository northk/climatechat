declare module 'cloudflare:test' {
	// Must be an interface (not a type alias) for declaration merging with cloudflare:test
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface ProvidedEnv extends Env {}
}
