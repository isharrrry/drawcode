import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { after, test } from "node:test";

import {
  applyLayout,
  assignDefaultPositions,
  LABEL_LANE,
  quote,
  readLayout,
  separateLabels,
  toDrawio,
  type Rect,
} from "../src/drawio.ts";
import { parseProject } from "../src/cparse.ts";
import { makeCallout } from "../src/model.ts";
import type { Model } from "../src/model.ts";
import { findChild, iterElements, parseXml, serializeXml } from "../src/xml.ts";
import { examplesC } from "./helpers.ts";

const FILES = examplesC();

function model() {
  return parseProject(FILES);
}

/** 复刻 draw.io 保存时的形态：`<diagram>` 内容 = base64(raw deflate(urlquote(model))) */
function pack(xml: string): string {
  const root = parseXml(xml);
  for (const d of root.children) {
    if (d.tag !== "diagram") continue;
    const inner = findChild(d, "mxGraphModel");
    if (inner === null) continue;
    const text = serializeXml(inner);
    d.children.length = 0;
    const blob = zlib.deflateRawSync(Buffer.from(quote(text), "utf8"), { level: 9 });
    d.text = blob.toString("base64");
  }
  return serializeXml(root);
}

test("drawio: output is well-formed and carries no comments", () => {
  const xml = toDrawio(model());
  parseXml(xml);
  assert.ok(!xml.includes("<!--"));
});

test("drawio: every symbol is an object carrying symbolId", () => {
  const root = parseXml(toDrawio(model()));
  const ids = new Set<string>();
  for (const el of iterElements(root)) {
    if (el.tag === "object") ids.add(el.attrib.get("symbolId") ?? "");
  }
  for (const sid of [
    "adc.h::g_raw",
    "adc.h::g_filtered",
    "dsp.h::g_coeff",
    "adc.h::adc_read",
    "dsp.h::fir_apply",
    "dsp.h::dsp_set_gain",
  ]) {
    assert.ok(ids.has(sid), `missing object for ${sid}`);
  }
});

test("drawio: cell ids avoid :: and /", () => {
  const root = parseXml(toDrawio(model()));
  for (const el of iterElements(root)) {
    if (el.tag !== "object") continue;
    const id = el.attrib.get("id") ?? "";
    assert.ok(!id.includes("::"));
    assert.ok(!id.includes("/"));
  }
});

test("drawio: signal attributes", () => {
  const root = parseXml(toDrawio(model()));
  const obj = [...iterElements(root)].find(
    (el) => el.tag === "object" && el.attrib.get("symbolId") === "adc.h::g_raw",
  );
  assert.ok(obj !== undefined);
  assert.equal(obj.attrib.get("kind"), "signal");
  assert.equal(obj.attrib.get("dir"), "in");
  assert.equal(obj.attrib.get("ctype"), "int16_t");
  assert.equal(obj.attrib.get("unit"), "LSB");
  assert.equal(obj.attrib.get("alias"), "原始采样值");
});

/** 从 style 里取出五边形路径的点。 */
function shapePath(style: string): Array<[number, number]> {
  const seg = style.split(";").find((s) => s.startsWith("path="));
  assert.ok(seg !== undefined, `style has no path=: ${style}`);
  return (seg as string)
    .slice("path=".length)
    .split(" ")
    .map((p) => p.split(",").map(Number) as [number, number]);
}

