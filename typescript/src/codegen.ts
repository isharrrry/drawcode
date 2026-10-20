/**
 * IR → 源码（反向回写）。对等 Python `codegen.py`。
 *
 * **只碰声明层**：注解行 + 声明行。函数体、语句、格式一律不动 —— 这是硬承诺，
 * 否则 `drawcode sync` 就成了会改坏用户代码的危险工具。
 *
 * 四处必须讲清楚的实现细节：
 *
 *   1. **C 与 C# 的追加分支必须对称**。`syncHeader`（C）与 `syncCsSource`（C#）都要能处理
 *      "IR 里有、源码里还没有"的新信号，把它们追加到文件末尾 / 类体末尾。历史上 C# 侧漏了
 *      这一支，表现为一个测试失败、另一个测试**空转通过**（幂等断言恒真，验证不到自己声称的性质）。
 *   2. **数组写法不同**：C 是 `T name[N]`，C# 是 `T[] name`。类型串若带着 C 的
 *      `float[32]` 直接写进 C# 会生成非法代码，所以要 `[N] -> []`。
 *   3. **合并而非覆盖，且 C 与 C# 的合并不能共用一套实现**。注解行绝不允许"整行重建"：
 *      整行重建只能输出受管键，源码上手写的 `xy`/`size`/`style` 会被静默抹掉。
 *      C 的注解是空格分隔的 `k="v"`（`dir` 是唯一裸值键），C# 是逗号分隔的 `Key = "value"`
 *      且第一个实参是位置参数 `Direction.X` —— 语法不同、分隔符语义也不同（C# 的
 *      `Xy = "360,130"` 里逗号在引号内、不能当实参分隔符切），共用一套只会两边都写错。
 *      唯一共享的纪律是「值没变就连原始空白都不动」。
 *   4. **几何回写**（`model.pinned`，见 model.ts 的 PinnedGeom）：只有"人拖过"的实体
 *      （读回值与 build 本来会写出的值不同）才在注解里生成/替换 `xy`/`size`。没人动过 ⇒
 *      所有 sync 产物与源文件**逐字节相同** —— 这是本能力的头号验收标准，也是上面第 3 条
 *      「值没变不动原文」的由来。Python 侧尚未跟进该能力；无人拖动时产物与旧版逐字节一致，
 *      两版对拍因此不受影响。
 */

import { FUNC_RE } from "./cparse.ts";
import { CS_FUNC_RE } from "./csparse.ts";
import { readTextFile, splitlines, writeTextFile } from "./fsutil.ts";
import type { Device, Func, Model, PinnedGeom, Signal } from "./model.ts";
import { num } from "./num.ts";
import { matchAt } from "./regex.ts";

const SIGNAL_LINE_RE =
  /^\s*(?<ctype>(?:[A-Za-z_]\w*[\s*]+)+)(?<name>[A-Za-z_]\w*)\s*(?<arr>\[[^\]]*\])?\s*;/;
const CTYPE_RE = /^(?<base>.+?)(?<arr>\[[^\]]*\])?$/;

const DIR_KEY: Record<string, string> = { in: "in", out: "out", inout: "io" };

/**
 * 从图里接回来的信号可能没有类型（用户在节点上只写了个名字）。
 * 这时落一个占位类型而不是留空 —— 留空会写出一条不是声明的 `g_unknown;`，
 * 解析器读不回来，下一次 sync 就会把它当成新元素再追加一遍（不幂等）。
 * `%s` 由 PLACEHOLDER_TODO 填充。
 */
const PLACEHOLDER_CTYPE = "int";
const PLACEHOLDER_TODO = "/* drawcode: 未能从图里认出类型，暂用 %s —— 请改成实际类型 */";

export function splitCtype(ctype: string): [string, string] {
  const m = matchAt(CTYPE_RE, ctype.trim());
  if (m === null) return [ctype.trim(), ""];
  return [(m.groups?.base as string).trim(), m.groups?.arr ?? ""];
}

