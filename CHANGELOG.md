# Changelog

All notable changes to Beam Statics are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Release tags have no `v` prefix.

## [Unreleased]

## [0.1.0] - Unreleased

First public release.

### Added

- `beam` code blocks: a line-based language with `title`, `units`, `length`, `pin`, `roller`, `fixed`, `hinge`, `point`, `moment`, `udl`, `linear`, `material`, `E`, `I` and `section` statements, keyword aliases, position keywords (`start`, `mid`, `end`), order-independent statements and `#` / `//` comments.
- Units: SI (kN and m, N and mm) and US customary (kip and ft, lb and in) systems, with free mixing of units inside a block and exact conversion factors.
- Analysis of statically determinate and indeterminate beams: pin, roller and fixed supports, free ends and internal hinges, under point forces, point moments, uniform and linearly varying loads.
- A dependency-free direct stiffness solver with exact piecewise-polynomial shear, moment, slope and deflection, exact extreme values, and detection of unstable beams (mechanisms) by a rank test.
- SVG output: beam drawing with loads and reactions, shear force, bending moment and deflection diagrams, a results table with reactions, extreme values, the worst span-to-deflection ratio (per span and cantilever, rounded down) and maximum bending stress, and engineering warnings (uplift, no horizontal restraint, large deflection, deflection out of range, no loads yet).
- Drawing details: load labels on their own bands with leaders where they crowd, heavier point-load arrows, support letters on reaction labels (`A 18.67 kN`), ↺ / ↻ on couples, ", tension side" in the moment title when that convention is chosen, and a `--bsd-paper` colour token (set automatically inside callouts).
- The results table names the unit system in effect and flags the plugin default, and counts static determinacy for vertical loads ("vertical loads").
- Material presets (steel, stainless steel, aluminium, timber, concrete) and section shapes (rectangle, circle, tube, box, I-beam) with explicit `E` and `I` overrides.
- Error messages with line numbers, the offending line and "Did you mean" suggestions, plus specific hints for common notation habits (decimal commas, thousands separators, `× 10^5`, `L/2`, feet and inches, typographic dashes) and refusal of ambiguous units (`mN`, `mPa`, one-letter kip forms in SI blocks).
- Input limits (block size, number of supports, hinges and loads, length range) so that a pasted block cannot freeze Obsidian.
- Beam editor with form and text views, built-in examples and a live preview; commands **Insert beam diagram** and **Insert beam block template**; an edit button on every rendered block that writes changes back into the note. The editor asks before discarding unsaved changes, always saves a `units` line, and supports keyboard navigation of its tabs.
- Safe write-back: a block is only rewritten when it can be located unambiguously (by position, or by its exact text inside lists, blockquotes and embeds), and never when the new text could end the code block early.
- Settings: default units, decimal places, moment diagram orientation (sagging up or tension side), deflection diagram and results table toggles.
- Light and dark themes, mobile support, print and PDF export styles.
- Documentation: README, language reference, engine notes, publishing guide, and a browser preview page for development (`npm run preview`).

[Unreleased]: https://github.com/lucasmcazelli/obsidian-beam-static-diagram/compare/0.1.0...HEAD
[0.1.0]: https://github.com/lucasmcazelli/obsidian-beam-static-diagram/releases/tag/0.1.0
