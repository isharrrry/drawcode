/**
 * IR → SVG 预览。对等 Python `svg.py`。
 *
 * **这是一份"简化视图"，不是 `.drawio` 的等价重绘**：
 *
 *   - 节点**复用** drawio 的布局（`assignDefaultPositions` / `containerBox`），所以位置一致；
 *   - 边**不复用** `route()`，而是从节点中心直连。因此线会穿过节点框，且没有锚点、没有折线、
 *     没有障碍规避 —— 这是刻意的，见 `../../docs/conformance.md` 的
 *     "Known divergence — SVG edge routing is simplified"。
 *
 * 推论：**SVG 的一致性测试不得断言边几何**，否则会把简化行为误当成契约锁死。
 * 也别把这里的边路由"修好"去接 `route()` —— 那会让 SVG 与 .drawio 分叉，是另一种破坏。
 *
 * 另外：这里**不画方向端口**（端口是 .drawio 专属的视觉元素）。
 *
 * 图片与文字块是在这条"简化"线上**跟齐 .drawio** 的两处，不能简化：
 * 设备卡片少了图片、图上少了说明文字，这张预览就不再能用来核对成品长什么样。
 * 代价是导出的 SVG 用相对路径引用图片文件，它必须和图片目录一起被搬动；
 * 用 `<img src="…svg">` 嵌进网页不显示图片，得直接打开或内联。
 *
 * `cards` 与 `toDrawio` 的同名参数必须同时开或同时关（`--cards` 一处控制），否则预览
 * 与 .drawio 画的是两张不同的图，而这份预览的唯一用途就是核对 .drawio。
 */

import { assignDefaultPositions, containerBox, entities } from "./drawio.ts";
import { escapeHtml } from "./html.ts";
import type { Callout, Func, Model, Signal } from "./model.ts";
import { num } from "./num.ts";
import { compareCodePoints } from "./order.ts";

const SIGNAL_FILL = "#d5e8d4";
const SIGNAL_STROKE = "#82b366";
const FUNC_FILL = "#ffe6cc";
const FUNC_STROKE = "#d79b00";
const EXT_FILL = "#f5f5f5";
const EXT_STROKE = "#666666";
const CONT_FILL = "#dae8fc";
const CONT_STROKE = "#6c8ebf";
const EDGE_COLOR = "#666666";
const FONT = "Helvetica,Arial,'Microsoft YaHei',sans-serif";
const HEADER = 30;

/** 画布四周留白。导出成常量是为了让调用方（cli）在传第三个参数时不必再写一遍这个数字。 */
export const SVG_PADDING = 24;

/** 与 drawio.ts 的 CALLOUT_FILL / CALLOUT_STROKE / CALLOUT_FONT 对应；改一处必须改另一处。 */
const CALLOUT_FILL: Record<string, string> = { text: "none", box: "#fff2cc", band: "#f5f5f5" };
const CALLOUT_STROKE: Record<string, string> = { text: "none", box: "#d6b656", band: "#b3b3b3" };
const CALLOUT_FONT: Record<string, number> = { text: 12, box: 12, band: 15 };

interface TextOptions {
  size?: number;
  anchor?: string;
  fill?: string;
  weight?: string;
}

function text(
  cx: number,
  cy: number,
  lines: string[],
  opts: TextOptions = {},
): string {
  const size = opts.size ?? 12;
  const anchor = opts.anchor ?? "middle";
  const fill = opts.fill ?? "#222222";
  const n = lines.length;
  const first = cy - (n - 1) * size * 0.6;
  let attributes = `text-anchor="${anchor}" font-size="${size}" fill="${fill}"`;
  if (opts.weight !== undefined) attributes += ` font-weight="${opts.weight}"`;
  const head = `<text x="${num(cx)}" y="${num(first + size * 0.35)}" ${attributes}>`;
  if (n === 1) return `${head}${escapeHtml(lines[0] as string)}</text>`;
  const out = [head];
  lines.forEach((line, i) => {
    const dy = i === 0 ? 0 : size * 1.2;
    out.push(`<tspan x="${num(cx)}" dy="${num(dy)}">${escapeHtml(line)}</tspan>`);
  });
  out.push("</text>");
  return out.join("");
}

function nodeLines(kind: "signal" | "func", e: Signal | Func): string[] {
  if (kind === "signal") {
    const s = e as Signal;
    const meta = [s.ctype, s.dir, s.unit].filter((b) => b !== "").join(" / ");
    return meta === "" ? [s.name] : [s.name, meta];
  }
  const f = e as Func;
  return [`${f.alias || f.name}()`, `${f.ret} ${f.name}()`];
}

/** 文字块按 `<br>` 断行 —— 与 .drawio 侧 `html=1` 的换行语义是同一件事。 */
function calloutLines(callout: Callout): string[] {
  return callout.text.split(/<br\s*\/?>/i);
}

