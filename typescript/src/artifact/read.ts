/**
 * 产物读取入口：读文件 -> 按 magic bytes 分派 -> 返回 `ArtifactModel`。
 *
 * 这里是**唯一**把字节变成模型的地方。上层的 CLI `inspect` 与 VS Code 插件都只调用它，
 * 因而「解析在哪个线程、文件多大、是否允许推断」都只需要在这一层决定。
 *
 * 硬约束（design §1.3）：只读字节，绝不 `require`/`load`/`exec` 目标产物。
 * 本模块只用 `fs.readFile`，没有任何执行路径。
 */

import { promises as fs } from "node:fs";
import * as nodePath from "node:path";

import { readAr } from "./ar.ts";
import { DiagnosticBag, DIAG } from "./diagnostics.ts";
import { readElf } from "./elf.ts";
import { detectFormat, type ContainerFormat } from "./format.ts";
import { emptyArtifactModel, type ArtifactModel } from "./model.ts";
import { readPeCli } from "./pe.ts";

export interface ReadOptions {
  /**
   * 是否允许用重定位 / 符号表补全声明层缺失的边（P4 可选）。
   * 默认 false：推断边会让同一产物在不同构建选项下产出不同模型。
   */
  inferEdges?: boolean;
  /**
   * PE/CLI sidecar 的绝对路径，由壳提供。
   *
   * 核心不假设自己装在仓库还是 VSIX 里；CLI 从仓库相对位置解析，
   * 扩展从 `context.extensionPath` 下的随包目录解析，然后把结果传进来。
   */
  metadataToolPath?: string;
}

/**
 * 读取一个产物文件。
 *
 * 不抛「格式不支持」异常：插件需要根据模型里的诊断决定是接管还是回退默认编辑器，
 * 抛异常会把「无法识别」变成一个必须额外捕获的控制流。只有 I/O 失败（文件不存在、
 * 无权限）才会 reject —— 那确实不是产物语义问题。
 */
export async function readArtifact(file: string, options: ReadOptions = {}): Promise<ArtifactModel> {
  const buf = await fs.readFile(file);
  const name = nodePath.basename(file);
  const container = detectFormat(buf);

  if (container === "unknown") {
    const bag = new DiagnosticBag();
    bag.error(DIAG.unknownFormat, "无法识别的文件格式（既不是 ar / PE，也不是 ELF）", name);
    return { ...emptyArtifactModel(name), diagnostics: bag.items };
  }

  // PE 走 .NET sidecar：CLI 元数据的解析交给 System.Reflection.Metadata，
  // 本仓库只保留「调用 + 消费 JSON」这一层。原生 PE 由 sidecar 返回 unsupported-native-pe。
  if (container === "pe") {
    return readPeCli(file, name, { toolPath: options.metadataToolPath });
  }

  // ELF 与 ar 都在本进程内按字节解析：格式足够简单，且 C 侧模板把元数据
  // 放进了定长 POD 段，读取不需要符号表、重定位或任何外部工具。
  if (container === "elf") {
    return readElf(buf, name, options);
  }
  return readAr(buf, name, options);
}

/** 把容器格式暴露给调用方（插件在打开文件前可用它做一次廉价判定）。 */
export type { ContainerFormat };
