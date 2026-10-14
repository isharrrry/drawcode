import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { adoptForeign, classify, direction, parseLabel } from "../src/adopt.ts";
import { main } from "../src/cli.ts";
import { parseProject } from "../src/cparse.ts";
import { readLayout, toDrawio } from "../src/drawio.ts";
import type { Model } from "../src/model.ts";
import { EXAMPLES_C } from "./helpers.ts";

const NAMES = ["adc.h", "adc.c", "dsp.h", "dsp.c"];

function model(root: string = EXAMPLES_C): Model {
  return parseProject(
    NAMES.map((n) => path.join(root, n)),
    root,
  );
}

function cell(cid: string, label: string, style: string, parent: string, x = 40, y = 200): string {
  return (
    `        <mxCell id="${cid}" value="${label}" style="${style}" vertex="1" parent="${parent}">\n` +
    `          <mxGeometry x="${x}" y="${y}" width="160" height="60" as="geometry" />\n` +
    "        </mxCell>\n"
  );
}

/** 画一张我们自己的图，再往里塞若干用户手画的元素。 */
function diagramWith(...cells: string[]): string {
  const xml = toDrawio(model());
  return xml.replace("</mxGraphModel>", cells.join("") + "      </mxGraphModel>");
}

// ---------------------------------------------------------------- classify

test("adopt: pentagon and ellipse are signals", () => {
  assert.equal(classify("shape=path;path=45,0 160,0;"), "signal");
  assert.equal(classify("shape=ellipse;"), "signal");
});

// draw.io 自己的椭圆 style 是**裸词** `ellipse;`，只有 drawcode 生成时才写
// `shape=ellipse`。只认后者的话，用户在工具栏上随手画的椭圆会被判成函数、写进
// .c —— 而且不报错。这条钉的就是那个裸词。
test("adopt: a bare ellipse word from the draw.io toolbar is a signal", () => {
  assert.equal(classify("ellipse;whiteSpace=wrap;html=1;"), "signal");
});

test("adopt: anything else is a func", () => {
  assert.equal(classify("rounded=1;whiteSpace=wrap;"), "func");
  assert.equal(classify(""), "func");
});

test("adopt: direction comes from the pentagon orientation", () => {
  assert.equal(direction("shape=path;direction=east;"), "in");
  assert.equal(direction("shape=path;direction=west;"), "out");
  assert.equal(direction("shape=path;"), "");
});

// --------------------------------------------------------------- parseLabel

test("adopt: a typed label yields ctype and name", () => {
  assert.deepEqual(parseLabel("int16_t g_alarm"), ["int16_t", "g_alarm", null]);
});

test("adopt: an untyped label leaves ctype empty", () => {
  assert.deepEqual(parseLabel("g_unknown"), ["", "g_unknown", null]);
});

test("adopt: a function signature yields its params", () => {
  assert.deepEqual(parseLabel("void dsp_reset(void)"), ["void", "dsp_reset", "void"]);
});

test("adopt: a function with parameters", () => {
  assert.deepEqual(parseLabel("int fir(int a, int b)"), ["int", "fir", "int a, int b"]);
});

// ---------------------------------------------------------- foreign detection

test("adopt: containers are not mistaken for user elements", () => {
  const lay = readLayout(toDrawio(model()), true);
  assert.deepEqual(lay.foreign, []);
});

