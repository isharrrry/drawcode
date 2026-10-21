/**
 * ELF 读取器：从 `dc_meta_entries` 段直接切片，不解析符号表、不执行代码。
 *
 * 设计取舍（design §6）：
 *  - 支持 ELF32 / ELF64 小端。32 位产物常见于 ARM（Cortex-A/R/M 的 Linux 用户态），
 *    其节头、符号、重定位的字段宽度与 ELF64 不同，必须按 `EI_CLASS` 分支读取；
 *    大端仍然明确报 `unsupported-arch`，而不是猜着读错。
 *  - 记录是模板定义的 200 字节定长 POD（见 `templates/c/DrawcodeMeta.h`），
 *    字段偏移是硬契约；`_Static_assert` 在编译期守住它，这里在读取期再守一次。
 *  - 字符串是内联定长数组，**不是指针**。所以 `.o` 未链接时也能直接读出名字，
 *    不需要 `.rela`、不需要重定位、不会被 strip 影响。
 *
 * 为什么不做「从机器码推断读写」：优化会把读写重排/合并，推断出的边既不可靠
 * 又依赖构建选项。第一版只认显式 `DC_READ/DC_WRITE`；缺失就用诊断说出来，
 * 而不是猜一个看起来合理的图。
 */

import { ByteView } from "./byteview.ts";
import { DiagnosticBag, DIAG } from "./diagnostics.ts";
import {
  type ArtifactEdge,
  type ArtifactFunc,
  type ArtifactKind,
  type ArtifactModel,
  type ArtifactModule,
  type ArtifactSignal,
  type ArtifactType,
  type SignalDirection,
  type TypeField,
  type TypeKind,
} from "./model.ts";

/** 与 `templates/c/DrawcodeMeta.h` 的 `DC_META_ENTRY_SIZE` 必须一致。 */
export const DC_RECORD_SIZE = 200;
const DC_META_VERSION = 1;

const EI_CLASS_32 = 1;
const EI_CLASS_64 = 2;
const EI_DATA_LSB = 1;

const ET_REL = 1;
const ET_EXEC = 2;
const ET_DYN = 3;

const SHT_SYMTAB = 2;
const SHT_RELA = 4;
/** ARM / 32 位 x86 的链接器默认产出 SHT_REL（加数写在被重定位的位置里）。 */
const SHT_REL = 9;
/** strip 过的 `.so` 常常只剩 `.dynsym`；它和 `.symtab` 的条目布局相同。 */
const SHT_DYNSYM = 11;
const SHF_EXECINSTR = 0x4;
const STT_OBJECT = 1;
const STT_FUNC = 2;

/**
 * 定长条目大小。ELF32 与 ELF64 的字段宽度不同，不能复用同一组常量：
 *   Elf32_Sym  16 字节，Elf32_Rel 8 字节，Elf32_Rela 12 字节；
 *   Elf64_Sym  24 字节，Elf64_Rel 16 字节，Elf64_Rela 24 字节。
 * 实际条目大小以节头 `sh_entsize` 为准，这里只是缺省值（有些产物写 0）。
 */
const SYM_SIZE_32 = 16;
const SYM_SIZE_64 = 24;
const REL_SIZE_32 = 8;
const RELA_SIZE_32 = 12;
const REL_SIZE_64 = 16;
const RELA_SIZE_64 = 24;

const ELF_HEADER_SIZE_32 = 52;
const ELF_HEADER_SIZE_64 = 64;

const MACHINES: Record<number, string> = {
  3: "x86",
  8: "mips",
  20: "ppc",
  21: "ppc64",
  40: "arm",
  62: "x64",
  183: "arm64",
  243: "riscv64",
};

interface ElfSection {
  /** section header 下标；重定位节用 `info` 指向它作用的节，需要按这个下标比较。 */
  index: number;
  name: string;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  /** SHT_SYMTAB 的链接字段指向字符串表；SHT_RELA 的链接字段指向符号表。 */
  link: number;
  /** SHT_RELA 的作用目标节；其余节为 0。 */
  info: number;
  entsize: number;
}

interface RawRecord {
  name: string;
  tag: string;
  kind: string;
  owner: string;
  type: string;
  size: number;
  offset: number;
  /** 声明序号（`__COUNTER__`）。段内顺序在 GCC/Clang 下是反的，靠它恢复。 */
  order: number;
}

/** 会产出模型实体的记录类型；只有 anchor/module 的产物不建空模块。 */
const CONTENT_KINDS = new Set(["signal", "field", "function", "read", "write", "call"]);

export interface ElfReadOptions {
  /** 稳定 id 的前缀。默认取文件名去扩展名；ar 成员传 `archive/member`。 */
  idPrefix?: string;
  /**
   * 是否用 `.symtab` + `.rela.*` 补全声明层缺失的读写边（P4）。
   *
   * 重定位只能证明「这段代码引用了这个符号」，分不清读还是写：因此推断边一律记为
   * `read`、`inferred: true`，并追加一条 `inferred-edges` 诊断。显式 `DC_READ/DC_WRITE`
   * 始终优先；同一对函数/信号已有显式边时不会再造一条推断边。
   */
  inferEdges?: boolean;
}

/**
 * 解析 ELF 字节。不抛格式异常：所有问题都变成模型里的诊断。
 *
 * `name` 是展示名（通常是 basename），同时用于默认 id 前缀；
 * ar 成员传入成员名，避免三个 `app.o` 产出同一批 id。
 */
