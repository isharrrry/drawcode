/**
 * drawio 方向：IR -> .drawio XML，以及反向的回读。
 *
 * 这是全项目最复杂的一块，也是性能热点。它做四件事：
 *
 *     1. 布局   assignDefaultPositions —— 组内按方向排序纵向堆叠，组间水平避让
 *     2. 路由   route / candidates / crosses —— 为每条边挑一组锚点和一条不撞节点的折线
 *     3. 发射   toDrawio —— 把容器、节点、方向端口、边写成 draw.io 认识的 XML
 *     4. 回读   readLayout / applyLayout —— 把人工调整过的排版取回来
 *
 * **跨语言几何契约**（三个实现必须逐字节一致，动这些等于让三版分叉）：
 *     ANCHOR_SETS 的**顺序**            决定平局时先选中哪组锚点
 *     SHRINK / SLACK / DETOUR           障碍判定与绕行的容差
 *     candidates() 里各种走法的**先后**   同样影响平局
 * 这些常量看着像随手取的数，其实是接口。要改必须三语言一起改并重新生成金标准。
 *
 * 节点用 `<object symbolId="…">` 包装，symbolId 是 drawcode 的身份标识：
 * readLayout 只认带 symbolId 的元素，所以用户在 draw.io 里手画的东西（裸 `<mxCell>`）
 * 不会被读进来污染 IR。
 */

import * as zlib from "node:zlib";

import { escapeHtml } from "./html.ts";
import type { Callout, Edge, Func, Model, PinnedGeom, Signal } from "./model.ts";
import { num } from "./num.ts";
import { compareCodePoints } from "./order.ts";
import type { XmlElement } from "./xml.ts";
import { findChild, findChildren, iterElements, parseXml } from "./xml.ts";

export type Point = [number, number];
export type Rect = [number, number, number, number];
export type Anchor = [number, number, number, number];

export const PAD = 30;
export const HEADER = 30;
export const NODE_W = 160;
export const NODE_H = 60;
export const GAP_Y = 40;

export const SIGNAL_STYLE = "shape=ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;";
export const FUNC_STYLE = "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;";
export const FUNC_EXT_STYLE = "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f5f5f5;strokeColor=#666666;";
export const CONT_STYLE =
  `swimlane;startSize=${HEADER};collapsible=0;recursiveResize=0;fillColor=#dae8fc;strokeColor=#6c8ebf;html=1;`;
export const EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;jumpStyle=arc;jumpSize=6;";

/**
 * `--straight-edges` 用的边样式：draw.io 的「直线」连接。
 *
 * `edgeStyle=none` 是 draw.io 里「Straight」的写法 —— 不跑任何布线算法，
 * 直接用一条直线连 exit 点到 entry 点。所以三件事都要去掉：
 *   - `edgeStyle=orthogonalEdgeStyle`：不清掉它，即使没有拐点，draw.io 也会**自己**再算一遍
 *     正交走线，线照样是弯的（这是最容易漏的一步）；
 *   - `rounded=1`：没有拐角，圆角无从谈起；
 *   - `jumpStyle=arc/jumpSize=6`：跨线跳弧只在布线器算拐点时才产生，直线不产生跨线。
 * `exitX/exitY/entryX/entryY` 锚点**保留** —— 它决定线从节点哪条边出发，与走法无关。
 */
export const STRAIGHT_EDGE_STYLE = "edgeStyle=none;html=1;";

/**
 * 被推开的边标签用的**子单元格**样式（见 laneOffsets 的说明）。
 *
 * 这串是 draw.io 自己拖动边标签后写的原样：`edgeLabel` 形状 + 居中。`points=[]`
 * 是它连带写下的一对空控制点，**别删** —— 删了 draw.io 打开时会自己补回来，
 * 文件于是"每次打开都变脏"，diff 里永远有噪音。
 */
export const EDGE_LABEL_STYLE =
  "edgeLabel;html=1;align=center;verticalAlign=middle;resizable=0;points=[];";

/**
 * 设备卡片：节点本身就是一张图，名字作为标签贴在图的下方。
 *
 * 为什么用 `shape=image` 而不是「圆角矩形 + `image=…`」：draw.io 的格式面板给矩形加图片时
 * 写的是 `image=…;imageAspect=0;imageWidth=…`，但那套键**只有 draw.io 自己的渲染路径认**，
 * 核心 mxGraph 的矩形形状完全不看它 —— 离线渲染器实测一个 `<image>` 都不出。而「两条渲染
 * 路径都能画出来」是这个项目的硬性前提（见本文件头对 `shape=path` 的说明），所以走
 * `shape=image`：实测两条路径都能出图。
 *
 * 代价：图片占满整个节点框，文字只能落到框外（`verticalLabelPosition=bottom`）。
 * 想在图里再写说明，用 Callout —— 那正是它存在的理由。
 */
export function funcImageStyle(asset: string): string {
  return (
    "shape=image;imageAspect=0;" +
    `image=${asset};` +
    "verticalLabelPosition=bottom;verticalAlign=top;html=1;fontSize=13;fontStyle=1;"
  );
}

/** `[Callout]` 的三种视觉：无边框文字 / 带底色说明框 / 大片分区带。 */
export const CALLOUT_FILL: Record<string, string> = { text: "none", box: "#fff2cc", band: "#f5f5f5" };
export const CALLOUT_STROKE: Record<string, string> = { text: "none", box: "#d6b656", band: "#b3b3b3" };
export const CALLOUT_FONT: Record<string, number> = { text: 12, box: 12, band: 15 };

/**
 * 文字块的样式串。
 *
 * `text;` 是 draw.io 的命名样式（无边框纯文本），**离线渲染器认不出这个裸段、会静默丢掉它**
 * （原因见 tools/render/render_drawio.js 里对 mxStylesheet 的说明）。所以这里同时把
 * strokeColor / fillColor 显式写成 none —— 裸段被丢也好、被认也好，两条渲染路径的结果都
 * 是一个无边框的文本框。
 *
 * 刻意不用 draw.io 的 `shape=note`（带折角的便签）：它不在 mxCellRenderer 的默认形状表里，
 * 离线渲染会退回矩形，等于「预览里看到的不是 draw.io 里看到的」。
 */
export function calloutStyle(c: Callout): string {
  const fill = CALLOUT_FILL[c.shape] ?? "none";
  const stroke = CALLOUT_STROKE[c.shape] ?? "none";
  const size = c.fontSize > 0 ? c.fontSize : (CALLOUT_FONT[c.shape] ?? 12);
  const base = c.shape === "text" ? "text;" : "rounded=1;";
  const dashed = c.shape === "band" ? "dashed=1;" : "";
  return (
    `${base}whiteSpace=wrap;html=1;strokeColor=${stroke};fillColor=${fill};${dashed}` +
    `align=left;verticalAlign=top;fontSize=${num(size)};spacingLeft=8;spacingTop=6;`
  );
}

// 方向五边形：形状本身就表达数据流向，不再往节点上贴额外的记号。
//
//   输入 = 左边平、右边尖   —— 数据从右侧尖角流进来
//   输出 = 右边平、左边尖   —— 数据从左侧尖角流出去
//
// 路径坐标按 160x60 的**设计尺寸**书写（正是 NODE_W x NODE_H），尖角精确落在
// 左右边缘中点上 —— 与 ANCHOR_SETS 第一条的 (1.0,0.5)/(0.0,0.5) 重合，所以
// 连线的起止点天然咬在尖角上，不需要额外补偿。
//
// 为什么用 `shape=path` 而不是现成的五边形：mxGraph 核心只注册了
// box/customShape/sample 三个形状，`mxgraph.basic.pentagon` 之类是 draw.io 的
// 扩展形状，离线渲染器画不出来（会退化成矩形），也就无法验证。`shape=path`
// 是 draw.io 的标准功能，渲染器侧由 tools/render/render_drawio.js 注册实现，
// 两边都能得到同一个五边形。
//
// 无方向的信号仍旧用椭圆（没有任何流向可表达）。
export const PENTA_IN_PATH = "0,0 115,0 160,30 115,60 0,60";
export const PENTA_OUT_PATH = "45,0 160,0 160,60 45,60 0,30";
export const SIGNAL_IN_STYLE = `shape=path;path=${PENTA_IN_PATH};whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;`;
export const SIGNAL_OUT_STYLE = `shape=path;path=${PENTA_OUT_PATH};whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;`;
export const SIGNAL_DIR_STYLE: Record<string, string> = {
  in: SIGNAL_IN_STYLE,
  out: SIGNAL_OUT_STYLE,
};
export const DETOUR = 15;
export const SLACK = 2;
export const SHRINK = 3;