test("drawio: direction shapes encode flow, and each tip sits on the edge midpoint", () => {
  // 这条需要独立守卫：conformance 只比较结构，形状差异全在 style 里，把形状
  // 改回椭圆不会有任何测试变红。
  //
  // 另一半同样重要：尖角必须精确落在左右边缘中点上。ANCHOR_SETS 的首选锚点是
  // (1.0,0.5)/(0.0,0.5)，只有尖角与它重合，连线才会咬在尖角上；一旦路径坐标
  // 改动而锚点没跟着改，线就会悬在平边上。
  const root = parseXml(toDrawio(model()));
  const signals = new Map<string, string>();
  for (const el of iterElements(root)) {
    if (el.tag !== "object" || el.attrib.get("kind") !== "signal") continue;
    const cell = findChild(el, "mxCell");
    // findChild 的返回类型是 `XmlElement | null`（不是 undefined）——
    // 写成 `cell !== undefined` 一条都挡不住，窄化后剩下的仍是 `XmlElement | null`。
    assert.ok(cell !== null);
    signals.set(el.attrib.get("symbolId") ?? "", cell.attrib.get("style") ?? "");
  }

  // dir=in -> 右边尖
  const inStyle = signals.get("adc.h::g_raw");
  assert.ok(inStyle !== undefined);
  assert.ok(inStyle.includes("shape=path"), "in 信号用五边形");
  assert.deepEqual(
    shapePath(inStyle as string).reduce((a, b) => (b[0] > a[0] ? b : a)),
    [160, 30],
    "in 的尖角在右边缘中点",
  );

  // dir=out -> 左边尖
  const outStyle = signals.get("adc.h::g_filtered");
  assert.ok(outStyle !== undefined);
  assert.ok(outStyle.includes("shape=path"), "out 信号用五边形");
  assert.deepEqual(
    shapePath(outStyle as string).reduce((a, b) => (b[0] < a[0] ? b : a)),
    [0, 30],
    "out 的尖角在左边缘中点",
  );

  // 示例里三个信号都有方向（in/out/in），没有"无方向 -> 椭圆"的用例可测；
  // 那个分支由 SIGNAL_DIR_STYLE 查不到时的默认值兜底。
});

test("drawio: signal nodes still carry symbolId after the shape change", () => {
  const root = parseXml(toDrawio(model()));
  const signals = [...iterElements(root)].filter(
    (el) => el.tag === "object" && el.attrib.get("kind") === "signal",
  );
  assert.equal(3, signals.length);
  for (const el of signals) assert.notEqual(el.attrib.get("symbolId") ?? "", "");
});

test("drawio: func attributes include device metadata", () => {
  const root = parseXml(toDrawio(model()));
  const obj = [...iterElements(root)].find(
    (el) => el.tag === "object" && el.attrib.get("symbolId") === "adc.h::adc_read",
  );
  assert.ok(obj !== undefined);
  assert.equal(obj.attrib.get("kind"), "func");
  assert.equal(obj.attrib.get("vendor"), "TI");
  assert.equal(obj.attrib.get("model"), "ADS1115");
  assert.equal(obj.attrib.get("spec"), "16bit/860SPS");
  assert.equal(obj.attrib.get("size"), "2.0x3.0mm");
  assert.equal(obj.attrib.get("asset"), "assets/ads1115.svg");
  assert.equal(obj.attrib.get("tooltip"), "上电后需先校准");
});

test("drawio: label uses html <br>, twice-escaped, never a real newline", () => {
  const xml = toDrawio(model());
  const root = parseXml(xml);
  const obj = [...iterElements(root)].find(
    (el) => el.tag === "object" && el.attrib.get("symbolId") === "adc.h::g_raw",
  );
  const label = obj?.attrib.get("label") ?? "";
  assert.ok(label.includes("<br>"), "decoded label must contain <br>");
  assert.ok(!label.includes("\n"));
  assert.ok(xml.includes("&lt;br&gt;"), "raw XML must carry the escaped form");
});

test("drawio: containers, and children are parent-relative", () => {
  const root = parseXml(toDrawio(model()));
  const containers = [...iterElements(root)].filter(
    (el) => el.tag === "mxCell" && (el.attrib.get("style") ?? "").includes("swimlane"),
  );
  assert.equal(containers.length, 2);
  const cid = new Set(containers.map((c) => c.attrib.get("id") as string));
  for (const el of iterElements(root)) {
    if (el.tag !== "object") continue;
    const inner = findChild(el, "mxCell");
    if (inner?.attrib.get("vertex") !== "1") continue;
    assert.ok(cid.has(inner.attrib.get("parent") as string));
  }
});

