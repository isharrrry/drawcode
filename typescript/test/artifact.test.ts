/**
 * 产物读取入口的最小测试：magic bytes 分派与未知格式的诊断。
 *
 * 这里刻意不测 PE / ELF / ar 的具体字段——那些由各自的读取器测试覆盖
 * （`artifact-pe.test.ts` / `artifact-elf.test.ts`）。本文件只锁住「字节 -> 容器」这一层。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { detectFormat } from "../src/artifact/format.ts";
import { readArtifact } from "../src/artifact/read.ts";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "drawcode.ts");

/**
 * PE 测试同样要自己给出 sidecar 路径。
 *
 * 核心已不再猜仓库布局（那份假设属于壳的职责），所以测试就是第三个壳：
 * 它知道测试文件在 `typescript/test`，向上两级是仓库根。
 */
const METADATA_TOOL = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "tools",
  "drawcode-metadata",
  "bin",
  "Release",
  "net8.0",
  "drawcode-metadata.dll",
);

/** 跑 CLI 子进程：inspect 会等 sidecar，直接调 main 会把 Promise 泄漏给测试框架。 */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function bytes(...vals: number[]): Uint8Array {
  return Uint8Array.from(vals);
}

function withTempFile(
  name: string,
  content: Uint8Array,
  body: (file: string) => Promise<void>,
): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-artifact-"));
  const file = path.join(tmp, name);
  fs.writeFileSync(file, content);
  return body(file).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
}

test("format: ar magic is !<arch>\\n", () => {
  assert.equal(detectFormat(bytes(0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a)), "ar");
});

test("format: ELF magic is \\x7fELF", () => {
  assert.equal(detectFormat(bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00)), "elf");
});

test("format: PE magic is MZ", () => {
  assert.equal(detectFormat(bytes(0x4d, 0x5a, 0x90, 0x00)), "pe");
});

test("format: random bytes are unknown", () => {
  assert.equal(detectFormat(bytes(0x89, 0x50, 0x4e, 0x47)), "unknown");
});

test("format: empty and truncated input never throws", () => {
  assert.equal(detectFormat(bytes()), "unknown");
  assert.equal(detectFormat(bytes(0x4d)), "unknown"); // 只有 "M"，不够 MZ
  assert.equal(detectFormat(bytes(0x7f, 0x45)), "unknown"); // 只有 Elf 的一半
});

test("format: magic must start at offset 0", () => {
  assert.equal(
    detectFormat(bytes(0x00, 0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a)),
    "unknown",
  );
});

test("read: unknown format gives an empty model plus a diagnostic", async () => {
  await withTempFile(
    "picture.png",
    bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    async (file) => {
      const model = await readArtifact(file);
      assert.equal(model.info.format, "unknown");
      assert.equal(model.info.kind, "unknown");
      // 模型里存 basename，不存绝对路径：规范 JSON 要能跨机器比字节。
      assert.equal(model.info.path, "picture.png");
      assert.equal(model.modules.length, 0);
      assert.equal(model.types.length, 0);
      assert.equal(model.signals.length, 0);
      assert.equal(model.funcs.length, 0);
      assert.equal(model.edges.length, 0);
      assert.equal(model.diagnostics.length, 1);
      assert.equal(model.diagnostics[0]?.code, "unknown-format");
      assert.equal(model.diagnostics[0]?.severity, "error");
    },
  );
});

test("read: missing file rejects instead of faking a model", async () => {
  await assert.rejects(readArtifact(path.join(os.tmpdir(), "drawcode-artifact-does-not-exist.bin")));
});

/**
 * 真实产物验收：路径由 `DRAWCODE_SAMPLE_DLL` 指定，未设置就跳过。
 *
 * 为什么不把样本 dll 入库：它有几个 MB，且是「样本工程」工程随源码变化重新生成的产物，
 * 入库后必然与源码漂移。这里只锁住**关键不变量**（信号数、每信号一读一写、零悬空），
 * 具体每条边的语义由 `样本工程/check-graph.mjs` 用源码 IR 对照。
 */
