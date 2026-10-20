# drawcode — .NET 10 (C#)

Source code is the single source of truth; the diagram is a derived view.

This is the C# implementation of `drawcode`, one of three parallel implementations
(Python / TypeScript / .NET) that must agree on **geometry exactly** so that their benchmark
numbers are comparable. See `../docs/conformance.md` for what "agree" means and
[SKILL.md](SKILL.md) for the porting notes and .NET pitfalls.

- **Reference implementation:** `python/src/drawcode/` — this port follows it function by function
  and does not redesign its layout or routing.
- **Target framework:** `net10.0`. .NET SDK 10.0.203 was used.
- **Runtime dependencies:** none. XML via `System.Xml.Linq`, JSON via `System.Text.Json`, schema
  validation via `System.Xml.Schema`, compression via `System.IO.Compression`. The test project
  takes xunit, and nothing else.

## Build and test

```bash
cd dotnet
dotnet build DrawCode.slnx             # 0 warnings, 0 errors
dotnet test  DrawCode.slnx             # 119 tests, 0 skipped
dotnet build DrawCode.slnx -c Release  # same, warnings-as-errors on
```

## Usage

```bash
# source code -> .drawio
dotnet run --project src/DrawCode -- build <file>... [--root DIR] [--out FILE] [--merge]
    [--svg FILE] [--inline] [--cards] [--no-rw-labels] [--straight-edges]

# reuse the hand-made layout of an existing diagram, and export an SVG preview
dotnet run --project src/DrawCode -- build adc.h adc.c dsp.h dsp.c \
    --root . --out flow.drawio --layout-from flow.drawio --svg flow.svg

# .drawio -> source code (declaration layer only; dry run unless --write)
dotnet run --project src/DrawCode -- sync flow.drawio adc.h adc.c dsp.h dsp.c --root . [--write]

# parsed IR as canonical JSON, for L1 comparison against the Python implementation
dotnet run --project src/DrawCode -- dump-ir adc.h adc.c dsp.h dsp.c --root . --out flow.ir.json
```

The build switches (`--merge`, `--inline`, `--cards`, `--no-rw-labels`, `--straight-edges`) match
the Python and TypeScript CLIs name for name and semantics; `../docs/implementations.md` spells out
what each does. With none of them passed, the output is byte-identical to the pre-switch behaviour.

What survives a round trip:

| You do this in draw.io | Result |
| :--- | :--- |
| Drag / resize a node | The next `sync --write` records `Xy` / `Size` in the declaration; subsequent `build` runs reuse that geometry |
| Drag a bend or change a connection point | Stored in `<Array as="points">`; code untouched |
| Edit `alias` / `unit` / `note` / `tooltip` | The source annotation is rewritten in place |
| Change `dir` | The `dir=` key is rewritten (`dir=in` / `dir=out` / `dir=io`), or `Direction.X` inside `[Drawcode(...)]` in C# |
| Add a variable node | A declaration is appended; `xy` / `size` and other hand-written keys are preserved |
| Edit a function body | **Never written back** — a design constraint, not a gap |

## Conformance

`tests/DrawCode.Tests/ConformanceTests.cs` reads `../tests/golden/**` and asserts four levels
separately, because "output differs" is not a useful bug report:

| Level | Compared | Result on both golden cases |
| :--- | :--- | :--- |
| **L1 — Parse (IR)** | `signals`, `funcs` (incl. `params`/`reads`/`writes`/`calls`), `edges`, `devices`, `files` | pass (byte-identical to `expected.ir.json`) |
| **L2 — Graph structure** | container set and nesting, node set and membership, edge set with `src`/`dst`/`rw` | pass |
| **L3 — Geometry** | node `x`/`y`/`w`/`h`, edge `<Array as="points">`, anchors `exitX`/`exitY`/`entryX`/`entryY` | pass (byte-identical to `expected.drawio`) |
| **L4 — Schema** | `.drawio` against `../tools/xsd/mxfile.xsd` | pass |

Comparison is structural, not byte-wise: attribute order is irrelevant, numbers compare by value,
`<mxPoint>` values are normalised to absolute canvas coordinates, and cell ids are not part of the
contract. A missing golden file **fails** the test — it is never skipped.

> Byte-identity with the goldens is a consequence of emitting XML by hand and is *not* asserted by
> the suite, on purpose: a future formatting tweak in the reference must not fail a correct port.

## Layout

```
dotnet/
├── DrawCode.slnx
├── SKILL.md                   how to port / extend this pipeline (incl. .NET pitfall list)
├── src/DrawCode/
│   ├── Model.cs               IR: Signal, Param, Func, Edge, Device, Model
│   ├── Text.cs                SplitLines / HtmlEscape / Num / BOM-preserving file IO
│   ├── CParse.cs              C  -> IR  (@drawcode dir=, @device, plain declarations)
│   ├── CsParse.cs             C# -> IR  ([Drawcode(...)], [Device(...)], [Callout(...)])
│   ├── ParseDispatch.cs       extension dispatch + multi-language merge
│   ├── Drawio.cs              IR <-> .drawio  (placement, routing, emit, read-back, compressed)
│   ├── IrJson.cs              canonical IR JSON for L1 comparison
│   ├── CodeGen.cs             IR -> source, declaration layer only (incl. Xy/Size write-back)
│   ├── Svg.cs                 IR -> SVG preview (shares node layout with .drawio, not edge routing)
│   ├── Cli.cs, Program.cs     build / sync / dump-ir
└── tests/DrawCode.Tests/      xunit: parse, drawio, codegen, edit-back, svg, conformance
```

## Notes

- `.tmp/` holds scratch directories created by the write-back tests. They are cleaned up by the
  tests; anything left behind is safe to delete.
- `dotnet/` is self-contained. Nothing outside it is read at build time except `tests/golden/`, which the
  conformance tests read read-only.
