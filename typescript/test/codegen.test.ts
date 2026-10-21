import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  renderCsAnnotation,
  renderSignal,
  syncCsMethods,
  syncCsSource,
  syncFunctions,
  syncHeader,
  syncSource,
} from "../src/codegen.ts";
import { parseProject } from "../src/cparse.ts";
import { parseCsProject } from "../src/csparse.ts";
import { applyLayout, readLayout, toDrawio } from "../src/drawio.ts";
import { makeSignal } from "../src/model.ts";
import type { Model, Signal } from "../src/model.ts";
import type { XmlElement } from "../src/xml.ts";
import { findChild, iterElements, parseXml, serializeXml } from "../src/xml.ts";
import { EXAMPLES_C, EXAMPLES_CS, REPO } from "./helpers.ts";

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

// ---------------------------------------------------------------------------
// 几何回写（pinned）：把「人拖过的几何」写回源码注解，同时不抹掉源码里手写的键。
//
// 受管夹具里没有手写的 `xy`/`size`/`style`（作者手工钉过的几何），所以每个用例先往
// temp 副本里**注入**这些键 —— 没有它们，「合并」与「整行重建」两种行为无法区分。
// 每个注入型用例都配一条对照断言：直接调 `renderSignal`/`renderCsAnnotation`（即旧的
// 「整行重建」路径产物）里没有这些手写键 —— 证明"保住原样"只可能来自合并路径；
// 若哪天有人把实现改回重建，对照断言会先炸。
// ---------------------------------------------------------------------------

const CS_NAMES = ["Adc.cs", "Dsp.cs"];

/**
 * C# 信号注解（夹具原样）与注入了手写 Xy/Size/Style 的版本。
 *
 * 夹具里 `g_raw` 的注解**刻意跨两行**：参数一多，IDE 与作者都会换行，回写必须能认出
 * 并就地合并整条语句。若哪天实现退回「只看行首是不是 `[`」，这里会在字段上方多插一条
 * `[Drawcode]`，下面的断言随即炸掉。
 */
const CS_GRAW =
  '[Drawcode(Direction.In, Unit = "LSB", Alias = "原始采样值",\n' +
  '            Note = "上电后需校准", Path = "adc/采样前端", Tags = "telemetry,rmem")]';
const CS_GRAW_HAND =
  '[Drawcode(Direction.In, Unit = "LSB", Alias = "原始采样值",\n' +
  '            Note = "上电后需校准", Path = "adc/采样前端", Tags = "telemetry,rmem", Xy = "360,130", Size = "160x60", Style = "strokeColor=#4d7ea8;")]';

function tempCsProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-ts-cs-"));
  for (const n of CS_NAMES) {
    fs.copyFileSync(path.join(EXAMPLES_CS, n), path.join(dir, n));
  }
  return dir;
}

function parseCsDir(dir: string): Model {
  return parseCsProject(
    CS_NAMES.map((n) => path.join(dir, n)),
    dir,
  );
}

/**
 * 往 temp 副本里注入手写键，模拟「作者手工钉过几何」。
 * 锚点找不到就断言失败（而不是静默不注入）——夹具漂移时测试必须响，不能空转通过。
 */
function injectOnce(dir: string, name: string, from: string, to: string): void {
  const p = path.join(dir, name);
  const text = fs.readFileSync(p, "utf8");
  assert.ok(text.includes(from), `fixture drift: ${name} 里找不到注入锚点: ${from}`);
  fs.writeFileSync(p, text.replace(from, to), "utf8");
}

/** 一个方法组件的真实形状：`[Drawcode]` 与签名之间隔着 `[Device]`，且带手写几何。 */
const DEVICES_CS = `namespace Drawcode
{
    public static class Devices
    {
        [Drawcode(Alias = "采集计算机", Asset = "图片/设备-采集计算机.png", Note = "采集设备主机", Xy = "1480,260", Size = "220x165")]
        [Device(Model = "示例型号")]
        public static Hardware dev_collector()
        {
            return null;
        }

        [Device(Model = "另一台")]
        [Drawcode(Alias = "设备二", Xy = "100,100")]
        public static Hardware dev_other()
        {
            return null;
        }

        [Drawcode(Alias = "分离注解", Xy = "10,20")]

        public static Hardware dev_sep()
        {
            return null;
        }
    }
}`;

