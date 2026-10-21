---
type: Guide
title: Examples
description: The small, medium and plain sample projects, the hand-drawn drawio fixture, and how to run them
tags: [examples, samples]
status: stable
---

# Examples

**English**

[← Documentation index](index.md)

`examples/` holds hand-written sample projects. They are small enough to read in full, and they
double as regression fixtures. This page replaces `examples/README.md`, `examples/medium/README.md`
and `examples/plain/README.md` (consolidated 2026-10-21).

## `small/` — two modules, annotated

The teaching example and the fixture for most tests.

| Path | Content |
| :--- | :--- |
| `small/c/` | `adc.h` / `adc.c` / `dsp.h` / `dsp.c` — two modules, 3 signals, 3 functions, 6 edges |
| `small/cs/` | `Adc.cs` / `Dsp.cs` — the same model expressed with `[Drawcode(...)]` attributes |

They are small on purpose: small enough to read in full and reason about, which makes them useful as
a regression fixture. `tools/golden/small-c/` and `tools/golden/small-cs/` are self-contained copies
with expected output, used as the conformance golden cases.

```bash
# C
node typescript/bin/drawcode.ts build examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --out out/flow-c.drawio --svg out/flow-c.svg

# C# — pass only Adc.cs and Dsp.cs; DrawcodeAttributes.cs is a type declaration
node typescript/bin/drawcode.ts build examples/small/cs/Adc.cs examples/small/cs/Dsp.cs \
    --root examples/small/cs --out out/flow-cs.drawio --svg out/flow-cs.svg
```

## `medium/` — three modules, cross-module flow

The next size up: cross-module signal flow, an array signal and two devices, still small enough to
read in one sitting.

```
adc ──g_raw──▶ filter ──g_filtered──▶ link
 │                                       │
 └──────────── control_step ─────────────┘
```

| Path | Content |
| :--- | :--- |
| `medium/c/` | `adc` / `filter` / `link` — 6 signals, 7 functions, 12 edges, 2 devices |
| `medium/cs/` | the same graph in C# (`Adc.cs` / `Filter.cs` / `Link.cs`) |

| Module | Signals | Notes |
| :--- | :--- | :--- |
| `adc` | `g_raw` (out), `g_gain` (in), `g_sample_rate` (in) | device `ADS1115`, pinned position via `xy`/`size` |
| `filter` | `g_filtered` (out), `g_coeff[16]` (in) | array signal — `ctype` becomes `float[16]` (C) / `float[]` (C#) |
| `link` | `g_tx_frame[8]` (out) | device `FT232H`, `control_step` calls across all three modules |

Both languages describe the same graph, so `drawcode build` over either directory produces the same
shape.

```bash
# C
node typescript/bin/drawcode.ts build examples/medium/c/*.h examples/medium/c/*.c \
    --root examples/medium/c --merge --out medium-c.drawio

# C#
node typescript/bin/drawcode.ts build examples/medium/cs/Adc.cs examples/medium/cs/Filter.cs \
    examples/medium/cs/Link.cs --root examples/medium/cs --merge --out medium-cs.drawio
```

`examples/medium/cs/DrawcodeAttributes.cs` is the copy of the attribute definitions your project
needs (`DrawcodeAttribute`, `DeviceAttribute`, `Direction`). C needs no header at all — direction
lives in the `@drawcode` comment.

> Pass only `Adc.cs`, `Filter.cs` and `Link.cs` to `drawcode build`.
> `DrawcodeAttributes.cs` is a type declaration — it carries no `[Drawcode(...)]` usage and is not
> an input.

## `plain/` — no metadata, manual artifact checks

`plain/c/` and `plain/cs/` deliberately contain no `[Drawcode]` / `[Device]` attributes,
`DrawcodeMeta.h` / `.c`, or `@drawcode` comments. The artifact has no `dc_meta_entries` section, so
the reader falls back to the symbol table (C/ELF) or plain .NET metadata (C#): a "show what you can
read" browsing mode.

Sources and build scripts are committed; build outputs are ignored by `.gitignore` but kept in the
working tree for manual verification.

```bash
# C — needs a GCC that produces ELF; on this machine a Linux cross toolchain is used
cd examples/plain/c
make -B

# C# — a plain class library with no reference to the attribute file
dotnet build examples/plain/cs -c Debug
```

Four-way comparison:

| Version | Artifact | Expected |
| :--- | :--- | :--- |
| C with metadata | `templates/c/example/app.out` (plus `libapp.so` / `libapp.a` / `app.o`) | `hasMetadata=true`; module `app::demo`; 2 signals, 2 functions, 3 explicit edges |
| C without metadata | `examples/plain/c/plain.out` (plus `libplain.so` / `libplain.a` / `sensor.o`) | `hasMetadata=false`; module `plain::plain`; 2 signals (no direction), 3 functions, 5 inferred read edges |
| C# with metadata | `tools/golden/small-cs/bin/Debug/net10.0/small-cs.dll` | `hasMetadata=true`; `AdcModule` / `DspModule`; 3 signals with in/out, 3 functions, 6 explicit edges |
| C# without metadata | `examples/plain/cs/bin/Debug/net10.0/plain-cs.dll` | `hasMetadata=false`; `Sensor` / `Filter` type modules; 4 signals (no direction), 4 functions, 7 inferred edges |

Additional details:

- `sensor.o`: an unlinked object file — 2 functions, 2 signals, 3 inferred edges.
- `libplain.a`: each member becomes its own module (`libplain/main::main`, `libplain/sensor::sensor`).
- `libplain.so` and `plain.out` are linked with `-Wl,--emit-relocs`, preserving `.rela.text`, which is
  how "this function touched that signal" is inferred. ELF cannot distinguish reads from writes, so
  every inferred edge is recorded as `read`.
- Without metadata the view checks "show empty modules" by default; C# type and namespace modules are
  expanded directly, and C archive members do not disappear when their count is zero.

## `drawio/` — a real draw.io export, committed

`rack-example.drawio` is a genuine draw.io export (Electron 16.5.1, three pages, compressed
payload), kept as the fixture for what `--layout-from` must **reject**.

It contains only bare `<mxCell>` elements, with no `<object symbolId="…">` wrapper, so it carries
none of drawcode's node identity and cannot supply a layout. Feeding it to `--layout-from` used to
place every node at `0,0` without a word; it now exits with an explanation. Locked in by the
`cli: a hand-drawn drawio cannot supply a layout` test in
[`typescript/test/cli.test.ts`](../typescript/test/cli.test.ts).

## Scale fixtures

The generator that produced the 5/10/20/40/80-module synthetic projects (`large/`) was retired on
2026-10-21 together with the Python/.NET implementations and the benchmark harness; it remains in
git history. The measured cost curve it produced — parsing linear, layout quadratic — is recorded as
historical data in [`README.md`](../README.md#measured-verification).
