import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { test } from "node:test";

import { applyLayout, quote, readLayout, toDrawio } from "../src/drawio.ts";
import { parseProject } from "../src/cparse.ts";
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
    assert.ok(cell !== undefined);
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
