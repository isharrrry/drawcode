---
type: Guide
title: Contributing
description: Environment, running the tests, regenerating golden cases, adding a source language, and the list of what has deliberately not been verified
tags: [contributing, testing, benchmark, workflow]
status: stable
---

# Contributing

**English** | [中文](contributing.zh-CN.md) | [Español](contributing.es.md)

[← Documentation index](index.md)

`drawcode` holds three independent implementations to byte-comparable output. That makes contribution rules stricter than usual in one direction — **you may change how fast something is computed, never what is computed** — and laxer in another: any implementation may be written in its own idiom as long as the output matches.

## Environment

| Toolchain | Version required | Used for |
| :--- | :--- | :--- |
| Python | 3.10 or newer (`requires-python = ">=3.10"`) | the reference implementation, the golden-case dumper |
| Node | 18 or newer | the TypeScript implementation, `tools/render/` |
| .NET SDK | 10 | the .NET implementation and its test project |
| PowerShell | 5.1 or newer (`#Requires -Version 5.1`) | `bench/run.ps1` |

**The three implementations have zero third-party runtime dependencies.** Parsing, layout, routing and XML writing use only each language's standard library. This is not asceticism: the benchmark in [`docs/benchmark.md`](benchmark.md) compares three implementations doing the same work, and a dependency that does work for one of them would make the numbers incomparable. Adding a runtime dependency to `python/`, `typescript/` or `dotnet/` is a behavioural change, not a convenience.