/**
 * 一个键值对的注解形态。
 *
 * `dir` 是 C 注解里**唯一**用裸值的键（`dir=in`，不是 `dir="in"`），其余一律带引号。
 * 这不是风格问题：cparse 的读取顺序是「先 KV_RE（带引号）、再 KV_BARE_RE（裸值）补齐」，
 * 既有源码、金标准与手写文档全部是 `dir=` 裸写 —— 回写必须产出同一种写法。
 */
function renderKvPair(key: string, value: string): string {
  return key === "dir" ? `${key}=${value}` : `${key}="${value}"`;
}

function kvLine(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => renderKvPair(k, v)).join(" ");
}

/**
 * 「人拖过的几何」→ 注解键值对；没有 `pinned` 项时返回空数组（⇒ 一个键都不写）。
 *
 * 两个键名因语言而不同（C 是 `xy`/`size`，C# 是 `Xy`/`Size`），分隔符却必须两个前端一致：
 *   - `xy`  用**逗号**：`"420,160"` —— cparse/csparse 的 applyGeometry 都是 `v.split(",")`；
 *   - `size` 用**小写 x**：`"180x72"` —— 两边都是 `v.toLowerCase().split("x")`。
 * 写错分隔符（`180*72`、大写 `X`、或把逗号写成别的）不会报错，只会静默得到 NaN 尺寸，
 * 所以这里按解析器的切法逐字对齐。数字一律走 `num()`：与 drawio 写 XML 几何是同一个
 * 格式化函数，保证 `120` 不写成 `120.0` —— 否则同一份几何在 .drawio 与源码里两个写法，
 * 回读比对永远对不上。
 */
function geomKv(
  xyKey: string,
  sizeKey: string,
  pinned: PinnedGeom | undefined,
): Array<[string, string]> {
  if (pinned === undefined) return [];
  const out: Array<[string, string]> = [];
  if (pinned.xy !== undefined) {
    const [x, y] = pinned.xy;
    out.push([xyKey, `${num(x)},${num(y)}`]);
  }
  if (pinned.size !== undefined) {
    const [w, h] = pinned.size;
    out.push([sizeKey, `${num(w)}x${num(h)}`]);
  }
  return out;
}

/**
 * 一个信号注解的受管键值对（C 侧，含 dir）。
 *
 * `dir` 只在方向是合法枚举值时出现：IR 里 `dir` 是空串是**合法状态**（注解没写方向），
 * 但注解语法认不出「空方向」这个值，硬写会得到 `dir=undefined`。
 */
function signalKv(sig: Signal, pinned: PinnedGeom | undefined): Array<[string, string]> {
  const kv: Array<[string, string]> = [];
  const dir = DIR_KEY[sig.dir];
  if (dir !== undefined) kv.push(["dir", dir]);
  if (sig.unit) kv.push(["unit", sig.unit]);
  if (sig.alias) kv.push(["alias", sig.alias]);
  if (sig.note) kv.push(["note", sig.note]);
  if (sig.external) kv.push(["external", "true"]);
  kv.push(...geomKv("xy", "size", pinned));
  return kv;
}

/**
 * 一行信号注解。**键全空时也必须落一个键**：解析侧把「注解里至少有一个键」当作
 * 信号的判据（`meta.size > 0`，见 cparse），光写 `/// @drawcode` 的声明读不回 IR，
 * 下一次 sync 会把它当成新元素再追加一遍。`dir=""` 表示「没有方向」—— 它是 IR 里的
 * 合法值（model.ts 的 Direction），读出侧两种识别规则（`dir` 键存在 / 有键）都认它。
 *
 * 注意这只影响**渲染新行**；合并既有行时用的 signalKv 在方向为空时不含 dir，
 * 免得给一条本来就没写方向的注解硬塞一个 `dir=""`，破坏「没人动过 ⇒ 逐字节不变」。
 */
export function renderAnnotation(sig: Signal, pinned?: PinnedGeom): string {
  const kv = signalKv(sig, pinned);
  return kv.length === 0 ? '/// @drawcode dir=""' : `/// @drawcode ${kvLine(kv)}`;
}

