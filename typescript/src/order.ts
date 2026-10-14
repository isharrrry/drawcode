/**
 * 排序比较器 —— 必须按 **Unicode 码点** 比，而不是 JS 默认的 UTF-16 码元。
 *
 * 为什么较真：`Array.prototype.sort()` 的默认比较把字符串按 UTF-16 码元排，
 * 于是任何 U+FFFF 以上的字符（emoji、部分 CJK 扩展）顺序都会和 Python 的
 * `sorted()` 不同。symbolId 里混进一个 emoji 就会出现"三版产出不同顺序"的幽灵 bug。
 */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const ac = Array.from(a);
  const bc = Array.from(b);
  const shared = Math.min(ac.length, bc.length);
  for (let i = 0; i < shared; i++) {
    const ca = (ac[i] as string).codePointAt(0) as number;
    const cb = (bc[i] as string).codePointAt(0) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  if (ac.length === bc.length) return 0;
  return ac.length < bc.length ? -1 : 1;
}

/** 对等 Python `sorted(list_of_str)`。 */
export function sortedCopy(values: Iterable<string>): string[] {
  return [...values].sort(compareCodePoints);
}
