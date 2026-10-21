import type { Model } from "./model.ts";
import { compareCodePoints } from "./order.ts";

/**
 * IR → 规范化 JSON，`dump-ir` 与 L1 金标准共用这一口径。
 *
 * 刻意**不包含**布局坐标（x/y/w/h）：布局是 `.drawio` 层的事，
 * 混进 L1 会让路由 bug 看起来像解析 bug（见 ../../docs/conformance.md）。
 */

export interface IrSignal {
  id: string;
  name: string;
  ctype: string;
  dir: string;
  file: string;
  line: number;
  unit: string;
  alias: string;
  note: string;
  external: boolean;
  group: string;
}

export interface IrParam {
  name: string;
  ctype: string;
  dir: string;
}

export interface IrFunc {
  id: string;
  name: string;
  ret: string;
  params: IrParam[];
  file: string;
  line: number;
  alias: string;
  note: string;
  tooltip: string;
  asset: string;
  external: boolean;
  group: string;
  reads: string[];
  writes: string[];
  calls: string[];
}

export interface IrEdge {
  src: string;
  dst: string;
  rw: string;
}

export interface IrDevice {
  id: string;
  vendor: string;
  model: string;
  spec: string;
  size: string;
  asset: string;
}

export interface IrDump {
  signals: IrSignal[];
  funcs: IrFunc[];
  edges: IrEdge[];
  devices: IrDevice[];
  files: string[];
}

export function dumpIr(model: Model): IrDump {
  const signals: IrSignal[] = [...model.signals.values()]
    .sort((a, b) => compareCodePoints(a.id, b.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      ctype: s.ctype,
      dir: s.dir,
      file: s.file,
      line: s.line,
      unit: s.unit,
      alias: s.alias,
      note: s.note,
      external: s.external,
      group: s.group,
    }));

  const funcs: IrFunc[] = [...model.funcs.values()]
    .sort((a, b) => compareCodePoints(a.id, b.id))
    .map((f) => ({
      id: f.id,
      name: f.name,
      ret: f.ret,
      params: f.params.map((p) => ({ name: p.name, ctype: p.ctype, dir: p.dir })),
      file: f.file,
      line: f.line,
      alias: f.alias,
      note: f.note,
      tooltip: f.tooltip,
      asset: f.asset,
      external: f.external,
      group: f.group,
      reads: [...f.reads].sort(compareCodePoints),
      writes: [...f.writes].sort(compareCodePoints),
      calls: [...f.calls].sort(compareCodePoints),
    }));

  const edges: IrEdge[] = model.edges
    .map((e) => ({ src: e.src, dst: e.dst, rw: e.rw }))
    .sort((a, b) =>
      compareCodePoints(a.src, b.src) ||
      compareCodePoints(a.dst, b.dst) ||
      compareCodePoints(a.rw, b.rw),
    );

  const devices: IrDevice[] = [...model.devices.entries()]
    .sort((a, b) => compareCodePoints(a[0], b[0]))
    .map(([id, d]) => ({
      id,
      vendor: d.vendor,
      model: d.model,
      spec: d.spec,
      size: d.size,
      asset: d.asset,
    }));

  return { signals, funcs, edges, devices, files: [...model.files].sort(compareCodePoints) };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * 规范化 JSON 文本，**逐字节**钉住金标准目录下各用例的 `expected.ir.json`：
 * 键按字母序排列（码点序，不是 UTF-16 码元序），两空格缩进，末尾一个换行。
 */
export function dumpIrJson(model: Model): string {
  return `${JSON.stringify(sortKeys(dumpIr(model)), null, 2)}\n`;
}
