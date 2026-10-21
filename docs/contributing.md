---
type: Guide
title: Contributing
description: Environment, running the tests, regenerating golden cases, adding a source language, and what is deliberately not verified
tags: [contributing, testing, workflow]
status: stable
---

# Contributing

**English** | [中文](contributing.zh-CN.md) | [Español](contributing.es.md)

[← Documentation index](index.md)

The repository has one implementation. The rule that keeps changes reviewable is simple: **you may
change how fast something is computed, never what is computed.** A change to the IR or to geometry
shows up as a golden diff, which is exactly where it should be reviewed.

## Environment

| Toolchain | Version required | Used for |
| :--- | :--- | :--- |
| Node | 22.6 or newer | the implementation, tests, `tools/render/` |
| .NET SDK + runtime | 10 | only the PE metadata sidecar (`tools/drawcode-metadata`) |

Parsing, layout, routing and XML writing use the Node standard library only. `npm run typecheck`
needs the `typescript` devDependency; it is not on the test path. The PE sidecar is a separate
net10.0 project: without .NET 10, `inspect` reports `tool-unavailable` for `.dll` inputs, while
ELF/ar reading still works in-process.

## Repository map

| Path | Contains |
| :--- | :--- |
| [`typescript/`](../typescript/) | the implementation: `cparse.ts`, `csparse.ts`, `model.ts`, `drawio.ts`, `codegen.ts`, `svg.ts`, `cli.ts`, `artifact/` |
| [`typescript/test/`](../typescript/test/) | the test suite: unit, conformance, artifact, XSD, CLI; `node --test` from `typescript/` |
| [`editors/vscode/`](../editors/vscode/) | the custom editor, webview and Explorer commands |
| [`tools/golden/`](../tools/golden/) | golden cases: input sources, expected IR, expected diagram, preview |
| [`tools/drawcode-metadata/`](../tools/drawcode-metadata/) | .NET 10 sidecar for PE/CLI artifacts; built with `dotnet build`, published by `tools/publish-metadata-tool.mjs` |
| [`tools/xsd/mxfile.xsd`](../tools/xsd/mxfile.xsd) | the official draw.io schema, vendored so schema tests never skip; provenance in [`tools/xsd/NOTICE.md`](../tools/xsd/NOTICE.md) |
| [`tools/render/`](../tools/render/) | offline `.drawio` → SVG/PNG renderer (see [Offline rendering](#offline-rendering)) |
| [`templates/`](../templates/) | C and C# metadata templates (usage: [templates.md](templates.md), Chinese) |
| [`examples/`](../examples/) | sample projects in C and C# (walkthrough: [examples.md](examples.md)) |
| [`openspec/`](../openspec/) | change records and specifications |

Everything under `tools/` is a **repo asset, not a shipped artifact**: it is outside the npm
package, outside the runtime dependency graph, and outside the test discovery path. The two
exceptions travel with a product instead — `drawcode-metadata` is published into the VSIX by
`editors/vscode/scripts/package-vsix.mjs`, and `golden/` is read by the test suite.

## Running the tests

```bash
cd typescript && node --test                              # 211 tests, 3 skipped
cd editors/vscode && node --test test/*.test.mjs          # 79 tests
```

The suite reports failures by layer — parse, IR/edges, `.drawio` I/O, codegen, schema, SVG,
conformance — matching the levels in [`conformance.md`](conformance.md).

**A skipped test is worse than a failing one.** Conformance resources are vendored; a missing golden
file must fail loudly, not pass.

## Offline rendering

`tools/render/` turns a `.drawio` into SVG or PNG with **draw.io's own mxGraph engine**, without a
draw.io installation or a GUI. It is a manual-verification tool: it is not on the CLI path, not in
the npm package, and not part of any test.

```bash
cd tools/render
npm install

node render_drawio.js input.drawio output.svg 10      # .drawio -> SVG (mxGraph)
node render_png.js     output.svg   output.png 2022   # SVG -> PNG (resvg)

# Zoom into a region to read small text on a large diagram — only the viewBox changes
node zoom_svg.js       input.svg    zoom.svg 120 80 640 360 3
```

Re-drawing the diagram by hand was rejected: a hand-written SVG drifts on CJK line breaking, arrow
clipping, orthogonal corner rounding and label avoidance — the things mxGraph already gets right.
On Windows call `npm.cmd`, because PowerShell's default execution policy refuses `npm.ps1`.

`mxgraph@4.2.2` is deprecated upstream (jgraph archived it in favour of maxGraph). That is accepted
on purpose: the desktop client is built on the same engine, so using it is what keeps the offline
output consistent with draw.io. The risk is contained to this directory. Two limitations are real
and recorded in [What is deliberately not verified](#what-is-deliberately-not-verified): no
`jumpStyle=arc` jumps, and estimated CJK text widths. The five failures that shaped this design are
written up in [`notes/drawio-render-pitfalls.md`](notes/drawio-render-pitfalls.md).

## Adding a golden case

A golden case is a self-contained directory under `tools/golden/<name>/`:

```
tools/golden/small-c/
├── input/                 # the sources
├── expected.ir.json       # L1 — parse-level golden
├── expected.drawio        # L2 + L3 — structure and geometry golden
└── preview.svg            # SVG golden, compared structurally
```

The IR golden is produced by the CLI, not by hand:

```bash
node typescript/bin/drawcode.ts dump-ir \
    tools/golden/small-c/input/adc.h tools/golden/small-c/input/adc.c \
    tools/golden/small-c/input/dsp.h tools/golden/small-c/input/dsp.c \
    --root tools/golden/small-c/input \
    --out tools/golden/small-c/expected.ir.json
```

It deliberately records **no layout coordinates**: layout is the `.drawio` layer's business, and
mixing the two would make a routing bug look like a parser bug.

`expected.drawio` is generated by the implementation, then reviewed and committed. **Regenerate
goldens only for an intentional behaviour change**, and name the level that moved in the commit
message. If a golden changes and you cannot name the reason, the change is a regression.

## Adding a source language

1. Add a parser module next to `cparse.ts` — for Rust, `rsparse.ts` — exposing
   `parseRsProject(paths, root): Model`.
2. **Reuse the existing IR.** Do not invent parallel data structures.
3. Decide how the language spells direction (C uses `dir=` in a comment; C# uses a positional
   attribute argument).
4. Dispatch on file extension in `parse.ts`.
5. Add the matching write-back in `codegen.ts` and dispatch it from `syncSource`.
6. Add a sample under `examples/small/<lang>/` plus tests, and a golden case if the syntax is new.
7. Update the capability list in [`conformance.md`](conformance.md).

**Never add a language branch to `drawio.ts`.** A diagram is a picture of the IR, and the IR is
language-agnostic.

## The geometry contract

Geometry is compared exactly, so a router change moves the goldens. Change `route`, `candidates`,
`crossGap` or `assignDefaultPositions`, regenerate the affected `.drawio` files, review the diff,
and run the full suite. A spatial index that speeds up obstacle queries is welcome; a different
routing result is a specification change.

## What is deliberately not verified

| Not verified | Why, and what it means for you |
| :--- | :--- |
| **PE artifacts need .NET 10.** | The sidecar is a separate net10.0 project. Without it, `.dll` inspection reports `tool-unavailable`; ELF/ar reading is in-process and unaffected. |
| **The artifact model is outside the source goldens.** | `inspect` has its own tests (`artifact.test.ts`, `artifact-elf.test.ts`); L1–L3 cover the source pipeline only. |
| **The offline renderer cannot draw `jumpStyle=arc`.** | `jumpStyle` is a draw.io extension absent from the mxGraph core. Generated files configure it correctly; verify the jumps in draw.io. |
| **CJK text measurement in the offline renderer is estimated.** | jsdom reports `offsetWidth = 0`, so glyph widths are approximated and label *avoidance* may be off. |
| **The SVG preview does not share the `.drawio` edge routing.** | Nodes share coordinates; edges are drawn centre-to-centre. Treat the SVG as a structural read. |
| **Mixed-language diagrams are merged, not symbol-resolved.** | A C and a C# input produce one IR, but a cross-language reference is not linked. |
| **Multi-page output, layers and tag filtering are not wired to the CLI.** | The IR can express more than the CLI emits. |

## Related

- [`architecture.md`](architecture.md) — the layering you are extending
- [`annotations.md`](annotations.md) — the parser's input contract
- [`drawio-format.md`](drawio-format.md) — the output format you must not break
- [`conformance.md`](conformance.md) — comparison levels and normalisation
- [`typescript/SKILL.md`](../typescript/SKILL.md) — implementation guide and traps