test("drawio: edge parent is the innermost common container", () => {
  const root = parseXml(toDrawio(model()));
  const byId = new Map<string, string>();
  for (const el of iterElements(root)) {
    if (el.tag !== "object") continue;
    const inner = findChild(el, "mxCell");
    if (inner !== null) byId.set(el.attrib.get("id") as string, inner.attrib.get("parent") as string);
  }
  for (const el of iterElements(root)) {
    if (el.tag !== "object") continue;
    const inner = findChild(el, "mxCell");
    if (inner?.attrib.get("edge") !== "1") continue;
    const p = byId.get(inner.attrib.get("source") as string);
    const q = byId.get(inner.attrib.get("target") as string);
    assert.equal(inner.attrib.get("parent"), p === q ? p : "1");
  }
});

test("drawio: edges carry def-use semantics", () => {
  const root = parseXml(toDrawio(model()));
  const rels = [...iterElements(root)]
    .filter((el) => el.tag === "object" && el.attrib.get("rel") !== undefined)
    .map((el) => `${el.attrib.get("src")}|${el.attrib.get("dst")}|${el.attrib.get("rw")}`);
  assert.ok(rels.includes("adc.h::g_raw|adc.h::adc_read|read"));
  assert.ok(rels.includes("adc.h::adc_read|adc.h::g_filtered|write"));
  assert.equal(rels.length, 6);
});

test("drawio: node layout survives a write/read round trip", () => {
  const m = model();
  (m.funcs.get("adc.h::adc_read") as { x: number }).x = 1234;
  (m.funcs.get("adc.h::adc_read") as { y: number }).y = 567;
  (m.signals.get("adc.h::g_raw") as { x: number }).x = 11;
  (m.signals.get("adc.h::g_raw") as { y: number }).y = 22;
  const xml = toDrawio(m);

  const m2 = model();
  applyLayout(m2, readLayout(xml));
  const f = m2.funcs.get("adc.h::adc_read");
  assert.deepStrictEqual([f?.x, f?.y], [1234, 567]);
  const s = m2.signals.get("adc.h::g_raw");
  assert.deepStrictEqual([s?.x, s?.y], [11, 22]);
});

test("drawio: hand-drawn waypoints survive a round trip", () => {
  const m = model();
  (m.edges[0] as { waypoints: Array<[number, number]> }).waypoints = [
    [100, 200],
    [300, 400],
  ];
  const layout = readLayout(toDrawio(m));
  const e = m.edges[0] as { src: string; dst: string; rw: string };
  assert.deepStrictEqual(layout.edges.get(`${e.src}->${e.dst}:${e.rw}`), [
    [100, 200],
    [300, 400],
  ]);
});

test("drawio: reading a hand-edited file picks up resized nodes", () => {
  const m = model();
  // 注意用 replaceAll：Python 的 str.replace 默认全替换，JS 的 String.replace(字符串,字符串)
  // 只替换第一处 —— 只改一处会让这个测试悄悄测到另一个节点上。
  const edited = toDrawio(m).replaceAll('width="160" height="60"', 'width="260" height="90"');
  applyLayout(m, readLayout(edited));
  const s = m.signals.get("adc.h::g_raw");
  assert.deepStrictEqual([s?.w, s?.h], [260, 90]);
});

test("drawio: compressed <diagram> reads identically to the plain form", () => {
  const plain = readLayout(toDrawio(model()));
  const packed = readLayout(pack(toDrawio(model())));
  assert.deepStrictEqual([...packed.nodes], [...plain.nodes]);
  assert.deepStrictEqual([...packed.edges], [...plain.edges]);
  assert.deepStrictEqual([...packed.attrs], [...plain.attrs]);
  assert.ok(packed.nodes.size > 0);
});

