import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { parseProject } from "../src/cparse.ts";
import { parseCsProject } from "../src/csparse.ts";
import { parseAny } from "../src/parse.ts";
import { compareCodePoints, sortedCopy } from "../src/order.ts";
import { EXAMPLES_C, examplesC, examplesCs } from "./helpers.ts";

const C_FILES = examplesC();
const CS_FILES = examplesCs();

test("C: signal set, directions and types", () => {
  const m = parseProject(C_FILES);
  assert.deepStrictEqual(sortedCopy(m.signals.keys()), [
    "adc.h::g_filtered",
    "adc.h::g_raw",
    "dsp.h::g_coeff",
  ]);
  assert.equal(m.signals.get("adc.h::g_raw")?.dir, "in");
  assert.equal(m.signals.get("adc.h::g_filtered")?.dir, "out");
  assert.equal(m.signals.get("dsp.h::g_coeff")?.dir, "in");
  assert.equal(m.signals.get("adc.h::g_raw")?.ctype, "int16_t");
  assert.equal(m.signals.get("dsp.h::g_coeff")?.ctype, "float[32]");
});

test("C: signal annotations land on the signal", () => {
  const s = parseProject(C_FILES).signals.get("adc.h::g_raw");
  assert.equal(s?.unit, "LSB");
  assert.equal(s?.alias, "原始采样值");
  assert.equal(s?.note, "上电后需校准");
  assert.equal(s?.file, "adc.h");
  assert.equal(s?.line, 7);
  assert.equal(s?.group, "adc");
});

test("C: func signature, annotation, xy/size and device", () => {
  const m = parseProject(C_FILES);
  const f = m.funcs.get("adc.h::adc_read");
  assert.equal(f?.ret, "int16_t");
  assert.equal(f?.alias, "ADC 采样");
  assert.equal(f?.tooltip, "上电后需先校准");
  assert.deepStrictEqual([f?.x, f?.y, f?.w, f?.h], [420, 160, 180, 72]);
  assert.equal(f?.line, 14);
  assert.equal(f?.group, "adc");
  const d = m.devices.get("adc.h::adc_read");
  assert.equal(d?.vendor, "TI");
  assert.equal(d?.model, "ADS1115");
  assert.equal(d?.spec, "16bit/860SPS");
  assert.equal(d?.size, "2.0x3.0mm");
  assert.equal(d?.asset, "assets/ads1115.svg");
});

test("C: params are ports, not nodes", () => {
  const f = parseProject(C_FILES).funcs.get("dsp.h::dsp_set_gain");
  assert.deepStrictEqual(f?.params.map((p) => p.name), ["gain"]);
  assert.equal(f?.params[0]?.ctype, "uint8_t");
  assert.equal(f?.params[0]?.dir, "in");
});

test("C: def-use comes from the body, never from annotations", () => {
  const m = parseProject(C_FILES);
  const read = m.funcs.get("adc.h::adc_read");
  assert.deepStrictEqual(read?.reads, ["adc.h::g_raw"]);
  assert.deepStrictEqual(read?.writes, ["adc.h::g_filtered"]);
  assert.deepStrictEqual(read?.calls, ["dsp.h::fir_apply"]);

  const fir = m.funcs.get("dsp.h::fir_apply");
  assert.deepStrictEqual(fir?.reads, ["adc.h::g_raw", "dsp.h::g_coeff"]);
  assert.deepStrictEqual(fir?.writes, ["adc.h::g_filtered"]);

  const gain = m.funcs.get("dsp.h::dsp_set_gain");
  assert.deepStrictEqual(gain?.writes, ["dsp.h::g_coeff"]);
  assert.deepStrictEqual(gain?.reads, []);
});

test("C: locals stay out of the graph", () => {
  const m = parseProject(C_FILES);
  const names = new Set<string>();
  for (const f of m.funcs.values()) {
    for (const n of f.reads) names.add(n);
    for (const n of f.writes) names.add(n);
  }
  assert.ok(!names.has("adc.c::v"));
  assert.ok(!names.has("dsp.c::i"));
});