/**
 * 一个信号的完整声明块：注解行 + 声明行。
 *
 * 注意 C 侧的数组写法是 `T name[N]`，所以 ctype 要拆成「基类型 + 方括号部分」再拼回去
 * （C# 侧写法不同，见 renderCsAnnotation）。
 *
 * 类型可能为空（元素是从图里接回来的，label 只写了名字）。这时**必须**落一个
 * 真实类型名，不能只写标识符本身：
 *
 *   1. 文件作用域的 `g_unknown;` 不是声明，不是合法 C；
 *   2. 解析器要求 `<type> <name>;`，只写名字就读不回来 —— 下一次 sync 会把
 *      它当成「图里新加的元素」再追加一遍，于是 sync 不幂等。
 *
 * TODO 放在**单独一行**（不是行尾），否则 SIGNAL_RE 的 `;$` 就匹配不上。
 * 而且**必须排在注解行之前**：TODO 是块注释，夹在注解与声明之间会把注解从缓冲里截断
 * （解析侧遇到非 `///` 行就清缓冲），那条注解就丢了，信号下次又会被当成新元素。
 */
export function renderSignal(sig: Signal, pinned?: PinnedGeom): string {
  const [baseRaw, arr] = splitCtype(sig.ctype);
  const untyped = baseRaw === "";
  const base = untyped ? PLACEHOLDER_CTYPE : baseRaw;
  const line = `${base} ${sig.name}${arr}`.trim() + ";";
  const out = `${renderAnnotation(sig, pinned)}\n${line}`;
  return untyped ? `${PLACEHOLDER_TODO.replace("%s", base)}\n${out}` : out;
}

/**
 * 为一个只有图形、没有源码的函数生成「签名 + 空实现」。
 *
 * 带空实现是刻意的：只给声明的话 C 侧能编译、链接时才报未定义符号，
 * 错误暴露得太晚；空实现让产物立刻可编译，缺口以注释形式留在原地。
 */
export function renderFuncSkeleton(f: Func): string {
  const ret = f.ret === "" ? "void" : f.ret;
  const params =
    f.params.length > 0
      ? f.params.map((p) => (p.ctype === "" ? p.name : `${p.ctype} ${p.name}`)).join(", ")
      : "void";
  return `${ret} ${f.name}(${params})\n{\n    /* TODO: drawcode 从图里新建，尚未实现 */\n}`;
}