test("drawio: compressed layout is not silently dropped", () => {
  const m = model();
  (m.signals.get("adc.h::g_raw") as { x: number }).x = 11;
  (m.signals.get("adc.h::g_raw") as { y: number }).y = 22;
  (m.funcs.get("adc.h::adc_read") as { x: number }).x = 1234;
  (m.funcs.get("adc.h::adc_read") as { y: number }).y = 567;
  const packed = pack(toDrawio(m));

  const m2 = model();
  applyLayout(m2, readLayout(packed));
  const f = m2.funcs.get("adc.h::adc_read");
  assert.deepStrictEqual([f?.x, f?.y], [1234, 567]);
  const s = m2.signals.get("adc.h::g_raw");
  assert.deepStrictEqual([s?.x, s?.y], [11, 22]);
});

test("drawio: compressed waypoints round trip", () => {
  const m = model();
  (m.edges[0] as { waypoints: Array<[number, number]> }).waypoints = [
    [100, 200],
    [300, 400],
  ];
  const layout = readLayout(pack(toDrawio(m)));
  const e = m.edges[0] as { src: string; dst: string; rw: string };
  assert.deepStrictEqual(layout.edges.get(`${e.src}->${e.dst}:${e.rw}`), [
    [100, 200],
    [300, 400],
  ]);
});

test("drawio: an unreadable <diagram> payload raises instead of returning empty", () => {
  const bad = '<mxfile><diagram id="d" name="p">not-a-compressed-payload</diagram></mxfile>';
  assert.throws(() => readLayout(bad), /压缩串/);
});

test("drawio: auto-generated waypoints are re-derived, human ones are kept", () => {
  const m1 = model();
  const xml = toDrawio(m1);

  const m2 = model();
  applyLayout(m2, readLayout(xml));
  // Auto points must be recognised and cleared, otherwise they would ossify on reuse.
  for (const e of m2.edges) assert.deepStrictEqual(e.waypoints, []);

  const m3 = model();
  const layout = readLayout(xml);
  const e3 = m3.edges[0] as { src: string; dst: string; rw: string };
  layout.edges.set(`${e3.src}->${e3.dst}:${e3.rw}`, [
    [7, 7],
    [9, 9],
  ]);
  applyLayout(m3, layout);
  assert.deepStrictEqual(m3.edges[0]?.waypoints, [
    [7, 7],
    [9, 9],
  ]);
});

// ─────────────────────────────────────────────────────────────────────────
// 边标签去叠印
//
// 为什么要单独守一组：撞标签只发生在**排版算出来的**坐标上，金标准小-c 里没有一对撞上
// 的标签 —— 也就是说金标准全绿也照不出这套逻辑的退化。而它退化的样子特别隐蔽：
// 两条标签叠在一处，图上仍"有"一个标签，读的人以为那儿只有一条线。
// ─────────────────────────────────────────────────────────────────────────

/** 一行标签的占位盒。高度按 12 号字一行（≈16.8）算，横向位置不影响竖直错位。 */
function labelAt(y: number): Rect {
  return [100, y, 60, 16.8];
}

test("drawio: 不撞的标签一个都不动", () => {
  // null = 这条边没有标签：既不参与碰撞，也不该被别人的位移带偏
  assert.deepEqual(separateLabels([labelAt(0), labelAt(100), null], LABEL_LANE), [0, 0, 0]);
});

test("drawio: 两条撞上时只推后来的一条，推的是竖直方向", () => {
  assert.deepEqual(separateLabels([labelAt(0), labelAt(4)], LABEL_LANE), [0, LABEL_LANE]);
});

test("drawio: 三条挤在一处时上下分开，不是都往同一边推", () => {
  // 都往下推的话，第三条要推到两格、第四条三格 —— 画布上没那么多余量，很快就出界
  assert.deepEqual(separateLabels([labelAt(0), labelAt(0), labelAt(0)], LABEL_LANE), [
    0,
    LABEL_LANE,
    -LABEL_LANE,
  ]);
});

