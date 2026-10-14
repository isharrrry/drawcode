/**
 * IR —— 内存态对象图，不落盘。对等 Python `model.py`。
 *
 * 语义的唯一事实源是源码；本结构由解析器每次重建，图（.drawio）只是派生产物 +
 * 人工排版载体。x/y/w/h 在 IR 里存在，但它们属于布局维度，`../../tools/dump_ir.py`
 * 刻意不把它们写进 L1 金标准。
 */

export type Direction = "in" | "out" | "inout";

export interface Signal {
  id: string;
  name: string;
  ctype: string;
  dir: Direction;
  file: string;
  line: number;
  unit: string;
  alias: string;
  note: string;
  external: boolean;
  group: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Param {
  name: string;
  ctype: string;
  dir: Direction;
}

export interface Func {
  id: string;
  name: string;
  ret: string;
  params: Param[];
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
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Edge {
  src: string;
  dst: string;
  rw: "read" | "write";
  /** 绝对画布坐标的折线拐点；空数组 = 交给路由算法。 */
  waypoints: Array<[number, number]>;
}

export interface Device {
  vendor: string;
  model: string;
  spec: string;
  size: string;
  asset: string;
}

/** 节点尺寸默认值来自参考实现：信号是 160x60 的椭圆，函数是 180x72 的圆角矩形。 */
export const SIGNAL_W = 160;
export const SIGNAL_H = 60;
export const FUNC_W = 180;
export const FUNC_H = 72;

export function makeSignal(init: Partial<Signal> & Pick<Signal, "id" | "name" | "ctype">): Signal {
  return {
    dir: "in",
    file: "",
    line: 0,
    unit: "",
    alias: "",
    note: "",
    external: false,
    group: "",
    x: 0,
    y: 0,
    w: SIGNAL_W,
    h: SIGNAL_H,
    ...init,
  };
}

export function makeFunc(init: Partial<Func> & Pick<Func, "id" | "name">): Func {
  return {
    ret: "void",
    params: [],
    file: "",
    line: 0,
    alias: "",
    note: "",
    tooltip: "",
    asset: "",
    external: false,
    group: "",
    reads: [],
    writes: [],
    calls: [],
    x: 0,
    y: 0,
    w: FUNC_W,
    h: FUNC_H,
    ...init,
  };
}

export function makeDevice(init: Partial<Device> = {}): Device {
  return { vendor: "", model: "", spec: "", size: "", asset: "", ...init };
}

export class Model {
  readonly signals = new Map<string, Signal>();
  readonly funcs = new Map<string, Func>();
  edges: Edge[] = [];
  readonly devices = new Map<string, Device>();
  files: string[] = [];

  constructor(files: string[] = []) {
    this.files = files;
  }

  addSignal(signal: Signal): void {
    this.signals.set(signal.id, signal);
  }

  addFunc(func: Func): void {
    this.funcs.set(func.id, func);
  }

  /** 边完全由函数体的读写集合推导 —— 与注释无关。 */
  rebuildEdges(): Edge[] {
    const out: Edge[] = [];
    for (const func of this.funcs.values()) {
      for (const sid of func.reads) out.push({ src: sid, dst: func.id, rw: "read", waypoints: [] });
      for (const sid of func.writes) out.push({ src: func.id, dst: sid, rw: "write", waypoints: [] });
    }
    this.edges = out;
    return out;
  }

  entity(id: string): Signal | Func | undefined {
    return this.signals.get(id) ?? this.funcs.get(id);
  }
}
