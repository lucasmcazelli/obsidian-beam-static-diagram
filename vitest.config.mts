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
			// The whole plugin, UI glue included (tests/ui-smoke.test.ts drives it in happy-dom).
			include: ['src/**/*.ts'],
			reporter: ['text', 'html'],
			// Floors a little below the current figures (about 98% statements, 91.5% branches,
			// 99.5% functions, 99.4% lines), so CI fails when new code lands without tests.
			thresholds: {
				statements: 97,
				branches: 90,
				functions: 98,
				lines: 98,
			},
		},
	},
});
