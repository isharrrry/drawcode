/**
 * C 源 → IR。对等 Python `cparse.py`。
 *
 * 注解语法（**已经没有宏、没有头文件了**）：
 *
 *     /// @drawcode dir=in unit="LSB" alias="原始采样值"
 *     int16_t g_raw;
 *
 * 两条容易踩的规则：
 *
 *   1. **`dir` 是裸词，其余属性带引号**（`dir=in` vs `unit="LSB"`）。正则必须同时接受
 *      两种写法 —— 只匹配带引号形式的版本会让**信号全部静默丢失**（signals 变空、
 *      不报任何错），这是本项目真实踩过的坑。
 *   2. 连续的 `///` 累积进缓冲，遇到**非注释非空行**才把它交给下一个声明；**空行会清空缓冲**。
 *      所以注解块必须紧贴它所注解的东西，中间只能隔别的 `///` 行。
 *
 * 边的来源是**函数体的 def/use 扫描**：函数体读到哪些全局信号、写了哪些，就产出对应的边。
 * 局部变量不入图。
 */

import { abspath, countOccurrences, dirname, readTextFile, relPath, splitlines, stem } from "./fsutil.ts";
import type { Direction, Func, Param } from "./model.ts";
import { Model, makeDevice, makeFunc, makeSignal } from "./model.ts";
import { compareCodePoints } from "./order.ts";
import { findAll, findAll1, findAllGroups, matchAt, sub } from "./regex.ts";

export const DIR_BY_KEY: Record<string, "in" | "out" | "inout"> = {
  in: "in",
  out: "out",
  io: "inout",
};

export const CONTROL = new Set([
  "if",
  "for",
  "while",
  "switch",
  "return",
  "sizeof",
  "do",
  "else",
  "case",
  "defined",
  "static_assert",
  "catch",
  "typeof",
]);

export const SIGNAL_RE =
  /^(?<ctype>(?:[A-Za-z_]\w*[\s*]+)+)(?<name>[A-Za-z_]\w*)\s*(?<arr>\[[^\]]*\])?\s*;$/;

export const FUNC_RE =
  /^(?<ret>(?:[A-Za-z_]\w*[\s*]+)+)(?<name>[A-Za-z_]\w*)\s*\((?<params>[^)]*)\)\s*(?<tail>[;{]?)\s*$/;

const ASSIGN_RE = /(?<![=!<>+\-*/%&|^])=(?!=)/;
const COMPOUND_RE = /(?:\+|-|\*|\/|%|&|\||\^|<<|>>)=/;
// 标识符字符集必须是 Unicode：C# 编译器接受中文名字，`a5_采样值 = …` 与
// `测试桩.处理(…)` 里的中文名都要能被 def/use 扫到，否则信号名中文化后所有边会静默消失。
// C 侧只用到其中的 ASCII 子集，行为不变。
const IDENT_RE = /[\p{L}_][\p{L}\p{N}_]*/u;
const CALL_RE = /([\p{L}_][\p{L}\p{N}_]*)\s*\(/u;
export const KV_RE = /(\w+)\s*=\s*"([^"]*)"/;

const ANNOTATION_TAG_RE = /^@(\w+)\s*(.*)$/;
const PARAM_RE = /^(?<ctype>.+?)\s*(?<name>[\p{L}_][\p{L}\p{N}_]*)$/u;
const SPLIT_SIGNAL_RE = /^([\p{L}_][\p{L}\p{N}_]*)\s*(\[[^\]]*\])?$/u;
const KV_BARE_RE = /(\w+)\s*=\s*([A-Za-z_]\w*)/;

/** 把 'g_coeff[32]' 拆成 ['g_coeff', '[32]']。*/
export function splitSignals(text: string): [string, string] {
  const trimmed = text.trim();
  const m = matchAt(SPLIT_SIGNAL_RE, trimmed);
  if (m === null) return [trimmed, ""];
  return [m[1] as string, m[2] ?? ""];
}

