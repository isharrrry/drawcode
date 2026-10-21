/**
 * CLI 的模块拆分、模糊简称，以及 `path` 决定的容器层级。
 *
 * 这三条是一条线上的设定：**一个模块一张图**，模块由同名文件确定，容器层级由源码里的
 * `@drawcode path="a/b"` 决定 —— 而不是「一个源文件一个容器」。对等 Python `test_cli.py`。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { main } from "../src/cli.ts";
import { parseProject } from "../src/cparse.ts";
import { toDrawio } from "../src/drawio.ts";
import { CASES_DIR, extractShape, mustRead } from "./helpers.ts";
import { EXAMPLES_C } from "./helpers.ts";

const ADCS = ["adc.h", "adc.c"];
const DSPS = ["dsp.h", "dsp.c"];

function fixture(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-cli-"));
  for (const f of [...ADCS, ...DSPS]) {
    fs.copyFileSync(path.join(EXAMPLES_C, f), path.join(tmp, f));
  }
  return tmp;
}

function outputs(tmp: string): string[] {
  return fs
    .readdirSync(tmp)
    .filter((f) => f.endsWith(".drawio"))
    .sort();
}

/** 裸文件名按模块目录展开；`--root` / `--out` 的值原样透传。*/
function runBuild(tmp: string, ...args: string[]): number {
  const argv = ["build"];
  const takesValue = new Set(["--root", "--out", "--layout-from", "--svg"]);
  let skipNext = false;
  for (const a of args) {
    if (skipNext) {
      argv.push(a);
      skipNext = false;
    } else if (takesValue.has(a)) {
      argv.push(a);
      skipNext = true;
    } else if (a.startsWith("--")) {
      argv.push(a);
    } else {
      argv.push(path.join(tmp, a));
    }
  }
  const code = main(argv);
  // build 永远走同步分支；把这条不变量写出来，避免将来给 build 加异步读取时静默变成 Promise。
  if (typeof code !== "number") throw new Error("build must be synchronous");
  return code;
}

