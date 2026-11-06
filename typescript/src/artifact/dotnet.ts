/**
 * .NET 运行时定位与故障分类。
 *
 * 发布形态是**框架依赖**：VSIX 只带 sidecar 的 `dll + deps + runtimeconfig`，
 * 不携带 .NET 运行时，也不做裁剪 —— 这样同一份包可以在 Windows / Linux 上使用。
 * 代价是目标机必须有 .NET 10+ 运行时；本模块负责把「没有 dotnet」「有 dotnet
 * 但没有兼容运行时」「sidecar 自己失败」区分开，让上层给出可操作的安装提示，
 * 而不是一条笼统的 `tool-unavailable` 或一个空白页面。
 *
 * 为什么还要按常见目录补找：VS Code 从图形界面启动时，PATH 不一定包含用户
 * shell 里的 `dotnet`。Linux 用 `dotnet-install.sh` 装到 `~/.dotnet`、Windows
 * 用 `dotnet-install` 装到 `%LOCALAPPDATA%\Microsoft\dotnet` 都属于这种情况。
 */

import { accessSync, constants as fsConstants, statSync } from "node:fs";
import * as nodePath from "node:path";

import type { DiagnosticCode } from "./model.ts";

/** 官方下载页；扩展的“打开安装说明”按钮也指向这里。 */
export const DOTNET_DOWNLOAD_URL = "https://dotnet.microsoft.com/download/dotnet/10.0";
/** Linux 各发行版的安装文档；包名随发行版不同，不能只给一条 apt 命令。 */
export const DOTNET_LINUX_DOCS_URL = "https://learn.microsoft.com/dotnet/core/install/linux";

/**
 * sidecar 的 TargetFramework 是 `net10.0`，csproj 显式设置了
 * `RollForward=LatestMajor`，所以 10.x 与更高的主版本都能运行。
 */
export const MIN_DOTNET_MAJOR = 10;

export type DotnetFailureCode = Extract<
  DiagnosticCode,
  "dotnet-missing" | "dotnet-runtime-missing" | "tool-unavailable"
>;

export interface DotnetFailure {
  code: DotnetFailureCode;
  /** 面向用户的完整说明（含平台相关的安装命令）。 */
  message: string;
  /** 宿主/子进程原始输出摘要，便于日志与排障；可能为空串。 */
  detail: string;
}

export interface DotnetLookupOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /**
   * 便于测试：判断候选路径是否是可执行文件。
   * 默认实现要求「是普通文件」；非 Windows 还要求 executable 位。
   */
  isExecutable?: (file: string) => boolean;
}

/** 默认的可执行判定。Windows 只检查存在（X_OK 在 Windows 上不生效）。 */
function defaultIsExecutable(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform === "win32") return true;
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 目标机上可能的 `dotnet` 可执行文件，按优先级排列。
 *
 * 只返回存在且可执行的路径；调用方仍应把 PATH 里的裸 `dotnet` 放在最前面，
 * 因为常规安装（Windows 系统安装、Linux 发行版包）都在 PATH 里。
 */
