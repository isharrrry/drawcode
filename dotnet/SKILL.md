# SKILL: implementing a source ↔ drawio converter in .NET / C#

Audience: the next person who has to add a language front end (or port this pipeline again).
It is written from what actually broke while porting `python/src/drawcode/` to .NET 10, not from
what a tutorial says should break.

The single rule that governs everything below: **the Python implementation is the specification.**
All three implementations must produce the same geometry, because otherwise the benchmark numbers
are not comparable. Port function by function. Do not redesign the router because you think you
have a better idea — a rope that routes "more prettily" is a rope whose benchmark means nothing.

---

## 1. Module layout

`src/DrawCode/` — one file per Python module, same boundaries, same responsibilities.

| File | Python counterpart | Responsibility |
| :--- | :--- | :--- |
| `Model.cs` | `model.py` | IR types + `RebuildEdges()`. Never persisted. |
| `Text.cs` | *(none — .NET-only)* | Helpers whose "obvious" .NET equivalent is wrong: `SplitLines`, `HtmlEscape`, `Num`, BOM-preserving read. |
| `CParse.cs` | `cparse.py` | C → IR: `/// @drawcode dir=`, `/// @device`, def/use scan. Signals are plain declarations. |
| `CsParse.cs` | `csparse.py` | C# → IR: `[Drawcode(Direction.X, …)]`, `[Device(…)]`. |
| `ParseDispatch.cs` | `parse.py` | Extension dispatch and multi-language merge into one IR. |
| `Drawio.cs` | `drawio.py` | **The hard one.** IR ↔ `.drawio`: placement, routing, emit, read-back, compressed form. |
| `IrJson.cs` | `../tools/dump_ir.py` | Canonical IR JSON — the L1 comparison artefact. |
| `CodeGen.cs` | `codegen.py` | IR → source, declaration layer only. |
| `Svg.cs` | `svg.py` | IR → SVG preview. Shares **node** layout with the `.drawio`, deliberately **not** the edge router (see §7). |
| `Cli.cs` / `Program.cs` | `cli.py` | `build` / `sync` / `dump-ir`. |

Layering is one-directional: `Model` ← `{CParse, CsParse}` ← `ParseDispatch`; `Model` → `{Drawio, Svg, CodeGen, IrJson}`.

---

## 2. IR types: `class`, not `record`

```csharp
internal interface INode          // what placement and emission need from a graph node
{
    string Id { get; }
    string Group { get; set; }
    double X { get; set; }  double Y { get; set; }
    double W { get; set; }  double H { get; set; }
    bool External { get; set; }
}

public sealed class Signal : INode
{
    public required string Id { get; init; }      // identity: never changes
    public required string Name { get; init; }
    public required string CType { get; init; }
    public string Dir { get; set; } = "in";
    public string File { get; set; } = "";
    public int Line { get; set; }
    public string Unit { get; set; } = "";
    public string Alias { get; set; } = "";
    public string Note { get; set; } = "";
    public bool External { get; set; }
    public string Group { get; set; } = "";
    public double X { get; set; }  public double Y { get; set; }
    public double W { get; set; } = 160;  public double H { get; set; } = 60;
}

public sealed class Param  { required Name, CType; string Dir = "in"; }

public sealed class Func : INode
{
    required Id, Name;
    string Ret = "void";  List<Param> Params = [];  string File = "";  int Line;
    string Alias, Note, Tooltip, Asset;
    bool External;  string Group;
    List<string> Reads = [], Writes = [], Calls = [];
    double X, Y;  double W = 180, H = 72;
}

public sealed class Edge   { required Src, Dst; string Rw = "read"; List<(double X, double Y)> Waypoints = []; }
public sealed class Device { string Vendor, Model, Spec, Size, Asset; }

public sealed class Model
{
    Dictionary<string, Signal> Signals;   // keyed by "<file>::<name>"
    Dictionary<string, Func>   Funcs;
    List<Edge> Edges;                     // derived, never authored
    Dictionary<string, Device> Devices;
    List<string> Files;
    void AddSignal(Signal); void AddFunc(Func); List<Edge> RebuildEdges();
}
```

**Why `class` and not `record`:**

- The placer mutates nodes in place (`AssignDefaultPositions` writes `e.X`/`e.Y`, `apply_layout`
  overwrites geometry from a `.drawio`). Records buy value equality nobody wants here, and their
  `with`-heavy ergonomics advertise immutability the pipeline does not have.
- Identity, by contrast, *is* immutable: `Id`/`Src`/`Dst`/`Name` are `required … { get; init; }`, so
  you cannot accidentally rekey a node out from under `Dictionary` and `Edges`.
