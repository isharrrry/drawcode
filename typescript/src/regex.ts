/**
 * Python `re` ↔ JS `RegExp` 之间的桥。
 *
 * 这里存在的唯一理由是 `lastIndex`：JS 正则一旦带 `g`，`exec()` 会从上次的
 * 位置接着找 —— 同一个正则对象复用两次就静默漏掉前半段。Python 的
 * `findall`/`search` 从不这样。所有辅助函数因此**每次构造新的正则对象**。
 */

function withoutState(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.replace(/[gy]/g, ""));
}

function withGlobal(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.replace(/[gy]/g, "") + "g");
}

/** 对等 Python `re.findall(pattern, text)`（无捕获组时返回整体匹配）。 */
export function findAll(re: RegExp, text: string): string[] {
  return [...text.matchAll(withGlobal(re))].map((m) => m[0]);
}

/** 对等 Python `re.findall(pattern, text)`（返回捕获组元组）。 */
export function findAllGroups(re: RegExp, text: string): string[][] {
  return [...text.matchAll(withGlobal(re))].map((m) => m.slice(1));
}

/** 只有一个捕获组时的便捷写法。 */
export function findAll1(re: RegExp, text: string): string[] {
  return [...text.matchAll(withGlobal(re))].map((m) => m[1] as string);
}

/**
 * 对等 Python `re.match(pattern, text)`：锚定在位置 0，但**不是**整串匹配。
 * JS 的 `String.prototype.match` 做不到这一点（它要么 search 要么整串），
 * 所以这里显式检查 `index === 0`。
 */
export function matchAt(re: RegExp, text: string): RegExpExecArray | null {
  const m = withoutState(re).exec(text);
  return m !== null && m.index === 0 ? m : null;
}

/** 对等 Python `re.search(pattern, text)`。 */
export function search(re: RegExp, text: string): RegExpExecArray | null {
  return withoutState(re).exec(text);
}

/** 对等 Python `re.sub(pattern, repl, text)`（全局替换）。 */
export function sub(re: RegExp, replacement: string, text: string): string {
  return text.replace(withGlobal(re), replacement);
}

/** JS 没有 `re.Pattern` 的类型别名烦恼；这个只为了让调用点读起来像 Python。 */
export type Pattern = RegExp;