test("adopt: a hand drawn shape is detected", () => {
  const xml = diagramWith(cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1"));
  const lay = readLayout(xml, true);
  const foreign = lay.foreign ?? [];
  assert.equal(foreign.length, 1);
  // label 是节点上原样的文字，类型解析留给 adopt
  assert.equal(foreign[0]?.label, "int16_t g_alarm");
  assert.equal(foreign[0]?.container, "adc");
});

test("adopt: foreign cells are off by default", () => {
  const lay = readLayout(diagramWith(cell("u1", "x", "rounded=1;", "grp1")));
  assert.equal(lay.foreign, undefined);
});

// ------------------------------------------------------------------- adopt

test("adopt: a signal goes to the header of its container", () => {
  const xml = diagramWith(cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1"));
  const m = model();
  const [added, problems] = adoptForeign(m, readLayout(xml, true), EXAMPLES_C);
  assert.deepEqual(added, ["adc.h::g_alarm"]);
  assert.equal(m.signals.get("adc.h::g_alarm")?.file, "adc.h");
  assert.equal(m.signals.get("adc.h::g_alarm")?.dir, "in");
  assert.deepEqual(problems, []);
});

test("adopt: a function goes to the sibling .c file, not the header", () => {
  const xml = diagramWith(cell("u3", "void dsp_reset(void)", "rounded=1;", "grp2"));
  const m = model();
  const [added] = adoptForeign(m, readLayout(xml, true), EXAMPLES_C);
  assert.deepEqual(added, ["dsp.c::dsp_reset"]);
  assert.equal(m.funcs.get("dsp.c::dsp_reset")?.file, "dsp.c");
});

test("adopt: an untyped signal is adopted but reported", () => {
  const xml = diagramWith(cell("u2", "g_unknown", "shape=ellipse;", "grp2"));
  const m = model();
  const [added, problems] = adoptForeign(m, readLayout(xml, true), EXAMPLES_C);
  assert.deepEqual(added, ["dsp.h::g_unknown"]);
  assert.equal(m.signals.get("dsp.h::g_unknown")?.ctype, "");
  assert.ok(problems.some((p) => p.includes("认不出类型")));
});

test("adopt: an element outside any container is reported, not guessed", () => {
  const xml = diagramWith(cell("u4", "floating", "rounded=1;", "1"));
  const m = model();
  const [added, problems] = adoptForeign(m, readLayout(xml, true), EXAMPLES_C);
  assert.deepEqual(added, []);
  assert.ok(problems.some((p) => p.includes("不在任何容器里")));
});

test("adopt: a nameless element gets an ordinal name and a note", () => {
  const xml = diagramWith(cell("u5", "", "shape=ellipse;", "grp1"));
  const m = model();
  const [added, problems] = adoptForeign(m, readLayout(xml, true), EXAMPLES_C);
  assert.deepEqual(added, ["adc.h::new_signal_1"]);
  assert.ok(problems.some((p) => p.includes("按序号命名")));
});

// ------------------------------------------------------------ sync round trip

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-adopt-"));
  for (const n of NAMES) fs.copyFileSync(path.join(EXAMPLES_C, n), path.join(dir, n));
  return dir;
}

function readOf(dir: string, name: string): string {
  return fs.readFileSync(path.join(dir, name), "utf8");
}

/** 整条链：图里多一个元素 -> sync --write -> 源码真的多出对应的声明/骨架。 */
function syncOnce(dir: string, ...cells: string[]): void {
  const p = path.join(dir, "flow.drawio");
  fs.writeFileSync(p, diagramWith(...cells), "utf8");
  main(["sync", p, ...NAMES.map((n) => path.join(dir, n)), "--root", dir, "--write"]);
}

test("adopt: a new signal is written into the header", () => {
  const dir = tempProject();
  syncOnce(dir, cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1"));
  const text = readOf(dir, "adc.h");
  assert.ok(text.includes("int16_t g_alarm;"));
  assert.ok(text.includes("dir=in"));
});

test("adopt: a new function skeleton is written into the .c file", () => {
  const dir = tempProject();
  syncOnce(dir, cell("u3", "void dsp_reset(void)", "rounded=1;", "grp2"));
  assert.ok(readOf(dir, "dsp.c").includes("void dsp_reset(void)"));
  assert.ok(!readOf(dir, "dsp.h").includes("void dsp_reset(void)"));
});

test("adopt: rerunning sync is idempotent", () => {
  const dir = tempProject();
  const c = cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1");
  syncOnce(dir, c);
  const first = readOf(dir, "adc.h");
  syncOnce(dir, c);
  assert.equal(readOf(dir, "adc.h"), first);
  assert.equal(readOf(dir, "adc.h").split("g_alarm;").length - 1, 1);
});

test("adopt: untouched files are not rewritten", () => {
  const dir = tempProject();
  const before = readOf(dir, "dsp.c");
  syncOnce(dir, cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1"));
  assert.equal(readOf(dir, "dsp.c"), before);
});

// 裸词 ellipse + 只有名字，是「用户在 draw.io 里画了个椭圆写个名字」最常见的形态。
// 它必须落进 .h：判成函数会写进 .c，而 .c 里出现一个没有类型的信号是错的。
test("adopt: an untyped bare-word ellipse lands in the header, not the .c", () => {
  const dir = tempProject();
  syncOnce(dir, cell("u2", "g_unknown", "ellipse;whiteSpace=wrap;html=1;", "grp1"));
  assert.ok(readOf(dir, "adc.h").includes("g_unknown;"));
  assert.ok(!readOf(dir, "adc.c").includes("g_unknown"));
});

// 无类型信号必须落一个**占位类型**：只写 `g_unknown;` 不是合法 C，而且解析器
// 读不回来 -> 下一次 sync 把它当成新元素再追加一遍。这条同时钉住这两件事。
test("adopt: an untyped signal is idempotent and gets a placeholder type", () => {
  const dir = tempProject();
  const c = cell("u2", "g_unknown", "ellipse;whiteSpace=wrap;html=1;", "grp1");
  syncOnce(dir, c);
  const first = readOf(dir, "adc.h");
  assert.ok(first.includes("int g_unknown;"), "占位类型必须落下去");
  assert.ok(first.includes("未能从图里认出类型"), "必须留下提醒");
  assert.equal(first.split("g_unknown;").length - 1, 1);

  syncOnce(dir, c);
  assert.equal(readOf(dir, "adc.h"), first, "第二次 sync 必须什么都不改");
  assert.equal(readOf(dir, "adc.h").split("g_unknown;").length - 1, 1, "不能重复追加");
});
