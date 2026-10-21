/**
 * 编译产物模型（`ArtifactModel`）。
 *
 * 为什么单独一份模型、不复用源码 IR：
 * 源码 IR（`../model.ts` 的 `Model`）的每个字段都由源码文本直接决定，三实现必须字节一致；
 * 产物模型的字段来自二进制里的元数据表 / 自定义段，是**另一条输入链路**。
 * 把它塞进 IR 会让 `.drawio` 的金标准随二进制解析细节漂移。
 * 因此这里只定义结构与稳定 id 规则，读取器（`pe.ts` / `elf.ts` / `ar.ts`）各自产出它。
 *
 * 这份结构在读取完成后是**只读快照**：消费者按值使用，不再回写。
 *
 * 稳定 id 规则（design §4.1，读取器必须遵守）：
 * - C#：`<assembly-stem>::<namespace>.<type>`（类型）、`...::<type>.<method>`（函数）、
 *   `...::<type>#<field>`（字段信号）；重载方法追加参数类型串。
 * - C：`<file-stem>::<symbol>`；静态符号重名时追加所属编译单元。
 * - 跨程序集引用：`external:<assembly>::<full-name>`，只展示、不展开。
 * id **不得含地址或随机数**，否则同一产物两次解析会得到不同 JSON。
 */

/** 读取器识别出的容器格式。`unknown` 用于无法识别 magic bytes 的输入。 */
export type ArtifactFormat = "pe-cli" | "pe-native" | "elf" | "ar" | "unknown";

/** 产物形态。注意 `.dll` 也可能是不带 CLI 头的 native DLL。 */
export type ArtifactKind = "dll" | "so" | "exe" | "object" | "archive" | "unknown";

/**
 * 信号方向。
 *
 * 注意 C# 模板里 `In` 的注释是 "Produced by the module"、`Out` 是
 * "Consumed by the module"，与直觉相反。读取器**按枚举名原样映射**（`In` -> `"in"`），
 * 不在这一层替用户纠正语义 —— 纠正会把图里的箭头方向整个翻过来。
 */
export type SignalDirection = "in" | "out" | "inout" | "";

export type TypeKind = "class" | "struct" | "record" | "enum" | "interface";

/** `archive` 是 `.a` 这层容器；成员各自是一个 `file` 模块。 */
export type ModuleKind = "assembly" | "namespace" | "type" | "file" | "cu" | "archive";

export type DiagnosticSeverity = "error" | "warning" | "info";

/**
 * 诊断码。分三类：
 * - 格式/结构问题：`unknown-format`、`truncated-section`、`unsupported-arch`、`unsupported-native-pe`
 * - 元数据问题：`no-metadata`、`missing-metadata-section`、`version-mismatch`、`trimmed-metadata`
 * - 语义完整性问题：`dangling-read`、`dangling-write`、`gc-sections-risk`
 * - 工具链问题：`tool-unavailable`（PE 解析依赖的 .NET sidecar 不在或跑不起来）
 */
export type DiagnosticCode =
  | "unknown-format"
  | "tool-unavailable"
  | "unsupported-native-pe"
  | "no-metadata"
  | "missing-metadata-section"
  | "version-mismatch"
  | "dangling-read"
  | "dangling-write"
  | "truncated-section"
  | "unsupported-arch"
  | "trimmed-metadata"
  | "gc-sections-risk"
  | "inferred-edges";

export interface ArtifactInfo {
  /**
   * 产物文件名（basename），**不是绝对路径**。
   * 规范 JSON 要能入库比字节，绝对路径会让同一产物在两台机器上产生不同输出。
   */
  path: string;
  format: ArtifactFormat;
  arch: string; // "x64" | "x86" | "arm64" | ...，未知时为空串
  kind: ArtifactKind;
  hasMetadata: boolean; // 是否找到 drawcode 元数据
  metadataVersion: number; // 0 = 无
  entryPoint?: string;
  /**
   * 以下字段都是**可选的展示信息**，不参与任何 id 或边推导。
   *
   * 为什么不全放进一个 `details` 映射：查看器需要按语义给它们排顺序、做单位换算
   * （例如 `fileSize` 要走字节格式化），键值对会让每个渲染点重新猜类型。
   * 缺失时序列化器直接省略，旧产物与旧读取器的 JSON 形状不变。
   */
  version?: string; // PE 程序集版本；C 产物没有这个概念
  fileVersion?: string; // AssemblyFileVersion
  productVersion?: string; // AssemblyInformationalVersion
  culture?: string;
  targetFramework?: string;
  buildId?: string; // ELF `.note.gnu.build-id`
  fileSize?: number; // 字节数
}

