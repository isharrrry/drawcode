/**
 * ELF / ar 读取器测试。
 *
 * 为什么用「合成字节」而不是提交二进制样本：
 *  - ELF 头与 200 字节记录布局正是要锁的契约，手工构造能把每个字段放到边界上；
 *  - 二进制夹具无法在 diff 里审阅，还会随工具链版本漂移；
 *  - 真实产物另有集成测试（未编译时跳过），两者互补。
 *
 * 合成 ELF 的最小形态：ELF 头 + 记录数据 + .shstrtab + 3 个 section header。
 * 读取器只需要这些；程序头、符号表、重定位都不参与。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { readArtifact } from "../src/artifact/read.ts";

const RECORD_SIZE = 200;
const ELF_HEADER_SIZE = 64;
const SECTION_HEADER_SIZE = 64;

interface Record {
  name?: string;
  tag?: string;
  kind: string;
  owner?: string;
  type?: string;
  size?: number;
  offset?: number;
  order?: number;
}

function putFixed(view: DataView, at: number, text: string, size: number): void {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > size) throw new Error(`字段超长：${text}`);
  for (let i = 0; i < bytes.length; i++) view.setUint8(at + i, bytes[i]!);
}

function encodeRecord(record: Record): Uint8Array {
  const buf = new Uint8Array(RECORD_SIZE);
  const view = new DataView(buf.buffer);
  putFixed(view, 0, record.name ?? "", 48);
  putFixed(view, 48, record.tag ?? "", 48);
  putFixed(view, 96, record.kind, 16);
  putFixed(view, 112, record.owner ?? "", 32);
  putFixed(view, 144, record.type ?? "", 40);
  view.setUint32(184, record.size ?? 0, true);
  view.setUint32(188, record.offset ?? 0, true);
  view.setBigUint64(192, BigInt(record.order ?? 0), true);
  return buf;
}

/**
 * 构造一个只含 `.shstrtab` 与可选 `dc_meta_entries` 的 ELF64 LE。
 *
 * `override` 用于负向测试：改 class、改 e_machine、把段长写成非 200 倍数。
 */
function buildElf(
  records: Record[],
  override: { elfClass?: number; machine?: number; sectionSizeDelta?: number; includeMeta?: boolean } = {},
): Uint8Array {
  const includeMeta = override.includeMeta ?? true;
  const meta = new Uint8Array(records.length * RECORD_SIZE);
  records.forEach((r, i) => meta.set(encodeRecord(r), i * RECORD_SIZE));

  const shstr = new TextEncoder().encode("\0.shstrtab\0dc_meta_entries\0");
  const metaOffset = ELF_HEADER_SIZE;
  const shstrOffset = metaOffset + meta.length;
  const shoff = shstrOffset + shstr.length;
  // section header 表按 8 字节对齐；读取器不要求，但保持真实产物的形态。
  const alignedShoff = shoff + ((8 - (shoff % 8)) % 8);
  const total = alignedShoff + 3 * SECTION_HEADER_SIZE;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  // e_ident
  view.setUint8(0, 0x7f);
  view.setUint8(1, 0x45);
  view.setUint8(2, 0x4c);
  view.setUint8(3, 0x46);
  view.setUint8(4, override.elfClass ?? 2); // ELFCLASS64
  view.setUint8(5, 1); // little endian
  view.setUint8(6, 1); // version
  // e_type / e_machine / e_version
  view.setUint16(16, 1, true); // ET_REL
  view.setUint16(18, override.machine ?? 62, true); // EM_X86_64
  view.setUint32(20, 1, true);
  // e_shoff / e_shentsize / e_shnum / e_shstrndx
  view.setBigUint64(40, BigInt(alignedShoff), true);
  view.setUint16(58, SECTION_HEADER_SIZE, true);
  view.setUint16(60, 3, true);
  view.setUint16(62, 2, true);

  buf.set(meta, metaOffset);
  buf.set(shstr, shstrOffset);

  const sh = (index: number, nameOff: number, offset: number, size: number): void => {
    const at = alignedShoff + index * SECTION_HEADER_SIZE;
    view.setUint32(at + 0, nameOff, true);
    view.setUint32(at + 4, 1, true); // SHT_PROGBITS
    view.setBigUint64(at + 24, BigInt(offset), true);
    view.setBigUint64(
      at + 32,
      BigInt(size + (index === 1 ? override.sectionSizeDelta ?? 0 : 0)),
      true,
    );
  };
  // 名称偏移：1 = ".shstrtab"，11 = "dc_meta_entries"（见上面 shstr 的字节布局）。
  sh(0, 0, 0, 0); // null section
  sh(1, 11, metaOffset, includeMeta ? meta.length : 0);
  sh(2, 1, shstrOffset, shstr.length);

  return buf;
}

/**
 * 构造带 `.symtab` / `.strtab` / `.rela.text` 的 ELF64 LE。
 *
 * 布局：
 *   0 null | 1 .text | 2 .data | 3 dc_meta_entries | 4 .symtab
 *   5 .strtab | 6 .rela.text | 7 .shstrtab
 *
 * 只放一个函数 `producer`（.text 偏移 0，长 0x20）与一个变量 `g_out`（.data），
 * `.rela.text` 在偏移 0x10 处引用 `g_out` —— 这正是编译器为
 * `g_out = ...` / `... = g_out` 生成的形态。二进制分不清读写，读取器应记为 read。
 */
