# Migration notes — how `drawcode` came to be laid out this way

This records **decisions**, not just file moves. Anyone can see the tree; nobody can
see why `cflow/` disappeared or why `spec/` was dissolved. That is what this file is for.

Date: 2026-10-14. All figures below were measured in this session.

## 1. `cflow` → `drawcode`

The tool was renamed and rehomed into a self-contained repository. What moved:

| Old | New | Note |
| :--- | :--- | :--- |
| `cflow/` (Python reference) | `python/src/drawcode/` | package renamed, `sys.path` and example paths rewritten |
| `cflow` test suite | `python/tests/` | 71 tests, still green after the move |
| `include/cflow_signals.h` | *(deleted)* | direction now comes from `@drawcode dir=…`; see §3 |
| `drawio-link-verify/` render scripts | `tools/render/` | distilled to `render_drawio.js` + `render_png.js` |

**Verification before deleting the originals**: the migrated Python suite ran
**71 tests, 0 failures, 0 skips**, and produced the same golden output byte-for-byte.

The two PowerShell traps hit during the migration are recorded in each language's
`SKILL.md`, because they cost real debugging time:

1. `Get-Content` / `Set-Content` round-trips mangle UTF-8 on this machine
   (a CJK third byte becomes `3F`, producing *invalid* UTF-8 that editors accept silently).
2. `[System.IO.File]` resolves relative paths against the **process** cwd, not the
   PowerShell location — so `cd foo; [IO.File]::ReadAllText("bar")` reads the wrong file.

## 2. `spec/` dissolved

`spec/` was not a fourth implementation and not an input; it was four unrelated things
sharing a directory. Each went where its semantics belong:

| Old | New | Why |
| :--- | :--- | :--- |
| `spec/conformance.md` | `docs/conformance.md` | it is a specification, i.e. documentation |
| `spec/cases/` | `tests/golden/` | these are test fixtures — they exist to fail a build |
| `spec/vendor/mxfile.xsd` | `tools/xsd/mxfile.xsd` | a vendored third-party asset used by a validator |
| `spec/dump_ir.py` | `tools/dump_ir.py` | a tool, not a spec |

**42 files** referenced these paths; all were rewritten. The tricky part was that
`spec` is also a *device attribute* (`spec="16bit/860SPS"`), so a blind search-and-replace
would have corrupted the IR schema. Replacements were anchored on full path fragments
(`"spec", "cases"`, `spec/conformance.md`, …) rather than the bare word.

The golden cases were **not** edited by hand. They were regenerated with the command
documented in `docs/conformance.md`, and the regenerated IR was verified identical to
the pre-migration golden (see §3).

## 3. Annotation syntax — breaking change

Two separate mechanisms for describing one thing were merged into one.

### C: no more header, no more macros

```c
// before
#include "drawcode_signals.h"
/// @drawcode unit="LSB" alias="原始采样值"
SIGNAL_IN(int16_t, g_raw);

// after
/// @drawcode dir=in unit="LSB" alias="原始采样值"
int16_t g_raw;
```

Direction moved from the macro name into the `@drawcode` block as `dir=in|out|io`.
C now needs **no include at all** — that was the point.

Cost, stated plainly: a macro like `SIGNAL_IN(int16_t, g_raw)` was checked by the
compiler; a comment is not. A typo in `dir=inn` is silently ignored rather than
rejected. This was a deliberate trade, accepted by the maintainer.

### C#: two annotations collapsed into one attribute

```csharp
// before
/// <drawcode alias="原始采样值" unit="LSB" />
[Signal(Direction.In)]
public static short g_raw;

// after
[Drawcode(Direction.In, Unit = "LSB", Alias = "原始采样值")]
public static short g_raw;
```

Direction stays a **positional argument** so the editor still completes `Direction.`
— that is the IntelliSense benefit that motivated keeping it typed rather than
collapsing everything into a string. Metadata became named properties.

`/// <device … />` became `[Device(…)]` for the same reason: leaving one XML-ish
comment beside a typed attribute would have been an unexplained exception.

Consequence: a C# project needs the attribute definitions. A copy ships at
`examples/small/cs/DrawcodeAttributes.cs` and is **not** an input to `drawcode` — it
declares types, it does not use them.

### Why the golden files changed, and by how much

Removing the `#include` line and collapsing two attribute lines into one shifted every
declaration's line number. The golden IR records `line`, so it had to be regenerated:

| Case | Field | Old | New |
| :--- | :--- | ---: | ---: |
| `small-c` | `g_raw` | 8 | 7 |
| `small-c` | `g_filtered` | 11 | 10 |
| `small-c` | `adc_read` | 15 | 14 |
| `small-cs` | `g_raw` | 7 | 6 |

Everything else is untouched. Verified: stripping `line` from both sides makes the
regenerated IR compare **equal** to the pre-migration golden, for both cases. And
`expected.drawio` / `preview.svg` came out at **exactly the same byte sizes**
(7113 / 3819 and 7089 / 3798) — the geometry did not move at all, which is the
strongest available evidence that the change was purely syntactic.

Two bugs were found and fixed by this exercise, both only visible in round-trip testing:

1. `re.findall` returns `''` — not `None` — for capture groups that did not
   participate, so `v if v is not None else bare` silently took the empty branch and
   every `dir=` was dropped. Caught because the parsed `dir` came back `""`.
2. The C# writer replaced the range `[head, head)` — empty — so it *inserted* a
   `[Drawcode(...)]` without removing the existing one, duplicating the attribute on
   every `sync`. Caught by `sync` not being idempotent.

A third, **pre-existing** bug surfaced while checking that the generator still worked:
`examples/large/generate.py --lang cs` emitted `F0`, `F1`, … for every module inside a
single `Drawcode.Large` namespace. Every module therefore declared the same method
names and the generated C# **could not compile**; the parser also silently collapsed
them, reporting 2 functions instead of 6 for a three-module project. Names are now
module-prefixed (`Mod000_F0`), matching the C generator's `mod000_f0`.


## 4. What was kept, and what was only recorded

The rule applied: **keep what is expensive to rebuild or is itself evidence; record
the rest and delete.**

| Kept | Why |
| :--- | :--- |
| `bench/results/*.json` | carries machine identity and toolchain versions — the evidence behind `docs/benchmark.md` |
| `tools/xsd/mxfile.xsd` | without it three XSD tests silently *skip* instead of running |
| `tests/golden/*/` | the conformance contract itself |

| Deleted | Why |
| :--- | :--- |
| `cflow/`, `drawio-link-verify/` | fully migrated and verified; originals would drift |
| `include/` | the macro header the new syntax makes unnecessary |
| `spec/` | dissolved, see §2 |
| generated `examples/large/_bench_*` | rebuilt by one command with a fixed seed (also gitignored) |
| probe scripts (`_probe*`, `_smoke`, `_dbg`) | one-shot, no reuse value |

This file is the compromise: the files are gone, the reasoning is not.
