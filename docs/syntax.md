# Beam block syntax

This is the complete reference for the `beam` code block language. The [README](../README.md#syntax-reference) has a one-page summary.

Every `beam` example on this page is checked by running it through the plugin's analysis (`analyzeBeam`) with no errors. Examples of mistakes are shown as plain text blocks.

## Contents

- [The basics](#the-basics)
- [Statements](#statements)
  - [title](#title) · [units](#units) · [length](#length) · [supports](#supports-pin-roller-fixed) · [hinge](#hinge)
  - [point](#point) · [moment](#moment) · [udl](#udl) · [linear](#linear)
  - [material](#material) · [E](#e) · [I](#i) · [section](#section)
- [Positions](#positions)
- [Directions and signs](#directions-and-signs)
- [Numbers](#numbers)
- [Units](#units-1)
- [Comments](#comments)
- [Errors and warnings](#errors-and-warnings)
- [Recipes](#recipes)

## The basics

A beam block is a fenced code block whose language is `beam`. Inside, write one statement per line:

````markdown
```beam
length 6 m
pin at 0
roller at end
point 10 kN down at 2 m
```
````

Rules that apply to every statement:

- **One statement per line.** A line starts with a keyword (`length`, `pin`, `point`, ...). Blank lines are ignored.
- **Keywords, directions, position words and units are case-insensitive**: `Pin AT End` works.
- **Order does not matter.** Statements can appear in any order, and inside a load statement the parts after the value (direction, position, extent) can appear in any order too.
- **Optional separator.** A `:` or `=` may follow the keyword: `length: 6 m`, `E = 200 GPa`.
- **`@` means `at`**: `point 10 kN @ 2 m`.
- **Single statements.** `title`, `units`, `length`, `material`, `E`, `I` and `section` may appear only once. Supports, hinges and loads can be repeated as often as needed.
- **Comments** start with `#` or `//` and run to the end of the line (except on a `title` line, where they are part of the title).

The smallest block that solves needs a `length` and enough supports to hold the beam. Without any load it still solves, with a `No loads yet` warning.

## Statements

Notation: `<value>` is a number with an optional unit, `<position>` is described under [Positions](#positions), `[...]` is optional and `a|b` means either word.

### title

```
title <any text>
```

Free text shown above the drawing. Anything goes, including commas and symbols, because the rest of the line is taken as is. On a `title` line `#` and `//` do not start a comment, so `title Beam #1` keeps its number.

```beam
title Floor joist J1, level 2 (check)
length 4 m
pin at 0
roller at end
udl 2.5 kN/m down
```

### units

```
units kN m | N mm | kip ft | lb in
```

Chooses the unit system for this block. It decides what a number **without** a unit means and which units the results are shown in. Without a `units` line the **Default units** setting applies (kN and m out of the box).

| System | Also accepted |
| --- | --- |
| `kN m` | `kN-m`, `kNm`, `kN, m`, `SI` |
| `N mm` | `N-mm`, `Nmm` |
| `kip ft` | `kip-ft`, `kips ft`, `k ft`, `US`, `imperial` |
| `lb in` | `lb-in`, `lbf in`, `lbs in` |

```beam
title Steel beam in N and mm
units N mm
length 5000
pin at 0
roller at end
point 12000 down at 2000
material steel
section rect 100 x 250
```

Numbers that carry their own unit are always read in that unit, whatever the system: `units kip ft` with `point 10 kN at 2 m` is perfectly valid.

### length

```
length <value>
```

Required. The total beam length, which must be greater than zero. Aliases: `span`, `L`.

```beam
span 20 ft
pin at 0
roller at end
point 4 kip down at mid
```

### Supports: pin, roller, fixed

```
pin at <position>
roller at <position>
fixed at <position>
```

| Keyword | Aliases | Restrains | Reactions |
| --- | --- | --- | --- |
| `pin` | `pinned` | vertical movement | vertical force |
| `roller` | | vertical movement | vertical force |
| `fixed` | `clamped`, `fix` | vertical movement and rotation | vertical force and moment |

Pins and rollers behave the same for vertical loads (the beam model has no horizontal loads); the difference is drawn and reported so the structure reads correctly. A **free end** is just an end without a support.

The longer forms `support pin at 0` and `pin support at 0` are also accepted. Two supports cannot share a position.

```beam
title Supports written three ways
length 9 m
support pin at 0
roller support at 4.5 m
roller at end
udl 3 kN/m down
```

Fixed supports usually sit at an end, but an interior clamp is allowed:

```beam
title Interior clamp with two overhangs
length 6 m
fixed at 2 m
point 3 kN down at start
point 5 kN down at end
```

### hinge

```
hinge at <position>
```

An internal hinge (moment release): the two sides are connected but no bending moment passes through, so M = 0 there and the slope may change abruptly. A hinge must lie strictly inside the beam, cannot sit on a fixed support, and a point moment cannot act exactly at a hinge (move it slightly to one side, so it is clear which part it loads).

Each hinge removes one restraint, so a hinged beam needs extra supports to stay stable. The plugin checks this exactly and reports a mechanism instead of returning meaningless numbers.

```beam
title Gerber beam with two hinges
length 18 m
pin at 0
roller at 6
roller at 12
roller at 18
hinge at 4.5
hinge at 13.5
udl 4 kN/m down
```

### point

```
point <force> [down|up] at <position>
```

A concentrated force. The direction defaults to `down`. Aliases: `force`, `load`.

Every load keyword may be followed by the word `load`, so `point load 10 kN at 2 m`, `uniform load 5 kN/m` and `linear load 0 to 6 kN/m` read naturally.

```beam
title Point loads
length 8 m
pin at 0
roller at end
point 12 kN down at 2 m
load 5 kN at mid
force 3 kN up at 7 m
```

### moment

```
moment <moment> cw|ccw at <position>
```

A concentrated moment (couple). The direction is **required**, because there is no natural default: `cw` (`clockwise`) or `ccw` (`counterclockwise`, `counter-clockwise`, `anticlockwise`, `anti-clockwise`). Alias: `couple`.

```beam
title Cantilever with an end moment
length 2.5 m
fixed at start
moment 8 kNm ccw at end
point 2 kN down at end
```

A moment unit can be written in several ways: `kNm`, `kN·m`, `kN*m`, `kN-m`, `kN.m` and even `kN m` with a space.

### udl

```
udl <load per length> [down|up] [from <position> to <position>]
```

A uniformly distributed load. Without `from ... to ...` it covers the whole beam; with them, give both. `from` must be less than `to`. Aliases: `uniform`, `distributed`.

```beam
title Uniform loads
length 10 m
pin at 0
roller at end
udl 2 kN/m down
uniform 5 kN/m down from 3 to 7 m
```

### linear

```
linear <start value> to <end value> [down|up] [from <position> to <position>]
```

A linearly varying load. The first value acts at `from` (or at the start of the beam) and the second at `to` (or the end), so `linear 0 to 6` is a triangle rising to the right and `linear 6 to 0` falls to the right. Unequal non-zero values give a trapezoid. Aliases: `triangle`, `trapezoid`, `varying`.

```beam
title Triangular and trapezoidal loads
length 6 m
pin at 0
roller at end
linear 0 to 6 kN/m down from 0 to 3 m
trapezoid 2 to 4 kN/m down from 3 to 6 m
```

If only one of the two values has a unit, the other one borrows it: `linear 2 to 6 kN/m` means 2 kN/m to 6 kN/m.

### material

```
material <name>
```

Picks a preset Young's modulus E, used for deflection. Names are case-insensitive, and spaces, hyphens and underscores are interchangeable.

| Name | Also accepted | E |
| --- | --- | --- |
| `steel` | `structural steel` | 200 GPa |
| `stainless` | `stainless steel` | 193 GPa |
| `aluminium` | `aluminum` | 68.9 GPa |
| `timber` | `wood` | 11 GPa |
| `concrete` | | 33 GPa |

The sources of these values are listed in the [README](../README.md#materials-and-sections). Deflection needs a stiffness too: add a `section` or an `I`.

### E

```
E <modulus>
```

Young's modulus, overriding any `material` (a warning says so). **A unit is required**, because a bare `200` could mean GPa, MPa or ksi.

```beam
title Steel to EN 1993 (E = 210 GPa)
length 6 m
pin at 0
roller at end
udl 10 kN/m down
E 210 GPa
I 8356 cm^4
```

### I

```
I <second moment of area>
```

Second moment of area about the bending axis, overriding the value computed from a `section` (a warning says so; the section still provides the depth for stress). **A unit is required.** `cm^4`, `cm4` and `cm⁴` are the same unit. Aliases: `Ix`, `Iy`, `Iz`, since catalogues name I after its axis; the beam always bends about the horizontal axis, so pick the catalogue value (strong or weak axis) that matches how the member is oriented.

### section

```
section <shape> <d1> x <d2> ... [unit]
```

A cross-section with a built-in formula. It provides I (for deflection) and the extreme fibre distance c = depth / 2 (for bending stress).

| Shape | Aliases | Dimensions, in this order |
| --- | --- | --- |
| `rect` | `rectangle` | b x h: width, depth |
| `circle` | `round`, `solid-circle` | d: diameter |
| `tube` | `pipe`, `chs` | d x t: outside diameter, wall thickness |
| `box` | `rhs`, `shs` | b x h x t: width, depth, wall thickness |
| `ibeam` | `i-beam`, `i`, `h`, `wide-flange` | b x h x tw x tf: flange width, depth, web thickness, flange thickness |

Separate dimensions with `x`, `×` or `*`, with or without spaces (`100x200mm` works). Units:

- one unit after the **last** dimension applies to all of them: `section rect 100 x 200 mm`;
- otherwise each dimension can carry its own unit: `section rect 10 cm x 0.2 m`;
- a dimension without any unit is in mm in `N mm` blocks and in inches in `lb in` blocks. In `kN m` and `kip ft` blocks a bare section number is refused (`Add a unit to the section dimensions, ...`): a bare length means m or ft there, so `section rect 0.1 x 0.2` would be ambiguous by a factor of 1000. (The editor's form writes the unit for you: a blank **Dimension unit** field saves the unit shown in its placeholder.)

The formulas are listed in the [README](../README.md#materials-and-sections). Impossible geometry (a wall thicker than half the section, a web wider than the flange) is reported as an error.

```beam
title Hollow sections
length 3 m
fixed at start
point 1.5 kN down at end
material steel
section rhs 100 x 150 x 5 mm
```

```beam
title Rolled IPE 300 with its catalogue I
length 6 m
pin at 0
roller at end
udl 12 kN/m down
material steel
# The formula ignores fillets (7999 cm^4); use the catalogue value instead
section ibeam 150 x 300 x 7.1 x 10.7 mm
I 8356 cm^4
```

The last example shows a warning that `I` overrides the section. That is intended: the section is kept for the bending stress.

## Positions

A position is either a length or a keyword. x is measured from the **left** end of the beam.

| Keyword | Means |
| --- | --- |
| `start`, `left` | x = 0 |
| `mid`, `midspan`, `mid-span`, `middle`, `center`, `centre` | x = L / 2 |
| `end`, `right` | x = L |

A length can carry any length unit (`2`, `2 m`, `1500 mm`, `150 cm`, `5 ft`, `60 in`). A bare number uses the length unit of the block's unit system.

In `from ... to ...`, a bare number borrows the unit of the other end, the way you would read it aloud: `from 2 to 6 ft` means from 2 ft to 6 ft.

```beam
title Positions in mixed units
length 6 m
pin at left
roller at right
point 4 kN down at 1500 mm
point 4 kN down at mid
udl 1 kN/m down from 400 to 550 cm
```

Positions must lie on the beam (0 to L). Round-off at the ends is forgiven, so `roller at 36 in` on a 3 ft beam lands exactly at the end. Textbook notation such as `at L` or `at L/2` is not read; the error suggests `end` or `mid`.

## Directions and signs

| Applies to | Words | Default |
| --- | --- | --- |
| `point`, `udl`, `linear` | `down`, `downward`, `downwards`, `up`, `upward`, `upwards` | `down` |
| `moment` | `cw`, `clockwise`, `ccw`, `counterclockwise`, `counter-clockwise`, `anticlockwise`, `anti-clockwise` | none: required |

A **negative value flips the direction**: `point -10 kN down` is a 10 kN upward force. `linear -2 to 4 kN/m down` is a load that changes direction along its length.

The sign conventions of the results (positive shear, sagging-positive moment, deflection positive up) are explained in the [README](../README.md#sign-conventions-and-how-to-read-the-diagrams).

## Numbers

- Integers, decimals and exponents: `10`, `2.5`, `.5`, `1e4`, `-2.5e3`.
- The decimal separator is a **dot**, and there are no thousands separators. `2,5` and `1,000` are rejected with a message instead of being read as 2, 25, 1 or 1000; so is `200 000` with a space.
- Powers of ten use `e`: write `2.1e5`, not `2.1 × 10^5`. Fractions such as `1/3` are not read; write a decimal.
- A leading Unicode minus sign (as copied from PDFs) is accepted like `-`. A typographic dash (en dash or em dash, as word processors insert) is refused, because a misread sign would flip a load; between two numbers it is taken for a range and the message suggests `from ... to ...`.
- Invisible characters copied from web pages (zero-width spaces, soft hyphens) are ignored.
- The unit can be glued to the number or separated by a space: `10kN` and `10 kN` are the same. Feet and inch marks (`5'`, `6"`) and compound lengths (`2 ft 6 in`) are not read; write `5 ft` or `2.5 ft`.

## Units

Units are matched case-insensitively. Products may be written with `·`, `•`, `*`, `-`, `.`, a space or nothing (`kN·m`, `kN*m`, `kN-m`, `kN.m`, `kN m`, `kNm`), powers with `^`, superscripts or plain digits (`cm^4`, `cm⁴`, `cm4`). Slashes matter: `kN/m` is a load per length, `kNm` is a moment.

Two exceptions are refused rather than guessed:

- `mN` and `mPa`. Case-insensitive matching would read them as MN and MPa, a factor of 10⁹ away from milli. Milli units are not supported; write `MN` or `MPa` (all lower-case `mpa` is accepted as MPa, since that is how people type it).
- The one-letter kip forms `k`, `k-ft`, `ft-k`, `k-in`, `k/ft` and `k/in` in `kN m` and `N mm` blocks, where `10 k` could mean 10 kN. Write `kip`, `kips` or `klf`, which are accepted everywhere. In `kip ft` and `lb in` blocks the short forms work.

| Quantity | Accepted units |
| --- | --- |
| Length | `m` (`meter`, `meters`, `metre`, `metres`), `cm`, `mm`, `in` (`inch`, `inches`), `ft` (`foot`, `feet`) |
| Force | `N`, `kN`, `MN`, `lb` (`lbf`, `lbs`), `kip` (`kips`, and `k` in US blocks) |
| Moment | `N·m`, `kN·m`, `MN·m`, `N·mm`, `kN·mm`, `MN·mm`, `N·cm`, `kN·cm`, `lb·ft`, `lb·in`, `kip·ft`, `kip·in`. US moments may be written in either order (`ft·lb`, `ft-kip`); SI moments only force first, because `mN` would read as a force. |
| Distributed load | `N/m`, `kN/m`, `MN/m`, `N/mm`, `kN/mm`, `N/cm`, `kN/cm`, `lb/ft` (also `lbf/ft`, `lbs/ft`, `plf`), `lb/in` (`pli`), `kip/ft` (`klf`), `kip/in` |
| Modulus | `Pa`, `kPa`, `MPa`, `GPa`, `N/m^2`, `kN/m^2`, `N/mm^2`, `MN/m^2`, `kN/mm^2`, `psi`, `ksi`, `Msi` |
| Second moment of area | `m^4`, `cm^4`, `mm^4`, `in^4` |

US conversions use the exact international definitions (1 in = 0.0254 m, 1 lbf = 4.4482216152605 N).

A unit of the wrong kind is an error, not a silent conversion: `point 10 kN/m at 2` reports `kN/m is not a force unit`.

### What a bare number means

| Quantity | `kN m` | `N mm` | `kip ft` | `lb in` |
| --- | --- | --- | --- | --- |
| Length and positions | m | mm | ft | in |
| Force | kN | N | kip | lb |
| Moment | kN·m | N·mm | kip·ft | lb·in |
| Distributed load | kN/m | N/mm | kip/ft | lb/in |
| Section dimensions | unit required | mm | unit required | in |
| E and I | unit required | unit required | unit required | unit required |

### Units of the results

Results use the **Decimal places** setting. Computed positions (where a maximum or a shear zero is) keep at least 2 decimals, E and I show 4 significant digits, and a preset E is rounded to 3 (steel reads 29000 ksi in US units).

| Result | `kN m` | `N mm` | `kip ft` | `lb in` |
| --- | --- | --- | --- | --- |
| Positions | m | mm | ft | in |
| Reactions and shear | kN | N | kip | lb |
| Moments | kN·m | N·mm | kip·ft | lb·in |
| Deflection | mm | mm | in | in |
| Bending stress | MPa | MPa | ksi | psi |
| E | GPa | MPa | ksi | psi |
| I | cm⁴ | mm⁴ | in⁴ | in⁴ |

## Comments

`#` or `//` starts a comment that runs to the end of the line, on its own line or after a statement. The one exception is a `title` line, whose whole text is the title.

```beam
# A comment on its own line
length 6 m   # a trailing comment
pin at 0     // C-style comments work too
roller at end
udl 4 kN/m down
```

The beam editor's **Form** tab rewrites the block from its fields, which drops comments. The editor shows a note when the block has comments; editing in the **Text** tab keeps them.

## Errors and warnings

Problems are shown in place of the drawing, each with its line number and the text of that line. Every problem in the block is listed at once, at most one per line. For example, this block has a mistake on almost every line:

```text
lenght 6 m
length 6 m
pin at 0 roller at end
roller at end
moment 5 kNm at 3
point 2,5 kN at 2
point 10 tons at 2
point 10 kN/m at 2
point 10 kN at 7 m
udl 4 kN/m at 2
E 200
section rect 100 x 200
length 7 m
```

and the plugin reports:

```text
Line 1: Unknown statement "lenght". Did you mean "length"?
Line 3: Unexpected "roller": write one statement per line
Line 5: Moment needs a direction: cw or ccw
Line 6: Invalid number "2,5": use a dot as the decimal separator
Line 7: Unknown unit "tons": use kN, N, kip or lb
Line 8: kN/m is not a force unit: use kN, N, kip or lb
Line 9: Position 7 m is outside the beam (0 to 6 m)
Line 10: A distributed load uses "from" and "to" instead of "at", for example: from 0 to 6 m
Line 11: Add a unit to E, for example: E 200 GPa
Line 12: Add a unit to the section dimensions, for example: section rect 100 x 200 mm
Line 13: length is defined twice (lines 2 and 13)
```

Problems with the whole beam have no line number:

```text
Add a length, for example: length 6 m
Add at least one support, for example: pin at 0
The beam is unstable: it can move as a mechanism. Add a support or remove a hinge
```

Common habits from textbooks and spreadsheets get a specific hint instead of a generic error:

| You wrote | The plugin says |
| --- | --- |
| `free at end` | A free end needs no statement: delete this line |
| `EI 16000 kNm^2` | Give E and I separately, for example: E 200 GPa on one line and I 8000 cm^4 on the next |
| `point 10 at L/2` | Unknown position "L/2". Did you mean "mid"? |
| `E 200 000 MPa` | Write numbers without spaces, for example 200000 |
| `E 2.1 x 10^5 MPa` | Write powers of ten with "e", for example 2.1e5 for 2.1 × 10^5 |
| `point 1,000 N at 2` | Invalid number "1,000": write numbers without separators, for example 1000 (use a dot for decimals: 1.5) |
| `point 10 at 2 ft 6 in` | Write one number with one unit, for example 2.5 ft rather than 2 ft 6 in |
| `udl 5 between 0 and 6` | Use "from 0 to 6 m", or leave it out to load the whole beam |
| `point 10 k at 2` (SI block) | "k" is ambiguous in an SI block: write kip or kN |

**Warnings** appear under the diagrams. The results are still computed, but deserve a second look:

| Warning | Meaning |
| --- | --- |
| `Support at x = 0 m pulls the beam down (5.00 kN): it must be anchored against uplift` | The support carries a downward reaction. Real bearings often cannot, so provide an anchor. |
| `No pin or fixed support: the beam is not restrained horizontally. Results assume vertical loads only` | Rollers only. Fine for the vertical analysis, but the real beam could slide. |
| `Maximum deflection is L/35: check E, I and the section units ...` | Deflection above L/50 of a span or cantilever (the same ratio as the results table's **Worst deflection ratio** row) is almost always an input mistake, and beyond what small-deflection theory describes well. |
| `The deflection could not be computed: check E and I` | E and I were given, but they are so extreme (for example `E 1e-300 Pa`) that the deflection falls outside the range of double-precision numbers. Reactions, shear and moment are still exact. |
| `Deflection needs both a material or E, and a section or I` | Only half of the stiffness was given, so no deflection is drawn. |
| `E overrides the material preset` / `I overrides the I computed from the section; ...` | Both were given; the explicit value wins. |
| `This point load is zero and is ignored` | A load of magnitude 0. |
| `No loads yet: add one, for example point 10 kN at 2 m` | The beam solves, but every diagram is zero. |

**Limits.** To keep a pasted block from freezing Obsidian, a block may have at most 50 supports and hinges together, 100 loads and 20,000 characters, and the length must lie between 1 µm and 100 km. Textbook beams are far below these limits.

## Recipes

Complete blocks for common textbook cases. Copy one and edit it.

**Simply supported, central point load.** M max = PL/4 = 15 kN·m.

```beam
title Central point load
length 6 m
pin at 0
roller at end
point 10 kN down at mid
material steel
section ibeam 150 x 300 x 7.1 x 10.7 mm
```

**Simply supported, full uniform load.** M max = wL²/8 = 18 kN·m at mid-span.

```beam
title Uniform load
length 6 m
pin at start
roller at end
udl 4 kN/m down
```

**Cantilever with a tip load.** Fixed-end moment = PL = 15 kN·m.

```beam
title Cantilever, tip load
length 3 m
fixed at start
point 5 kN down at end
material steel
section rect 100 x 200 mm
```

**Cantilever fixed on the right.**

```beam
title Cantilever fixed at the right
length 2 m
fixed at end
udl 3 kN/m down
```

**Overhang on both sides.**

```beam
title Double overhang
length 10 m
pin at 2 m
roller at 8 m
udl 5 kN/m down
point 4 kN down at start
point 4 kN down at end
```

**Propped cantilever** (indeterminate to degree 1).

```beam
title Propped cantilever
length 6 m
fixed at 0
roller at 6
udl 5 kN/m down
```

**Fixed-fixed beam** (indeterminate to degree 2). End moments wL²/12 = 15 kN·m.

```beam
title Fixed-fixed beam
length 6 m
fixed at start
fixed at end
udl 5 kN/m down
```

**Three-span continuous beam.**

```beam
title Three-span continuous beam
length 15 m
pin at 0
roller at 5
roller at 10
roller at 15
udl 8 kN/m down
point 20 kN down at 12.5
```

**Hydrostatic (triangular) load on a cantilever wall strip.**

```beam
title Water pressure on a 3 m wall strip
length 3 m
fixed at start
linear 29.4 to 0 kN/m down
```

**Timber floor joist with self-weight**, in N and mm.

```beam
title Timber joist 50 x 200, 4 m span
units N mm
length 4000
pin at 0
roller at end
# 1.5 kN/m² floor load at 400 mm spacing = 0.6 N/mm, plus self-weight
udl 0.6 down
udl 0.05 down
material timber
section rect 50 x 200
```

**US customary, lb and in.**

```beam
title Aluminium tube, lb and in
units lb in
length 96
pin at 0
roller at end
point 150 down at 48
material aluminum
section tube 3 x 0.125
```

**Point moment on a simply supported beam.** The supports react with a couple of opposite forces (one of them pulls down, so this block shows an uplift warning).

```beam
title Applied moment at mid-span
length 4 m
pin at 0
roller at end
moment 12 kNm cw at mid
```

**Upward load (uplift).** The net load points up, so both supports must hold the beam down and the block warns about uplift at each of them.

```beam
title Wind uplift on a roof purlin
length 5 m
pin at 0
roller at end
udl 0.4 kN/m down
udl 1.1 kN/m up
```