function buildElfWithRela(
  records: Record[],
  options: { includeSymtab?: boolean } = {},
): Uint8Array {
  const includeSymtab = options.includeSymtab ?? true;
  const meta = new Uint8Array(records.length * RECORD_SIZE);
  records.forEach((r, i) => meta.set(encodeRecord(r), i * RECORD_SIZE));

  const text = new Uint8Array(0x20).fill(0x90); // nop
  const data = new Uint8Array(8);
  const strtabBytes = new TextEncoder().encode("\0g_out\0producer\0");
  // 偏移按字节数：0=NUL，1..5="g_out"，6=NUL，7..14="producer"，15=NUL。
  const strtab = { gOut: 1, producer: 7 };

  const names = ["", ".text", ".data", "dc_meta_entries", ".symtab", ".strtab", ".rela.text", ".shstrtab"];
  const nameOff = new Map<string, number>();
  const nameChunks: number[] = [];
  let nameLen = 0;
  for (const n of names) {
    nameOff.set(n, nameLen);
    for (const ch of new TextEncoder().encode(n)) nameChunks.push(ch);
    nameChunks.push(0);
    nameLen += n.length + 1;
  }
  const shstr = new Uint8Array(nameChunks);

  const symEntrySize = 24;
  const symtab = new Uint8Array(includeSymtab ? symEntrySize * 3 : 0);
  if (includeSymtab) {
    const sym = new DataView(symtab.buffer);
    // 0: null
    // 1: g_out（OBJECT，.data，大小 8）
    sym.setUint32(24, strtab.gOut, true);
    sym.setUint8(28, 0x11); // STB_GLOBAL << 4 | STT_OBJECT
    sym.setUint16(30, 2, true);
    sym.setBigUint64(32, 0n, true);
    sym.setBigUint64(40, 8n, true);
    // 2: producer（FUNC，.text，偏移 0，大小 0x20）
    sym.setUint32(48, strtab.producer, true);
    sym.setUint8(52, 0x12); // STB_GLOBAL << 4 | STT_FUNC
    sym.setUint16(54, 1, true);
    sym.setBigUint64(56, 0n, true);
    sym.setBigUint64(64, 0x20n, true);
  }

  const rela = new Uint8Array(24);
  {
    const view = new DataView(rela.buffer);
    view.setBigUint64(0, 0x10n, true); // r_offset
    // ELF64_R_INFO(sym=1, type=R_X86_64_PC32=2)
    view.setBigUint64(8, (1n << 32n) | 2n, true);
    view.setBigInt64(16, 0n, true);
  }

  const align8 = (n: number): number => n + ((8 - (n % 8)) % 8);
  const textOffset = ELF_HEADER_SIZE;
  const dataOffset = align8(textOffset + text.length);
  const metaOffset = align8(dataOffset + data.length);
  const symOffset = align8(metaOffset + meta.length);
  const strOffset = align8(symOffset + symtab.length);
  const relaOffset = align8(strOffset + strtabBytes.length);
  const shstrOffset = align8(relaOffset + rela.length);
  const shoff = align8(shstrOffset + shstr.length);
  const shnum = 8;
  const total = shoff + shnum * SECTION_HEADER_SIZE;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  view.setUint8(0, 0x7f);
  view.setUint8(1, 0x45);
  view.setUint8(2, 0x4c);
  view.setUint8(3, 0x46);
  view.setUint8(4, 2); // ELFCLASS64
  view.setUint8(5, 1); // little endian
  view.setUint8(6, 1);
  view.setUint16(16, 1, true); // ET_REL
  view.setUint16(18, 62, true); // EM_X86_64
  view.setUint32(20, 1, true);
  view.setBigUint64(40, BigInt(shoff), true);
  view.setUint16(58, SECTION_HEADER_SIZE, true);
  view.setUint16(60, shnum, true);
  view.setUint16(62, 7, true); // .shstrtab

  buf.set(text, textOffset);
  buf.set(data, dataOffset);
  buf.set(meta, metaOffset);
  buf.set(symtab, symOffset);
  buf.set(strtabBytes, strOffset);
  buf.set(rela, relaOffset);
  buf.set(shstr, shstrOffset);

  interface Header {
    name: string;
    type: number;
    flags?: number;
    offset: number;
    size: number;
    link?: number;
    info?: number;
    entsize?: number;
  }
  const headers: Header[] = [
    { name: "", type: 0, offset: 0, size: 0 },
    { name: ".text", type: 1, flags: 0x6, offset: textOffset, size: text.length }, // AX
    { name: ".data", type: 1, flags: 0x3, offset: dataOffset, size: data.length }, // WA
    { name: "dc_meta_entries", type: 1, flags: 0x2, offset: metaOffset, size: meta.length },
    {
      name: ".symtab",
      type: 2, // SHT_SYMTAB
      offset: symOffset,
      size: symtab.length,
      link: 5, // .strtab
      info: 1,
      entsize: symEntrySize,
    },
    { name: ".strtab", type: 3, offset: strOffset, size: strtabBytes.length },
    {
      name: ".rela.text",
      type: 4, // SHT_RELA
      offset: relaOffset,
      size: includeSymtab ? rela.length : 0,
      link: 4, // .symtab
      info: 1, // 作用于 .text
      entsize: 24,
    },
    { name: ".shstrtab", type: 3, offset: shstrOffset, size: shstr.length },
  ];

  headers.forEach((h, i) => {
    const at = shoff + i * SECTION_HEADER_SIZE;
    view.setUint32(at + 0, nameOff.get(h.name) ?? 0, true);
    view.setUint32(at + 4, h.type, true);
    view.setBigUint64(at + 8, BigInt(h.flags ?? 0), true);
    view.setBigUint64(at + 16, 0n, true);
    view.setBigUint64(at + 24, BigInt(h.offset), true);
    view.setBigUint64(at + 32, BigInt(h.size), true);
    view.setUint32(at + 40, h.link ?? 0, true);
    view.setUint32(at + 44, h.info ?? 0, true);
    view.setBigUint64(at + 48, 8n, true);
    view.setBigUint64(at + 56, BigInt(h.entsize ?? 0), true);
  });

  return buf;
}

