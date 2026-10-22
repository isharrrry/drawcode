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

test("C: signal xy/size/style reach the signal", () => {
  // 这三个键此前只有函数分支读，信号分支静默忽略 —— 与 C# 前端行为不一致。
  // 用临时目录而不是往 examples/ 里加注解：后者是金标准的输入，动它会牵动别的案例。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-parse-"));
  try {
    fs.writeFileSync(
      path.join(dir, "geo.h"),
      [
        '/// @drawcode dir=in xy="40,120" size="120x80" style="fillColor=#dae8fc"',
        "int16_t g_geo;",
        "",
      ].join("\n"),
    );
    const s = parseProject([path.join(dir, "geo.h")], dir).signals.get("geo.h::g_geo");
    assert.equal(s?.x, 40);
    assert.equal(s?.y, 120);
    assert.equal(s?.w, 120);
    assert.equal(s?.h, 80);
    assert.equal(s?.style, "fillColor=#dae8fc");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C: func style reaches the func", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-parse-"));
  try {
    fs.writeFileSync(
      path.join(dir, "geo.h"),
      [
        '/// @drawcode alias="带样式函数" style="rounded=0;fillColor=#d5e8d4"',
        "void geo_fn(void);",
        "",
      ].join("\n"),
    );
    const f = parseProject([path.join(dir, "geo.h")], dir).funcs.get("geo.h::geo_fn");
    // 原样透传：不解析、不加工（与 csparse.ts 对 style 的处理一致）。
    assert.equal(f?.style, "rounded=0;fillColor=#d5e8d4");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C: no xy/size/style keeps the model defaults", () => {
  // 金标准的前提：不含这三个键的输入，解析结果必须与改动前逐字段相同 ——
  // 160x60 / 180x72 / 空串都来自 makeSignal/makeFunc 的默认值，改动只是不去动它们。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-parse-"));
  try {
    fs.writeFileSync(
      path.join(dir, "plain.h"),
      [
        '/// @drawcode dir=in unit="V"',
        "int16_t g_plain;",
        "",
        '/// @drawcode alias="无几何函数"',
        "void plain_fn(void);",
        "",
      ].join("\n"),
    );
    const m = parseProject([path.join(dir, "plain.h")], dir);
    const s = m.signals.get("plain.h::g_plain");
    assert.deepStrictEqual([s?.x, s?.y, s?.w, s?.h, s?.style], [0, 0, 160, 60, ""]);
    const f = m.funcs.get("plain.h::plain_fn");
    assert.deepStrictEqual([f?.x, f?.y, f?.w, f?.h, f?.style], [0, 0, 180, 72, ""]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C: size with a wrong separator is a silent NaN, same as C#", () => {
  // `size="180,72"` 用的是逗号（xy 的分隔符），切不出第二段：实测 w=NaN、h=undefined。
  // 刻意不报错、不兜底 —— C# 前端对同一份输入给出同样的结果，两侧必须一致（见下）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-parse-"));
  try {
    fs.writeFileSync(
      path.join(dir, "bad.h"),
      ['/// @drawcode dir=in size="180,72"', "int16_t g_bad;", ""].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "Bad.cs"),
      ['[Drawcode(Direction.In, Size = "180,72")]', "public static short g_bad;", ""].join("\n"),
    );
    const c = parseProject([path.join(dir, "bad.h")], dir).signals.get("bad.h::g_bad");
    const cs = parseCsProject([path.join(dir, "Bad.cs")], dir).signals.get("Bad.cs::g_bad");
    // 用 throw 而不是 assert.ok 收窄类型：没装 @types/node 时 assert 没有类型、收窄失效。
    if (c === undefined || cs === undefined) throw new Error("两侧的信号都应进 IR");
    assert.ok(Number.isNaN(c.w), `w 实测 ${String(c.w)}，应为 NaN`);
    assert.deepStrictEqual(c.h, undefined, `h 实测 ${String(c.h)}，应为 undefined`);
    assert.deepStrictEqual(
      [c.x, c.y, c.w, c.h],
      [cs.x, cs.y, cs.w, cs.h],
      "C 与 C# 的几何必须逐字段一致",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C: single-part xy sets x only and leaves y undefined, same as C#", () => {
  // `xy="40"` 只有一段：实测 x=40、y=undefined。与 C# 前端同一静默行为。
  // 未写的 w/h 不受影响，仍是默认 160x60 —— 只有写坏的键才产出非默认值。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-parse-"));
  try {
    fs.writeFileSync(
      path.join(dir, "one.h"),
      ['/// @drawcode dir=in xy="40"', "int16_t g_one;", ""].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "One.cs"),
      ['[Drawcode(Direction.In, Xy = "40")]', "public static short g_one;", ""].join("\n"),
    );
    const c = parseProject([path.join(dir, "one.h")], dir).signals.get("one.h::g_one");
    const cs = parseCsProject([path.join(dir, "One.cs")], dir).signals.get("One.cs::g_one");
    // 同上：throw 收窄，不依赖 assert 的类型声明。
    if (c === undefined || cs === undefined) throw new Error("两侧的信号都应进 IR");
    assert.equal(c.x, 40);
    assert.deepStrictEqual(c.y, undefined, `y 实测 ${String(c.y)}，应为 undefined`);
    assert.deepStrictEqual([c.w, c.h], [160, 60]);
    assert.deepStrictEqual(
      [c.x, c.y, c.w, c.h],
      [cs.x, cs.y, cs.w, cs.h],
      "C 与 C# 的几何必须逐字段一致",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C#: a multi-line [Drawcode] attribute still binds to the following declaration", () => {
  // 参数一多，特性自然会跨行。旧实现按行匹配 ATTR_RE：第一行进了 buf，
  // 续行被当成声明行丢掉，真正的字段声明失去 dir → 信号从 IR 里静默消失。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-parse-"));
  try {
    fs.writeFileSync(
      path.join(dir, "Multi.cs"),
      [
        "namespace N {",
        "  public static class M {",
        "    [Drawcode(Direction.In, Unit = \"LSB\",",
        "        Alias = \"原始采样值\",",
        "        Note = \"说明里带 [0] 也要解析\")]",
        "    public static short g_multi;",
        "",
        "    [Drawcode(Alias = \"采样\",",
        "        Path = \"m/采样\")]",
        "    [Device(Vendor = \"TI\",",
        "        Model = \"ADS1115\")]",
        "    public static short Read()",
        "    {",
        "      return g_multi;",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const m = parseCsProject([path.join(dir, "Multi.cs")], dir);
    const signal = m.signals.get("Multi.cs::g_multi");
    if (signal === undefined) throw new Error("多行特性后面的字段必须仍是信号");
    assert.equal(signal.dir, "in");
    assert.equal(signal.unit, "LSB");
    assert.equal(signal.alias, "原始采样值");
    assert.equal(signal.note, "说明里带 [0] 也要解析");
    const func = m.funcs.get("Multi.cs::Read");
    if (func === undefined) throw new Error("多行特性后面的方法必须仍是函数");
    assert.equal(func.alias, "采样");
    assert.equal(func.path, "m/采样");
    assert.equal(m.devices.get("Multi.cs::Read")?.model, "ADS1115");
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
    "Adc.cs::g_buffer",
    "Adc.cs::g_calibration",
    "Adc.cs::g_filtered",
    "Adc.cs::g_raw",
    "Adc.cs::g_sample_count",
    "Adc.cs::g_state",
    "Dsp.cs::g_coeff",
    "Dsp.cs::g_config",
    "Dsp.cs::g_frames",
    "Dsp.cs::g_gain",
    "Dsp.cs::g_saturated",
    "Dsp.cs::g_window",
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
  assert.equal(m.funcs.get("Dsp.cs::SetGain")?.params[0]?.ctype, "double");
});

test("C#: def-use and array-element write", () => {
  const m = parseCsProject(CS_FILES);
  const read = m.funcs.get("Adc.cs::AdcRead");
  assert.deepStrictEqual(read?.reads, [
    "Adc.cs::g_buffer",
    "Adc.cs::g_calibration",
    "Adc.cs::g_raw",
    "Adc.cs::g_sample_count",
  ]);
  assert.deepStrictEqual(read?.writes, ["Adc.cs::g_filtered", "Adc.cs::g_state"]);
  assert.deepStrictEqual(read?.calls, ["Dsp.cs::FirApply"]);
  const gain = m.funcs.get("Dsp.cs::SetGain");
  assert.deepStrictEqual(gain?.writes, ["Dsp.cs::g_gain"]);
  assert.deepStrictEqual(gain?.reads, []);
  assert.equal(m.edges.length, 25);
});

test("C#: Unicode names parse; record declarations stay outside the graph", () => {
  // 回归：类型**与名字**都必须是 Unicode。
  //   · `数据包 a1_数据包;` 必须成为信号；
  //   · 中文方法 `生成` 必须成为函数（名字位置不再只认 ASCII）；
  //   · 泛型方法 `泛型生成<T>` 名字后跟 `<`，不得成为函数；
  //   · `record` 声明与记录体里的方法不是组件，必须整段跳过。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-parse-"));
  try {
    fs.writeFileSync(
      path.join(dir, "中文类型.cs"),
      [
        "using Drawcode;",
        "namespace 示例;",
        "public static class 设备",
        "{",
        '    [Drawcode(Direction.Out, Unit = "数据与配置")]',
        "    public static 数据包 a1_数据包;",
        "    public static 数据包 生成()",
        "    {",
        "        return default!;",
        "    }",
        "    public static T 泛型生成<T>(T 关系) { return 关系; }",
        "    public static coder输出 coder(coder输入 input)",
        "    {",
        "        测试桩.处理(input);",
        "        a1_数据包 = 生成();",
        "        return default!;",
        "    }",
        "}",
        "public sealed record 采样帧(帧头 头, int 数量)",
        "{",
        "    public const int 最大数量 = 100;",
        "    public 帧头 下一帧() { return default!; }",
        "}",
      ].join("\n"),
    );
    const m = parseCsProject([path.join(dir, "中文类型.cs")], dir);
    const sig = m.signals.get("中文类型.cs::a1_数据包");
    assert.equal(sig?.ctype, "数据包");
    assert.equal(sig?.dir, "out");
    const f = m.funcs.get("中文类型.cs::coder");
    assert.equal(f?.ret, "coder输出");
    assert.deepStrictEqual(
      f?.params.map((p) => [p.ctype, p.name]),
      [["coder输入", "input"]],
    );
    assert.equal(m.funcs.has("中文类型.cs::生成"), true, "中文方法名应成为节点");
    assert.equal(m.funcs.has("中文类型.cs::泛型生成"), false, "泛型方法不得成为节点");
    assert.equal(m.funcs.has("中文类型.cs::采样帧"), false, "record 声明不得成为节点");
    assert.equal(m.funcs.has("中文类型.cs::下一帧"), false, "记录体里的方法不得成为节点");
    assert.deepStrictEqual(f?.writes, ["中文类型.cs::a1_数据包"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C#: Path attribute sets the container", () => {
  // `Path` 是共享特性：Python 一直支持，TS 早先漏了这条白名单，同一份源码
  // 只有 Python 有嵌套容器，另外两版静默回退到文件 stem。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-path-"));
  try {
    fs.writeFileSync(
      path.join(dir, "x.cs"),
      [
        "public static class 设备",
        "{",
        '    [Drawcode(Direction.Out, Path = "adc/采样前端")]',
        "    public static short g_raw;",
        '    [Drawcode(Path = "adc/滤波")]',
        "    public static short Filter()",
        "    {",
        "        return 0;",
        "    }",
        "}",
      ].join("\n"),
    );
    const m = parseCsProject([path.join(dir, "x.cs")], dir);
    assert.equal(m.signals.get("x.cs::g_raw")?.path, "adc/采样前端");
    assert.equal(m.signals.get("x.cs::g_raw")?.group, "adc");
    assert.equal(m.funcs.get("x.cs::Filter")?.path, "adc/滤波");
    assert.equal(m.funcs.get("x.cs::Filter")?.group, "adc");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseAny: mixed C + C# keeps C# callouts", () => {
  // 回归：callouts 是数组而非 Map，混合语言合并时早先漏了 push，
  // C# 前端声明的说明框只有单语言输入才出现。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-mixed-"));
  try {
    fs.writeFileSync(
      path.join(dir, "a.h"),
      ['/// @drawcode dir=in unit="V"', "int16_t g_in;", ""].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "b.cs"),
      [
        "public static class B",
        "{",
        '    [Drawcode(Direction.Out, Unit = "LSB")]',
        '    [Callout("说明框", Xy = "40,40", Size = "260x60", Style = "box")]',
        "    public static short g_out;",
        "}",
      ].join("\n"),
    );
    const m = parseAny([path.join(dir, "a.h"), path.join(dir, "b.cs")], dir);
    assert.equal(m.signals.size, 2);
    assert.equal(m.callouts.length, 1);
    const c = m.callouts[0];
    assert.equal(c?.owner, "b.cs::g_out");
    assert.equal(c?.text, "说明框");
    assert.equal(c?.shape, "box");
    assert.equal(c?.x, 40);
    assert.equal(c?.w, 260);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseAny dispatches by extension and merges", () => {
  const onlyC = parseAny(C_FILES);
  assert.equal(onlyC.signals.size, 3);
  assert.equal(onlyC.edges.length, 6);

  // 两门语言各自的 root 不同，这里显式给根目录，让相对路径各按各的算。
  const mixed = parseAny([...C_FILES, ...CS_FILES], EXAMPLES_C);
  assert.equal(mixed.signals.size, 15);
  assert.equal(mixed.funcs.size, 12);
  assert.equal(mixed.edges.length, 31);
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
