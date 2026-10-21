---
type: Guide
title: The .drawio format
description: Element mapping, coordinate semantics, routing rules and draw.io's compressed storage form — the full contract between drawcode and the diagram file
tags: [drawio, format, xml, coordinates, compression]
status: stable
---

# The `.drawio` format

**English** | [中文](drawio-format.zh-CN.md) | [Español](drawio-format.es.md)

[← Documentation index](index.md)

The `.drawio` file is the only artefact `drawcode` writes besides source code, and it plays two roles at once: it is a **derived view** of the IR, and it is the **sole carrier of layout** — the one thing in this system that cannot be regenerated from code. Every rule below exists because of one of those two roles.

## Skeleton of a generated file

```xml
<mxfile host="app.diagrams.net" agent="drawcode" type="device">
  <diagram id="drawcode" name="dataflow">
    <mxGraphModel dx="1200" dy="800" ... >
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <!-- containers, then nodes, then edges -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

`mxCell id="0"` is the graph root and `id="1"` is its default layer; both are required by the schema and neither carries data. Everything else hangs off `id="1"`.

## Element mapping

| IR concept | XML form | Parent | Notes |
| :--- | :--- | :--- | :--- |
| container (`group`) | `<mxCell vertex="1">` with a `swimlane` style | `1` | `value` is the group name; geometry is **absolute** |
| signal / function | `<object>` wrapping an `<mxCell vertex="1">` | the container cell | geometry is **container-relative** |
| edge | `<object>` wrapping an `<mxCell edge="1">` | container if source and target share one, else `1` | geometry is relative to whatever the parent is |

### Nodes carry data as `<object>` attributes

A bare `<mxCell>` has no place to put custom properties, so every node and edge is wrapped in an `<object>` element that carries the semantic payload:

```xml
<object id="n3" label="g_raw&lt;br&gt;int16_t / in / LSB" symbolId="adc.h::g_raw"
        kind="signal" ctype="int16_t" dir="in" unit="LSB"
        alias="原始采样值" note="上电后需校准">
  <mxCell style="shape=path;path=0,0 115,0 160,30 115,60 0,60;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;"
          vertex="1" parent="grp1">
    <mxGeometry x="30" y="202" width="160" height="60" as="geometry" />
  </mxCell>
</object>
```

| Attribute | Meaning | Read back? |
| :--- | :--- | :--- |
| `symbolId` | the IR id, `"<file>::<name>"` — the join key between diagram and code | yes, as the map key |
| `kind` | `signal` or `func`, selecting the style and label form | no |
| `label` | the rendered text; `&lt;br&gt;` is the line break | no |
| `ctype` `dir` `unit` | signal semantics mirrored into attributes | `dir` yes, others no |
| `alias` `note` `tooltip` | annotation values | yes |
| `ret` `asset` | function return type and image path | no |
| `vendor` `model` `spec` `size` | device data, only present when `@device` / `[Device]` was used | no |

`read_layout` reads back exactly five writable fields — `alias`, `unit`, `note`, `tooltip` and `dir` — because those are the fields a human is expected to edit inside draw.io. Everything else is written for display and ignored on the way in.

### Node styles are five constants

| Constant | Applies to | Style string |
| :--- | :--- | :--- |
| `SIGNAL_IN_STYLE` | `dir=in` signals | `shape=path;path=0,0 115,0 160,30 115,60 0,60;…` — a right-pointing pentagon |
| `SIGNAL_OUT_STYLE` | `dir=out` signals | `shape=path;path=45,0 160,0 160,60 45,60 0,30;…` — a left-pointing pentagon |
| `SIGNAL_STYLE` | signals with `dir=io` or none | `shape=ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;` |
| `FUNC_STYLE` | functions | `rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;` |
| `FUNC_EXT_STYLE` | `external="true"` functions | same as above plus `dashed=1`, grey fill and stroke |

The pentagons carry the flow direction in the shape itself, so no marker is drawn on top of the
node. Their apexes sit exactly on the left/right edge midpoints — the same points `ANCHOR_SETS`
prefers — which is why the incoming and outgoing lines bite the apex rather than the flat side.
`_conn_side` fixes that: an `in` signal always connects on its **right**, an `out` signal on its
**left**, whichever end of the edge it happens to be.

Container style is built from `CONT_STYLE` with `startSize=30`: the swimlane title band is 30 units tall, and `_container_box` reserves exactly that much extra height above the topmost member.

## Coordinate semantics

> **`mxGeometry` and `mxPoint` coordinates are relative to the parent cell, not to the canvas.** A node inside a container stores its offset from that container's top-left corner. A container stores its own position on the canvas because its parent is the layer.

Two functions convert between the two spaces, and the conversion must be exactly inverse or positions drift a little on every round-trip:

| Direction | Function | Operation |
| :--- | :--- | :--- |
| IR → XML | `to_drawio` | subtracts the container origin: `x - ox`, `y - oy` |
| XML → IR | `read_layout` | calls `_origin(cells, parent)` and *adds* the accumulated offsets |

### `_origin` is the only conversion point on the way in

```python
def _origin(cells, cid):
    x = y = 0.0
    while cid and cid not in ("0", "1") and cid in cells and cid not in seen:
        geom = cells[cid]["cell"].find("mxGeometry")
        if geom is not None:
            x += float(geom.get("x") or 0)
            y += float(geom.get("y") or 0)
        cid = cells[cid]["parent"]
    return x, y