**Test dependencies are separate and optional.** The Python suite uses `lxml` to validate generated files against the official schema at [`tools/xsd/mxfile.xsd`](../tools/xsd/mxfile.xsd). Without `lxml` those three tests **skip** rather than fail; see [What is deliberately not verified](#what-is-deliberately-not-verified).

## Repository map

| Path | Contains |
| :--- | :--- |
| [`examples/`](../examples/) | sample projects in C and C#, including the three-module `medium/` case |
| [`python/src/drawcode/`](../python/src/drawcode/) | the reference implementation — eight modules |
| [`python/tests/`](../python/tests/) | the Python test suite |
| [`python/SKILL.md`](../python/SKILL.md) | porting and extension guide for this implementation |
| [`typescript/`](../typescript/) | the TypeScript implementation |
| [`dotnet/`](../dotnet/) | the .NET 10 implementation |
| [`conformance.md`](conformance.md) | how agreement between implementations is measured |
| [`tests/golden/`](../tests/golden/) | golden cases: input sources, expected IR, expected diagram |
| [`tools/dump_ir.py`](../tools/dump_ir.py) | regenerates the parse-level golden from the Python implementation |
| [`tools/xsd/mxfile.xsd`](../tools/xsd/mxfile.xsd) | the official draw.io schema, vendored so tests never skip |
| [`examples/small/`](../examples/small/) | the sample C and C# projects used everywhere |
| [`examples/large/generate.py`](../examples/large/generate.py) | generates scaled-up sample projects for the benchmark |
| [`bench/run.ps1`](../bench/run.ps1) | the three-language benchmark |
| [`tools/render/`](../tools/render/) | offline `.drawio` → SVG → PNG rendering |

## Running the tests

```bash
cd python && python -m unittest discover -s tests -t .    # reference implementation

cd typescript && npm test                                  # see typescript/ for build steps
cd dotnet && dotnet test                                   # see dotnet/ for build steps
```

A run of the Python suite in this repository:

```
Ran 124 tests in 0.556s

OK
```

The suite is organised to make a failure name its layer, matching the four comparison levels in [`conformance.md`](conformance.md):

| Area | What it covers |
| :--- | :--- |
| C parsing | macro direction, annotation keys, array declarators, comment-block boundaries |
| C# parsing | `[Drawcode]` and `[Device]` attribute binding |
| IR and edges | edge derivation from `reads`/`writes`, merge behaviour |
| `.drawio` read/write | round-trip of coordinates, waypoints, attributes; both storage forms |
| Code generation | declaration-layer write-back, and that function bodies are untouched |
| Schema validation | generated output against the vendored official XSD |
| End-to-end | build → sync → build leaves the source unchanged |
| SVG preview | node coordinates and text, compared structurally |

**A skipped test is worse than a failing one.** A test that skips makes an unverified implementation look verified, so conformance resources are vendored into the repository rather than fetched from a sibling checkout, and a missing golden file must fail loudly. The same rule applies to the TypeScript and .NET runner: if they cannot find a golden case, they must report an error, not pass.

## Running the benchmark

```bash
pwsh bench/run.ps1
```

On Windows, the script's own header recommends the explicit form, because the default execution policy blocks unsigned local scripts:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File bench/run.ps1
```

Useful parameters:

| Parameter | Default | Meaning |
| :--- | :--- | :--- |
| `-Sizes` | `s,m,l` | which scale presets to run |
| `-Langs` | `python,typescript,dotnet` | which implementations to measure |
| `-Repeat` | `3` | runs per combination; the **median** is reported |

Each run generates the sample sources first — deterministically, since the generator's parameters and RNG seed are fixed — and then times the whole `parse → IR → .drawio` pipeline **including process startup**, because that is what a user actually experiences.

Two constraints worth knowing before you read a result table:

- **Scale presets are built into the script.** The `$Scale` table defines `s = 5 modules`, `m = 10`, `l = 20`, each with 10 signals and 6 functions per module. A size not in that table is rejected with `unknown size`. Measuring a different scale means editing the table.
- **An implementation that is not built is reported as `SKIP (not built)`, not as a failure.** Readiness is tested by file existence: `python/src/drawcode/cli.py`, `typescript/dist/cli.js`, `dotnet/src/DrawCode/bin/Release/net10.0/DrawCode.dll`. A result row with `median_ms = $null` and `note = "not built"` is a build-order problem, not a performance finding.

Results are written to `bench/results/bench-<timestamp>.json` alongside the machine and toolchain versions, which is what makes a historical number reproducible rather than anecdotal.

## Adding a golden case

A golden case is a self-contained directory under `tests/golden/<name>/` holding inputs and expected outputs for both comparison levels:

```
tests/golden/small-c/
├── input/                 # the sources
├── expected.ir.json       # L1 — parse-level golden
├── expected.drawio        # L2 + L3 — structure and geometry golden
└── preview.svg            # SVG golden, compared structurally
```

The IR golden is produced by [`tools/dump_ir.py`](../tools/dump_ir.py), not by hand:

```bash
python tools/dump_ir.py tests/golden/small-c/input tests/golden/small-c/expected.ir.json \
    tests/golden/small-c/input/adc.h tests/golden/small-c/input/adc.c \
    tests/golden/small-c/input/dsp.h tests/golden/small-c/input/dsp.c
```

Its first two arguments are the root and the output path; the rest are input files. Note what the dumper deliberately leaves out: **it records no layout coordinates**. Layout is the `.drawio` layer's business, and mixing the two would make a routing bug look like a parser bug. Keep that separation when you extend it.

`expected.drawio` is generated by an implementation, then reviewed and committed — so regenerating it is a deliberate act that shows up as a diff. **Regenerate goldens only for an intentional behaviour change**, and say in the commit message which level moved. If a golden changes and you cannot name the reason, the change is a regression.

## Adding a source language

The full walkthrough is in [`python/SKILL.md`](../python/SKILL.md) section 8; the short version:

1. Add a parser module next to `cparse.py` — for a Rust front end, `rsparse.py` — exposing `parse_rs_project(paths, root) -> Model`.
2. **Reuse the existing IR.** Do not invent parallel data structures; three-way agreement depends on all front ends producing the same `Model`.
3. Decide how the language spells direction. C uses a `dir=` key in a comment, C# uses a positional attribute argument; a Rust front end might use `#[drawcode(dir = "in")]`.
4. Dispatch on file extension in `parse.py`.
5. Add the matching write-back function in `codegen.py` for the declaration layer, and dispatch it from `sync_source`.
6. Add a sample project under `examples/small/<lang>/` plus tests; add a golden case under `tests/golden/` if the syntax shape is new.
7. Update the capability list in [`conformance.md`](conformance.md).

**The one thing not to do: never add a language branch to `drawio.py`.** A diagram is a picture of the IR, and the IR is language-agnostic. The moment a language check appears in the layout layer, the three implementations can no longer share one routing specification, and the benchmark stops meaning anything.

## The geometry contract

Because geometry is compared exactly, changes to the router propagate to all three implementations at once. When you change `_route`, `_candidates`, `_cross_gap` or `_assign_default_positions` in one implementation:

1. Port the same change to the other two.
2. Regenerate the affected golden `.drawio` files.
3. Re-run the benchmark and record it, since routing cost is what dominates large inputs.

Adding a spatial index that speeds up obstacle queries is allowed and welcome. Making the router produce *different* edges is not, even if they look better — it breaks comparability. If a routing improvement is genuinely wanted, it is a specification change, and all three implementations move together.

## What is deliberately not verified

Stated here rather than discovered by a contributor halfway through a change.

| Not verified | Why, and what it means for you |
| :--- | :--- |
| **The TypeScript and .NET test suites are not asserted here.** | This document reports a Python run only. Treat the other two as trustworthy exactly to the extent their own suites pass; see their directories for entry points and status. |
| **Schema validation is conditional on `lxml`.** | Without it, three tests skip. They were made unconditional by vendoring the XSD, but the library itself is still optional, so a bare environment silently loses that coverage. |
| **The offline renderer cannot draw `jumpStyle=arc`.** | `jumpStyle` is a draw.io extension absent from the mxGraph core. Generated files configure it correctly; verifying the jumps requires opening the file in draw.io. |
| **CJK text measurement in the offline renderer is estimated.** | jsdom reports `offsetWidth = 0`, so glyph widths are approximated, and label *avoidance* may be off. Text rendering itself is unaffected. |
| **The SVG preview does not share the `.drawio` edge routing.** | Nodes share coordinates; edges are drawn centre-to-centre. Treat the SVG as a structural read, not a faithful preview. |
| **Only the scales in `$Scale` have presets.** | `s`, `m` and `l` are 5, 10 and 20 modules. Any other scale needs the script edited first. |
| **Mixed-language diagrams are merged, not symbol-resolved.** | A C and a C# input produce one IR, but a cross-language reference to the same name is not linked. |
| **Multi-page output, layers and tag filtering are not wired to the CLI.** | The IR can express more than the CLI currently emits. |

None of these are hidden: each one appears where a reader will actually meet it, and every "measured" figure elsewhere in this documentation came from a command that was run, never from an estimate.

## Related

- [architecture.md](architecture.md) — the layering you are extending
- [annotations.md](annotations.md) — the parser's input contract
- [drawio-format.md](drawio-format.md) — the output format you must not break
- [`conformance.md`](conformance.md) — comparison levels, normalisation, required capabilities
- [`python/SKILL.md`](../python/SKILL.md) — porting guide, including the implementation's own list of traps
