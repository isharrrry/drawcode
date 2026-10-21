/**
 * IR —— 内存态对象图，不落盘（早期由 Python `model.py` 首次定义，该实现已于 2026-10 退役）。
 *
 * 语义的唯一事实源是源码；本结构由解析器每次重建，图（.drawio）只是派生产物 +
 * 人工排版载体。x/y/w/h 在 IR 里存在，但它们属于布局维度，`dump-ir`
 * 刻意不把它们写进 L1 金标准。
 */

/**
 * 信号方向。空串是合法值：注解里没写 `dir`（或写成 `dir=""`）时就是它 ——
 * 信号照样成立，只是没有方向。别把空串当"非法"而把整个信号丢掉。
 */
export type Direction = "in" | "out" | "inout" | "";


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
  /**
   * 容器层级，`adc/采样前端` 这样的斜杠路径。空串表示「没标」，解析器会把它归一化成
   * 模块名（`adc.h` -> `adc`），所以下游拿到的 path 永远非空。
   * `group` 恒等于 path 的第一段，是给「只关心顶层容器」的旧代码用的。
   */
  path: string;
  /** 追加到节点样式串末尾的原始片段（`[Drawcode(Style="…")]`），空串 = 用默认样式。 */
  style: string;
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
  /** 追加到节点样式串末尾的原始片段，空串 = 用默认样式。 */
  style: string;
  external: boolean;
  group: string;
  path: string;
  reads: string[];
  writes: string[];
  calls: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 自由文字块 —— 图上「不表达语义、只表达怎么读这张图」的那一层。
 *
 * 它不是节点：不参与 `rebuildEdges`、不参与容器归属、不参与障碍规避，
 * 只是一块钉死在画布坐标上的文字（可带底色）。所以它**不是** EntityKind 的第三个成员 ——
 * 一旦进了 entities()，它就会被当成可连线的节点、被算进容器包围盒，
 * 那才是真正会把图弄乱的路径。
 */
