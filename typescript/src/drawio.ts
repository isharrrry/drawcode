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
import type { Edge, Func, Model, Signal } from "./model.ts";
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
  for (const signal of model.signals.values()) out.push({ kind: "signal", ent: signal });
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

export function nodeLabel(kind: EntityKind, e: Signal | Func): string {
  if (kind === "signal") {
    const s = e as Signal;
    const bits = [s.ctype, s.dir, s.unit].filter((b) => b !== "");
    return `${escapeHtml(s.name)}<br>${escapeHtml(bits.join(" / "))}`;
  }
  const f = e as Func;
  return `${escapeHtml(f.alias || f.name)}()<br>${escapeHtml(`${f.ret} ${f.name}()`)}`;
}

export function toDrawio(model: Model): string {
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
    const style =
      kind === "signal"
        ? (SIGNAL_DIR_STYLE[(ent as Signal).dir] ?? SIGNAL_STYLE)
        : (ent as Func).external
          ? FUNC_EXT_STYLE
          : FUNC_STYLE;

    const pairs: Array<[string, string | null | undefined]> = [
      ["id", cellId.get(ent.id)],
      ["label", nodeLabel(kind, ent)],
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

  const sortedEdges = model.edges.slice().sort((a, b) => compareCodePoints(edgeKey(a), edgeKey(b)));
  sortedEdges.forEach((e, i) => {
    const srcEnt = model.signals.get(e.src) ?? model.funcs.get(e.src);
    const dstEnt = model.signals.get(e.dst) ?? model.funcs.get(e.dst);
    const srcPath = srcEnt === undefined ? "misc" : entityPath(srcEnt);
    const dstPath = dstEnt === undefined ? "misc" : entityPath(dstEnt);
    // 同容器内的边挂在该容器下（坐标相对容器），跨容器的边挂在根下（坐标绝对）
    const parent = srcPath === dstPath ? (gid.get(srcPath) as string) : "1";
    const sb = boxes.get(srcPath) as Rect;
    const [ox, oy]: Point = parent !== "1" ? [sb[0], sb[1]] : [0, 0];

    let style = EDGE_STYLE;
    let waypoints: Point[] = [...e.waypoints];
    if (waypoints.length === 0) {
      const avoid = entities(model).map(({ ent }): Rect => [ent.x, ent.y, ent.w, ent.h]);
      const gap =
        parent === "1" ? crossGap(sb, boxes.get(dstPath) as Rect) : null;
      const [anchors, pts] = routeEdge(model, e, avoid, gap);
      waypoints = pts;
      if (anchors !== null) style += anchorStyle(anchors);
    }

    const pairs: Array<[string, string | null | undefined]> = [
      ["id", `e${i + 1}`],
      ["label", e.rw],
      ["rel", "def-use"],
      ["src", e.src],
      ["dst", e.dst],
      ["rw", e.rw],
    ];

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

    out.push(
      `        <object ${attrs(pairs)}>\n` +
        `          <mxCell style="${style}" edge="1" parent="${parent}" source="${cellId.get(e.src)}" target="${cellId.get(e.dst)}">\n` +
        `            ${geom}\n` +
        `          </mxCell>\n` +
        `        </object>\n`,
    );
  });

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
 * 把读回来的排版叠加到刚解析出的 IR 上 —— 这是 `--layout-from` 的核心。
 *
 * 三件事，顺序不能反：
 *   1. 覆盖节点几何（x/y/w/h），用户拖过的位置才算数；
 *   2. 覆盖注解属性（alias/unit/note/tooltip 与信号方向），**用户的编辑优先于源码**；
 *   3. 拐点只在"与自动算出来的不同"时才采纳 —— 参见 autoWaypoints 的说明：
 *      相同说明这条边没被人动过，应继续跟随自动路由，否则源码一改布局就僵死。
 */
export function applyLayout(model: Model, layout: Layout): Model {
  for (const [sid, [x, y, w, h]] of layout.nodes) {
    const ent = model.signals.get(sid) ?? model.funcs.get(sid);
    if (ent === undefined) continue;
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