/**
 * 构造带 `.symtab` / `.strtab` / `.rel.text` 的 ELF32 LE（EM_ARM）。
 *
 * 与 ELF64 夹具的差异正好是读取器最容易写错的三个地方：
 *   1. 头 52 字节、section header 40 字节，且 shoff/entsize 等字段挪了位置；
 *   2. Elf32_Sym 16 字节，字段顺序是 name/value/size/info/other/shndx（不是 64 位的顺序）；
 *   3. ARM 链接器默认产出 SHT_REL（没有显式 addend），r_info 的符号下标在高 24 位。
 * 合成这份字节，才能在没有 ARM 工具链的机器上也锁住这些偏移。
 *
 * 布局：0 null | 1 .text | 2 .data | 3 dc_meta_entries | 4 .symtab
 *      5 .strtab | 6 .rel.text | 7 .shstrtab
 */
function buildElf32WithRel(records: Record[]): Uint8Array {
  const meta = new Uint8Array(records.length * RECORD_SIZE);
  records.forEach((r, i) => meta.set(encodeRecord(r), i * RECORD_SIZE));

  const text = new Uint8Array(0x20).fill(0x90); // nop
  const data = new Uint8Array(8);
  // 偏移：0=NUL，1..5="g_out"，6=NUL，7..14="producer"，15=NUL，16..22="g_state"，23=NUL
  const strtabBytes = new TextEncoder().encode("\0g_out\0producer\0g_state\0");
  const strtab = { gOut: 1, producer: 7, gState: 16 };

  const names = ["", ".text", ".data", "dc_meta_entries", ".symtab", ".strtab", ".rel.text", ".shstrtab"];
  const nameOff = new Map<string, number>();
  const nameChunks: number[] = [];
  let nameLen = 0;
  for (const n of names) {
    nameOff.set(n, nameLen);
    for (const ch of new TextEncoder().encode(n)) nameChunks.push(ch);
    nameChunks.push(0);
    nameLen += new TextEncoder().encode(n).length + 1;
  }
  const shstr = new Uint8Array(nameChunks);

  const symEntrySize = 16;
  const symtab = new Uint8Array(symEntrySize * 4);
  {
    const sym = new DataView(symtab.buffer);
    // 1: g_out（OBJECT，.data，大小 8）
    sym.setUint32(16, strtab.gOut, true);
    sym.setUint32(20, 0, true);
    sym.setUint32(24, 8, true);
    sym.setUint8(28, 0x11); // STB_GLOBAL << 4 | STT_OBJECT
    sym.setUint16(30, 2, true); // .data
    // 2: producer（FUNC，.text，偏移 0，大小 0x20）
    sym.setUint32(32, strtab.producer, true);
    sym.setUint32(36, 0, true);
    sym.setUint32(40, 0x20, true);
    sym.setUint8(44, 0x12); // STB_GLOBAL << 4 | STT_FUNC
    sym.setUint16(46, 1, true); // .text
    // 3: g_state（OBJECT，.data，大小 8）
    sym.setUint32(48, strtab.gState, true);
    sym.setUint32(52, 0, true);
    sym.setUint32(56, 8, true);
    sym.setUint8(60, 0x11);
    sym.setUint16(62, 2, true);
  }

  // Elf32_Rel：r_offset(4) r_info(4)。ELF32_R_INFO(sym=1, type=R_ARM_ABS32=2)
  // 符号下标放在高 24 位，这是 ELF32_R_SYM 与 ELF64 的又一处差异。
  const rel = new Uint8Array(8);
  {
    const view = new DataView(rel.buffer);
    view.setUint32(0, 0x10, true);
    view.setUint32(4, (1 << 8) | 2, true);
  }

  const align4 = (n: number): number => n + ((4 - (n % 4)) % 4);
  const headerSize = 52;
  const textOffset = headerSize;
  const dataOffset = align4(textOffset + text.length);
  const metaOffset = align4(dataOffset + data.length);
  const symOffset = align4(metaOffset + meta.length);
  const strOffset = align4(symOffset + symtab.length);
  const relOffset = align4(strOffset + strtabBytes.length);
  const shstrOffset = align4(relOffset + rel.length);
  const shoff = align4(shstrOffset + shstr.length);
  const shnum = 8;
  const sectionHeaderSize = 40;
  const total = shoff + shnum * sectionHeaderSize;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  view.setUint8(0, 0x7f);
  view.setUint8(1, 0x45);
  view.setUint8(2, 0x4c);
  view.setUint8(3, 0x46);
  view.setUint8(4, 1); // ELFCLASS32
  view.setUint8(5, 1); // little endian
  view.setUint8(6, 1);
  view.setUint16(16, 1, true); // ET_REL
  view.setUint16(18, 40, true); // EM_ARM
  view.setUint32(20, 1, true);
  // Elf32_Ehdr 尾部：e_ehsize(40) e_phentsize(42) e_phnum(44)
  //                e_shentsize(46) e_shnum(48) e_shstrndx(50)
  view.setUint32(32, shoff, true);
  view.setUint16(40, headerSize, true);
  view.setUint16(46, sectionHeaderSize, true);
  view.setUint16(48, shnum, true);
  view.setUint16(50, 7, true);

  buf.set(text, textOffset);
  buf.set(data, dataOffset);
  buf.set(meta, metaOffset);
  buf.set(symtab, symOffset);
  buf.set(strtabBytes, strOffset);
  buf.set(rel, relOffset);
  buf.set(shstr, shstrOffset);

  interface Header {
    name: string;
    type: number;
    flags?: number;
    offset: number;
    size: number;
    link?: number;
    info?: number;
    entsize?: number;
  }
  const headers: Header[] = [
    { name: "", type: 0, offset: 0, size: 0 },
    { name: ".text", type: 1, flags: 0x6, offset: textOffset, size: text.length }, // AX
    { name: ".data", type: 1, flags: 0x3, offset: dataOffset, size: data.length }, // WA
    { name: "dc_meta_entries", type: 1, flags: 0x2, offset: metaOffset, size: meta.length },
    { name: ".symtab", type: 2, offset: symOffset, size: symtab.length, link: 5, info: 1, entsize: symEntrySize },
    { name: ".strtab", type: 3, offset: strOffset, size: strtabBytes.length },
    // SHT_REL=9：内容与 .rela.text 相同，只是没有 addend。
    { name: ".rel.text", type: 9, offset: relOffset, size: rel.length, link: 4, info: 1, entsize: 8 },
    { name: ".shstrtab", type: 3, offset: shstrOffset, size: shstr.length },
  ];

  headers.forEach((h, i) => {
    const at = shoff + i * sectionHeaderSize;
    // Elf32_Shdr：name0 type4 flags8 addr12 offset16 size20 link24 info28 align32 entsize36
    view.setUint32(at + 0, nameOff.get(h.name) ?? 0, true);
    view.setUint32(at + 4, h.type, true);
    view.setUint32(at + 8, h.flags ?? 0, true);
    view.setUint32(at + 12, 0, true);
    view.setUint32(at + 16, h.offset, true);
    view.setUint32(at + 20, h.size, true);
    view.setUint32(at + 24, h.link ?? 0, true);
    view.setUint32(at + 28, h.info ?? 0, true);
    view.setUint32(at + 32, 4, true);
    view.setUint32(at + 36, h.entsize ?? 0, true);
  });

  return buf;
}