export interface Callout {
  id: string;
  /** 显示文本。可以含 `<br>`：draw.io 按 HTML 换行，离线渲染器把它转成换行符。 */
  text: string;
  /** 宿主实体 id（Func/Signal），仅作溯源；空串表示这是整张图的说明。 */
  owner: string;
  /** 视觉种类：text 无边框文字 / box 带底色说明框 / band 大片分区带。 */
  shape: "text" | "box" | "band";
  /** 字号；0 表示用该种类的默认值。 */
  fontSize: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 「从图里读回、且与 build 本来会写出的值不同」的那部分几何 —— 也就是要回写进源码注解的
 * 人工排版意图。
 *
 * 判据为什么是「与 build 会写出的值比」而不是「与默认布局比」：一个节点在源码里已经有
 * `xy`（作者手工钉过）时，它的坐标本来就与默认布局不同 —— 若拿默认布局当基准，每次
 * `sync` 都会重写一遍这个键。基准取「build 会写出什么」（源码声明值，没声明则是默认布局值），
 * 两个来源才归一到同一条线上：**只有读出值与 build 产物不一致，才算「人拖过」**。
 * 这也是让 `sync` 在没人动过的情况下保持零 diff 的前提。
 *
 * 谁来填：只有 `applyLayout`（drawio.ts）。它是唯一同时握着「读回值」与「build 会写出的值」
 * 两个数的地方。谁去读：`codegen.ts`（渲染注解）与测试。空表 = 没人动过布局，产物逐字节不变。
 *
 * 值是**绝对画布坐标**（与 `Signal.x/y` 同坐标系）。节点在容器里时，写进 XML 的是相对坐标、
 * 源码注解里的是绝对坐标 —— 换算由 drawio.ts 与 codegen.ts 各自负责，这里只存绝对原值。
 */
export interface PinnedGeom {
  /** 读回的绝对左上角；省略 = 这次没被拖动。 */
  xy?: [number, number];
  /** 读回的宽高；省略 = 这次没被缩放。 */
  size?: [number, number];
}

/** 边的种类。`inline` 是折叠后的**直连边**：写者函数 -> 读者函数，中间没有信号节点。 */
export type EdgeKind = "read" | "write" | "inline";

export interface Edge {
  src: string;
  dst: string;
  rw: EdgeKind;
  /** 绝对画布坐标的折线拐点；空数组 = 交给路由算法。 */
  waypoints: Array<[number, number]>;
  /** 仅 `inline` 边有：被折叠掉的信号 id，用来把标签文本找回来。 */
  sig?: string;
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
    path: "",
    style: "",
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
    style: "",
    external: false,
    group: "",
    path: "",
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

export function makeCallout(init: Partial<Callout> & Pick<Callout, "id" | "text">): Callout {
  return {
    owner: "",
    shape: "text",
    fontSize: 0,
    x: 0,
    y: 0,
    w: 200,
    h: 40,
    ...init,
  };
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

export class Model {
  readonly signals = new Map<string, Signal>();
  readonly funcs = new Map<string, Func>();
  edges: Edge[] = [];
  readonly devices = new Map<string, Device>();
  readonly callouts: Callout[] = [];
  /**
   * 被 `collapseSignals` 折叠成直连边的信号 id。`entities()` 必须跳过它们 ——
   * 否则信号节点照画、边却没了两段，图上会剩一堆悬空的椭圆。
   */
  readonly inlined = new Set<string>();
  /** 被折叠的信号 -> [写者函数 id, 读者函数 id]，`rebuildEdges` 靠它发射直连边。 */
  readonly inlinePairs = new Map<string, [string, string]>();
  /**
   * 与 `inlined` 同一路数的「一次性标记」：由 `applyLayout` 在读回排版时填，
   * 记下与 build 本来会写出的几何不一致的实体（entity id -> 差别在哪几项）。
   * 只在 `sync`/`--layout-from` 这条链上有内容；纯 `build` 永远是空表。
   */
  readonly pinned = new Map<string, PinnedGeom>();
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

  addCallout(callout: Callout): void {
    this.callouts.push(callout);
  }

  /** 边完全由函数体的读写集合推导 —— 与注释无关。内联边同样只在这里产生。 */
  rebuildEdges(): Edge[] {
    const out: Edge[] = [];
    for (const func of this.funcs.values()) {
      for (const sid of func.reads) {
        if (this.inlined.has(sid)) continue;
        out.push({ src: sid, dst: func.id, rw: "read", waypoints: [] });
      }
      for (const sid of func.writes) {
        if (this.inlined.has(sid)) continue;
        out.push({ src: func.id, dst: sid, rw: "write", waypoints: [] });
      }
    }
    // 折叠掉的信号：一条直连边代替原来的两段，`src`/`dst` 都是函数。
    for (const [sid, [from, to]] of this.inlinePairs) {
      out.push({ src: from, dst: to, rw: "inline", waypoints: [], sig: sid });
    }
    this.edges = out;
    return out;
  }

  entity(id: string): Signal | Func | undefined {
    return this.signals.get(id) ?? this.funcs.get(id);
  }
}

/**
 * 把「恰好一写一读」的信号折叠成写者到读者的一条直连边 —— 接口图的可读性来源。
 *
 * 为什么限定**恰好一写一读**：只有这时「信号」与「从 A 到 B 的这一根连线」才是同一样
 * 东西，折掉它不丢任何信息。多写（多处驱动同一信号）或多读（一个信号广播给多方）时，
 * 信号是一个真正的汇合点，折掉它就等于把图上的汇合关系抹掉了。
 *
 * 自环（同一个函数既写又读）也跳过：折出来会是一根自己指向自己的线。
 *
 * 副作用：会重算 `model.edges`。默认不调用，所以不传 `--inline` 时的产物逐字节不变。
 */
export function collapseSignals(model: Model): number {
  const writers = new Map<string, string[]>();
  const readers = new Map<string, string[]>();
  for (const func of model.funcs.values()) {
    for (const sid of func.writes) pushInto(writers, sid, func.id);
    for (const sid of func.reads) pushInto(readers, sid, func.id);
  }

  let folded = 0;
  for (const sid of model.signals.keys()) {
    const w = writers.get(sid) ?? [];
    const r = readers.get(sid) ?? [];
    if (w.length !== 1 || r.length !== 1) continue;
    const from = w[0] as string;
    const to = r[0] as string;
    if (from === to) continue;
    model.inlined.add(sid);
    model.inlinePairs.set(sid, [from, to]);
    folded++;
  }
  model.rebuildEdges();
  return folded;
}
