/**
 * C# 源 → IR。对等 Python `csparse.py`。
 *
 * 注解语法是**真特性**（不是注释）：
 *
 *     [Drawcode(Direction.In, Unit = "LSB", Alias = "原始采样值", Xy = "40,120", Size = "180x72")]
 *     [Callout("这块写什么，可含<br>换行", Xy = "40,40", Size = "260x60", Style = "box")]
 *     [Device(Vendor = "TI", Model = "ADS1115", Spec = "16bit/860SPS")]
 *     public static short g_raw;
 *
 * 与 C 侧的差异，以及它们**为什么是刻意的**：
 *
 *   - 方向是**位置参数**（`Direction.In`）而不是 `dir=` 键 —— 位置参数能让编辑器补全 `Direction.`。
 *   - `Direction.None` 或缺省参数**不构成信号**（当作函数或纯文档）；而 C 侧无 `dir` 键时 IR 的
 *     `dir` 是**空串**。这个不对称必须原样保留，三版都如此。
 *   - 节点几何键 `Xy`/`Size`、样式追加键 `Style`：**C 侧一直有，C# 侧本文件是第一个支持的实现**
 *     （Python 与 .NET 的 C# 前端尚未跟进，见 ../../docs/annotations.zh-CN.md 的说明）。
 *     `Xy` 是 `"x,y"`，`Size` 是 `"宽x高"`，容差与 cparse.ts 逐字一致，否则同一份坐标在两个
 *     前端会得到两种结果。别与 `[Device]` 上的 `size` 混淆 —— 那是器件物理封装尺寸，
 *     是两侧都读的**另一个同名键**，各在自己的命名空间里。
 */

import { containerPath, defUse, loadSources, parseParams, topGroup } from "./cparse.ts";
import { abspath, countOccurrences, dirname } from "./fsutil.ts";
import type { Func, Param } from "./model.ts";
import { Model, makeCallout, makeDevice, makeFunc, makeSignal } from "./model.ts";
import { matchAt } from "./regex.ts";

export const DIRS: Record<string, "in" | "out" | "inout"> = {
  In: "in",
  Out: "out",
  Io: "inout",
};

const ATTR_RE = /\[\s*(Drawcode|Device|Callout)\s*\((.*)\)\s*\]/;
const DIR_ARG_RE = /Direction\.(\w+)/;
const ARG_RE = /(\w+)\s*=\s*(?:"([^"]*)"|(\w+))/g;

/** `[Drawcode(...)]` / `[Device(...)]` 的命名参数 → 小写键。裸词（如 `true`）也接受。 */
const META_KEY: Record<string, string> = {
  unit: "unit",
  alias: "alias",
  note: "note",
  tooltip: "tooltip",
  external: "external",
  asset: "asset",
  path: "path",
  xy: "xy",
  size: "size",
  style: "style",
};

/**
 * `[Callout]` 的命名参数在 meta 里的键前缀。
 *
 * 刻意与 META_KEY 分开：`Style` 在 `[Drawcode]` 上是「追加到节点样式」，在 `[Callout]` 上是
 * 「文字块种类」，同名不同义。混在一个命名空间里，`[Drawcode(Style=…)]` 与
 * `[Callout(..., Style=…)]` 写在同一个声明上时必然互相踩。
 *
 * 分隔符与节点几何**同一套**：`Xy` 用逗号（`"40,40"`）、`Size` 用小写 `x`（`"260x60"`），
 * 由下面 parseCallout 里那段 `v.split(",")` / `v.toLowerCase().split("x")` 决定。
 * 两者写混不会报错，只会得到 NaN 尺寸的隐形文字块 —— 曾经本文件头部的示例自己就写错了。
 */
const CALLOUT_KEY: Record<string, string> = {
  xy: "callout_xy",
  size: "callout_size",
  style: "callout_shape",
  font: "callout_font",
};

