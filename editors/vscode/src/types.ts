/**
 * 扩展侧使用的 `ArtifactModel` 结构。
 *
 * 为什么不从 `../../../typescript/src/artifact/model.ts` 直接 import：
 *   - 扩展是独立的 npm 包（有自己的 tsconfig 与 rootDir），跨包相对 import 会把
 *     仓库源码拖进 `dist/` 的目录结构，tsc 的 `rootDir` 也会报错；
 *   - 扩展运行时不与仓库源码同生命周期：用户可能只安装 vsix，仓库并不存在；
 *   - 真正的契约是 CLI `inspect` 输出的**规范 JSON**（见 `docs/artifact-format.md`），
 *     不是 TypeScript 类型。类型在这里只是消费侧的一份手抄镜像。
 *
 * 因此本文件的修改时机只有一处：`typescript/src/artifact/model.ts` 的字段增删。
 * 两者不一致时以 `docs/artifact-format.md` 为准。
 */

export type SignalDirection = "in" | "out" | "inout" | "";

export interface ArtifactInfo {
  path: string;
  format: "pe-cli" | "pe-native" | "elf" | "ar" | "unknown";
  arch: string;
  kind: "dll" | "so" | "exe" | "object" | "archive" | "unknown";
  hasMetadata: boolean;
  metadataVersion: number;
  entryPoint?: string;
  version?: string;
  fileVersion?: string;
  productVersion?: string;
  culture?: string;
  targetFramework?: string;
  buildId?: string;
  fileSize?: number;
}

export interface TypeField {
  name: string;
  ctype: string;
  typeId?: string;
  offset: number;
  size: number;
  initial?: string;
  tags: string[];
}

export interface ArtifactType {
  id: string;
  name: string;
  kind: "class" | "struct" | "record" | "enum" | "interface";
  path: string;
  alias?: string;
  note?: string;
  tags: string[];
  store: boolean;
  exclude: boolean;
  fields: TypeField[];
  size: number;
}

export interface ArtifactSignal {
  id: string;
  name: string;
  ctype: string;
  dir: SignalDirection;
  unit: string;
  alias: string;
  note: string;
  tags: string[];
  path: string;
  ownerType?: string;
  fieldOffset?: number;
  initial?: string;
  exclude: boolean;
  external: boolean;
  inferred: boolean;
  address?: string;
}

export interface ArtifactParam {
  name: string;
  ctype: string;
  dir: string;
}

export interface ArtifactFunc {
  id: string;
  name: string;
  ret: string;
  params: ArtifactParam[];
  path: string;
  alias?: string;
  note?: string;
  tags: string[];
  reads: string[];
  writes: string[];
  calls: string[];
  exclude: boolean;
  external: boolean;
  address?: string;
}

export interface ArtifactEdge {
  src: string;
  dst: string;
  kind: "read" | "write" | "call";
  inferred: boolean;
}

export interface ArtifactModule {
  id: string;
  name: string;
  path: string;
  kind: "assembly" | "namespace" | "type" | "file" | "cu" | "archive";
  children: string[];
  root: boolean;
  exclude: boolean;
  counts: { signals: number; funcs: number; types: number };
}

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  subject?: string;
}

export interface ArtifactModel {
  info: ArtifactInfo;
  modules: ArtifactModule[];
  types: ArtifactType[];
  signals: ArtifactSignal[];
  funcs: ArtifactFunc[];
  edges: ArtifactEdge[];
  diagnostics: Diagnostic[];
}