export function readElf(bytes: Uint8Array, name: string, options: ElfReadOptions = {}): ArtifactModel {
  const view = new ByteView(bytes);
  const arch = archOfElf(view);
  const kind = kindOfElf(view);
  const stem = options.idPrefix ?? stripExtension(name);
  const bag = new DiagnosticBag();
  const empty = (overrides: Partial<ArtifactModel["info"]> = {}): ArtifactModel => ({
    info: {
      path: name,
      format: "elf",
      arch,
      kind,
      hasMetadata: false,
      metadataVersion: 0,
      fileSize: view.length,
      ...overrides,
    },
    modules: [],
    types: [],
    signals: [],
    funcs: [],
    edges: [],
    diagnostics: bag.items,
  });

  if (!hasElfMagic(view)) {
    bag.error(DIAG.unknownFormat, "不是 ELF 文件", name);
    return empty();
  }

  // e_ident[EI_CLASS] / e_ident[EI_DATA]：先确认读法，再读任何多字节字段。
  // ELF32 的头是 52 字节、ELF64 是 64 字节；用 class 决定最小长度，
  // 否则一个合法的 ELF32 文件会被误判成截断。
  const eiClass = view.u8(4);
  const headerSize = eiClass === EI_CLASS_32 ? ELF_HEADER_SIZE_32 : ELF_HEADER_SIZE_64;
  if (
    view.length < headerSize ||
    (eiClass !== EI_CLASS_32 && eiClass !== EI_CLASS_64) ||
    view.u8(5) !== EI_DATA_LSB
  ) {
    bag.error(DIAG.unsupportedArch, "仅支持 ELF32 / ELF64 小端程序集", name);
    return empty();
  }

  const machine = view.u16(18);
  if (!(machine in MACHINES)) {
    bag.warn(DIAG.unsupportedArch, `未识别的 ELF machine=0x${machine.toString(16)}`, name);
  }

  let sections: ElfSection[];
  try {
    sections = readSections(view);
  } catch (error) {
    bag.error(DIAG.truncatedSection, messageOf(error), name);
    return empty();
  }

  const meta = sections.find((s) => s.name === "dc_meta_entries");
  if (meta === undefined || meta.size === 0) {
    // 没有 drawcode 元数据不代表文件不可读：符号表仍然给出函数与全局变量。
    // 这里走一条独立的回退路径，不把符号硬塞进元数据记录模型，
    // 避免“有元数据”和“只能看符号”两种语义混在同一个 buildModel 里。
    let symbols: ElfSymbol[] = [];
    try {
      symbols = readSymbols(view, sections) ?? [];
    } catch (error) {
      bag.warn(DIAG.truncatedSection, `符号表读取失败：${messageOf(error)}`, name);
    }
    return buildSymbolFallback(view, sections, symbols, stem, name, kind, arch, bag);
  }

  if (meta.size % DC_RECORD_SIZE !== 0) {
    bag.warn(
      DIAG.truncatedSection,
      `dc_meta_entries 段长 ${meta.size} 不是 ${DC_RECORD_SIZE} 的整数倍；尾部不完整记录已忽略`,
      name,
    );
  }

  let raw: RawRecord[];
  try {
    raw = readRecords(view, meta);
  } catch (error) {
    bag.error(DIAG.truncatedSection, messageOf(error), name);
    return empty();
  }

  if (raw.length === 0) {
    bag.warn(DIAG.noMetadata, "dc_meta_entries 段存在但没有任何记录", name);
    return empty({ hasMetadata: true });
  }

  // anchor 只在链接了 DrawcodeMeta.c 的产物里出现；.o 没有它，版本按「未知」处理。
  const anchor = raw.find((r) => r.kind === "anchor");
  const version = anchor === undefined ? 0 : Number.parseInt(anchor.tag, 10);
  if (anchor !== undefined && version !== DC_META_VERSION) {
    bag.error(
      DIAG.versionMismatch,
      `元数据版本 ${anchor.tag || "?"} 不受支持（读取器支持 ${DC_META_VERSION}）；请更新模板或读取器`,
      name,
    );
    return empty({ hasMetadata: true, metadataVersion: Number.isFinite(version) ? version : 0 });
  }

  if (!raw.some((r) => CONTENT_KINDS.has(r.kind))) {
    // 只链接了 DrawcodeMeta.c 的 meta.o 就是这种形态：它只贡献 anchor 与预算符号，
    // 不该在树里多出一个 0 计数的模块。归档层仍能从 info 里取到版本。
    return empty({ hasMetadata: true, metadataVersion: Number.isFinite(version) ? version : 0 });
  }

  // GCC/Clang 逆序追加段内对象；按声明序号排序恢复源码顺序。
  // 旧产物 order 全为 0，稳定排序保持原段序，不会引入新的不确定性。
  raw = [...raw].sort((a, b) => a.order - b.order);

  const moduleName =
    firstNonEmpty(anchor?.owner, raw.find((r) => r.kind === "signal")?.owner) || stem;
  const model = buildModel(raw, stem, moduleName, name, kind, arch, version, bag);
  model.info.fileSize = view.length;
  model.info.buildId = readBuildId(view, sections);

  if (options.inferEdges === true) {
    const symbols = readSymbols(view, sections);
    if (symbols === undefined) {
      // strip --strip-all 会删除 .symtab；声明层仍在，只是推断退路自动关闭。
      bag.info(
        DIAG.inferredEdges,
        ".symtab 不存在（可能被 strip 删除），推断边已关闭；声明层不受影响",
        name,
      );
    } else {
      const explicit = new Set(model.edges.map((e) => `${e.src}|${e.dst}`));
      const inferred = inferReadEdges(view, sections, symbols, model.funcs, model.signals, explicit, bag);
      model.edges.push(...inferred);
    }
    // buildModel 已经把当时的 bag 快照写进模型；推断阶段新增的诊断要重新取一次。
    model.diagnostics = bag.items;
  }
  return model;
}

function stripExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.[^.]*$/, "");
}

/**
 * 读 `.note.gnu.build-id` 的十六进制串。
 *
 * 这是链接时 `-Wl,--build-id` 生成的摘要，用来把产物对应回构建记录；
 * 没有该节（例如嵌入式老工具链）就返回 undefined，不合成假值。
 * note 布局：namesz/descsz/type 三个 u32，随后是 4 字节对齐的 name 与 desc。
 */
function readBuildId(view: ByteView, sections: ElfSection[]): string | undefined {
  const section = sections.find((s) => s.name === ".note.gnu.build-id");
  if (section === undefined || section.offset + 12 > view.length) return undefined;

  const namesz = view.u32(section.offset);
  const descsz = view.u32(section.offset + 4);
  const type = view.u32(section.offset + 8);
  if (type !== 3 || namesz === 0 || descsz === 0) return undefined;

  const descStart = section.offset + 12 + ((namesz + 3) & ~3);
  if (descStart + descsz > view.length) return undefined;

  let hex = "";
  for (let i = 0; i < descsz; i++) hex += view.u8(descStart + i).toString(16).padStart(2, "0");
  return hex.length > 0 ? hex : undefined;
}

