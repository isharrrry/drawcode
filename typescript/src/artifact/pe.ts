/**
 * PE/CLI 读取器：把解析工作交给同协议栈的 .NET 小工具（sidecar）。
 *
 * 为什么不在 TS 里手写：CLI 元数据要处理表流、编码索引、签名 blob、自定义特性、
 * CIL 操作数长度……正确实现约 2500 行，而且每个边角都可能在真实产物上读错。
 * `System.Reflection.Metadata` 是 BCL 自带的官方实现，改由它解析、TS 只消费 JSON，
 * 维护成本与出错面都小一个数量级。
 *
 * 安全边界不变：sidecar 用 `PEReader` **只读字节**，不 `Assembly.Load`、不执行目标代码。
 * 这里也只用 `execFile` 调本地进程，不把产物内容拼进命令行以外的任何执行路径。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DiagnosticBag, DIAG } from "./diagnostics.ts";
import { emptyArtifactModel, type ArtifactModel } from "./model.ts";

const execFileAsync = promisify(execFile);

/** sidecar 一般几十毫秒；给 30 秒是给「首次 JIT + 大程序集」留余量，不是常态耗时。 */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface PeReadOptions {
  /**
   * sidecar 的 dll 路径，由壳（CLI / VS Code 扩展）显式传入。
   *
   * 核心不再从 `import.meta.url` 推断仓库布局：CLI 知道 sidecar 在仓库的哪个目录，
   * 扩展知道它随 VSIX 装在哪个目录；把「东西在哪」留给壳，核心才能同时被
   * CommonJS 扩展与 ESM CLI 引用，而不需要各自复制一份解析逻辑。
   */
  toolPath?: string;
  /** 调用超时，毫秒。 */
  timeoutMs?: number;
}

/**
 * 解析一个 PE 文件（CLI 或原生）。
 *
 * 返回模型而不是抛异常：sidecar 缺失、超时、输出不是 JSON，都是「这一类输入暂时看不了」，
 * 应当变成模型里的诊断让界面提示，而不是让调用方多写一层 try/catch。
 */
export async function readPeCli(
  file: string,
  name: string,
  options: PeReadOptions = {},
): Promise<ArtifactModel> {
  const bag = new DiagnosticBag();
  const tool = resolveTool(options.toolPath);

  if (tool === null) {
    bag.warn(
      DIAG.toolUnavailable,
      "找不到 drawcode-metadata 工具；PE/CLI 解析需要随包携带的 sidecar 与 .NET 10 运行时",
      name,
    );
    return { ...emptyArtifactModel(name, "pe-cli", "dll"), diagnostics: bag.items };
  }

  let stdout: string;
  try {
    const result = await execFileAsync("dotnet", [tool, file], {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
    stdout = result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bag.warn(DIAG.toolUnavailable, `drawcode-metadata 调用失败：${message}`, name);
    return { ...emptyArtifactModel(name, "pe-cli", "dll"), diagnostics: bag.items };
  }

  try {
    return JSON.parse(stdout) as ArtifactModel;
  } catch {
    bag.warn(DIAG.toolUnavailable, "drawcode-metadata 的输出不是合法 JSON", name);
    return { ...emptyArtifactModel(name, "pe-cli", "dll"), diagnostics: bag.items };
  }
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