export function dotnetCandidates(options: DotnetLookupOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const p = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const isExecutable =
    options.isExecutable ?? ((file: string) => defaultIsExecutable(file, platform));
  const exe = platform === "win32" ? "dotnet.exe" : "dotnet";

  const candidates: string[] = [];

  // SDK / MSBuild 在子进程里会设置这个变量，指向 dotnet 可执行文件本身。
  const hostPath = env["DOTNET_HOST_PATH"]?.trim();
  if (hostPath !== undefined && hostPath.length > 0) candidates.push(hostPath);

  /**
   * `DOTNET_ROOT` 按官方约定指向**目录**（目录里才有 dotnet / dotnet.exe）。
   * 注意不能拿 basename 是否等于 `dotnet` 来判断它是不是可执行文件：
   * Linux 上 `/usr/share/dotnet` 的 basename 也叫 dotnet，会被误当成文件。
   */
  const addRoot = (root: string | undefined): void => {
    const trimmed = root?.trim().replace(/[\\/]+$/, "") ?? "";
    if (trimmed.length === 0) return;
    candidates.push(p.join(trimmed, exe));
  };

  addRoot(env["DOTNET_ROOT"]);
  if (platform === "win32") addRoot(env["DOTNET_ROOT(x86)"]);

  if (platform === "win32") {
    const programFiles = env["ProgramFiles"];
    const programFilesX86 = env["ProgramFiles(x86)"];
    const localAppData = env["LOCALAPPDATA"];
    const userProfile = env["USERPROFILE"];
    if (programFiles !== undefined) candidates.push(p.join(programFiles, "dotnet", exe));
    if (programFilesX86 !== undefined) candidates.push(p.join(programFilesX86, "dotnet", exe));
    if (localAppData !== undefined) {
      candidates.push(p.join(localAppData, "Microsoft", "dotnet", exe));
    }
    if (userProfile !== undefined) candidates.push(p.join(userProfile, ".dotnet", exe));
  } else if (platform === "darwin") {
    candidates.push(
      "/usr/local/share/dotnet/dotnet",
      "/opt/homebrew/bin/dotnet",
      "/usr/local/bin/dotnet",
    );
    if (env["HOME"] !== undefined) candidates.push(p.join(env["HOME"], ".dotnet", exe));
  } else {
    candidates.push(
      "/usr/share/dotnet/dotnet", // 官方安装脚本与多数发行版
      "/usr/lib/dotnet/dotnet", // Debian / Ubuntu 的 dotnet-runtime 包
      "/usr/lib64/dotnet/dotnet", // Fedora / RHEL
      "/usr/local/share/dotnet/dotnet",
      "/opt/dotnet/dotnet",
      "/snap/bin/dotnet",
      "/usr/local/bin/dotnet",
      "/usr/bin/dotnet",
    );
    if (env["HOME"] !== undefined) candidates.push(p.join(env["HOME"], ".dotnet", exe));
  }

  const seen = new Set<string>();
  const found: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutable(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * 调用 dotnet 的候选命令，按尝试顺序排列。
 *
 * 显式配置（扩展设置 / `DRAWCODE_DOTNET`）拥有最高优先级，并且**不再回退**：
 * 用户指定了一个路径却被静默换掉，排障时会非常困惑。没有显式配置时先试 PATH
 * 里的 `dotnet`；命令不存在或宿主报告缺少兼容运行时，再逐个试常见安装目录。
 */
export function dotnetAttempts(
  explicitPath?: string,
  options: DotnetLookupOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const configured = explicitPath?.trim() || env["DRAWCODE_DOTNET"]?.trim() || "";
  if (configured.length > 0) return [configured];
  return ["dotnet", ...dotnetCandidates(options)];
}

/** 平台相关的安装提示。多行文本既用于诊断消息，也用于扩展页面里的说明块。 */
export function dotnetInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return [
      "Windows 安装 .NET 10 运行时：",
      "  winget install Microsoft.DotNet.Runtime.10",
      `  或从 ${DOTNET_DOWNLOAD_URL} 下载安装。`,
    ].join("\n");
  }
  if (platform === "linux") {
    return [
      "Linux 安装 .NET 10 运行时（按发行版选一条）：",
      "  Debian / Ubuntu: sudo apt-get install -y dotnet-runtime-10.0",
      "  Fedora:          sudo dnf install -y dotnet-runtime-10.0",
      `  其他发行版：${DOTNET_LINUX_DOCS_URL}`,
      `  或从 ${DOTNET_DOWNLOAD_URL} 下载。`,
    ].join("\n");
  }
  if (platform === "darwin") {
    return [
      "macOS 安装 .NET 10 运行时：",
      "  brew install dotnet@10",
      `  或从 ${DOTNET_DOWNLOAD_URL} 下载安装。`,
    ].join("\n");
  }
  return `安装 .NET 10 运行时：${DOTNET_DOWNLOAD_URL}`;
}