- `record` also generates `ToString`/`Equals` over the whole graph, which for a 5000-node model is
  pure cost in a hot loop.

`INode` exists because the placer/router/SVG emitter genuinely treat signals and functions
uniformly, but the rest of the code must keep them apart (different styles, labels, ports).
An interface gives exactly that seam without a base class both would have to inherit.

**Do not** replace the `Dictionary` fields with `SortedDictionary`. Python's dict preserves
*insertion* order, and several code paths depend on it (`Entities()` yields signals then funcs).
Where the reference sorts, sort explicitly at the use site (`OrderBy(e => e.Id, StringComparer.Ordinal)`).
`System.Collections.Generic.Dictionary` does **not** guarantee enumeration order, so every place
that iterates it and cares must order explicitly — this port does, deliberately.

---

## 3. Forward pipeline: source → IR → layout → drawio

```
files
  │  Text.ReadSource            UTF-8, BOM *kept* (see §5.6)
  ▼
Text.SplitLines                 Python splitlines() semantics, not String.Split('\n')
  │
  ├─ CParse.ParseProject        line scan → signals / funcs / devices; then Bodies() + DefUse()
  └─ CsParse.ParseCsProject     attribute + comment scan, same IR
  │                             (ParseDispatch.ParseAny merges by extension)
  ▼
Model                           signals, funcs, devices, files
  │  Model.RebuildEdges()       reads → Edge(sig, func, "read"); writes → Edge(func, sig, "write")
  ▼
Drawio.ToDrawio(model)
  │  1. AssignDefaultPositions  group by `group`, pack vertically (GAP_Y), separate horizontally
  │  2. GroupEntities + ContainerBox per group → one swimlane per source file
  │  3. emit containers (sorted by group name) → grp1, grp2, …
  │  4. emit nodes (sorted by symbolId) → n1, n2, …, geometry *relative to the container*
  │  5. per edge (sorted by src,dst,rw): Route() → anchors + waypoints; points *relative* too
  ▼
.drawio XML  (hand-written string; see §5.2 for why not XDocument)
```

Reverse:

```
.drawio  ──Drawio.Unpack──▶  plain <mxGraphModel> (compressed payloads expanded in place)
         ──LoadCells──▶      id → {parent, symbolId, geometry, edge flags}
         ──ReadLayout──▶     { nodes: symbolId → absolute x,y,w,h
                               edges: "src->dst:rw" → absolute mxPoint list
                               attrs: symbolId → custom properties except id/label/symbolId }
         ──ApplyLayout──▶    writes geometry onto the IR, then:
                               auto = AutoWaypoints(model)
                               for each edge: keep the file's points *unless* they equal
                               what the generator would produce — those are ours, not the
                               human's, and must be recomputed rather than frozen.
```

That last rule matters: without it, `build --layout-from old.drawio` treats the previous run's
auto-generated bends as hand-made edits, and the routing can never improve.

### Layout and routing constants (copy them exactly)

```
PAD = 30   HEADER = 30   GAP_Y = 40   DETOUR = 15   SLACK = 2   SHRINK = 3
```

Anchor sets, tried **in this order**:

```
(1,.5 → 0,.5)  (0,.5 → 1,.5)  (.5,1 → .5,0)  (.5,0 → .5,1)
(1,.5 → 1,.5)  (0,.5 → 0,.5)  (.5,0 → .5,0)  (.5,1 → .5,1)
```

Route scoring is `total |Δx| + |Δy|` with a **strict `<`** comparison, so when two candidates tie
the **earlier one wins**. Candidate generation order inside `Candidates()` is therefore
load-bearing: gap route → horizontal-then-vertical → vertical-then-horizontal → same-side lane →
lane-offset pair. Reorder them and every tie in the reference diagram flips.

Obstacle list is **all** entities — including the edge's own source and target. `Crosses()`
shrinks each end by `SHRINK` so landing on a border is not a hit, while crawling *along* a border
for more than 3px is.

---

## 4. Testing

```bash
cd dotnet
dotnet test DrawCode.slnx            # 78 tests, 0 skipped
dotnet build DrawCode.slnx -c Release   # 0 warnings, 0 errors
```

`tests/DrawCode.Tests/ConformanceTests.cs` is the one that matters. It reads `../tests/golden/**` and
asserts four separate levels:

| Level | Assertion | Golden |
| :--- | :--- | :--- |
| L1 | structural JSON equality of the IR | `expected.ir.json` |
| L2 | container/node/edge sets **and nesting** | `expected.drawio` |
| L3 | every geometry value, anchor quadruple and `mxPoint` list | `expected.drawio` |
| L4 | `.drawio` validates against `../tools/xsd/mxfile.xsd` | `../tools/xsd/mxfile.xsd` |

