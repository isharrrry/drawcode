import * as fs from "node:fs";
import * as nodePath from "node:path";

/**
 * 读源码必须显式 UTF-8。Node 的 `readFileSync(p, "utf8")` 与 Python 的
 * `open(p, encoding="utf-8")` 行为一致：**都保留 BOM**（`utf-8-sig` 才吃掉它）。
 * 两版一致就够了 —— 但要知道第一行会带一个 \uFEFF。
 */
export function readTextFile(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/** 对等 Python `open(path, "w", encoding="utf-8", newline="")`：不做换行转换。 */
export function writeTextFile(file: string, text: string): void {
  fs.writeFileSync(file, text, "utf8");
}

const LINE_BOUNDARY = new Set([
  "\n",
  "\r",
  "\v",
  "\f",
  "\x1c",
  "\x1d",
  "\x1e",
  "\x85",
  "\u2028",
  "\u2029",
]);

/**
 * 对等 Python `str.splitlines()`。
 *
 * 为什么不能直接用 `text.split(/\r?\n/)`：那个在 "a\n" 上返回 `["a", ""]`，
 * 而 Python 返回 `["a"]`。codegen 靠"行数组是否相等"决定要不要写盘，
 * 多出来的空串会让**没被改动的文件被重写一遍**。
 */
export function splitlines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (LINE_BOUNDARY.has(ch)) {
      out.push(text.slice(start, i));
      i++;
      if (ch === "\r" && text.charAt(i) === "\n") i++;
      start = i;
      continue;
    }
    i++;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** 对等 Python `os.path.relpath(target, root).replace("\\", "/")`。 */
export function relPath(target: string, root: string): string {
  return nodePath.relative(nodePath.resolve(root), nodePath.resolve(target)).replace(/\\/g, "/");
}

/** 对等 Python `os.path.splitext(os.path.basename(rel))[0]`。 */
export function stem(rel: string): string {
  return nodePath.basename(rel, nodePath.extname(rel));
}

export function abspath(p: string): string {
  return nodePath.resolve(p);
}

export function dirname(p: string): string {
  return nodePath.dirname(p);
}

export function basename(p: string): string {
  return nodePath.basename(p);
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

/** 对等 Python `os.makedirs(dirname or ".", exist_ok=True)`。 */
export function ensureDir(p: string): void {
  fs.mkdirSync(p === "" ? "." : p, { recursive: true });
}

/** 对等 Python `str.count(sub)`（不重叠计数）。 */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return haystack.length + 1;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}
