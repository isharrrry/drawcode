# Conformance

`drawcode` ships three independent implementations — Python, TypeScript, .NET 10 (C#). They must
agree. This file defines **how agreement is measured**, so that "the three versions match" is a
checkable claim rather than a feeling.

## Why the bar is exact, not approximate

A performance comparison is only meaningful if all three implementations do the *same work*. If the
TypeScript version draws prettier edges because it routes differently, its benchmark numbers are not
comparable. So all three follow **one layout and routing specification**, and geometry is compared
exactly.

The reference implementation is `python/src/drawcode/`. Port its algorithms function by function;
do not redesign them.

## Comparison levels

| Level | What is compared | Tolerance |
| :--- | :--- | :--- |
| **L1 — Parse (IR)** | `signals`, `funcs` (incl. `params`/`reads`/`writes`/`calls`), `edges`, `devices`, `files` | exact |
| **L2 — Graph structure** | container set and nesting, node set and container membership, edge set with `src`/`dst`/`rw` | exact |
| **L3 — Geometry** | node `x`/`y`/`w`/`h`, edge `<Array as="points">` sequences, edge anchors (`exitX`/`exitY`/`entryX`/`entryY`) | exact |
| **L4 — Schema** | generated `.drawio` validates against `tools/xsd/mxfile.xsd` | must pass |

L1 catches parser bugs. L2 catches container-assignment bugs. L3 catches layout and routing bugs.
Reporting which level failed is required — "output differs" is not a useful bug report.

## Golden cases

`tests/golden/<name>/` is self-contained:

```
tests/golden/small-c/
├── input/                 # adc.h adc.c dsp.h dsp.c
├── expected.ir.json       # L1 golden
├── expected.drawio        # L2 + L3 golden
└── preview.svg            # SVG golden (rendered output, not compared byte-wise — see below)
```

`expected.ir.json` is produced by `tools/dump_ir.py`, which deliberately records **no layout
coordinates**: layout is the `.drawio` layer's business, and mixing the two would make a routing bug
look like a parser bug.

To regenerate the goldens after an intentional behaviour change:

```bash
python tools/dump_ir.py tests/golden/small-c/input tests/golden/small-c/expected.ir.json \
    tests/golden/small-c/input/adc.h tests/golden/small-c/input/adc.c \
    tests/golden/small-c/input/dsp.h tests/golden/small-c/input/dsp.c
```

## Normalisation rules

Comparison is **structural, never byte-wise**. Two documents are equal iff, after normalisation:

1. **Attribute order is irrelevant.** Sort attributes by name before comparing an element.
2. **Insignificant whitespace is irrelevant.** Compare text content stripped; ignore indentation.
3. **Numbers compare by value, not spelling.** `420`, `420.0` and `4.2e2` are equal. The reference
   implementation happens to print integers without a decimal point; that is not a requirement.
4. **`<mxPoint>` coordinates are parent-relative.** `read_layout` converts them to absolute canvas
   coordinates and `to_drawio` converts back. Compare *after* conversion — comparing raw values
   across differently-nested diagrams reports phantom drift.
5. **Element order follows document order**, except where this spec says "sorted" (e.g. containers
   by id, nodes by `symbolId`, edges by `(src, dst, rw)`), in which case sort before comparing.
6. **IDs are compared as strings**, but the specific `id` values (`n1`, `e1`, `grp1`) are *not*
   part of the contract beyond being unique and stable within one run. Compare the *mapping*
   from `symbolId` to geometry, not the raw `id` strings.

## Required capabilities

Both non-Python implementations must provide all of these. A missing capability is a failure even
if no golden case exercises it yet.

| # | Capability | Reference |
| :--- | :--- | :--- |
| 1 | C parse: `/// @drawcode` annotation (the `dir` key and metadata), `/// @device` | `cparse.py` |
| 2 | C# parse: `[Drawcode(Direction.X, ...)]` and `[Device(...)]` attributes | `csparse.py` |
| 3 | IR assembly and edge derivation (`reads`/`writes` → edges) | `model.py` |
| 4 | Default layout (container stacking, intra-container vertical packing) | `_assign_default_positions` |
| 5 | Containers: one swimlane per source directory/file, nesting, edge assigned to innermost common container | `to_drawio` |
| 6 | Routing: anchor selection, obstacle avoidance, cross-container gap routing, lane detours | `_route`, `_candidates`, `_cross_gap` |
| 7 | `.drawio` write: `<object>` custom properties, `mxCell`, `mxGeometry`, `<Array as="points">` | `to_drawio` |
| 8 | `.drawio` read: **both** plain and draw.io-compressed form, plus layout application | `read_layout`, `_unpack` |
| 9 | Write-back to source, declaration layer only (never function bodies) | `codegen.py` |
| 10 | SVG preview sharing **node** coordinates with the `.drawio` | `svg.py` |

## Capability 8 is not optional

draw.io compresses `<diagram>` content by default when saving. An implementation that only reads
plain XML will return an **empty layout without error** after the user saves in draw.io, silently
discarding hand-made layout. The compressed form is:

```
base64( raw-deflate( urllib-quote( xml ) ) )
```

with `~()*!.'` as the only characters not percent-encoded. Spec: `_decompress` / `_unpack`.

An unreadable `<diagram>` payload must raise an error, never return an empty layout.

## SVG is compared structurally, not byte-wise

SVG is a *rendered artefact*. Implementations may differ in attribute order, whitespace and path
command spelling. Compare: element count by tag, the text nodes, and coordinates within 0.5px.
Never require byte equality.

**Known divergence — SVG edge routing is simplified.** The SVG preview shares the *node* layout
with the `.drawio` (both call `_assign_default_positions`), but **not the edge router**: `svg.py`
draws each edge centre-to-centre with optional waypoints, while `to_drawio` runs the full anchor
selection and obstacle avoidance in `_route`. Consequences, stated plainly:

- SVG edges start and end at node *centres*, so they visibly cross node shapes; `.drawio` edges do not.
- The SVG is therefore **not** a faithful preview of the `.drawio`. It is a quick structural read.
- To supply real routing to the SVG, `to_drawio` must be refactored to expose edge geometry as a
  shared function. Until then, both implementations reproduce the simplified behaviour, and SVG
  conformance tests must not assert edge geometry.

**Known divergence — TypeScript carries extensions the other two do not have.** `docs/annotations.md`
now documents these as available; they are not, everywhere. Stated plainly so nobody hunts a ghost:

- **Edge-label de-clashing is TypeScript-only.** When two edge labels would overlap, TS moves every
  label but the first out of its edge and into a sibling `<mxCell id="eN_label" … parent="eN">`,
  where `<mxPoint as="offset">` holds a purely vertical shift, and blanks the edge object's own
  `label`. Python and .NET leave every label inline on its edge, so the same input yields more cells
  and visibly stacked text. The shared golden case (`small-c`) contains no two labels close enough
  to clash, so conformance stays green — which is precisely why this is written down instead of left
  to be found in the field.
- **Geometry — `xy`, node `size`, `style` — is read by TypeScript only, on both front ends and both
  entity kinds.** One mechanism, one bullet: `cparse.py` reads `xy`/`size` on **functions only** (its
  signal loop is already finished by the time the geometry is read, so a `xy` written on a variable is
  parsed and dropped), `csparse.py` never calls `meta.get("xy")` at all and says so in its own header,
  `CsParse.cs` likewise, and **neither Python nor .NET reads `style`**. TypeScript honours all three in a
  `.c` *and* in a `.cs`, on signals *and* on functions, because the device-level overview diagrams
  need pinned geometry and per-role colour.
- **`[Callout]` exists only in TypeScript's C# front end.** Neither `csparse.py` nor `CsParse.cs`
  knows `CalloutAttribute`. This is the same class of divergence as the bullet above and is listed
  separately only because the consequence is larger — a whole layer of the drawing disappears.
- Because every implementation ignores unknown keys and attributes rather than rejecting them, the
  two bullets above degrade **silently**. Feeding a `[Callout]` source to Python or .NET produces a
  diagram with the text blocks missing and no error (the node's own attributes still apply — a
  `[Callout]` line starts with `[`, so it passes through the annotation buffer untouched). Feeding an
  `xy` to `cparse.py` produces a normally-stacked diagram and no warning. And no golden case can catch
  either: `expected.ir.json` deliberately records no coordinates (see *Golden cases*), so L1 is
  identical whichever implementation ran. A diagram that quietly loses its geometry is worse than one
  that refuses to build.
- **Geometry is written back to source by TypeScript only.** `sync` (and the layout half of
  `--layout-from`) records `xy`/`size` on entities whose diagram geometry differs from what `build`
  would have written; Python and .NET write nothing, so a rearrange-and-sync round trip through them
  is silently one-way and the next `build` discards the layout. The shared goldens are unaffected in
  both directions: with nobody having dragged anything there is no difference to write, so the
  emitted source is byte-identical to the old behaviour — which is precisely why this had to be
  written down rather than left to a failing test.
- **`Path = "a/b"` is aligned.** All three front ends map `Path` to the container path (TypeScript
  and .NET once omitted it from their key whitelists while Python stored every named argument; the
  whitelists now list it, and each side has a regression test). Nothing to work around.

## Running the comparison

Each implementation ships a conformance runner that reports per-level results:

```
python/      python -m unittest discover -s tests -t .
typescript/  npm test
dotnet/      dotnet test
```

Each runner must fail loudly if a golden file is missing, rather than skipping the case. A skipped
conformance test is worse than a failing one: it makes an unverified implementation look verified.