```

It walks the `parent` chain from a cell up to the layer, summing every ancestor's `x`/`y`. The `seen` set guards against a malformed file whose parent links form a cycle — without it, a hand-broken diagram would hang the reader instead of failing.

This is the single place where nesting depth is flattened. Anything that compares coordinates across diagrams of different nesting must do so **after** this conversion; comparing raw values reports phantom drift. See [Normalisation rules](#normalisation-rules).

Edge waypoints are treated the same way: `to_drawio` writes `px - ox`, `py - oy` where `(ox, oy)` is the origin of the edge's own parent — which for a cross-container edge is `(0, 0)`, because that edge is parented to the layer and therefore already in canvas space.

## Containers and nesting

A container is created per **source file**, not per directory. Each entity's `group` is the file's stem (`adc.h` and `adc.c` both yield `adc`), so a header and its implementation share one container.

| Step | Rule |
| :--- | :--- |
| container id | `grp1`, `grp2`, … assigned in **sorted group-name order**, so ids are stable across runs |
| container bounds | `_container_box`: `min(x) - 30`, `min(y) - 60`, width `max(x2) - min(x) + 60`, height `max(y2) - min(y) + 60 + 30` |
| horizontal avoidance | groups are laid out in sorted order; if a group's box would start left of the previous group's right edge plus `4 * 30`, the whole group is shifted right |
| edge parenting | `parent = grpN` when source and target share a group, otherwise `parent = "1"` |

The `PAD = 30` margin and the `HEADER = 30` title band are what those constants contribute: 30 on every side, plus another 30 of reserved space above the topmost member for the swimlane title.

**On "innermost common container".** The specification describes edge parenting that way, and this is where it lands: because containers are currently one level deep, the innermost container shared by two entities is their own group when the groups match, and the root layer when they do not. Depth is a property of the container model, not of the parenting rule.

## Edge representation

Edges are the part of the file with the most invariants, because they are the part draw.io would otherwise route on its own.

### Base style

```
edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;jumpStyle=arc;jumpSize=6;
```

`orthogonalEdgeStyle` constrains segments to horizontal and vertical; `rounded=1` rounds the corners; `jumpStyle=arc` asks for arc jumps where two edges cross. Note that `jumpStyle` is a draw.io extension, not part of the open-source mxGraph core — the file configures it correctly and the draw.io client honours it, but the bundled offline renderer cannot draw it. That limitation is stated in [Known limitations](../README.md#known-limitations-listed-honestly).

### Anchors

An anchor pins an endpoint to a specific point on the node's bounding box, expressed as fractions of width and height:

```
exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;
```

`exitX`/`exitY` locate the start on the source node, `entryX`/`entryY` the end on the target; the `Dx`/`Dy` pairs are draw.io's offset slots and are always zero here. `0,0` is the top-left corner, `1,1` the bottom-right, so `exitX=1;exitY=0.5` means "right edge, vertical middle".

The router tries eight anchor combinations in a fixed order — the four opposing pairs first, then the four same-side pairs, which exist to enable side detours:

| Order | exitX, exitY | entryX, entryY | Shape |
| :--- | :--- | :--- | :--- |
| 1 | 1, 0.5 | 0, 0.5 | right edge to left edge |
| 2 | 0, 0.5 | 1, 0.5 | left edge to right edge |
| 3 | 0.5, 1 | 0.5, 0 | bottom edge to top edge |
| 4 | 0.5, 0 | 0.5, 1 | top edge to bottom edge |
| 5 | 1, 0.5 | 1, 0.5 | right edge to right edge |
| 6 | 0, 0.5 | 0, 0.5 | left edge to left edge |
| 7 | 0.5, 0 | 0.5, 0 | top edge to top edge |
| 8 | 0.5, 1 | 0.5, 1 | bottom edge to bottom edge |

Order only breaks ties: every combination is scored by resulting path length, and the shortest collision-free one wins. If **no** combination produces a clean path, no anchor attributes are emitted at all and draw.io routes the edge itself — an unanchored edge is considered better than an anchored one that crosses a node.

### Waypoints and routing

Intermediate points go into an `<Array as="points">` child of the edge's `mxGeometry`:

```xml
<mxGeometry relative="1" as="geometry">
  <Array as="points">
    <mxPoint x="690" y="332" />
    <mxPoint x="690" y="238" />
  </Array>