function buildAr(members: { name: string; data: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [new TextEncoder().encode("!<arch>\n")];
  for (const m of members) {
    const name = (m.name + "/").padEnd(16, " ");
    const header =
      name +
      "0".padEnd(12, " ") + // mtime
      "0".padEnd(6, " ") + // uid
      "0".padEnd(6, " ") + // gid
      "644".padEnd(8, " ") + // mode
      String(m.data.length).padEnd(10, " ") +
      "`\n";
    chunks.push(new TextEncoder().encode(header));
    chunks.push(m.data);
    if (m.data.length % 2 === 1) chunks.push(new Uint8Array([0x0a]));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function withTempFile(
  name: string,
  content: Uint8Array,
  body: (file: string) => Promise<void>,
): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-elf-"));
  const file = path.join(tmp, name);
  fs.writeFileSync(file, content);
  return body(file).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
}

/**
 * 找一个能产出 ELF 的 C 编译器与配套 strip。
 *
 * 本机默认 `gcc` 可能是 Cygwin 的 PE 目标（`x86_64-pc-cygwin`），不能用来测 ELF；
 * 所以用 `-dumpmachine` 过滤，并允许 `DRAWCODE_ELF_CC` 显式指定。
 * 找不到时测试跳过，不把「本机没装交叉工具链」判成代码缺陷。
 */
function findElfToolchain(): { cc: string; strip: string } | null {
  const candidates = [process.env.DRAWCODE_ELF_CC, "x86_64-unknown-linux-gnu-gcc", "gcc"];
  for (const cc of candidates) {
    if (cc === undefined || cc === "") continue;
    const probe = spawnSync(cc, ["-dumpmachine"], { encoding: "utf8" });
    if (probe.status !== 0 || !/linux|elf/i.test(probe.stdout)) continue;

    const printed = spawnSync(cc, ["-print-prog-name=strip"], { encoding: "utf8" });
    if (printed.status !== 0) continue;
    // Cygwin 工具链打印 `/cygdrive/d/...`，Node 的 spawn 不认这个前缀。
    const raw = (printed.stdout ?? "").trim();
    const m = /^\/cygdrive\/([a-zA-Z])\/(.*)$/.exec(raw);
    const strip = m === null ? raw : `${m[1]}:/${m[2]}`;
    if (!fs.existsSync(strip)) continue;
    return { cc, strip };
  }
  return null;
}

/** 示例工程的最小等价记录集；顺序故意打乱，验证按 order 排序。 */
function demoRecords(): Record[] {
  return [
    { kind: "module", tag: "root", owner: "demo", order: 9 },
    { kind: "anchor", tag: "1", owner: "demo", type: "dc_meta_entry", order: 0 },
    { kind: "signal", name: "g_out", tag: "telemetry,rmem", owner: "demo", type: "double", order: 1 },
    { kind: "signal", name: "g_state", owner: "demo", type: "DcState", order: 2 },
    { kind: "field", name: "gain", owner: "DcState", type: "float", size: 4, offset: 12, order: 5 },
    { kind: "field", name: "voltage", owner: "DcState", type: "double", size: 8, offset: 0, order: 3 },
    { kind: "field", name: "count", owner: "DcState", type: "int32", size: 4, offset: 8, order: 4 },
    { kind: "function", name: "producer", owner: "demo", order: 6 },
    { kind: "function", name: "consumer", owner: "demo", order: 7 },
    { kind: "write", name: "g_out", owner: "producer", order: 8 },
    { kind: "read", name: "g_out", owner: "consumer", order: 10 },
    { kind: "call", name: "producer", owner: "consumer", order: 11 },
  ];
}

test("elf: 记录解码为信号、类型、函数与三类边", async () => {
  await withTempFile("app.o", buildElf(demoRecords()), async (file) => {
    const model = await readArtifact(file);
    assert.equal(model.info.format, "elf");
    assert.equal(model.info.kind, "object");
    assert.equal(model.info.arch, "x64");
    assert.equal(model.info.hasMetadata, true);
    assert.equal(model.info.metadataVersion, 1);
    assert.equal(model.diagnostics.length, 0);

    assert.equal(model.signals.length, 2);
    assert.equal(model.types.length, 1);
    assert.equal(model.funcs.length, 2);
    assert.equal(model.modules.length, 1);
    assert.equal(model.modules[0]?.root, true);
    assert.deepEqual(model.modules[0]?.counts, { signals: 2, funcs: 2, types: 1 });

    // 字段按声明序号排序；偏移/大小来自编译器。
    assert.deepEqual(model.types[0]?.fields.map((f) => f.name), ["voltage", "count", "gain"]);
    assert.deepEqual(model.types[0]?.fields.map((f) => f.offset), [0, 8, 12]);

    // 信号类型指向同名 ArtifactType，ICD 视图据此下钻。
    const state = model.signals.find((s) => s.name === "g_state");
    assert.equal(state?.ownerType, model.types[0]?.id);

    assert.equal(model.edges.filter((e) => e.kind === "read").length, 1);
    assert.equal(model.edges.filter((e) => e.kind === "write").length, 1);
    assert.equal(model.edges.filter((e) => e.kind === "call").length, 1);
  });
});

test("elf: direction/path、返回类型、参数与枚举成员都进入模型", async () => {
  const records: Record[] = [
    { kind: "anchor", tag: "1", owner: "demo", order: 0 },
    { kind: "module", tag: "root", owner: "demo", order: 1 },
    { kind: "type", name: "Mode", tag: "kind=enum,size=4,alias=Mode", owner: "demo", order: 2 },
    { kind: "enum_member", name: "IDLE", owner: "Mode", type: "Mode", offset: 0, order: 3 },
    { kind: "enum_member", name: "RUN", owner: "Mode", type: "Mode", offset: 1, order: 4 },
    {
      kind: "signal",
      name: "g_out",
      tag: "store,direction=out,path=io,unit=V,init=0",
      type: "double",
      owner: "demo",
      order: 5,
    },
    { kind: "function", name: "produce", tag: "alias=Produce", owner: "demo", type: "void", order: 6 },
    // 故意先写序号 1、再写序号 0：读取器必须按 offset 还原签名顺序。
    {
      kind: "param",
      name: "step",
      tag: "direction=in,unit=ms,alias=步进",
      owner: "produce",
      type: "uint32",
      offset: 1,
      order: 7,
    },
    { kind: "param", name: "base", owner: "produce", type: "float", offset: 0, order: 8 },
  ];
  await withTempFile("rich.o", buildElf(records), async (file) => {
    const model = await readArtifact(file);
    assert.equal(model.diagnostics.length, 0);

    const sig = model.signals.find((s) => s.name === "g_out");
    assert.equal(sig?.dir, "out");
    assert.equal(sig?.path, "io");
    assert.equal(sig?.initial, "0");
    // ArtifactSignal 没有 store 位；标签不能因为解析被消费就消失。
    assert.deepEqual(sig?.tags, ["store"]);

    const fn = model.funcs.find((f) => f.name === "produce");
    assert.equal(fn?.ret, "void");
    assert.deepEqual(
      fn?.params.map((p) => [p.name, p.ctype, p.dir, p.unit ?? "", p.alias ?? ""]),
      [
        // 没写 tag 的参数：unit/alias 缺省，JSON 里不会出现空键。
        ["base", "float", "", "", ""],
        ["step", "uint32", "in", "ms", "步进"],
      ],
    );

    const mode = model.types.find((t) => t.name === "Mode");
    assert.equal(mode?.kind, "enum");
    // 枚举成员的「初值」就是成员值，偏移/大小保持未知（0）。
    assert.deepEqual(
      mode?.fields.map((f) => [f.name, f.initial, f.offset, f.size]),
      [
        ["IDLE", "0", 0, 0],
        ["RUN", "1", 0, 0],
      ],
    );
  });
});

test("elf: 没有 dc_meta_entries 段时给出 no-metadata，而不是失败", async () => {
  await withTempFile("plain.o", buildElf([], { includeMeta: false }), async (file) => {
    const model = await readArtifact(file);
    assert.equal(model.info.hasMetadata, false);
    assert.equal(model.signals.length, 0);
    assert.equal(model.diagnostics[0]?.code, "no-metadata");
  });
});

test("elf: 版本不符是错误，且不再产出实体", async () => {
  const records = demoRecords().map((r) => (r.kind === "anchor" ? { ...r, tag: "99" } : r));
  await withTempFile("future.o", buildElf(records), async (file) => {
    const model = await readArtifact(file);
    assert.equal(model.info.hasMetadata, true);
    assert.equal(model.info.metadataVersion, 99);
    assert.equal(model.signals.length, 0);
    assert.equal(model.diagnostics[0]?.code, "version-mismatch");
    assert.equal(model.diagnostics[0]?.severity, "error");
  });
});

test("elf: 既非 ELF32 也非 ELF64 的 class 报 unsupported-arch", async () => {
  // class=0 不是合法值；1/2 现在分别按 ELF32/ELF64 解析，不能再当负样本。
  await withTempFile("bad-class.o", buildElf(demoRecords(), { elfClass: 0 }), async (file) => {
    const model = await readArtifact(file);
    assert.equal(model.diagnostics[0]?.code, "unsupported-arch");
    assert.equal(model.signals.length, 0);
  });
});

test("elf: 大端 ELF 报 unsupported-arch", async () => {
  const data = buildElf(demoRecords());
  data[5] = 2; // ELFDATA2MSB
  await withTempFile("be.o", data, async (file) => {
    const model = await readArtifact(file);
    assert.equal(model.diagnostics[0]?.code, "unsupported-arch");
  });
});

test("elf: 段长不是 200 的整数倍时警告并忽略尾部", async () => {
  await withTempFile("ragged.o", buildElf(demoRecords(), { sectionSizeDelta: 37 }), async (file) => {
    const model = await readArtifact(file);
    assert.ok(model.diagnostics.some((d) => d.code === "truncated-section"));
    // 尾部残缺记录不进入模型。
    assert.ok(model.signals.length > 0);
    for (const s of model.signals) assert.ok(!s.name.includes("\u0000"));
  });
});

test("elf: 读取未声明信号会生成 external 占位并保持零悬空", async () => {
  const records = [
    { kind: "anchor", tag: "1", owner: "demo", order: 0 },
    { kind: "function", name: "consumer", owner: "demo", order: 1 },
    { kind: "read", name: "ghost", owner: "consumer", order: 2 },
  ];
  await withTempFile("ghost.o", buildElf(records), async (file) => {
    const model = await readArtifact(file);
    const ghost = model.signals.find((s) => s.name === "ghost");
    assert.equal(ghost?.external, true);
    assert.ok(model.diagnostics.some((d) => d.code === "dangling-read"));

    const known = new Set([...model.signals.map((s) => s.id), ...model.funcs.map((f) => f.id)]);
    for (const edge of model.edges) {
      assert.ok(known.has(edge.src), `悬空 src: ${edge.src}`);
      assert.ok(known.has(edge.dst), `悬空 dst: ${edge.dst}`);
    }
  });
});

/** 只有声明层、没有任何 DC_READ/DC_WRITE 的最小记录集。 */
function inferRecords(): Record[] {
  return [
    { kind: "anchor", tag: "1", owner: "demo", order: 0 },
    { kind: "signal", name: "g_out", owner: "demo", type: "double", order: 1 },
    { kind: "function", name: "producer", owner: "demo", order: 2 },
  ];
}

test("elf: 默认不读取符号表，声明层缺的边不会被悄悄补上", async () => {
  await withTempFile("infer.o", buildElfWithRela(inferRecords()), async (file) => {
    const model = await readArtifact(file);
    assert.equal(model.edges.length, 0);
    assert.equal(model.funcs[0]?.reads.length, 0);
    assert.ok(!model.diagnostics.some((d) => d.code === "inferred-edges"));
  });
});

test("elf: --infer-edges 用 .rela.text 补出 inferred 的 read 边", async () => {
  await withTempFile("infer.o", buildElfWithRela(inferRecords()), async (file) => {
    const model = await readArtifact(file, { inferEdges: true });
    const edge = model.edges.find((e) => e.kind === "read" && e.inferred);
    assert.ok(edge !== undefined, "应有推断出的 read 边");
    assert.equal(model.edges.length, 1);

    const producer = model.funcs.find((f) => f.name === "producer");
    const gOut = model.signals.find((s) => s.name === "g_out");
    assert.equal(edge?.src, producer?.id);
    assert.equal(edge?.dst, gOut?.id);
    // func.reads 与边同源，视图只读一处。
    assert.deepEqual(producer?.reads, [gOut?.id]);

    const note = model.diagnostics.find((d) => d.code === "inferred-edges");
    assert.equal(note?.severity, "info");
  });
});

test("elf32: ARM 小端的节头、Elf32_Sym 与 SHT_REL 重定位都能读", async () => {
  await withTempFile("app32.o", buildElf32WithRel(inferRecords()), async (file) => {
    const model = await readArtifact(file, { inferEdges: true });
    assert.equal(model.info.format, "elf");
    assert.equal(model.info.arch, "arm");
    assert.equal(model.info.kind, "object");
    assert.equal(model.info.hasMetadata, true);
    assert.equal(model.info.metadataVersion, 1);
    assert.deepEqual(model.signals.map((s) => s.name), ["g_out"]);
    assert.deepEqual(model.funcs.map((f) => f.name), ["producer"]);

    // 元数据里没有 DC_READ；唯一一条边来自 .rel.text（SHT_REL，无 addend）。
    const edge = model.edges.find((e) => e.kind === "read" && e.inferred);
    assert.ok(edge !== undefined, "应从 SHT_REL 推断出 read 边");
    assert.equal(edge?.src, model.funcs[0]?.id);
    assert.equal(edge?.dst, model.signals[0]?.id);
  });
});

test("elf: 显式 DC_WRITE 优先，同一对函数/信号不再造推断边", async () => {
  const records = [
    ...inferRecords(),
    { kind: "write", name: "g_out", owner: "producer", order: 3 },
  ];
  await withTempFile("explicit.o", buildElfWithRela(records), async (file) => {
    const model = await readArtifact(file, { inferEdges: true });
    assert.equal(model.edges.length, 1);
    assert.equal(model.edges[0]?.kind, "write");
    assert.equal(model.edges[0]?.inferred, false);
  });
});

test("elf: strip --strip-all 后声明层仍在，推断自动关闭", async () => {
  await withTempFile(
    "stripped.o",
    buildElfWithRela(inferRecords(), { includeSymtab: false }),
    async (file) => {
      const model = await readArtifact(file, { inferEdges: true });
      // .symtab 没了，但 dc_meta_entries 不受影响。
      assert.equal(model.info.hasMetadata, true);
      assert.deepEqual(model.signals.map((s) => s.name), ["g_out"]);
      assert.deepEqual(model.funcs.map((f) => f.name), ["producer"]);
      assert.equal(model.edges.length, 0);
      const note = model.diagnostics.find((d) => d.code === "inferred-edges");
      assert.equal(note?.severity, "info");
      assert.match(note?.message ?? "", /\.symtab/);
    },
  );
});

test("ar: 推断开关透传到成员，归档层也能得到 inferred 边", async () => {
  const app = buildElfWithRela(inferRecords());
  await withTempFile("libinfer.a", buildAr([{ name: "app.o", data: app }]), async (file) => {
    const model = await readArtifact(file, { inferEdges: true });
    assert.equal(model.edges.filter((e) => e.inferred).length, 1);
    assert.ok(model.diagnostics.some((d) => d.code === "inferred-edges"));
  });
});

test("elf: 真实 gcc 产物在 strip 前后的推断行为", async (t) => {
  const toolchain = findElfToolchain();
  if (toolchain === null) {
    t.skip("未找到能产出 ELF 的 C 工具链");
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-elf-real-"));
  try {
    // 故意不写 DC_READ/DC_WRITE：模拟「模板只标了声明，忘了标读写」的实际工程。
    fs.writeFileSync(
      path.join(tmp, "infer.c"),
      [
        '#include "DrawcodeMeta.h"',
        "double g_out;",
        'DC_SIGNAL(g_out, "telemetry", "double");',
        "void producer(void) { g_out += 1.0; }",
        'DC_FUNCTION(producer, "");',
        "",
      ].join("\n"),
    );

    const includeDir = path.resolve(import.meta.dirname, "..", "..", "templates", "c");
    const compile = spawnSync(
      toolchain.cc,
      [
        "-std=c11",
        "-O2",
        "-I",
        includeDir,
        '-DDC_META_MODULE="demo"',
        "-c",
        "infer.c",
        "-o",
        "infer.o",
      ],
      { cwd: tmp, encoding: "utf8" },
    );
    assert.equal(compile.status, 0, compile.stderr);

    const obj = path.join(tmp, "infer.o");
    // 关闭推断：声明层完整，但没有任何读写边。
    const off = await readArtifact(obj);
    assert.equal(off.signals.length, 1);
    assert.equal(off.funcs.length, 1);
    assert.equal(off.edges.length, 0);

    // 打开推断：重定位指向 g_out，归因到 producer。
    const on = await readArtifact(obj, { inferEdges: true });
    const inferred = on.edges.filter((e) => e.inferred);
    assert.equal(inferred.length, 1);
    assert.equal(inferred[0]?.kind, "read");
    assert.equal(inferred[0]?.dst, on.signals[0]?.id);
    assert.equal(inferred[0]?.src, on.funcs[0]?.id);

    // strip --strip-all 删掉 .symtab 与 .rela.text，但删不掉 dc_meta_entries。
    fs.copyFileSync(obj, path.join(tmp, "stripped.o"));
    const strip = spawnSync(toolchain.strip, ["--strip-all", "stripped.o"], {
      cwd: tmp,
      encoding: "utf8",
    });
    assert.equal(strip.status, 0, strip.stderr);

    const stripped = await readArtifact(path.join(tmp, "stripped.o"), { inferEdges: true });
    assert.equal(stripped.info.hasMetadata, true);
    assert.equal(stripped.signals.length, 1);
    assert.equal(stripped.funcs.length, 1);
    assert.equal(stripped.edges.length, 0);
    assert.ok(stripped.diagnostics.some((d) => d.code === "inferred-edges"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("elf: 同一字节两次解析得到完全相同的 JSON", async () => {
  const data = buildElf(demoRecords());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-elf-stable-"));
  try {
    const file = path.join(tmp, "app.o");
    fs.writeFileSync(file, data);
    const first = await readArtifact(file);
    const second = await readArtifact(file);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ar: 成员逐个解析，无元数据成员回退为空模块", async () => {
  const app = buildElf(demoRecords());
  const main = buildElf([], { includeMeta: false });
  await withTempFile(
    "libapp.a",
    buildAr([
      { name: "app.o", data: app },
      { name: "main.o", data: main },
    ]),
    async (file) => {
      const model = await readArtifact(file);
      assert.equal(model.info.format, "ar");
      assert.equal(model.info.kind, "archive");
      assert.equal(model.info.hasMetadata, true);
      assert.equal(model.info.metadataVersion, 1);

      const archive = model.modules.filter((m) => m.kind === "archive");
      assert.equal(archive.length, 1);
      assert.deepEqual(archive[0]?.counts, { signals: 2, funcs: 2, types: 1 });
      // app.o 走元数据；main.o 没有元数据，也会保留一个 0 计数的文件模块，
      // 这样在视图里能看到成员确实存在，而不是凭空消失。
      assert.deepEqual(
        model.modules.filter((m) => m.kind === "file").map((m) => m.id),
        ["libapp/app::demo", "libapp/main::main"],
      );
      assert.deepEqual(archive[0]?.children, ["libapp/app::demo", "libapp/main::main"]);
      // 成员级 no-metadata 被抑制，归档层只在完全没有元数据时报警。
      assert.equal(model.diagnostics.length, 0);
    },
  );
});

test("ar: 空归档（没有任何元数据成员）给出 no-metadata", async () => {
  const main = buildElf([], { includeMeta: false });
  await withTempFile("empty.a", buildAr([{ name: "main.o", data: main }]), async (file) => {
    const model = await readArtifact(file);
    assert.equal(model.info.hasMetadata, false);
    assert.ok(model.diagnostics.some((d) => d.code === "no-metadata"));
  });
});

/**
 * 真实模板产物集成测试：`templates/c/example` 未编译时跳过。
 *
 * 这条锁的是「模板与读取器对同一份布局的理解」——合成测试只能证明读取器
 * 符合我们以为的布局，真实产物才能证明 C 编译器也确实按这个布局写。
 */
test("elf: 模板示例的真实产物（若已编译）", async (t) => {
  const sample = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "templates",
    "c",
    "example",
    "app.out",
  );
  if (!fs.existsSync(sample)) {
    t.skip("templates/c/example 尚未编译");
    return;
  }

  const model = await readArtifact(sample);
  assert.equal(model.info.kind, "exe");
  assert.equal(model.info.metadataVersion, 1);

  // 模板示例覆盖了 enum 与 struct 两种类型；按名字找而不是按下标，
  // 这样以后在 app.c 里增删类型不会连带弄坏这条断言。
  const state = model.types.find((t) => t.name === "DcState");
  assert.deepEqual(
    state?.fields.map((f) => f.name),
    ["voltage", "count", "gain", "mode", "flags"],
  );
  assert.equal(state?.kind, "struct");
  assert.equal(state?.store, true);
  const mode = model.types.find((t) => t.name === "DcMode");
  assert.equal(mode?.kind, "enum");
  // 枚举成员进入字段表，初值列就是成员值。
  assert.deepEqual(
    mode?.fields.map((f) => [f.name, f.initial]),
    [
      ["DC_MODE_IDLE", "0"],
      ["DC_MODE_RUN", "1"],
      ["DC_MODE_FAULT", "2"],
    ],
  );

  // 方向/分组/单位/初值来自 tag 字符串，应与 C# 的 Direction/Path/Unit/Initial 同义。
  const voltage = model.signals.find((s) => s.name === "g_output_voltage");
  assert.equal(voltage?.dir, "out");
  assert.equal(voltage?.path, "demo");
  assert.equal(voltage?.unit, "V");
  assert.equal(voltage?.initial, "0");
  const st = model.signals.find((s) => s.name === "g_state");
  assert.equal(st?.dir, "inout");
  assert.equal(st?.path, "state");
  assert.deepEqual(st?.tags, ["store"]);

  // 函数返回类型与参数（含方向）来自 DC_FUNCTION_AS / DC_PARAM。
  const filter = model.funcs.find((f) => f.name === "filter_sample");
  assert.equal(filter?.ret, "int32");
  assert.deepEqual(
    filter?.params.map((p) => [p.name, p.ctype, p.dir]),
    [
      ["sample", "double", "in"],
      ["out", "double *", "out"],
    ],
  );
  // 参数 tag 里的 unit/alias 与信号走同一套解析，不能解析后丢掉。
  assert.deepEqual(
    filter?.params.map((p) => [p.unit ?? "", p.alias ?? ""]),
    [
      ["V", "采样"],
      ["V", "结果"],
    ],
  );

  assert.equal(model.signals.length, 10);
  assert.equal(model.funcs.length, 10);
  // 35 条全部来自 DC_READ/DC_WRITE/DC_CALL：app.out 链接时没带 --emit-relocs，
  // 不该出现任何推断边。
  assert.equal(model.edges.length, 35);
  assert.equal(model.edges.filter((e) => e.inferred === true).length, 0);
  // 示例是「给人抄的」，读写边要闭合；出现悬空边说明示例本身写漏了。
  assert.equal(model.diagnostics.length, 0);
});