export function renderFuncKv(func: Func, pinned?: PinnedGeom): Array<[string, string]> {
  const kv: Array<[string, string]> = [];
  if (func.alias) kv.push(["alias", func.alias]);
  if (func.tooltip) kv.push(["tooltip", func.tooltip]);
  if (func.note) kv.push(["note", func.note]);
  if (func.external) kv.push(["external", "true"]);
  kv.push(...geomKv("xy", "size", pinned));
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

/**
 * 把 kvNew 合并进一行既有的 C 注解，返回整行。保留 drawcode 不管理的属性
 * （手写的 `xy`/`size`/`style`）并维持原有顺序。
 *
 * 与"整行重建"的差别（都是为了「没人动过 ⇒ 逐字节不变」这条硬标准）：
 *   - 逐段原地替换，而不是按解析出的键值对重排整行：行前缀（`/// @drawcode` 与任何缩进）、
 *     键与键之间的空白、行尾原样保留；只有键值对本身可能被改写；
 *   - **值没变的键连写法都不动**：`dir = in`（多余空格、裸值）不会因为一次无关的合并被
 *     规范化成 `dir=in`，否则每次 sync 都会产生无意义的 diff；
 *   - 值确实要改的键沿用**原键的引号风格**：`dir=in → dir=out`（裸值）、`alias="旧" → alias="新"`；
 *   - 追加的新键用 renderKvPair 的规范写法。
 *
 * 扫描正则同时认带引号（`k="v"`）与裸值（`dir=in`）两种写法 —— 旧实现只认带引号的，
 * 所以它没法复用在信号行上（`dir=in` 会被漏掉）。
 */
function mergeAnnotation(origLine: string, kvNew: Array<[string, string]>): string {
  const next = new Map<string, string>(kvNew);
  const used = new Set<string>();
  let out = "";
  let cursor = 0;
  // 每次调用新建正则：带 g 的正则对象复用会从 lastIndex 接着扫（见 regex.ts 头部）。
  const pairRe = /(\w+)\s*=\s*("[^"]*"|[A-Za-z_]\w*)/g;
  for (const m of origLine.matchAll(pairRe)) {
    const start = m.index as number;
    out += origLine.slice(cursor, start);
    cursor = start + m[0].length;
    const key = m[1] as string;
    const raw = m[2] as string;
    const value = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    const want = next.get(key);
    if (want === undefined) {
      out += m[0]; // 不受管的键（手写 xy/size/style 等）：原样保留
      continue;
    }
    // 只要 kvNew 里也有这个键，无论值是否相同都算「已消费」——否则收尾的
    // "追加缺失键" 循环会把值相同的键再追加一遍，注解里出现重复键。
    used.add(key);
    out += want === value ? m[0] : raw.startsWith('"') ? `${key}="${want}"` : `${key}=${want}`;
  }
  out += origLine.slice(cursor);
  for (const [k, v] of kvNew) {
    if (used.has(k)) continue;
    out += (out.endsWith(" ") ? "" : " ") + renderKvPair(k, v);
  }
  return out;
}

function funcBlock(
  func: Func,
  dev: Device | undefined,
  orig: string[],
  pinned: PinnedGeom | undefined,
): string[] {
  const kv = renderFuncKv(func, pinned);
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
    const rendered = funcBlock(f, model.devices.get(f.id), block, model.pinned.get(f.id));
    if (block.length !== rendered.length || block.some((l, i) => l !== rendered[i])) {
      newLines.splice(start, end - start, ...rendered);
    }
  }

  // 图里有、源码里还没有的函数 —— 这正是「用户在 draw.io 里新加了一个函数节点」
  // 的情形（见 adopt.ts）。追加到文件末尾，并带上空实现骨架，使产物仍能编译过：
  // 只给声明的话，C 侧能编译但链接会报未定义符号。
  const known = new Set(spans.map((s) => s[2]));
  const missing = [...funcs.values()].filter((f) => !known.has(f.name));
  if (missing.length > 0) {
    const add: string[] = [];
    for (const f of missing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const kv = renderFuncKv(f, model.pinned.get(f.id));
      if (kv.length > 0) add.push(`/// @drawcode ${kvLine(kv)}`);
      const devKv = renderDeviceKv(model.devices.get(f.id));
      if (devKv.length > 0) {
        add.push(`/// @device ${devKv.map(([k, v]) => `${k}="${v}"`).join(" ")}`);
      }
      add.push(renderFuncSkeleton(f));
      add.push("");
    }
    while (newLines.length > 0 && (newLines[newLines.length - 1] as string).trim() === "") {
      newLines.pop();
    }
    newLines.push("");
    newLines.push(...add);
  }

  if (newLines.length === lines.length && newLines.every((l, i) => l === lines[i])) return false;
  let result = newLines.join("\n");
  if (text.endsWith("\n")) result += "\n";
  writeTextFile(path, result);
  return true;
}

