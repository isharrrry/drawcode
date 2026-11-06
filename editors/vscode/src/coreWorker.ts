/**
 * 解析线程：在 worker_threads 里直接调用核心的 `readArtifact`。
 *
 * 为什么是 worker 而不是扩展宿主主线程：
 *   - ELF / ar 的解析是同步的 `Buffer` 遍历，几十 MB 的 `.so` 会让宿主卡住；
 *   - PE 虽然等的是子进程，但 sidecar 的 JSON 解析同样发生在这条线程上。
 *   把「字节 -> 模型」整段放进 worker，宿主只负责收结构化克隆的结果。
 *
 * 为什么用 `require` 而不是 `import "../core/artifact/read.js"`：
 *   核心在 `typescript/src`，按 ESM 写；扩展按 CommonJS 编译。两边用同一个
 *   源码文件、各自产出自己的模块格式。`dist/core` 是构建程序集，不在 TS 的
 *   rootDir 内，静态 import 会让 tsc 试图把核心再编一遍。运行时按绝对路径
 *   `require` 是这里唯一不制造第二份源码的办法。
 *
 * 安全边界不变：只调用 `readArtifact`，目标程序集只被按字节读取，绝不加载执行。
 */

import * as path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

/** 只声明本 worker 用到的那一小块核心 API，避免把核心类型复制一份。 */
interface ArtifactCore {
  readArtifact(
    file: string,
    options: { inferEdges?: boolean; metadataToolPath?: string; dotnetPath?: string },
  ): Promise<unknown>;
  canonicalArtifactJson(model: unknown): string;
}

interface CoreRequest {
  file: string;
  inferEdges: boolean;
  /** sidecar 的绝对路径；找不到时由主线程留空，核心会退回环境变量或给诊断。 */
  metadataToolPath?: string;
  /** `dotnet` 的显式路径；空串表示由核心自动查找。 */
  dotnetPath?: string;
}

/**
 * 载入 `dist/core` 里的 CommonJS 核心。
 *
 * 单独包一层是为了把「扩展安装不完整」与「程序集解析失败」区分开：
 * 前者是 MODULE_NOT_FOUND，要提示重新安装；后者是程序集语义问题。
 */
function loadCore(): ArtifactCore {
  const readModule = require(path.join(__dirname, "core", "artifact", "read.js")) as {
    readArtifact: ArtifactCore["readArtifact"];
  };
  const inspectModule = require(path.join(__dirname, "core", "artifact", "inspect.js")) as {
    canonicalArtifactJson: ArtifactCore["canonicalArtifactJson"];
  };
  return {
    readArtifact: readModule.readArtifact,
    canonicalArtifactJson: inspectModule.canonicalArtifactJson,
  };
}

async function main(): Promise<void> {
  const request = workerData as CoreRequest;

  let core: ArtifactCore;
  try {
    core = loadCore();
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      code: "core-missing",
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  try {
    const model = await core.readArtifact(request.file, {
      inferEdges: request.inferEdges,
      metadataToolPath: request.metadataToolPath,
      dotnetPath: request.dotnetPath,
    });
    // 模型与规范 JSON 一起回传：宿主既要渲染模型，也要支持「复制 JSON」，
    // 两份在 worker 里一次算好比回传模型后再在宿主里重新规范一遍更省事。
    parentPort?.postMessage({
      ok: true,
      model,
      json: core.canonicalArtifactJson(model),
    });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
}

void main();
