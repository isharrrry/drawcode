---
type: Note
title: Offline .drawio rendering — pitfalls
description: Five real failures hit while making draw.io's own mxGraph engine render .drawio files headlessly, and what each one actually was
tags: [rendering, mxgraph, jsdom, drawio, pitfalls]
status: stable
---

# Offline rendering of `.drawio` — five pitfalls

**English** | 中文 | Español

[← Documentation index](../index.md)

## Why render offline at all

draw.io desktop is an Electron app. Driving it headlessly is a dead end — all three routes were
tried and all three failed:

| Route | Result |
| :--- | :--- |
| Launch the GUI from a non-interactive session | window creation refused, `0x5` |
| Portable build, silent launch | crashed, `0x80000003` |
| Silent install then drive | installer exits `2`, requires elevation |

The working route is different: `mxgraph` is draw.io's own open-source rendering core, and it runs
in Node with `jsdom`. **Let draw.io's engine draw the picture** instead of reimplementing one.

Reimplementing looks cheaper and is not. Hand-written SVG loses CJK line breaking, arrow clipping
at node boundaries, orthogonal-routing corner rounding, and edge/label avoidance — the exact things
mxGraph already gets right.

## The five failures

All five were hit while getting `tools/render/render_drawio.js` to run. Each is recorded with the
error as it appeared, because the error text is what makes this file searchable later.

### 1. Node 24's built-in `navigator` shadows jsdom's

```
TypeError: Cannot read properties of undefined (reading 'indexOf')
    at mxClient ...
```

mxGraph reads `navigator.appVersion` during startup. Node 24 defines a **global `navigator`**, and
jsdom's is not the one mxGraph gets — the built-in has no `appVersion`. Assigning
`global.window`/`global.document` is not enough.

**Fix**: redefine the global explicitly, over jsdom's navigator, before requiring mxgraph:

```js
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
```

`location` needs the same treatment (pitfall 4).

### 2. `mxImageExport` methods take `(state, canvas)`, not `(canvas, state)`

```
TypeError: state.text.checkBounds is not a function
```

Every method on `mxImageExport` is called as `fn(state, canvas)`. Passing them in the intuitive
`(canvas, state)` order type-checks fine in JavaScript (both are objects) and fails at runtime
deep inside a drawing call. The error surfaces in a function that has nothing to do with the
mistake.

**Lesson**: this class is undocumented enough that guessing the argument order costs more time than
reading `mxImageExport.prototype` first.

### 3. `mxCodec` resolves classes by `window[nodeName]`, so `<object>` collides with JavaScript's `Object`

Symptom: only 2 of 16 cells decoded. No error — just a silently incomplete graph.

`mxCodec` decodes an element by looking up a constructor at `window[element.nodeName]`. The
`.drawio` `<object>` element — draw.io's wrapper for custom properties — maps to `window.Object`,
which is JavaScript's built-in `Object`. The codec then builds the wrong thing.

**Consequence for this project**: `.drawio` files produced here use `<object>` extensively (it is
where `symbolId`, `alias`, `rw` and device metadata live). Any decoder must handle `<object>`
directly rather than relying on `mxCodec`'s name lookup.

### 4. `location is not defined`

`mxImageShape` builds absolute image URLs from `location`. jsdom's window has it; the Node global
does not.

**Fix**: same pattern as pitfall 1 — publish `dom.window.location` onto `globalThis`.

### 5. Text rendered brown (`#774400`)

Not a bug in the input. `#774400` is mxGraph's **default font colour**, which draw.io overrides in
its own stylesheet. Headless mxGraph has no such stylesheet, so unstyled text comes out brown.

**Fix**: set the colour explicitly in generated styles rather than relying on defaults. Worth
knowing when comparing a headless render against draw.io's own screenshot: a colour difference may
be a missing default, not a generation bug.

## Two limits that remain

Stated here rather than left for someone to rediscover:

1. **`jumpStyle=arc` line jumps cannot be rendered.** `jumpStyle` is a draw.io extension; grep the
   whole `mxgraph/javascript/src` tree and it does not appear. Generated files configure it
   correctly and the draw.io client honours it, but this offline renderer will not show jumps.
   Verify jumps by opening the `.drawio` in draw.io.
2. **CJK text measurement is estimated.** jsdom has no layout engine and reports
   `offsetWidth === 0`, so mxGraph cannot measure text. `mxUtils.getSizeForString` is patched with
   an estimate (CJK glyph ≈ `fontSize` wide, ASCII ≈ `0.55 × fontSize`). **Text itself renders
   correctly** — SVG positioning uses `text-anchor`, not the measurement — but label *avoidance*,
   which does depend on measured width, can be slightly off. A real fix needs node-canvas.

## Related

- [Contributing § Offline rendering](../contributing.md#offline-rendering) — how to run the renderer
- [`../drawio-format.md`](../drawio-format.md) — the `.drawio` mapping and compressed storage form
