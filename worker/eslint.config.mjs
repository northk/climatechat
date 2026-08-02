import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['worker-configuration.d.ts'] },
	eslint.configs.recommended,
	tseslint.configs.recommendedTypeChecked,
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