/**
 * 容器的斜杠路径，例如 `adc/采样前端`。
 *
 * 标了 `path="adc/采样前端"` 就用它；没标则退回模块名（`adc.h` -> `adc`）。
 * 这样旧源码一个字不改也照常工作，而且下游拿到的 path **永远非空** ——
 * 「没标」和「标成空」是同一种情况，不需要在别处再判一次。
 */
export function containerPath(meta: Map<string, string>, rel: string): string {
  const raw = (meta.get("path") ?? "").trim();
  return raw.replace(/^\/+|\/+$/g, "") || stem(rel);
}

/** path 的第一段，即最外层容器名。*/
export function topGroup(path: string): string {
  return path.split("/")[0] as string;
}

/**
 * 把 `xy="x,y"` / `size="宽x高"` 落到实体的几何字段上 —— 信号与函数共用同一份容差。
 *
 * **容差必须与 csparse.ts（C# 前端）的同名函数逐字一致**，这里是照它的写法抄的：
 * 逗号切 `xy`、小写 `x` 切 `size`、一律 `Number()`。理由是同一份布局意图
 * （`xy="420,160"`）在两个前端必须得到同一个数 —— IR 的 x/y/w/h 属于布局维度，
 * L1 金标准刻意不比对它们（见 model.ts 头部），两边切法一旦不同，
 * 「同一份源码在 C 与 C# 里排出来的图不一样」会是**没有任何测试会报警**的差异。
 *
 * 写错分隔符（如把 `size="180x72"` 写成 `size="180,72"`）时**不做校验、不报错、不兜底**：
 * 切不出第二段就静默得到 NaN / undefined 传给下游 —— 与 C# 前端完全相同的静默行为。
 * 为什么选静默而不是在这里报错：本次的硬约束是「畸形输入也要与 C# 前端一致」，
 * 报错只会让两侧分叉；且校验属于行为变更，不在本次对齐的范围里。
 * 实测结果（哪个字段是 NaN、哪个是 undefined）见 test/parse.test.ts。
 *
 * 两版实现各自保留一份副本、互不 import、互不改对方的文件，是本仓库的既有约定。
 * 缺键（undefined 或空串）不动默认值：信号 160x60、函数 180x72，来自 model.ts。
 */
export function applyGeometry(
  ent: { x: number; y: number; w: number; h: number },
  meta: Map<string, string>,
): void {
  const xy = meta.get("xy");
  if (xy !== undefined && xy !== "") {
    const parts = xy.split(",").map((v) => Number(v));
    ent.x = parts[0] as number;
    ent.y = parts[1] as number;
  }
  const size = meta.get("size");
  if (size !== undefined && size !== "") {
    const parts = size.toLowerCase().split("x").map((v) => Number(v));
    ent.w = parts[0] as number;
    ent.h = parts[1] as number;
  }
}

/** 擦除块注释与行注释（对等 Python 侧带 re.S 的 `/*...*/` 替换，再做 `//...` 替换）。*/
export function stripComments(text: string): string {
  return sub(/\/\*[\s\S]*?\*\//, " ", text).replace(/\/\/[^\n]*/g, " ");
}

export function parseParams(text: string): Param[] {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "void") return [];
  const out: Param[] = [];
  for (const rawPart of trimmed.split(",")) {
    const part = rawPart.trim();
    const m = matchAt(PARAM_RE, part);
    if (m !== null) {
      out.push({
        name: m.groups?.name as string,
        ctype: (m.groups?.ctype as string).trim(),
        dir: "in",
      });
    }
  }
  return out;
}

