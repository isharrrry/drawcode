/**
 * 小端字节读取器。
 *
 * 所有偏移都是**文件绝对偏移**。越界一律抛 `RangeError`：二进制格式里「读到哪算哪」
 * 会让后续字段全部错位，产出一个看起来正常、其实全错的模型 —— 那比直接失败更糟。
 * 上层（`pe.ts` / `elf.ts`）捕获后转成 `truncated-section` 诊断。
 *
 * 为什么自己包一层而不是到处 `new DataView(...)`：
 * Buffer 的底层 ArrayBuffer 可能带 offset（Node 的 slab 分配），直接用
 * `new DataView(buf.buffer)` 会从错误的原点开始读。这里统一处理一次。
 */

export class ByteView {
  private readonly data: DataView;
  private readonly bytes: Uint8Array;

  // 显式字段而不是构造函数参数属性：项目启用了 erasableSyntaxOnly，
  // 参数属性会在编译时生成赋值语句，不属于可擦除语法。
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.data.byteLength;
  }

  private need(offset: number, size: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset + size > this.data.byteLength) {
      throw new RangeError(
        `读取越界：offset=${offset} size=${size}，文件长度=${this.data.byteLength}`,
      );
    }
  }

  u8(offset: number): number {
    this.need(offset, 1);
    return this.data.getUint8(offset);
  }

  u16(offset: number): number {
    this.need(offset, 2);
    return this.data.getUint16(offset, true);
  }

  /** 无符号 32 位。JS 的位运算会带符号，这里统一 `>>> 0`。 */
  u32(offset: number): number {
    this.need(offset, 4);
    return this.data.getUint32(offset, true);
  }

  i32(offset: number): number {
    this.need(offset, 4);
    return this.data.getInt32(offset, true);
  }

  u64(offset: number): bigint {
    this.need(offset, 8);
    return this.data.getBigUint64(offset, true);
  }

  i64(offset: number): bigint {
    this.need(offset, 8);
    return this.data.getBigInt64(offset, true);
  }

  f32(offset: number): number {
    this.need(offset, 4);
    return this.data.getFloat32(offset, true);
  }

  f64(offset: number): number {
    this.need(offset, 8);
    return this.data.getFloat64(offset, true);
  }

  /** 取子区间（复制）。调用方拿到的是一份独立字节，不会被后续读取影响。 */
  slice(offset: number, size: number): Uint8Array {
    this.need(offset, size);
    return this.bytes.slice(offset, offset + size);
  }

  /**
   * 读取以 NUL 结尾的 UTF-8 字符串，返回 [文本, 结束后偏移]。
   * `end` 由调用方给出（堆或元数据根的边界），避免一个坏字符串吃到文件尾。
   */
  cstring(offset: number, end: number = this.length): [string, number] {
    if (offset < 0 || offset > end || end > this.length) {
      throw new RangeError(`字符串越界：offset=${offset} end=${end}`);
    }
    let at = offset;
    while (at < end && this.data.getUint8(at) !== 0) at++;
    const raw = this.bytes.subarray(offset, at);
    // 元数据里的 #Strings 与 ELF 的符号名都是 UTF-8；非法序列用替换符而不是抛错，
    // 因为一个坏名字不该让整份产物无法浏览。
    const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
    return [text, at + 1];
  }
}

/**
 * ECMA-335 II.23.2 压缩无符号整数。
 *
 * 三种前缀决定长度：`0xxxxxxx` 1 字节、`10xxxxxx` 2 字节、`110xxxxx` 4 字节。
 * 元数据里所有「计数」和 blob 内嵌的 table 索引都走这个编码。
 */
export function readCompressedUInt(
  view: ByteView,
  offset: number,
): { value: number; next: number } {
  const b0 = view.u8(offset);
  if ((b0 & 0x80) === 0) return { value: b0, next: offset + 1 };
  if ((b0 & 0xc0) === 0x80) {
    return { value: ((b0 & 0x3f) << 8) | view.u8(offset + 1), next: offset + 2 };
  }
  if ((b0 & 0xe0) === 0xc0) {
    const value =
      ((b0 & 0x1f) << 24) |
      (view.u8(offset + 1) << 16) |
      (view.u8(offset + 2) << 8) |
      view.u8(offset + 3);
    return { value: value >>> 0, next: offset + 4 };
  }
  throw new RangeError(`非法压缩整数前缀 0x${b0.toString(16)} @ ${offset}`);
}