Report failures **per level**. "output differs" is not a bug report: L1 failing means the parser,
L2 means container assignment, L3 means layout or routing.

`TestPaths` resolves the repo root from `[CallerFilePath]` and **throws** when a golden file is
missing. Never relax that into a skip — a skipped conformance test makes an unverified
implementation look verified. If your grader is green while `tests/golden/` is absent, your grader is lying.

Comparison is structural, never byte-wise (`../docs/conformance.md`): attribute order is irrelevant,
numbers compare by value, `<mxPoint>` values are normalised to absolute canvas coordinates first,
and cell ids (`n1`, `e1`, `grp1`) are not part of the contract — compare the `symbolId` → geometry
mapping instead.

> This port currently also happens to be byte-identical to both goldens. That is a happy accident
> of emitting strings by hand; **do not** assert byte equality in the test suite, or a future
> Python formatting tweak will fail a correct C# implementation.

---

## 5. .NET / C# pitfalls actually hit during this port

### 5.1 `string.Format` has no `%s` — it is `{0}`

This bit the port while the C# annotation was still a `/// <drawcode %s />` comment: porting that
format string verbatim into `string.Format(CultureInfo.InvariantCulture, …, body)` silently emits
the literal `%s`, because `string.Format` finds no placeholder — it formats nothing and **throws no
error**. The symptom was a C# annotation that round-tripped without its `unit="mV"`.

The annotation surface has since moved to `[Drawcode(...)]` attributes and no longer goes through
`string.Format`, but the trap is generic: **never carry a Python `%`-style format string across the
port.** Check every interpolated string you translate.

Grep your port for `%s`, `%d`, `%(name)s` after transcribing any format string.

### 5.2 `XDocument` serialisation will not match Python `ElementTree`

Do **not** emit `.drawio` through `XDocument`/`XElement`. Differences that will bite:

- `XDocument.ToString()` prepends `<?xml version="1.0" encoding="utf-8"?>`; the golden files have
  no declaration. (`XElement.ToString()` does not add one — a trap in the other direction.)
- ElementTree writes attributes in insertion order; LINQ-to-XML makes no ordering promise.
- Self-closing tags become `<mxCell … />` in both, but whitespace and indentation differ.
- LINQ-to-XML escapes `'` and some control characters differently.

**Parse with `XDocument` (it is excellent at that), emit by hand with `StringBuilder`.** Every
character in `Drawio.ToDrawio` — including the odd indentation of the `<Array as="points">` block,
which is intentionally misaligned to match Python's triple-quoted template — is deliberate.

```csharp
return "<mxfile host=\"app.diagrams.net\" agent=\"drawcode\" type=\"device\">\n"
     + "  <diagram id=\"drawcode\" name=\"dataflow\">\n"
     + …
```

If you must serialise, `SaveOptions.DisableFormatting` still leaves the declaration when you call
it on an `XDocument`, and `XmlWriterSettings { OmitXmlDeclaration = true }` is the reliable route.

### 5.3 Floating point: culture, and integral-vs-decimal spelling

Python's `_num`:

```python
v = float(v)
return str(int(v)) if v == int(v) else repr(v)
```

```csharp
internal static string Num(double v)
{
    if (double.IsFinite(v) && v == Math.Floor(v) && v >= long.MinValue && v <= long.MaxValue)
        return ((long)v).ToString(CultureInfo.InvariantCulture);
    return v.ToString("R", CultureInfo.InvariantCulture);
}
```

- `CultureInfo.InvariantCulture` is not optional. On a `de-DE` machine `(1.5).ToString()` yields
  `"1,5"` and your `.drawio` becomes unparseable. Same for `double.Parse`: always
  `NumberStyles.Float, CultureInfo.InvariantCulture`.
- `"R"` (round-trip) is the closest thing to Python's `repr` shortest-form. It is not identical for
  exponentials: `repr(1e-5) == '1e-05'` but `(1e-5).ToString("R") == "1E-05"`. Irrelevant for
  pixel coordinates, fatal for anything scientific.
- `v == Math.Floor(v)` handles `-0.0` the same way Python's `int(-0.0)` does (both print `0`).
- Long.MaxValue guard: Python's `int()` is arbitrary precision, `(long)` is not.

### 5.4 HTML escaping: `&#x27;`, not `&#39;`

`html.escape(s, quote=True)` escapes `'` as `&#x27;`. `System.Net.WebUtility.HtmlEncode` emits
`&#39;`. `System.Security.SecurityElement.Escape` is a third answer again. Write it yourself:

```csharp
case '&': sb.Append("&amp;"); break;
case '<': sb.Append("&lt;");  break;
case '>': sb.Append("&gt;");  break;
case '"': sb.Append("&quot;"); break;
case '\'': sb.Append("&#x27;"); break;   // NOT &#39;
```

Order matters: escape `&` first, or you double-escape the others.

### 5.5 `Regex` differences

- **Named groups are `(?<name>…)`, not `(?P<name>…)`.** Python's spelling throws
  `InvalidOperationException: unrecognized grouping construct` in .NET — it is at least loud.
- **`re.match` anchors at the start; `Regex.Match` searches.** A pattern with a leading `^` used
  through `Regex.Match` behaves like `re.match` (without `RegexOptions.Multiline`, `^` is the string
  start). For Python `re.search`, drop the `^`. Getting this backwards makes a parser that accepts
  `foo bar()` starting mid-line.
- `\w`, `\s`, `\d` are Unicode-aware in both, but the letter categories are not identical. Fine for
  ASCII identifiers; do not rely on it for identifier validation of non-Latin source.
- `RegexOptions.Singleline` is Python's `re.S` (`.` matches newline). `RegexOptions.Multiline` is
  Python's `re.M` — different flag, commonly confused.

### 5.6 Reading source: BOM, and `newline=""`

```csharp
using var reader = new StreamReader(
    path,
    new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
    detectEncodingFromByteOrderMarks: false);   // ← keeps U+FEFF in the text
```

`File.ReadAllText(path)` strips a BOM. Python's `open(p, encoding="utf-8")` does **not** — the BOM
lands in the first line, and `"\uFEFF#ifndef ADC_H"` will not match `^#ifndef`. If your port
"cannot find" the first declaration in a BOM'd file, this is why.

Writing: `new UTF8Encoding(false)` with no newline translation, matching `open(..., "w", newline="")`.

`String.Split('\n')` is **not** Python's `splitlines()`: Python also breaks on `\v`, `\f`, `\x1c`,
`\x1d`, `\x1e`, `\x85`, `\u2028`, `\u2029`, and a trailing break produces no trailing empty
element. `Text.SplitLines` does this properly. It rarely matters for source code, and matters
immediately the day someone pastes a form feed.

### 5.7 ASCII vs raw deflate — the compressed-diagram trap

draw.io writes `<diagram>` content as `base64(raw-deflate(percent-encode(xml)))`. The `-15` window
in Python's `zlib.decompress(data, -15)` means **raw** deflate: no zlib header, no adler32.

```csharp
using var deflate = new DeflateStream(input, CompressionMode.Decompress);   // ✅
using var deflate = new ZLibStream(input, CompressionMode.Decompress);      // ❌ expects a header
```

`ZLibStream` is the intuitive choice and is wrong here; it fails with "invalid data" on exactly the
files draw.io produces. Corollary: an implementation that only reads plain XML will return an
**empty layout without error** after a user saves in draw.io, silently discarding their hand-made
layout. `Drawio.Unpack` therefore **throws** on an unrecognisable payload instead of returning
nothing.

Percent-decoding is also not `Uri.UnescapeDataString`: Python's `urllib.parse.unquote` leaves a
stray `%` literal and replaces invalid UTF-8 with U+FFFD rather than throwing. `PercentDecode` walks
bytes by hand.

### 5.8 Python negative indexing when porting line scanners

`codegen.py` contains `attr_idx = i - 1 if CS_ATTR_RE.match(lines[i - 1]) else None`. At `i == 0`
Python reads `lines[-1]` — the **last** line of the file. .NET throws
`ArgumentOutOfRangeException`. Reproduce it explicitly:

```csharp
private static string AtLine(IReadOnlyList<string> lines, int idx) =>
    idx >= 0 ? lines[idx] : lines[lines.Count + idx];
```

This kind of thing is invisible in tests until the very first line of a file happens to matter.

### 5.9 `Select(...).ToList()` produces the wrong runtime type for pattern matching

```csharp
var edges = model.Edges.Select(e => Map(...)).ToList();   // List<SortedDictionary<string, object?>>
var edges = model.Edges.Select(e => (object?)Map(...)).ToList();   // List<object?> ✅
```

A `switch` on `case List<object?> list` matches on the *runtime* generic type, so the first form
fell through to `default` and threw `unsupported JSON node: List\`1[SortedDictionary\`2[...]]`.
Cast inside the selector.

### 5.10 `internal` is invisible to the test project

```xml
<ItemGroup>
  <InternalsVisibleTo Include="DrawCode.Tests" />
</ItemGroup>
```

