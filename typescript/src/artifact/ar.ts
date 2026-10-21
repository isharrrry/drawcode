/**
 * ar 归档读取器：把 `.a` 拆成成员，再对每个 ELF 成员调用 `readElf`。
 *
 * 为什么要单独一层：`.a` 本身没有元数据，信息全在成员里。归档格式又足够简单
 * （60 字节定长头），手写比引入依赖更稳；真正复杂的是 ELF，那部分复用读取器。
 *
 * 支持的名称写法：
 *  - 短名：直接放在 16 字节 name 字段（以 `/` 结尾）；
 *  - 长名：`//` 成员是长名表，其他成员的 name 写成 `/<十进制偏移>`；
 *  - `/` 是符号表，跳过；`/SYM64/` 同理。
 * GNU 与 LLVM ar 默认都产出这种布局，覆盖了本项目的 `ar rcs` 结果。
 *
 * 不支持：BSD 的 `#1/<len>` 长名（Apple 工具链）。遇到时给诊断并跳过该成员，
 * 而不是把名字字段当数据解释 —— 后者会让偏移整体错位。
 */

import { ByteView } from "./byteview.ts";
import { DiagnosticBag, DIAG } from "./diagnostics.ts";
import { readElf } from "./elf.ts";
import { type ArtifactModel, type ArtifactModule } from "./model.ts";

const AR_MAGIC = "!<arch>\n";
const MEMBER_HEADER_SIZE = 60;

interface Member {
  name: string;
  offset: number;
  size: number;
}

/**
 * 解析 ar 归档。
 *
 * 成员顺序保持文件顺序：同一份 `.a` 两次解析必须得到相同 JSON。
 * 成员内模块 id 用 `归档名/成员名` 作前缀，避免多个 `app.o` 撞 id。
 */
export function readAr(
  bytes: Uint8Array,
  name: string,
  options: { inferEdges?: boolean } = {},
): ArtifactModel {
  const view = new ByteView(bytes);
  const bag = new DiagnosticBag();
  const stem = stripExtension(name.split(/[\\/]/).pop() ?? name);

  const empty = (): ArtifactModel => ({
    info: {
      path: name,
      format: "ar",
      arch: "",
      kind: "archive",
      hasMetadata: false,
      metadataVersion: 0,
    },
    modules: [],
    types: [],
    signals: [],
    funcs: [],
    edges: [],
    diagnostics: bag.items,
  });

  if (view.length < AR_MAGIC.length || decodeLatin1(view, 0, AR_MAGIC.length) !== AR_MAGIC) {
    bag.error(DIAG.unknownFormat, "不是 ar 归档（缺少 !<arch> 头）", name);
    return empty();
  }

  let members: Member[];
  let longNames = "";
  try {
    const parsed = readMembers(view);
    members = parsed.members;
    longNames = parsed.longNames;
  } catch (error) {
    bag.error(DIAG.truncatedSection, messageOf(error), name);
    return empty();
  }

  const archive: ArtifactModule = {
    id: `${stem}::`,
    name: stem,
    path: stem,
    kind: "archive",
    children: [],
    root: false,
    exclude: false,
    counts: { signals: 0, funcs: 0, types: 0 },
  };

  const merged: ArtifactModel = {
    info: {
      path: name,
      format: "ar",
      arch: "",
      kind: "archive",
      hasMetadata: false,
      metadataVersion: 0,
    },
    modules: [archive],
    types: [],
    signals: [],
    funcs: [],
    edges: [],
    diagnostics: [],
  };

  // 同名成员（理论上可重复）追加 #2；id 前缀带序号，成员内所有 id 随之唯一。
  const seen = new Map<string, number>();

  for (const m of members) {
    let memberName: string | null;
    try {
      memberName = resolveName(m, longNames);
    } catch (error) {
      bag.warn(DIAG.truncatedSection, messageOf(error), name);
      continue;
    }
    if (memberName === null) continue; // 符号表 / 长名表
    if (memberName.startsWith("#1/")) {
      bag.warn(DIAG.unsupportedArch, `不支持 BSD ar 长名成员 ${memberName}，已跳过`, name);
      continue;
    }

    const count = (seen.get(memberName) ?? 0) + 1;
    seen.set(memberName, count);
    const memberStem = stripExtension(memberName) + (count > 1 ? `#${count}` : "");

    const data = view.slice(m.offset, m.size);
    if (!isElf(data)) continue; // 归档里可能有非 ELF 的辅助成员

    const member = readElf(data, memberName, {
      idPrefix: `${stem}/${memberStem}`,
      inferEdges: options.inferEdges,
    });
    merged.modules.push(...member.modules);
    merged.types.push(...member.types);
    merged.signals.push(...member.signals);
    merged.funcs.push(...member.funcs);
    merged.edges.push(...member.edges);
    // 归档里未接入模板的成员是常态（main.o、第三方目标文件），
    // 逐成员报 no-metadata 只会淹没真正的问题；归档末尾统一判定一次即可。
    merged.diagnostics.push(...member.diagnostics.filter((d) => d.code !== DIAG.noMetadata));

    const rootModule = member.modules[0];
    if (rootModule !== undefined) {
      archive.children.push(rootModule.id);
      archive.counts.signals += rootModule.counts.signals;
      archive.counts.funcs += rootModule.counts.funcs;
      archive.counts.types += rootModule.counts.types;
    }

    if (member.info.hasMetadata) {
      merged.info.hasMetadata = true;
      if (merged.info.metadataVersion === 0) merged.info.metadataVersion = member.info.metadataVersion;
      if (merged.info.arch === "") merged.info.arch = member.info.arch;
    }
  }

  if (!merged.info.hasMetadata) {
    bag.warn(DIAG.noMetadata, "归档里没有任何带 dc_meta_entries 的 ELF 成员", name);
  }

  merged.diagnostics.push(...bag.items);
  return merged;
}