test("C: an annotation without dir still keeps its declaration", () => {
  // 进 IR 的判据是「有注解」，不是「有 dir」。早先把两件事混成一件
  // （`dirKey !== undefined`），于是 `/// @drawcode path="p"` 这种没有 dir 的注解
  // 会让**整条声明消失**，而且不报任何错 —— 产物悄悄少节点，最难查的一类。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-parse-"));
  try {
    const src = [
      '/// @drawcode path="p"',
      "int16_t g_nodir;",
      "",
      '/// @drawcode dir=""',
      "int16_t g_emptydir;",
      "",
      "void f(void)",
      "{",
      "    int local_i;",
      "    local_i = 0;",
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "z.h"), src);
    const m = parseProject([path.join(dir, "z.h")], dir);

    assert.ok(m.signals.has("z.h::g_nodir"), "没有 dir 的声明被丢掉了");
    assert.strictEqual(m.signals.get("z.h::g_nodir")?.dir, "");
    assert.strictEqual(m.signals.get("z.h::g_nodir")?.path, "p");
    assert.ok(m.signals.has("z.h::g_emptydir"), "空 dir 的声明被丢掉了");
    assert.ok(!m.signals.has("z.h::local_i"), "局部变量不该进 IR");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C: edges", () => {
  const m = parseProject(C_FILES);
  const got = m.edges.map((e) => `${e.src}|${e.dst}|${e.rw}`).sort();
  for (const want of [
    "adc.h::g_raw|adc.h::adc_read|read",
    "adc.h::adc_read|adc.h::g_filtered|write",
    "dsp.h::g_coeff|dsp.h::fir_apply|read",
    "dsp.h::fir_apply|adc.h::g_filtered|write",
  ]) {
    assert.ok(got.includes(want), `missing edge ${want}`);
  }
  assert.equal(got.length, 6);
});

test("C#: signals, directions and annotations", () => {
  const m = parseCsProject(CS_FILES);
  assert.deepStrictEqual(sortedCopy(m.signals.keys()), [
    "Adc.cs::g_filtered",
    "Adc.cs::g_raw",
    "Dsp.cs::g_coeff",
  ]);
  assert.equal(m.signals.get("Adc.cs::g_raw")?.dir, "in");
  assert.equal(m.signals.get("Adc.cs::g_filtered")?.dir, "out");
  const s = m.signals.get("Adc.cs::g_raw");
  assert.equal(s?.alias, "原始采样值");
  assert.equal(s?.unit, "LSB");
  assert.equal(s?.note, "上电后需校准");
  assert.equal(s?.file, "Adc.cs");
});

test("C#: funcs, device and params", () => {
  const m = parseCsProject(CS_FILES);
  const f = m.funcs.get("Adc.cs::AdcRead");
  assert.equal(f?.ret, "short");
  assert.equal(f?.alias, "ADC 采样");
  assert.equal(f?.tooltip, "上电后需先校准");
  assert.equal(m.devices.get("Adc.cs::AdcRead")?.model, "ADS1115");
  assert.deepStrictEqual(m.funcs.get("Dsp.cs::SetGain")?.params.map((p) => p.name), ["gain"]);
  assert.equal(m.funcs.get("Dsp.cs::SetGain")?.params[0]?.ctype, "byte");
});

test("C#: def-use and array-element write", () => {
  const m = parseCsProject(CS_FILES);
  const read = m.funcs.get("Adc.cs::AdcRead");
  assert.deepStrictEqual(read?.reads, ["Adc.cs::g_raw"]);
  assert.deepStrictEqual(read?.writes, ["Adc.cs::g_filtered"]);
  assert.deepStrictEqual(read?.calls, ["Dsp.cs::FirApply"]);
  const gain = m.funcs.get("Dsp.cs::SetGain");
  assert.deepStrictEqual(gain?.writes, ["Dsp.cs::g_coeff"]);
  assert.deepStrictEqual(gain?.reads, []);
  assert.equal(m.edges.length, 6);
});

test("parseAny dispatches by extension and merges", () => {
  const onlyC = parseAny(C_FILES);
  assert.equal(onlyC.signals.size, 3);
  assert.equal(onlyC.edges.length, 6);

  // 两门语言各自的 root 不同，这里显式给根目录，让相对路径各按各的算。
  const mixed = parseAny([...C_FILES, ...CS_FILES], EXAMPLES_C);
  assert.equal(mixed.signals.size, 6);
  assert.equal(mixed.funcs.size, 6);
  assert.equal(mixed.edges.length, 12);
});

test("parseAny refuses unknown extensions loudly", () => {
  assert.throws(() => parseAny(["nope.rs"]), /不支持的文件类型/);
});

test("compareCodePoints sorts by code point, not UTF-16 code unit", () => {
  // U+FFFD (65533) 与 U+10000 (65536)：码点上前者小，但 UTF-16 码元上前者
  // (0xFFFD) 大于后者的高位代理项 (0xD800)。用默认 sort 会得到相反顺序。
  const bmp = "\uFFFD";
  const astral = "\u{10000}";
  assert.ok(compareCodePoints(bmp, astral) < 0, "U+FFFD must sort before U+10000 by code point");
  assert.deepStrictEqual(sortedCopy([bmp, astral]), [bmp, astral]);
  // 反证：JS 默认比较给出相反结果
  assert.ok([bmp, astral].sort()[0] === astral, "default sort really does disagree");
});
