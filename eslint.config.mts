import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'coverage',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'scripts',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'vitest.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// The sample config never lints manifest.json, so the manifest rules
		// (forbidden words, description format, allowed keys) would only be
		// checked at submission time. Lint it locally too.
		files: ['manifest.json'],
		languageOptions: { parser: tseslint.parser },
		plugins: { obsidianmd },
		rules: { 'obsidianmd/validate-manifest': 'error' },
	},
	{
		files: ['src/**/*.ts'],
		rules: {
			// Engineering unit symbols are not sentence-case violations.
			// ignoreWords ADDS to the defaults (brands/acronyms would replace them).
			// "E" and "I" are deliberately NOT listed: the community scanner runs
			// the stock config without these words, so local lint must flag the
			// same strings (write "elastic modulus" / "second moment of area").
			'obsidianmd/ui/sentence-case': [
				'warn',
				{
					enforceCamelCaseLower: true,
					ignoreWords: ['kN', 'kNm', 'kip', 'ksi', 'psi', 'MPa', 'GPa', 'kPa', 'Pa', 'N', 'mm', 'cm', 'm', 'ft', 'in', 'lb', 'EI', 'SI', 'L'],
				},
			],
		},
	},
	{
		// Tooling and tests run in Node, never inside Obsidian.
		files: ['vitest.config.mts', 'tests/**/*.ts'],
		rules: {
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
);
