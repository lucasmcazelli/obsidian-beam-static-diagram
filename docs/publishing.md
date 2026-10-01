# Releasing and publishing

How to cut a release of Beam Statics and how the plugin gets into (and stays in) the Obsidian community directory. Written for the process as it stands in October 2026; check the official developer documentation if a step no longer matches.

## Contents

- [How publishing works in 2026](#how-publishing-works-in-2026)
- [The automated review](#the-automated-review)
- [One-time setup](#one-time-setup)
- [Cutting a release](#cutting-a-release)
- [Submitting the plugin](#submitting-the-plugin)
- [Manifest rules](#manifest-rules)
- [Listing screenshots](#listing-screenshots)
- [Beta testing with BRAT](#beta-testing-with-brat)
- [Pre-submission checklist](#pre-submission-checklist)

## How publishing works in 2026

- Plugins are submitted and managed at **[community.obsidian.md](https://community.obsidian.md)**, the community directory and developer dashboard launched in May 2026.
- The old process (a pull request adding an entry to `community-plugins.json` in `obsidianmd/obsidian-releases`) was **retired in May 2026**. Do not open such a pull request, and ignore older guides and workflows that validate one.
- Every GitHub release is scanned by an **automated review**, not only the first submission. Users see the result as a scorecard on the plugin's page.

## The automated review

Each release is checked in four sections:

| Section | What it looks at |
| --- | --- |
| Manifest | `manifest.json` fields and rules (id, name, description, versions) |
| Releases | the GitHub release: tag, version match, required assets |
| Source code | the repository source, linted with `eslint-plugin-obsidianmd` (recommended config) |
| Build verification | rebuilds the plugin from source and compares the result with the released `main.js` |

Every finding is rated **Error**, **Warning**, **Recommendation** or **Pass**. **Errors block installation** of that version, so treat any error as a release blocker.

**Source code rules.** The scanner runs the `recommended` config of `eslint-plugin-obsidianmd` with its security rules raised to **error**: `no-eval`, `no-implied-eval`, `no-unsanitized/*` (no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` with dynamic content), `regex-lookbehind` (lookbehind assertions break older iOS WebViews), and `no-forbidden-elements`. Paths that are not part of the plugin are ignored, including `tests`, `scripts`, `docs` and `*.mjs` tooling files. This repository runs the same recommended config locally and in CI with `--max-warnings=0`, which is stricter than the scanner, so a clean `npm run lint` is the best predictor of a clean review.

**Build verification.** The scanner runs the first script it finds among `build`, `build:plugin` and `compile` (here: `build`) and checks that the output matches the released `main.js`. A mismatch means the release cannot be verified. To keep the build reproducible:

- keep `package-lock.json` committed and install with `npm ci`;
- pin `esbuild` to an **exact** version in `package.json` (currently `0.28.2`, no `^`), because different esbuild versions emit different bytes;
- keep the banner in `esbuild.config.mjs` free of timestamps, version numbers or anything else that changes between builds;
- build releases only from the tagged commit, through the Release workflow, never from a local working copy.

You can check reproducibility yourself on a clean checkout of a tag:

```bash
git clone --branch 0.1.0 https://github.com/lucasmcazelli/obsidian-beam-static-diagram.git check
cd check && npm ci && npm run build && sha256sum main.js
# compare with the main.js attached to the 0.1.0 release
```

**Review branch.** The dashboard can run the same review on a branch before you release ("Review branch"). Use it on the release branch before tagging, so problems show up before users can see them.

## One-time setup

1. **Workflow permissions.** In the GitHub repository: **Settings > Actions > General > Workflow permissions > Read and write permissions**. The Release workflow needs it to create the draft release.
2. **Notifications.** In the community dashboard, enable **Action required notifications** so you hear about a review error on a new release (or a policy change that affects the plugin) without checking the page.
3. **Node.js** 22.12 or later locally (`.github/workflows/release.yml` builds with Node 24).

## Cutting a release

The version lives in three places that must agree: `package.json`, `manifest.json` and `versions.json` (which maps each plugin version to its `minAppVersion`). `npm version` keeps them in sync.

1. Make sure `main` is green in CI and the CHANGELOG has an entry for the new version.
2. Bump the version:

   ```bash
   npm version patch   # or minor, or major
   ```

   This runs `version-bump.mjs`, which writes the new version into `manifest.json` and adds it to `versions.json`, commits, and creates a git tag **without** a `v` prefix (for example `0.1.1`, set by `tag-version-prefix=""` in `.npmrc`). Obsidian requires the tag to equal the manifest version exactly.
3. Push the commit and the tag:

   ```bash
   git push --follow-tags
   ```

4. The **Release** workflow (`.github/workflows/release.yml`) checks that the tag matches `manifest.json`, runs lint, tests and the production build, creates a **build provenance attestation** for `main.js`, `manifest.json` and `styles.css`, and opens a **draft** GitHub release with those three files attached individually.
5. Open the draft on GitHub, write the release notes (copy them from the CHANGELOG), and **publish** it. The automated review runs on the published release.

Anyone can verify that a release asset was built by this repository's workflow:

```bash
gh attestation verify main.js --repo lucasmcazelli/obsidian-beam-static-diagram
```

To raise `minAppVersion`, edit `manifest.json` **before** running `npm version`, so the new entry in `versions.json` records it.

## Submitting the plugin

Done once, after the first release is published:

1. Sign in at [community.obsidian.md](https://community.obsidian.md) with your Obsidian account.
2. Link your GitHub account.
3. Go to **Plugins > New plugin**.
4. Enter the repository URL: `https://github.com/lucasmcazelli/obsidian-beam-static-diagram`.
5. Read and agree to the developer policies, then submit.

The automated review runs on the latest release. Fix any **Error** by publishing a new release; warnings and recommendations are worth fixing too, since they show on the scorecard.

## Manifest rules

`manifest.json` is checked locally by the `obsidianmd/validate-manifest` lint rule (see `eslint.config.mts`) and again by the review.

- **id**: lower-case letters and hyphens (`beam-statics`). It must not contain `obsidian` and must not contain `plugin`. It must match the plugin folder name and **never changes** after publication, since vaults store settings under it.
- **name**: `Beam Statics`. No `Obsidian`, and no `Plugin` suffix.
- **description**: one sentence that starts with a verb and says what the plugin does, ends with a period, stays short (well under 250 characters), and does not start with "This plugin" or mention Obsidian. Current text: "Draw beams from a simple text block and compute support reactions, shear force, bending moment and deflection diagrams."
- **version**: semantic version `x.y.z`, equal to the release tag.
- **minAppVersion**: the oldest Obsidian version the plugin supports (`1.13.0`, needed for declarative settings).
- **isDesktopOnly**: `false`. The plugin uses no Node or Electron APIs and must keep working on mobile.
- **author**, **authorUrl**; add **fundingUrl** only if there is a real funding page.

## Listing screenshots

The directory page can show up to **5 desktop screenshots at 1200 x 800** and up to **5 mobile screenshots at 900 x 1600**. Take them in Obsidian itself, in a clean demo vault with the default theme, so they show the real app around the plugin. Good candidates:

1. A note with a rendered block (the simply supported example) in light mode.
2. The same note in dark mode.
3. The beam editor, showing the form and the live preview.
4. A continuous beam or a beam with a hinge, showing the results table.
5. An error message with line numbers, to show the friendly feedback.

The images in `images/` (used by the README) are rendered outside Obsidian with `npm run preview` and the scripts described in [CONTRIBUTING.md](../CONTRIBUTING.md); they are not the right size for the listing.

## Beta testing with BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs a plugin straight from its GitHub releases, which is the usual way to test before (or alongside) the directory:

1. Publish a release as above. BRAT can also install a GitHub release marked as a pre-release, which keeps a beta away from regular users.
2. Testers install BRAT, choose **Add beta plugin**, and enter `lucasmcazelli/obsidian-beam-static-diagram`.
3. BRAT updates testers automatically when a newer release appears.

## Pre-submission checklist

Code and build

- [ ] `npm ci` on a clean checkout, then `npm run lint -- --max-warnings=0`, `npm test` and `npm run build` all pass.
- [ ] No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval`, `new Function` or regex lookbehind in `src/`.
- [ ] No network requests, telemetry or Node/Electron APIs (`isDesktopOnly` is `false`).
- [ ] `esbuild` is pinned exactly, `package-lock.json` is committed, and the build banner contains nothing that changes between builds.
- [ ] A clean build of the tag gives a `main.js` identical to the release asset.

Manifest and release

- [ ] `manifest.json`, `package.json` and `versions.json` agree on the version; `minAppVersion` is right.
- [ ] The id, name and description follow the [manifest rules](#manifest-rules) (`npm run lint` checks them).
- [ ] The git tag equals the version, with no `v`.
- [ ] The GitHub release is **published** (not a draft) and has `main.js`, `manifest.json` and `styles.css` attached as separate files.

Behaviour

- [ ] Tested in a fresh vault with only this plugin enabled, on desktop and on a phone, in light and dark themes.
- [ ] Every example from the editor's **Start from example** menu renders without errors.
- [ ] Settings changes redraw open blocks; disabling the plugin leaves no errors in the console.
- [ ] Editing a block through the pencil button updates the right block, and refuses (with a message) when the note changed in the meantime.
- [ ] Two behaviours are covered only by mocked tests and must be checked by hand in a real vault: (1) in Reading view, editing a beam inside a list item, a blockquote or a callout (where Obsidian reports the whole list or quote as the block's section) updates exactly that beam; (2) disabling the plugin with a note open removes the pencil buttons and stops the redraws (blocks are retired on unload), and re-enabling redraws them.

Documentation and listing

- [ ] README explains what the plugin does, how to use it, its limitations, and states that it makes no network requests; images use relative `./images/...` paths.
- [ ] `LICENSE` is present; `CHANGELOG.md` has the new version.
- [ ] Listing screenshots are ready (up to 5 desktop at 1200 x 800, 5 mobile at 900 x 1600).
- [ ] Workflow permissions are set to read and write, and **Action required notifications** are on.
- [ ] Developer policies have been read and the plugin complies.