test("drawio: 推一格不够远就要继续试下一格（会过冲的那种）", () => {
  // 第二条只比第一条高 6 像素：机械地推 +17 会落到 11 像素处，仍小于一个行高 ——
  // 表面上"挪过了"，实际还叠着。所以格位得试，不能按格号直接算。
  assert.deepEqual(separateLabels([labelAt(0), labelAt(-6)], LABEL_LANE), [0, -LABEL_LANE]);
});

test("drawio: 一串联的标签算一个整体", () => {
  // 甲撞乙、乙撞丙，但甲丙不撞。丙不能只看"我跟谁撞" —— 它得躲开整串已经落位的标签，
  // 否则会被推到甲的头上。近处的格子被甲、乙占了，丙只能落到第二格。
  assert.deepEqual(separateLabels([labelAt(0), labelAt(12), labelAt(24)], LABEL_LANE), [
    0,
    LABEL_LANE,
    2 * LABEL_LANE,
  ]);
});

/**
 * 造一个「两条边的标签必然重合」的最小工程。
 *
 * 关键在坐标由测试**钉死**：两组端点各自完全重合，两条边的折线互为平移（dy=0 时就是
 * 同一条），弧长中点必然落在同一处，标签也就必然叠印。这样前提不依赖自动排版怎么算；
 * 万一哪天造不出重叠，下面「恰好推开一条」的断言会立刻变红，不会静默退化成空测。
 *
 * dy 是第二条边整体的下移量，用来造「差一点点才撞上」的近邻情形。
 */
const PAIR_H = [
  "#ifndef PAIR_H",
  "#define PAIR_H",
  "",
  '/// @drawcode alias="甲信号"',
  "int g_a;",
  "",
  '/// @drawcode alias="乙信号"',
  "int g_b;",
  "",
  '/// @drawcode alias="甲函数"',
  "void f_one(void);",
  "",
  '/// @drawcode alias="乙函数"',
  "void f_two(void);",
  "",
  "#endif",
].join("\n");

const PAIR_C = [
  '#include "pair.h"',
  "",
  "void f_one(void)",
  "{",
  "    g_a = 1;",
  "}",
  "",
  "void f_two(void)",
  "{",
  "    g_b = 1;",
  "}",
].join("\n");

let fixtureDir: string | null = null;

function clashModel(dy: number) {
  if (fixtureDir === null) {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-clash-"));
    fs.writeFileSync(path.join(fixtureDir, "pair.h"), PAIR_H, "utf8");
    fs.writeFileSync(path.join(fixtureDir, "pair.c"), PAIR_C, "utf8");
  }
  const m = parseProject([path.join(fixtureDir, "pair.h"), path.join(fixtureDir, "pair.c")]);
  const place = (node: unknown, x: number, y: number): void => {
    const box = node as { x: number; y: number; w: number; h: number };
    box.x = x;
    box.y = y;
    box.w = 160;
    box.h = 60;
  };
  place(m.signals.get("pair.h::g_a"), 30, 60);
  place(m.signals.get("pair.h::g_b"), 30, 60 + dy);
  place(m.funcs.get("pair.h::f_one"), 420, 130);
  place(m.funcs.get("pair.h::f_two"), 420, 130 + dy);
  return m;
}