/**
 * 解析一个已缓冲的注解块，返回 `[meta, dev]` 两组键值。
 *
 * **两种取值写法都要认**（这是本函数最容易出错的地方）：
 *   - `KV_RE`     带引号：`unit="LSB"`、`alias="原始采样值"`
 *   - `KV_BARE_RE` 裸值：`dir=in`、`external=true`
 *
 * 只实现前者会让 `dir` 读不到 ⇒ 信号全部变成"无方向"甚至整体丢失，且**不报任何错**。
 * 先跑带引号的，再用裸值补齐尚未出现的键（同一个键不会同时以两种形式出现）。
 */
export function readAnnotations(buf: string[]): [Map<string, string>, Map<string, string>] {
  const meta = new Map<string, string>();
  const dev = new Map<string, string>();
  for (const raw of buf) {
    const body = raw.replace(/^\s+/, "").slice(3).trim();
    const m = matchAt(ANNOTATION_TAG_RE, body);
    if (m === null) continue;
    const tag = m[1] as string;
    const rest = m[2] as string;
    const kv: Array<[string, string]> = findAllGroups(KV_RE, rest).map(
      ([k, v]) => [k as string, v as string] as [string, string],
    );
    for (const [k, v] of findAllGroups(KV_BARE_RE, rest)) {
      if (!kv.some(([seen]) => seen === k)) kv.push([k as string, v as string]);
    }
    if (tag === "drawcode") {
      for (const [k, v] of kv) meta.set(k, v);
    } else if (tag === "device") {
      for (const [k, v] of kv) dev.set(k, v);
    }
  }
  return [meta, dev];
}

/**
 * 扫描 .c 行列表，抽出 name -> 函数体文本。
 * 这里刻意保留参考实现里 `j - i <= 2` 的那个边界：它决定了函数签名与 `{`
 * 之间最多允许隔 2 行。改成更合理的写法会让两版在畸形输入上分道扬镳。 */
