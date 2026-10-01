# How the engine works

This page explains, for contributors, how a `beam` block becomes numbers and drawings. It follows the code in `src/core` and `src/render`; file and function names are given so you can jump straight to the source. Every formula here is implemented as written.

## Contents

- [Pipeline](#pipeline)
- [Sign convention](#sign-convention)
- [Units](#units)
- [Step 1: key points](#step-1-key-points)
- [Step 2: stability and determinacy](#step-2-stability-and-determinacy)
- [Step 3: direct stiffness method](#step-3-direct-stiffness-method)
- [Step 4: reactions and the equilibrium check](#step-4-reactions-and-the-equilibrium-check)
- [Step 5: exact shear and moment by statics](#step-5-exact-shear-and-moment-by-statics)
- [Step 6: slope and deflection](#step-6-slope-and-deflection)
- [Step 7: extrema, stress and shear zeros](#step-7-extrema-stress-and-shear-zeros)
- [Engineering warnings](#engineering-warnings)
- [Tolerances](#tolerances)
- [Rendering](#rendering)
- [Validation](#validation)

## Pipeline

```
text --parseBeamSource--> BeamAst --buildModel--> BeamModel --solveBeam--> BeamResults --scene builders--> Scene --mountScene--> SVG
```

| Stage | File | Input to output | Notes |
| --- | --- | --- | --- |
| Parse | `src/core/parser.ts` | text to `BeamAst` | Syntax only. Numbers and units stay raw strings. At most one error per line. Never throws. |
| Model | `src/core/model.ts` | `BeamAst` to `BeamModel` | Resolves units and positions to SI, converts directions to signs, checks rules that span lines (positions on the beam, duplicate supports, hinge placement). |
| Classify | `src/core/stability.ts` | `BeamModel` to `Classification` | Rejects mechanisms before any matrix is built; gives the degree of indeterminacy. |
| Solve | `src/core/solver.ts` | `BeamModel` to `BeamResults` | Reactions by the direct stiffness method, then exact piecewise polynomials for V, M, slope and deflection. |
| Extrema | `src/core/diagrams.ts` | segments to `Extrema` | Exact maxima from derivative roots; plotting samples. |
| Orchestrate | `src/core/analyze.ts` | text to `AnalysisOutput` | Runs everything, adds engineering warnings, and turns any exception into a diagnostic. `analyzeBeam` never throws. |
| Draw | `src/render/*.ts` | `BeamResults` to `Scene` | DOM-free lists of SVG primitives. |
| Mount | `src/ui/mount.ts` | `Scene` to `<svg>` | Uses Obsidian's `createSvg` and `setText`; no markup strings. |

The shared types and the sign convention live in `src/core/types.ts`. Nothing in `src/core` or `src/render` imports `obsidian` or touches the DOM, so the whole engine runs in plain Node under vitest.

## Sign convention

Internally (from the header of `src/core/types.ts`):

| Symbol | Meaning | Positive |
| --- | --- | --- |
| x | position from the left end [m] | to the right |
| F, fy | forces, including reactions [N] | **up** (gravity loads are negative) |
| q(x) | distributed load [N/m] | **up** |
| C, mz | applied and reaction couples [N·m] | **counter-clockwise** |
| V(x) | shear: sum of the upward forces **left** of the section [N] | textbook positive shear |
| M(x) | bending moment [N·m] | **sagging** (bottom fibre in tension) |
| v(x) | deflection [m] | **up** |
| θ(x) = dv/dx | slope [rad] | counter-clockwise |

Relations: dV/dx = q, dM/dx = V, EI·v'' = M. A counter-clockwise applied couple makes M jump **down** by its value (reading left to right).

The words a user types are converted in `buildModel`:

```
point  F down -> fy = -F        point  F up  -> fy = +F
moment C ccw  -> mz = +C        moment C cw  -> mz = -C
udl / linear w down -> q = -w   udl / linear w up -> q = +w
```

so a negative magnitude flips the direction. The renderer and the results table translate back: reactions as magnitudes with arrows, deflections as magnitudes with "down" or "up", moments with their sign.

Note that the independent oracle script (`scripts/oracle/beam_exact.py`) uses **clockwise-positive** couples internally; its docstring says so. Convert when comparing.

## Units

Everything inside the model is in SI base units: m, N, N·m, N/m, Pa, m⁴. `src/core/units.ts` is the only module that knows other units.

- Unit symbols are looked up through a normalised key: lower case, superscripts become digits, and `^`, spaces and product separators (`·`, `⋅`, `•`, `*`, `-`, `.`) are removed. Slashes are kept, so `kN/m` and `kNm` stay different.
- US factors are written as literals of the exact international definitions (1 in = 0.0254 m, 1 lbf = 4.4482216152605 N), so that, for example, 1 kip·ft is the double nearest to its exact value.
- SI submultiples (mm, cm⁴, ...) are converted by **dividing** by an integer (`UnitDef.divisor`) instead of multiplying by an inexact binary fraction, so 1500 mm becomes exactly 1.5 m.
- A bare number takes the default unit of the active system for that dimension (`UNIT_SYSTEMS[system].symbols[dimension]`). `E` and `I` require a unit.

## Step 1: key points

`prepare()` in `solver.ts` collects the **key points**: both ends, every support, hinge, point load, couple and distributed-load end. Positions closer than `1e-9·L` are merged, so near-coincident items never create zero-length pieces. Ends, supports and hinges are placed first and keep their exact coordinates; load positions then snap onto them. Between two consecutive key points every result is a single smooth polynomial: a **segment**.

## Step 2: stability and determinacy

Counting rules (reactions - 2 - hinges) are not reliable: a pin at 0, rollers at 2 and 4 and a hinge at 5 on a 6 m beam "counts" as determinate, yet the part right of the hinge swings freely. `classifyBeam()` in `stability.ts` tests the rigid-body motions directly.

Hinges split the beam into parts k = 0..n. Without bending, part k can only translate and rotate:

```
v_k(x) = v0_k + th_k · (x / L)
```

two unknowns per part (dividing by L keeps every matrix entry between -1 and 1 whatever the length). Each restraint adds a row to a constraint matrix A (columns: v0_0, th_0, v0_1, th_1, ...):

| Item | Row(s) |
| --- | --- |
| pin or roller at x, in part k | v_k(x) = 0 |
| fixed at x, in part k | v_k(x) = 0 and th_k = 0 |
| hinge at xh between parts k and k+1 | v_k(xh) - v_{k+1}(xh) = 0 |

A support exactly on a hinge belongs to the part on its left (the hinge row then pins the right part there too); a fixed support on a hinge clamps both sides.

The beam is **stable** when the only admissible motion is zero, that is when `rank(A) = 2·parts`. The rank uses Gaussian elimination with partial pivoting and an absolute pivot tolerance of `1e-9`, which is meaningful because the entries are 0, ±1 or ±x/L. The **degree of indeterminacy** is `rows - 2·parts` for a stable beam. The check depends neither on the loads nor on EI.

## Step 3: direct stiffness method

`runStiffness()` in `solver.ts`.

**Nodes and degrees of freedom.** Nodes sit only at the beam ends, supports and hinges, never at load points: a load very close to a support would otherwise create a tiny, badly conditioned element. Each node has a deflection DOF v and a rotation DOF θ. At a hinge node the rotation is split into θL (seen by the element on the left) and θR (seen by the element on the right), which is exactly a moment release.

**Element stiffness.** For an Euler-Bernoulli element of length Le, DOFs [v1, θ1, v2, θ2]:

```
            [  12     6Le    -12     6Le  ]
  k = EI/Le³[  6Le    4Le²   -6Le    2Le² ]
            [ -12    -6Le     12    -6Le  ]
            [  6Le    2Le²   -6Le    4Le² ]
```

The system is assembled and solved with **EI = 1**. For a prismatic beam without springs or settlements the reactions, V and M do not depend on EI and the displacements scale exactly with 1/EI, so one solve serves both the force results and (after dividing by the real EI) the deflection. That is why reactions, shear and moment are available even when no material or section is given.

**Shape functions.** Hermite cubics at local position a, with ξ = a/Le:

```
N1 = 1 - 3ξ² + 2ξ³        N2 = Le·(ξ - 2ξ² + ξ³)
N3 = 3ξ² - 2ξ³            N4 = Le·(ξ³ - ξ²)
```

**Consistent nodal loads** (the work-equivalent loads of the element), with b = Le - a:

- Point force P at a: `f = P·N(a) = P·[ b²(3a + b)/Le³,  a·b²/Le²,  a²(a + 3b)/Le³,  -a²·b/Le² ]`
- Couple C (counter-clockwise) at a does work C·θ(a), so `f = C·N'(a) = C·[ -6ab/Le³,  b(b - 2a)/Le²,  6ab/Le³,  a(a - 2b)/Le² ]`
- Linearly varying load q(x) over the overlap [lo, hi] of the load and the element: `f_i = ∫ N_i(x)·q(x) dx`. N_i is cubic and q linear, so the degree-4 integrand is integrated **exactly** with 3-point Gauss-Legendre quadrature (exact up to degree 5). A load that starts or ends inside an element needs no extra node: over the overlap, q is a single straight line.

A point item exactly on a node is applied to the element on its right (the last element for x = L), so it is counted exactly once.

**Exactness.** For a prismatic Euler-Bernoulli element the Hermite cubics are exact solutions of the unloaded beam equation, so with consistent loads the **nodal** displacements are exact, not approximate, however few elements there are. Everything between nodes is then recovered exactly by statics (step 5), which is why the mesh never needs refining.

**Boundary conditions and solve.** Pins and rollers restrain v; fixed supports restrain v and θ (both θL and θR on a hinge node). The free-free partition `K_ff·u_f = F_f` is solved by `solveLinearSystem()` in `linalg.ts`: symmetric Jacobi scaling (`d_i = 1/sqrt(|A_ii|)`, so every non-zero diagonal becomes 1 and one dimensionless pivot tolerance suits a 1 cm beam and a 1 km beam alike), Gaussian elimination with partial pivoting, and a scaled pivot tolerance of `1e-10`. A singular matrix after a passed stability check means extreme geometry (two supports almost on top of each other) and is reported as such.

## Step 4: reactions and the equilibrium check

`collectReactions()` computes, at every restrained DOF d,

```
R_d = Σ_j K[d][j]·u[j] - F[d]
```

the force the support adds so that K·u = F + R. A fixed support's couple is the sum over its rotation DOF(s). Reactions smaller than `1e-12` times the total load are round-off and are set to exactly 0. If two supports merged into one node, the whole reaction is reported on the first one.

`equilibriumResidual()` then sums all vertical forces and all moments about x = 0 (distributed loads through their exact resultant and first moment). `checkResidual()` refuses to answer when either residual exceeds `1e-6` of the forces involved (applied loads plus reactions); healthy beams sit near `1e-15`. Only extreme geometry, such as a hinge a few micrometres from a support, gets close, and the user then sees "supports or hinges are too close together" instead of wrong numbers.

## Step 5: exact shear and moment by statics

With the reactions known the beam is statically determinate. `buildSegments()` cuts the beam at x = x0 + s inside each segment [x0, x1] and sums everything on the left (method of sections). All polynomials use the **local** coordinate s, which keeps coefficients well scaled even on a 1000 m beam.

```
V(s) = Σ F_i                       (forces and reactions at x_i <= x0)
     + ∫ q over [0, x0 + s]

M(s) = Σ F_i·(x0 + s - x_i)        (same forces)
     - Σ C_j                       (couples at x_j <= x0; ccw positive, hence the minus)
     + moment of the distributed loads about the section
```

For a linear load from x1 to x2 (a = x2 - x1, values q1 and q2):

- entirely left of the section: resultant `W = (q1 + q2)·a/2` and moment about x2 `a²(2q1 + q2)/6`, plus `W·(x0 - x2 + s)`;
- covering the segment: the part left of x0 as above, plus the part inside the segment, `q(t) = qa + slope·t`, contributing `qa·s + slope·s²/2` to V and `qa·s²/2 + slope·s³/6` to M.

Items at x0 are included and items at x1 are not, so evaluating at s = x1 - x0 gives the left limit at x1 (a fixed right end shows its hogging moment, not 0). Degrees: q ≤ 1, V ≤ 2, M ≤ 3.

## Step 6: slope and deflection

When E and I are both known (`integrateDeflection()`), slope and deflection are integrated segment by segment from the left end:

```
θ(s) = θ_start + ∫ M/EI ds
v(s) = v_start + ∫ θ ds
```

The start values at x = 0 are the stiffness solution's nodal values divided by the real EI. Deflection is continuous everywhere; at a hinge the slope restarts from the DSM rotation of the element on the right (θR). Degrees: θ ≤ 4, v ≤ 5. Property tests check that the marched values match the nodal solution at every node.

An absurd E or I (say `E 1e-300 Pa`) can push θ and v outside double precision. When a bound on any segment's polynomial (Σ|c_i|·max(1, len)^i) is not finite or exceeds `1e300` (`MAX_DEFLECTION_MAGNITUDE`, which leaves room for the m-to-mm conversion and chart scaling), θ and v are withheld and `hasDeflection` is false; reactions, V and M stay exact, and `analyzeBeam` warns that the deflection could not be computed.

## Step 7: extrema, stress and shear zeros

`computeExtrema()` in `diagrams.ts` never relies on samples:

- V is extreme at segment ends (both sides of every jump) and where q = 0;
- M is extreme at segment ends and where V = 0;
- v is extreme at segment ends and where θ = 0.

Roots come from `polyRootsInInterval()` in `polynomial.ts`: closed form for degree 1 and 2 (the quadratic uses the cancellation-free formula), and for higher degrees the roots of the derivative split the interval into monotonic pieces, each searched by bisection to full double precision. Unlike sampling, this never misses two close roots.

Ties within `1e-9` of the diagram scale keep the first occurrence from the left, so a symmetric beam reports the left of two equal peaks. Values below `1e-12` of the scale are reported as exactly 0, so labels never read "-0.00".

**Bending stress** is `σ = |M|max · c / I`, the largest elastic bending stress along the beam, available when a section gives c. When an explicit `I` overrides the section, that I is used with the section's c.

**Shear zeros** (`findShearZeros()`) are the positions where V changes sign, either inside a segment or by a jump through zero; V touching zero and returning is not a sign change. The moment diagram labels the local peaks found there, so both spans of a continuous beam get their own peak label.

**Plot samples** (`sampleDiagram()`) are only for drawing: evenly spaced points per segment including both ends, so a jump appears as two points with the same x.

## Engineering warnings

`engineeringWarnings()` in `analyze.ts` runs after a successful solve:

| Warning | Trigger |
| --- | --- |
| Uplift | a pin or roller reaction pointing down by more than `1e-9` of the force scale |
| No horizontal restraint | every support is a roller |
| Equilibrium | residual above `1e-6` (last line of defence; the solver already refuses such results) |
| Deflection unavailable | E and I given, but the solver withheld the deflection (out of double-precision range) |
| Large deflection | the worst span or cantilever ratio (`governingDeflectionRatio()` in `diagrams.ts`, the same figure as the results table) is below L/50, where small-deflection theory stops being reliable |

`analyzeBeam` also warns when a block has no loads at all (every diagram would be zero, which looks like a bug).

The **force scale** used for all relative tolerances (`forceScale()` in `src/core/scale.ts`) is Σ|point loads| + Σ|couples|/L + the absolute area under every distributed load (+ |reactions| where available).

**Input limits.** Before any work, `analyzeBeam` refuses blocks over 20,000 characters, with more than 50 supports and hinges or more than 100 loads, and `buildModel` refuses lengths outside 1 µm to 100 km. The analysis reruns on every resize and editor keystroke pause, so these limits keep a pasted or crafted block from freezing Obsidian.

## Tolerances

Tolerances shared between modules (`POSITION_TOL`, `RESIDUAL_TOL`) are defined once in `src/core/tolerances.ts`.

| Constant | Value | Where | Purpose |
| --- | --- | --- | --- |
| `POSITION_TOL` | 1e-9 · L | model, solver, diagrams, stability | same-position checks, key-point merging, snapping to the ends |
| `RANK_TOL` | 1e-9 (absolute) | stability | zero pivot in the constraint matrix |
| `relTol` | 1e-10 (scaled) | linalg | singular stiffness matrix |
| `REACTION_ZERO_TOL` | 1e-12 · total load | solver | round-off reactions become 0 |
| `RESIDUAL_TOL` | 1e-6 | solver, analyze | equilibrium self-check |
| `ZERO_TOL` | 1e-12 · scale | diagrams | round-off values become 0 |
| `TIE_TOL` | 1e-9 · scale | diagrams | equal peaks |
| `UPLIFT_TOL` | 1e-9 · force scale | analyze | uplift warning |
| `LARGE_DEFLECTION_RATIO` | 50 | analyze | L/50 warning |
| `ZERO_FLOOR` | 1e-10 (display units) | units | display round-off prints as 0 |

## Rendering

`src/render` turns results into `Scene` objects: a width, a height, an accessible title and description, and a flat list of primitives (`line`, `polygon`, `path`, `text`, ...) that carry only `bsd-*` class names, never colours or inline styles. `beam-scene.ts` draws the beam, supports, hinges, loads, reactions and dimension line; `chart-scene.ts` draws the shear, moment and deflection diagrams. Both use the same horizontal mapping (`createXLayout` in `scene.ts`), so a load on the beam drawing sits exactly above the jump it causes. Labels are placed with simple collision avoidance (rows, preferred sides, the curve and axis as obstacles).

`src/ui/mount.ts` turns a scene into a live `<svg>` with Obsidian's `createSvg()` and `setText()`, skipping any `style`, `class`, `on*` or `href` attribute (`isForbiddenAttribute()` in `scene.ts`, shared with `svg-string.ts`) and any non-finite number. No HTML or SVG string is ever parsed, so text from a block cannot become markup. Colours come from CSS custom properties in `styles.css` mapped to Obsidian theme variables, which is why theme switches and PDF export need no re-render. `svg-string.ts` serialises a scene to an escaped SVG string; it is used by tests and tooling only, never by the plugin itself.

## Validation

- **Closed-form benchmarks** (`tests/solver.benchmarks.test.ts`): the 23 cases of `tests/fixtures/benchmarks.json` (simply supported, cantilever, overhang, propped, fixed-fixed, continuous and Gerber beams under point, uniform, triangular, trapezoidal and moment loads) with relative tolerances of 1e-9 on reactions, V and M and 1e-7 on deflection, plus extra textbook cases and robustness cases (loads next to supports, very long and very short beams, mechanisms).
- **Oracle**: every fixture value was cross-checked with `scripts/oracle/beam_exact.py`, an independent solver using singularity (Macaulay) functions in exact rational arithmetic (Python `fractions`). It is a development tool and is not shipped.
- **Property tests** (`tests/solver.properties.test.ts`): 150 random stable beams from a seeded generator, checking global equilibrium, the jumps of V and M at every key point, M = 0 at hinges and free ends, dV/dx = q, dM/dx = V, dθ/dx = M/EI and dv/dx = θ, superposition, mirror symmetry, linear scaling with the loads, 1/EI scaling of deflection, boundary conditions, extremes that bound every sample, and shear zeros.
- **Parser, model, units, render and UI tests** cover the language, every error message path, the drawings and the Obsidian glue (with a small `obsidian` mock in `tests/__mocks__`).

Run them all with `npx vitest run`.
