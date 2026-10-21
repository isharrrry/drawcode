# drawcode

**English** | [中文](README.zh-CN.md) | [Español](README.es.md)

> Turn annotated C / C# source into an editable [draw.io](https://www.drawio.com/) dataflow diagram — and read your hand-made layout back into the code.

Runs on Windows, Linux and macOS. The CLI has no third-party runtime dependencies: Node 22.6+.
A .NET 10 runtime is needed only to read PE/CLI `.dll` artifacts through the bundled sidecar.

![drawcode output](docs/assets/small-c.png)

## What problem it solves

Most "code to diagram" tools generate a picture and stop there. The picture goes stale the moment
someone edits the code, because **the diagram quietly becomes a second source of truth** — and two
sources of truth always drift. The usual fix is worse: export an intermediate JSON, then invent
hashes, drift detection and three-way merges to reconcile them.

`drawcode` takes the opposite position.

- **Source code is the only source of truth.** Semantics live in the code, expressed with macros,
  attributes and structured comments. No intermediate JSON is ever written to disk — the IR exists
  only in memory and is rebuilt from code on every run.
- **The diagram carries only what code cannot express**: layout, which is a human decision. Drag a
  node in draw.io, and the new position round-trips back into the IR on the next run.
- **The reverse direction is deliberately narrow.** Only the *declaration layer* is written back —
  `SIGNAL_*` macro statements and annotation attributes. **Function body logic is never rewritten**,
  by design.
- **Idempotent.** Build → edit → sync → build produces zero code changes. This is asserted by tests,
  not assumed.
- **Goldens pin the contract.** The IR and geometry are compared exactly against committed golden
  cases, so a parser or router change shows up as a reviewable diff rather than silent drift.

## Quick start

```bash
git clone <this-repo> && cd drawcode

# No install: Node >= 22.6 runs the .ts entry point directly
node typescript/bin/drawcode.ts build \
    examples/small/c/adc.h examples/small/c/adc.c \
    examples/small/c/dsp.h examples/small/c/dsp.c \
    --root examples/small/c \
    --out out/flow.drawio --svg out/flow.svg

# Open a .drawio in draw.io, rearrange the nodes, save, then reuse that layout
# and write the annotations back into your source:
node typescript/bin/drawcode.ts build ... --layout-from out/flow.drawio --out out/flow.drawio
node typescript/bin/drawcode.ts sync out/flow.drawio examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c                    # dry run: reports what would change
node typescript/bin/drawcode.ts sync out/flow.drawio examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --write            # actually write
```

Build commands, the repository map and the test commands are in
[`docs/implementations.md`](docs/implementations.md).

## Command-line usage

```
drawcode build <files...> [--root DIR] [--out FILE] [--merge] [--layout-from FILE] [--svg FILE]
                [--inline] [--cards] [--no-rw-labels] [--straight-edges]
drawcode sync  <drawio> <files...> [--root DIR] [--write]
drawcode inspect <artifact> [--out FILE] [--infer-edges]
```

| Command | Does |
| :--- | :--- |
| `build` | Parse sources → build IR → write `.drawio`. `--layout-from` reuses an existing diagram's hand-made layout. `--svg` also emits a read-only preview sharing the same coordinates. |
| `sync` | Read `.drawio` → apply layout and annotation attributes → write the **declaration layer** back to source. Dry run unless `--write` is passed. |
| `inspect` | Read a compiled artifact (`.dll` / `.so` / `.out` / `.a` / `.o`) and emit canonical JSON. Never loads or executes the artifact. PE `.dll` reading uses the bundled .NET sidecar; ELF and `ar` archives are read in-process. |

`--inline` folds one-write/one-read signals into direct edges, `--cards` renders `asset`-bearing
functions as image cards, `--no-rw-labels` drops the `read`/`write` edge labels, and
`--straight-edges` replaces orthogonal routing with straight lines. Without them the output is
byte-identical to the default behaviour.

## Browsing compiled artifacts