export function bodies(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < lines.length) {
    const m = matchAt(FUNC_RE, (lines[i] as string).trim());
    const name = m?.groups?.name;
    if (m !== null && name !== undefined && !CONTROL.has(name)) {
      let j = i;
      while (j < lines.length && !(lines[j] as string).includes("{") && j - i <= 2) j++;
      if (j < lines.length && (lines[j] as string).includes("{")) {
        let depth = 0;
        const chunk: string[] = [];
        let k = j;
        while (k < lines.length) {
          const line = lines[k] as string;
          depth += countOccurrences(line, "{") - countOccurrences(line, "}");
          chunk.push(line);
          if (depth === 0) break;
          k++;
        }
        out.set(name, chunk.join("\n"));
        i = k + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

export interface DefUse {
  reads: string[];
  writes: string[];
  calls: string[];
}

/**
 * 函数体的读写分析 ——边只从这里来，跟注释零关系。
 * 三种语句形态分开处理：复合赋值（`a += b` 读也写）、简单赋值（`a = b` 左写右读）、其他（整句都算读）。 */
export function defUse(
  body: string,
  signalsByName: Map<string, string>,
  funcsByName: Map<string, string>,
): DefUse {
  const text = stripComments(body);
  const reads = new Set<string>();
  const writes = new Set<string>();
  const calls = new Set<string>();

  for (const rawStmt of text.split(/[;{}]/)) {
    const stmt = rawStmt.trim();
    if (stmt === "") continue;

    for (const name of findAll1(CALL_RE, stmt)) {
      if (CONTROL.has(name)) continue;
      const fid = funcsByName.get(name);
      if (fid !== undefined) calls.add(fid);
    }

    const comp = COMPOUND_RE.exec(stmt);
    const simple = ASSIGN_RE.exec(stmt);
    if (comp !== null) {
      const lhs = stmt.slice(0, comp.index);
      const rhs = stmt.slice(comp.index + comp[0].length);
      for (const n of findAll(IDENT_RE, lhs)) writes.add(n);
      for (const n of findAll(IDENT_RE, lhs)) reads.add(n);
      for (const n of findAll(IDENT_RE, rhs)) reads.add(n);
    } else if (simple !== null) {
      const lhs = stmt.slice(0, simple.index);
      const rhs = stmt.slice(simple.index + simple[0].length);
      for (const n of findAll(IDENT_RE, lhs)) writes.add(n);
      for (const n of findAll(IDENT_RE, rhs)) reads.add(n);
    } else {
      for (const n of findAll(IDENT_RE, stmt)) reads.add(n);
    }
  }

  const rd = new Set<string>();
  for (const n of reads) {
    const sid = signalsByName.get(n);
    if (sid !== undefined) rd.add(sid);
  }
  const wr = new Set<string>();
  for (const n of writes) {
    const sid = signalsByName.get(n);
    if (sid !== undefined) wr.add(sid);
  }
  return {
    reads: [...rd].sort(compareCodePoints),
    writes: [...wr].sort(compareCodePoints),
    calls: [...calls].sort(compareCodePoints),
  };
}

interface FuncInfo {
  params?: Param[];
  rel?: string;
  line?: number;
  ret?: string;
  meta?: Map<string, string>;
  device?: Map<string, string>;
}

/** 对等 Python `val in ("", None, {}, [])`。*/
function isEmptyValue(value: unknown): boolean {
  if (value === "" || value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Map) return value.size === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

export function loadSources(paths: string[], root: string): Array<[string, string[]]> {
  return paths.map((p) => {
    const rel = relPath(p, root);
    return [rel, splitlines(readTextFile(p))] as [string, string[]];
  });
}

export function parseProject(paths: string[], root?: string): Model {
  // 对等 Python: root = root or os.path.dirname(os.path.abspath(paths[0]))
  const resolvedRoot = root ?? dirname(abspath(paths[0] as string));

  const loaded = loadSources(paths, resolvedRoot);
  const model = new Model(loaded.map(([rel]) => rel));

  interface RawSignal {
    rel: string;
    line: number;
    dir: Direction;
    ctype: string;
    name: string;
    meta: Map<string, string>;
  }
  const rawSignals: RawSignal[] = [];
  const rawFuncs = new Map<string, FuncInfo>();

  for (const [rel, lines] of loaded) {
    let buf: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      const raw = lines[index] as string;
      const lineno = index + 1;
      const s = raw.trim();

      if (s.startsWith("///")) {
        buf.push(raw);
        continue;
      }
      if (s === "") {
        buf = [];
        continue;
      }

      const [meta, dev] = readAnnotations(buf);
      buf = [];

      // 判据是「有注解」，对等 Python 的 `if ms and meta`：
      //   * 没有注解的声明不进 IR —— 否则函数体里的 `int i;` 会被当成顶层信号；
      //   * `dir` 可以缺省、也可以为空，那种情况下信号照样成立，只是没有方向。
      // 早先这里写成 `dirKey !== undefined`，把「有没有注解」和「有没有 dir」混成了
      // 同一件事：`/// @drawcode path="p"` 没有 dir，整条声明就消失了。现在两者分开。
      const dirKey = meta.get("dir");
      const ms = meta.size > 0 ? matchAt(SIGNAL_RE, s) : null;
      if (ms !== null) {
        rawSignals.push({
          rel,
          line: lineno,
          dir: (dirKey !== undefined ? DIR_BY_KEY[dirKey] : undefined) ?? "",
          ctype: (ms.groups?.ctype as string).trim() + (ms.groups?.arr ?? ""),
          name: ms.groups?.name as string,
          meta,
        });
        continue;
      }

      const mf = matchAt(FUNC_RE, s);
      const funcName = mf?.groups?.name;
      if (mf !== null && funcName !== undefined && !CONTROL.has(funcName)) {
        const info = rawFuncs.get(funcName) ?? { params: [] as Param[] };
        rawFuncs.set(funcName, info);
        const isHeader = rel.endsWith(".h");
        const fresh: FuncInfo = {
          rel,
          line: lineno,
          ret: (mf.groups?.ret as string).trim(),
          params: parseParams(mf.groups?.params as string),
          meta,
          device: dev,
        };
        for (const [key, value] of Object.entries(fresh)) {
          if (key === "params" && info.params !== undefined && info.params.length > 0) continue;
          if (isEmptyValue(value) && key in info) continue;
          if (!(key in info) || isHeader) {
            (info as Record<string, unknown>)[key] = value;
          }
        }
      }
    }
  }

  for (const rs of rawSignals) {
    const cpath = containerPath(rs.meta, rs.rel);
    const signal = makeSignal({
      id: `${rs.rel}::${rs.name}`,
      name: rs.name,
      ctype: rs.ctype,
      dir: rs.dir,
      file: rs.rel,
      line: rs.line,
      unit: rs.meta.get("unit") ?? "",
      alias: rs.meta.get("alias") ?? "",
      note: rs.meta.get("note") ?? "",
      external: rs.meta.get("external") === "true",
      group: topGroup(cpath),
      path: cpath,
      // 与 csparse.ts 同源：`style` 原样透传进 IR，解析器不解读它 —— 把片段拼进
      // mxGraph 样式串是 drawio.ts 的职责。缺键 = 空串 = 用默认样式。
      style: rs.meta.get("style") ?? "",
    });
    // 几何键对信号也生效。此前 C 侧只有函数分支读 xy/size、信号分支静默忽略，
    // 于是同一份注解在两个前端会得到不同布局；现在两边共用同一套容差（见 applyGeometry）。
    applyGeometry(signal, rs.meta);
    model.addSignal(signal);
  }

  const signalsByName = new Map<string, string>();
  for (const signal of model.signals.values()) signalsByName.set(signal.name, signal.id);

  const funcsByName = new Map<string, string>();
  for (const [name, info] of rawFuncs) {
    const fid = `${info.rel}::${name}`;
    funcsByName.set(name, fid);
    const meta = info.meta ?? new Map<string, string>();
    const fpath = containerPath(meta, info.rel as string);
    const func: Func = makeFunc({
      id: fid,
      name,
      ret: info.ret ?? "void",
      params: info.params ?? [],
      file: info.rel as string,
      line: info.line as number,
      alias: meta.get("alias") ?? "",
      note: meta.get("note") ?? "",
      tooltip: meta.get("tooltip") ?? "",
      asset: meta.get("asset") ?? "",
      // 同信号分支：`style` 原样透传，解析器不解读它。
      style: meta.get("style") ?? "",
      external: meta.get("external") === "true",
      group: topGroup(fpath),
      path: fpath,
    });
    // 几何键统一走 applyGeometry：与原先就地写的那段逐字等价（同容差、同「缺键不动」
    // 守卫），抽出来只为让信号与函数共用一份，杜绝两处日后各自漂移。
    applyGeometry(func, meta);
    model.addFunc(func);

    const device = info.device;
    if (device !== undefined && device.size > 0) {
      model.devices.set(
        fid,
        makeDevice({
          vendor: device.get("vendor") ?? "",
          model: device.get("model") ?? "",
          spec: device.get("spec") ?? "",
          size: device.get("size") ?? "",
          asset: device.get("asset") ?? "",
        }),
      );
      if (func.asset === "") func.asset = device.get("asset") ?? "";
    }
  }

  for (const [rel, lines] of loaded) {
    if (!/\.(c|cpp)$/.test(rel)) continue;
    for (const [name, body] of bodies(lines)) {
      const fid = funcsByName.get(name);
      if (fid === undefined) continue;
      const { reads, writes, calls } = defUse(body, signalsByName, funcsByName);
      const func = model.funcs.get(fid) as Func;
      func.reads = reads;
      func.writes = writes;
      func.calls = calls;
    }
  }

  model.rebuildEdges();
  return model;
}
