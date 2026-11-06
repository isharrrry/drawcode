#!/usr/bin/env node
/**
 * 发布 drawcode-metadata sidecar（PE/CLI 解析工具）。
 *
 * 为什么需要这个脚本，而不是让每个人记 `dotnet publish` 的参数：
 * 发布形态有两条互斥的路线，选错会得到「文件在、但别的机器跑不起来」这种最难查的故障。
 *
 *   1) 框架依赖（默认）：产物只有几百 KB，但目标机必须有 .NET 10+ 运行时。
 *      csproj 显式设置了 RollForward=LatestMajor，因此装了 10.x 或更高主版本都能运行。
 *   2) 自包含（--self-contained）：把运行时一起打进去，单平台几十 MB，目标机无需装 .NET；
 *      必须指定 RID（运行时标识符），因为不同平台的运行时不通用。
 *
 * 发布策略（design §5.0）：开发机、CI 与 VSIX 都用框架依赖——单包跨平台，代价是
 * 目标机需要 .NET 10+ 运行时。**VSIX 固定不携带、不裁剪运行时**；--self-contained
 * 仅供离线或特殊部署实验，不是插件发布路径。
 * 扩展与 CLI 调用 sidecar 时按「显式路径 → DRAWCODE_DOTNET → PATH → 常见安装目录」
 * 查找 `dotnet`，缺少运行时时给出安装指引（见 typescript/src/artifact/dotnet.ts）。
 *
 * 用法：
 *   node tools/publish-metadata-tool.mjs
 *   node tools/publish-metadata-tool.mjs --self-contained --runtime win-x64 --out dist/metadata/win-x64
 *   node tools/publish-metadata-tool.mjs --configuration Debug
 *
 * 退出码：0 成功；1 dotnet 调用失败；2 参数错误。
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectDir = path.join(repoRoot, "tools", "drawcode-metadata");

/** 解析 `--key value` 与 `--flag`。刻意不引第三方参数库：脚本要在最小环境里能跑。 */
function parseArgs(argv) {
  const options = {
    selfContained: false,
    runtime: "",
    output: "",
    configuration: "Release",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--self-contained") {
      options.selfContained = true;
      continue;
    }
    if (arg === "--runtime" || arg === "--out" || arg === "--configuration") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`参数 ${arg} 需要一个值`);
      }
      i++;
      if (arg === "--runtime") options.runtime = value;
      else if (arg === "--out") options.output = value;
      else options.configuration = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    fail(`未知参数：${arg}`);
  }

  // 自包含发布必须带 RID；反之，带 RID 的框架依赖发布也是合法的（会多一个平台目录），
  // 但我们不鼓励，因为框架依赖本来就能跨平台，指定 RID 只会让路径更难猜。
  if (options.selfContained && options.runtime.length === 0) {
    fail("--self-contained 必须同时指定 --runtime（例如 win-x64、linux-x64）");
  }

  return options;
}

function fail(message) {
  process.stderr.write(`publish-metadata-tool: ${message}\n`);
  printUsage();
  process.exit(2);
}

function printUsage() {
  process.stderr.write(
    [
      "用法: node tools/publish-metadata-tool.mjs [选项]",
      "",
      "  --self-contained        连同 .NET 运行时一起发布（必须配 --runtime）",
      "  --runtime <rid>         目标平台，如 win-x64 / linux-x64 / osx-arm64",
      "  --out <dir>             输出目录（默认 bin/<Configuration>/net10.0）",
      "  --configuration <name>  Release（默认）或 Debug",
      "",
    ].join("\n"),
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const args = ["publish", projectDir, "-c", options.configuration, "--nologo"];
  if (options.selfContained) {
    args.push("--self-contained", "true", "-r", options.runtime);
  } else {
    // 显式关掉自包含与裁剪：机器上可能残留 `SelfContained=true` /
    // `PublishTrimmed=true` 的全局属性，不写这两行会让「默认框架依赖、不裁剪」
    // 的承诺失效。
    args.push("--self-contained", "false", "-p:PublishTrimmed=false");
  }
  if (options.output.length > 0) {
    args.push("-o", path.resolve(options.output));
  }

  const rendered = `dotnet ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`;
  process.stdout.write(`${rendered}\n`);

  const result = spawnSync("dotnet", args, { stdio: "inherit", cwd: repoRoot });
  if (result.error !== undefined) {
    process.stderr.write(`无法执行 dotnet：${result.error.message}\n`);
    process.stderr.write("请安装 .NET 10 SDK（https://dotnet.microsoft.com/download）\n");
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  // 打印最终 dll 的绝对路径：调用方（扩展打包脚本）要把它复制进扩展目录，
  // 让人肉眼找 bin/Release/net10.0 容易找错平台目录。
  const outDir =
    options.output.length > 0
      ? path.resolve(options.output)
      : path.join(projectDir, "bin", options.configuration, "net10.0");
  process.stdout.write(`sidecar: ${path.join(outDir, "drawcode-metadata.dll")}\n`);
}

main();
