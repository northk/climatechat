declare module 'cloudflare:test' {
	// Must be an interface (not a type alias) for declaration merging with cloudflare:test
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface ProvidedEnv extends Env {}
}

// Vite ?raw imports used for test fixtures (workerd has no node:fs)
declare module '*.csv?raw' {
	const content: string;
	export default content;
}
declare module '*.json?raw' {
	const content: string;
	export default content;
}
declare module '*.dat?raw' {
	const content: string;
	export default content;
}