test("cli: one module gives one named diagram", () => {
  const tmp = fixture();
  assert.equal(runBuild(tmp, "adc.h", "adc.c", "--root", tmp), 0);
  assert.deepStrictEqual(outputs(tmp), ["adc.drawio"]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("cli: two modules give two diagrams", () => {
  const tmp = fixture();
  assert.equal(runBuild(tmp, "adc.h", "adc.c", "dsp.h", "dsp.c", "--root", tmp), 0);
  assert.deepStrictEqual(outputs(tmp), ["adc.drawio", "dsp.drawio"]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("cli: each diagram holds only its own module", () => {
  const tmp = fixture();
  runBuild(tmp, "adc.h", "adc.c", "dsp.h", "dsp.c", "--root", tmp);
  const xml = fs.readFileSync(path.join(tmp, "dsp.drawio"), "utf8");
  assert.ok(xml.includes("dsp.h::g_coeff"));
  assert.ok(!xml.includes("adc.h::"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("cli: --out is refused for several modules", () => {
  // --out 只能指一个文件；多模块时静默只写第一个才是最坏的做法。
  const tmp = fixture();
  const code = runBuild(tmp, "adc.h", "adc.c", "dsp.h", "dsp.c", "--root", tmp, "--out", path.join(tmp, "both.drawio"));
  assert.equal(code, 2);
  assert.deepStrictEqual(outputs(tmp), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("cli: --merge puts everything in one diagram", () => {
  const tmp = fixture();
  const code = runBuild(tmp, "adc.h", "adc.c", "dsp.h", "dsp.c", "--root", tmp, "--merge", "--out", path.join(tmp, "all.drawio"));
  assert.equal(code, 0);
  assert.deepStrictEqual(outputs(tmp), ["all.drawio"]);
  const xml = fs.readFileSync(path.join(tmp, "all.drawio"), "utf8");
  assert.ok(xml.includes("adc.h::g_raw"));
  assert.ok(xml.includes("dsp.h::g_coeff"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("cli: header alone pulls in the sibling source", () => {
  // 只给 .h 也要拿到 .c 里扫出来的边 —— 否则图会缺一半
  const tmp = fixture();
  runBuild(tmp, "dsp.h", "--root", tmp);
  assert.deepStrictEqual(outputs(tmp), ["dsp.drawio"]);
  const model = parseProject([path.join(tmp, "dsp.h"), path.join(tmp, "dsp.c")], tmp);
  const shape = extractShape(fs.readFileSync(path.join(tmp, "dsp.drawio"), "utf8"));
  assert.equal(shape.edges.length, model.edges.length);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("cli: source alone gives the same diagram as header alone", () => {
  const tmp = fixture();
  runBuild(tmp, "dsp.h", "--root", tmp);
  const fromHeader = fs.readFileSync(path.join(tmp, "dsp.drawio"), "utf8");
  fs.rmSync(path.join(tmp, "dsp.drawio"));
  runBuild(tmp, "dsp.c", "--root", tmp);
  const fromSource = fs.readFileSync(path.join(tmp, "dsp.drawio"), "utf8");
  assert.equal(fromHeader, fromSource);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const PATH_HEADER = `/// @drawcode path="adc/采样前端" dir=in unit="LSB"
int16_t g_raw;

/// @drawcode path="adc/滤波" dir=in unit="coeff"
float g_coeff[32];

/// @drawcode dir=in unit="plain"
int16_t g_plain;
`;

function pathModel(): { tmp: string; xml: string; model: ReturnType<typeof parseProject> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-path-"));
  fs.writeFileSync(path.join(tmp, "x.h"), PATH_HEADER, "utf8");
  const model = parseProject([path.join(tmp, "x.h")], tmp);
  return { tmp, xml: toDrawio(model), model };
}

test("path: stored on the entity, group is its first segment", () => {
  const { tmp, model } = pathModel();
  assert.equal(model.signals.get("x.h::g_raw")?.path, "adc/采样前端");
  assert.equal(model.signals.get("x.h::g_raw")?.group, "adc");
  assert.equal(model.signals.get("x.h::g_coeff")?.path, "adc/滤波");
  assert.equal(model.signals.get("x.h::g_coeff")?.group, "adc");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("path: without it the module name is the container", () => {
  // 旧源码一个字不改也照常工作：没标 path 就用文件名。
  const { tmp, model } = pathModel();
  assert.equal(model.signals.get("x.h::g_plain")?.path, "x");
  assert.equal(model.signals.get("x.h::g_plain")?.group, "x");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("path: nested containers are emitted with a parent chain", () => {
  const { tmp, xml } = pathModel();
  const shape = extractShape(xml);
  const paths = shape.containers.map((c) => c.path);
  assert.ok(paths.includes("adc"), `got ${JSON.stringify(paths)}`);
  assert.ok(paths.includes("adc/采样前端"), `got ${JSON.stringify(paths)}`);
  assert.ok(paths.includes("adc/滤波"), `got ${JSON.stringify(paths)}`);
  // 子容器的 parent 必须一路指回父容器，而不是根
  const byPath = new Map(shape.nodes.map((n) => [n.symbolId, n.container]));
  assert.equal(byPath.get("x.h::g_raw"), "adc/采样前端");
  assert.equal(byPath.get("x.h::g_coeff"), "adc/滤波");
  // 没标 path 的落在自己的模块容器 `x` 里，不会被塞进 adc
  assert.equal(byPath.get("x.h::g_plain"), "x");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("dump-ir: canonical JSON matches the golden", () => {
  // 三版 CLI 的公开面必须一致：.NET 有 dump-ir，TS/Python 也必须有。
  // 产物口径与 tools/dump_ir.py 相同 —— 逐字节比对金标准，而不是只比字段。
  const tmp = fixture();
  try {
    const out = path.join(tmp, "ir.json");
    const files = [...ADCS, ...DSPS].map((f) => path.join(tmp, f));
    assert.equal(main(["dump-ir", ...files, "--root", tmp, "--out", out]), 0);
    assert.equal(
      fs.readFileSync(out, "utf8"),
      mustRead(path.join(CASES_DIR, "small-c", "expected.ir.json")),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
