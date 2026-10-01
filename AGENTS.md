# AGENTS.md

Guidance for AI coding agents working on this repository. Humans: see [CONTRIBUTING.md](./CONTRIBUTING.md), which this file summarises.

## Project

Beam Statics is an Obsidian community plugin (TypeScript, bundled by esbuild to `main.js`). Users write a ```` ```beam ```` code block or use a modal editor; the plugin parses it, solves the beam (direct stiffness method plus exact piecewise polynomials) and draws SVG diagrams with a results table. Everything runs locally, offline, on desktop and mobile.

- Plugin id `beam-statics`, `minAppVersion` 1.13.0 (declarative settings API), `isDesktopOnly: false`.
- No runtime dependencies. Node.js 22.12 or later for development.

## Commands

```bash
npm ci                                  # install (lockfile is committed; do not switch package managers)
npm run dev                             # watch build
npx vitest run [tests/<file>.test.ts]   # tests, all or one file
npx tsc --noEmit                        # type-check src/ and tests/
npx eslint . --max-warnings=0           # lint exactly as CI does
npm run build                           # type-check and production build
npm run preview                         # browser preview at preview/index.html
```

Run lint, tests and build before declaring a change done. CI (`.github/workflows/ci.yml`) runs lint, the tests with coverage thresholds (`npm run coverage`, configured in `vitest.config.mts`) and the build on Node 22 and 24.

## Architecture

```
text -> parser -> BeamAst -> model -> BeamModel -> solver -> BeamResults -> render -> Scene -> mount -> SVG
```

- `src/core/`: language and engine, pure TypeScript. `types.ts` is the shared contract and documents the internal sign convention at the top.
- `src/render/`: DOM-free scene builders that emit primitives with `bsd-*` classes.
- `src/ui/`, `src/main.ts`, `src/settings.ts`: the only code that imports `obsidian`.
- `tests/`: vitest; `tests/__mocks__/obsidian.ts` stubs the API at runtime.
- `scripts/`: dev tools (exact oracle solver, preview page). Not part of the plugin build, ignored by lint and by the directory scanner.
- `main.js` is a build output and is git-ignored. Never commit it.

Engine details: [docs/how-it-works.md](./docs/how-it-works.md). Language: [docs/syntax.md](./docs/syntax.md).

## Hard rules

- `src/core` and `src/render` must not import `obsidian` or use the DOM.
- No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `DOMParser`, `document.write`, `eval` or `new Function`. Build DOM with `createEl` / `createDiv` / `createSvg` and `setText`.
- No regex lookbehind (`(?<=`, `(?<!`): it breaks older iOS WebViews and is an error in the directory scanner.
- No network requests, telemetry, Node built-ins or Electron APIs in `src/`.
- No inline styles or colours in scenes; colours live in `styles.css` as `--bsd-*` tokens mapped to Obsidian theme variables. Every emitted class must be styled (a test checks both directions).
- `analyzeBeam` must never throw: user errors become diagnostics with line numbers and a hint of the correct input.
- Keep the internal sign convention of `types.ts` (forces and q positive up, couples counter-clockwise, sagging moment positive, deflection up). Convert only in `model.ts` and in the renderer.
- UI text is sentence case. Do not add default hotkeys to commands.
- Never use the em dash character (U+2014) in code, comments, docs or UI text.

## Community directory constraints

The plugin is published through community.obsidian.md, which scans every release (details in [docs/publishing.md](./docs/publishing.md)):

- Source is linted with `eslint-plugin-obsidianmd` recommended rules, security rules at error. Local lint uses the same config and is stricter (`--max-warnings=0`), so keep it clean.
- The scanner rebuilds with `npm run build` and compares the output with the released `main.js`. Keep `package-lock.json`, keep `esbuild` pinned to an exact version, and never put timestamps or other changing values in the build banner.
- `manifest.json` rules are linted (`obsidianmd/validate-manifest`). Do not change the plugin `id`. Do not put "obsidian" or "plugin" in the id or name.
- Versions change only through `npm version patch|minor|major`, which updates `manifest.json` and `versions.json` and tags without a `v` prefix.

## Conventions

- Every file starts with a block comment explaining its role; every export has JSDoc with units and signs. Comments explain why. Name numeric thresholds as documented constants.
- Tests accompany every change: regression tests for bug fixes; parser, model, solver and render tests for features; closed-form values for anything numerical (fixtures in `tests/fixtures/benchmarks.json`, cross-checked with `scripts/oracle/beam_exact.py`, which uses clockwise-positive couples).
- Error messages say what is wrong and show a correct example: `Add a length, for example: length 6 m`.
- Prefer small, focused changes. Do not reformat unrelated code.
- When you change the language, units, settings or behaviour, update `README.md`, `docs/syntax.md` and `CHANGELOG.md` (under Unreleased) in the same change, and verify every `beam` example in the docs still analyses without errors.

## Common tasks

- Add a load type or a unit: step-by-step lists in [CONTRIBUTING.md](./CONTRIBUTING.md#adding-a-load-type).
- Change a drawing: edit `src/render/*`, run `npm run preview`, check both themes and a narrow width.
- Add a setting: `src/settings.ts` (interface, `DEFAULT_SETTINGS`, `normalizeSettings`, `getSettingDefinitions`), then document it in the README settings table.

## References

- Obsidian developer docs: https://docs.obsidian.md
- Obsidian API types: the `obsidian` package in `node_modules/obsidian/obsidian.d.ts`
- Lint rules: https://github.com/obsidianmd/eslint-plugin
- Sample plugin this repo started from: https://github.com/obsidianmd/obsidian-sample-plugin