const CALLOUT_SHAPES = new Set(["text", "box", "band"]);

/** `[Callout("文本", 命名参数…)]`：文本必须是第一个位置参数，用双引号括起（内部不能有双引号）。 */
const CALLOUT_TEXT_RE = /^"([^"]*)"\s*(?:,\s*(.*))?$/;

/** 一条 `[Callout]` 解析出来的原始形态，还没挂到宿主实体上。 */
export interface RawCallout {
  text: string;
  shape: "text" | "box" | "band";
  fontSize: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function parseArgs(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  ARG_RE.lastIndex = 0;
  let a: RegExpExecArray | null;
  while ((a = ARG_RE.exec(body)) !== null) {
    out.push([(a[1] as string).toLowerCase(), (a[2] ?? a[3] ?? "") as string]);
  }
  return out;
}

function parseAttrLine(line: string): [string, string][] {
  const m = ATTR_RE.exec(line);
  if (m === null) return [];
  return parseArgs(m[2] as string);
}

/**
 * 一条特性文本的 `[`/`]` 净值，跳过双引号字符串里的方括号。
 *
 * 为什么不能直接数字符：`Note = "采样[0]"` 这类合法元数据会让计数提前归零，
 * 把后半条特性当成独立声明处理。字符串内的 `\"` 也要跳过，否则会把转义引号
 * 误判成字符串结束。
 */
function indexOutsideString(text: string, targets: string): number {
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (targets.includes(ch)) return i;
  }
  return -1;
}

/**
 * 方括号配平差值（引号内的 `[`/`]` 不计）。
 *
 * 导出给 codegen 用：回写侧要判断「这一行是不是一条跨行属性的开头」，
 * 必须与解析侧用**同一套**引号/转义规则，否则会出现「解析认得出、回写找不到」
 * 的静默丢改动（两条正则各写一份迟早漂移）。
 */
export function bracketDelta(text: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
  }
  return depth;
}

/**
 * `Xy = "x,y"` / `Size = "宽x高"`。
 *
 * 容差与 C 侧 cparse.ts 的写法**逐字对齐**（逗号分隔、小写 `x` 分隔、一律 `Number()` 且不校验），
 * 两个前端对同一份坐标必须得出同一个数，否则「同一套源码在两个语言里排版不同」会变成
 * 永远查不出来的怪事。非法输入得到 NaN，与 C 侧一样由下游自己承担。
 */
