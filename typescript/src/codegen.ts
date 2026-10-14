/**
 * IR → 源码（反向回写）。对等 Python `codegen.py`。
 *
 * **只碰声明层**：注解行 + 声明行。函数体、语句、格式一律不动 —— 这是硬承诺，
 * 否则 `drawcode sync` 就成了会改坏用户代码的危险工具。
 *
 * 三处必须讲清楚的实现细节：
 *
 *   1. **C 与 C# 的追加分支必须对称**。`syncHeader`（C）与 `syncCsSource`（C#）都要能处理
 *      "IR 里有、源码里还没有"的新信号，把它们追加到文件末尾 / 类体末尾。历史上 C# 侧漏了
 *      这一支，表现为一个测试失败、另一个测试**空转通过**（幂等断言恒真，验证不到自己声称的性质）。
 *   2. **数组写法不同**：C 是 `T name[N]`，C# 是 `T[] name`。类型串若带着 C 的
 *      `float[32]` 直接写进 C# 会生成非法代码，所以要 `[N] -> []`。
 *   3. **合并而非覆盖**：`mergeAnnotation` 保留 drawcode 不管理的键（手写的 `xy`/`size`），
 *      并维持它们原有的顺序。给一个已注解的函数加 note，不该悄悄丢掉它的坐标。
 */

import { FUNC_RE, KV_RE } from "./cparse.ts";
import { readTextFile, splitlines, writeTextFile } from "./fsutil.ts";
import type { Device, Func, Model, Signal } from "./model.ts";
import { findAllGroups, matchAt } from "./regex.ts";

const SIGNAL_LINE_RE =
  /^\s*(?<ctype>(?:[A-Za-z_]\w*[\s*]+)+)(?<name>[A-Za-z_]\w*)\s*(?<arr>\[[^\]]*\])?\s*;/;
const CTYPE_RE = /^(?<base>.+?)(?<arr>\[[^\]]*\])?$/;

const DIR_KEY: Record<string, string> = { in: "in", out: "out", inout: "io" };

export function splitCtype(ctype: string): [string, string] {
  const m = matchAt(CTYPE_RE, ctype.trim());
  if (m === null) return [ctype.trim(), ""];
  return [(m.groups?.base as string).trim(), m.groups?.arr ?? ""];
}

function kvLine(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `${k}="${v}"`).join(" ");
}

export function renderAnnotation(sig: Signal): string {
  const kv: Array<[string, string]> = [];
  if (sig.unit) kv.push(["unit", sig.unit]);
  if (sig.alias) kv.push(["alias", sig.alias]);
  if (sig.note) kv.push(["note", sig.note]);
  if (sig.external) kv.push(["external", "true"]);
  const rest = kvLine(kv);
  return `/// @drawcode dir=${DIR_KEY[sig.dir] as string}${rest === "" ? "" : " " + rest}`;
}

/**
 * 一个信号的完整声明块：注解行 + 声明行。
 *
 * 注意 C 侧的数组写法是 `T name[N]`，所以 ctype 要拆成「基类型 + 方括号部分」再拼回去
 * （C# 侧写法不同，见 renderCsAnnotation）。
 */
export function renderSignal(sig: Signal): string {
  const [base, arr] = splitCtype(sig.ctype);
  return `${renderAnnotation(sig)}\n${base} ${sig.name}${arr};`;
}

export function renderFuncKv(func: Func): Array<[string, string]> {
  const kv: Array<[string, string]> = [];
  if (func.alias) kv.push(["alias", func.alias]);
  if (func.tooltip) kv.push(["tooltip", func.tooltip]);
  if (func.note) kv.push(["note", func.note]);
  if (func.external) kv.push(["external", "true"]);
  return kv;
}

export function renderDeviceKv(dev: Device | undefined): Array<[string, string]> {
  if (dev === undefined) return [];
  const pairs: Array<[string, string]> = [
    ["vendor", dev.vendor],
    ["model", dev.model],
    ["spec", dev.spec],
    ["size", dev.size],
    ["asset", dev.asset],
  ];
  return pairs.filter(([, v]) => v !== "");
}

/** 保留原行里 drawcode 未管理的属性（如手写的 xy/size），并保持原有顺序。 */
function mergeAnnotation(origLine: string, kvNew: Array<[string, string]>): string {
  const next = new Map<string, string>(kvNew);
  const out: Array<[string, string]> = [];
  const used = new Set<string>();
  for (const [k, v] of findAllGroups(KV_RE, origLine)) {
    const key = k as string;
    if (next.has(key)) {
      out.push([key, next.get(key) as string]);
      used.add(key);
    } else {
      out.push([key, v as string]);
    }
  }
  for (const [k, v] of kvNew) {
    if (!used.has(k)) out.push([k, v]);
  }
  return `/// @drawcode ${kvLine(out)}`;
}