</mxGeometry>
```

`relative="1"` marks the array as offsets from the edge's parent. When there are no intermediate points the geometry collapses to the self-closing `<mxGeometry relative="1" as="geometry" />` form.

The router is a small generate-and-test loop rather than a general pathfinder:

| Step | Function | What it does |
| :--- | :--- | :--- |
| candidate generation | `_candidates` | for one anchor pair, emits a handful of orthogonal routes: via the cross-container gap, L-shaped in either order, a side lane, and lane-detoured variants |
| gap route | `_cross_gap` | when two containers do not overlap, returns the axis and midpoint of the empty channel between them; returns nothing when they do overlap |
| lane detour | `_lane_pt` | moves an endpoint 15 units along the outward normal of the edge it sits on, so a line leaves the border before turning instead of running along it |
| collision test | `_crosses` | does a segment enter a node box? Both ends are shrunk by 3 units and the box is inflated by 2, so an endpoint resting on a border is not a collision |
| scoring | `_length` | Manhattan length; the shortest surviving route wins |

The constants that shape all of this are `DETOUR = 15` (lane offset), `SLACK = 2` (box inflation for the collision test) and `SHRINK = 3` (endpoint retreat). The obstacle set includes the source and target nodes themselves — without that, a route may legally run along its own node's border, which looks like the line is drawn *through* the box.

## Compressed storage

> **This is the failure mode that loses work.** draw.io compresses the diagram by default when it saves. An implementation that reads only plain XML will report **an empty layout, with no error**, immediately after the user has arranged the diagram by hand — and every coordinate they set is silently discarded.

### The exact transform

```
base64( raw-deflate( url-quote( xml ) ) )
```

Reading it in Python is three calls, and the third argument to `decompress` is what makes it work:

```python
urllib.parse.unquote(zlib.decompress(base64.b64decode(data), -15).decode("utf-8"))
```

`-15` selects raw DEFLATE, i.e. a zlib stream with the 2-byte header and 4-byte checksum stripped. Using the default `zlib.decompress(data)` raises, because the stream is not zlib-wrapped. Note also that the payload is a **UTF-8 decode after inflation**: the XML is percent-encoded, so multi-byte characters survive the round-trip as `%XX` escapes rather than raw bytes.

On the writing side, the quote set matters equally. The characters left unescaped are `~()*!.'` — Python's `urlquote` would additionally leave `/` and `:`, producing a payload draw.io cannot read back.