function hasElfMagic(view: ByteView): boolean {
  return (
    view.length >= 4 &&
    view.u8(0) === 0x7f &&
    view.u8(1) === 0x45 &&
    view.u8(2) === 0x4c &&
    view.u8(3) === 0x46
  );
}

/**
 * 是否为 32 位 ELF。
 *
 * 只在 `readElf` 已确认 magic 与 `EI_CLASS` 合法后调用；其他读取函数
 * （节头/符号/重定位）共用它来选字段布局，避免每个函数各写一份判断。
 */
function isElf32(view: ByteView): boolean {
  return view.u8(4) === EI_CLASS_32;
}

function kindOfElf(view: ByteView): ArtifactKind {
  if (!hasElfMagic(view) || view.length < 20) return "unknown";
  const type = view.u16(16);
  if (type === ET_REL) return "object";
  if (type === ET_EXEC) return "exe";
  if (type === ET_DYN) {
    // PIE 可执行文件与共享库都是 ET_DYN，单看 e_type 分不开。
    // 链接器会给可执行文件写入口地址（e_entry 非 0），而 `-shared` 产出的
    // 共享库通常保持 0。据此把 linux 可执行文件显示成 exe 而不是 so。
    // 这是启发式判断：少数带入口的插件式 .so 会被误判，但展开展示的收益更大。
    const entry = isElf32(view) ? view.u32(24) : Number(view.u64(24));
    return entry !== 0 ? "exe" : "so";
  }
  return "unknown";
}

function archOfElf(view: ByteView): string {
  if (!hasElfMagic(view) || view.length < 20) return "";
  return MACHINES[view.u16(18)] ?? "";
}

/**
 * 读 section header table 与 `.shstrtab`。
 *
 * 所有偏移都走 ByteView 的越界检查：格式坏掉时抛 `RangeError`，
 * 由 `readElf` 统一转成 `truncated-section`。
 */
function readSections(view: ByteView): ElfSection[] {
  const elf32 = isElf32(view);
  // e_shoff / e_shentsize / e_shnum / e_shstrndx 在两种 class 下的偏移不同：
  //   ELF32 头总长 52：e_shoff(32) e_shentsize(46) e_shnum(48) e_shstrndx(50)
  //   ELF64 头总长 64：e_shoff(40) e_shentsize(58) e_shnum(60) e_shstrndx(62)
  const shoff = elf32 ? view.u32(32) : Number(view.u64(40));
  const shentsize = view.u16(elf32 ? 46 : 58);
  const shnum = view.u16(elf32 ? 48 : 60);
  const shstrndx = view.u16(elf32 ? 50 : 62);
  const minEntry = elf32 ? 40 : 64;

  if (shoff === 0 || shnum === 0 || shentsize < minEntry) {
    throw new RangeError(`没有可用的 section header table（shoff=${shoff} shnum=${shnum}）`);
  }

  const raw: Omit<ElfSection, "name">[] = [];
  for (let i = 0; i < shnum; i++) {
    const at = shoff + i * shentsize;
    // Elf32_Shdr：name0 type4 flags8 addr12 offset16 size20 link24 info28 entsize36
    // Elf64_Shdr：name0 type4 flags8 addr16 offset24 size32 link40 info44 entsize56
    raw.push({
      index: i,
      type: view.u32(at + 4),
      // 0x8 = SHF_EXECINSTR；重定位归属到函数时需要判断目标节是否可执行。
      flags: elf32 ? view.u32(at + 8) : Number(view.u64(at + 8)),
      addr: elf32 ? view.u32(at + 12) : Number(view.u64(at + 16)),
      offset: elf32 ? view.u32(at + 16) : Number(view.u64(at + 24)),
      size: elf32 ? view.u32(at + 20) : Number(view.u64(at + 32)),
      link: view.u32(at + (elf32 ? 24 : 40)),
      info: view.u32(at + (elf32 ? 28 : 44)),
      entsize: elf32 ? view.u32(at + 36) : Number(view.u64(at + 56)),
    });
  }

  const shstr = raw[shstrndx];
  if (shstr === undefined) throw new RangeError(`e_shstrndx=${shstrndx} 越界`);

  return raw.map((s) => ({
    ...s,
    name: cStringAt(view, shstr.offset + view.u32(shoff + s.index * shentsize), shstr.offset + shstr.size),
  }));
}

/**
 * 按 200 字节切片并解码定长字段。
 *
 * 只读 `floor(size / 200)` 条：尾部残缺记录不进入模型（调用方已警告），
 * 避免最后一条把名字读成半个字符串。
 */
function readRecords(view: ByteView, section: ElfSection): RawRecord[] {
  const count = Math.floor(section.size / DC_RECORD_SIZE);
  const out: RawRecord[] = [];
  for (let i = 0; i < count; i++) {
    const at = section.offset + i * DC_RECORD_SIZE;
    out.push({
      name: fixedString(view, at, 48),
      tag: fixedString(view, at + 48, 48),
      kind: fixedString(view, at + 96, 16),
      owner: fixedString(view, at + 112, 32),
      type: fixedString(view, at + 144, 40),
      size: view.u32(at + 184),
      offset: view.u32(at + 188),
      order: safeOrder(view.u64(at + 192)),
    });
  }
  return out;
}

/** order 是编译期计数器；超出安全整数视作 0（旧产物 / 脏数据），排序退回段序。 */
function safeOrder(value: bigint): number {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0;
}

// ── P4：符号表 + 重定位推断 ─────────────────────────────────────────────

interface ElfSymbol {
  name: string;
  /** ELF64_ST_TYPE(st_info)：1 = OBJECT，2 = FUNC。 */
  type: number;
  /** ELF64_ST_BIND(st_info)：0 = LOCAL，1 = GLOBAL，2 = WEAK。 */
  bind: number;
  /** 定义所在的 section 下标；SHN_UNDEF(0) 表示未定义。 */
  shndx: number;
  value: number;
  size: number;
}