function funcBlock(func: Func, dev: Device | undefined, orig: string[]): string[] {
  const kv = renderFuncKv(func);
  const devKv = renderDeviceKv(dev);
  const origAnnotation = orig.find((l) => l.replace(/^\s+/, "").startsWith("/// @drawcode"));
  const out: string[] = [];
  if (kv.length > 0 || origAnnotation !== undefined) {
    out.push(
      origAnnotation !== undefined
        ? mergeAnnotation(origAnnotation, kv)
        : `/// @drawcode ${kvLine(kv)}`,
    );
  }
  if (devKv.length > 0) out.push(`/// @device ${kvLine(devKv)}`);
  out.push(
    ...orig.filter((l) => {
      const s = l.replace(/^\s+/, "");
      return !s.startsWith("/// @drawcode") && !s.startsWith("/// @device");
    }),
  );
  return out;
}

export function syncFunctions(path: string, model: Model, rel: string): boolean {
  const text = readTextFile(path);
  const lines = splitlines(text);
  const funcs = new Map<string, Func>();
  for (const f of model.funcs.values()) {
    if (f.file === rel) funcs.set(f.name, f);
  }
  if (funcs.size === 0) return false;

  const spans: Array<[number, number, string]> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = matchAt(FUNC_RE, (lines[i] as string).trim());
    const name = m?.groups?.name;
    if (m === null || name === undefined || !funcs.has(name)) continue;
    let j = i - 1;
    while (j >= 0 && (lines[j] as string).trim().startsWith("///")) j--;
    spans.push([j + 1, i, name]);
  }

  const newLines = [...lines];
  for (const [start, end, name] of [...spans].reverse()) {
    const f = funcs.get(name) as Func;
    const block = newLines.slice(start, end);
    const rendered = funcBlock(f, model.devices.get(f.id), block);
    if (block.length !== rendered.length || block.some((l, i) => l !== rendered[i])) {
      newLines.splice(start, end - start, ...rendered);
    }
  }

  if (newLines.length === lines.length && newLines.every((l, i) => l === lines[i])) return false;
  let result = newLines.join("\n");
  if (text.endsWith("\n")) result += "\n";
  writeTextFile(path, result);
  return true;
}

const CS_DIR: Record<string, string> = { in: "In", out: "Out", inout: "Io" };
const CS_ATTR_RE = /^\s*\[\s*Drawcode\s*\(/;
const CS_FIELD_LINE_RE = new RegExp(
  "^\\s*(?:(?:public|private|internal|protected|static|readonly|const|volatile)\\s+)*" +
    "(?<ctype>[A-Za-z_][\\w\\.<>,\\[\\]\\?]*)\\s+(?<name>[A-Za-z_]\\w*)\\s*(?<init>=[^;]*)?;\\s*$",
);

function csArgs(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `${k} = "${v}"`).join(", ");
}

/** `[Drawcode(Direction.In, Unit = "…", Alias = "…")]` —— 方向只出现在信号上。 */
export function renderCsAnnotation(sig: Signal): string[] {
  const kv: Array<[string, string]> = [];
  if (sig.unit) kv.push(["Unit", sig.unit]);
  if (sig.alias) kv.push(["Alias", sig.alias]);
  if (sig.note) kv.push(["Note", sig.note]);
  if (sig.external) kv.push(["External", "true"]);
  const head = `Direction.${CS_DIR[sig.dir] as string}`;
  const args = kv.length === 0 ? head : `${head}, ${csArgs(kv)}`;
  return [`[Drawcode(${args})]`];
}

/** 回写 C# 声明层：`[Drawcode(Direction.X, …)]` 特性。 */
export function syncCsSource(path: string, model: Model, rel: string): boolean {
  const text = readTextFile(path);
  const lines = splitlines(text);
  const wanted = new Map<string, Signal>();
  for (const s of model.signals.values()) {
    if (s.file === rel) wanted.set(s.name, s);
  }

  interface Span {
    start: number;
    end: number;
    name: string;
  }
  const spans: Span[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = matchAt(CS_FIELD_LINE_RE, lines[i] as string);
    const name = m?.groups?.name;
    if (m === null || name === undefined || !wanted.has(name)) continue;
    const hasAttr = i > 0 && CS_ATTR_RE.test(lines[i - 1] as string);
    spans.push({ start: hasAttr ? i - 1 : i, end: i, name });
  }

  const newLines = [...lines];
  for (const span of [...spans].reverse()) {
    const sig = wanted.get(span.name) as Signal;
    const fieldLine = lines[span.end] as string;
    const indent = fieldLine.slice(0, fieldLine.length - fieldLine.replace(/^\s+/, "").length);
    const rendered = [...renderCsAnnotation(sig).map((l) => indent + l), fieldLine];
    const current = newLines.slice(span.start, span.end + 1);
    if (current.length !== rendered.length || current.some((l, i) => l !== rendered[i])) {
      newLines.splice(span.start, span.end + 1 - span.start, ...rendered);
    }
  }

  const known = new Set(spans.map((s) => s.name));
  const extra = [...wanted.keys()].filter((n) => !known.has(n));
  if (extra.length > 0) {
    let anchor: number | null = null;
    for (let i = 0; i < newLines.length; i++) {
      if (CS_FIELD_LINE_RE.test(newLines[i] as string)) anchor = i + 1;
    }
    if (anchor === null) {
      for (let i = newLines.length - 1; i >= 0; i--) {
        if ((newLines[i] as string).trim() === "}") {
          anchor = i;
          break;
        }
      }
    }
    if (anchor === null) anchor = newLines.length;
    let indent = "        ";
    for (const line of newLines) {
      if (CS_FIELD_LINE_RE.test(line)) {
        indent = line.slice(0, line.length - line.replace(/^\s+/, "").length);
        break;
      }
    }
    const add: string[] = [];
    for (const name of [...extra].sort()) {
      const sig = wanted.get(name) as Signal;
      add.push(...renderCsAnnotation(sig).map((l) => indent + l));
      add.push(`${indent}public static ${sig.ctype.replace(/\[\s*\d+\s*\]/, "[]")} ${sig.name};`);
      add.push("");
    }
    newLines.splice(anchor, 0, ...add);
  }

  if (newLines.length === lines.length && newLines.every((l, i) => l === lines[i])) return false;
  let result = newLines.join("\n");
  if (text.endsWith("\n")) result += "\n";
  writeTextFile(path, result);
  return true;
}

interface Block {
  start: number;
  end: number;
  name: string;
}

/**
 * 找出文件里所有「信号声明块」的位置：块 = 声明行本身 + 它上方连续的 `///` 注解行。
 *
 * 与解析侧的规则一致：注解块必须紧贴声明，中间不能有空行。
 * 回写时按 start..end 整块替换，所以块的边界画错会吃掉相邻代码。
 */
function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = matchAt(SIGNAL_LINE_RE, lines[i] as string);
    const name = m?.groups?.name;
    if (m === null || name === undefined) continue;
    let j = i - 1;
    while (j >= 0 && (lines[j] as string).trim().startsWith("///")) j--;
    out.push({ start: j + 1, end: i, name });
  }
  return out;
}

