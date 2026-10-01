# Security policy

## Supported versions

Only the latest release receives fixes. Please check that you are on it before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (private vulnerability reporting). Include:

- the plugin and Obsidian versions, and your platform (desktop OS or mobile);
- the beam block or the steps that trigger the problem;
- what an attacker could achieve.

This is a volunteer project. You can expect an acknowledgement within 7 days and a fix or a plan as soon as the problem is understood. Once a fix is released, the advisory is published with credit to you unless you prefer otherwise.

## Scope

In scope:

- **Markup or script injection from a note.** Beam blocks may come from notes you did not write (shared vaults, downloaded notes). Any way for block text to run script, inject HTML or SVG, or load a remote resource is a vulnerability.
- **Unintended file changes.** The plugin edits a note only when you insert a block or save one from the beam editor, and it refuses to write when the block changed in the meantime. Writing to the wrong place, overwriting other content or losing text is in scope.
- **Network activity.** The plugin makes no network requests. Any request it makes is a bug in scope.
- **Release integrity.** A release asset (`main.js`, `manifest.json`, `styles.css`) that does not match the source, or a weakness in the release workflow.
- **Denial of service** that freezes or crashes Obsidian from a beam block small enough to appear in a normal note.

Out of scope:

- Incorrect engineering results. Report these as ordinary bugs; they are treated as high priority, but they are not security issues. The plugin is an educational tool and its results must be verified before use in design.
- Vulnerabilities in Obsidian itself; report those to the Obsidian team.
- Attacks that require write access to your vault's `.obsidian/plugins` folder, since such an attacker can already run any code.
- Development-only tools in `scripts/` and the test suite, which are not shipped.

## Design measures

- All drawing uses DOM APIs (`createEl`, `createSvg`, `setText`); no HTML or SVG string is ever parsed. Scene attributes named `style`, `on*` or `href` are refused when an SVG is mounted.
- No `eval`, `new Function`, remote code or runtime dependencies.
- Lookups of user words in keyword tables use own properties only, so names such as `constructor` or `__proto__` cannot reach inherited object members.
- Releases are built by GitHub Actions from the tagged commit and carry a build provenance attestation. Verify one with:

  ```bash
  gh attestation verify main.js --repo lucasmcazelli/obsidian-beam-static-diagram
  ```
