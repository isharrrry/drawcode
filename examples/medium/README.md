# Medium example — a three-module acquisition pipeline

`small/` proves the syntax in two files. This one is the next size up: three
modules, cross-module signal flow, an array signal, and two devices. It is still
hand-written and small enough to read in one sitting.

```
adc ──g_raw──▶ filter ──g_filtered──▶ link
 │                                       │
 └──────────── control_step ─────────────┘
```

| Module | Signals | Notes |
| :--- | :--- | :--- |
| `adc` | `g_raw` (out), `g_gain` (in), `g_sample_rate` (in) | device `ADS1115`, pinned position via `xy`/`size` |
| `filter` | `g_filtered` (out), `g_coeff[16]` (in) | array signal — `ctype` becomes `float[16]` (C) / `float[]` (C#) |
| `link` | `g_tx_frame[8]` (out) | device `FT232H`, `control_step` calls across all three modules |

Both languages describe the same graph, so `drawcode build` over either
directory produces the same shape.

## Build it

```powershell
# C
python -m drawcode.cli build examples/medium/c/adc.h examples/medium/c/adc.c `
    examples/medium/c/filter.h examples/medium/c/filter.c `
    examples/medium/c/link.h examples/medium/c/link.c `
    --out medium-c.drawio

# C#
python -m drawcode.cli build examples/medium/cs/Adc.cs examples/medium/cs/Filter.cs `
    examples/medium/cs/Link.cs --out medium-cs.drawio
```

`examples/medium/cs/DrawcodeAttributes.cs` is the copy of the attribute
definitions your project needs (`DrawcodeAttribute`, `DeviceAttribute`,
`Direction`). C needs no header at all — direction lives in the `@drawcode`
comment.

> Pass only `Adc.cs`, `Filter.cs` and `Link.cs` to `drawcode build`.
> `DrawcodeAttributes.cs` is a type declaration — it carries no `[Drawcode(...)]`
> usage and is not an input.

## What it is for

Learning the annotation surface at a size where every line is still load-bearing.
For scale and timing, see `examples/large/`; for the minimal case, `small/`.