/**
 * C 头文件的声明层回写。
 *
 * 两段：(1) 已存在的声明块就地把注解行重写一遍；(2) **IR 里有、文件里没有的信号追加到 `#endif` 之前**。
 *
 * 第 (2) 段是 C 与 C# 必须对称的能力 —— 代码里新建一个信号、跑 `sync`，它得真的出现在源码里。
 * C# 侧历史上漏了这一支，症状是一个测试失败、另一个测试**空转通过**。
 */
export function syncHeader(path: string, model: Model, rel: string): boolean {
  const text = readTextFile(path);
  const lines = splitlines(text);
  const wanted = new Map<string, Signal>();
  for (const s of model.signals.values()) {
    if (s.file === rel) wanted.set(s.name, s);
  }
  const found = blocks(lines);

  const newLines = [...lines];
  for (const block of [...found].reverse()) {
    const sig = wanted.get(block.name);
    if (sig === undefined) continue;
    const rendered = splitlines(renderSignal(sig));
    const current = newLines.slice(block.start, block.end + 1);
    if (current.length !== rendered.length || current.some((l, i) => l !== rendered[i])) {
      newLines.splice(block.start, block.end + 1 - block.start, ...rendered);
    }
  }

  const known = new Set(found.map((b) => b.name));
  const missing = [...wanted.entries()]
    .filter(([n]) => !known.has(n))
    .map(([, s]) => s)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (missing.length > 0) {
    let idx = newLines.length;
    for (let i = newLines.length - 1; i >= 0; i--) {
      if ((newLines[i] as string).trim().startsWith("#endif")) {
        idx = i;
        break;
      }
    }
    const add: string[] = [];
    for (const s of missing) {
      add.push(...splitlines(renderSignal(s)));
      add.push("");
    }
    newLines.splice(idx, 0, ...add);
  }

  if (newLines.length === lines.length && newLines.every((l, i) => l === lines[i])) return false;
  let result = newLines.join("\n");
  if (text.endsWith("\n")) result += "\n";
  writeTextFile(path, result);
  return true;
}

/** 按语言分派回写；C 与 C# 的声明语法不同，绝不能互相套用。 */
export function syncSource(path: string, model: Model, rel: string): boolean {
  if (path.toLowerCase().endsWith(".cs")) return syncCsSource(path, model, rel);
  const touched = syncHeader(path, model, rel);
  return syncFunctions(path, model, rel) || touched;
}