const CS_DIR: Record<string, string> = { in: "In", out: "Out", inout: "Io" };
const CS_ATTR_RE = /^\s*\[\s*Drawcode\s*\(/;
// 类型与名字都必须与 csparse.ts 的 TYPE_RE / IDENT 用同一字符集：sync 回写时要能认出
// 「中文类型 + 中文字段名」的声明（`public static 数据包 a1_数据包;`），
// 否则中文名信号在回写时会被静默漏掉。
const CS_FIELD_LINE_RE = new RegExp(
  "^\\s*(?:(?:public|private|internal|protected|static|readonly|const|volatile)\\s+)*" +
    "(?<ctype>[\\p{L}_][\\p{L}\\p{N}_\\.<>,\\[\\]\\?]*)\\s+(?<name>[\\p{L}_][\\p{L}\\p{N}_]*)\\s*" +
    "(?<init>=[^;]*)?;\\s*$",
  "u",
);

/** `Key = "value"` / `Key = bareword` 的命名实参（裸值不含逗号；含逗号的只可能是引号值）。 */
const CS_NAMED_ARG_RE = /^\s*(?<key>\w+)\s*=\s*(?:"(?<quoted>[^"]*)"|(?<bare>\w+))\s*$/;
/** 位置参数：`Direction.Out`。方向在 C# 侧是位置参数，让编辑器能补全 `Direction.`。 */
const CS_DIR_ARG_RE = /^\s*Direction\s*\.\s*(?<member>\w+)\s*$/;

function csArgs(pairs: Array<[string, string]>): string {
  // "Direction" 是 csSignalArgs 里的伪键：它是位置参数，规范形态是 `Direction.In`，
  // 不是 `Direction = "In"`。走这里兜底，任何追加路径都不会写出错误形态。
  return pairs
    .map(([k, v]) => (k === "Direction" ? `Direction.${v}` : `${k} = "${v}"`))
    .join(", ");
}

/**
 * C# 信号注解的受管实参（渲染与合并共用同一份，防止两处集合/顺序漂移）。
 *
 * `Direction` 在源码里是**位置参数**（`Direction.In`，不写 `Key = "value"`）。这里用伪键
 * "Direction" 表示它：渲染时落回位置形态，合并时与既有的位置参数对齐替换。
 * 方向为空串（IR 合法值）时不产出该参数，既不写出 `Direction.undefined`，也让合并跳过它。
 */
function csSignalArgs(sig: Signal, pinned: PinnedGeom | undefined): Array<[string, string]> {
  const args: Array<[string, string]> = [];
  const dir = CS_DIR[sig.dir];
  if (dir !== undefined) args.push(["Direction", dir]);
  if (sig.unit) args.push(["Unit", sig.unit]);
  if (sig.alias) args.push(["Alias", sig.alias]);
  if (sig.note) args.push(["Note", sig.note]);
  if (sig.external) args.push(["External", "true"]);
  args.push(...geomKv("Xy", "Size", pinned));
  return args;
}

/**
 * `[Drawcode(Direction.In, Unit = "…", Alias = "…", Xy = "…", Size = "…")]` —— 方向只出现在信号上。
 *
 * 这是**追加新信号**时用的行形态（合并既有行走 mergeCsAnnotationLine）。dir 为空串时
 * 头部的 `Direction.undefined` 是历史行为，保持原样：IR 里合法、语法里无法表达，
 * 不是本函数该悄悄改变的东西（契约外，见报告）。
 */
export function renderCsAnnotation(sig: Signal, pinned?: PinnedGeom): string[] {
  const named = csSignalArgs(sig, pinned).filter(([k]) => k !== "Direction");
  const head = `Direction.${CS_DIR[sig.dir] as string}`;
  const rest = csArgs(named);
  return [`[Drawcode(${rest === "" ? head : `${head}, ${rest}`})]`];
}

/**
 * 引号感知的顶层逗号切分。
 *
 * `Xy = "360,130"` 的逗号在引号里，直接 `body.split(",")` 会把它当一个实参切成两半，
 * 合并后写出 `Xy = "360` + 半个 `130"` 这种会编译失败的垃圾。引号内不做转义处理 ——
 * 与 csparse 的 ARG_RE（`[^"]*`）保持同一套假设，两处对"什么算引号值"的判断必须一致。
 */
function splitTopLevelCommas(body: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inQuote = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
}

/**
 * `[Drawcode(...)]` 的实参体 → 合并后的实参体。**参数级** merge，不是整行重建：
 *
 *   - 位置参数（`Direction.Out`）与认不出的实参一律原样保留（逐字节，连空白都不动）；
 *   - 命名参数只有受管值确实不同才重写（重写为 `Key = "value"` 规范形态）；值相同 ⇒ 原样，
 *     这正是「无人拖动 ⇒ 逐字节不变」的实现方式，也让 `Unit="LSB"` 这种紧凑写法不会被顺手规范化；
 *   - 缺失的受管参数追加到末尾；
 *   - 键名按大小写不敏感匹配（解析侧 ARG_RE 也把键名小写化后再查表），但重写时沿用原键写法。
 */
function mergeCsArgs(body: string, updates: Array<[string, string]>): string {
  if (updates.length === 0) return body;
  const next = new Map(updates.map(([k, v]) => [k.toLowerCase(), v] as [string, string]));
  const used = new Set<string>();
  const out: string[] = [];
  for (const seg of splitTopLevelCommas(body)) {
    const named = matchAt(CS_NAMED_ARG_RE, seg);
    if (named !== null) {
      const key = named.groups?.key as string;
      const value = (named.groups?.quoted ?? named.groups?.bare) as string;
      const want = next.get(key.toLowerCase());
      if (want === undefined) {
        out.push(seg); // 不受管的实参（手写 Style、Unit 之外的键等）：原样保留
        continue;
      }
      // 与 C 侧同理：值相同也要算「已消费」，否则会被当成缺失键追加成重复实参
      // —— `Direction` 伪键尤其致命，那会写出 `Direction.Out, Direction = "Out"`。
      used.add(key.toLowerCase());
      if (want === value) {
        out.push(seg);
        continue;
      }
      const lead = seg.slice(0, seg.length - seg.replace(/^\s+/, "").length);
      out.push(`${lead}${key} = "${want}"`);
      continue;
    }
    const dir = matchAt(CS_DIR_ARG_RE, seg);
    if (dir !== null) {
      const want = next.get("direction");
      if (want === undefined) {
        out.push(seg);
        continue;
      }
      used.add("direction");
      const value = dir.groups?.member as string;
      if (want === value) {
        out.push(seg);
        continue;
      }
      const lead = seg.slice(0, seg.length - seg.replace(/^\s+/, "").length);
      out.push(`${lead}Direction.${want}`);
      continue;
    }
    out.push(seg);
  }
  const missing = updates.filter(([k]) => !used.has(k.toLowerCase()));
  if (missing.length === 0) return out.join(",");
  const add = csArgs(missing);
  const last = out[out.length - 1] as string;
  if (last.trim() === "") {
    // 体是空的（`[Drawcode()]`）或尾随逗号：没有实参可依附，直接落规范写法
    out[out.length - 1] = out.length === 1 && last === "" ? add : ` ${add}`;
  } else {
    out.push(` ${add}`);
  }
  return out.join(",");
}

/**
 * 在一行 `[Drawcode(...)]` 上找到实参体（引号感知地配对 `)`），对它做 mergeCsArgs。
 * 认不出（没有 `[Drawcode(`、括号不闭合）时**原样返回整行** —— 回写工具对看不懂的东西必须
 * 闭嘴：把一行没改动的注解改写坏掉，比不写回更糟。
 */
function mergeCsAnnotationLine(line: string, updates: Array<[string, string]>): string {
  const m = CS_ATTR_RE.exec(line);
  if (m === null) return line;
  const bodyStart = (m.index as number) + m[0].length;
  let inQuote = false;
  let depth = 0;
  for (let i = bodyStart; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch !== ")") continue;
    if (depth > 0) {
      depth--;
      continue;
    }
    const body = line.slice(bodyStart, i);
    const merged = mergeCsArgs(body, updates);
    // 行尾（`)]` 之后，可能有注释）原样保留：只换实参体这一段
    return merged === body ? line : line.slice(0, bodyStart) + merged + line.slice(i);
  }
  return line;
}