Prefer this over making everything `public`. (The assembly name must match exactly.)

### 5.11 A field can shadow the class you are calling

```csharp
private static readonly string Svg = Svg.ToSvg(M);   // CS1061: 'string' has no 'ToSvg'
```

C# resolves `Svg` to the field inside the initialiser. Name the field `SvgText`.

### 5.12 Treat warnings as errors, or you will not have zero warnings

```xml
<TreatWarningsAsErrors>true</TreatWarningsAsErrors>
<Nullable>enable</Nullable>
```

With nullable reference types on, `Cell.Element = null!`-style initialisers and
`out var` patterns need real attention; the compiler will tell you where.

### 5.13 Test frameworks and the process temp directory

- `xunit` does not participate in `ImplicitUsings`; add `global using Xunit;`.
- `Path.GetTempPath()` may be unwritable in a sandboxed agent environment. `Fixture.ScratchRoot`
  puts throwaway copies under `dotnet/.tmp/tests/` instead — which also keeps the "never touch
  anything outside `dotnet/`" promise when the tests copy golden inputs.

### 5.14 Do not let golden inputs be writable

Write-back tests (`CodeGen.SyncSource`) rewrite files in place. Always copy the case inputs into a
scratch directory first: `tests/golden/` is read-only, and a test that edits a golden case destroys the
evidence it was supposed to check.

---

## 6. Adding a new language front end

1. **Write the parser.** New file `src/DrawCode/<Lang>Parse.cs`, mirroring `CParse.cs`. It must
   produce the same `Model`: `Signal` for declared globals with a direction, `Func` for callables,
   `Param` for parameters (ports — never nodes), `Device` for attached metadata.
2. **Get direction from the surface syntax**, not from a heuristic: C reads the bare `dir=` key of
   the `/// @drawcode` block, C# reads the positional `Direction.X` argument of `[Drawcode(...)]`.
   Whatever the language has, map it into `in`/`out`/`inout` (`io` is the C spelling for `inout`).
3. **Reuse `CParse.DefUse`** for `reads`/`writes`/`calls`. If the language's statement syntax
   differs enough, write a sibling `DefUse`; do not fork the *semantics* (locals must stay out of
   the graph, compound assignment reads **and** writes its target, array-element writes count as
   writes to the signal).
4. **Call `model.RebuildEdges()`** at the end. Never construct `Edge` directly — edges are derived.
5. **Register the extension** in `ParseDispatch`: add to `CsExt`/`CExt` or introduce a new list, and
   add a branch that calls your parser. Merging is by dictionary union, so identical symbol ids from
   two languages collide — that is why cross-language symbol resolution is still an open item.
6. **Teach `CodeGen.SyncSource`** the language's declaration syntax: `<path.EndsWith(".rs")>` →
   your `SyncXSource`. Emitting C `/// @drawcode` blocks into a Rust file is the single worst failure
   mode here. Function bodies are never rewritten — keep it that way.
7. **Add tests**: a parse test asserting signals/funcs/edges/params/def-use, and a round-trip test
   (parse → emit → parse → sync → sync again is a no-op).
8. **Add a golden case** under `../tests/golden/<name>/` — but `tests/golden/` is owned by the spec maintainer.
   Produce the expected files, then **ask**; do not commit goldens you generated from your own
   implementation, or you have written a test that asserts you are right.

---

## 7. Things that are deliberately *not* done here

- **SVG edge routing is simplified, and that is the spec.** `../docs/conformance.md` records this as a
  known divergence: the preview shares the *node* layout with the `.drawio` (both call
  `AssignDefaultPositions`) but **not** the router. `Svg.EdgePoints` draws centre-to-centre through
  whatever waypoints exist, so SVG edges visibly cross node shapes while `.drawio` edges do not.
  The SVG is a quick structural read, **not** a faithful preview. Do not "fix" it by calling
  `Route()` from the SVG emitter — that would change the artefact the other two implementations
  produce, and SVG conformance tests must not assert edge geometry. Making the preview faithful
  requires refactoring `to_drawio` to expose edge geometry as a shared function, which is a
  spec-level change, not a port decision.
- **Function bodies are never written back.** Not a missing feature — a design constraint. The
  diagram is a derived view; semantics live in code.
- **No NuGet runtime dependencies.** `System.Xml.Linq`, `System.Text.Json`, `System.Xml.Schema`,
  `System.IO.Compression` cover everything. Only the test project takes packages.
- **Layout is not stored in source.** Coordinates are view state; putting them in `.c` files turns
  every drag into diff noise. They live in the `.drawio`, which is both a derived artefact and the
  layout carrier.
