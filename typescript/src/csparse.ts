/**
 * C# 源 → IR。对等 Python `csparse.py`。
 *
 * 注解语法是**真特性**（不是注释）：
 *
 *     [Drawcode(Direction.In, Unit = "LSB", Alias = "原始采样值")]
 *     [Device(Vendor = "TI", Model = "ADS1115", Spec = "16bit/860SPS")]
 *     public static short g_raw;
 *
 * 与 C 侧的差异，以及它们**为什么是刻意的**：
 *
 *   - 方向是**位置参数**（`Direction.In`）而不是 `dir=` 键 —— 位置参数能让编辑器补全 `Direction.`。
 *   - `Direction.None` 或缺省参数**不构成信号**（当作函数或纯文档）；而 C 侧无 `dir` 键时 IR 的
 *     `dir` 是**空串**。这个不对称必须原样保留，三版都如此。
 *   - **没有节点几何键**：`xy` 与节点 `size` 都只有 C 侧支持（`[Drawcode]` 里也没有 `Size`）。
 *     别与 `[Device]` 上的 `size` 混淆 —— 那是器件物理封装尺寸，是两侧都读的**另一个同名键**。
 */

import { containerPath, defUse, loadSources, parseParams, topGroup } from "./cparse.ts";
import { abspath, countOccurrences, dirname } from "./fsutil.ts";
import type { Func, Param } from "./model.ts";
import { Model, makeDevice, makeFunc, makeSignal } from "./model.ts";
import { matchAt } from "./regex.ts";

export const DIRS: Record<string, "in" | "out" | "inout"> = {
  In: "in",
  Out: "out",
  Io: "inout",
};

const ATTR_RE = /\[\s*(Drawcode|Device)\s*\((.*)\)\s*\]/;
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
};

function parseAttrLine(line: string): [string, string][] {
  const m = ATTR_RE.exec(line);
  if (m === null) return [];
  const out: Array<[string, string]> = [];
  ARG_RE.lastIndex = 0;
  let a: RegExpExecArray | null;
  while ((a = ARG_RE.exec(m[2] as string)) !== null) {
    out.push([(a[1] as string).toLowerCase(), (a[2] ?? a[3] ?? "") as string]);
  }
  return out;
}

/** 收集相邻特性行：`[Drawcode(...)]` 进 meta，`[Device(...)]` 进 dev，并返回方向。 */
export function readMeta(buf: string[]): [Map<string, string>, Map<string, string>, string | null] {
  const meta = new Map<string, string>();
  const dev = new Map<string, string>();
  let dir: string | null = null;
  for (const raw of buf) {
    const m = ATTR_RE.exec(raw);
    if (m === null) continue;
    const isDevice = m[1] === "Device";
    if (!isDevice) {
      const d = DIR_ARG_RE.exec(m[2] as string);
      if (d !== null) dir = d[1] as string;
    }
    for (const [k, v] of parseAttrLine(raw)) {
      if (isDevice) dev.set(k, v);
      else if (META_KEY[k] !== undefined) meta.set(META_KEY[k] as string, v);
    }
  }
  return [meta, dev, dir];
}

const MODIFIERS =
  "public|private|internal|protected|static|readonly|const|volatile|" +
  "virtual|override|abstract|sealed|async|extern|unsafe|new|partial";

export const FIELD_RE = new RegExp(
  `^\\s*(?:(?:${MODIFIERS})\\s+)*(?<ctype>[A-Za-z_][\\w\\.<>,\\[\\]\\?]*)\\s+` +
    `(?<name>[A-Za-z_]\\w*)\\s*(?:=[^;]*)?;\\s*$`,
);

export const CS_FUNC_RE = new RegExp(
  `^\\s*(?:(?:${MODIFIERS})\\s+)*(?<ret>[A-Za-z_][\\w\\.<>,\\[\\]\\?]*)\\s+` +
    `(?<name>[A-Za-z_]\\w*)\\s*\\((?<params>[^)]*)\\)\\s*\\{?\\s*$`,
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
  }
  const rawSignals: RawSignal[] = [];
  const rawFuncs = new Map<string, CsFuncInfo>();

  for (const [rel, lines] of loaded) {
    let buf: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      const raw = lines[index] as string;
      const lineno = index + 1;
      const s = raw.trim();

      if (s.startsWith("[")) {
        buf.push(raw);
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

      const [meta, dev, dirArg] = readMeta(buf);
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
        });
      }
    }
  }

  for (const rs of rawSignals) {
    const cpath = containerPath(rs.meta, rs.rel);
    model.addSignal(
      makeSignal({
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
      }),
    );
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
      external: info.meta.get("external") === "true",
      group: topGroup(fpath),
      path: fpath,
    });
    model.addFunc(func);

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
