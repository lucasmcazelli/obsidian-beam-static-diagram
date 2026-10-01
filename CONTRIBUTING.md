# Contributing to Beam Statics

Thanks for helping. The most valuable contribution is a bug report with the exact beam block that misbehaves, what you expected (ideally with a textbook reference or a hand calculation) and what the plugin showed. Wrong numbers are treated as the most serious kind of bug.

## Setup

Requires Node.js 22.12 or later.

This follows the official [Build a plugin](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin) guide. Use a separate **test vault**, never your real one: a plugin bug can change notes.

```bash
cd path/to/test-vault/.obsidian/plugins
# The folder name must match the plugin id in manifest.json ("beam-statics"),
# not the repository name.
git clone https://github.com/lucasmcazelli/obsidian-beam-static-diagram.git beam-statics
cd beam-statics
npm ci
npm run dev
```

`npm run dev` rebuilds `main.js` on every change. In Obsidian, open **Settings > Community plugins**, turn on community plugins and enable **Beam Statics**. After each build, toggle the plugin off and on, run **Reload app without saving** from the command palette, or install the [Hot-Reload](https://github.com/pjeby/hot-reload) plugin to reload automatically. Restart Obsidian after editing `manifest.json`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Watch build with inline source maps |
| `npm test` | All unit tests (vitest), about 3 seconds |
| `npx vitest run tests/parser.test.ts` | One test file |
| `npm run lint` | ESLint with `eslint-plugin-obsidianmd`; CI adds `--max-warnings=0` |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `tests/` |
| `npm run build` | Type-check and production build of `main.js` |
| `npm run preview` | Writes `preview/index.html` (see [Preview page](#preview-page)) |
| `npm run coverage` | The test suite with coverage of all of `src/`; fails below the thresholds in `vitest.config.mts` (CI runs this) |

## Architecture

```
text --parser--> BeamAst --model--> BeamModel --solver--> BeamResults --render--> Scene --mount--> SVG
       (syntax)          (units, SI,          (DSM + exact            (DOM-free         (createSvg,
                          validation)          polynomials)            primitives)       setText)
```

| Folder | Role | May import `obsidian`? |
| --- | --- | --- |
| `src/core/` | Language and engine: `parser`, `units`, `model`, `materials`, `sections`, `stability`, `linalg`, `polynomial`, `solver`, `diagrams`, `analyze`, `serializer`, `examples`, `lookup`, `scale` (force scale), `tolerances` (shared tolerances), and the shared contract `types.ts` | **No**, and no DOM |
| `src/render/` | Scene builders: `beam-scene` (beam drawing), `chart-scene` (V, M, v diagrams), `draw` and `scene` (helpers, layout), `svg-string` (tests and tooling only) | **No**, and no DOM |
| `src/ui/` | Obsidian glue: `beam-block` (code block renderer), `beam-view` (block output), `mount` (scene to SVG), `editor-modal` (beam editor), `write-back` (saving into the note) | Yes |
| `src/main.ts`, `src/settings.ts` | Plugin entry point, commands, settings tab | Yes |
| `tests/` | vitest suites; `tests/__mocks__/obsidian.ts` is the runtime stub of the API | |
| `scripts/` | Development tools: `oracle/beam_exact.py` (exact reference solver), `preview/` (browser preview). Not part of the plugin build. | |

`docs/how-it-works.md` explains the engine step by step; `src/core/types.ts` documents the internal sign convention at the top.

## Rules

1. **`src/core` and `src/render` stay pure.** They never import `obsidian` and never touch the DOM, so they run in plain Node and can be unit tested. Only `src/ui`, `src/main.ts` and `src/settings.ts` talk to Obsidian.
2. **No markup strings.** Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `DOMParser` or `document.write`. Build DOM with Obsidian's helpers (`createDiv`, `createEl`, `createSvg`) and `setText`. The community directory scanner treats violations as errors.
3. **No network, telemetry or Node/Electron APIs.** The plugin must work offline and on mobile (`isDesktopOnly: false`).
4. **No runtime dependencies.** Everything ships in `main.js`. Dev dependencies are fine; `esbuild` stays pinned to an exact version for reproducible builds.
5. **Colours live in `styles.css`.** Scenes emit only `bsd-*` class names, never colours or inline styles, and `styles.css` maps them to Obsidian theme variables. `tests/integration.test.ts` fails if a class is emitted but not styled, or styled but never emitted.
6. **`analyzeBeam` never throws.** A user mistake becomes a `Diagnostic` with a line number when there is one. Messages are sentence case, say what is wrong and show how to fix it ("Moment needs a direction: cw or ccw", "Add a length, for example: length 6 m").
7. **One sign convention.** Everything below the model uses the convention in `src/core/types.ts` (forces and q up, couples counter-clockwise, sagging moment positive, deflection up). Convert only at the edges: in `model.ts` from words, in the renderer and results table back to words and arrows.
8. **UI text is sentence case** (`obsidianmd/ui/sentence-case`). Engineering unit symbols are allowed in `eslint.config.mts`.
9. **No em dash character** (U+2014) anywhere: code, comments, docs or UI text. Use a colon, a comma, parentheses or a plain hyphen.

### Comment style

- Every file starts with a block comment saying what it does and how it fits in the pipeline.
- Every exported function, type and constant has a JSDoc comment. State units (`[m]`, `[N·m]`), signs ("positive up") and what happens on bad input.
- Explain **why**, not what: the reason for a tolerance, the source of a formula, the bug a check prevents. Write formulas out (`M(s) = ...`) where the code implements one.
- Name magic numbers as constants with a comment (`/** Deflections above L/50 ... */ const LARGE_DEFLECTION_RATIO = 50;`).

### Tests

- Every bug fix comes with a test that fails without it.
- Every feature comes with tests at each layer it touches: parser, model, solver, render, UI.
- Engineering results are checked against closed-form solutions. New benchmark values go in `tests/fixtures/benchmarks.json` and are cross-checked with `scripts/oracle/beam_exact.py` (`python3` with no extra packages; note that it uses clockwise-positive couples internally).
- The random-beam property tests in `tests/solver.properties.test.ts` must keep passing; extend their generator when you add a load or support type.

## Adding a load type

Most new loads can be expressed with the existing model types (`PointLoad`, `MomentLoad`, `DistributedLoad`); then only the language layer changes. A genuinely new kind of load touches every layer:

1. **`src/core/types.ts`**: add the AST interface (raw strings plus `line`) to `AstLoad`, and, if needed, a model type to `Load`, documenting its sign.
2. **`src/core/parser.ts`**: add the keyword and aliases to `KEYWORDS`, extend `StatementType`, and parse it in `parseStatement` with `readQuantity` and `readLoadClauses`. Give every error an example of correct input.
3. **`src/core/analyze.ts`**: add the statement to `STATEMENT_CATEGORIES` (the compiler insists).
4. **`src/core/model.ts`**: convert to SI and the internal signs, and validate positions and values.
5. **`src/core/serializer.ts`**: write it back so that parse, serialize, parse gives the same AST.
6. **`src/core/solver.ts`**: consistent nodal loads in `runStiffness`, its contribution to V and M in `buildSegments`, and its resultant in `equilibriumResidual` and `totalLoad`; also `forceScale` in `src/core/scale.ts`.
7. **`src/render/beam-scene.ts`**: draw it, label it and give it a tooltip; style any new class in `styles.css`.
8. **`src/ui/editor-modal.ts`**: a form row, a label in `LOAD_KIND_LABELS`, and conversion in `changeLoadKind`.
9. **Docs**: the statement table in `README.md`, a section in `docs/syntax.md`, the formulas in `docs/how-it-works.md`, and a `CHANGELOG.md` entry.
10. **Tests** for every step above, including a closed-form benchmark.

## Adding a unit

1. Add a row to `UNIT_ROWS` in `src/core/units.ts`: `[class, factor to SI, [spellings]]`. Write the factor as an exact literal (see the US constants), and for an SI submultiple let the table derive an exact divisor.
2. Check the normalised spelling (`unitKey`: lower case, separators removed) does not collide with an existing unit. Matching is case-insensitive, so `mN` and `MN` share a key; `parseQuantity` refuses `mN` and `mPa` explicitly for that reason, and refuses the one-letter kip forms in SI blocks. A new ambiguous spelling needs the same treatment.
3. If the unit becomes the default or display unit of a system, update `UNIT_SYSTEMS` and, when the hint text should mention it, `UNIT_HINTS`.
4. Add parsing and conversion tests in `tests/units.test.ts`.
5. Update the unit tables in `README.md` and `docs/syntax.md`.

A new **unit system** also needs a `UnitSystemId`, an entry in `UNIT_SYSTEMS` and in `UNIT_SYSTEM_ALIASES`, and example `E` and `I` statements in `model.ts`. The settings dropdown and the editor pick it up automatically.

## Preview page

`npm run preview` bundles the real renderer (`src/ui/beam-view.ts`) for a normal browser and writes `preview/index.html` (git-ignored). Open it from disk: it shows every built-in example in the light and dark themes and a text box that redraws as you type, with controls for width, units, decimals, the moment convention and the optional parts. Use it to check drawing changes quickly, at phone widths too, without restarting Obsidian.

How it works: `scripts/preview/build.mjs` bundles `scripts/preview/entry.ts` with esbuild, replaces the `obsidian` module with an empty shim (`obsidian-shim.ts`), installs Obsidian's DOM helpers (`polyfill.ts`), and inlines `styles.css` plus stand-in theme colours (`theme.css`). The theme colours approximate Obsidian's defaults, so always confirm a visual change in Obsidian too.

**Screenshot mode** renders a single panel with no page chrome, for README images:

```
preview/index.html?example=simply-supported&theme=light&width=760
```

`example` is an example id from `src/core/examples.ts` (or `playground`), `theme` is `light` or `dark`, and `moment=tension-side` or `units=kip-ft` change those settings. The README images are element screenshots of `#shot` taken with a headless Chromium (for example Playwright) at a device scale factor of 2.

## Before opening a pull request

- [ ] `npm run lint -- --max-warnings=0`, `npm test` and `npm run build` pass.
- [ ] New behaviour has tests; fixed bugs have regression tests.
- [ ] Drawings checked with `npm run preview` in both themes and at a narrow width, if the change affects rendering.
- [ ] Docs updated (`README.md`, `docs/`), and an entry added under **Unreleased** in `CHANGELOG.md`.
- [ ] No `obsidian` import in `src/core` or `src/render`, no markup strings, no em dash characters.

Keep pull requests focused on one change, and write commit messages in the imperative mood ("Add spring supports", "Fix hinge next to a roller").

By contributing you agree that your contribution is licensed under the [MIT License](./LICENSE).
