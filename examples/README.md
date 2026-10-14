# Examples

## `small/` — annotated, hand-written, committed

The teaching examples, and the fixture for most tests.

| Path | Content |
| :--- | :--- |
| `small/c/` | `adc.h` / `adc.c` / `dsp.h` / `dsp.c` — two modules, 3 signals, 3 functions, 6 edges |
| `small/cs/` | `Adc.cs` / `Dsp.cs` — the same model expressed with `[Drawcode(...)]` attributes |

They are small on purpose: small enough to read in full and reason about, which makes them useful
as a regression fixture. `../tests/golden/small-c/` and `../tests/golden/small-cs/` are self-contained copies
with expected output, used as the conformance golden cases.

```bash
export PYTHONPATH=python/src
python -m drawcode.cli build examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --out out/flow-c.drawio --svg out/flow-c.svg
```

## `medium/` — three modules, hand-written, committed

The next size up: cross-module signal flow, an array signal and two devices, still small enough to
read in one sitting. See [`medium/README.md`](medium/README.md).

| Path | Content |
| :--- | :--- |
| `medium/c/` | `adc` / `filter` / `link` — 6 signals, 7 functions, 12 edges, 2 devices |
| `medium/cs/` | the same graph in C# (`Adc.cs` / `Filter.cs` / `Link.cs`) |

> **`DrawcodeAttributes.cs` is a type declaration, not a source file to be annotated.** It defines
> `DrawcodeAttribute`, `DeviceAttribute` and `Direction` so the C# sample compiles. Do **not** pass it
> to `drawcode build` — it carries no `[Drawcode(...)]` usage of its own.


## `drawio/` — a real draw.io export, committed

`rack-example.drawio` is a genuine draw.io export (Electron 16.5.1, three pages, compressed
payload), kept as the fixture for what `--layout-from` must **reject**.

It contains only bare `<mxCell>` elements, with no `<object symbolId="…">` wrapper, so it carries
none of drawcode's node identity and cannot supply a layout. Feeding it to `--layout-from` used to
place every node at `0,0` without a word; it now exits with an explanation. Locked in by
`python/tests/test_drawio.py::TestHandDrawnDiagram`.

## `large/` — generated, NOT committed

`generate.py` synthesises a project of any size. Generated output is **not committed**, because one
command rebuilds it and scale/seed are fixed, so results stay reproducible.

```bash
python examples/large/generate.py --modules 40 --out examples/large/c
```

| Flag | Default | Meaning |
| :--- | :--- | :--- |
| `--lang` | `c` | `c` or `cs` |
| `--modules` | 40 | number of modules (one `.h`/`.c` pair each) |
| `--signals` | 10 | signals per module |
| `--funcs` | 6 | functions per module |
| `--seed` | 20261014 | RNG seed — fixed so runs are comparable |
| `--out` | *(required)* | output directory |

Each module reads a few of its own signals, reads one signal from the previous module (producing
cross-container edges), and writes one signal — so the edge graph is realistic rather than a
straight line of independent nodes.

### Why the default is 40 and the benchmark uses 20

Measured layout cost grows super-linearly:

| Modules | Files | Signals | Funcs | Edges | Parse | Layout |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 10 | 50 | 30 | 144 | 4.0 ms | 0.36 s |
| 10 | 20 | 100 | 60 | 294 | 6.6 ms | 1.45 s |
| 20 | 40 | 200 | 120 | 594 | 12.9 ms | 5.89 s |
| 40 | 80 | 400 | 240 | 1194 | 26.8 ms | 23.3 s |
| 80 | 160 | 800 | 480 | 2394 | 52.9 ms | **95.4 s** |

Parsing is linear; layout is quadratic, because routing each edge tests candidate routes against
every node. The benchmark caps at 20 modules so a full three-language run finishes in reasonable
time. See [`docs/benchmark.md`](../docs/benchmark.md) for the analysis and
[`bench/run.ps1`](../bench/run.ps1) for the harness.
