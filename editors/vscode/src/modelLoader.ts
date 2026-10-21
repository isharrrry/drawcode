/**
 * VS Code 侧的解析编排：从设置到模型，全程不启动 CLI。
 *
 * 架构上这里只是一个「壳」：
 *   - 仓库里的 CLI 与这里都调用同一个 `readArtifact`（`typescript/src/artifact/read.ts`）；
 *   - 壳各自负责自己环境里的「东西在哪」——CLI 从仓库相对位置找 sidecar，
 *     扩展从 `extensionPath` 下的随包目录找；
 *   - 解析语义只有一份，不存在「插件调 CLI，CLI 再解析」那条会漂移的链路。
 *
 * 为什么仍然要 worker：
 *   ELF / ar 是同步的字节遍历，大 `.so` 会把扩展宿主卡住；PE 虽然等的是
 *   `dotnet` 子进程，但 sidecar 输出的 JSON 也在这条线程解析。把整段放进
 *   worker，宿主只做 UI。
 *
 * 安全边界：只调用只读的 `readArtifact`，不加载、不执行被查看的程序集。
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";

import type { ArtifactModel } from "./types";

const MB = 1024 * 1024;

/**
 * sidecar 相对扩展根的路径。
 *
 * 发布版由打包脚本把 `tools/drawcode-metadata` 的 publish 程序集放进 VSIX；
 * 开发态（F5）没有这份拷贝，`findMetadataTool` 会继续向上找到仓库里的同名目录。
 */
const METADATA_TOOL_SEGMENTS = [
  "tools",
  "drawcode-metadata",
  "bin",
  "Release",
  "net8.0",
  "drawcode-metadata.dll",
] as const;

/** 程序集超过 `drawcode.maxSizeMB`。webview 据此提供“仍要解析”。 */
export class ArtifactTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(
      `程序集 ${(size / MB).toFixed(1)} MB，超过上限 ${(limit / MB).toFixed(0)} MB。` +
        "解析大文件可能让扩展宿主卡住数秒。",
    );
    this.name = "ArtifactTooLargeError";
  }
}

/** 扩展随包的解析核心缺失：安装不完整，只能重新安装。 */
export class CoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreUnavailableError";
  }
}

/** 核心存在但解析失败：程序集读取异常、worker 崩溃等。 */
export class InspectFailedError extends Error {
  constructor(
    message: string,
    /** 原始错误文本，调用方可在“查看详情”里原样展示。 */
    readonly detail: string,
  ) {
    super(message);
    this.name = "InspectFailedError";
  }
}

export interface ViewerSettings {
  maxSizeMB: number;
  showCompilerGenerated: boolean;
  showExcluded: boolean;
  inferEdges: boolean;
  /** 信号 + 函数超过它才走切片；0 = 总是切片，-1 = 强制全量。 */
  artifactSliceThreshold: number;
}

export function readSettings(): ViewerSettings {
  const cfg = vscode.workspace.getConfiguration("drawcode");
  const threshold = cfg.get<number>("artifactSliceThreshold", 2000);
  return {
    maxSizeMB: Math.max(1, cfg.get<number>("maxSizeMB", 64)),
    showCompilerGenerated: cfg.get<boolean>("showCompilerGenerated", false),
    showExcluded: cfg.get<boolean>("showExcluded", false),
    inferEdges: cfg.get<boolean>("inferEdges", false),
    // 非数字（用户把设置写成字符串等）时退回默认值，避免 NaN 让比较恒为 false、
    // 悄悄关掉切片。
    artifactSliceThreshold: Number.isFinite(threshold) ? Math.trunc(threshold) : 2000,
  };
}

/**
 * 找 PE/CLI sidecar。
 *
 * 顺序：
 *   1. 扩展自己的 `tools/drawcode-metadata/...`（发布版随 VSIX 携带）；
 *   2. 从扩展目录向上最多 8 层找同样的相对路径（开发态：`<repo>/editors/vscode`
 *      向上两层就是 `<repo>`）；
 *   3. 都没有则返回 undefined，核心会退回 `DRAWCODE_METADATA_TOOL` 环境变量。
 *
 * 找不到不是致命错误：ELF / ar 不需要 sidecar。PE 会得到一条 `tool-unavailable`
 * 诊断，页面照常打开并说明原因。
 */