/**
 * 逐条读成员头。
 *
 * 每轮先读 60 字节头，再按 size 跳到数据区；数据区按 2 字节对齐。
 * `//` 的内容保存下来给后续 `/<offset>` 解析，不单独成为一个成员。
 */
function readMembers(view: ByteView): { members: Member[]; longNames: string } {
  const members: Member[] = [];
  let longNames = "";
  let at = AR_MAGIC.length;

  while (at + MEMBER_HEADER_SIZE <= view.length) {
    const header = at;
    const rawName = decodeLatin1(view, header, 16).trimEnd();
    // 头部结束标记 "`\n"；缺失说明文件被截断或根本不是 ar。
    if (decodeLatin1(view, header + 58, 2) !== "`\n") {
      throw new RangeError(`成员头结束标记缺失 @ ${header}`);
    }
    const rawSize = decodeLatin1(view, header + 48, 10).trim();
    if (!/^\d+$/.test(rawSize)) {
      throw new RangeError(`成员大小不是十进制数：${JSON.stringify(rawSize)} @ ${header}`);
    }
    const size = Number.parseInt(rawSize, 10);
    const dataOffset = header + MEMBER_HEADER_SIZE;
    if (dataOffset + size > view.length) {
      throw new RangeError(`成员数据越界：offset=${dataOffset} size=${size}`);
    }

    if (rawName === "//") {
      longNames = decodeLatin1(view, dataOffset, size);
    } else {
      members.push({ name: rawName, offset: dataOffset, size });
    }

    at = dataOffset + size;
    if (at % 2 === 1) at += 1; // 成员之间按偶数边界对齐
  }

  return { members, longNames };
}

/**
 * 把成员头里的 name 字段解析成真实名字。
 *
 * 返回 null 表示「这是索引/符号表，不是普通成员」。`<offset>` 指向长名表，
 * 长名以 `/\n` 结束；偏移非法时抛错，由调用方转诊断——静默跳过会掩盖归档损坏。
 */
function resolveName(m: Member, longNames: string): string | null {
  if (m.name === "/" || m.name === "/SYM64/") return null;

  if (/^\/\d+$/.test(m.name)) {
    const offset = Number.parseInt(m.name.slice(1), 10);
    if (!Number.isFinite(offset) || offset < 0 || offset >= longNames.length) {
      throw new RangeError(`长名偏移越界：${m.name}（长名表长度 ${longNames.length}）`);
    }
    const end = longNames.indexOf("/\n", offset);
    const stop = end === -1 ? longNames.length : end;
    return longNames.slice(offset, stop).replace(/\/$/, "");
  }

  // 短名以 `/` 结尾（GNU）；去掉它。空名视为损坏但不致命。
  return m.name.replace(/\/$/, "");
}

function isElf(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0x7f &&
    data[1] === 0x45 &&
    data[2] === 0x4c &&
    data[3] === 0x46
  );
}

function decodeLatin1(view: ByteView, offset: number, size: number): string {
  const bytes = view.slice(offset, size);
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]*$/, "");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