`drawcode inspect` also powers a read-only VS Code viewer. Open a `.dll`, `.so`, `.out`, `.a` or
`.o` and the custom editor shows what was compiled into it:

- **Overview** — format, architecture, entity counts and reader diagnostics.
- **Module cross-links** — a virtualized tree of modules, types, signals and functions; checking a
  signal draws its flow in the left-hand wire gutter, from the writing row to the reading row.
- **Persistent data** — types marked `Store` as ER tables, with field types and nested-type links.

![Module cross-links: a checked port draws a wire from its writing row to its reading row](docs/assets/artifact-viewer.png)

*Module cross-links: check a port and the wire runs from its writing row to its reading row; a
struct signal's fields expand in the right-hand groupbox.*

| Persistent data (`Store` types as ER tables) | C artifact, grouped by tag |
| :---: | :---: |
| ![persistent data view](docs/assets/artifact-viewer-store.png) | ![C artifact grouped by tag](docs/assets/artifact-viewer-c.png) |

Prerequisites and settings live in [`docs/vscode-extension.md`](docs/vscode-extension.md). The
extension bundles the same parsing core as the CLI (`readArtifact`) rather than starting an external
CLI, and it never loads or executes the artifact.

## Core concepts

1. **One persistent source, one derived artefact.** Code is the fact; the `.drawio` is a view plus
   the layout that only a human can supply. Details: [`docs/architecture.md`](docs/architecture.md).
2. **Annotations are the only thing a parser cannot infer.** Direction and metadata are written
   *into the code*: a `/// @drawcode` comment in C, a `[Drawcode(Direction.In)]` attribute in C#.
   Field-level reference:
   [`docs/annotations.md`](docs/annotations.md).
3. **Edges are derived, not parsed.** `read`/`write` edges come from scanning function *bodies* for
   which globals they touch. Editing a comment changes a label; it never moves a line. This is
   often surprising, and it is deliberate.
4. **Coordinates are parent-relative.** In `.drawio`, `mxGeometry` and `mxPoint` are relative to
   their container. `read_layout` converts to absolute canvas coordinates and `to_drawio` converts
   back — the single conversion point that prevents drift accumulating across round-trips.
5. **draw.io compresses by default.** When draw.io saves, it stores `<diagram>` content as
   `base64(raw-deflate(url-quote(xml)))`. Reading only plain XML means **silently returning an empty
   layout** and discarding the user's hand-made arrangement. Both forms are read here, and an
   unreadable payload raises instead of returning empty. Format details:
   [`docs/drawio-format.md`](docs/drawio-format.md).

## Documentation

| To learn about | Read |
| :--- | :--- |
| Why the design is shaped this way | [`docs/architecture.md`](docs/architecture.md) |
| Every annotation key, with types and defaults | [`docs/annotations.md`](docs/annotations.md) |
| `.drawio` mapping, routing rules, coordinate semantics | [`docs/drawio-format.md`](docs/drawio-format.md) |
| What the golden cases pin, and why they are frozen | [`docs/conformance.md`](docs/conformance.md) |
| The `ArtifactModel` JSON emitted by `inspect` | [`docs/artifact-format.md`](docs/artifact-format.md) |
| Browsing a compiled artifact in VS Code | [`docs/vscode-extension.md`](docs/vscode-extension.md)（中文） |
| Making your own C/C# build readable | [`docs/templates.md`](docs/templates.md)（中文） |
| Running the bundled sample projects | [`docs/examples.md`](docs/examples.md) |
| Building, testing, adding a language | [`docs/contributing.md`](docs/contributing.md) |
| How to implement this capability yourself | [`typescript/SKILL.md`](typescript/SKILL.md) |

## Development

```bash
cd typescript && node --test          # CLI, parsers, IR, layout, conformance
cd editors/vscode && node --test test/*.test.mjs   # extension host-free tests
```

