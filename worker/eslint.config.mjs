import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';

export default tseslint.config(
	{ ignores: ['worker-configuration.d.ts'] },
	eslint.configs.recommended,
	tseslint.configs.recommendedTypeChecked,
	{
		/**
		 * Anything under src/ ships. Importing a devDependency from here builds
		 * and deploys perfectly well (esbuild resolves from node_modules and
		 * ignores which package.json section declared it), so the mistake is
		 * silent until a production-only install fails. This rule turns
		 * "remember to promote the dependency" into a lint failure at exactly
		 * the moment it matters. Tests and config files are unrestricted.
		 */
		files: ['src/**/*.ts'],
		plugins: { 'import-x': importX },
		rules: {
			'import-x/no-extraneous-dependencies': ['error', { devDependencies: false, peerDependencies: false }],
		},
	},
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		// Config files themselves aren't part of a tsconfig project
		files: ['*.mjs', '*.mts'],
		extends: [tseslint.configs.disableTypeChecked],
	},
);