/**
 * 从第 `from` 行向上扫过连续的 `[...]` 属性行，返回最近一行 `[Drawcode(` 的行号，找不到返回 null。
 *
 * 为什么不能只看"上一行"：设备卡片的真实形状是
 *     [Drawcode(...)]            ← 要合并的目标
 *     [Device(Model = "…")]      ← 它的"下一行"，也就是签名的"上一行"
 *     public static Hardware dev_xxx()
 * `[Device]` 卡在中间，"签名的上一行"这个定位法直接失效：会把方法误判成"没有注解"，
 * 然后（若照旧逻辑）在上面插一行重复的 `[Drawcode]`。所以必须扫过**连续的**属性行。
 *
 * 停扫条件与解析侧一致：readMeta 同样只把连续无空行、无注释的 `[...]` 块当同一个注解块，
 * 两边用同一条边界才能在"解析认得出"的行上写回。多个 `[Drawcode]` 时取**最近**的一行：
 * 解析侧同类键是后写覆盖前写，即离声明最近者胜。
 */
function findCsDrawcodeAbove(lines: string[], from: number): number | null {
  for (let j = from - 1; j >= 0 && (lines[j] as string).trim().startsWith("["); j--) {
    if (CS_ATTR_RE.test(lines[j] as string)) return j;
  }
  return null;
}