/** 先试对向锚点，再试同侧锚点（同侧配侧向绕行用）。顺序即优先级，不要重排。 */
export const ANCHOR_SETS: Anchor[] = [
  [1.0, 0.5, 0.0, 0.5],
  [0.0, 0.5, 1.0, 0.5],
  [0.5, 1.0, 0.5, 0.0],
  [0.5, 0.0, 0.5, 1.0],
  [1.0, 0.5, 1.0, 0.5],
  [0.0, 0.5, 0.0, 0.5],
  [0.5, 0.0, 0.5, 0.0],
  [0.5, 1.0, 0.5, 1.0],
];

export type EntityKind = "signal" | "func";

export interface Entity {
  kind: EntityKind;
  ent: Signal | Func;
}

export function anchorStyle(a: Anchor): string {
  return (
    `exitX=${num(a[0])};exitY=${num(a[1])};exitDx=0;exitDy=0;` +
    `entryX=${num(a[2])};entryY=${num(a[3])};entryDx=0;entryDy=0;`
  );
}

/**
 * 从样式串里读回锚点 —— 只在「走 `--layout-from` 拿到人工拐点、本次没有路由」
 * 的边上用得到，此时锚点只能从写出去的那串样式里认。认不出返回 null，
 * 由调用方退到默认锚点；draw.io 对无锚点的边是"就近贴边框"，与这里的近似无关。
 */