### Both forms are read, and a broken payload raises

`_unpack` accepts either shape:

| Input | Behaviour |
| :--- | :--- |
| `<diagram>` with an `<mxGraphModel>` child | returned as-is — this is the plain form |
| `<diagram>` whose text is a compressed payload | inflated in place and the `<mxGraphModel>` appended, so downstream code sees one shape |
| `<diagram>` with empty text | skipped — some files contain placeholder diagrams |
| `<diagram>` with text that will not inflate | **raises `ValueError`** |

That last row is the design decision worth stating plainly: returning an empty layout would be indistinguishable from a diagram that genuinely has no layout, and the caller would overwrite hand-made work with defaults. Raising makes the corruption visible at the point of failure. `conformance.md` lists this as a required capability rather than a nicety.

Because the two forms inflate to the same tree, `read_layout` is form-agnostic: the same file saved by drawcode and re-saved by draw.io yields identical nodes, edges and attributes. That equality is asserted against a draw.io-compressed golden file.

## Round-trip idempotence

Building twice must not move anything. The difficulty is that **the generator writes waypoints into the file, and then cannot tell its own waypoints from ones a human dragged** — so on the next run it would preserve its own output as if it were human intent, and the routing algorithm could never improve.

The solution is a comparison, not a marker:

1. `apply_layout` first hydrates node positions from the file, so the model reflects the real coordinates.
2. `_auto_waypoints(model)` then recomputes, **for those coordinates**, what each edge's waypoints would be if the generator produced them today.
3. For each edge, the file's waypoints are adopted; if they equal the freshly computed auto value, they are **discarded** — the edge is left with no stored waypoints, so `to_drawio` will route it again from scratch.
4. Anything that does *not* match the auto value is kept, because a human must have moved it.

The consequences are worth spelling out:

| Situation | Result |
| :--- | :--- |
| Build → build with no edit | identical file; auto waypoints are recomputed to the same values |
| Build → drag a node in draw.io → build | node moves, edges re-route against the new position |
| Build → pull one edge's line → build | that edge keeps its path; the others are recomputed |
| Routing algorithm changes | old auto waypoints no longer match and are **kept**, so they look hand-made; rebuild without `--layout-from` to pick up new routing |

That last row is the honest edge case: the heuristic cannot distinguish "auto, from an older version" from "human". Adding a marker attribute would fix it at the cost of putting generator bookkeeping into a file humans edit.

## Normalisation rules

Comparison between implementations is structural, never byte-wise. Attribute order is irrelevant, insignificant whitespace is irrelevant, and numbers compare by value rather than spelling — `420`, `420.0` and `4.2e2` are equal. The generated `id` values (`n1`, `e1`, `grp1`) are not part of the contract beyond being unique and stable within one run; what is compared is the mapping from `symbolId` to geometry. The full list, including which of the four comparison levels a failure belongs to, is in [`conformance.md`](conformance.md).

One rule from that list deserves repeating here because it is a `.drawio`-format rule, not a process rule: **element order follows document order, except where the specification says sorted** — containers by id, nodes by `symbolId`, edges by the triple `(src, dst, rw)`. Sorting before comparing is what makes the comparison independent of dictionary iteration order, which differs between Python and, say, .NET.

## Related

- [annotations.md](annotations.md) — where the attributes on `<object>` come from
- [architecture.md](architecture.md) — why only the declaration layer is written back
- [`conformance.md`](conformance.md) — comparison levels and normalisation rules
- [Contributing § Offline rendering](contributing.md#offline-rendering) — rendering a `.drawio`
  without draw.io installed
