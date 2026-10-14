---
type: Guide
title: Implementations
description: How to build, test and invoke each of the Python, TypeScript and .NET implementations, and how they are held to identical output
tags: [implementations, python, typescript, dotnet, conformance]
status: stable
---

# Implementations

**English** | [中文](implementations.zh-CN.md) | [Español](implementations.es.md)

[← Documentation index](index.md)

`drawcode` ships the same capability three times, once per language, so the performance comparison
in [benchmark.md](benchmark.md) compares implementations rather than ecosystems.

| | Python | TypeScript | .NET |
| :--- | :--- | :--- | :--- |
| Directory | [`python/`](../python/) | [`typescript/`](../typescript/) | [`dotnet/`](../dotnet/) |
| Requires | Python 3.10+ | Node 22.6+ | .NET SDK 10 |
| Runtime dependencies | **none** (stdlib only) | **none** (no `node_modules`) | **none** (BCL only) |
| Entry point | `python -m drawcode.cli` | `node typescript/bin/drawcode.ts` | `dotnet dotnet/src/DrawCode/bin/Release/net10.0/DrawCode.dll` |
| Tests | `python -m unittest discover -s tests -t .` | `node --test` | `dotnet test dotnet/DrawCode.slnx -c Release` |
| Test count | 75 | 107 | 79 |
| Per-implementation guide | [`python/SKILL.md`](../python/SKILL.md) | [`typescript/SKILL.md`](../typescript/SKILL.md) | [`dotnet/SKILL.md`](../dotnet/SKILL.md) |

Every command in the table runs from the repository root. Each implementation directory also has a
`README.md`, and a `SKILL.md` covering the port walkthrough.

## The shared contract

All three offer the same two operations:

```
build <files...> [--root DIR] [--out FILE] [--layout-from FILE] [--svg FILE]
sync  <drawio> <files...> [--root DIR] [--write]
```

| Operation | Does |
| :--- | :--- |
| `build` | parse sources → IR → write `.drawio`. `--layout-from` reuses an existing diagram's hand-made layout; `--svg` also emits a preview. |
| `sync` | read `.drawio` → apply layout and annotation attributes → write back the **declaration layer** only. Dry run unless `--write` is given. |

## Python

Reference implementation. Standard library only, so it runs from a source checkout with no install:

```bash
export PYTHONPATH=python/src          # Windows: $env:PYTHONPATH = "python/src"
python -m drawcode.cli build examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --out out/flow.drawio --svg out/flow.svg

cd python && python -m unittest discover -s tests -t .
```

Verified: `pip install -e .` inside `python/` also exposes a `drawcode` console script, and
`drawcode --help` lists both subcommands.

## TypeScript

Lives in [`typescript/`](../typescript/).

**There is no install step and no `node_modules`.** Node 22.6 or later strips the type annotations
itself, so the `.ts` entry point is run directly and nothing is compiled to JavaScript first.

```bash
node typescript/bin/drawcode.ts build examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --out out/flow-ts.drawio

cd typescript && node --test
```

`npm run typecheck` does need an external `typescript` package, which the repository deliberately
does not vendor; it is not on the test path.

## .NET

Lives in [`dotnet/`](../dotnet/), as a `.slnx` solution targeting `net10.0`.

Build once, then run the assembly that build produces:

```bash
dotnet build dotnet/DrawCode.slnx -c Release

dotnet dotnet/src/DrawCode/bin/Release/net10.0/DrawCode.dll build \
    examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --out out/flow-net.drawio

dotnet test dotnet/DrawCode.slnx -c Release
```

Both implementations above ship a `SKILL.md` documenting the Node- and .NET-specific traps
(regex semantics, XML serialisation, no `DOMParser`; `XDocument` writing an XML declaration the
golden files do not have, `CultureInfo.InvariantCulture` for float formatting, and raw deflate
requiring `DeflateStream` rather than `ZLibStream`).

## How identity is enforced

Three implementations agreeing is not a vibe; it is a test. All three are held to
[`conformance.md`](conformance.md) and the golden cases under `tests/golden/`:

| Level | Compared | Tolerance |
| :--- | :--- | :--- |
| L1 — parse (IR) | signals, funcs, params, edges, devices, files | exact |
| L2 — graph structure | containers, nesting, node membership, edge endpoints | exact |
| L3 — geometry | node `x`/`y`/`w`/`h`, polyline points, edge anchors | exact |
| L4 — schema | validates against `tools/xsd/mxfile.xsd` | must pass |

**All three implementations reproduce the `small-c` and `small-cs` golden cases byte-for-byte** —
identical SHA256 for both `expected.drawio` and `expected.ir.json`. That is stricter than the
normalised comparison the spec requires: it is L3 geometry agreement down to the last digit, not
merely structural equality.

**A conformance runner must fail loudly when a golden file is missing rather than skipping.**
A silently skipped conformance test makes an unverified implementation look verified. This actually
happened during the project's own development: the XSD validation tests resolved the schema from a
sibling repository, so three tests skipped for anyone without that checkout. The schema is now
vendored at [`tools/xsd/mxfile.xsd`](../tools/xsd/mxfile.xsd) and all three tests execute.

## Why identical output matters more than it seems

The benchmark is only meaningful if the three implementations do the **same work**. A faster router
that draws prettier edges would post better numbers and prove nothing.

So the constraint is explicit: **optimisation may change how fast something is computed, never what
is computed.** A spatial index that speeds up obstacle queries is legitimate. A different routing
heuristic is not — it would silently turn the benchmark into a comparison of three different
programs.

This is a real limitation on how the implementations may evolve, and it is accepted deliberately.

## Related

- [`conformance.md`](conformance.md) — the full comparison specification
- [benchmark.md](benchmark.md) — measured numbers
- [architecture.md](architecture.md) — why the design is shaped this way