interface ExecErrorLike {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

/**
 * 提取宿主输出里最有信息量的行。
 *
 * 缺运行时时 dotnet 会先打印 App / Architecture / Framework，再列出机器上已装的
 * 所有框架（可能几十行，含 x86 列表）。整段塞进诊断既长又埋没关键信息，所以
 * 优先保留这几类关键行；识别不到时才退回末尾几行（通常是异常的真正原因）。
 */
function summarizeOutput(text: string, max = 600): string {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  // 刻意不保留 App / .NET location：它们含本机绝对路径，会让规范 JSON 无法跨机器
  // 逐字节比对。Framework / 架构与安装结论足以定位问题。
  const keyLines = lines.filter((line) =>
    /You must install|It was not possible|Framework:|^Architecture:/i.test(line),
  );
  const picked = keyLines.length > 0 ? keyLines : lines.slice(-8);
  const joined = picked.join("\n");
  return joined.length <= max ? joined : `${joined.slice(0, max)}…`;
}

/** 这些是 .NET 宿主在「找不到兼容框架」时的固定文案（大小写不敏感）。 */
function looksLikeMissingRuntime(text: string): boolean {
  return (
    /You must install or update \.NET/i.test(text) ||
    /It was not possible to find any compatible framework version/i.test(text) ||
    /framework ['"]?Microsoft\.NETCore\.App['"]?.*was not found/i.test(text) ||
    /To run this application, you must install .*Microsoft\.NETCore\.App/i.test(text)
  );
}

/**
 * 是否值得换下一个候选 `dotnet` 路径重试。
 *
 * - 命令不存在（ENOENT）：当然要换下一个安装位置。
 * - 宿主报告缺少兼容运行时：也要换。机器上可能 PATH 是旧版 .NET，而
 *   `~/.dotnet` 或 `/usr/lib/dotnet` 里有新版；只试 PATH 会让用户误以为
 *   「装了也没用」。
 * - 超时、sidecar 自身异常：宿主已经能跑，换路径只会重放同一个错误。
 */
export function shouldTryNextDotnet(error: unknown): boolean {
  const e = (error ?? {}) as ExecErrorLike;
  if (e.code === "ENOENT" || e.code === 150) return true;
  const combined = [textOf(e.stderr), textOf(e.stdout), textOf(e.message)]
    .filter((part) => part.length > 0)
    .join("\n");
  return looksLikeMissingRuntime(combined);
}

/**
 * 把 `execFile("dotnet", ...)` 的失败翻译成用户能行动的诊断。
 *
 * `error.code` 在 spawn 失败时是字符串（`ENOENT`），在子进程非零退出时是数字；
 * 两者必须分开处理，否则「没装 .NET」会被误报成「sidecar 解析失败」。
 */
export function classifyDotnetFailure(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): DotnetFailure {
  const e = (error ?? {}) as ExecErrorLike;
  const stderr = textOf(e.stderr);
  const stdout = textOf(e.stdout);
  const message = textOf(e.message);
  const combined = [stderr, stdout, message].filter((part) => part.length > 0).join("\n");
  const detail = summarizeOutput(stderr.length > 0 ? stderr : stdout);

  // ENOENT：候选命令本身不存在。调用方应在换完所有候选后才会走到这里。
  if (e.code === "ENOENT") {
    return {
      code: "dotnet-missing",
      message:
        "未找到 .NET 运行时：PATH、DOTNET_ROOT、DOTNET_HOST_PATH 与常见安装目录里都没有可用的 `dotnet` 命令。" +
        "解析 .dll 需要 .NET 10+ 运行时；扩展不随包携带运行时（保持安装包小，" +
        "同一份包可用于 Windows / Linux）。\n" +
        dotnetInstallHint(platform) +
        "\n安装后请重启 VS Code；Remote-SSH / WSL / Dev Container 请在远端安装。",
      detail,
    };
  }

  if (e.killed === true || e.code === "ETIMEDOUT") {
    return {
      code: "tool-unavailable",
      message:
        "drawcode-metadata 调用超时：.NET sidecar 在超时时间内没有返回。" +
        "可以重试；若每次都超时，请确认 `dotnet` 能在终端里正常运行。",
      detail,
    };
  }

  // 宿主找不到框架时通常退出 150；文案是英文常量，但不同版本略有差异，两个都认。
  if (e.code === 150 || looksLikeMissingRuntime(combined)) {
    return {
      code: "dotnet-runtime-missing",
      message:
        "已找到 `dotnet`，但没有可用的 .NET 10+ 运行时" +
        "（sidecar 需要 Microsoft.NETCore.App 10.x 或更高主版本）。\n" +
        dotnetInstallHint(platform) +
        (detail.length > 0 ? `\n宿主输出：${detail}` : ""),
      detail,
    };
  }

  const exit = typeof e.code === "number" ? `（退出码 ${e.code}）` : "";
  return {
    code: "tool-unavailable",
    message:
      `drawcode-metadata 调用失败${exit}` +
      (detail.length > 0 ? `：${detail}` : "。请确认 sidecar 与 .NET 运行时安装完整。"),
    detail,
  };
}
