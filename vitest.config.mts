import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Pure-logic tests run in Node: no DOM and no Obsidian runtime needed.
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		// The 'obsidian' npm package ships type definitions only (its "main" is
		// empty), so a runtime import fails outside the app. Point it at a tiny
		// hand-written stub for the rare test that touches UI glue code.
		alias: {
			obsidian: fileURLToPath(new URL('./tests/__mocks__/obsidian.ts', import.meta.url)),
		},
		coverage: {
			provider: 'v8',
			include: ['src/core/**/*.ts', 'src/render/**/*.ts'],
			reporter: ['text', 'html'],
		},
	},
});
