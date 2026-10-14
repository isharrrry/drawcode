# Benchmark

**drawcode in three languages: same algorithm, same output, very different constants.**

**English** | [中文](benchmark.zh-CN.md) | [Español](benchmark.es.md)

All three implementations produce byte-identical `.drawio` output (see
[`conformance.md`](conformance.md) and `docs/implementations.md`).
This page measures what that identical work costs in each runtime.

## What is measured

The full `parse → IR → .drawio` pipeline, driven through each implementation's
own CLI, **including process startup** — because that is what a user actually
experiences when they run `drawcode build`.

Generated inputs come from [`examples/large/generate.py`](../examples/large/generate.py)
with a fixed RNG seed, so the runs are reproducible.

```
powershell -ExecutionPolicy Bypass -File bench/run.ps1 -Sizes s,m,l,xl,xxl
```

| size | modules | files | signals | funcs | edges |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `s` | 5 | 10 | 50 | 30 | 144 |
| `m` | 10 | 20 | 100 | 60 | 294 |
| `l` | 20 | 40 | 200 | 120 | 594 |
| `xl` | 40 | 80 | 400 | 240 | 1 194 |

A fifth preset, `xxl` (80 modules), exists in `bench/run.ps1` but is not measured
here — a single Python run takes about 95 s. See the extrapolation below.

Note that **edges grow linearly** with module count while **time grows
quadratically**. That is the signature of the `edges × nodes` product, and it is
the most direct evidence for the cost model.

## Results (median of 3, milliseconds)

Machine: Windows 10 (build 22631), Intel Core i5-10200H, 8 logical cores. Toolchain: Python 3.14.6, Node v24.16.0, .NET 10.0.203.

| size | modules | python | typescript | dotnet |
| :--- | ---: | ---: | ---: | ---: |
| `s` | 5 | 464.8 | 174.8 | 152.8 |
| `m` | 10 | 1 603.6 | 208.5 | 177.5 |
| `l` | 20 | 5 966.7 | 325.9 | 255.1 |
| `xl` | 40 | 23 951.4 | 791.3 | 527.8 |

Raw runs are written to `bench/results/bench-<timestamp>.json`, each carrying the
machine description and toolchain versions alongside the numbers.

## The shape of the curve

The pipeline is **quadratic in the number of nodes**, in every language. The
routing stage tests each candidate route of each edge against every other node,
so cost grows with `edges × candidates × nodes`.

Fitting `T(n) = C + k·n²` (n = modules) to the `s` and `xl` measurements:

| implementation | startup constant `C` | quadratic coefficient `k` | `m` predicted / measured | `l` predicted / measured |
| :--- | ---: | ---: | :--- | :--- |
| python | 92.0 ms | **14.91** | 1 583 / 1 604 | 6 057 / 5 967 |
| typescript | 165.0 ms | **0.391** | 204 / 209 | 322 / 326 |
| dotnet | 146.9 ms | **0.238** | 171 / 178 | 242 / 255 |

Predictions land within 1–5% of measurement at the two interpolated points,
which is why the curve is read as clean `n²` rather than "roughly super-linear".

**The three implementations are algorithmically identical — only the constant
differs.** Python's quadratic coefficient is **62.6×** .NET's and **38.1×**
TypeScript's.

That is the whole story behind the headline gap. It is not a smarter algorithm
in C# or TypeScript; it is 2.5 million interpreter-level function calls per run
being executed by a JIT instead.

### Why TypeScript and .NET *look* flat at small sizes

Their growth ratios (1.19×, 1.56×, 2.43× from TypeScript, for a doubling of
module count each time) are far below the 4× a quadratic would give. That is
not sub-quadratic behaviour — it is ~150 ms of process startup swamping a
quadratic term that is still only tens of milliseconds at these sizes.

Extrapolating with the fitted model reproduces the table in the README:

```
python @ 80 modules = 92.0 + 14.91 × 6400 ≈ 95 500 ms ≈ 95.4 s
```

## Where the time goes

`cProfile` on the Python implementation at `m` (10 modules):

```
2 482 500 calls   drawio.py:131(_crosses)   3.37 s cumulative   (69%)
      294 calls   drawio.py:152(_route)     4.81 s cumulative
```

`_crosses` — the segment-versus-rectangle obstacle test — is called 2.5 million
times for what is a 294-edge diagram. That single function is the hotspot, and
it is the one place where an algorithmic improvement would pay off in all three
languages.

## What this means for "optimised versions"

The three implementations are deliberately **reference-equal**, not
independently optimised: they share the same routing strategy, the same anchor
candidate sets, and the same geometry constants (`ANCHOR_SETS` order, `SHRINK=3`,
`SLACK=2`), which is what makes their output byte-identical.

Two consequences:

1. **The numbers above measure runtimes, not designs.** A genuine algorithmic
   optimisation — spatial indexing to cut the `edges × candidates × nodes`
   product — would need to be applied to all three and re-pinned against the
   golden cases, because it can change which route wins ties.
2. **Python will not catch up by micro-optimisation.** A 62.6× constant gap is
   a language-execution gap; closing it means either reducing the work (fewer
   `_crosses` calls) or moving the inner loop out of the interpreter.

## Reproducing

```powershell
# all sizes, all languages, 3 repeats
powershell -ExecutionPolicy Bypass -File bench/run.ps1

# one size, one language, 5 repeats
powershell -ExecutionPolicy Bypass -File bench/run.ps1 -Sizes m -Langs dotnet -Repeat 5
```

A language whose entry point is missing is reported as `SKIP (not built)` rather
than silently omitted.
