/**
 * PE/CLI 读取器：把解析工作交给同协议栈的 .NET 小工具（sidecar）。
 *
 * 为什么不在 TS 里手写：CLI 元数据要处理表流、编码索引、签名 blob、自定义特性、
 * CIL 操作数长度……正确实现约 2500 行，而且每个边角都可能在真实产物上读错。
 * `System.Reflection.Metadata` 是 BCL 自带的官方实现，改由它解析、TS 只消费 JSON，
 * 维护成本与出错面都小一个数量级。
 *
 * 发布形态是框架依赖：VSIX 只带 sidecar 的 dll/deps/runtimeconfig，不带也不裁剪
 * .NET 运行时。因此这里把「sidecar 缺失」「没装 dotnet」「dotnet 没有 10+ 运行时」
 * 分开报告 —— 用户需要看到的是「装什么」，而不是一条笼统的 tool-unavailable。
 *
 * 安全边界不变：sidecar 用 `PEReader` **只读字节**，不 `Assembly.Load`、不执行目标代码。
 * 这里也只用 `execFile` 调本地进程，不把产物内容拼进命令行以外的任何执行路径。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { DiagnosticBag, DIAG } from "./diagnostics.ts";
import { classifyDotnetFailure, dotnetAttempts, shouldTryNextDotnet } from "./dotnet.ts";
import { emptyArtifactModel, type ArtifactModel } from "./model.ts";

const execFileAsync = promisify(execFile);

/** sidecar 一般几十毫秒；给 30 秒是给「首次 JIT + 大程序集」留余量，不是常态耗时。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 诊断里只写相对位置，保证规范 JSON 可以跨机器逐字节比对。 */
const SIDECAR_MISSING_MESSAGE =
  "找不到随扩展打包的 drawcode-metadata sidecar" +
  "（tools/drawcode-metadata/bin/Release/net10.0/drawcode-metadata.dll）。" +
  "扩展安装不完整，请重新安装；从源码运行请先执行 `npm run build` 或 " +
  "`node tools/publish-metadata-tool.mjs`。ELF / ar 解析不依赖它。";

export interface PeReadOptions {
  /**
   * sidecar 的 dll 路径，由壳（CLI / VS Code 扩展）显式传入。
   *
   * 核心不再从 `import.meta.url` 推断仓库布局：CLI 知道 sidecar 在仓库的哪个目录，
   * 扩展知道它随 VSIX 装在哪个目录；把「东西在哪」留给壳，核心才能同时被
   * CommonJS 扩展与 ESM CLI 引用，而不需要各自复制一份解析逻辑。
   */
  toolPath?: string;
  /**
   * `dotnet` 可执行文件的显式路径（扩展设置 `drawcode.dotnetPath`）。
   * 未设置时依次尝试 `DRAWCODE_DOTNET`、PATH 与各平台常见安装目录。
   */
  dotnetPath?: string;
  /** 调用超时，毫秒。 */
  timeoutMs?: number;
}

/**
 * 解析一个 PE 文件（CLI 或原生）。
 *
 * 返回模型而不是抛异常：sidecar 缺失、.NET 未安装、超时、输出不是 JSON，都是
 * 「这一类输入暂时看不了」，应当变成模型里的诊断让界面提示，而不是让调用方
 * 多写一层 try/catch。
 */
export async function readPeCli(
  file: string,
  name: string,
  options: PeReadOptions = {},
): Promise<ArtifactModel> {
  const bag = new DiagnosticBag();
  const tool = resolveTool(options.toolPath);

  if (tool === null || !sidecarIsComplete(tool)) {
    bag.warn(DIAG.toolUnavailable, SIDECAR_MISSING_MESSAGE, name);
    return { ...emptyArtifactModel(name, "pe-cli", "dll"), diagnostics: bag.items };
  }

  let stdout: string | undefined;
  let lastError: unknown;
  const attempts = dotnetAttempts(options.dotnetPath);

  for (const dotnet of attempts) {
    try {
      const result = await execFileAsync(dotnet, [tool, file], {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      });
      stdout = result.stdout;
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      // 命令不存在、或宿主报告缺少兼容运行时，都值得换下一个安装位置再试：
      // 机器上可能 PATH 是旧版 .NET，而 ~/.dotnet / /usr/lib/dotnet 里有新版。
      // 超时或 sidecar 自身异常则不再重试，换路径只会重放同一个错误。
      if (!shouldTryNextDotnet(error)) break;
    }
  }

  if (stdout === undefined) {
    const failure = classifyDotnetFailure(lastError);
    bag.warn(failure.code, failure.message, name);
    return { ...emptyArtifactModel(name, "pe-cli", "dll"), diagnostics: bag.items };
  }

  try {
    return JSON.parse(stdout) as ArtifactModel;
  } catch {
    bag.warn(
      DIAG.toolUnavailable,
      "drawcode-metadata 的输出不是合法 JSON。请确认 sidecar 与扩展版本一致，然后重试。",
      name,
    );
    return { ...emptyArtifactModel(name, "pe-cli", "dll"), diagnostics: bag.items };
  }
}

/**
 * sidecar 是否完整。
 *
 * 框架依赖发布必须同时有 dll、deps.json 与 runtimeconfig.json：只缺
 * runtimeconfig.json 时 `dotnet <dll>` 仍会启动失败，但错误信息很像「产物有问题」。
 * 在这里提前判定，能把「扩展装坏了」和「程序集读不了」分开。
 */
function sidecarIsComplete(tool: string): boolean {
  if (!existsSync(tool)) return false;
  if (!tool.toLowerCase().endsWith(".dll")) return true;
  const base = tool.slice(0, -4);
  return existsSync(`${base}.deps.json`) && existsSync(`${base}.runtimeconfig.json`);
}

/**
 * sidecar 定位顺序：壳显式传入 -> 环境变量。
 *
 * 核心只认这两个来源，不读 cwd、不猜仓库层级。环境变量留给「sidecar 装在别处」
 * 的调试场景；正常运行时由壳给出确切的绝对路径。
 */
function resolveTool(explicit: string | undefined): string | null {
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const fromEnv = process.env["DRAWCODE_METADATA_TOOL"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  return null;
}
