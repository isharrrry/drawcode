/**
 * .NET sidecar 的跨平台定位、失败分类与「没装 .NET」诊断。
 *
 * 这些用例不依赖真的安装/卸载 .NET：
 *   - 候选路径与安装提示是纯函数，直接按 platform/env 断言；
 *   - 子进程失败用「不存在的可执行文件」或 `node` 冒充 dotnet 来构造，
 *     因而 Windows / Linux 都能跑，也不会因为本机装没装 .NET 而波动。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  classifyDotnetFailure,
  dotnetAttempts,
  dotnetCandidates,
  dotnetInstallHint,
  shouldTryNextDotnet,
  DOTNET_DOWNLOAD_URL,
} from "../src/artifact/dotnet.ts";
import { readArtifact } from "../src/artifact/read.ts";
import { readPeCli } from "../src/artifact/pe.ts";

function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-dotnet-"));
  return body(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const PE_BYTES = Uint8Array.from([0x4d, 0x5a, 0x00, 0x00]);

test("dotnetCandidates: Linux 优先 DOTNET_ROOT，并包含常见安装目录", () => {
  const candidates = dotnetCandidates({
    platform: "linux",
    env: { DOTNET_ROOT: "/opt/dotnet/", HOME: "/home/me" },
    isExecutable: () => true,
  });
  assert.equal(candidates[0], "/opt/dotnet/dotnet");
  assert.ok(candidates.includes("/usr/share/dotnet/dotnet"));
  assert.ok(candidates.includes("/usr/lib/dotnet/dotnet"));
  assert.ok(candidates.includes("/snap/bin/dotnet"));
  assert.ok(candidates.includes("/home/me/.dotnet/dotnet"));
});

test("dotnetCandidates: Windows 使用 win32 路径与 ProgramFiles", () => {
  const candidates = dotnetCandidates({
    platform: "win32",
    env: {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    },
    isExecutable: () => true,
  });
  assert.ok(candidates.includes("C:\\Program Files\\dotnet\\dotnet.exe"));
  assert.ok(candidates.includes("C:\\Program Files (x86)\\dotnet\\dotnet.exe"));
  assert.ok(candidates.includes("C:\\Users\\me\\AppData\\Local\\Microsoft\\dotnet\\dotnet.exe"));
});

test("dotnetCandidates: DOTNET_HOST_PATH 指向可执行文件本身，优先级最高", () => {
  const candidates = dotnetCandidates({
    platform: "linux",
    env: { DOTNET_HOST_PATH: "/custom/dotnet", DOTNET_ROOT: "/opt/dotnet" },
    isExecutable: () => true,
  });
  assert.equal(candidates[0], "/custom/dotnet");
  assert.ok(candidates.includes("/opt/dotnet/dotnet"));
});

test("dotnetCandidates: 过滤不存在/不可执行的路径，并去重", () => {
  const candidates = dotnetCandidates({
    platform: "linux",
    env: { DOTNET_ROOT: "/usr/share/dotnet", HOME: "/home/me" },
    isExecutable: (file) => file === "/usr/share/dotnet/dotnet",
  });
  assert.deepEqual(candidates, ["/usr/share/dotnet/dotnet"]);
});

test("dotnetAttempts: 显式路径 > 环境变量 > PATH + 候选", () => {
  assert.deepEqual(dotnetAttempts("/custom/dotnet", { env: {} }), ["/custom/dotnet"]);
  assert.deepEqual(dotnetAttempts(undefined, { env: { DRAWCODE_DOTNET: "/env/dotnet" } }), [
    "/env/dotnet",
  ]);
  const attempts = dotnetAttempts(undefined, {
    platform: "linux",
    env: {},
    isExecutable: () => false,
  });
  assert.deepEqual(attempts, ["dotnet"]);
});

test("classifyDotnetFailure: ENOENT 是 dotnet-missing，并按平台给安装命令", () => {
  const windows = classifyDotnetFailure({ code: "ENOENT", message: "spawn dotnet ENOENT" }, "win32");
  assert.equal(windows.code, "dotnet-missing");
  assert.match(windows.message, /winget install Microsoft\.DotNet\.Runtime\.10/);
  assert.ok(windows.message.includes(DOTNET_DOWNLOAD_URL));

  const linux = classifyDotnetFailure({ code: "ENOENT" }, "linux");
  assert.equal(linux.code, "dotnet-missing");
  assert.match(linux.message, /apt-get install -y dotnet-runtime-10\.0/);
  assert.match(linux.message, /dnf install -y dotnet-runtime-10\.0/);
  assert.match(linux.message, /learn\.microsoft\.com\/dotnet\/core\/install\/linux/);
});

test("classifyDotnetFailure: 宿主说找不到框架 -> dotnet-runtime-missing", () => {
  const failure = classifyDotnetFailure(
    {
      code: 150,
      stderr:
        "You must install or update .NET to run this application.\n" +
        "Framework: 'Microsoft.NETCore.App', version '10.0.0' (x64)\n",
    },
    "linux",
  );
  assert.equal(failure.code, "dotnet-runtime-missing");
  assert.match(failure.message, /\.NET 10\+/);
  assert.match(failure.detail, /Microsoft\.NETCore\.App/);
});

test("classifyDotnetFailure: 文案匹配（不依赖退出码）", () => {
  const failure = classifyDotnetFailure({
    code: 1,
    stderr: "The framework 'Microsoft.NETCore.App', version '10.0.0' was not found.",
  });
  assert.equal(failure.code, "dotnet-runtime-missing");
});

test("classifyDotnetFailure: 超时不是 .NET 缺失", () => {
  const failure = classifyDotnetFailure({ killed: true, signal: "SIGTERM" });
  assert.equal(failure.code, "tool-unavailable");
  assert.match(failure.message, /超时/);
});

test("classifyDotnetFailure: sidecar 自身失败保留退出码与输出", () => {
  const failure = classifyDotnetFailure({ code: 4, stderr: "解析失败: Read out of bounds" });
  assert.equal(failure.code, "tool-unavailable");
  assert.match(failure.message, /退出码 4/);
  assert.match(failure.message, /Read out of bounds/);
});

test("shouldTryNextDotnet: 命令缺失或缺运行时才换候选，超时/解析失败不换", () => {
  assert.equal(shouldTryNextDotnet({ code: "ENOENT" }), true);
  assert.equal(shouldTryNextDotnet({ code: 150, stderr: "" }), true);
  assert.equal(
    shouldTryNextDotnet({ code: 1, stderr: "You must install or update .NET to run this application." }),
    true,
  );
  assert.equal(shouldTryNextDotnet({ code: 4, stderr: "解析失败: Read out of bounds" }), false);
  assert.equal(shouldTryNextDotnet({ killed: true, signal: "SIGTERM" }), false);
});

test("dotnetInstallHint: 三个平台都有可执行命令", () => {
  assert.match(dotnetInstallHint("win32"), /winget/);
  assert.match(dotnetInstallHint("linux"), /apt-get/);
  assert.match(dotnetInstallHint("darwin"), /brew/);
});

test("readPeCli: sidecar 缺失 -> tool-unavailable（不尝试启动 dotnet）", async () => {
  const model = await readPeCli("x.dll", "x.dll", {
    toolPath: path.join(os.tmpdir(), "drawcode-missing-sidecar", "drawcode-metadata.dll"),
  });
  assert.equal(model.diagnostics.length, 1);
  assert.equal(model.diagnostics[0]?.code, "tool-unavailable");
  assert.match(model.diagnostics[0]?.message ?? "", /sidecar/);
});

test("readPeCli: sidecar 缺 deps/runtimeconfig -> 安装不完整（tool-unavailable）", async () => {
  await withTempDir(async (dir) => {
    const tool = path.join(dir, "drawcode-metadata.dll");
    fs.writeFileSync(tool, "");
    const artifact = path.join(dir, "sample.dll");
    fs.writeFileSync(artifact, PE_BYTES);

    const model = await readPeCli(artifact, "sample.dll", {
      toolPath: tool,
      dotnetPath: path.join(dir, "no-such-dotnet"),
      timeoutMs: 5_000,
    });
    assert.equal(model.diagnostics[0]?.code, "tool-unavailable");
    assert.match(model.diagnostics[0]?.message ?? "", /sidecar/);
  });
});

test("readPeCli: 找不到 dotnet -> dotnet-missing", async () => {
  await withTempDir(async (dir) => {
    const tool = path.join(dir, "drawcode-metadata.dll");
    fs.writeFileSync(tool, "");
    fs.writeFileSync(path.join(dir, "drawcode-metadata.deps.json"), "{}");
    fs.writeFileSync(path.join(dir, "drawcode-metadata.runtimeconfig.json"), "{}");
    const artifact = path.join(dir, "sample.dll");
    fs.writeFileSync(artifact, PE_BYTES);

    const model = await readPeCli(artifact, "sample.dll", {
      toolPath: tool,
      dotnetPath: path.join(dir, "no-such-dotnet"),
      timeoutMs: 5_000,
    });
    assert.equal(model.diagnostics[0]?.code, "dotnet-missing");
    assert.ok((model.diagnostics[0]?.message ?? "").includes(DOTNET_DOWNLOAD_URL));
  });
});

test("readPeCli: 有 dotnet 但没有运行时 -> dotnet-runtime-missing", async () => {
  await withTempDir(async (dir) => {
    // 用 node 冒充 dotnet：`node <fake-tool> <artifact>` 会执行这段脚本。
    // 这样不依赖本机真的装/不装 .NET，Windows 与 Linux 行为一致。
    const fakeTool = path.join(dir, "fake-sidecar.js");
    fs.writeFileSync(
      fakeTool,
      [
        'process.stderr.write("You must install or update .NET to run this application.\\n");',
        'process.stderr.write("Framework: \'Microsoft.NETCore.App\', version \'10.0.0\' (x64)\\n");',
        "process.exit(150);",
      ].join("\n"),
    );
    const artifact = path.join(dir, "sample.dll");
    fs.writeFileSync(artifact, PE_BYTES);

    const model = await readPeCli(artifact, "sample.dll", {
      toolPath: fakeTool,
      dotnetPath: process.execPath,
      timeoutMs: 10_000,
    });
    assert.equal(model.diagnostics[0]?.code, "dotnet-runtime-missing");
    assert.match(model.diagnostics[0]?.message ?? "", /Microsoft\.NETCore\.App/);
  });
});

test("readPeCli: dotnetPath 指向可执行程序时正常解析 stdout JSON", async () => {
  await withTempDir(async (dir) => {
    const fakeTool = path.join(dir, "fake-sidecar.js");
    const payload = {
      info: {
        path: "sample.dll",
        format: "pe-cli",
        arch: "x64",
        kind: "dll",
        hasMetadata: false,
        metadataVersion: 0,
      },
      modules: [],
      types: [],
      signals: [],
      funcs: [],
      edges: [],
      diagnostics: [],
    };
    fs.writeFileSync(fakeTool, `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`);
    const artifact = path.join(dir, "sample.dll");
    fs.writeFileSync(artifact, PE_BYTES);

    const model = await readPeCli(artifact, "sample.dll", {
      toolPath: fakeTool,
      dotnetPath: process.execPath,
      timeoutMs: 10_000,
    });
    assert.equal(model.info.path, "sample.dll");
    assert.equal(model.diagnostics.length, 0);
  });
});

test("readArtifact: dotnetPath 从入口透传到 PE 读取器", async () => {
  await withTempDir(async (dir) => {
    const tool = path.join(dir, "drawcode-metadata.dll");
    fs.writeFileSync(tool, "");
    fs.writeFileSync(path.join(dir, "drawcode-metadata.deps.json"), "{}");
    fs.writeFileSync(path.join(dir, "drawcode-metadata.runtimeconfig.json"), "{}");
    const artifact = path.join(dir, "sample.dll");
    fs.writeFileSync(artifact, PE_BYTES);

    const model = await readArtifact(artifact, {
      metadataToolPath: tool,
      dotnetPath: path.join(dir, "no-such-dotnet"),
    });
    assert.equal(model.diagnostics[0]?.code, "dotnet-missing");
  });
});
