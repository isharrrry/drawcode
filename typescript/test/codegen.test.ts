import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { renderSignal, syncFunctions, syncHeader, syncSource } from "../src/codegen.ts";
import { parseProject } from "../src/cparse.ts";
import { applyLayout, readLayout, toDrawio } from "../src/drawio.ts";
import { makeSignal } from "../src/model.ts";
import type { Model } from "../src/model.ts";
import type { XmlElement } from "../src/xml.ts";
import { findChild, iterElements, parseXml, serializeXml } from "../src/xml.ts";
import { EXAMPLES_C, REPO } from "./helpers.ts";

const NAMES = ["adc.h", "adc.c", "dsp.h", "dsp.c"];

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-ts-"));
  for (const n of NAMES) {
    fs.copyFileSync(path.join(EXAMPLES_C, n), path.join(dir, n));
  }
  return dir;
}

function pathsOf(dir: string): string[] {
  return NAMES.map((n) => path.join(dir, n));
}

function parseDir(dir: string): Model {
  return parseProject(pathsOf(dir), dir);
}

function readOf(dir: string, name: string): string {
  return fs.readFileSync(path.join(dir, name), "utf8");
}

function el(tag: string, attrib: Record<string, string> = {}): XmlElement {
  return { tag, attrib: new Map(Object.entries(attrib)), children: [], text: null, tail: null };
}

/** 用 XML 结构化编辑模拟人在 draw.io 里的四类操作。 */
function editLikeDrawio(xml: string): string {
  const tree = parseXml(xml);
  for (const o of iterElements(tree)) {
    if (o.tag !== "object") continue;
    const sid = o.attrib.get("symbolId");
    if (sid === "adc.h::g_raw") {
      o.attrib.set("alias", "原始采样");
      o.attrib.set("dir", "out");
    }
    if (sid === "adc.h::adc_read") {
      const g = findChild(findChild(o, "mxCell") as XmlElement, "mxGeometry") as XmlElement;
      g.attrib.set("x", String(Number(g.attrib.get("x")) + 100));
      g.attrib.set("y", String(Number(g.attrib.get("y")) + 100));
      g.attrib.set("width", "220");
    }
    if (o.attrib.get("src") === "adc.h::g_raw" && o.attrib.get("dst") === "adc.h::adc_read") {
      const geom = findChild(findChild(o, "mxCell") as XmlElement, "mxGeometry") as XmlElement;
      geom.children = geom.children.filter((c) => c.tag !== "Array");
      const arr = el("Array", { as: "points" });
      arr.children.push(el("mxPoint", { x: "180", y: "150" }));
      geom.children.push(arr);
    }
  }
  return serializeXml(tree);
}

test("codegen: render_signal with array type and annotation", () => {
  const s = makeSignal({ id: "x.h::g_new", name: "g_new", ctype: "float[8]", dir: "out", unit: "V", alias: "新信号" });
  assert.equal(
    renderSignal(s),
    '/// @drawcode dir=out unit="V" alias="新信号"\nfloat g_new[8];',
  );
});

test("codegen: render_signal minimal carries the direction", () => {
  const s = makeSignal({ id: "x.h::g_a", name: "g_a", ctype: "uint8_t", dir: "in" });
  assert.equal(renderSignal(s), '/// @drawcode dir=in\nuint8_t g_a;');
});

