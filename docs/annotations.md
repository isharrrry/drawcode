---
type: Guide
title: Annotations
description: Field-level reference for every annotation key — the C @drawcode and @device comment blocks, and the C# Drawcode, Device and Callout attributes
tags: [annotations, parsing, attributes, comments, reference]
status: stable
---

# Annotations

**English** | [中文](annotations.zh-CN.md) | [Español](annotations.es.md)

[← Documentation index](index.md)

Annotations carry the two things a parser cannot infer from source: **direction** (is this signal an input or an output?) and **human-facing metadata** (what does a person call it?). Everything else — which functions read which signals, which signals get written — is derived from the code itself.

> **Annotations never decide whether an edge exists.** An edge exists because a function body reads or writes a signal. Editing a comment changes a label; it never adds, removes or moves a line. See [Why annotations do not control edges](#why-annotations-do-not-control-edges).

## Direction in C: the `dir` key

Direction is a key in the `@drawcode` comment that sits directly above the declaration. **Only an annotated top-level variable is a signal** — an unannotated declaration is never one, however it is spelled.

| `dir` value | `dir` in the IR | Diagram appearance |
| :--- | :--- | :--- |
| `dir=in` | `in` | right-pointing pentagon, label `type / in / unit` |
| `dir=out` | `out` | left-pointing pentagon, label `type / out / unit` |
| `dir=io` | `inout` | ellipse, label `type / inout / unit` |
| absent | `""` | ellipse, label with no direction |

```c
/// @drawcode dir=in unit="LSB" alias="原始采样值" note="上电后需校准"
int16_t g_raw;
```

### No header, no macros

Earlier versions of drawcode required a `drawcode_signals.h` header and `SIGNAL_IN` / `SIGNAL_OUT` / `SIGNAL_IO` macros. **Both are gone.** Direction now lives in the comment, so there is nothing to include and nothing to link — the annotation is read from the source text and never from a compiled artefact.

### Syntax constraints

The declaration is recognised by a line-oriented regular expression, one declaration per line:

```
(?P<ctype>.+?)\s*(?P<name>[A-Za-z_]\w*)(\[[^\]]*\])?\s*;
```

- **One declaration per line, terminated by `;`.** The trailing semicolon is part of the match; a declaration split across lines is not recognised.
- **The declaration must carry `@drawcode`.** A comment block with no annotation, or an annotation on a construct that is not a top-level variable, produces no signal at all.
- **Array declarators are folded into the type.** `float g_coeff[32];` yields `name = g_coeff` and `ctype = float[32]`; the suffix is reattached to the type, so the label reads `float[32] / in / coeff`.
- **Signals accept every key in the signal table below, geometry included.** `xy`, `size` and `style` are read on a variable exactly as they are on a function, by every front end and every implementation — see [Where the geometry keys actually take effect](#where-the-geometry-keys-actually-take-effect).

## Direction in C#: the `[Drawcode]` attribute

C# has no comment-key convention here, so **everything** a C signal says in a comment is said by a single attribute instead. Direction is its first, positional argument.

```csharp
[Drawcode(Direction.In, Unit = "LSB", Alias = "原始采样值", Note = "上电后需校准")]
public static short g_raw;
```

| Attribute value | `dir` in the IR |
| :--- | :--- |
| `[Drawcode(Direction.In)]` | `in` |
| `[Drawcode(Direction.Out)]` | `out` |
| `[Drawcode(Direction.Io)]` | `inout` |
| `[Drawcode]` / `[Drawcode(Direction.None)]` | `""` |

The attribute binds to the **next field, property or method declaration** that follows it, ignoring blank lines, `using`, `namespace`, `#`-prefixed lines and bare braces. The positional argument may be omitted (`[Drawcode(Alias = "…")]`), in which case the member is documented but carries no direction. `DrawcodeAttribute`, `DeviceAttribute`, `CalloutAttribute` and `Direction` must exist in your project — copy [`examples/small/cs/DrawcodeAttributes.cs`](../examples/small/cs/DrawcodeAttributes.cs) once.

## Annotation syntax

### C: comment keys

```c
/// @drawcode unit="LSB" alias="原始采样值" note="上电后需校准"
int16_t g_raw;
```

Two tags are recognised, both at the start of a `///` line after optional leading whitespace:

| Tag | Carries | Keys |
| :--- | :--- | :--- |
| `@drawcode` | the entity's own metadata | see the two key tables below |
| `@device` | device master data for a **function** | `vendor` `model` `spec` `size` `asset` |

### C#: attributes

```csharp
[Drawcode(Alias = "ADC 采样", Tooltip = "上电后需先校准")]
[Device(Vendor = "TI", Model = "ADS1115", Spec = "16bit/860SPS", Size = "2.0x3.0mm", Asset = "assets/ads1115.svg")]
public static short AdcRead()
```

The same two concepts, expressed as attributes. `[Device]` replaces the old `/// <device />` comment, so it is no longer a doc comment and no longer reaches XML documentation output.

### How the keys are read

In C, consecutive `///` lines accumulate and are **flushed** when a non-`///`, non-blank line is reached; a blank line clears the buffer, so the block must sit directly above what it annotates. In C#, the attribute binds forward to the next declaration, skipping blank lines, `using`, `namespace`, `#`-prefixed lines and bare braces.

Key/value pairs in C are read by `(\w+)\s*=\s*"([^"]*)"`: **keys are bare words, values are double-quoted, and a value may not contain a double quote.** In C# the keys are named attribute properties. Unknown keys are silently ignored rather than raising, which keeps annotations forward-compatible across implementations.
## Key reference: signals

Applies to `@drawcode`-annotated top-level variables in C and to `[Drawcode]`-attributed fields and properties in C#. All keys behave identically in both languages and in every implementation; the last three are geometry, read by every front end on both entity kinds. `dir` is documented above.

| Key | Type | Default | Effect | Example |
| :--- | :--- | :--- | :--- | :--- |
| `unit` | string | `""` | Third element of the node label, after `ctype / dir`. Purely descriptive; no arithmetic is performed on it. | `unit="LSB"` |
| `alias` | string | `""` | Human name used as a **custom attribute** on the node (not in the label). The label always shows the C identifier. | `alias="原始采样值"` |
| `note` | string | `""` | Free-text remark, written to the `<object>` custom attributes. Not rendered in the label. | `note="上电后需校准"` |
| `external` | `"true"` / absent | `false` | Marks the signal as coming from outside the module set. Parsed as the string `"true"`; any other value, including `"True"`, leaves it `false`. | `external="true"` |
| `xy` | `"x,y"` | unset | Absolute canvas coordinates, overriding the default stacking for this node. | `xy="420,160"` |
| `size` | `"WxH"` | `160x60` on a signal, `180x72` on a function | Initial node size; separator is a lowercase `x`. | `size="180x72"` |
| `style` | string | `""` | Fragment appended verbatim to the end of the node's style string (role colouring and the like). An empty value leaves the output byte-identical. | `style=";fillColor=#e8f0fe"` |

The label is assembled as `name` on the first line and `ctype / dir / unit` on the second, skipping empty parts — so a signal with no `unit` reads `int16_t / in`, not `int16_t / in / `.

## Key reference: functions

Applies to function declarations in C and to methods in C#.

| Key | Type | Default | Effect | Example |
| :--- | :--- | :--- | :--- | :--- |
| `alias` | string | `""` | Used as the node's **title line** in place of the function name (`ADC 采样()` instead of `adc_read()`). The real name still appears on the second line. | `alias="ADC 采样"` |
| `note` | string | `""` | Free-text remark, written to the `<object>` custom attributes. | `note="上电后需先校准"` |
| `tooltip` | string | `""` | Hover text, written to the `<object>` custom attributes. | `tooltip="上电后需先校准"` |
| `asset` | string | `""` | Path to an image for the node, written to the `<object>` custom attributes. **The path is recorded, not resolved** — no file is read, and a missing target is not an error. With `--cards` it becomes the picture on the card (see [Image cards](#image-cards---cards)). | `asset="assets/ads1115.svg"` |
| `external` | `"true"` / absent | `false` | Switches the node style to the dashed external form. | `external="true"` |
| `xy` | `"x,y"` | unset | Initial node position on the canvas, in absolute canvas coordinates. Overrides the default stacking for this node. | `xy="420,160"` |
| `size` | `"WxH"` | `180x72` | Initial node size. The separator is a lowercase `x`; the value is lowercased before splitting, so `180X72` also works. | `size="180x72"` |
| `style` | string | `""` | Fragment appended verbatim to the end of the node's style string, same as the signal row. | `style=";fillColor=#dae8fc"` |

Do not mix the separators up: `xy` takes a comma, `size` takes a **lowercase `x`**. Writing the
wrong one does **not** raise — it yields a node with `NaN` size, positioned at `(NaN, NaN)` and
sized `(NaN, NaN)`, which is invisible in draw.io.

### Where the geometry keys actually take effect

All three keys are read by **every** front end, in a `.c` and in a `.cs`, on signals and on functions.
Earlier revisions read `xy`/`size` only in the function branch, only on some front ends, and never
read `style`; those gaps are closed now. The rules are identical everywhere:

- a missing key or an empty string leaves the entity's default untouched;
- a malformed value does **not** raise — it becomes `NaN`, and a node with `NaN` geometry is invisible
  in draw.io;
- `xy` splits on a comma, `size` on a lowercase `x` (the value is lowercased first, so `180X72` is
  accepted);
- conversion follows JavaScript `Number()` — the three strings where it differs from a typical
  `strtod`-style parse (`"1_0"`, `"infinity"`, `"0x10"`) are covered by tests.

`sync` writes the pair back too, for entities whose diagram geometry differs from what `build` would
have written — see [Write-back](#write-back). Because every implementation ignores unknown keys
rather than raising, these behaviours are pinned by dedicated unit tests rather than by the goldens:
`expected.ir.json` deliberately records no coordinates, so L1 cannot catch a regression.

Do not confuse these with the `size` key on `@device` / `[Device]`, which is the physical package size of a part and **is** read on both sides — they are different keys that happen to share a name.

## Key reference: devices

`@device` (C) / `[Device]` (C#) attaches device master data to a **function** — the usual case being a driver entry point that talks to one chip. It is stored in `Model.devices`, keyed by the function's id.

| Key | Type | Default | Effect | Example |
| :--- | :--- | :--- | :--- | :--- |
| `vendor` | string | `""` | Written to the node's `<object>` custom attributes. | `vendor="TI"` |
| `model` | string | `""` | Same. | `model="ADS1115"` |
| `spec` | string | `""` | Same. | `spec="16bit/860SPS"` |
| `size` | string | `""` | Same — and see the warning below. | `size="2.0x3.0mm"` |
| `asset` | string | `""` | Same. **Also copied onto the function's own `asset` field if that is still empty**, so a device image can be declared once. | `asset="assets/ads1115.svg"` |

### The two keys named `size` are unrelated

`@drawcode size="180x72"` and `@device size="2.0x3.0mm"` share a name and nothing else.

| | `@drawcode size` | `@device size` |
| :--- | :--- | :--- |
| Meaning | node **geometry** in canvas units | a **descriptive string** about the physical part |
| Parsed as | two floats, split on lowercase `x` | an opaque string, stored as-is |
| Stored on | `Func.w` / `Func.h` | `Device.size` |
| Reaches the diagram as | `mxGeometry` `width` / `height` | an `<object>` custom attribute |
| Wrong value causes | a crash on `float()` — this is the one place a malformed annotation is fatal | nothing; any string is accepted |

Because both are written with the same `k="v"` syntax and both appear in the same comment block, this is the most common annotation mistake. The distinction is which tag the key sits under.

## Free text blocks: `[Callout]`

A box you can put words in. It fills the gap left by the key system: annotation keys decorate
elements that already exist, but they cannot add anything new — so there was nowhere to write a
section heading, a legend, or a note saying what the diagram deliberately leaves out.

```csharp
[Callout("Platform interior — device and relation groups live on this side",
         Xy = "40,40", Size = "260x60", Style = "band")]
[Callout("IO closed loop: parameters ⇄ commands", Xy = "40,120", Size = "240x40", Style = "box", Font = 13)]
```

| Argument | Value | Notes |
| :--- | :--- | :--- |
| first positional | double-quoted string | **must come first**, and may not contain a double quote. May contain `<br>` for a line break |
| `Xy` | `"x,y"` | **absolute** canvas coordinates, written exactly like node geometry |
| `Size` | `"WxH"` | lowercase `x` separator. Defaults to `240x40` |
| `Style` | `text` / `box` / `band` | borderless text / tinted callout box / wide section band. An unrecognised value falls back to `text` |
| `Font` | number | font size. `0` or absent uses the default for the kind (`text`/`box` 12, `band` 15) |

**It does not attach to the entity it is written above.** The `[Callout]` line sits on some method or
field only so that it lives in the same file as the diagram — its position comes entirely from `Xy`,
independently of where its host ends up. One declaration may carry **several** `[Callout]` lines
(they are a list, not a dictionary, so they do not overwrite one another).

Note that `Style` means "kind of text block" here and "fragment appended to the node style" on
`[Drawcode]` — **same name, different meaning**. The two are parsed into separate key namespaces so
that writing both on one declaration cannot make them collide.

Three things surprise people:

1. **`band` has to be drawn before the containers.** A cell is drawn together with its whole subtree,
   and a band is a direct child of the root; emitted after the containers it lands *on top of* that
   subtree and covers every card inside them. The generator therefore emits `band` **before** the
   containers and `text`/`box` after the cards — you do not have to manage this, but you do need to
   know it if you change the emit order.
2. **Dragging a text block does not round-trip.** `applyLayout` only resolves node and function ids
   and skips anything else. Move the block in draw.io, rebuild with `--layout-from`, and it **snaps
   back to the `Xy` in the source**. To move it, edit the source.
3. **All three C# front ends know this attribute; the C front end does not.** `CalloutAttribute` is
   parsed by `csparse.ts`, `csparse.py` and `CsParse.cs` alike, and the parse-dispatch merge
   concatenates their lists. There is no C equivalent in any implementation — a `///` comment block
   has no natural place to carry several independent, absolutely-positioned rectangles. Unknown
   attributes are still ignored rather than raising, so a misspelt property degrades silently; the
   attribute itself no longer does.

## Image cards: `--cards`

Give `Asset` on `@device` / `[Device]` a picture, pass `--cards`, and the function node becomes an
image card: the picture fills the node box and the function name is pushed outside it, below the
frame (there is no room left inside).

```bash
node bin/drawcode.ts build Drone.cs --cards --out devices.drawio --svg devices.svg
```

- Only takes effect when `--cards` is on **and** `asset` is non-empty; without the flag, `asset` is
  just a record on the `<object>`.
- `[Device(Asset = "…")]` is copied onto the function automatically (a function that sets its own
  `asset` wins), so the picture only has to be declared once.
- The path is relative to the **`.drawio` file itself** and drawcode never reads it — a missing
  target is not an error, the card just renders blank.
- **Offline renderers do not fetch external image files by default.** Converting such an SVG to PNG
  without pointing the renderer at the image directory makes the photos vanish from the PNG while
  the SVG still looks fine. That is a rendering-toolchain trap, not a flaw in the diagram.

## Where each key ends up

Every annotation key lands in exactly one of three places. Knowing which one explains most "I changed the annotation and nothing happened" reports.

| Destination | Keys | Visible in the diagram as |
| :--- | :--- | :--- |
| node **label text** | `unit` (signals), `alias` (functions) | rendered characters inside the shape |
| `<object>` **custom attributes** | `alias` `note` (signals); `ret` `alias` `note` `tooltip` `asset` (functions); all five device keys | element attributes, visible in draw.io's Edit Data dialog |
| **geometry** | `xy`, `@drawcode size`, `@device`-attributed functions' positions | node coordinates |

A signal's `alias` is deliberately *not* in the label: two signals can be aliased to the same human name without becoming indistinguishable on the canvas. Note that `read_layout` reads `alias`, `unit`, `note`, `tooltip` and `dir` back out of the `<object>` attributes, so those five are round-trippable through a hand-edited diagram; the newer device keys are written but not read back by this path.

## Why annotations do not control edges

`rebuild_edges()` is the only producer of edges, and it never looks at a comment:

```
for f in funcs:
    for sid in f.reads:  edges.append(Edge(sid, f.id, "read"))
    for sid in f.writes: edges.append(Edge(f.id, sid, "write"))
```

`f.reads` and `f.writes` come from `_def_use()`, which scans the **function body text** after stripping comments:

- statements are split on `;`, `{` and `}`;
- a compound assignment (`+=`, `<<=`, …) marks the left side as both read and written, and the right side as read;
- a plain `=` marks the left side as written and the right side as read;
- anything else in the statement counts as read;
- every identifier found is then filtered against the set of declared signal names — names that are not signals (locals, parameters, library calls) are discarded.

Two consequences follow directly, and both surprise people:

1. **A comment can never create or delete an edge.** `alias` is metadata; `unit` is metadata; there is no annotation for "this function reads `g_raw`", because the body already says so.
2. **The direction of the arrow follows read/write, not the annotation.** A `read` edge runs *signal → function*; a `write` edge runs *function → signal*. Annotating a signal `dir=out` does not turn its read edges into writes.

Changing `g_raw` from `dir=in` to `dir=out` changes the label text and the node's `dir` attribute. It does not move a single line. If you want an edge to disappear, delete the statement that reads or writes the signal.

## What the parser infers without annotations

These rules need no annotation because they follow from the code's structure.

| Rule | Consequence on the diagram |
| :--- | :--- |
| **Parameters are ports, not nodes.** Parsed into `Param(name, ctype)` and attached to the function. | `void dsp_set_gain(uint8_t gain)` produces one function node. There is no `gain` ellipse and no edge to it. |
| **Local variables stay out.** Only identifiers that resolve to a declared signal survive the `_def_use` filter. | `int16_t v` inside `adc_read()` is invisible. |
| **One node per declaration.** The parser carries the declared type string through as `ctype` and never walks a type's members. | A struct-typed signal is a single ellipse labelled with the struct type; it is never expanded into one node per field. |
| **Functions are recognised by shape, not by annotation.** A line matching the function pattern that is not one of the C control keywords (`if`, `for`, `while`, `switch`, `return`, `sizeof`, …) becomes a function. | An unannotated function still gets a node — it simply has no alias, so the node is titled with its real name. |
| **Header declarations win over definitions.** When a name appears in both a `.h` and a `.c`, keys from the header are preferred. | Annotate in the header, as the examples do. |
| **The container is the file.** Each entity's `group` is the source file's stem. | `adc.h` entities land in a container named `adc`. |
| **Multi-language merge is by concatenation, not by symbol resolution.** | C and C# inputs produce one merged IR, but a cross-language reference to the same name is not linked. |

## Write-back

`sync` rewrites the declaration layer and nothing else. For each entity it renders the annotation block from the IR and replaces the existing span, leaving every other byte of the file untouched.

| Field | Written back as |
| :--- | :--- |
| signal `unit` `alias` `note` `external` | `/// @drawcode …` (C) or `[Drawcode(…)]` (C#) |
| signal `dir` | the key `dir=in` / `dir=out` / `dir=io` (C), or the positional argument `Direction.X` (C#) |
| function `alias` `note` `tooltip` `external` | `/// @drawcode …` (C) or `[Drawcode(…)]` (C#) |
| device keys | `/// @device …` (C) or `[Device(…)]` (C#) |
| `xy` / `size`, **only where the diagram disagrees with the source** | `xy="420,160" size="180x72"` (C) or `Xy = "420,160", Size = "180x72"` (C#) |
| `style` | **never** — it is an input-only key, like `clientX` on an element |
| function **body** | **never** — this is the design constraint, not a gap |

`sync` writes the pair back and merges at **parameter level**: a
hand-written `Style`, a compact `Unit="LSB"` or a `[Device]` line above the attribute survives
untouched, and only the keys whose values actually changed are rewritten. A rearranged diagram
therefore round-trips without disturbing hand-written annotations.

The geometry row is conditional, and the condition is what keeps `sync` honest. `applyLayout` is the
one place that holds both numbers — what the diagram now says, and what `build` would have written
(the source's own `xy`, or the default layout when there is none) — and it records only the entities
where the two differ. **Those differences are the only geometry `sync` ever writes.** So an untouched
project produces byte-identical files, and a node the source already pinned keeps its original value
rather than being rewritten to the same number in a new spelling.

Three consequences worth knowing before you hand someone a diagram to rearrange:

- **The unit is the container, not the canvas.** `<mxGeometry>` stores coordinates relative to the
  parent cell; the annotation stores **absolute** canvas coordinates. The conversion lives in
  `drawio.ts` and `codegen.ts` — hand-editing either one alone means reproducing that arithmetic.
- **Only a cell that came out of `build` can be pinned.** A shape drawn in draw.io carries no
  `symbolId`, so `applyLayout` never sees it and no `pinned` entry is ever created for it — including
  on later syncs, long after `adoptForeign` declared it in the source. Measured, not inferred: adopt
  a signal at `(40,200)`, re-sync, then drag that same cell to `(500,700)` and re-sync again — the
  annotation is still bare `/// @drawcode dir=in`, and the node goes back to the default stack on the
  next `build`. **To pin a node you added in the diagram, build first, then drag the generated cell.**
- **`style` is never written, so it is also never lost.** The C and C# merges are key-by-key rather
  than line-by-line precisely so that keys drawncode does not manage survive in their original
  position. Adding a note to an annotated function will not silently drop its colour fragment.

## Related

- [architecture.md](architecture.md) — layering, data flows, and why the IR is never persisted
- [drawio-format.md](drawio-format.md) — how annotated entities become `.drawio` elements
- [`examples/small/cs/DrawcodeAttributes.cs`](../examples/small/cs/DrawcodeAttributes.cs) — the C# attribute definitions, ready to copy
- [`examples/small/c/adc.h`](../examples/small/c/adc.h) and [`examples/small/cs/Adc.cs`](../examples/small/cs/Adc.cs) — every key used in one place