test("pe: 真实样本的读写边与源码解析结果一致", async (t) => {
  const sample = process.env["DRAWCODE_SAMPLE_DLL"] ?? "";
  if (sample.length === 0 || !fs.existsSync(sample)) {
    t.skip("未设置 DRAWCODE_SAMPLE_DLL");
    return;
  }

  const model = await readArtifact(sample, { metadataToolPath: METADATA_TOOL });

  assert.equal(model.info.format, "pe-cli");
  assert.equal(model.info.hasMetadata, true);
  assert.equal(model.signals.length, 31);
  assert.equal(model.edges.filter((e) => e.kind === "read").length, 31);
  assert.equal(model.edges.filter((e) => e.kind === "write").length, 31);

  // 组件方法的 path 是 `命名空间/类型`；测试与模拟代码不在验收范围内。
  const components = model.funcs.filter((f) => f.path.startsWith("sample-app/"));
  assert.equal(components.length, 22);
  for (const component of components) {
    assert.deepEqual(component.calls, [], `${component.id} 不应产生调用边`);
  }

  // 每个信号恰好被写一次、读一次 —— 端口数的机器证据。
  for (const signal of model.signals) {
    assert.equal(model.edges.filter((e) => e.kind === "write" && e.dst === signal.id).length, 1, signal.id);
    assert.equal(model.edges.filter((e) => e.kind === "read" && e.dst === signal.id).length, 1, signal.id);
  }

  // 零悬空：每条边的两端都能在模型里找到。
  const known = new Set([...model.signals.map((s) => s.id), ...model.funcs.map((f) => f.id)]);
  for (const edge of model.edges) {
    assert.ok(known.has(edge.src), `悬空 src: ${edge.src}`);
    assert.ok(known.has(edge.dst), `悬空 dst: ${edge.dst}`);
  }
});

/**
 * 稳定性验收：同一文件连跑两次 sidecar，JSON 必须逐字节一致。
 *
 * 为什么单独锁这一条：插件会缓存模型、测试会拿 JSON 做快照、将来 CLI `inspect`
 * 要让人把两次输出直接 diff。任何一处把字典遍历顺序或临时目录塞进模型，
 * 都会让「同一产物」在不同时刻看起来不同——而这种漂移在功能测试里看不出来。
 */
test("pe: 同一 DLL 连续解析两次得到完全相同的 JSON", async (t) => {
  const sample = process.env["DRAWCODE_SAMPLE_DLL"] ?? "";
  if (sample.length === 0 || !fs.existsSync(sample)) {
    t.skip("未设置 DRAWCODE_SAMPLE_DLL");
    return;
  }

  const first = await readArtifact(sample, { metadataToolPath: METADATA_TOOL });
  const second = await readArtifact(sample, { metadataToolPath: METADATA_TOOL });

  // 模型里只允许 basename：绝对路径会让跨机器比对永远失败。
  assert.equal(first.info.path, path.basename(sample));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("inspect: 无元数据产物退出码为 0，JSON 写 stdout", async () => {
  await withTempFile(
    "picture.png",
    bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    async (file) => {
      const { status, stdout, stderr } = runCli(["inspect", file]);
      assert.equal(status, 0, stderr);
      // stdout 必须是纯 JSON：混进提示文字会弄脏 `| jq`。
      const model = JSON.parse(stdout) as { info: { format: string }; diagnostics: unknown[] };
      assert.equal(model.info.format, "unknown");
      assert.equal(model.diagnostics.length, 1);
    },
  );
});

test("inspect: 参数错退出码为 2", () => {
  assert.equal(runCli(["inspect"]).status, 2);
});

test("inspect: 两次 --out 的输出字节一致", async (t) => {
  const sample = process.env["DRAWCODE_SAMPLE_DLL"] ?? "";
  if (sample.length === 0 || !fs.existsSync(sample)) {
    t.skip("未设置 DRAWCODE_SAMPLE_DLL");
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-inspect-"));
  try {
    const a = path.join(tmp, "a.json");
    const b = path.join(tmp, "b.json");
    assert.equal(runCli(["inspect", sample, "--out", a]).status, 0);
    assert.equal(runCli(["inspect", sample, "--out", b]).status, 0);
    assert.equal(fs.readFileSync(a, "utf8"), fs.readFileSync(b, "utf8"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