/**
 * 回写 C# 声明层：信号字段的 `[Drawcode(Direction.X, …)]` 特性。
 *
 * 既有注解行走**参数级合并**（mergeCsAnnotationLine）：手写的 `Style`、`Xy`/`Size`
 * 和其他不认识的参数全部原样存活，只有受管参数里值确实变了的才被就地替换。
 * 旧实现是整行重建，手写参数会被静默抹掉 —— 与 C 信号的 `syncHeader` 是同一个缺陷，
 * 这次一并修掉。
 */
export function syncCsSource(path: string, model: Model, rel: string): boolean {
  const text = readTextFile(path);
  const lines = splitlines(text);
  const wanted = new Map<string, Signal>();
  for (const s of model.signals.values()) {
    if (s.file === rel) wanted.set(s.name, s);
  }

  interface Span {
    /** `[Drawcode(` 所在行；null = 声明上方没有 Drawcode 注解行，需要新插一行。 */
    dcIdx: number | null;
    /** 字段声明行。 */
    fieldIdx: number;
    name: string;
  }
  const spans: Span[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = matchAt(CS_FIELD_LINE_RE, lines[i] as string);
    const name = m?.groups?.name;
    if (m === null || name === undefined || !wanted.has(name)) continue;
    spans.push({ dcIdx: findCsDrawcodeAbove(lines, i), fieldIdx: i, name });
  }

  const newLines = [...lines];
  for (const span of [...spans].reverse()) {
    const sig = wanted.get(span.name) as Signal;
    const pinned = model.pinned.get(sig.id);
    if (span.dcIdx !== null) {
      const merged = mergeCsAnnotationLine(newLines[span.dcIdx] as string, csSignalArgs(sig, pinned));
      if (merged !== newLines[span.dcIdx]) newLines[span.dcIdx] = merged;
      continue;
    }
    // 字段上方没有 Drawcode 注解行：插一行新的，字段行本身一格不动
    const fieldLine = lines[span.fieldIdx] as string;
    const indent = fieldLine.slice(0, fieldLine.length - fieldLine.replace(/^\s+/, "").length);
    const rendered = [...renderCsAnnotation(sig, pinned).map((l) => indent + l), fieldLine];
    newLines.splice(span.fieldIdx, 1, ...rendered);
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
      add.push(...renderCsAnnotation(sig, model.pinned.get(sig.id)).map((l) => indent + l));
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

/**
 * C# 方法注解的**几何**回写。本轮只做一件事：把 `pinned` 里的 Xy/Size 合并进方法上方
 * `[Drawcode(...)]` 行；`[Device(...)]` 行与签名一个字都不动。
 *
 * 为什么只碰几何、不碰 Alias/Note/Asset：
 *   - 本轮契约只要求几何；
 *   - `Asset` 在解析侧有一个隐蔽来源：`Func.asset` 在 `[Drawcode]` 没有 Asset 时会从
 *     `[Device(Asset=…)]` 回填（见 csparse.parseCsProject）。若把 Asset 也纳入合并，
 *     就会把 Device 行上的 Asset 悄悄复制一份进 Drawcode 行 —— 凭空多出一个键；
 *   - 写回范围越小，破坏面越小。其余键的回写是后续工作，不是这里顺手做的事。
 *
 * 定位方法签名复用 csparse 的 CS_FUNC_RE（方法签名的单一事实源），绝不另写一套正则 ——
 * 两套写法迟早漂移，届时"解析认得出、回写找不到"会静默丢失改动。
 *
 * 已知限制（本轮不做）：图里有、源码里没有的**新方法**不会自动插入骨架；
 * 找不到 `[Drawcode(...)]` 的既有方法也一行都不碰。
 */
export function syncCsMethods(path: string, model: Model, rel: string): boolean {
  const funcs = new Map<string, Func>();
  for (const f of model.funcs.values()) {
    if (f.file === rel) funcs.set(f.name, f);
  }
  if (funcs.size === 0) return false;

  const text = readTextFile(path);
  const lines = splitlines(text);
  const newLines = [...lines];
  for (let i = 0; i < lines.length; i++) {
    const m = matchAt(CS_FUNC_RE, (lines[i] as string).trim());
    const name = m?.groups?.name;
    if (m === null || name === undefined) continue;
    const f = funcs.get(name);
    if (f === undefined) continue;
    const dcIdx = findCsDrawcodeAbove(lines, i);
    if (dcIdx === null) continue;
    const updates = geomKv("Xy", "Size", model.pinned.get(f.id));
    if (updates.length === 0) continue;
    const merged = mergeCsAnnotationLine(newLines[dcIdx] as string, updates);
    if (merged !== newLines[dcIdx]) newLines[dcIdx] = merged;
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
 * 一个既有信号块的合并渲染：注解行**就地合并**（mergeAnnotation），其余行不动。
 *
 * 为什么注解行绝不能整行重建（旧实现的做法）：重建只能输出受管键
 * （dir/unit/alias/note/external），源码上手写的 `xy`/`size`/`style` 会被静默抹掉 ——
 * 这是个既存缺陷。合并后：没人拖动 ⇒ 手写键原样存活；人拖过 ⇒ 就地替换。
 *
 * 未定类型的 TODO 注释行必须留在注解行**之前**（原因见 renderSignal 的说明）。
 */
function mergeSignalBlock(
  sig: Signal,
  orig: string[],
  pinned: PinnedGeom | undefined,
): string[] {
  const rendered = splitlines(renderSignal(sig, pinned));
  const renderedAnnAt = rendered.findIndex((l) =>
    l.replace(/^\s+/, "").startsWith("/// @drawcode"),
  );
  const origAnnAt = orig.findIndex((l) => l.replace(/^\s+/, "").startsWith("/// @drawcode"));
  const kv = signalKv(sig, pinned);
  const annotation =
    origAnnAt >= 0
      ? mergeAnnotation(orig[origAnnAt] as string, kv)
      : (rendered[renderedAnnAt] as string);
  const head = rendered.slice(0, renderedAnnAt);
  const body = origAnnAt >= 0 ? orig.filter((_, i) => i !== origAnnAt) : orig;
  if (origAnnAt < 0) {
    // 块里没有 @drawcode 行：把注解插在声明行正上方，其余 `///` 行保持原序
    return [...head, ...body.slice(0, -1), annotation, body[body.length - 1] as string];
  }
  return [...head, ...body.slice(0, origAnnAt), annotation, ...body.slice(origAnnAt)];
}

/**
 * C 头文件的声明层回写。
 *
 * 两段：(1) 已存在的声明块把注解行合并一遍；(2) **IR 里有、文件里没有的信号追加到 `#endif` 之前**。
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
    const rendered = mergeSignalBlock(
      sig,
      newLines.slice(block.start, block.end + 1),
      model.pinned.get(sig.id),
    );
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
      add.push(...splitlines(renderSignal(s, model.pinned.get(s.id))));
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
  if (path.toLowerCase().endsWith(".cs")) {
    // C# 信号与方法分两趟：定位规则不同（字段声明 vs 方法签名 + 连读的 `[...]` 属性行）。
    // 两趟都必须跑、不能用 `||` 短路 —— 信号没变不等于方法没变。
    const signals = syncCsSource(path, model, rel);
    const methods = syncCsMethods(path, model, rel);
    return signals || methods;
  }
  const touched = syncHeader(path, model, rel);
  return syncFunctions(path, model, rel) || touched;
}
