# drawcode

**English** | [中文](README.zh-CN.md) | [Español](README.es.md)

> Turn annotated C / C# source into an editable [draw.io](https://www.drawio.com/) dataflow diagram — and read your hand-made layout back into the code. Three independent implementations: Python, TypeScript, .NET 10.

Runs on Windows, Linux and macOS. No third-party runtime dependencies in any implementation: Python 3.10+, Node 22.6+, or .NET 10 (pick one).

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
- **Three implementations, one specification.** Python, TypeScript and .NET produce byte-comparable
  geometry from the same input, validated against shared golden cases — so the performance
  comparison in [`docs/benchmark.md`](docs/benchmark.md) compares like with like.

## Quick start

```bash
git clone <this-repo> && cd drawcode

# Python - no install, run straight from the source tree
export PYTHONPATH=python/src           # Windows: $env:PYTHONPATH = "python/src"
python -m drawcode.cli build \
    examples/small/c/adc.h examples/small/c/adc.c \
    examples/small/c/dsp.h examples/small/c/dsp.c \
    --root examples/small/c \
    --out out/flow.drawio --svg out/flow.svg

# TypeScript - no install, Node >= 22.6 runs the .ts entry point directly
node typescript/bin/drawcode.ts build \
    examples/small/c/adc.h examples/small/c/adc.c \
    examples/small/c/dsp.h examples/small/c/dsp.c \
    --root examples/small/c --out out/flow-ts.drawio

# .NET 10 - build once, then run the produced dll
dotnet build dotnet/DrawCode.slnx -c Release
dotnet dotnet/src/DrawCode/bin/Release/net10.0/DrawCode.dll build \
    examples/small/c/adc.h examples/small/c/adc.c \
    examples/small/c/dsp.h examples/small/c/dsp.c \
    --root examples/small/c --out out/flow-net.drawio

# Open a .drawio in draw.io, rearrange the nodes, save, then reuse that layout
# and write the annotations back into your source:
python -m drawcode.cli build ... --layout-from out/flow.drawio --out out/flow.drawio
python -m drawcode.cli sync out/flow.drawio examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c                    # dry run: reports what would change
python -m drawcode.cli sync out/flow.drawio examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --write            # actually write
```

All three implementations emit **byte-identical** `.drawio` for the same input.
The equivalence table and the per-language test commands are in [`docs/implementations.md`](docs/implementations.md).

## Command-line usage

```
drawcode build <files...> [--root DIR] [--out FILE] [--layout-from FILE] [--svg FILE]
drawcode sync  <drawio> <files...> [--root DIR] [--write]
```

| Command | Does |
| :--- | :--- |
| `build` | Parse sources → build IR → write `.drawio`. `--layout-from` reuses an existing diagram's hand-made layout. `--svg` also emits a read-only preview sharing the same coordinates. |
| `sync` | Read `.drawio` → apply layout and annotation attributes → write the **declaration layer** back to source. Dry run unless `--write` is passed. |

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
| Measured performance, three implementations | [`docs/benchmark.md`](docs/benchmark.md) |
| How the three implementations are held to one spec | [`docs/conformance.md`](docs/conformance.md) |
| Building, testing, adding a language | [`docs/contributing.md`](docs/contributing.md) |
| How to implement this capability yourself | [`python/SKILL.md`](python/SKILL.md), [`typescript/SKILL.md`](typescript/SKILL.md), [`dotnet/SKILL.md`](dotnet/SKILL.md) |

## Development

```bash
cd python && python -m unittest discover -s tests -t .    # 124 tests
cd typescript && npm test
cd dotnet && dotnet test

pwsh bench/run.ps1                                        # three-language benchmark
```

Measured environment: Windows 11 (10.0.22621), Python 3.14.6, Node 24.16.0, .NET SDK 10.0.203.

## Measured verification

**No number in this repository is estimated.** Every figure below was produced by running the
command in the same column.

| Claim | How it was measured | Result |
| :--- | :--- | :--- |
| Python implementation is correct | `python -m unittest discover -s tests -t .` | **124 tests, 0 failures, 0 skipped** |
| Compressed `.drawio` is read correctly | Read back a draw.io-compressed golden file | **nodes=6, edges=6, attrs=6** — identical to the plain form |
| Unreadable payload does not fail silently | `read_layout('<mxfile><diagram>not-a-payload</diagram></mxfile>')` | raises `ValueError` |
| Generated `.drawio` is schema-valid | `lxml` XMLSchema against `tools/xsd/mxfile.xsd` | **3/3 pass** (C, C#, and a waypoint-carrying diagram) |
| Idempotent round-trip | Build → sync → build, compare | **zero changes on the second sync** |
| Layout cost | `bench/run.ps1`, 5/10/20/40/80 modules | 0.36 s / 1.45 s / 5.89 s / 23.3 s / 95.4 s — **super-linear, see below** |
| Parse cost, same runs | same | 4.0 / 6.6 / 12.9 / 26.8 / 52.9 ms — linear |
| Three implementations agree | `tests/golden/*/expected.{ir.json,drawio}` | see [`docs/benchmark.md`](docs/benchmark.md) |

The layout figures are the interesting result: **parsing scales linearly while layout is
quadratic.** Routing each edge tests candidate routes against every other node, so an 80-module
project spends 95 seconds on layout and 53 milliseconds on parsing. This is stated as a
characteristic, not hidden as a rounding error — the benchmark document records where the time
actually goes.

## Known limitations (listed honestly)

- **Layout is O(n²)**, so large projects are slow. No spatial index is used yet. This applies
  equally to all three implementations.
- **The offline renderer cannot draw `jumpStyle=arc` line jumps.** `jumpStyle` is a draw.io
  extension absent from the open-source mxGraph core. Generated files configure it correctly and the
  draw.io client honours it, but `tools/render/` will not show the jumps. Verify jumps in draw.io.
- **Swimlane container titles render centred** in the offline renderer, though they appear top-left
  in draw.io. This is a renderer limitation, not a generator bug.
- **CJK text measurement in the offline renderer is estimated.** jsdom has no layout engine and
  reports `offsetWidth = 0`, so glyph widths are approximated. Text itself renders correctly (SVG
  positioning does not depend on the measurement); label *avoidance* may be off.
- **The SVG preview does not share the `.drawio` edge routing.** Node positions are shared (both
  call the same default layout), but `svg.py` draws edges centre-to-centre while `to_drawio` runs
  full anchor selection and obstacle avoidance. SVG edges therefore cross node shapes that the
  `.drawio` routes around. Treat the SVG as a structural read, not a faithful preview. Fixing this
  needs `to_drawio` refactored to expose edge geometry as a shared function.
- **Function bodies are never written back.** Deliberate design constraint, not a gap.
- **Mixed-language single diagrams are not symbol-resolved.** C and C# models can be merged, but a
  cross-language reference to the same name is not resolved.
- **Multi-page / multi-view, layers and tag filtering are not wired to the CLI.**
- **Geometry equality across implementations requires porting the same algorithms.** That is the
  point — but it means a "differently optimised" implementation is only allowed to change *how fast*
  it computes, never *what* it computes.

## License

[MIT](LICENSE). Vendored third-party material is listed in [`tools/xsd/README.md`](tools/xsd/README.md).