interface SymbolRange {
  func: ArtifactFunc;
  shndx: number;
  start: number;
  end: number;
}

/**
 * 读 `.symtab`；它缺失或被 strip 时退回 `.dynsym`。
 *
 * 动态符号表不覆盖局部静态函数，但能让 strip 过的 `.so` 仍然显示导出函数与
 * 全局变量。两者条目布局一致，区别只在 `sh_link` 指向 `.strtab` 还是 `.dynstr`。
 *
 * 两种 class 的 `Elf_Sym` 字段顺序不同，必须分开读：
 *   Elf32_Sym (16B)：st_name(4) st_value(4) st_size(4) st_info(1) st_other(1) st_shndx(2)
 *   Elf64_Sym (24B)：st_name(4) st_info(1) st_other(1) st_shndx(2) st_value(8) st_size(8)
 * 符号名在 `sh_link` 指向的字符串表里，按 NUL 截断。
 */
function readSymbols(view: ByteView, sections: ElfSection[]): ElfSymbol[] | undefined {
  const symtab =
    sections.find((s) => s.type === SHT_SYMTAB && s.size > 0) ??
    sections.find((s) => s.type === SHT_DYNSYM && s.size > 0);
  if (symtab === undefined) return undefined;
  const strtab = sections[symtab.link];
  if (strtab === undefined) return undefined;

  const elf32 = isElf32(view);
  const fallbackSize = elf32 ? SYM_SIZE_32 : SYM_SIZE_64;
  const entrySize = symtab.entsize >= fallbackSize ? symtab.entsize : fallbackSize;
  const count = Math.floor(symtab.size / entrySize);
  const out: ElfSymbol[] = [];
  for (let i = 0; i < count; i++) {
    const at = symtab.offset + i * entrySize;
    const nameAt = view.u32(at);
    const info = view.u8(at + (elf32 ? 12 : 4));
    out.push({
      name: cStringAt(view, strtab.offset + nameAt, strtab.offset + strtab.size),
      type: info & 0x0f,
      bind: info >>> 4,
      shndx: view.u16(at + (elf32 ? 14 : 6)),
      value: elf32 ? view.u32(at + 4) : Number(view.u64(at + 8)),
      size: elf32 ? view.u32(at + 8) : Number(view.u64(at + 16)),
    });
  }
  return out;
}

/**
 * 用重定位补「函数 → 信号」边。
 *
 * 归因规则：
 * - ET_REL（`.o`/`.a` 成员）：函数符号与重定位位置都用「节内偏移」，
 *   必须落在同一个 section（`shndx`）且位于 `[st_value, st_value+st_size)`。
 * - ET_EXEC / ET_DYN：函数符号与 `r_offset` 都是虚拟地址，直接比较；
 *   这里不能再加 `sh_addr`，否则会得到两倍偏移。
 *
 * 方向只记为 `read`：一条 `mov %eax, g_x(%rip)` 与一条 `mov g_x(%rip), %eax`
 * 产生的重定位类型可能相同，二进制层面无法可靠区分读写。与其猜错方向，
 * 不如把「这里访问过」这件事标成推断边，让用户回源码补 `DC_WRITE`。
 */