/**
 * 画一个文字块。`band` 铺在容器之上、节点之下；`box`/`text` 画在节点之后压在上面。
 * 先后次序由调用点决定，这里只负责画 —— 与 toDrawio 的 `emitCallouts("band"|"text")` 对齐。
 */
function calloutSvg(callout: Callout): string {
  const size = callout.fontSize > 0 ? callout.fontSize : (CALLOUT_FONT[callout.shape] ?? 12);
  const out: string[] = [];
  if (callout.shape !== "text") {
    const dash = callout.shape === "band" ? ' stroke-dasharray="6 4"' : "";
    out.push(
      `<rect x="${num(callout.x)}" y="${num(callout.y)}" width="${num(callout.w)}" height="${num(callout.h)}" rx="4" ` +
        `fill="${CALLOUT_FILL[callout.shape]}" stroke="${CALLOUT_STROKE[callout.shape]}"${dash} data-kind="callout"/>`,
    );
  }
  // verticalAlign=top / spacingTop=6 / spacingLeft=8，与 calloutStyle() 的间距对齐
  const weight = callout.shape === "band" ? "bold" : undefined;
  out.push(
    text(callout.x + 8, callout.y + 6 + size * 0.75, calloutLines(callout), {
      size,
      anchor: "start",
      weight,
    }),
  );
  return out.join("");
}

/** 边上显示的文字：内联边用被折叠信号的 unit（退回 name），其余仍是 rw —— 与 .drawio 一致。 */
function edgeLabel(model: Model, e: Model["edges"][number], rwLabels: boolean): string {
  if (e.rw === "inline" && e.sig !== undefined) {
    const sig = model.signals.get(e.sig);
    if (sig !== undefined) return sig.unit !== "" ? sig.unit : sig.name;
  }
  // 与 drawio.ts 的 inlineEdgeLabel 同一套口径：`rwLabels=false` 时去掉 read/write
  return rwLabels ? e.rw : "";
}