export interface TypeField {
  name: string;
  ctype: string;
  /** `ctype` 是自定义类型时指向 `ArtifactType.id`，供 ICD 递归下钻；基本类型为 undefined。 */
  typeId?: string;
  /** 字节偏移。0 = 未知：PE 元数据不含布局信息，只有 ELF 读取器能给出实际值。 */
  offset: number;
  /** 字节大小。0 = 未知（同上）；正常字段不会真的零字节。 */
  size: number;
  /** 源码里的初值（C 的 `init:` 标签 / C# 的 `Initial` 特性）；未知时缺省。 */
  initial?: string;
  tags: string[];
}

export interface ArtifactType {
  id: string; // 稳定 id，见文件头注释
  name: string;
  kind: TypeKind;
  path: string; // 树路径：`Namespace/Type` 或 `file/struct`
  alias?: string;
  note?: string;
  tags: string[];
  store: boolean; // 持久化数据 -> ER 视图
  exclude: boolean; // 元数据标了排除：树中默认隐藏
  fields: TypeField[];
  size: number; // 0 = 未知
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
  path: string; // 模块/子模块
  ownerType?: string; // 字段信号所属类型的 id
  fieldOffset?: number;
  /** 源码声明的初值；C 用 `init:` 标签，C# 用 `[Drawcode(Initial = "...")]`。 */
  initial?: string;
  exclude: boolean;
  external: boolean; // 跨程序集 / 未定义符号
  inferred: boolean; // 语义来自 IL / 重定位推断，而非显式元数据
  address?: string; // "0x..."，可缺；仅供展示，不参与 id
}

export interface ArtifactParam {
  name: string;
  ctype: string;
  dir: string;
  /** `unit=...`：物理单位；PE 参数没有该信息，缺省。 */
  unit?: string;
  /** `alias=...`：显示别名；PE 参数没有该信息，缺省。 */
  alias?: string;
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
  /** 元素是 `ArtifactSignal.id`。与 `ArtifactEdge` 的 read/write 边同源，读取器只维护一处。 */
  reads: string[];
  writes: string[];
  /** 元素是 `ArtifactFunc.id`。 */
  calls: string[];
  exclude: boolean;
  external: boolean;
  address?: string;
}

export interface ArtifactEdge {
  src: string; // func id
  dst: string; // signal id（read/write）或 func id（call）
  kind: "read" | "write" | "call";
  inferred: boolean;
}

export interface ArtifactModule {
  id: string;
  name: string;
  path: string;
  kind: ModuleKind;
  /** 子模块 id。树按此懒加载：未展开的节点不需要请求其子节点。 */
  children: string[];
  /** 元数据标了根：树默认只列根模块，可切换全量。 */
  root: boolean;
  /** 元数据标了排除：树中默认隐藏。 */
  exclude: boolean;
  /** 以该模块为根的**子树**计数（含自身），用于概览与 `> 2000` 节点时的模块级聚合。 */
  counts: { signals: number; funcs: number; types: number };
}

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: DiagnosticCode;
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

/**
 * 空模型：读取器在「格式可识别但没有任何可读内容」时从这里起步。
 *
 * `format` 默认 `unknown`、`kind` 默认 `unknown`，调用方按需覆盖。
 * 返回新对象，调用方可以安全展开（`{ ...empty, info: ... }`）而不影响别人。
 */
export function emptyArtifactModel(
  path: string,
  format: ArtifactFormat = "unknown",
  kind: ArtifactKind = "unknown",
  arch = "",
): ArtifactModel {
  return {
    info: {
      path,
      format,
      arch,
      kind,
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
}