The PE sidecar under `tools/drawcode-metadata/` is plain .NET 10 and is only built/run when
`inspect` reads a `.dll`; the rest of the toolchain needs nothing but Node 22.6+.

## Measured verification

**No number in this repository is estimated.** Every figure below was produced by running the
command in the same column.

| Claim | How it was measured | Result |
| :--- | :--- | :--- |
| TypeScript implementation is correct | `cd typescript && node --test` | **211 tests, 0 failures, 3 skipped** |
| Extension tests | `cd editors/vscode && node --test test/*.test.mjs` | **79 tests, 0 failures** |
| Compressed `.drawio` is read correctly | Read back a draw.io-compressed golden file | **nodes=6, edges=6, attrs=6** — identical to the plain form |
| Unreadable payload does not fail silently | `read_layout('<mxfile><diagram>not-a-payload</diagram></mxfile>')` | throws (never returns an empty layout) |
| Generated `.drawio` is schema-valid | XSD validation against `tools/xsd/mxfile.xsd` | **3/3 pass** (C, C#, and a waypoint-carrying diagram) |
| Idempotent round-trip | Build → sync → build, compare | **zero changes on the second sync** |
| Golden IR reproduced exactly | `dump-ir` compared byte-for-byte with `tools/golden/*/expected.ir.json` | **identical in both golden cases** |

The measured performance figures from the 2026-10 benchmark (layout quadratic in module count,
parse linear) were taken on the retired Python reference implementation; they are kept here
because the algorithms are the same, and are marked as historical rather than current.

| Claim | How it was measured | Result |
| :--- | :--- | :--- |
| Layout cost (historical, Python) | 5/10/20/40/80 modules | 0.36 s / 1.45 s / 5.89 s / 23.3 s / 95.4 s — **super-linear** |
| Parse cost (historical, Python) | same | 4.0 / 6.6 / 12.9 / 26.8 / 52.9 ms — linear |

**Parsing scales linearly while layout is quadratic.** Routing each edge tests candidate routes
against every other node, so an 80-module project spends 95 seconds on layout and 53 milliseconds on
parsing. This is stated as a characteristic, not hidden as a rounding error.

## Known limitations (listed honestly)

- **Layout is O(n²)**, so large projects are slow. No spatial index is used yet.
- **The offline renderer cannot draw `jumpStyle=arc` line jumps.** `jumpStyle` is a draw.io
  extension absent from the open-source mxGraph core. Generated files configure it correctly and the
  draw.io client honours it, but `tools/render/` will not show the jumps. Verify jumps in draw.io.
- **Swimlane container titles render centred** in the offline renderer, though they appear top-left
  in draw.io. This is a renderer limitation, not a generator bug.
- **CJK text measurement in the offline renderer is estimated.** jsdom has no layout engine and
  reports `offsetWidth = 0`, so glyph widths are approximated. Text itself renders correctly (SVG
  positioning does not depend on the measurement); label *avoidance* may be off.
- **The SVG preview does not share the `.drawio` edge routing.** Node positions are shared (both
  call the same default layout), but `svg.ts` draws edges centre-to-centre while `to_drawio` runs
  full anchor selection and obstacle avoidance. SVG edges therefore cross node shapes that the
  `.drawio` routes around. Treat the SVG as a structural read, not a faithful preview. Fixing this
  needs `to_drawio` refactored to expose edge geometry as a shared function.
- **Function bodies are never written back.** Deliberate design constraint, not a gap.
- **Mixed-language single diagrams are not symbol-resolved.** C and C# models can be merged, but a
  cross-language reference to the same name is not resolved.
- **Multi-page / multi-view, layers and tag filtering are not wired to the CLI.**
- **Geometry is frozen to the goldens.** A quicker layout algorithm is welcome only if it changes
  *how fast* geometry is computed, not *what* geometry is produced — otherwise every golden case
  diffs, and hand-made layouts stop matching.

## License

[MIT](LICENSE). Vendored third-party material is listed in [`tools/xsd/NOTICE.md`](tools/xsd/NOTICE.md).