export function findMetadataTool(extensionPath: string): string | undefined {
  const bundled = path.join(extensionPath, ...METADATA_TOOL_SEGMENTS);
  if (existsSync(bundled)) return bundled;

  let dir = path.dirname(path.resolve(extensionPath));
  for (let level = 0; level < 8; level += 1) {
    const candidate = path.join(dir, ...METADATA_TOOL_SEGMENTS);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export interface LoadedArtifact {
  model: ArtifactModel;
  /** 规范 JSON 原文，供“解析当前程序集（复制 JSON）”命令使用。 */
  json: string;
}

export interface LoadOptions {
  /** 用户确认“仍要解析”后跳过大小检查。 */
  ignoreSize?: boolean;
}

export async function loadArtifactModel(
  uri: vscode.Uri,
  context: vscode.ExtensionContext,
  token: vscode.CancellationToken,
  settings: ViewerSettings,
  options: LoadOptions = {},
): Promise<LoadedArtifact> {
  // 用 vscode.workspace.fs 而不是 node:fs：远端/虚拟工作区下前者才有效。
  const stat = await vscode.workspace.fs.stat(uri);
  if (options.ignoreSize !== true && stat.size > settings.maxSizeMB * MB) {
    throw new ArtifactTooLargeError(stat.size, settings.maxSizeMB * MB);
  }
  if (token.isCancellationRequested) throw cancelledError();

  return parseInWorker(
    uri.fsPath,
    settings.inferEdges,
    findMetadataTool(context.extensionPath),
    token,
  );
}

/** 取消不是错误：editor 会静默返回，命令面板也不会弹红条。 */
function cancelledError(): Error {
  const error = new Error("解析已取消");
  error.name = "AbortError";
  return error;
}

interface WorkerReply {
  ok?: unknown;
  code?: unknown;
  model?: unknown;
  json?: unknown;
  error?: unknown;
}

/**
 * 在 worker 里解析一次程序集。
 *
 * worker 的入口是一个真实文件（`dist/coreWorker.js`）而不是内联函数；
 * 它不 import vscode，否则扩展宿主的模块解析器在 worker 里不存在。
 */
function parseInWorker(
  file: string,
  inferEdges: boolean,
  metadataToolPath: string | undefined,
  token: vscode.CancellationToken,
): Promise<LoadedArtifact> {
  return new Promise<LoadedArtifact>((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "coreWorker.js"), {
      workerData: { file, inferEdges, metadataToolPath },
    });

    let settled = false;
    // 声明成可空而不是在 finish 里直接用 const：如果 VS Code 在注册时立刻回调
    // 已取消的 token，`subscription` 还处在暂时性死区，访问会抛 ReferenceError。
    let subscription: vscode.Disposable | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      subscription?.dispose();
      void worker.terminate();
      action();
    };

    subscription = token.onCancellationRequested(() => {
      finish(() => reject(cancelledError()));
    });

    worker.once("message", (reply: WorkerReply) => {
      finish(() => {
        if (reply.ok === true && reply.model !== undefined && typeof reply.json === "string") {
          resolve({ model: reply.model as ArtifactModel, json: reply.json });
          return;
        }
        if (reply.code === "core-missing") {
          reject(
            new CoreUnavailableError(
              "扩展内置的解析核心缺失（dist/core）。请重新安装 Drawcode Artifact Viewer。",
            ),
          );
          return;
        }
        reject(
          new InspectFailedError(
            "解析程序集失败。",
            typeof reply.error === "string" ? reply.error : "worker 未给出错误信息",
          ),
        );
      });
    });

    worker.once("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === "MODULE_NOT_FOUND") {
          reject(
            new CoreUnavailableError(
              "扩展内置的解析核心缺失（dist/core 或 dist/coreWorker.js）。" +
                "请重新安装 Drawcode Artifact Viewer。",
            ),
          );
          return;
        }
        reject(new InspectFailedError(`解析线程启动失败：${error.message}`, error.stack ?? ""));
      });
    });

    worker.once("exit", (code) => {
      finish(() => {
        reject(new InspectFailedError(`解析线程在返回结果前退出（code ${code}）。`, ""));
      });
    });
  });
}
