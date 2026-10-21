---
type: Guide
title: Architecture
description: How drawcode is layered, what each module owns, and why the design refuses to persist an intermediate representation
tags: [architecture, design, ir, dataflow]
status: stable
---

# Architecture

**English** | [中文](architecture.zh-CN.md) | [Español](architecture.es.md)

[← Documentation index](index.md)

## The decision everything else follows from

`drawcode` was rewritten after a first attempt that persisted three files per project:

```
model.ir.json     semantics
views/*.json      layout + annotations
devices.json      device master data
```

The problem was not the file count. It was that **semantics existed twice** — once in the `.h`/`.c`
sources and once in `model.ir.json`. Two sources of truth drift, always. Reconciling them required
inventing `irHash`, drift detection and three-way merges. That is a debt you take on by choice.

The rewrite collapsed it to one answer:

> **The source code is the only source of truth.**

Semantics already live in the code. What was missing was only *direction* (is this signal an input
or an output?) and *annotation* (what does a human call it?). So those were moved **into the code**
as document comments and attributes, instead of being stored beside it.

## Persistent layers

| Layer | Form | Persisted | Rebuildable |
| :--- | :--- | :--- | :--- |
| Semantics — signals, functions, direction, annotations, device data | **C / C# source** | ✅ the only source of truth | — |
| IR | in-memory object graph | ❌ **never written** | rebuilt from code every run |
| Layout (coordinates, polylines, folding) + pure appearance | **`.drawio`** | ✅ derived artefact *and* layout carrier | semantics rebuildable, **hand-made layout is not** |

**Persisted data = code (1 set) + diagram (1 artefact). Persisted intermediate data = 0 sets.**

### Why layout does not go into the code

Coordinates are a view property. They do not participate in compilation, and every drag would
rewrite the `.c` file — exploding diffs and drowning code review in coordinate noise. So layout
lives in the `.drawio`, is produced by human dragging, and is read back into the IR on the next run.

This is also why the lost-layout failure mode is taken so seriously: **hand-made layout is the one
thing in this system that cannot be regenerated.** See [drawio-format.md](drawio-format.md) for the
compressed-storage trap.

## Module layering

```
                    ┌──────────────────────────────┐
   source files ───▶│ cparse.ts / csparse.ts       │  language front ends
                    │  (one per source language)   │
                    └───────────────┬──────────────┘
                                    ▼
                    ┌──────────────────────────────┐
                    │ model.ts                     │  IR (in memory only)
                    │  Signal / Func / Edge / ...  │
                    └───────────────┬──────────────┘
                                    ▼
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐         ┌──────────────────┐        ┌────────────────┐
│ drawio.ts     │         │ svg.ts           │        │ codegen.ts     │
│ IR ↔ .drawio  │         │ IR → SVG preview │        │ IR → code      │
│ layout+route  │         │ (node layout     │        │ (declaration   │
│               │         │  only, see note) │        │  layer only)   │
└───────────────┘         └──────────────────┘        └────────────────┘
        ▲                                                      │
        └──────────────────── cli.ts ──────────────────────────┘
                          build / sync
```

| Module | Owns | Does **not** own |
| :--- | :--- | :--- |
| `model.ts` | IR types and edge derivation | any I/O |
| `cparse.ts` | C syntax → IR | layout, drawing |
| `csparse.ts` | C# syntax → IR | layout, drawing |
| `parse.ts` | extension dispatch, multi-language merge | syntax details |
| `drawio.ts` | layout, routing, `.drawio` read/write | source syntax |
| `svg.ts` | SVG preview | routing (see below) |
| `codegen.ts` | declaration-layer write-back | function bodies (never) |
| `cli.ts` | argument handling, file I/O | any algorithm |

**The rule that keeps this maintainable**: `drawio.ts` contains **no language branches**. A diagram
is a picture of the IR, and the IR is language-agnostic. A language check inside the renderer would
mean the geometry golden is really two different contracts wearing one name.

## Data flow: `build`

```
files
└─ parse_any(files, root)
   ├─ dispatch by extension: .c/.h → cparse, .cs → csparse
   └─ merge into one Model, then rebuild_edges()
└─ [optional] apply_layout(model, read_layout(old.drawio))   ← reuse hand-made layout
└─ to_drawio(model) → XML
   ├─ _assign_default_positions(model)      only when there is no prior layout
   ├─ build swimlanes from directories/files, compute nesting
   ├─ each signal/function → <object> + <mxCell> + <mxGeometry>
   ├─ each edge → anchors (_endpoints/_candidates) → obstacle-aware routing (_route)
   │             → <Array as="points">
   └─ attach each edge to its innermost common container
└─ [optional] to_svg(model) → read-only preview
```

