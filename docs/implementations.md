---
type: Guide
title: Implementation
description: How to build, test and invoke the TypeScript implementation, and what the golden cases still pin
tags: [implementations, typescript, conformance]
status: stable
---

# Implementation

**English** | [中文](implementations.zh-CN.md) | [Español](implementations.es.md)

[← Documentation index](index.md)

`drawcode` ships one implementation: TypeScript. Node runs the `.ts` entry point directly, so the
CLI has no build step and no `node_modules` on its path.

| | TypeScript |
| :--- | :--- |
| Directory | [`typescript/`](../typescript/) |
| Requires | Node 22.18+ (native type stripping) |
| Runtime dependencies | **none** (Node standard library only) |
| Entry point | `node typescript/bin/drawcode.ts` |
| Tests | `cd typescript && node --test` |
| Test count | 229 (5 skipped) |
| Guide | [`typescript/SKILL.md`](../typescript/SKILL.md) |

## Commands

```
build   <files...> [--root DIR] [--out FILE] [--merge] [--layout-from FILE] [--svg FILE]
                    [--inline] [--cards] [--no-rw-labels] [--straight-edges]
sync    <drawio> <files...> [--root DIR] [--write]
dump-ir <files...> [--root DIR] [--out FILE]
inspect <artifact> [--out FILE] [--infer-edges]
```

```bash
node typescript/bin/drawcode.ts build examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --merge --out out/flow.drawio --svg out/flow.svg

node typescript/bin/drawcode.ts sync out/flow.drawio examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c          # dry run; add --write to apply

node typescript/bin/drawcode.ts inspect tools/golden/small-cs/bin/Debug/net10.0/small-cs.dll
```

| Flag | Effect |
| :--- | :--- |
| `build --merge` | merge all modules into one diagram (default: one per module) |
| `build --layout-from FILE` | reuse the hand-made layout from an existing diagram, then rebuild from source (idempotent) |
| `build --inline` | collapse one-writer/one-reader signals into direct function-to-function edges |
| `build --cards` | render functions that carry `Asset` as image cards |
| `build --no-rw-labels` | drop the `read`/`write` labels, keep the lines |
| `build --straight-edges` | straight lines instead of orthogonal routing (see below) |
| `build --svg FILE` | also emit a read-only SVG preview |
| `sync` | diagram → source, declaration layer only; dry run unless `--write` |
| `inspect` | read `.dll` / `.so` / `.out` / `.a` / `.o` into canonical JSON; never loads or executes the target |

With `--inline` and `--layout-from` together, folding happens first and layout is applied to the
result; removed nodes must be laid out again rather than leaving holes.

## Dependencies

No runtime dependencies is a deliberate property, not an accident. Node 22.18+ strips types at load
time, so the `.ts` entry point runs without a build step or `node_modules`. The XML reader/writer and
the XSD subset validator are hand-written because the document shapes are small and the goldens are
byte-aligned; a library would bring its own quirks. `node --test` is the runner.

`@types/node` and `typescript` are devDependencies for `npm run typecheck` and editor completion
only; the test path does not load them. The one exception is `inspect` on PE/CLI files, which spawns
[`tools/drawcode-metadata`](../tools/drawcode-metadata/) — a .NET 10 sidecar outside npm. ELF and
`ar` archives are read in-process.

## Tests

`cd typescript && node --test` runs 229 tests (5 skipped). The skipped ones need something outside
the repository — a sample DLL, or a compiled `templates/c/example` — and print their reason at run
time.

## Build switches

### `--straight-edges` cannot become the default

The default is orthogonal routing. Both goldens record `orthogonalEdgeStyle` and explicit
`<Array as="points">`; changing the default would turn them red and invalidate every hand-made
layout recorded against the old geometry. The flag is therefore opt-in. Four style changes must
move together: drop `edgeStyle=orthogonalEdgeStyle`, `rounded=1` and `jumpStyle=arc`, but keep the
`exitX`/`exitY`/`entryX`/`entryY` anchors. Straight edges suit row-per-node topologies; on
band-and-card layouts they become a diagonal mesh and can cross cards and labels.

## Scope limits

- No multi-page diagrams, draw.io layers, or tag filtering: none are wired to the CLI.
- Mixed-language input is merged, but a symbol referenced across languages is not resolved.
- `npm run typecheck` needs `npm install` first; the tests do not.

## What the golden cases pin

[`tools/golden/`](../tools/golden/) holds `small-c` and `small-cs`: input sources, canonical IR,
expected `.drawio` and a preview SVG. The suite compares L1 (IR), L2 (graph structure) and L3
(geometry) exactly, and L4 (schema) against [`tools/xsd/mxfile.xsd`](../tools/xsd/mxfile.xsd).
Regenerating a golden is a deliberate act; see [contributing.md](contributing.md).

## Retired implementations

Until 2026-10 the repository also shipped independent Python and .NET implementations. They existed
to cross-check one contract and to compare performance. When the product converged on the TypeScript
implementation — the VS Code extension and the binary artifact reader — maintaining three parsers
stopped paying for itself, and both trees were removed from the working tree on 2026-10-21.

Their removal changes what is *measured*, not what is *required*: the golden cases still pin the IR
and the geometry. The retired trees remain available in git history before that date.

## Related

- [`conformance.md`](conformance.md) — what the suite compares and how
- [`artifact-format.md`](artifact-format.md) — the binary artifact model
- [`contributing.md`](contributing.md) — environment, tests and goldens