/** 内联边沿用被折叠信号的 Style 片段里的线色；取不到就用默认色。 */
function edgeColor(model: Model, e: Model["edges"][number]): string {
  if (e.rw !== "inline" || e.sig === undefined) return EDGE_COLOR;
  const m = /strokeColor=(#[0-9a-fA-F]{3,8})/.exec(model.signals.get(e.sig)?.style ?? "");
  return m === null ? EDGE_COLOR : (m[1] as string);
}

function edgePoints(
  model: Model,
  e: Model["edges"][number],
  straightEdges = false,
): Array<[number, number]> {
  const src = model.signals.get(e.src) ?? model.funcs.get(e.src);
  const dst = model.signals.get(e.dst) ?? model.funcs.get(e.dst);
  if (src === undefined || dst === undefined) return [];
  const pts: Array<[number, number]> = [[src.x + src.w / 2.0, src.y + src.h / 2.0]];
  pts.push(...e.waypoints);
  pts.push([dst.x + dst.w / 2.0, dst.y + dst.h / 2.0]);
  // 直线模式：两点直连，不补那个让预览"看着像正交走线"的肘点。
  // 与 drawio.ts 的 --straight-edges 同一口径；人工拐点同样保留（上面已经 push 进去了）。
  if (straightEdges) return pts;
  if (pts.length === 2) {
    const [x1, y1] = pts[0] as [number, number];
    const [x2, y2] = pts[1] as [number, number];
    const mx = (x1 + x2) / 2.0;
    return [
      [x1, y1],
      [mx, y1],
      [mx, y2],
      [x2, y2],
    ];
  }
  return pts;
}

export function toSvg(model: Model, padding = SVG_PADDING, cards = false, rwLabels = true, straightEdges = false): string {
  assignDefaultPositions(model);
  // 走 entities()：它会跳过被折叠的信号（否则图上剩一堆没有边的空椭圆），
  // 且次序与原先手写的 [...signals, ...funcs] 相同，不内联时产物不变。
  const items = entities(model);
  const ents: Array<Signal | Func> = items.map(({ ent }) => ent);

  const groups = new Map<string, Array<Signal | Func>>();
  for (const e of ents) {
    const key = e.group || "misc";
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [e]);
    else list.push(e);
  }

  const boxes = new Map<string, [number, number, number, number]>();
  for (const [name, members] of groups) boxes.set(name, containerBox(members));

  if (ents.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"></svg>';
  }

  // 文字块也计入画布范围：否则一张主要靠文字说明的图会被裁得只剩卡片
  const calloutXs = model.callouts.flatMap((c) => [c.x, c.x + c.w]);
  const calloutYs = model.callouts.flatMap((c) => [c.y, c.y + c.h]);
  const xs = [...ents.map((e) => e.x), ...[...boxes.values()].map((b) => b[0]), ...calloutXs];
  const ys = [...ents.map((e) => e.y), ...[...boxes.values()].map((b) => b[1]), ...calloutYs];
  const x2 = [...ents.map((e) => e.x + e.w), ...[...boxes.values()].map((b) => b[0] + b[2]), ...calloutXs];
  const y2 = [...ents.map((e) => e.y + e.h), ...[...boxes.values()].map((b) => b[1] + b[3]), ...calloutYs];

  const minx = Math.min(...xs) - padding;
  const miny = Math.min(...ys) - padding;
  const width = Math.max(...x2) - minx + padding;
  const height = Math.max(...y2) - miny + padding;

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="${num(minx)} ${num(miny)} ${num(width)} ${num(height)}" font-family="${FONT}">`,
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" ' +
      `orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${EDGE_COLOR}"/></marker></defs>`,
  ];

  for (const g of [...boxes.keys()].sort(compareCodePoints)) {
    const [ox, oy, ow, oh] = boxes.get(g) as [number, number, number, number];
    out.push(
      `<rect x="${num(ox)}" y="${num(oy)}" width="${num(ow)}" height="${num(oh)}" rx="6" fill="${CONT_FILL}" stroke="${CONT_STROKE}" data-kind="container"/>`,
    );
    out.push(text(ox + 12, oy + HEADER / 2.0, [g], { size: 13, anchor: "start", weight: "bold" }));
  }

  // 分区带先画，当卡片的底
  for (const c of model.callouts) if (c.shape === "band") out.push(calloutSvg(c));

  const drawItems = items.slice().sort((a, b) => compareCodePoints(a.ent.id, b.ent.id));

  for (const { kind, ent: e } of drawItems) {
    const cx = e.x + e.w / 2.0;
    const cy = e.y + e.h / 2.0;
    if (kind === "signal") {
      out.push(
        `<ellipse cx="${num(cx)}" cy="${num(cy)}" rx="${num(e.w / 2.0)}" ry="${num(e.h / 2.0)}" fill="${SIGNAL_FILL}" stroke="${SIGNAL_STROKE}" data-kind="signal"/>`,
      );
    } else if (cards && (e as Func).asset !== "") {
      // 设备卡片：图片占满节点框，名字贴图下方（对应 .drawio 的 verticalLabelPosition=bottom）。
      // preserveAspectRatio="none" 与 imageAspect=0 同义：跟着框变形，不留等比白边。
      out.push(
        `<image x="${num(e.x)}" y="${num(e.y)}" width="${num(e.w)}" height="${num(e.h)}" ` +
          `preserveAspectRatio="none" href="${escapeHtml((e as Func).asset, true)}" data-kind="image"/>`,
      );
    } else {
      const dash = e.external ? ' stroke-dasharray="6 4"' : "";
      out.push(
        `<rect x="${num(e.x)}" y="${num(e.y)}" width="${num(e.w)}" height="${num(e.h)}" rx="4" fill="${e.external ? EXT_FILL : FUNC_FILL}" stroke="${e.external ? EXT_STROKE : FUNC_STROKE}"${dash} data-kind="func"/>`,
      );
    }
    if (kind === "func" && cards && (e as Func).asset !== "") {
      // 卡片标签只有一行，见 drawio.ts 的 nodeLabel
      out.push(text(cx, e.y + e.h + 16, [e.alias || e.name], { size: 13, weight: "bold" }));
    } else {
      out.push(text(cx, cy, nodeLines(kind, e)));
    }
  }

  // 说明文字后画，压在卡片上面
  for (const c of model.callouts) if (c.shape !== "band") out.push(calloutSvg(c));

  for (const e of model.edges) {
    const pts = edgePoints(model, e, straightEdges);
    if (pts.length === 0) continue;
    const d = `M ${pts.map(([px, py]) => `${num(px)} ${num(py)}`).join(" L ")}`;
    out.push(
      `<path d="${d}" fill="none" stroke="${edgeColor(model, e)}" stroke-width="1.4" marker-end="url(#arrow)" data-edge="1"/>`,
    );
    // 标签可能被 --no-rw-labels 关掉；空标签不落文字，免得留下一堆空 <text>
    const label = edgeLabel(model, e, rwLabels);
    if (label !== "") {
      const [mx, my] = pts[Math.floor(pts.length / 2)] as [number, number];
      // 这里**不做**平行边的标签去叠印（.drawio 侧做了，见 drawio.ts 的 separateLabels）。
      // 原因：SVG 的 golden 是三种实现共享的契约，且按 ±0.5px 比坐标 —— 只改 TS 就会
      // 把 python/dotnet 的一致性测试弄红。要动就得三份一起动，那是另一件事。
      out.push(text(mx, my - 8, [label], { size: 10, fill: "#444444" }));
    }
  }

  out.push("</svg>");
  return out.join("");
}