## Data flow: `sync`

```
read_layout(xml) → {nodes, edges, attrs}
├─ _unpack(xml)            expand draw.io's compressed storage form
├─ _load_cells(xml)        collect both <object> and <mxCell>
├─ _origin(cells, parent)  accumulate parent offsets → absolute canvas coordinates
└─ yields: symbolId → (x,y,w,h) / edge key → [(x,y)] / symbolId → writable attributes

apply_layout(model, layout)    hydrate layout and attributes back into the IR
sync_source(path, model, rel)  write per file
├─ .cs → sync_cs_source()
└─ otherwise → sync_header() + sync_functions()
```

Write-back touches the declaration layer only. It locates a span by scanning upward over
consecutive `///` lines (or over the attribute block), matches the declaration, replaces
that span, and leaves everything else byte-identical. `test_sync_leaves_other_code_untouched`
asserts exactly this.

## The bidirectional boundary is deliberately asymmetric

| Direction | Allowed | Forbidden |
| :--- | :--- | :--- |
| code → diagram | rebuild nodes, edges, hierarchy, annotations; idempotent | — |
| diagram → code | write back **declaration layer** only: `@drawcode`/`@device` comments (C), `[Drawcode]`/`[Device]` attributes (C#) | never rewrite function bodies; never reorder unrelated code |
| conflicts | semantic conflicts: **code wins**; layout conflicts: **diagram wins** (different dimensions, they cannot disagree) | no three-way merge |

Why so narrow in reverse? Because a diagram is a *low-fidelity* representation. It knows a function
reads `g_raw`; it does not know the loop bounds, the error handling or the arithmetic. Any tool that
writes function bodies from a picture is guessing, and guessing in a source file is unacceptable.
Restricting the reverse direction to declarations makes the operation provably safe: it can only
touch lines whose full content the diagram actually represents.

## One implementation, a frozen geometry contract

There is one implementation, TypeScript, held to the golden cases in `tools/golden/` byte-for-byte
([`conformance.md`](conformance.md)). Until 2026-10-21 two further implementations (Python and .NET)
existed and were compared against the same goldens; they were retired once the TypeScript output
proved byte-identical, and remain in git history.

The honest consequence: **optimisation may change how fast something is computed, never what is
computed.** A spatial index that speeds up obstacle queries is fine; a smarter router that produces
prettier edges is not, because it invalidates every golden and every hand-made layout recorded
against the old geometry.

### Known divergence: the SVG preview

`svg.ts` shares the **node** layout with `drawio.ts` (both call `_assign_default_positions`) but
**not the edge router**. It draws edges centre-to-centre, so they visibly cross node shapes that the
`.drawio` routes around. The SVG is a structural read, not a faithful preview. Supplying real
routing requires refactoring `to_drawio` to expose edge geometry as a shared function; until then
the simplified behaviour is deliberate.

## Artifact viewer: reading products, not sources

`drawcode inspect` reads a compiled artifact (PE/CLI, ELF, ar) and emits a model of modules, types,
signals, functions and read/write edges. The shape is familiar, but the source is different:
metadata and IL/symbols instead of text. It never loads or executes the artifact. PE metadata is
read by the bundled .NET 10 sidecar; ELF and ar are read in-process.

The VS Code extension in `editors/vscode/` is a thin client of that command. A custom read-only
editor shells out to `inspect`, posts the canonical JSON into a webview, and renders three views
(overview, module cross-links, persistent ER). It adds no parser of its own, so PE metadata has
exactly one implementation (`tools/drawcode-metadata`, built on `System.Reflection.Metadata`) and
ELF has exactly one (`typescript/src/artifact/elf.ts`).

This path deliberately stays out of the `.drawio` pipeline: no layout write-back, no `sync`, no
golden conformance levels. An artifact has no source file to write back to, and its layout is
computed for the viewer at runtime. The JSON contract is
[`artifact-format.md`](artifact-format.md).

## Related

- [annotations.md](annotations.md) — the annotation keys that carry direction and metadata
- [drawio-format.md](drawio-format.md) — mapping rules, coordinates, routing, compression
- [artifact-format.md](artifact-format.md) — the `ArtifactModel` JSON emitted by `inspect`
- [../conformance.md](conformance.md) — what the goldens pin and which behaviours they cannot see