function inferReadEdges(
  view: ByteView,
  sections: ElfSection[],
  symbols: ElfSymbol[],
  funcs: Iterable<ArtifactFunc>,
  signals: Iterable<ArtifactSignal>,
  explicitPairs: Set<string>,
  bag: DiagnosticBag,
): ArtifactEdge[] {
  const isRelocatable = view.u16(16) === ET_REL;

  const funcsByName = new Map<string, ArtifactFunc[]>();
  for (const f of funcs) {
    const list = funcsByName.get(f.name);
    if (list === undefined) funcsByName.set(f.name, [f]);
    else list.push(f);
  }

  // 同名静态函数可能在不同编译单元各有一份；保留全部区间，按重定位位置唯一命中。
  const ranges: SymbolRange[] = [];
  for (const sym of symbols) {
    if (sym.type !== STT_FUNC || sym.shndx === 0 || sym.size === 0) continue;
    const targets = funcsByName.get(sym.name);
    if (targets === undefined) continue;
    for (const func of targets) {
      ranges.push({ func, shndx: sym.shndx, start: sym.value, end: sym.value + sym.size });
    }
  }

  const signalByName = new Map<string, ArtifactSignal>();
  for (const s of signals) {
    if (!signalByName.has(s.name)) signalByName.set(s.name, s);
  }

  const funcOfLocation = (shndx: number, offset: number, va: number): ArtifactFunc | null => {
    let found: ArtifactFunc | null = null;
    for (const r of ranges) {
      const hit = isRelocatable
        ? r.shndx === shndx && offset >= r.start && offset < r.end
        : va >= r.start && va < r.end;
      if (!hit) continue;
      // 两个同名函数区间同时命中说明归因有歧义；宁可不推断，也不连错边。
      if (found !== null && found.id !== r.func.id) return null;
      found = r.func;
    }
    return found;
  };

  const seen = new Set<string>();
  const edges: ArtifactEdge[] = [];
  let sawExecutableReloc = false;
  const elf32 = isElf32(view);

  for (const section of sections) {
    // 重定位表有两种编码：SHT_RELA 带显式 addend（x86-64/AArch64 常用），
    // SHT_REL 的 addend 藏在被改写的指令字里（ARM 32 位常用）。
    // 这里只关心 r_offset 与符号下标，两者在两种编码中位置一致，所以一并处理。
    if (section.type !== SHT_RELA && section.type !== SHT_REL) continue;
    const target = sections[section.info];
    // 只看可执行节上的重定位；`.rela.data` / `.rel.data` 是数据指针，不代表代码访问。
    if (target === undefined || (target.flags & SHF_EXECINSTR) === 0) continue;
    sawExecutableReloc = true;

    const isRela = section.type === SHT_RELA;
    const fallbackSize = elf32
      ? isRela
        ? RELA_SIZE_32
        : REL_SIZE_32
      : isRela
        ? RELA_SIZE_64
        : REL_SIZE_64;
    const entrySize = section.entsize >= fallbackSize ? section.entsize : fallbackSize;
    const count = Math.floor(section.size / entrySize);
    for (let i = 0; i < count; i++) {
      const at = section.offset + i * entrySize;
      // Elf32_Rel：r_offset(4) r_info(4)，符号下标 = r_info >> 8
      // Elf32_Rela：在上面的基础上多 4 字节 addend，r_offset/r_info 位置不变
      // Elf64_Rel：r_offset(8) r_info(8)，符号下标 = r_info >> 32
      // Elf64_Rela：同上再加 8 字节 addend
      const rOffset = elf32 ? view.u32(at) : Number(view.u64(at));
      const symbolIndex = elf32
        ? view.u32(at + 4) >>> 8
        : Number(view.u64(at + 8) >> 32n);
      const sym = symbols[symbolIndex];
      if (sym === undefined) continue;

      const signal = signalByName.get(sym.name);
      if (signal === undefined) continue;

      // ET_REL 的 r_offset 是节内偏移，ET_EXEC/ET_DYN 的 r_offset 已经是虚拟地址。
      const func = funcOfLocation(target.index, rOffset, rOffset);
      if (func === null) continue;

      // 显式边优先：已有 DC_READ/DC_WRITE 就不再造一条同对的推断边。
      if (explicitPairs.has(`${func.id}|${signal.id}`)) continue;
      const key = `${func.id}|${signal.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      func.reads.push(signal.id);
      edges.push({ src: func.id, dst: signal.id, kind: "read", inferred: true });
    }
  }

  if (!sawExecutableReloc) {
    bag.info(
      DIAG.inferredEdges,
      "没有可执行节上的 .rela/.rel（链接时可能未加 --emit-relocs），推断边已关闭",
      undefined,
    );
  } else if (edges.length > 0) {
    bag.info(
      DIAG.inferredEdges,
      `用 .symtab/.rela 推断了 ${edges.length} 条访问边。二进制无法区分读写，均记为 read；` +
        "建议在源码补 DC_READ / DC_WRITE 宏",
      undefined,
    );
  }
  return edges;
}

/** 读取定长 char 数组；未填满的部分是 NUL，不能越过字段边界。 */
function fixedString(view: ByteView, start: number, size: number): string {
  return cStringAt(view, start, start + size);
}

/** 从 `start` 读到 NUL 或 `end`，UTF-8 解码。坏字节用替换符，不让整份产物失败。 */
function cStringAt(view: ByteView, start: number, end: number): string {
  let at = start;
  while (at < end && at < view.length && view.u8(at) !== 0) at++;
  return new TextDecoder("utf-8", { fatal: false }).decode(view.slice(start, at - start));
}

/**
 * 逗号标签：保留值 `root`/`exclude`/`store` 被消费，`key=value` 形式的
 * `alias`/`unit`/`note`/`init`/`direction`/`path` 也被消费成结构化字段，
 * 其余去空白后作为业务标签。
 *
 * 为什么复用 tag 而不是扩记录结构：200 字节定长布局是跨版本契约，改它会迫使
 * 所有旧产物升级；而这些属性本来只是短文本，塞进已有的 48 字节 tag 足够，
 * 旧读取器最坏把它们当普通标签显示，不会读错偏移。
 */
function parseTags(tag: string): {
  tags: string[];
  root: boolean;
  exclude: boolean;
  store: boolean;
  alias: string;
  unit: string;
  note: string;
  initial: string;
  kind: string;
  size: number;
  dir: SignalDirection;
  path: string;
} {
  const tags: string[] = [];
  let root = false;
  let exclude = false;
  let store = false;
  let alias = "";
  let unit = "";
  let note = "";
  let initial = "";
  let kind = "";
  let size = 0;
  let dir: SignalDirection = "";
  let path = "";
  for (const token of tag.split(",")) {
    const t = token.trim();
    if (t.length === 0) continue;
    if (t === "root") root = true;
    else if (t === "exclude") exclude = true;
    else if (t === "store") store = true;
    else {
      const kv = /^(alias|unit|note|init|initial|kind|size|direction|dir|path)[:=](.*)$/.exec(t);
      if (kv === null) {
        tags.push(t);
        continue;
      }
      const value = (kv[2] as string).trim();
      if (kv[1] === "alias") alias = value;
      else if (kv[1] === "unit") unit = value;
      else if (kv[1] === "note") note = value;
      else if (kv[1] === "init" || kv[1] === "initial") initial = value;
      else if (kv[1] === "kind") kind = value;
      else if (kv[1] === "direction" || kv[1] === "dir") dir = normalizeDirection(value);
      else if (kv[1] === "path") path = value;
      else {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed >= 0) size = parsed;
      }
    }
  }
  return { tags, root, exclude, store, alias, unit, note, initial, kind, size, dir, path };
}

/**
 * 方向写法收敛成模型的三值 + 空。
 *
 * C 模板面向手写，`in`/`input`/`read` 都可能出现；读取器只认规范值，
 * 其余（拼错、留空）一律按「未知」处理 —— 猜一个方向比空着更糟，
 * 因为它会让错误的数据流看起来可信。
 */
function normalizeDirection(value: string): SignalDirection {
  switch (value.toLowerCase()) {
    case "in":
    case "input":
    case "read":
      return "in";
    case "out":
    case "output":
    case "write":
      return "out";
    case "inout":
    case "io":
    case "both":
      return "inout";
    default:
      return "";
  }
}

function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const v of values) if (v !== undefined && v.length > 0) return v;
  return "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 标签里的 kind 是自由文本；只接受模型定义的五个值，其余按 C 的 struct 处理。 */
function normalizeTypeKind(kind: string): TypeKind {
  switch (kind.trim().toLowerCase()) {
    case "class":
      return "class";
    case "record":
      return "record";
    case "enum":
      return "enum";
    case "interface":
      return "interface";
    default:
      return "struct";
  }
}

/**
 * 记录 → 模型。
 *
 * id 规则（与 `docs/artifact-format.md` 一致）：
 *   模块 `<prefix>::<module>`；类型 `<prefix>::<module>.<type>`；
 *   信号/函数 `<prefix>::<module>.<name>`；外部占位 `external:<prefix>::<module>.<name>`。
 * 名字重复时追加 `#2`、`#3`，保证同一产物两次解析得到同一 id。
 */
function buildModel(
  raw: RawRecord[],
  stem: string,
  moduleName: string,
  name: string,
  kind: ArtifactKind,
  arch: string,
  version: number,
  bag: DiagnosticBag,
): ArtifactModel {
  const moduleId = `${stem}::${moduleName}`;
  const module: ArtifactModule = {
    id: moduleId,
    name: moduleName,
    path: moduleName,
    kind: "file",
    children: [],
    root: false,
    exclude: false,
    counts: { signals: 0, funcs: 0, types: 0 },
  };

  const types = new Map<string, ArtifactType>();
  // 按 id 建索引：重复名字要能追加后缀，而查找按 name 线性扫描（模块内名字通常很少）。
  const signals = new Map<string, ArtifactSignal>();
  const funcs = new Map<string, ArtifactFunc>();
  const pending: { kind: "read" | "write" | "call"; owner: string; name: string }[] = [];
  // 参数在函数记录之后挂接：`DC_PARAM` 的 owner 只存函数名，
  // 不保证该函数记录已经出现过（源码顺序允许先写参数文档再写函数）。
  const pendingParams: {
    owner: string;
    name: string;
    ctype: string;
    dir: SignalDirection;
    index: number;
    unit: string;
    alias: string;
  }[] = [];

  const unique = (existing: Map<string, unknown>, base: string): string => {
    if (!existing.has(base)) return base;
    let n = 2;
    while (existing.has(`${base}#${n}`)) n++;
    return `${base}#${n}`;
  };

  for (const r of raw) {
    const t = parseTags(r.tag);
    const { tags, root, exclude } = t;
    switch (r.kind) {
      case "anchor":
      case "header":
        continue;

      case "module":
        if (root) module.root = true;
        if (exclude) module.exclude = true;
        continue;

      case "signal": {
        const id = unique(signals, `${stem}::${moduleName}.${r.name}`);
        signals.set(id, {
          id,
          name: r.name,
          ctype: r.type,
          // `direction=in|out|inout` 与 C# 的 Direction 属性同义；没写就是未知，
          // 不用读写边反推 —— 读 + 写同时存在时会得到 inout，掩盖漏标的信号。
          dir: t.dir,
          unit: t.unit,
          alias: t.alias,
          note: t.note,
          // 信号模型没有 store 布尔位；对全局量来说「掉电保持」本身就是读者要看的标签，
          // 因此保留在 tags 里，而不是像类型那样消费掉后无处可查。
          tags: t.store ? [...tags, "store"] : tags,
          path: t.path.length > 0 ? t.path : moduleName,
          initial: t.initial.length > 0 ? t.initial : undefined,
          exclude,
          external: false,
          inferred: false,
        });
        continue;
      }

      case "type": {
        // 显式类型记录：用于声明没有字段的信号结构、外部类型形态。
        // 字段记录仍会创建占位类型，两种记录按名字合并。
        let type = types.get(r.name);
        if (type === undefined) {
          type = {
            id: `${stem}::${moduleName}.${r.name}`,
            name: r.name,
            kind: normalizeTypeKind(t.kind),
            path: `${moduleName}/${r.name}`,
            alias: t.alias.length > 0 ? t.alias : undefined,
            note: t.note.length > 0 ? t.note : undefined,
            tags,
            store: t.store,
            exclude,
            fields: [],
            size: t.size,
          };
          types.set(r.name, type);
        } else {
          type.alias = t.alias.length > 0 ? t.alias : type.alias;
          type.note = t.note.length > 0 ? t.note : type.note;
          type.tags = [...new Set([...type.tags, ...tags])];
          type.store = type.store || t.store;
          type.kind = t.kind.length > 0 ? normalizeTypeKind(t.kind) : type.kind;
          if (t.size > 0) type.size = t.size;
        }
        continue;
      }

      case "field": {
        let type = types.get(r.owner);
        if (type === undefined) {
          type = {
            id: `${stem}::${moduleName}.${r.owner}`,
            name: r.owner,
            // C 模板没有 record/enum 信息；struct 是唯一可证的形态。
            kind: "struct",
            path: `${moduleName}/${r.owner}`,
            tags: [],
            store: false,
            exclude: false,
            fields: [],
            size: 0,
          };
          types.set(r.owner, type);
        }
        const field: TypeField = {
          name: r.name,
          ctype: r.type,
          offset: r.offset,
          size: r.size,
          initial: t.initial.length > 0 ? t.initial : undefined,
          tags,
        };
        type.fields.push(field);
        // 字段上的 store 等价于“所在类型需要持久化”，避免模板用户
        // 每加一个字段都要重复标注类型级标签。
        if (t.store) type.store = true;
        type.size = Math.max(type.size, r.offset + r.size);
        continue;
      }

      case "function": {
        const id = unique(funcs, `${stem}::${moduleName}.${r.name}`);
        funcs.set(id, {
          id,
          name: r.name,
          // `type` 列在函数记录上承载返回值（DC_FUNCTION_AS）；旧模板写空的
          // DC_FUNCTION 保持空串，视图显示为「未知」，不伪造 void。
          ret: r.type,
          params: [],
          path: t.path.length > 0 ? t.path : moduleName,
          alias: t.alias.length > 0 ? t.alias : undefined,
          note: t.note.length > 0 ? t.note : undefined,
          tags,
          reads: [],
          writes: [],
          calls: [],
          exclude,
          external: false,
        });
        continue;
      }

      case "param": {
        // 函数记录可能尚未出现（源码里 DC_PARAM 写在 DC_FUNCTION 之前也不会坏），
        // 与 read/write/call 一样延后到全部记录读完再挂接。
        pendingParams.push({
          owner: r.owner,
          name: r.name,
          ctype: r.type,
          dir: t.dir,
          index: r.offset,
          // 参数与信号共用同一套 tag 解析：unit/alias 以前解析后被丢掉，
          // 导致模板里写了 `unit=V`、视图却只显示类型和名字。这里补进模型，
          // 让参数行与信号行展示同一组属性。
          unit: t.unit,
          alias: t.alias,
        });
        continue;
      }

      case "enum_member": {
        // 枚举成员的数值由模板放在 offset 列（uint32 编码）。这里把它当「初值」，
        // 与 C# sidecar 对枚举成员的表示一致：字段名 + 初值列，而不是伪造字节偏移。
        let type = types.get(r.owner);
        if (type === undefined) {
          type = {
            id: `${stem}::${moduleName}.${r.owner}`,
            name: r.owner,
            // 只有 enum_member 记录时，形态本身已经证明它是枚举。
            kind: "enum",
            path: `${moduleName}/${r.owner}`,
            tags: [],
            store: false,
            exclude: false,
            fields: [],
            size: 0,
          };
          types.set(r.owner, type);
        }
        type.fields.push({
          name: r.name,
          ctype: r.type.length > 0 ? r.type : r.owner,
          offset: 0,
          size: 0,
          initial: String(r.offset),
          tags,
        });
        continue;
      }

      case "read":
      case "write":
      case "call":
        pending.push({ kind: r.kind, owner: r.owner, name: r.name });
        continue;

      default:
        // 未知 kind 静默跳过：模板将来新增记录类型时，旧读取器仍能浏览其余内容。
        continue;
    }
  }

  // 字段类型指向本模块内的类型，供 ICD 视图递归下钻。
  const typeIds = new Map<string, string>();
  for (const t of types.values()) typeIds.set(t.name, t.id);
  for (const t of types.values()) {
    for (const f of t.fields) {
      const target = typeIds.get(f.ctype);
      if (target !== undefined) f.typeId = target;
    }
  }
  // 信号类型同样可以指向类型（如 `DC_SIGNAL(g_state, "", "DcState")`）。
  for (const s of signals.values()) {
    const target = typeIds.get(s.ctype);
    if (target !== undefined) s.ownerType = target;
  }

  const edges: ArtifactEdge[] = [];
  const externalSignals = new Map<string, ArtifactSignal>();
  const externalFuncs = new Map<string, ArtifactFunc>();

  const signalOf = (varName: string, read: boolean): ArtifactSignal => {
    const found = [...signals.values()].find((s) => s.name === varName);
    if (found !== undefined) return found;
    const existing = externalSignals.get(varName);
    if (existing !== undefined) return existing;
    const id = `external:${moduleId}.${varName}`;
    const placeholder: ArtifactSignal = {
      id,
      name: varName,
      ctype: "",
      dir: "",
      unit: "",
      alias: "",
      note: "",
      tags: [],
      path: moduleName,
      exclude: false,
      external: true,
      inferred: false,
    };
    externalSignals.set(varName, placeholder);
    bag.warn(
      read ? DIAG.danglingRead : DIAG.danglingWrite,
      `引用了未声明的信号 ${varName}，已生成外部占位`,
      id,
    );
    return placeholder;
  };

  const funcOf = (funcName: string): ArtifactFunc => {
    const found = [...funcs.values()].find((f) => f.name === funcName);
    if (found !== undefined) return found;
    const existing = externalFuncs.get(funcName);
    if (existing !== undefined) return existing;
    const id = `external:${moduleId}.${funcName}`;
    const placeholder: ArtifactFunc = {
      id,
      name: funcName,
      ret: "",
      params: [],
      path: moduleName,
      tags: [],
      reads: [],
      writes: [],
      calls: [],
      exclude: false,
      external: true,
    };
    externalFuncs.set(funcName, placeholder);
    return placeholder;
  };

  for (const p of pending) {
    const fn = funcOf(p.owner);
    if (p.kind === "call") {
      const callee = funcOf(p.name);
      fn.calls.push(callee.id);
      edges.push({ src: fn.id, dst: callee.id, kind: "call", inferred: false });
      continue;
    }
    const sig = signalOf(p.name, p.kind === "read");
    if (p.kind === "read") fn.reads.push(sig.id);
    else fn.writes.push(sig.id);
    edges.push({ src: fn.id, dst: sig.id, kind: p.kind, inferred: false });
  }

  // 参数挂接：只认本模块内真实存在的函数记录。找不到时不创建 external 占位，
  // 否则一个写错函数名的 DC_PARAM 会凭空多出一个函数节点，比缺参数更难发现。
  const paramsByFunc = new Map<
    ArtifactFunc,
    {
      index: number;
      name: string;
      ctype: string;
      dir: SignalDirection;
      unit: string;
      alias: string;
    }[]
  >();
  for (const p of pendingParams) {
    const fn = [...funcs.values()].find((f) => f.name === p.owner);
    if (fn === undefined) {
      bag.warn(DIAG.danglingRead, `参数 ${p.name} 找不到所属函数 ${p.owner}，已忽略`);
      continue;
    }
    const list = paramsByFunc.get(fn) ?? [];
    list.push({
      index: p.index,
      name: p.name,
      ctype: p.ctype,
      dir: p.dir,
      unit: p.unit,
      alias: p.alias,
    });
    paramsByFunc.set(fn, list);
  }
  for (const [fn, list] of paramsByFunc) {
    // `offset` 是参数序号；按它排序恢复源码签名顺序，而不是宏的书写顺序。
    list.sort((a, b) => a.index - b.index);
    // 空属性不写进 JSON：canonical 输出不因“声明了空 unit”而多出键。
    fn.params.push(
      ...list.map(({ name, ctype, dir, unit, alias }) => ({
        name,
        ctype,
        dir,
        ...(unit.length > 0 ? { unit } : {}),
        ...(alias.length > 0 ? { alias } : {}),
      })),
    );
  }

  // 缺半边的数据链是信息，不是错误：保留信号并给诊断。
  const allSignals = [...signals.values(), ...externalSignals.values()];
  for (const s of signals.values()) {
    const reads = edges.filter((e) => e.dst === s.id && e.kind === "read").length;
    const writes = edges.filter((e) => e.dst === s.id && e.kind === "write").length;
    if (writes > 0 && reads === 0) {
      bag.warn(DIAG.danglingWrite, `${s.name} 只被写、从未被读`, s.id);
    } else if (reads > 0 && writes === 0) {
      bag.warn(DIAG.danglingRead, `${s.name} 只被读、从未被写`, s.id);
    }
  }

  const allFuncs = [...funcs.values(), ...externalFuncs.values()];
  module.counts = { signals: allSignals.length, funcs: allFuncs.length, types: types.size };

  return {
    info: {
      path: name,
      format: "elf",
      arch,
      kind,
      hasMetadata: true,
      metadataVersion: version,
    },
    modules: [module],
    types: [...types.values()],
    signals: allSignals,
    funcs: allFuncs,
    edges,
    diagnostics: bag.items,
  };
}

/** 链接器/CRT 生成的固定符号，浏览业务代码时没有意义。 */
const INTERNAL_ELF_SYMBOLS = new Set(["_start", "_init", "_fini", "_IO_stdin_used"]);

/**
 * 判断一个符号是否值得出现在无元数据视图里。
 *
 * 这不是安全过滤，只是把 CRT 与链接器脚手架从业务符号中摘出去：
 *   - `__` 开头是编译器/运行库保留名；
 *   - size 为 0 的多是链接器标签或空桩（如 frame_dummy）；
 *   - 本地符号名里带 `.` 是编译器给静态变量加的唯一后缀（如 completed.1）。
 *
 * 用户自己的 `_foo`、静态函数和静态变量仍然保留——回退模式宁可多显示，
 * 也不替用户判断哪些代码“不重要”。
 */
function isBrowsableSymbol(symbol: ElfSymbol): boolean {
  if (symbol.name.startsWith(".")) return false;
  if (symbol.name.startsWith("__")) return false;
  if (INTERNAL_ELF_SYMBOLS.has(symbol.name)) return false;
  if (symbol.size === 0) return false;
  if (symbol.bind === 0 /* STB_LOCAL */ && symbol.name.includes(".")) return false;
  return true;
}

/**
 * 无元数据回退：把符号表当作最小模型。
 *
 * 映射规则刻意保守：
 *   - `STT_FUNC` -> 函数；
 *   - `STT_OBJECT` -> 信号，方向留空（二进制里没有方向信息）；
 *   - 同名符号用 `#2`、`#3` 去重，保证同一文件两次解析得到同一批 id；
 *   - 用重定位补“函数访问过某信号”，一律记 `read` 并标 `inferred`。
 *
 * 这条路径只在没有 `dc_meta_entries` 时启用，不会改变已接入模板的产物。
 * 读不到的类型、字段、方向、别名等信息就在这里留空，而不是猜一个看起来
 * 合理但会误导用户的值。
 */
function buildSymbolFallback(
  view: ByteView,
  sections: ElfSection[],
  symbols: ElfSymbol[],
  stem: string,
  name: string,
  kind: ArtifactKind,
  arch: string,
  bag: DiagnosticBag,
): ArtifactModel {
  // ar 成员会把 `libapp/main` 这样的前缀作为 stem 传进来；模块名只取最后
  // 一段，id 仍用完整前缀，这样 `libapp/main::main` 既唯一又好读。
  // 单独的 .o/.so/.out 没有 `/`，两种写法等价。
  const moduleName = stem.split("/").pop() || stem;
  const moduleId = `${stem}::${moduleName}`;
  const module: ArtifactModule = {
    id: moduleId,
    name: moduleName,
    path: moduleName,
    kind: "file",
    children: [],
    root: false,
    exclude: false,
    counts: { signals: 0, funcs: 0, types: 0 },
  };

  const usedIds = new Set<string>();
  const idOf = (symbolName: string): string => {
    const base = `${stem}::${moduleName}.${symbolName}`;
    if (!usedIds.has(base)) {
      usedIds.add(base);
      return base;
    }
    let index = 2;
    while (usedIds.has(`${base}#${index}`)) index += 1;
    const id = `${base}#${index}`;
    usedIds.add(id);
    return id;
  };

  const funcs: ArtifactFunc[] = [];
  const signals: ArtifactSignal[] = [];
  for (const symbol of symbols) {
    // shndx=0 是未定义符号（外部引用），不是本文件产出的实体。
    if (symbol.shndx === 0 || symbol.name.length === 0) continue;
    if (!isBrowsableSymbol(symbol)) continue;

    if (symbol.type === STT_FUNC) {
      funcs.push({
        id: idOf(symbol.name),
        name: symbol.name,
        ret: "",
        params: [],
        path: moduleName,
        tags: [],
        reads: [],
        writes: [],
        calls: [],
        exclude: false,
        external: false,
        address: `0x${symbol.value.toString(16)}`,
      });
    } else if (symbol.type === STT_OBJECT) {
      signals.push({
        id: idOf(symbol.name),
        name: symbol.name,
        ctype: "",
        dir: "",
        unit: "",
        alias: "",
        note: "",
        tags: [],
        path: moduleName,
        exclude: false,
        external: false,
        inferred: true,
        address: `0x${symbol.value.toString(16)}`,
      });
    }
  }

  // 符号表顺序在链接器之间可能不同；按名字排序，保证展示稳定。
  byName(funcs);
  byName(signals);
  module.counts = { signals: signals.length, funcs: funcs.length, types: 0 };

  const model: ArtifactModel = {
    info: {
      path: name,
      format: "elf",
      arch,
      kind,
      hasMetadata: false,
      metadataVersion: 0,
      fileSize: view.length,
      buildId: readBuildId(view, sections),
    },
    modules: [module],
    types: [],
    signals,
    funcs,
    edges: [],
    diagnostics: [],
  };

  bag.warn(
    DIAG.noMetadata,
    funcs.length + signals.length === 0
      ? "ELF 中没有 dc_meta_entries 段，符号表也没有可读的 FUNC/OBJECT 记录；只保留文件模块"
      : `没有 drawcode 元数据：按符号表列出 ${funcs.length} 个函数、${signals.length} 个信号（方向未知）`,
    name,
  );

  if (funcs.length > 0 && signals.length > 0) {
    // 无元数据时推断边是唯一的关系来源，因此不再受 `inferEdges` 开关约束；
    // 有元数据的路径仍然遵守该开关，显式声明始终优先。
    model.edges.push(...inferReadEdges(view, sections, symbols, funcs, signals, new Set(), bag));
  }
  model.diagnostics = bag.items;
  return model;
}

/** 按名字排序；同名再按 id，避免两个符号的 id 后缀交换顺序。 */
function byName<T extends { id: string; name: string }>(items: T[]): void {
  items.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}