export function styleAnchor(style: string): Anchor | null {
  const m =
    /exitX=([\d.-]+);exitY=([\d.-]+);exitDx=[\d.-]+;exitDy=[\d.-]+;entryX=([\d.-]+);entryY=([\d.-]+);/.exec(
      style,
    );
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

/**
 * 对等 Python `_attrs`：跳过 None / 空串，值走 `html.escape(quote=True)`。
 *
 * 注意这里是**第二遍**转义 —— label 里已经是 `&lt;br&gt;`，这里的 `&` 会变成 `&amp;`。
 * 少一遍或顺序反了，金标准里的 `label="g_raw&lt;br&gt;..."` 就对不上。
 */
export function attrs(pairs: Array<[string, string | null | undefined]>): string {
  return pairs
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}="${escapeHtml(String(value), true)}"`)
    .join(" ");
}

export function entities(model: Model): Entity[] {
  const out: Entity[] = [];
  // 被折叠成直连边的信号不出现在图上：它已经变成那根线上的标签，
  // 再画一个空椭圆就是个既没有入边也没有出边的悬空节点。
  for (const signal of model.signals.values()) {
    if (model.inlined.has(signal.id)) continue;
    out.push({ kind: "signal", ent: signal });
  }
  for (const func of model.funcs.values()) out.push({ kind: "func", ent: func });
  return out;
}

export function edgeKey(e: { src: string; dst: string; rw: string }): string {
  return `${e.src}->${e.dst}:${e.rw}`;
}

export function rect(model: Model, sid: string): Rect {
  const ent = model.signals.get(sid) ?? model.funcs.get(sid);
  if (ent === undefined) throw new Error(`drawcode: unknown symbol ${sid}`);
  return [ent.x, ent.y, ent.w, ent.h];
}

export type Gap = { kind: "v" | "h"; pos: number } | null;

/** 两容器之间的空缝；互相重叠时没有缝。 */
export function crossGap(sbox: Rect, dbox: Rect): Gap {
  if (sbox[0] + sbox[2] <= dbox[0]) {
    return { kind: "v", pos: (sbox[0] + sbox[2] + dbox[0]) / 2.0 };
  }
  if (dbox[0] + dbox[2] <= sbox[0]) {
    return { kind: "v", pos: (dbox[0] + dbox[2] + sbox[0]) / 2.0 };
  }
  if (sbox[1] + sbox[3] <= dbox[1]) {
    return { kind: "h", pos: (sbox[1] + sbox[3] + dbox[1]) / 2.0 };
  }
  if (dbox[1] + dbox[3] <= sbox[1]) {
    return { kind: "h", pos: (dbox[1] + dbox[3] + sbox[1]) / 2.0 };
  }
  return null;
}

export function endpoints(srect: Rect, drect: Rect, a: Anchor): [Point, Point] {
  return [
    [srect[0] + srect[2] * a[0], srect[1] + srect[3] * a[1]],
    [drect[0] + drect[2] * a[2], drect[1] + drect[3] * a[3]],
  ];
}

/** 沿锚点所在边的法线外移 DETOUR：让线先离开边框再走，不贴着边框爬。 */
export function lanePt(pt: Point, ax: number, ay: number): Point {
  const [x, y] = pt;
  if (ax === 0) return [x - DETOUR, y];
  if (ax === 1) return [x + DETOUR, y];
  if (ay === 0) return [x, y - DETOUR];
  if (ay === 1) return [x, y + DETOUR];
  return [x, y];
}

function samePoint(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** 同一组锚点下的几种正交走法。数组顺序参与 tie-break（同长度取先出现的）。 */
export function candidates(
  sp: Point,
  dp: Point,
  a: Anchor,
  srect: Rect,
  drect: Rect,
  gap: Gap,
): Point[][] {
  const out: Point[][] = [];
  if (gap !== null) {
    if (gap.kind === "v") out.push([sp, [gap.pos, sp[1]], [gap.pos, dp[1]], dp]);
    else out.push([sp, [sp[0], gap.pos], [dp[0], gap.pos], dp]);
  }
  out.push([sp, [dp[0], sp[1]], dp]);
  out.push([sp, [sp[0], dp[1]], dp]);

  if (a[0] === a[2] && (a[0] === 0 || a[0] === 1)) {
    const lane =
      a[0] === 0
        ? Math.min(srect[0], drect[0]) - DETOUR
        : Math.max(srect[0] + srect[2], drect[0] + drect[2]) + DETOUR;
    out.push([sp, [lane, sp[1]], [lane, dp[1]], dp]);
  }
  if (a[1] === a[3] && (a[1] === 0 || a[1] === 1)) {
    const lane =
      a[1] === 0
        ? Math.min(srect[1], drect[1]) - DETOUR
        : Math.max(srect[1] + srect[3], drect[1] + drect[3]) + DETOUR;
    out.push([sp, [sp[0], lane], [dp[0], lane], dp]);
  }

  const sp2 = lanePt(sp, a[0], a[1]);
  const dp2 = lanePt(dp, a[2], a[3]);
  if (!samePoint(sp2, sp) || !samePoint(dp2, dp)) {
    out.push([sp, sp2, [dp2[0], sp2[1]], dp2, dp]);
    out.push([sp, sp2, [sp2[0], dp2[1]], dp2, dp]);
  }
  return out;
}

/** 线段是否插进节点框；两端各收 SHRINK，端点贴边不算穿透。 */
export function crosses(box: Rect, p: Point, q: Point): boolean {
  const [x, y, w, h] = box;
  if (Math.abs(p[1] - q[1]) < 0.5) {
    let lo = Math.min(p[0], q[0]);
    let hi = Math.max(p[0], q[0]);
    lo += SHRINK;
    hi -= SHRINK;
    return hi > lo && y - SLACK < p[1] && p[1] < y + h + SLACK && hi > x && lo < x + w;
  }
  if (Math.abs(p[0] - q[0]) < 0.5) {
    let lo = Math.min(p[1], q[1]);
    let hi = Math.max(p[1], q[1]);
    lo += SHRINK;
    hi -= SHRINK;
    return hi > lo && x - SLACK < p[0] && p[0] < x + w + SLACK && hi > y && lo < y + h;
  }
  return false;
}

export function polylineLength(pts: Point[]): number {
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i] as Point;
    const q = pts[i + 1] as Point;
    total += Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
  }
  return total;
}

/** 五边形尖角所在的一侧。只有 in/out 有尖角，其余为 null（不约束）。 */
export type Side = "left" | "right" | null;

/**
 * 信号节点的连线接入边：输入接右侧（右尖）、输出接左侧（左尖）。
 *
 * 这两个值是刻意固定的，不是"可选之一"：五边形的尖角本身就是流向的标记，
 * 线从平边接进去会把标记的意思废掉。函数与无方向的信号返回 null —— 它们的
 * 形状没有表达方向，硬性限制只会逼线绕远路。
 */
export function connSide(model: Model, eid: string): Side {
  const sig = model.signals.get(eid);
  if (sig === undefined) return null;
  if (sig.dir === "in") return "right";
  if (sig.dir === "out") return "left";
  return null;
}

/** 锚点是否满足两端的方向约束（中点锚点才算数，0.5 是对应的 y）。 */
function sideOk(a: Anchor, srcSide: Side, dstSide: Side): boolean {
  if (srcSide !== null) {
    const want = srcSide === "right" ? 1.0 : 0.0;
    if (a[0] !== want || a[1] !== 0.5) return false;
  }
  if (dstSide !== null) {
    const want = dstSide === "right" ? 1.0 : 0.0;
    if (a[2] !== want || a[3] !== 0.5) return false;
  }
  return true;
}

/**
 * 在所有锚点/走法组合里挑一条不撞节点的最短线。
 * 返回 `[anchors, 中间拐点]`；全撞时 anchors 为 null，交回 drawio 自己路由。
 *
 * `srcSide`/`dstSide` 是方向约束。**约束无解时会放宽重试一次** —— 宁可偶尔
 * 让线不咬尖角，也不能让边凭空消失。
 */
export function route(
  srect: Rect,
  drect: Rect,
  obstacles: Rect[],
  gap: Gap,
  srcSide: Side = null,
  dstSide: Side = null,
): [Anchor | null, Point[]] {
  const search = (withConstraints: boolean): { n: number; a: Anchor; pts: Point[] } | null => {
    let best: { n: number; a: Anchor; pts: Point[] } | null = null;
    for (const a of ANCHOR_SETS) {
      if (withConstraints && !sideOk(a, srcSide, dstSide)) continue;
      const [sp, dp] = endpoints(srect, drect, a);
      for (const pts of candidates(sp, dp, a, srect, drect, gap)) {
        let blocked = false;
        for (let i = 0; i + 1 < pts.length && !blocked; i++) {
          for (const box of obstacles) {
            if (crosses(box, pts[i] as Point, pts[i + 1] as Point)) {
              blocked = true;
              break;
            }
          }
        }
        if (blocked) continue;
        const n = polylineLength(pts);
        if (best === null || n < best.n) best = { n, a, pts };
      }
    }
    return best;
  };

  let best = search(true);
  if (best === null && (srcSide !== null || dstSide !== null)) best = search(false);
  if (best === null) return [null, []];
  const chosen = best as { n: number; a: Anchor; pts: Point[] };
  return [chosen.a, chosen.pts.slice(1, -1)];
}

/**
 * 按边的两端算出锚点与拐点。
 *
 * **两个调用点（autoWaypoints 与 toDrawio）必须走这一个入口**：它们算出的
 * 拐点必须逐字相同，否则 applyLayout 会把自动产生的拐点误认成人工拖动、
 * 锁死不再重算。
 */
export function routeEdge(
  model: Model,
  e: Edge,
  avoid: Rect[],
  gap: Gap,
): [Anchor | null, Point[]] {
  return route(
    rect(model, e.src),
    rect(model, e.dst),
    avoid,
    gap,
    connSide(model, e.src),
    connSide(model, e.dst),
  );
}

/** 叠印的标签沿法线推开的间距，单位像素。要大于一行字高，否则还是糊在一起。 */
export const LABEL_LANE = 17;

/**
 * 折线的**弧长中点**，以及中点处的单位法线。
 *
 * 为什么是弧长中点：draw.io 把边的文字放在那儿，这是从渲染结果反推出来的 ——
 * 五条已知边的实测标签位置与弧长中点只差**同一个**常量偏移（那是我算漏的容器原点）。
 * 用欧氏长度，不能用上面 polylineLength 的曼哈顿长度：折了弯以后两者差半个身位。
 *
 * 返回的法线用来决定「往哪边推开」，只在去叠印时用得上。
 */
export function midAndNormal(pts: Point[]): [Point, Point] {
  const segs: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i] as Point;
    const q = pts[i + 1] as Point;
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    segs.push(d);
    total += d;
  }
  const first = pts[0] ?? ([0, 0] as Point);
  if (total === 0) return [first, [0, -1]];

  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as number;
    if (acc + seg >= total / 2) {
      const p = pts[i] as Point;
      const q = pts[i + 1] as Point;
      const t = seg === 0 ? 0 : (total / 2 - acc) / seg;
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      return [
        [p[0] + dx * t, p[1] + dy * t],
        [-dy / len, dx / len],
      ];
    }
    acc += seg;
  }
  return [pts[pts.length - 1] as Point, [0, -1]];
}

/** 边标签的字号（draw.io 默认 12），用来估算文字占多宽 —— 判重叠要用它。 */
export const LABEL_FONT = 12;

/**
 * 标签文字的估算占位盒 `[x, y, w, h]`，**以落点为中心**。
 *
 * 为什么是居中而不是「从落点向右铺」：渲染件里标签是
 * `<g text-anchor="middle"><text x="中点">…` —— 那个 `x` 是文字**中心**，不是左边缘。
 * （曾经据「三条叠印标签的 x 完全相同」判成左对齐，那个观察对两种情况都成立，不能分辨。）
 * 推论：判重叠不能只比落点，落点差十几像素的两条标签照样大面积互相覆盖 ——
 * 看上去就是一团糊字，这正是要治的病。
 * 宽度按字数估：中日韩/全角一个字一格，拉丁字母半个多格（略宽于实测，宁可多判一处）。
 */
function labelBox(anchor: Point, label: string): Rect {
  const w = textWidth(label, LABEL_FONT);
  const h = LABEL_FONT * 1.4;
  return [anchor[0] - w / 2, anchor[1] - h / 2, w, h];
}

/** 两个占位盒是否真的压在一起（留 2 像素容差，免得贴边也算撞）。 */
function boxesClash(a: Rect, b: Rect): boolean {
  return (
    a[0] < b[0] + b[2] - 2 && b[0] < a[0] + a[2] - 2 && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
  );
}

/**
 * 把**压在一起**的标签推开，返回每条在 **y 方向**上的位移（没撞的都是 0；
 * **正数向下、负数向上** —— 调用方直接把它写进 `as="offset"` 的 y，不再取反）。
 *
 * 为什么必须处理这件事：`--inline` 把一写一读的信号折成直连边之后，同一对节点
 * 之间的几条边会走到**同一条折线**上（锚点都取边的中点，见 ANCHOR_SETS），
 * 于是标签叠印在同一点。实测在 12 台设备 / 26 条边的总览图里有 4 处，一段话糊成
 * 一团黑，整张图就没法读了。
 *
 * 算法三步：
 *   1. 占位盒相交（boxesClash）就把两条连起来，取**连通分量** —— 一团是一个分量，
 *      这么连是必要的：甲撞乙、乙撞丙而甲丙不撞时，三条仍得各占一个位置。
 *   2. 团内按传入次序编号，第 1 条不动，其余按 +1、-1、+2… 交替让开 —— 一路往同
 *      一边推的话，几条标签会推出画布外面去。第 1 条不动还有一个好处：没有叠印的
 *      图，产物逐字节不变。
 *
 * 为什么只往竖直方向推，不沿各边的法线推：
 *   - **横向推不划算**。文字是横排的，一个字那么宽、一行那么高（12 号字约 7×14），
 *     水平分开两条标签要挪 `(宽甲+宽乙)/2`（实测「read」撞「write」要 24 像素），
 *     竖直分开只要一个字高（约 15 像素）。而且上下两行是人的阅读习惯，左右并排不是。
 *   - **各推各的法线会漏**。实测 small-c：一条边横走、另一条竖走，两条标签只差
 *     6 像素；法线互相垂直，各推 17 像素之后竖直方向一点没分开，还是叠着。
 */
export function separateLabels(boxes: Array<Rect | null>, lane: number): number[] {
  const out = new Array<number>(boxes.length).fill(0);

  // 1. 连通分量（并查集，路径压缩交给 find 里的循环）
  const parent = Array.from({ length: boxes.length }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r] as number;
    let c = x;
    while (parent[c] !== r) {
      const next = parent[c] as number;
      parent[c] = r;
      c = next;
    }
    return r;
  };
  for (let i = 0; i < boxes.length; i++) {
    // 必须显式挡 undefined：noUncheckedIndexedAccess 下 boxes[i] 是
    // `Rect | null | undefined`，只写 `=== null` 会漏掉 undefined，
    // 接着传给 boxesClash(需要 Rect) 就是类型错误。
    // 写成 `== null` 更短，但本仓库一律用 `===`，不在这里开先例。
    const a = boxes[i];
    if (a === null || a === undefined) continue;
    for (let j = 0; j < i; j++) {
      const b = boxes[j];
      if (b === null || b === undefined || !boxesClash(a, b)) continue;
      parent[find(i)] = find(j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i] === null) continue;
    const root = find(i);
    const list = groups.get(root);
    if (list === undefined) groups.set(root, [i]);
    else list.push(i);
  }

  // 2. 团内错开：第 1 条不动，其余按 +1、-1、+2… 试格，取**第一个真的错开**的。
  //    为什么要试、不能直接按格号算：格号给出的位移是固定的 17 像素，可两条标签
  //    本来就可能差着 6 像素（不相上下），往那边推 17 像素会**过冲**，落到另一侧
  //    又只差 11 像素，仍小于一个行高 —— 还是叠着。所以按「与已落位的每一条都错开
  //    各自半高之和」来判，判过才算。
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const placed: Array<Rect | null> = [];
    list.forEach((idx, k) => {
      const box = boxes[idx] as Rect;
      if (k === 0) {
        placed.push(box);
        return;
      }
      for (let step = 1; ; step += 1) {
        const shift = laneShift(step) * lane;
        const moved: Rect = [box[0], box[1] + shift, box[2], box[3]];
        if (placed.every((p) => p === null || !overlapsY(moved, p))) {
          out[idx] = shift;
          placed.push(moved);
          return;
        }
      }
    });
  }
  return out;
}

/** 两个盒子在竖直方向是否还有重叠（横向重叠与否不参与 —— 只是用来判「错开」）。 */
function overlapsY(a: Rect, b: Rect): boolean {
  return a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

/** 格号 -> 竖直方向的格数。0 格不动，其余按 +1、-1、+2… 交替（下、上、下下…），
 * 免得几条标签一起往同一边推、推出画布。 */
export function laneShift(lane: number): number {
  if (lane === 0) return 0;
  return (lane % 2 === 1 ? 1 : -1) * Math.ceil(lane / 2);
}

/** 占位盒：.svg 侧的标签以落点**居中**，宽度按字数估（与 labelBox 同一套估法）。 */
export function textBox(center: Point, label: string, font: number): Rect {
  const [x, y] = center;
  const w = textWidth(label, font);
  return [x - w / 2, y - font, w, font * 1.4];
}

/** 一行文字大概占多宽：中日韩/全角一个字一格，拉丁字母半个多格。 */
export function textWidth(label: string, font: number): number {
  let w = 0;
  for (const ch of label) {
    w += /[⺀-鿿　-〿＀-￯]/.test(ch) ? font : font * 0.58;
  }
  return w;
}

/**
 * 实体的容器路径。
 *
 * `path` 是完整层级（`adc/采样`），`group` 是它的第一段。老实体只填了 group，
 * 所以这里退回 group；两者都空才落到 `misc`。解析器保证 path 非空，
 * 这个兜底是给手工构造的 model 用的。
 */
export function entityPath(e: Signal | Func): string {
  return e.path || e.group || "misc";
}

export interface TreeNode {
  members: Array<Signal | Func>;
  children: string[];
}

/**
 * 从所有实体的 path 推出容器树。
 *
 * 中间层级即使没有直属成员也会被建出来 —— `path="adc/采样"` 里那个 `adc`
 * 必须存在，否则子容器会没有父框可挂。
 */
export function containerTree(model: Model): Map<string, TreeNode> {
  const nodes = new Map<string, TreeNode>();
  for (const { ent } of entities(model)) {
    const parts = entityPath(ent).split("/");
    for (let i = 1; i <= parts.length; i++) {
      const key = parts.slice(0, i).join("/");
      if (!nodes.has(key)) nodes.set(key, { members: [], children: [] });
    }
    (nodes.get(parts.join("/")) as TreeNode).members.push(ent);
  }
  for (const p of [...nodes.keys()]) {
    if (p.includes("/")) {
      const parent = p.slice(0, p.lastIndexOf("/"));
      const kids = (nodes.get(parent) as TreeNode).children;
      if (!kids.includes(p)) kids.push(p);
    }
  }
  return nodes;
}

/** 一个容器及其所有子孙的成员，展开成一维列表。*/
export function allMembers(nodes: Map<string, TreeNode>, path: string): Array<Signal | Func> {
  const node = nodes.get(path) as TreeNode;
  const out = [...node.members];
  for (const child of node.children) out.push(...allMembers(nodes, child));
  return out;
}

/**
 * 组内排序权：输入信号靠上、输出信号靠下，中间留给无方向的实体。
 *
 * 这样整张图的数据流方向是「左上 -> 右下」，与方向五边形的尖角朝向一致。
 * 函数没有 dir 属性，取到 undefined 后落到空串，自然落在中间。
 */
export function dirRank(e: Signal | Func): number {
  const d = (e as Partial<Signal>).dir ?? "";
  if (d === "in") return 0;
  if (d === "out") return 2;
  return 1;
}

/** 容器（泳道）的包围盒：成员节点的并集，四周各留 PAD，顶部再加 HEADER 放标题。 */
export function containerBox(members: Array<Signal | Func>): Rect {
  if (members.length === 0) {
    // 中间容器（`a/b/c` 里的 `b`）只有子容器、没有直属成员，会走到这里。
    // 少了这一条，Math.min() 取空数组得 Infinity，几何会算成字面量 "NaN" 写进文件。
    return [0, 0, 0, 0];
  }
  const xs = members.map((e) => e.x);
  const ys = members.map((e) => e.y);
  const x2 = members.map((e) => e.x + e.w);
  const y2 = members.map((e) => e.y + e.h);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return [
    minX - PAD,
    minY - PAD - HEADER,
    Math.max(...x2) - minX + 2 * PAD,
    Math.max(...y2) - minY + 2 * PAD + HEADER,
  ];
}

function byRankThenId(a: Signal | Func, b: Signal | Func): number {
  return dirRank(a) - dirRank(b) || compareCodePoints(a.id, b.id);
}

/**
 * 把一组实体在给定左上角垂直堆叠，返回它们的包围盒。
 *
 * 只对**直属成员**调用（`layoutTree` 里 `members === own` 那一支）——它们从没被
 * 递归设过坐标，所以 `e.x === 0 && e.y === 0` 对块里每个成员都成立。带人工坐标
 * （`@drawcode xy="…"`）的节点不受影响。
 */
function stack(members: Array<Signal | Func>, xLeft: number, yTop: number): Rect {
  let y = yTop;
  for (const e of members) {
    if (e.x === 0 && e.y === 0) {
      e.x = xLeft;
      e.y = y;
    }
    y += e.h + GAP_Y;
  }
  return containerBox(members);
}

/**
 * 递归排布一个容器：子容器各成一块，直属成员另成一块，横向依次摆开。
 *
 * 单层容器（没有子容器）时，这就退化成「成员垂直堆叠」—— 与老行为完全一致，
 * 所以没有任何 `path=` 的源码产物逐字节不变。
 */
function layoutTree(
  nodes: Map<string, TreeNode>,
  path: string,
  xLeft: number,
  yTop: number,
): Rect | null {
  const node = nodes.get(path) as TreeNode;
  const own = node.members.slice().sort(byRankThenId);

  // 块宽必须按**整棵子树**算。中间容器（`a/b/c` 里的 `b`）自己没有直属成员，
  // 若只看它的 members，宽度是 0 → 游标不前进 → 几棵子树叠在一起。
  const blocks: Array<Array<Signal | Func>> = [];
  for (const child of node.children.slice().sort(compareCodePoints)) {
    layoutTree(nodes, child, 0, 0);
    const members = allMembers(nodes, child);
    if (members.length > 0) blocks.push(members);
  }
  if (own.length > 0) blocks.push(own);
  if (blocks.length === 0) return null;

  // 游标走的是**块左边界**（和 containerBox 同一基准），不是成员坐标 ——
  // 早先把成员坐标 xLeft 和包围盒左边界 box[0] 拿来比较，两者差一个 PAD，
  // 于是永远判定"需要平移"，把整块又推了 30。
  let cursor = xLeft;
  for (const members of blocks) {
    if (members === own) {
      stack(members, cursor, yTop);
    } else {
      // 子容器已经在局部坐标系里排好了，整体平移到游标即可 ——
      // 它的子容器也在这份 members 里，所以会跟着一起走。
      const box = containerBox(members);
      const dx = cursor - box[0];
      for (const e of members) e.x += dx;
    }
    const box = containerBox(members);
    cursor = box[0] + box[2] + 2 * PAD + PAD;
  }
  return containerBox(blocks.flat());
}

/** 给没坐标的实体排初始位；顶层容器之间做水平避让，保证不互相压住。*/
export function assignDefaultPositions(model: Model): void {
  const nodes = containerTree(model);
  const tops = [...nodes.keys()].filter((p) => !p.includes("/")).sort(compareCodePoints);

  let rightEdge: number | null = null;
  for (const gname of tops) {
    layoutTree(nodes, gname, PAD, PAD + HEADER + PAD);
    const members = allMembers(nodes, gname);
    // 若这一棵树比已排好的往左，就整棵右移，避免两个顶层容器水平重叠
    let box = containerBox(members);
    if (rightEdge !== null && box[0] < rightEdge) {
      const dx = rightEdge - box[0];
      for (const e of members) e.x += dx;
      box = containerBox(members);
    }
    rightEdge = box[0] + box[2] + 4 * PAD;
  }
}

/** 当前坐标下每条边会自动算出的拐点，用来认出"这是生成器写的，不是人拖的"。 */
export function autoWaypoints(model: Model): Map<string, Point[]> {
  const nodes = containerTree(model);
  const boxes = new Map<string, Rect>();
  for (const p of nodes.keys()) boxes.set(p, containerBox(allMembers(nodes, p)));

  const auto = new Map<string, Point[]>();
  for (const e of model.edges) {
    const srcEnt = model.signals.get(e.src) ?? model.funcs.get(e.src);
    const dstEnt = model.signals.get(e.dst) ?? model.funcs.get(e.dst);
    const sg = srcEnt === undefined ? "misc" : entityPath(srcEnt);
    const dg = dstEnt === undefined ? "misc" : entityPath(dstEnt);
    const avoid = entities(model).map(({ ent }): Rect => [ent.x, ent.y, ent.w, ent.h]);
    const gap = sg !== dg ? crossGap(boxes.get(sg) as Rect, boxes.get(dg) as Rect) : null;
    auto.set(edgeKey(e), routeEdge(model, e, avoid, gap)[1]);
  }
  return auto;
}

/**
 * 节点文字。`cards` 打开且该函数带 `asset` 时，标签只剩一行 —— 卡片框被图片占满，
 * 图下面塞不下「别名() + 类型 名字()」两行，而设备名本来就在命中它的那行注释里。
 *
 * `cards` 默认关：`asset` 在默认视图里是**纯属性**（`<object>` 上带着它，供 `sync` 回写注解），
 * 不改变节点的样式与文字。这是金标准（`tools/golden` 下各用例的 `expected.drawio`）
 * 钉住的行为，把默认渲染换成图片卡片会让所有几何金标准失效。
 */
export function nodeLabel(kind: EntityKind, e: Signal | Func, cards = false): string {
  if (kind === "signal") {
    const s = e as Signal;
    const bits = [s.ctype, s.dir, s.unit].filter((b) => b !== "");
    return `${escapeHtml(s.name)}<br>${escapeHtml(bits.join(" / "))}`;
  }
  const f = e as Func;
  if (cards && f.asset !== "") return escapeHtml(f.alias || f.name);
  return `${escapeHtml(f.alias || f.name)}()<br>${escapeHtml(`${f.ret} ${f.name}()`)}`;
}

/**
 * 直连边上的可见文本。
 *
 * 用信号的 `unit`（中文语义名）而不是 `alias`：后者带着 `a5` 这类编号，适合做核对用的图例，
 * 挂在线上会把线挤满。`unit` 才是读图的人要的「这条线传的是什么」。
 *
 * 另一端是**真节点**（信号没被折掉）时，线上写的是 `read` / `write`，也就是这条边相对那个
 * 节点的读写方向 —— 它和箭头方向完全同义（箭头指着谁，谁的视角就是 read），纯粹是冗余。
 * 十几条边还好，设备总览那种几十条边的图上，「read/write」会把图面糊死。所以给出
 * `rwLabels = false`（CLI 的 `--no-rw-labels`）把这一类标签去掉；默认保持原样，不动既有产物。
 */
function inlineEdgeLabel(model: Model, e: Edge, rwLabels: boolean): string {
  if (e.sig === undefined) return rwLabels ? e.rw : "";
  const signal = model.signals.get(e.sig);
  if (signal === undefined) return rwLabels ? e.rw : "";
  return escapeHtml(signal.unit !== "" ? signal.unit : signal.name);
}

export function toDrawio(model: Model, cards = false, rwLabels = true, straightEdges = false): string {
  assignDefaultPositions(model);

  const nodes = containerTree(model);
  const paths = [...nodes.keys()].sort(compareCodePoints);
  const gid = new Map<string, string>();
  paths.forEach((p, i) => gid.set(p, `grp${i + 1}`));

  // 容器 id 与原点：节点坐标在 XML 里是**相对父容器**的，所以处处要减去父的原点。
  // 顶层容器没有父，原点就是根 (0,0) —— 单层源码因此与老版本逐位相同。
  const boxes = new Map<string, Rect>();
  for (const p of paths) boxes.set(p, containerBox(allMembers(nodes, p)));

  const parentPath = (p: string): string | null =>
    p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : null;

  /** 容器自己的原点 —— 它的几何是相对**父容器**写的。*/
  const originOf = (p: string): Point => {
    const pp = parentPath(p);
    if (pp === null) return [0, 0];
    const pb = boxes.get(pp) as Rect;
    return [pb[0], pb[1]];
  };

  const sorted = entities(model)
    .slice()
    .sort((a, b) => compareCodePoints(a.ent.id, b.ent.id));
  const cellId = new Map<string, string>();
  sorted.forEach(({ ent }, i) => cellId.set(ent.id, `n${i + 1}`));

  const out: string[] = [];

  /**
   * 发射文字块。它们挂在根 `parent="1"` 下、用画布绝对坐标 —— 文字块不属于任何容器
   * （见 model.ts 的 Callout 说明），所以不做容器偏移，也不参与 `containerBox`。
   */
  const emitCallouts = (want: "band" | "text"): void => {
    model.callouts.forEach((c, i) => {
      const isBand = c.shape === "band";
      if (isBand !== (want === "band")) return;
      const pairs: Array<[string, string | null | undefined]> = [
        ["id", `co${i + 1}`],
        // 原样交给 attrs：它只转义一遍，`<br>` 在文件里成为 `&lt;br&gt;`（XML 读回即 `<br>`，
        // draw.io 按 html=1 换行）。这里若先 escapeHtml 一遍，文件里会变成 `&amp;lt;br&amp;gt;`，
        // 读回来是**字面量** `&lt;br&gt;`，图上就显示成这七个字符。
        ["label", c.text],
        ["symbolId", c.id],
        ["kind", "callout"],
        ["owner", c.owner],
      ];
      out.push(
        `        <object ${attrs(pairs)}>\n` +
          `          <mxCell style="${calloutStyle(c)}" vertex="1" parent="1">\n` +
          `            <mxGeometry x="${num(c.x)}" y="${num(c.y)}" width="${num(c.w)}" height="${num(c.h)}" as="geometry" />\n` +
          `          </mxCell>\n` +
          `        </object>\n`,
      );
    });
  };

  // 分区带写在**容器之前**。draw.io 按文档顺序叠放，而一个单元格是连同它的整棵子树一起画的；
  // 「根 → 容器 → 卡片」这棵子树会在容器那一格被画到时整块画完。带是根的直接子节点，
  // 只要排在容器后面，它就落在整棵子树的**上面**，把容器里每一张卡片都盖住
  // （只把带排到卡片前面解决不了：卡片不是根的兄弟，是容器的孩子）。
  // 说明文字（box / text）仍旧最后画 —— 它本来就该压在卡片上面。
  emitCallouts("band");


  for (const p of paths) {
    const [ox, oy, ow, oh] = boxes.get(p) as Rect;
    const [pox, poy] = originOf(p);
    const pp = parentPath(p);
    // 容器显示名用 path 最后一段
    const label = p.slice(p.lastIndexOf("/") + 1);
    out.push(
      `        <mxCell id="${gid.get(p)}" value="${escapeHtml(label)}" style="${CONT_STYLE}" vertex="1" parent="${pp === null ? "1" : gid.get(pp)}">\n` +
        `          <mxGeometry x="${num(ox - pox)}" y="${num(oy - poy)}" width="${num(ow)}" height="${num(oh)}" as="geometry" />\n` +
        `        </mxCell>\n`,
    );
  }

  for (const { kind, ent } of sorted) {
    const epath = entityPath(ent);
    // 节点相对**自己的容器**，不是父容器 —— 这和容器的相对基准不同，别合并
    const eb = boxes.get(epath) as Rect;
    const ox = eb[0];
    const oy = eb[1];
    // `Style` 是原样追加在样式串末尾的片段（角色分色这类装饰）。空串时等于没追加，
    // 所以不写 Style 的源码产物逐字节不变。
    const style =
      kind === "signal"
        ? (SIGNAL_DIR_STYLE[(ent as Signal).dir] ?? SIGNAL_STYLE) + (ent as Signal).style
        : cards && (ent as Func).asset !== ""
          ? funcImageStyle((ent as Func).asset) + (ent as Func).style
          : ((ent as Func).external ? FUNC_EXT_STYLE : FUNC_STYLE) + (ent as Func).style;

    const pairs: Array<[string, string | null | undefined]> = [
      ["id", cellId.get(ent.id)],
      ["label", nodeLabel(kind, ent, cards)],
      ["symbolId", ent.id],
      ["kind", kind],
    ];
    if (kind === "signal") {
      const s = ent as Signal;
      pairs.push(
        ["ctype", s.ctype],
        ["dir", s.dir],
        ["unit", s.unit],
        ["alias", s.alias],
        ["note", s.note],
      );
    } else {
      const f = ent as Func;
      pairs.push(
        ["ret", f.ret],
        ["alias", f.alias],
        ["note", f.note],
        ["tooltip", f.tooltip],
        ["asset", f.asset],
      );
      const dev = model.devices.get(ent.id);
      if (dev !== undefined) {
        pairs.push(
          ["vendor", dev.vendor],
          ["model", dev.model],
          ["spec", dev.spec],
          ["size", dev.size],
        );
      }
    }

    out.push(
      `        <object ${attrs(pairs)}>\n` +
        `          <mxCell style="${style}" vertex="1" parent="${gid.get(epath)}">\n` +
        `            <mxGeometry x="${num(ent.x - ox)}" y="${num(ent.y - oy)}" width="${num(ent.w)}" height="${num(ent.h)}" as="geometry" />\n` +
        `          </mxCell>\n` +
        `        </object>\n`,
    );
  }

  emitCallouts("text");

  const sortedEdges = model.edges.slice().sort((a, b) => compareCodePoints(edgeKey(a), edgeKey(b)));

  // 边分两趟：第一趟算走法、标签落点与几何；第二趟才写 XML。
  // 分两趟是**去叠印**逼出来的：落点要和**所有**边比过才知道哪几条叠在一起。
  const laid = sortedEdges.map((e, i) => {
    const srcEnt = model.signals.get(e.src) ?? model.funcs.get(e.src);
    const dstEnt = model.signals.get(e.dst) ?? model.funcs.get(e.dst);
    const srcPath = srcEnt === undefined ? "misc" : entityPath(srcEnt);
    const dstPath = dstEnt === undefined ? "misc" : entityPath(dstEnt);
    // 同容器内的边挂在该容器下（坐标相对容器），跨容器的边挂在根下（坐标绝对）
    const parent = srcPath === dstPath ? (gid.get(srcPath) as string) : "1";
    const sb = boxes.get(srcPath) as Rect;
    const [ox, oy]: Point = parent !== "1" ? [sb[0], sb[1]] : [0, 0];

    let style = straightEdges ? STRAIGHT_EDGE_STYLE : EDGE_STYLE;
    // 内联边的颜色跟着它折叠掉的那个信号走：信号上的 Style 片段本来是给节点用的，
    // 节点没了，这个片段就落到线上 —— 否则「按关系性质分色」这类图就没有可以着色的地方。
    if (e.rw === "inline" && e.sig !== undefined) {
      const sig = model.signals.get(e.sig);
      if (sig !== undefined) style += sig.style;
    }
    let anchors: Anchor | null = null;
    // 直线模式**只丢自动拐点**，`--layout-from` 里人工画上的拐点照样保留：
    // 那是人明确放上去的东西，不该被一个样式开关悄悄吞掉。
    let waypoints: Point[] = [...e.waypoints];
    if (waypoints.length === 0) {
      const avoid = entities(model).map(({ ent }): Rect => [ent.x, ent.y, ent.w, ent.h]);
      const gap =
        parent === "1" ? crossGap(sb, boxes.get(dstPath) as Rect) : null;
      // 拐点可以丢，锚点不能丢：routeEdge 选出的出入口决定了线贴着哪条边，
      // 丢了它 draw.io 会自己就近挑边，"左右相连"可能变成从上下出线。
      const [a, pts] = routeEdge(model, e, avoid, gap);
      anchors = a;
      waypoints = straightEdges ? [] : pts;
      if (a !== null) style += anchorStyle(a);
    }

    let geom: string;
    if (waypoints.length > 0) {
      const pts = waypoints
        .map(([px, py]) => `\n              <mxPoint x="${num(px - ox)}" y="${num(py - oy)}" />`)
        .join("");
      geom =
        `<mxGeometry relative="1" as="geometry">\n            ` +
        `<Array as="points">${pts}\n            </Array>\n          </mxGeometry>`;
    } else {
      geom = '<mxGeometry relative="1" as="geometry" />';
    }

    // 折线 = 出锚点 -> 拐点 -> 入锚点。锚点取自本次路由的结果；走 `--layout-from`
    // 拿到人工拐点的边没有锚点可依，退到样式串里记着的锚点，再退到默认左右中点
    // （draw.io 自己的默认是"就近贴边框"，这里只是给去叠印一个够用的近似）。
    const a: Anchor = anchors ?? styleAnchor(style) ?? [1.0, 0.5, 0.0, 0.5];
    const [sp, dp] = endpoints(rect(model, e.src), rect(model, e.dst), a);
    const [anchor, normal] = midAndNormal([sp, ...waypoints, dp]);

    return { i, e, style, parent, geom, label: inlineEdgeLabel(model, e, rwLabels), anchor, normal };
  });

  const shifts = separateLabels(
    laid.map((x) => (x.label === "" ? null : labelBox(x.anchor, x.label))),
    LABEL_LANE,
  );

  for (const le of laid) {
    const id = `e${le.i + 1}`;
    const shiftY = shifts[le.i] as number;
    const moved = shiftY !== 0;
    const pairs: Array<[string, string | null | undefined]> = [
      ["id", id],
      // 被推开的标签不再留在边上：draw.io 自己拖标签时就是把文字挪进子单元格，
      // 两处都留着会画两遍。
      ["label", moved ? "" : le.label],
      ["rel", "def-use"],
      ["src", le.e.src],
      ["dst", le.e.dst],
      ["rw", le.e.rw],
    ];
    // 折叠掉的信号 id 留在边上：回读与校验时才能把这根线还原回 a5 那样的编号
    if (le.e.sig !== undefined) pairs.push(["sig", le.e.sig]);

    out.push(
      `        <object ${attrs(pairs)}>\n` +
        `          <mxCell style="${le.style}" edge="1" parent="${le.parent}" source="${cellId.get(le.e.src)}" target="${cellId.get(le.e.dst)}">\n` +
        `            ${le.geom}\n` +
        `          </mxCell>\n` +
        `        </object>\n`,
    );

    if (!moved) continue;
    // 位移写进 `<mxPoint as="offset">`，**不要**写进 `mxGeometry` 的 x/y。
    //
    // mxGraphView.getPoint（mxGraphView.js:2011-2074）里这两条路的语义完全不同：
    //   - `geometry.y`（代码里的 gy）沿矢量 `(dy/L, -dx/L)` 位移 —— 也就是**永远垂直于那条边**，
    //     位移方向随边的走向转：横边上是上下、竖边上就成了左右。实测：把 y 从 -17 改成 -200，
    //     一条竖向边的标签只横向跑了 183px，纵向纹丝不动。
    //     上一版就是踩了这个坑：算法按下都推开了，画出来却横着散开，该叠的还是叠着。
    //   - `geometry.offset`（即 `<mxPoint as="offset">`）直接加到点上 —— **全局坐标轴**，
    //     与边怎么走无关。受控实验（一条 L 形边）：offset `(150, 0)` → 落点 x+150.5；
    //     offset `(0, -120)` → 落点 y-119.5。方向符合直觉：正数往下/往右。
    // `geometry.x`（=0）是**沿边**的相对位置，0 表示弧长中点，保持不动。
    out.push(
      `        <mxCell id="${id}_label" value="${escapeHtml(le.label, true)}" style="${EDGE_LABEL_STYLE}" vertex="1" connectable="0" parent="${id}">\n` +
        `          <mxGeometry x="0" y="0" relative="1" as="geometry">` +
        `<mxPoint x="0" y="${num(shiftY)}" as="offset" /></mxGeometry>\n` +
        `        </mxCell>\n`,
    );
  }

  return (
    '<mxfile host="app.diagrams.net" agent="drawcode" type="device">\n' +
    '  <diagram id="drawcode" name="dataflow">\n' +
    '    <mxGraphModel adaptiveColors="auto" dx="1200" dy="800" grid="1" gridSize="10" ' +
    'guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" ' +
    'pageWidth="1169" pageHeight="826" math="0" shadow="0">\n' +
    "      <root>\n" +
    '        <mxCell id="0" />\n' +
    '        <mxCell id="1" parent="0" />\n' +
    out.join("") +
    "      </root>\n" +
    "    </mxGraphModel>\n" +
    "  </diagram>\n" +
    "</mxfile>\n"
  );
}

/**
 * 对等 Python `urllib.parse.unquote(s, encoding="utf-8", errors="replace")`。
 * `decodeURIComponent` 不能直接用：它对畸形 `%` 序列会抛 URIError，而 Python 保留原样。
 */
export function unquote(text: string): string {
  if (!text.includes("%")) return text;
  const bytes: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "%" && i + 2 < text.length) {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    const cp = text.codePointAt(i) as number;
    for (const b of Buffer.from(String.fromCodePoint(cp), "utf8")) bytes.push(b);
    i += cp > 0xffff ? 2 : 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** draw.io 的压缩形态：base64(raw-deflate(urlquote(xml)))。 */
export function decompress(data: string): string {
  const inflated = zlib.inflateRawSync(Buffer.from(data, "base64"));
  return unquote(inflated.toString("utf8"));
}

/** 对等 `urllib.parse.quote(text, safe="~()*!.'")` —— 供测试构造压缩串用。 */
export function quote(text: string): string {
  const SAFE = new Set([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~()*!.'"]);
  const bytes = Buffer.from(text, "utf8");
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    out += SAFE.has(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * draw.io 保存时默认把 `<mxGraphModel>` 压成 `<diagram>` 的文本串。
 *
 * 未压缩形态（`<diagram>` 下直接挂 `<mxGraphModel>` 子元素）原样返回；压缩形态就地展开，
 * 使 readLayout 对两种形态等价。**解压失败必须抛错，不能静默返回空布局** ——
 * 静默会让人工排版被无声丢弃（这正是 conformance.md 把能力 8 标成"非可选"的原因）。
 */
export function unpack(xml: string): XmlElement {
  const root = parseXml(xml);
  for (const diagram of iterElements(root)) {
    if (diagram.tag !== "diagram") continue;
    if (findChild(diagram, "mxGraphModel") !== null) continue;
    const text = (diagram.text ?? "").trim();
    if (text === "") continue;
    let model: XmlElement;
    try {
      model = parseXml(decompress(text));
    } catch (exc) {
      throw new Error(
        `<diagram> 既不是 <mxGraphModel> 子元素，也不是可识别的 draw.io 压缩串: ${String(exc)}`,
      );
    }
    diagram.children.length = 0;
    diagram.text = null;
    diagram.children.push(model);
  }
  return root;
}

export interface CellInfo {
  el: XmlElement;
  cell: XmlElement;
  parent: string | null;
  symbolId: string | null;
  srcCell: string | null;
  dstCell: string | null;
  rw: string | null;
  edge: boolean;
}

export function loadCells(xml: string): Map<string, CellInfo> {
  const root = unpack(xml);
  const cells = new Map<string, CellInfo>();
  for (const el of iterElements(root)) {
    if (el.tag === "object") {
      const inner = findChild(el, "mxCell");
      if (inner === null) continue;
      const id = el.attrib.get("id");
      if (id === undefined) continue;
      cells.set(id, {
        el,
        cell: inner,
        parent: inner.attrib.get("parent") ?? null,
        symbolId: el.attrib.get("symbolId") ?? null,
        srcCell: inner.attrib.get("source") ?? null,
        dstCell: inner.attrib.get("target") ?? null,
        rw: el.attrib.get("rw") ?? null,
        edge: inner.attrib.get("edge") === "1",
      });
    } else if (el.tag === "mxCell") {
      const id = el.attrib.get("id");
      if (id === undefined || id === "0" || id === "1") continue;
      cells.set(id, {
        el,
        cell: el,
        parent: el.attrib.get("parent") ?? null,
        symbolId: null,
        srcCell: el.attrib.get("source") ?? null,
        dstCell: el.attrib.get("target") ?? null,
        rw: null,
        edge: el.attrib.get("edge") === "1",
      });
    }
  }
  return cells;
}

function numericAttr(el: XmlElement, name: string): number {
  const raw = el.attrib.get(name);
  if (raw === undefined || raw === "") return 0;
  return Number(raw);
}

/** 沿 parent 链累加 mxGeometry，把 parent-relative 坐标还原成画布绝对坐标。 */
export function originOf(cells: Map<string, CellInfo>, cid: string | null): Point {
  let x = 0;
  let y = 0;
  const seen = new Set<string>();
  let cur: string | null = cid;
  while (
    cur !== null &&
    cur !== "" &&
    cur !== "0" &&
    cur !== "1" &&
    cells.has(cur) &&
    !seen.has(cur)
  ) {
    seen.add(cur);
    const info = cells.get(cur) as CellInfo;
    const geom = findChild(info.cell, "mxGeometry");
    if (geom !== null) {
      x += numericAttr(geom, "x");
      y += numericAttr(geom, "y");
    }
    cur = info.parent;
  }
  return [x, y];
}

/** 图里「能看见、但不是 drawcode 节点」的顶点，供 `adopt` 接回 IR。 */
export interface ForeignCell {
  cell_id: string;
  label: string;
  style: string;
  parent: string | null;
  container: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  nodes: Map<string, Rect>;
  edges: Map<string, Point[]>;
  attrs: Map<string, Map<string, string>>;
  /** 容器 cell id -> 容器名（= group 名 = 源文件名）。仅 `includeForeign` 时返回。 */
  containers?: Map<string, string>;
  /** 图里多出来的顶点。仅 `includeForeign` 时返回。 */
  foreign?: ForeignCell[];
}

/**
 * 把人工排版的 `.drawio` 读回内存：节点坐标、属性、以及**确实被人拖动过**的拐点。
 *
 * 只认带 `symbolId` 的 `<object>`（见文件头），所以手工在 draw.io 里画的图形、以及我们
 * 自己生成的方向端口（裸 `<mxCell>`）都不会被读进来。找不到 symbolId 的元素直接忽略。
 *
 * `includeForeign` 为 true 时另外返回 `containers` 与 `foreign` 两项，供 `adopt` 把
 * 「用户在 draw.io 里新加的元素」接回 IR。默认不返回，因为绝大多数调用方
 * （尤其 `--layout-from`）只关心既有节点。
 */
export function readLayout(xml: string, includeForeign = false): Layout {
  const cells = loadCells(xml);
  const nodes = new Map<string, Rect>();
  const edges = new Map<string, Point[]>();
  const attrs = new Map<string, Map<string, string>>();

  for (const info of cells.values()) {
    if (info.edge || info.symbolId === null) continue;
    const a = new Map<string, string>();
    for (const [k, v] of info.el.attrib) {
      if (k !== "id" && k !== "label" && k !== "symbolId") a.set(k, v);
    }
    attrs.set(info.symbolId, a);
  }

  for (const info of cells.values()) {
    if (info.edge) continue;
    const geom = findChild(info.cell, "mxGeometry");
    const [ox, oy] = originOf(cells, info.parent);
    if (info.symbolId !== null && geom !== null) {
      nodes.set(info.symbolId, [
        numericAttr(geom, "x") + ox,
        numericAttr(geom, "y") + oy,
        numericAttr(geom, "width"),
        numericAttr(geom, "height"),
      ]);
    }
  }

  for (const info of cells.values()) {
    if (!info.edge || info.srcCell === null) continue;
    const src = cells.get(info.srcCell)?.symbolId ?? null;
    const dst = info.dstCell === null ? null : (cells.get(info.dstCell)?.symbolId ?? null);
    if (src === null || src === "" || dst === null || dst === "") continue;
    const [ox, oy] = originOf(cells, info.parent);
    const pts: Point[] = [];
    const geom = findChild(info.cell, "mxGeometry");
    if (geom !== null) {
      const arr = findChild(geom, "Array");
      if (arr !== null) {
        for (const p of findChildren(arr, "mxPoint")) {
          pts.push([numericAttr(p, "x") + ox, numericAttr(p, "y") + oy]);
        }
      }
    }
    edges.set(`${src}->${dst}:${info.rw ?? "read"}`, pts);
  }

  const result: Layout = { nodes, edges, attrs };
  if (includeForeign) {
    const containers = containersOf(cells);
    result.containers = containers;
    result.foreign = foreignCells(cells, containers);
  }
  return result;
}

/**
 * 容器 cell id -> 容器名。容器名就是 group 名，也是它对应的源文件名（不含扩展名）。
 * 判定用 `swimlane`：容器是泳道，天生没有 `symbolId`。
 */
function containersOf(cells: Map<string, CellInfo>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [cid, info] of cells) {
    if (info.cell.attrib.get("vertex") === "1" && (info.cell.attrib.get("style") ?? "").includes("swimlane")) {
      out.set(cid, (info.el.attrib.get("value") ?? "").trim());
    }
  }
  return out;
}

/**
 * 图里「能看见、但不是 drawcode 节点」的顶点。
 *
 * 用户手工加元素有两种常见做法，两种都会落到这里：
 *
 *   * 直接拖一个形状出来 —— 裸 `<mxCell>`，没有 `symbolId`；
 *   * 复制一个已有节点 —— 副本带着**同一个 `symbolId`**，于是被 `loadCells`
 *     折叠到原节点上，表现为「图里多了一个但读回来没多」。
 *
 * 这里按 cell id 收集，所以上面第二种情况仍然能被发现：副本的 cell id 是新的。
 */
function foreignCells(
  cells: Map<string, CellInfo>,
  containers: Map<string, string>,
): ForeignCell[] {
  const out: ForeignCell[] = [];
  for (const [cid, info] of cells) {
    if (info.edge || info.symbolId !== null) continue;
    if (containers.has(cid)) continue; // 容器本身就是 swimlane，不是用户新加的元素
    // **挂在边下面的单元格是标签，不是节点**：去叠印写出的子标签单元格就长这样
    // （parent 指向那条边）。漏掉这一条，`sync` 会把每条被推开的标签都当成
    // 「用户在图上新加的节点」，然后往源码里写一个名叫「经局域网读取数据集」的函数。
    if (info.parent !== null && cells.get(info.parent)?.edge === true) continue;
    const geom = findChild(info.cell, "mxGeometry");
    if (geom === null) continue;
    out.push({
      cell_id: cid,
      label: (info.el.attrib.get("label") ?? info.el.attrib.get("value") ?? "").trim(),
      style: info.cell.attrib.get("style") ?? "",
      parent: info.parent,
      container: containers.get(info.parent ?? "") ?? "",
      x: numericAttr(geom, "x"),
      y: numericAttr(geom, "y"),
      w: numericAttr(geom, "width"),
      h: numericAttr(geom, "height"),
    });
  }
  return out;
}

function samePoints(a: Point[], b: Point[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!samePoint(a[i] as Point, b[i] as Point)) return false;
  }
  return true;
}

/**
 * 覆盖几何**之前**取的基线快照：每个实体此刻的 `[x, y, w, h]`。
 *
 * 调用方必须先跑过一次 `assignDefaultPositions`，快照里才是「build 本来会写进
 * `.drawio` 的几何」（源码声明的 `xy`/`size` 优先，没声明则是默认布局值）。这份基线
 * 是 `applyLayout` 判断「哪些几何是人动过的」的对照物 —— 只用一次，所以不必深拷贝，
 * 数组是这里新造的。
 *
 * 两个 map 都收：`entities()` 会跳过被 `inline` 折叠的信号，而覆盖循环靠
 * `signals.get(sid) ?? funcs.get(sid)` 命中实体 —— 两者的集合必须对齐，
 * 否则折叠过的信号在图上被拖了也记不进 `pinned`。
 */
function geometrySnapshot(model: Model): Map<string, Rect> {
  const snap = new Map<string, Rect>();
  for (const signal of model.signals.values()) snap.set(signal.id, [signal.x, signal.y, signal.w, signal.h]);
  for (const func of model.funcs.values()) snap.set(func.id, [func.x, func.y, func.w, func.h]);
  return snap;
}

/**
 * `geometrySnapshot` 的逆操作：把快照写回实体。
 *
 * 存在的唯一理由是让「取基线」变成**非破坏性**的 —— 见 applyLayout 开头的说明。
 * 遍历的是实体侧而不是快照侧：快照是实体的子集，遍历实体能保证一个都不漏；
 * 若反过来遍历快照，不在快照里的实体会被留在「已经被布局改过」的状态。
 */
function restoreGeometry(model: Model, snap: Map<string, Rect>): void {
  for (const signal of model.signals.values()) {
    const r = snap.get(signal.id);
    if (r === undefined) continue;
    signal.x = r[0]; signal.y = r[1]; signal.w = r[2]; signal.h = r[3];
  }
  for (const func of model.funcs.values()) {
    const r = snap.get(func.id);
    if (r === undefined) continue;
    func.x = r[0]; func.y = r[1]; func.w = r[2]; func.h = r[3];
  }
}

/**
 * 把「读回值与 baseline 快照不一致」记进 `model.pinned` —— 也就是要回写源码的
 * 人工排版意图。用**精确不等**，不设浮点容差：坐标本来就是整数，容差只会把
 * 「只拖动了一两个像素」这种真实排版吞掉。
 */
function recordPinned(model: Model, sid: string, base: Rect | undefined, read: Rect): void {
  if (base === undefined) return;
  const [bx, by, bw, bh] = base;
  const [x, y, w, h] = read;
  const geom: PinnedGeom = {};
  if (x !== bx || y !== by) geom.xy = [x, y]; // 注意存的是**读回值**（绝对画布坐标）
  if (w !== bw || h !== bh) geom.size = [w, h];
  if (geom.xy !== undefined || geom.size !== undefined) model.pinned.set(sid, geom);
}

/**
 * 把读回来的排版叠加到刚解析出的 IR 上 —— 这是 `--layout-from` 与 `sync` 的核心。
 *
 * 四件事，顺序不能反：
 *   0. **基线**：先跑 assignDefaultPositions 摆好默认布局，再快照每个实体的
 *      [x,y,w,h] —— 这就是「build 本来会写进 .drawio 的几何」。读出值偏离基线
 *      （精确不等）的实体记进 model.pinned，供回写侧写进源码注解（见 PinnedGeom）；
 *   1. 覆盖节点几何（x/y/w/h），用户拖过的位置才算数；
 *   2. 覆盖注解属性（alias/unit/note/tooltip 与信号方向），**用户的编辑优先于源码**；
 *   3. 拐点只在"与自动算出来的不同"时才采纳 —— 参见 autoWaypoints 的说明：
 *      相同说明这条边没被人动过，应继续跟随自动路由，否则源码一改布局就僵死。
 *
 * 判据为什么是「与 build 会写出的值比」而不是「与默认布局比」：一个节点在源码里
 * **已经有** `xy` 时，它的坐标本来就与默认布局不同 —— 若拿默认布局当基准，每次
 * `sync` 都会把这个键重写一遍，而 `sync` 的核心验收标准是「没人动过就零 diff」。
 * 基准取「build 会写出什么」（源码声明值，没声明则是默认布局值），两个来源才归一
 * 到同一条线上：**只有读出值与 build 产物不一致，才算人拖过**。
 *
 * 已知边界：若用户在 build 之后、sync 之前改过源码（插入了节点，默认布局整体位移），
 * 那些被挪动但没人碰过的节点会被误判成「人拖过」而钉进源码。这与既有 autoWaypoints
 * 对边的处理是同一类脆弱性，属已知取舍，本轮不解决。
 *
 * 取基线时多调了一次 assignDefaultPositions，但**跑完立刻把模型恢复原状**
 * （`live` 快照 -> assignDefaultPositions -> `base` 快照 -> restoreGeometry）。
 * 这么绕是为了绕开一个实测出来的坑：
 *
 *   assignDefaultPositions **不是固定点** —— 单层容器成立，多层容器（path 含 `/`）不成立。
 *   多层下每调一次，非最深层的实体整体右移 PAD(30)，且不收敛（450 -> 480 -> 510）。
 *   根因在 layoutTree 的 `dx = cursor - box[0]` 平移累加：已带全局坐标的子孙层没法再被
 *   归一化回局部原点。这是**先于本特性就存在**的缺陷（该函数在 HEAD 与工作区逐字节相同），
 *   修它超出本特性范围（会动金标准），故只记录、不处理。
 *
 *   如果像最初那样「就地多调一次、把结果留在模型里」，多层容器下这次调用会把实体挪走，
 *   于是：读回值偏离「build 会写出的值」——**没人拖过的节点也被判定成「人拖过」而进
 *   pinned**，sync 就写出源码里本没有的 xy；第二次 sync 又因为基线变了而再写一遍，
 *   幂等性直接崩掉（adopt 的两条幂等测试正是这么红的）。
 *   恢复原状之后，这次调用对模型、对后续所有环节都是只读的，多层的非幂等性伤不到任何人。
 *
 * 基线为什么必须来自「跑一遍 assignDefaultPositions 之后」而不是源码声明值：
 * 见下面那段「判据为什么是与 build 会写出的值比」。
 */
export function applyLayout(model: Model, layout: Layout): Model {
  model.pinned.clear();
  // 取基线必须是**非破坏性**的：先把调用前的几何整体快照下来，跑一次
  // assignDefaultPositions 拿到「build 本来会写出的值」，随即把模型恢复原状。
  // 于是基线是准的，而模型状态与调用前逐字段相同 —— 后面的坐标覆盖、容器归属、
  // adoptForeign 拿到的还是原来那个模型（理由见上面那段长注释）。
  const live = geometrySnapshot(model);
  assignDefaultPositions(model);
  const base = geometrySnapshot(model);
  restoreGeometry(model, live);

  for (const [sid, box] of layout.nodes) {
    const ent = model.signals.get(sid) ?? model.funcs.get(sid);
    // 容器 cell、callout（两者都以 symbolId 形态出现在 layout.nodes 里）与图上未知
    // 的 id 都在这里挡掉：它们不是实体，没有「人工改过的几何」可回写。
    if (ent === undefined) continue;
    recordPinned(model, sid, base.get(sid), box);
    const [x, y, w, h] = box;
    ent.x = x;
    ent.y = y;
    ent.w = w;
    ent.h = h;
  }

  for (const [sid, props] of layout.attrs) {
    const ent = model.signals.get(sid) ?? model.funcs.get(sid);
    if (ent === undefined) continue;
    for (const key of ["alias", "unit", "note", "tooltip"] as const) {
      const value = props.get(key);
      if (value !== undefined && key in ent) {
        (ent as unknown as Record<string, string>)[key] = value;
      }
    }
    const signal = model.signals.get(sid);
    const dir = props.get("dir");
    if (signal !== undefined && (dir === "in" || dir === "out" || dir === "inout")) {
      signal.dir = dir;
    }
  }

  const auto = autoWaypoints(model);
  for (const e of model.edges) {
    const key = edgeKey(e);
    const read = layout.edges.get(key);
    if (read === undefined) continue;
    e.waypoints = read;
    const expected = auto.get(key);
    if (expected !== undefined && samePoints(read, expected)) e.waypoints = [];
  }
  return model;
}