test("codegen: hand-written signal geometry survives an unrelated C sync (the pre-fix erase)", () => {
  const dir = tempProject();
  try {
    injectOnce(
      dir,
      "adc.h",
      '/// @drawcode dir=in unit="LSB" alias="原始采样值" note="上电后需校准"',
      '/// @drawcode dir=in unit="LSB" alias="原始采样值" note="上电后需校准" xy="40,120" size="160x60" style="rounded=0;"',
    );
    const m = parseDir(dir);
    const sig = m.signals.get("adc.h::g_raw") as Signal;
    sig.alias = "改名后的采样值";
    assert.ok(syncHeader(path.join(dir, "adc.h"), m, "adc.h"));
    const text = readOf(dir, "adc.h");
    // 手写的 xy/size/style 原样存活，alias 就地替换，dir 仍是裸值写法
    assert.ok(
      text.includes(
        'dir=in unit="LSB" alias="改名后的采样值" note="上电后需校准" xy="40,120" size="160x60" style="rounded=0;"',
      ),
    );
    // 对照组：重建路径（旧实现）的产物里没有这些手写键 —— 抹掉是旧行为
    assert.ok(!renderSignal(sig).includes("xy="));
    assert.ok(!renderSignal(sig).includes("style="));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: a dragged signal replaces its geometry in place, hand-written style survives", () => {
  const dir = tempProject();
  try {
    injectOnce(
      dir,
      "adc.h",
      '/// @drawcode dir=in unit="LSB" alias="原始采样值" note="上电后需校准"',
      '/// @drawcode dir=in unit="LSB" alias="原始采样值" note="上电后需校准" xy="40,120" size="160x60" style="rounded=0;"',
    );
    const m = parseDir(dir);
    m.pinned.set("adc.h::g_raw", { xy: [420, 160], size: [180, 72] });
    assert.ok(syncHeader(path.join(dir, "adc.h"), m, "adc.h"));
    const text = readOf(dir, "adc.h");
    // 逗号 + 小写 x：与 cparse.applyGeometry 的切法逐字一致（写错会静默得到 NaN 尺寸）
    assert.ok(text.includes('xy="420,160" size="180x72"'));
    assert.ok(!text.includes('xy="40,120"'));
    assert.ok(text.includes('style="rounded=0;"'));
    assert.ok(text.includes('alias="原始采样值"'));

    // 幂等：回写后的文件重新解析（pinned 自然为空），再 sync 必须不动
    const before = readOf(dir, "adc.h");
    assert.equal(syncHeader(path.join(dir, "adc.h"), parseDir(dir), "adc.h"), false);
    assert.equal(readOf(dir, "adc.h"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: a dragged function replaces only the dragged axis, in place", () => {
  const dir = tempProject();
  try {
    const m = parseDir(dir);
    // 只拖了位置：手写的 size 不该被动（pinned.size 省略 = 这次没被缩放）
    m.pinned.set("adc.h::adc_read", { xy: [420, 260] });
    assert.ok(syncFunctions(path.join(dir, "adc.h"), m, "adc.h"));
    const text = readOf(dir, "adc.h");
    assert.ok(
      text.includes('/// @drawcode alias="ADC 采样" xy="420,260" size="180x72" tooltip="上电后需先校准"'),
    );
    assert.ok(!text.includes('xy="420,160"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: a dragged function without geometry gets xy and size appended", () => {
  const dir = tempProject();
  try {
    const m = parseDir(dir);
    m.pinned.set("dsp.h::fir_apply", { xy: [300, 300], size: [200, 90] });
    assert.ok(syncFunctions(path.join(dir, "dsp.h"), m, "dsp.h"));
    const text = readOf(dir, "dsp.h");
    assert.ok(text.includes('/// @drawcode alias="FIR 滤波" xy="300,300" size="200x90"'));
    // 没被拖过的邻居一字不动
    assert.ok(text.includes('/// @drawcode alias="设置增益"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: a keyless empty-dir signal still round-trips (no bare annotation)", () => {
  const dir = tempProject();
  try {
    const m = parseDir(dir);
    m.addSignal(
      makeSignal({ id: "adc.h::g_nd", name: "g_nd", ctype: "int16_t", dir: "", file: "adc.h" }),
    );
    assert.ok(syncHeader(path.join(dir, "adc.h"), m, "adc.h"));
    // 键全空时也必须落一个可读回的键；光写 `/// @drawcode` 解析侧不认
    assert.ok(readOf(dir, "adc.h").includes('/// @drawcode dir=""\nint16_t g_nd;'));
    const m2 = parseDir(dir);
    const back = m2.signals.get("adc.h::g_nd");
    assert.ok(back !== undefined, "读不回来 ⇒ 下次 sync 会把它当新元素重复追加");
    assert.equal(back?.dir, "");
    const before = readOf(dir, "adc.h");
    assert.equal(syncHeader(path.join(dir, "adc.h"), m2, "adc.h"), false);
    assert.equal(readOf(dir, "adc.h"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: no drags means byte-identical C output (the headline criterion)", () => {
  const dir = tempProject();
  try {
    // 连手写键也一起就位：没人拖过时，连它们也一字不动
    injectOnce(
      dir,
      "adc.h",
      '/// @drawcode dir=in unit="LSB" alias="原始采样值" note="上电后需校准"',
      '/// @drawcode dir=in unit="LSB" alias="原始采样值" note="上电后需校准" xy="40,120" size="160x60" style="rounded=0;"',
    );
    const m = parseDir(dir);
    const before = Object.fromEntries(NAMES.map((n) => [n, readOf(dir, n)]));
    for (const p of pathsOf(dir)) {
      assert.equal(syncSource(p, m, path.basename(p)), false, `${path.basename(p)} 不该被写`);
    }
    for (const n of NAMES) assert.equal(readOf(dir, n), before[n]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: hand-written C# signal args survive (Style, Xy) with an empty pinned", () => {
  const dir = tempCsProject();
  try {
    injectOnce(dir, "Adc.cs", CS_GRAW, CS_GRAW_HAND);
    const m = parseCsDir(dir);
    const sig = m.signals.get("Adc.cs::g_raw") as Signal;
    sig.alias = "改名后的采样值";
    assert.ok(syncCsSource(path.join(dir, "Adc.cs"), m, "Adc.cs"));
    const text = readOf(dir, "Adc.cs");
    // 位置参数 Direction.In 原位、换行与手写键原样，只有 Alias 被就地替换
    assert.ok(
      text.includes(
        '[Drawcode(Direction.In, Unit = "LSB", Alias = "改名后的采样值",\n' +
          '            Note = "上电后需校准", Path = "adc/采样前端", Tags = "telemetry,rmem", Xy = "360,130", Size = "160x60", Style = "strokeColor=#4d7ea8;")]',
      ),
    );
    // 跨行注解仍然只有一条：没被误判成「没有注解」而在字段上方多插一行。
    // 按行定位 g_raw 声明，它正上方的两行必须恰好是合并后的整条注解。
    const ls = text.split("\n");
    const decl = ls.findIndex((l) => l.includes("public static short g_raw;"));
    assert.deepEqual(ls.slice(decl - 2, decl), [
      '        [Drawcode(Direction.In, Unit = "LSB", Alias = "改名后的采样值",',
      '            Note = "上电后需校准", Path = "adc/采样前端", Tags = "telemetry,rmem", Xy = "360,130", Size = "160x60", Style = "strokeColor=#4d7ea8;")]',
    ]);
    // 对照组：重建路径（旧实现）的产物里没有 Xy/Style —— 抹掉是旧行为
    const rebuilt = renderCsAnnotation(sig).join("");
    assert.ok(!rebuilt.includes("Xy"));
    assert.ok(!rebuilt.includes("Style"));
    // 没被动过的邻居（Direction.Out 位置参数）一字不动
    assert.ok(text.includes('[Drawcode(Direction.Out, Unit = "LSB", Alias = "滤波输出", Tags = "telemetry")]'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: a dragged C# signal replaces Xy/Size in place and appends when absent", () => {
  const dir = tempCsProject();
  try {
    injectOnce(dir, "Adc.cs", CS_GRAW, CS_GRAW_HAND);
    const m = parseCsDir(dir);
    m.pinned.set("Adc.cs::g_raw", { xy: [400, 200], size: [200, 80] });
    m.pinned.set("Adc.cs::g_filtered", { xy: [500, 250] });
    assert.ok(syncCsSource(path.join(dir, "Adc.cs"), m, "Adc.cs"));
    const text = readOf(dir, "Adc.cs");
    assert.ok(
      text.includes(
        '[Drawcode(Direction.In, Unit = "LSB", Alias = "原始采样值",\n' +
          '            Note = "上电后需校准", Path = "adc/采样前端", Tags = "telemetry,rmem", Xy = "400,200", Size = "200x80", Style = "strokeColor=#4d7ea8;")]',
      ),
    );
    // 原本没有几何的信号：Xy 追加到实参末尾，Direction.Out 位置参数仍在首位
    assert.ok(
      text.includes('[Drawcode(Direction.Out, Unit = "LSB", Alias = "滤波输出", Tags = "telemetry", Xy = "500,250")]'),
    );

    // 幂等：回写后重新解析（pinned 自然为空），再 sync 必须不动
    const before = readOf(dir, "Adc.cs");
    assert.equal(syncCsSource(path.join(dir, "Adc.cs"), parseCsDir(dir), "Adc.cs"), false);
    assert.equal(readOf(dir, "Adc.cs"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: a dragged C# method merges its Drawcode line, [Device] and signature untouched", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-ts-csdev-"));
  try {
    const file = path.join(dir, "Devices.cs");
    fs.writeFileSync(file, DEVICES_CS, "utf8");

    // 没人拖动：一行都不许动（手写 Xy/Size 原样）
    const m0 = parseCsProject([file], dir);
    assert.equal(syncCsMethods(file, m0, "Devices.cs"), false);
    assert.equal(readOf(dir, "Devices.cs"), DEVICES_CS);

    // 拖了两个方法：真实形状（[Drawcode] 与签名隔着 [Device]）与反序形状都要命中
    const m = parseCsProject([file], dir);
    m.pinned.set("Devices.cs::dev_collector", { xy: [1400, 240], size: [240, 180] });
    m.pinned.set("Devices.cs::dev_other", { xy: [150, 150], size: [160, 80] });
    assert.ok(syncCsMethods(file, m, "Devices.cs"));
    const after = readOf(dir, "Devices.cs");

    // 只允许两行变化，且都是 Drawcode 行 —— Device 行、签名、方法体逐字节不动
    const before = DEVICES_CS.split("\n");
    const now = after.split("\n");
    assert.equal(now.length, before.length);
    const changed = now.filter((l, i) => l !== before[i]);
    assert.equal(changed.length, 2);
    for (const l of changed) assert.ok(l.includes("[Drawcode("), `只有 Drawcode 行允许变化: ${l}`);

    assert.ok(
      after.includes(
        '        [Drawcode(Alias = "采集计算机", Asset = "图片/设备-采集计算机.png", Note = "采集设备主机", Xy = "1400,240", Size = "240x180")]',
      ),
    );
    assert.ok(after.includes('        [Drawcode(Alias = "设备二", Xy = "150,150", Size = "160x80")]'));
    assert.ok(after.includes('        [Device(Model = "示例型号")]'));
    assert.ok(after.includes("public static Hardware dev_collector()"));
    // 空行隔断的注解：解析侧不认（readMeta 遇空行清缓冲），回写侧同样不碰
    assert.ok(after.includes('        [Drawcode(Alias = "分离注解", Xy = "10,20")]'));

    // 幂等：重新解析后 pinned 为空，第二趟必须报"没改"
    assert.equal(syncCsMethods(file, parseCsProject([file], dir), "Devices.cs"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: 方法体里的 return g_raw; 不会被当成字段声明写回", () => {
  // `return g_raw;` 在字段正则眼里是 `type=return, name=g_raw`。解析侧靠「必须有方向」
  // 天然挡住，回写侧只按名字匹配 —— 没有防护时会在方法体里插一条 [Drawcode]。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-ts-csret-"));
  try {
    const file = path.join(dir, "Ret.cs");
    const source = [
      "public static class M",
      "{",
      '    [Drawcode(Direction.In, Alias = "原始")]',
      "    public static short g_raw;",
      "",
      '    [Drawcode(Alias = "读原始")]',
      "    public static short ReadRaw()",
      "    {",
      "        return g_raw;",
      "    }",
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(file, source, "utf8");
    const m = parseCsProject([file], dir);
    assert.ok(m.signals.has("Ret.cs::g_raw"));
    assert.equal(syncCsSource(file, m, "Ret.cs"), false);
    assert.equal(fs.readFileSync(file, "utf8"), source);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen: no drags means byte-identical C# output (syncSource runs both passes)", () => {
  const dir = tempCsProject();
  try {
    injectOnce(dir, "Adc.cs", CS_GRAW, CS_GRAW_HAND);
    const m = parseCsDir(dir);
    const before = Object.fromEntries(CS_NAMES.map((n) => [n, readOf(dir, n)]));
    for (const n of CS_NAMES) {
      assert.equal(syncSource(path.join(dir, n), m, n), false, `${n} 不该被写`);
    }
    for (const n of CS_NAMES) assert.equal(readOf(dir, n), before[n]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