after(() => {
  if (fixtureDir !== null) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test("drawio: 被推开的边标签挪进 _label 子单元，位移写在 offset 上", () => {
  const xml = toDrawio(clashModel(0));
  const root = parseXml(xml);
  const labels = [...iterElements(root)].filter(
    (el) => el.tag === "mxCell" && (el.attrib.get("id") ?? "").endsWith("_label"),
  );
  assert.equal(labels.length, 1, "两条边的标签完全重合，应恰好推开一条");
  const cell = labels[0];
  assert.ok(cell !== undefined);

  const id = cell.attrib.get("id") as string;
  const owner = id.slice(0, -"_label".length);
  assert.equal(cell.attrib.get("parent"), owner, "子标签挂在被推开的那条边下面");
  assert.equal(cell.attrib.get("value"), "write", "挪的是位置，文字本身一个字不改");
  assert.equal(cell.attrib.get("vertex"), "1");

  const geom = findChild(cell, "mxGeometry");
  assert.ok(geom !== null);
  // 位移**不能**写进 mxGeometry 的 x/y：那是「沿边的垂直方向」的另一种语义
  // （见 drawio.ts 里那段注释），竖着的边上的标签会横着跑掉 —— 而这个错法在画布上
  // 同样"看着挪开了"，极难被发现。
  assert.equal(geom.attrib.get("x"), "0");
  assert.equal(geom.attrib.get("y"), "0");
  const offset = findChild(geom, "mxPoint");
  assert.ok(offset !== null);
  assert.equal(offset.attrib.get("as"), "offset");
  assert.equal(offset.attrib.get("x"), "0", "只往竖直方向推，不横着挪");
  assert.equal(offset.attrib.get("y"), String(LABEL_LANE), "正数往下：后来的一条压在上面，往下让一行");

  // 同一条边不能两处都带标签 —— 那会把同一句话画两遍
  const owners = [...iterElements(root)].filter(
    (el) => el.tag === "object" && el.attrib.get("id") === owner,
  );
  assert.equal(owners.length, 1);
  assert.ok(!owners[0]?.attrib.get("label"), "被推开的边自己不再留标签");

  // 没被推的那条原样不动（去叠印只该动撞上的，不该把整套标签都重排一遍）
  const kept = [...iterElements(root)].filter(
    (el) => el.tag === "object" && el.attrib.get("label") === "write",
  );
  assert.equal(kept.length, 1, "没被推的那条仍把标签写在自己身上");
});

test("drawio: 差几个像素才撞上的两条也会被推开", () => {
  const xml = toDrawio(clashModel(6));
  assert.equal((xml.match(/_label"/g) ?? []).length, 1, "相距 6 像素小于一个行高，仍算撞上");
});

test("drawio: _label 子单元读回来时不算「用户新加的节点」", () => {
  const layout = readLayout(toDrawio(clashModel(0)), true);
  // 少了 foreignCells 里那道「父是边就跳过」的守卫，sync 会把每条被推开的标签
  // 当成用户在 draw.io 里拖进来的新节点，然后往源码里写一个名叫「write」的函数。
  assert.deepEqual(layout.foreign, []);
  assert.equal(layout.nodes.size, 4, "两个信号 + 两个函数，一个不多 —— 子标签不是节点");
  assert.equal(layout.edges.size, 2, "子标签也没把那两条边顶掉");
});

// ─────────────────────────────────────────────────────────────────────────
// 人工排版回读：pinned —— 哪些实体的几何被人动过
//
// 判据是「读出值 vs build 本来会写出的值」，为什么这么定见 applyLayout 的注释。
// 这一组里最关键的是「源码里声明过 xy、图上没改 -> 空表」：它是 sync
// 「没人动过就零 diff」的保证。空表还意味着整条回写链上没有任何新行为，
// 产物逐字节不变。
// ─────────────────────────────────────────────────────────────────────────

/** 全实体的几何（x/y/w/h 逐字段），给「跑两遍不变」的深比较用。 */
function geometry(m: Model): Map<string, [number, number, number, number]> {
  const out = new Map<string, [number, number, number, number]>();
  for (const s of m.signals.values()) out.set(s.id, [s.x, s.y, s.w, s.h]);
  for (const f of m.funcs.values()) out.set(f.id, [f.x, f.y, f.w, f.h]);
  return out;
}

test("drawio: 被拖过的节点进 pinned.xy，值等于读回值", () => {
  const layout = readLayout(toDrawio(model()));
  const sid = "adc.h::g_raw";
  const read = layout.nodes.get(sid);
  assert.ok(read !== undefined);
  const moved: Rect = [read[0] + 100, read[1] + 40, read[2], read[3]];
  layout.nodes.set(sid, moved);

  const m = model();
  applyLayout(m, layout);
  assert.deepStrictEqual(m.pinned.get(sid)?.xy, [moved[0], moved[1]]);
  assert.equal(m.pinned.get(sid)?.size, undefined, "宽高没动，size 不该出现");
  assert.equal(m.pinned.size, 1, "只有这一个节点被动过");
  // 几何覆盖本身照旧 —— 这张表只是多出来的记录，不改变既有行为
  assert.deepStrictEqual([m.signals.get(sid)?.x, m.signals.get(sid)?.y], [moved[0], moved[1]]);
});

test("drawio: 只缩放不拖 → 只有 size，xy 缺失", () => {
  const layout = readLayout(toDrawio(model()));
  const sid = "adc.h::g_raw";
  const read = layout.nodes.get(sid);
  assert.ok(read !== undefined);
  const resized: Rect = [read[0], read[1], read[2] + 40, read[3] + 30];
  layout.nodes.set(sid, resized);

  const m = model();
  applyLayout(m, layout);
  const p = m.pinned.get(sid);
  assert.ok(p !== undefined);
  assert.equal(p.xy, undefined, "x/y 没动，xy 不该出现");
  assert.deepStrictEqual(p.size, [resized[2], resized[3]]);
});

test("drawio: 图上没人动过 → pinned 是空表", () => {
  const m = model();
  applyLayout(m, readLayout(toDrawio(model())));
  assert.deepStrictEqual([...m.pinned], []);
});

test("drawio: 源码里声明过 xy 的节点，图上没改也不进 pinned", () => {
  // adc_read 在 examples/small/c/adc.h 里就带 xy="420,160"（金标准 expected.drawio
  // 里能查到同一对坐标），它的位置与默认布局本来就不同。若基线取默认布局而不是
  // 「build 会写出的值」，这个键会在每次 sync 时被重写一遍 —— 零 diff 当场破功。
  const m = model();
  const declared = m.funcs.get("adc.h::adc_read");
  assert.deepStrictEqual([declared?.x, declared?.y], [420, 160], "前置条件：解析器把 xy 落进了 IR");

  applyLayout(m, readLayout(toDrawio(model())));
  assert.ok(!m.pinned.has("adc.h::adc_read"), "源码声明过的坐标不是「人拖过」");
  assert.equal(m.pinned.size, 0);
});

test("drawio: 容器 cell / callout / 未知 id 不进 pinned", () => {
  const withCallout = (): Model => {
    const m = model();
    m.addCallout(makeCallout({ id: "co:说明", text: "图例", x: 10, y: 10, w: 120, h: 40 }));
    return m;
  };
  const layout = readLayout(toDrawio(withCallout()));
  // 前置条件：callout 是带 symbolId 的 <object>，**确实**会出现在 layout.nodes 里，
  // 所以它进不进 pinned，全靠 applyLayout 里「signals/funcs 都查无此人就跳过」那道守卫。
  assert.ok(layout.nodes.has("co:说明"), "callout 应当出现在 layout.nodes 里");
  layout.nodes.set("grp1", [0, 0, 50, 50]); // 容器 cell 的 id 形状
  layout.nodes.set("不存在.h::ghost", [5, 5, 5, 5]); // 图上有、源码里没有的 id

  const m = withCallout();
  applyLayout(m, layout);
  assert.deepStrictEqual([...m.pinned], []);
});

test("drawio: assignDefaultPositions 对同一模型是固定点（单层容器）", () => {
  const m = model();
  assignDefaultPositions(m);
  const first = geometry(m);
  assignDefaultPositions(m);
  assert.deepStrictEqual(geometry(m), first);
});

test("drawio: [已知缺陷] 多层容器下 assignDefaultPositions 不是固定点，非最深层每跑一次 +30", () => {
  // 单层容器走 stack() 的「x===0&&y===0 才落位」哨兵分支，那一支是固定点（上一条测试）。
  // 多层容器走 layoutTree 里「dx = cursor - box[0]」的**平移累加**分支 —— 它把已经带
  // 全局坐标的子孙当成局部坐标再推一次，于是**不是**固定点：每跑一次，非最深层的实体
  // 整体右移 PAD(30)，且不收敛（450 -> 480 -> 510）。
  //
  // 这是**先于「人工拖拽几何回写」就存在**的缺陷：layoutTree 在 HEAD 与工作区逐字节相同。
  // 修它会动金标准坐标，超出本特性范围，所以这里**不修，只把现状原样钉死**。
  //
  // 为什么钉而不是留一条永远红的断言：留红断言会让 `npm test` 长期带红，后来的人就再也
  // 分不清「哪条红是真回归」——本轮三条并行改动里已经有人被它误导过一次。钉死现状既能
  // 保住信号（将来谁修了这个缺陷，这条会立刻红并提示「缺陷已修，请更新本测试」），
  // 又让其余测试的红成为可信信号。
  //
  // 断言比「两次结果相同」更严格：逐实体核对位移量，并用第二遍、第三遍证明它**不收敛**。
  //
  // 容器层级手工指定（不依赖解析器的 path= 注解）：这里要测的是布局函数的性质，
  // 与 path 从哪来无关，手工指定能让这个测试只随 assignDefaultPositions 的变化而变。
  const m = model();
  const place: Array<[string, string]> = [
    ["adc.h::g_raw", "grp/甲"],
    ["adc.h::adc_read", "grp/甲"],
    ["adc.h::g_filtered", "grp/甲/乙"],
    ["dsp.h::g_coeff", "grp/甲/乙"],
    ["dsp.h::fir_apply", "grp/甲/乙/丙"],
    ["dsp.h::dsp_set_gain", "other"],
  ];
  for (const [sid, p] of place) {
    const ent = m.signals.get(sid) ?? m.funcs.get(sid);
    assert.ok(ent !== undefined, `fixture 缺少实体 ${sid}`);
    ent.path = p;
    ent.group = p.split("/")[0] as string;
  }

  assignDefaultPositions(m);
  const first = geometry(m);
  // 非空转守卫：最深一层（丙）的成员先在局部 (0,0) 排、再由父层 dx 推走 ——
  // x 若仍为 0，说明平移累加那一支根本没执行，这条测试就退化成没覆盖它。
  const deep = first.get("dsp.h::fir_apply");
  assert.ok(deep !== undefined);
  assert.notEqual(deep[0], 0, "深层成员应当被父层平移过");

  // 每再跑一遍，各实体的 x 位移量（实测值，= PAD）。
  // 最深一层（丙）的成员是唯一不动的：它在局部坐标里已经没有可再平移的子孙。
  const DRIFT: Array<[string, number]> = [
    ["adc.h::g_raw", 30],
    ["adc.h::adc_read", 30],
    ["adc.h::g_filtered", 30],
    ["dsp.h::g_coeff", 30],
    ["dsp.h::fir_apply", 0],
    ["dsp.h::dsp_set_gain", 30],
  ];

  for (const round of [2, 3]) {
    const before = geometry(m);
    assignDefaultPositions(m);
    const after = geometry(m);
    for (const [sid, dx] of DRIFT) {
      const b = before.get(sid);
      const a = after.get(sid);
      assert.ok(b !== undefined && a !== undefined, `第 ${round} 遍缺少 ${sid}`);
      assert.equal(a[0], b[0] + dx, `第 ${round} 遍：${sid} 的 x 位移应为 ${dx}`);
      // 位移只在 x 上：y/w/h 必须一字不动，否则「+30」这个结论就是错的
      assert.deepStrictEqual([a[1], a[2], a[3]], [b[1], b[2], b[3]], `第 ${round} 遍：${sid} 只有 x 该动`);
    }
  }
});