function applyGeometry(
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

function parseCallout(body: string): RawCallout {
  const out: RawCallout = { text: "", shape: "text", fontSize: 0, x: 0, y: 0, w: 240, h: 40 };
  const tm = CALLOUT_TEXT_RE.exec(body.trim());
  const rest = tm === null ? body : (tm[2] ?? "");
  if (tm !== null) out.text = tm[1] as string;
  for (const [k, v] of parseArgs(rest)) {
    if (CALLOUT_KEY[k] === undefined) continue;
    if (k === "style") {
      // 认不出的种类退回无边框文字，而不是把原始串当样式用 —— 后者会静默产出非法样式
      out.shape = CALLOUT_SHAPES.has(v) ? (v as RawCallout["shape"]) : "text";
    } else if (k === "font") {
      out.fontSize = Number(v) || 0;
    } else {
      const parts = (k === "xy" ? v.split(",") : v.toLowerCase().split("x")).map((n) => Number(n));
      if (k === "xy") {
        out.x = parts[0] as number;
        out.y = parts[1] as number;
      } else {
        out.w = parts[0] as number;
        out.h = parts[1] as number;
      }
    }
  }
  return out;
}

/**
 * 收集相邻特性行：`[Drawcode(...)]` 进 meta，`[Device(...)]` 进 dev，`[Callout(...)]` 进列表，
 * 并返回方向。
 *
 * 返回**四元组**（老调用方解构前三位即可，追加第四位是源兼容的）。Callout 用列表而不是
 * 塞进 meta：一个声明上挂两个文字块是正常需求，塞进 Map 会被后一条静默覆盖。
 */
export function readMeta(
  buf: string[],
): [Map<string, string>, Map<string, string>, string | null, RawCallout[]] {
  const meta = new Map<string, string>();
  const dev = new Map<string, string>();
  const callouts: RawCallout[] = [];
  let dir: string | null = null;
  for (const raw of buf) {
    const m = ATTR_RE.exec(raw);
    if (m === null) continue;
    const kind = m[1] as string;
    if (kind === "Callout") {
      callouts.push(parseCallout(m[2] as string));
      continue;
    }
    const isDevice = kind === "Device";
    if (!isDevice) {
      const d = DIR_ARG_RE.exec(m[2] as string);
      if (d !== null) dir = d[1] as string;
    }
    for (const [k, v] of parseAttrLine(raw)) {
      if (isDevice) dev.set(k, v);
      else if (META_KEY[k] !== undefined) meta.set(META_KEY[k] as string, v);
    }
  }
  return [meta, dev, dir, callouts];
}

const MODIFIERS =
  "public|private|internal|protected|static|readonly|const|volatile|" +
  "virtual|override|abstract|sealed|async|extern|unsafe|new|partial";

/**
 * C# 类型片段的字符集：首字符是任意 Unicode 字母或下划线，后续是字母、数字、下划线与
 * 类型语法里常见的 `. < > , [ ] ?`。
 *
 * 为什么不能用 `[A-Za-z_]`／`\w`：本项目的关系字段类型是中文结构体（`数据包`），
 * ASCII 正则会让整条声明**静默地**不被当成信号 —— 图上少一个节点，而且不报任何错。
 * 这正是「中文类型名要单独修解析器」的原因：C# 编译器接受中文标识符，解析器却看不见。
 *
 * 名字位置与类型位置**同一字符集**：C# 编译器接受中文标识符，解析器没有理由只认 ASCII。
 * 信号名、函数名都可能是中文 —— 图上要显示的就是「哪个模块、传了什么」。
 *
 * 放宽名字后，原本靠「ASCII 看不见」挡在图外的两类声明必须显式处理：
 *   · `record` 类型声明与记录体里的方法 → 由 RECORD_DECL_RE 整段跳过；
 *   · 支撑件里的泛型桩方法（`生成<T>()` / `处理<T>(T)`）→ 名字后跟 `<` 而不是 `(`，天然不匹配。
 */
const IDENT = "[\\p{L}_][\\p{L}\\p{N}_]*";
const TYPE_RE = "[\\p{L}_][\\p{L}\\p{N}_\\.<>,\\[\\]\\?]*";

export const FIELD_RE = new RegExp(
  `^\\s*(?:(?:${MODIFIERS})\\s+)*(?<ctype>${TYPE_RE})\\s+` +
    `(?<name>${IDENT})\\s*(?:=[^;]*)?;\\s*$`,
  "u",
);

export const CS_FUNC_RE = new RegExp(
  `^\\s*(?:(?:${MODIFIERS})\\s+)*(?<ret>${TYPE_RE})\\s+` +
    `(?<name>${IDENT})\\s*\\((?<params>[^)]*)\\)\\s*\\{?\\s*$`,
  "u",
);

/**
 * `record` 声明的开头。解析时必须**整段跳过**。
 *
 * 名字位置放开到 Unicode 之后，`public sealed record 采样帧(...)` 与普通方法签名
 * 完全同形；记录体里的 `public 帧头 下一帧()` 也会变成组件函数。数据类型文件
 * （`示例数据结构.cs`）不是被测模型，整段跳过记录声明是唯一不误伤设备类里真实方法的
 * 办法 —— 设备类用 `class`，不在这个正则里。
 *
 * 只跳过 `record`，不跳过 `class`：模型源文件本身就是 `public static class 设备名`，
 * 连类一起跳会把整张图清空。
 */
const RECORD_DECL_RE = new RegExp(
  `^\\s*(?:(?:public|private|internal|protected|static|sealed|abstract|readonly|partial|unsafe|new)\\s+)*record\\b`,
);

const SKIP_PREFIX = ["using ", "namespace ", "#"];
const SKIP_EXACT = new Set(["{", "}", "};"]);

export function csBodies(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < lines.length) {
    const m = matchAt(CS_FUNC_RE, (lines[i] as string).trim());
    const name = m?.groups?.name;
    if (m !== null && name !== undefined) {
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

interface CsFuncInfo {
  rel: string;
  line: number;
  ret: string;
  params: Param[];
  meta: Map<string, string>;
  device: Map<string, string>;
  callouts: RawCallout[];
}

export function parseCsProject(paths: string[], root?: string): Model {
  const resolvedRoot = root ?? dirname(abspath(paths[0] as string));
  const loaded = loadSources(paths, resolvedRoot);
  const model = new Model(loaded.map(([rel]) => rel));

  interface RawSignal {
    rel: string;
    line: number;
    dir: "in" | "out" | "inout";
    ctype: string;
    name: string;
    meta: Map<string, string>;
    callouts: RawCallout[];
  }
  const rawSignals: RawSignal[] = [];
  const rawFuncs = new Map<string, CsFuncInfo>();

  for (const [rel, lines] of loaded) {
    let buf: string[] = [];
    // 一条特性可能跨多行（参数多时最常见）。`[`/`]` 未配平就继续吞下一行，
    // 等配平后把整条拼成一行交给 readMeta —— ATTR_RE 的 `.` 不跨行。
    // 不这样做时，第二行会被当成声明行（既不是字段也不是函数）而丢弃，
    // 紧随其后的真实声明就失去了特性，信号会从图上**静默消失**。
    let pendingAttr: string | null = null;
    for (let index = 0; index < lines.length; index++) {
      const raw = lines[index] as string;
      const lineno = index + 1;
      const s = raw.trim();

      if (pendingAttr !== null) {
        pendingAttr = `${pendingAttr} ${s}`;
        if (bracketDelta(pendingAttr) <= 0) {
          buf.push(pendingAttr);
          pendingAttr = null;
        }
        continue;
      }
      if (s.startsWith("[")) {
        if (bracketDelta(s) > 0) pendingAttr = s;
        else buf.push(raw);
        continue;
      }
      if (s.startsWith("///") || s === "") {
        buf = [];
        continue;
      }
      if (SKIP_PREFIX.some((prefix) => s.startsWith(prefix)) || SKIP_EXACT.has(s)) {
        buf = [];
        continue;
      }

      // 数据类型文件里的记录声明不是组件：连同记录体里的方法一起跳过。
      // 一行到底（`...);` 或 `... { }`）直接跳过；带多行记录体的按花括号配平。
      if (RECORD_DECL_RE.test(s)) {
        buf = [];
        let j = index;
        let depth = countOccurrences(raw, "{") - countOccurrences(raw, "}");
        // 主构造参数表可以跨多行（`record X(\n 参数,\n 参数);`）。旧实现直接找
        // 「第一个含 `{` 的行」，遇到无记录体的多行声明时会一路找到**下一个类**
        // 的开括号，把整个类当成记录体吞掉——Dsp.cs 的信号因此全部消失。
        // 正确的终止符是字符串外的 `;`；先遇到 `{` 才是记录体。
        if (indexOutsideString(raw, "{") < 0 && indexOutsideString(raw, ";") < 0) {
          let k = j + 1;
          while (k < lines.length) {
            const line = lines[k] as string;
            if (indexOutsideString(line, "{") >= 0) {
              j = k;
              depth = countOccurrences(line, "{") - countOccurrences(line, "}");
              break;
            }
            if (indexOutsideString(line, ";") >= 0) {
              j = k;
              depth = 0;
              break;
            }
            k++;
          }
          if (k >= lines.length) {
            index = j;
            continue;
          }
        }
        if (depth > 0) {
          let k = j + 1;
          while (k < lines.length && depth > 0) {
            depth += countOccurrences(lines[k] as string, "{") - countOccurrences(lines[k] as string, "}");
            k++;
          }
          j = k - 1;
        }
        index = j;
        continue;
      }

      const [meta, dev, dirArg, callouts] = readMeta(buf);
      buf = [];

      const mf = matchAt(FIELD_RE, s);
      const dir = dirArg === null ? undefined : DIRS[dirArg];
      if (mf !== null && dir !== undefined) {
        rawSignals.push({
          rel,
          line: lineno,
          dir,
          ctype: mf.groups?.ctype as string,
          name: mf.groups?.name as string,
          meta,
          callouts,
        });
        continue;
      }

      const mfn = matchAt(CS_FUNC_RE, s);
      if (mfn !== null) {
        const name = mfn.groups?.name as string;
        rawFuncs.set(name, {
          rel,
          line: lineno,
          ret: mfn.groups?.ret as string,
          params: parseParams(mfn.groups?.params as string),
          meta,
          device: dev,
          callouts,
        });
      }
    }
  }

  /**
   * 把一条声明上的文字块挂进模型。坐标为画布绝对坐标 —— 文字块不属于任何容器
   * （见 model.ts 的 Callout 说明），所以这里不做任何容器偏移。
   */
  const attachCallouts = (owner: string, raws: RawCallout[]): void => {
    raws.forEach((raw, i) => {
      model.addCallout(
        makeCallout({
          id: `${owner}#callout${i + 1}`,
          text: raw.text,
          owner,
          shape: raw.shape,
          fontSize: raw.fontSize,
          x: raw.x,
          y: raw.y,
          w: raw.w,
          h: raw.h,
        }),
      );
    });
  };

  for (const rs of rawSignals) {
    const cpath = containerPath(rs.meta, rs.rel);
    const sid = `${rs.rel}::${rs.name}`;
    const signal = makeSignal({
      id: sid,
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
      style: rs.meta.get("style") ?? "",
    });
    applyGeometry(signal, rs.meta);
    model.addSignal(signal);
    attachCallouts(sid, rs.callouts);
  }

  const signalsByName = new Map<string, string>();
  for (const signal of model.signals.values()) signalsByName.set(signal.name, signal.id);

  const funcsByName = new Map<string, string>();
  for (const [name, info] of rawFuncs) {
    const fid = `${info.rel}::${name}`;
    funcsByName.set(name, fid);
    const fpath = containerPath(info.meta, info.rel);
    const func: Func = makeFunc({
      id: fid,
      name,
      ret: info.ret,
      params: info.params,
      file: info.rel,
      line: info.line,
      alias: info.meta.get("alias") ?? "",
      note: info.meta.get("note") ?? "",
      tooltip: info.meta.get("tooltip") ?? "",
      asset: info.meta.get("asset") ?? "",
      style: info.meta.get("style") ?? "",
      external: info.meta.get("external") === "true",
      group: topGroup(fpath),
      path: fpath,
    });
    applyGeometry(func, info.meta);
    model.addFunc(func);
    attachCallouts(fid, info.callouts);

    if (info.device.size > 0) {
      model.devices.set(
        fid,
        makeDevice({
          vendor: info.device.get("vendor") ?? "",
          model: info.device.get("model") ?? "",
          spec: info.device.get("spec") ?? "",
          size: info.device.get("size") ?? "",
          asset: info.device.get("asset") ?? "",
        }),
      );
      if (func.asset === "") func.asset = info.device.get("asset") ?? "";
    }
  }

  for (const [, lines] of loaded) {
    for (const [name, body] of csBodies(lines)) {
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