test("codegen: syncHeader is idempotent on an untouched file", () => {
  const dir = tempProject();
  try {
    const before = readOf(dir, "adc.h");
    syncHeader(path.join(dir, "adc.h"), parseDir(dir), "adc.h");
    assert.equal(readOf(dir, "adc.h"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: syncHeader updates an alias in place", () => {
  const dir = tempProject();
  try {
    const m = parseDir(dir);
    (m.signals.get("adc.h::g_raw") as { alias: string }).alias = "改名后的采样值";
    syncHeader(path.join(dir, "adc.h"), m, "adc.h");
    const text = readOf(dir, "adc.h");
    assert.ok(text.includes('dir=in unit="LSB" alias="改名后的采样值"'));
    assert.ok(!text.includes('alias="原始采样值"'));
    assert.ok(text.includes("int16_t g_raw;"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: syncHeader appends a new signal before #endif", () => {
  const dir = tempProject();
  try {
    const m = parseDir(dir);
    m.addSignal(
      makeSignal({ id: "adc.h::g_new", name: "g_new", ctype: "uint8_t", dir: "out", file: "adc.h", alias: "新增" }),
    );
    syncHeader(path.join(dir, "adc.h"), m, "adc.h");
    const text = readOf(dir, "adc.h");
    assert.ok(text.includes("uint8_t g_new;"));
    assert.ok(text.indexOf("g_new") < text.indexOf("#endif"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: syncHeader leaves unrelated code untouched", () => {
  const dir = tempProject();
  try {
    const m = parseDir(dir);
    (m.signals.get("adc.h::g_raw") as { note: string }).note = "";
    syncHeader(path.join(dir, "adc.h"), m, "adc.h");
    const text = readOf(dir, "adc.h");
    assert.ok(text.includes("#include <stdint.h>"));
    assert.ok(text.includes('dir=in unit="LSB"'));
    assert.ok(text.includes("int16_t adc_read(void);"));
    assert.ok(text.includes("#ifndef ADC_H"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: syncFunctions leaves an untouched file alone", () => {
  const dir = tempProject();
  try {
    const before = readOf(dir, "adc.h");
    syncFunctions(path.join(dir, "adc.h"), parseDir(dir), "adc.h");
    assert.equal(readOf(dir, "adc.h"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: alias update keeps hand-written layout attributes", () => {
  const dir = tempProject();
  try {
    const m = parseDir(dir);
    (m.funcs.get("adc.h::adc_read") as { alias: string }).alias = "采集入口";
    syncFunctions(path.join(dir, "adc.h"), m, "adc.h");
    const text = readOf(dir, "adc.h");
    assert.ok(text.includes('alias="采集入口"'));
    assert.ok(!text.includes('alias="ADC 采样"'));
    assert.ok(text.includes('xy="420,160"'));
    assert.ok(text.includes('size="180x72"'));
    assert.ok(text.includes("int16_t adc_read(void);"));
    assert.ok(text.includes('vendor="TI"'));
    assert.ok(text.includes('asset="assets/ads1115.svg"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: device annotation is rewritten", () => {
  const dir = tempProject();
  try {
    const m = parseDir(dir);
    (m.devices.get("adc.h::adc_read") as { spec: string }).spec = "16bit/2kSPS";
    syncFunctions(path.join(dir, "adc.h"), m, "adc.h");
    assert.ok(readOf(dir, "adc.h").includes('spec="16bit/2kSPS"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: syncFunctions is idempotent after an edit", () => {
  const dir = tempProject();
  try {
    const m = parseDir(dir);
    (m.funcs.get("adc.h::adc_read") as { note: string }).note = "待确认中断上下文";
    syncFunctions(path.join(dir, "adc.h"), m, "adc.h");
    const once = readOf(dir, "adc.h");
    syncFunctions(path.join(dir, "adc.h"), m, "adc.h");
    assert.equal(readOf(dir, "adc.h"), once);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("roundtrip: code -> graph -> code is stable", () => {
  const dir = tempProject();
  try {
    const m1 = parseDir(dir);
    const xml = toDrawio(m1);

    const m2 = parseDir(dir);
    applyLayout(m2, readLayout(xml));
    for (const p of pathsOf(dir)) syncHeader(p, m2, path.basename(p));
    const first = Object.fromEntries(NAMES.map((n) => [n, readOf(dir, n)]));

    const m3 = parseDir(dir);
    for (const p of pathsOf(dir)) syncHeader(p, m3, path.basename(p));
    const second = Object.fromEntries(NAMES.map((n) => [n, readOf(dir, n)]));

    assert.deepStrictEqual(first, second);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("roundtrip: human layout survives and writes nothing back to code", () => {
  const dir = tempProject();
  try {
    const m1 = parseDir(dir);
    const xml = toDrawio(m1);

    const m2 = parseDir(dir);
    const layout = readLayout(xml);
    layout.nodes.set("adc.h::adc_read", [900, 700, 200, 80]);
    applyLayout(m2, layout);

    const xml2 = toDrawio(m2);
    const m3 = parseDir(dir);
    applyLayout(m3, readLayout(xml2));
    const f = m3.funcs.get("adc.h::adc_read");
    assert.deepStrictEqual([f?.x, f?.y], [900, 700]);
    assert.deepStrictEqual([f?.w, f?.h], [200, 80]);

    const before = readOf(dir, "adc.h");
    for (const p of pathsOf(dir)) syncHeader(p, m3, path.basename(p));
    assert.equal(readOf(dir, "adc.h"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("roundtrip: a node added in the graph lands in the header", () => {
  const dir = tempProject();
  try {
    const m = parseDir(dir);
    m.addSignal(
      makeSignal({
        id: "adc.h::g_alarm",
        name: "g_alarm",
        ctype: "uint8_t",
        dir: "out",
        file: "adc.h",
        alias: "报警输出",
        group: "adc",
      }),
    );
    syncHeader(path.join(dir, "adc.h"), m, "adc.h");

    const m2 = parseDir(dir);
    assert.ok(m2.signals.has("adc.h::g_alarm"));
    assert.equal(m2.signals.get("adc.h::g_alarm")?.dir, "out");
    assert.equal(m2.signals.get("adc.h::g_alarm")?.alias, "报警输出");
    assert.ok(toDrawio(m2).includes("adc.h::g_alarm"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("roundtrip: annotations survive code -> graph -> code", () => {
  const dir = tempProject();
  try {
    const m = parseDir(dir);
    (m.funcs.get("adc.h::adc_read") as { alias: string }).alias = "采集入口";
    (m.signals.get("adc.h::g_raw") as { unit: string }).unit = "mV";
    for (const p of pathsOf(dir)) syncHeader(p, m, path.basename(p));

    const m2 = parseDir(dir);
    // 函数别名只由 syncFunctions 回写，所以这里仍是原值。
    assert.equal(m2.funcs.get("adc.h::adc_read")?.alias, "ADC 采样");
    assert.equal(m2.signals.get("adc.h::g_raw")?.unit, "mV");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("edit-back: an edited .drawio flows back into the source", () => {
  const dir = tempProject();
  try {
    const xml = toDrawio(parseDir(dir));
    assert.ok(xml.includes('alias="原始采样值"'));
    assert.ok(xml.includes('dir="in"'));
    assert.ok(readOf(dir, "adc.h").includes('dir=in unit="LSB" alias="原始采样值"'));

    const layout = readLayout(editLikeDrawio(xml));
    const m = parseDir(dir);
    applyLayout(m, layout);
    for (const p of pathsOf(dir)) syncSource(p, m, path.basename(p));

    const header = readOf(dir, "adc.h");
    assert.ok(header.includes('alias="原始采样"'));
    assert.ok(!header.includes('alias="原始采样值"'));
    assert.ok(header.includes('dir=out unit="LSB" alias="原始采样"'));
    assert.ok(!header.includes('dir=in unit="LSB"'));
    assert.ok(header.includes("#include <stdint.h>"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("edit-back: edited layout survives, and edge waypoints become absolute", () => {
  const dir = tempProject();
  try {
    const xml = toDrawio(parseDir(dir));
    const before = readLayout(xml).nodes.get("adc.h::adc_read") as [number, number, number, number];
    const layout = readLayout(editLikeDrawio(xml));
    const after = layout.nodes.get("adc.h::adc_read") as [number, number, number, number];

    assert.equal(after[0], before[0] + 100);
    assert.equal(after[1], before[1] + 100);
    assert.equal(after[2], 220);

    // mxPoint 与 mxGeometry 同在父容器坐标系里，回读时统一还原成画布绝对坐标
    const tree = parseXml(xml);
    let rel: XmlElement | null = null;
    for (const o of iterElements(tree)) {
      if (o.tag === "object" && o.attrib.get("symbolId") === "adc.h::adc_read") {
        rel = findChild(findChild(o, "mxCell") as XmlElement, "mxGeometry");
      }
    }
    const ox = before[0] - Number((rel as XmlElement).attrib.get("x"));
    const oy = before[1] - Number((rel as XmlElement).attrib.get("y"));

    const key = "adc.h::g_raw->adc.h::adc_read:read";
    assert.deepStrictEqual(layout.edges.get(key), [[180 + ox, 150 + oy]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("edit-back: roundtrip after an edit is stable", () => {
  const dir = tempProject();
  try {
    const xml = toDrawio(parseDir(dir));
    const m1 = parseDir(dir);
    applyLayout(m1, readLayout(editLikeDrawio(xml)));
    for (const p of pathsOf(dir)) syncSource(p, m1, path.basename(p));
    const first = Object.fromEntries(NAMES.map((n) => [n, readOf(dir, n)]));

    for (const p of pathsOf(dir)) syncSource(p, parseDir(dir), path.basename(p));
    assert.deepStrictEqual(first, Object.fromEntries(NAMES.map((n) => [n, readOf(dir, n)])));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("edit-back: editing a .drawio on disk, then reading it back", () => {
  const dir = tempProject();
  try {
    const file = path.join(dir, "g.drawio");
    fs.writeFileSync(file, toDrawio(parseDir(dir)), "utf8");
    fs.writeFileSync(file, editLikeDrawio(fs.readFileSync(file, "utf8")), "utf8");

    const m = parseDir(dir);
    applyLayout(m, readLayout(fs.readFileSync(file, "utf8")));
    syncSource(path.join(dir, "adc.h"), m, "adc.h");
    assert.ok(readOf(dir, "adc.h").includes('dir=out unit="LSB"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
