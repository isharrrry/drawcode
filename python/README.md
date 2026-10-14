# drawcode — Python implementation

Reference implementation. Zero third-party runtime dependencies; standard library only.

```bash
# run straight from the source tree, no install needed
export PYTHONPATH=src                # Windows: $env:PYTHONPATH = "src"

python -m drawcode.cli build ../examples/small/c/adc.h ../examples/small/c/adc.c \
    ../examples/small/c/dsp.h ../examples/small/c/dsp.c \
    --root ../examples/small/c --out ../out/flow.drawio --svg ../out/flow.svg

python -m drawcode.cli sync ../out/flow.drawio ../examples/small/c/*.h ../examples/small/c/*.c \
    --root ../examples/small/c --write
```

Or install it as a package (gives you a `drawcode` command):

```bash
pip install -e .
drawcode build ...
```

## Tests

```bash
python -m unittest discover -s tests -t .     # 71 tests
```

## Layout

| Module | Responsibility |
| :--- | :--- |
| `src/drawcode/model.py` | IR types and edge derivation |
| `src/drawcode/cparse.py` | C → IR |
| `src/drawcode/csparse.py` | C# → IR |
| `src/drawcode/parse.py` | extension dispatch, multi-language merge |
| `src/drawcode/drawio.py` | IR ↔ `.drawio` (layout, routing, compressed-form reading) |
| `src/drawcode/codegen.py` | IR → code (declaration layer only) |
| `src/drawcode/svg.py` | IR → SVG preview |
| `src/drawcode/cli.py` | `build` / `sync` commands |

Conformance material lives outside this directory, so all three implementations share it:
`../../docs/conformance.md` (the bar), `../../tests/golden/` (golden cases), `../../tools/xsd/mxfile.xsd`.

## Implementing this yourself

See [`SKILL.md`](SKILL.md) — module walkthrough, the IR shape, both data flows, and the seven traps
this implementation actually hit (the compressed-storage trap is the expensive one).
