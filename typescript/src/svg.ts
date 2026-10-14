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
 */

import { assignDefaultPositions, containerBox } from "./drawio.ts";
import { escapeHtml } from "./html.ts";
import type { Func, Model, Signal } from "./model.ts";
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

function edgePoints(model: Model, e: Model["edges"][number]): Array<[number, number]> {
  const src = model.signals.get(e.src) ?? model.funcs.get(e.src);
  const dst = model.signals.get(e.dst) ?? model.funcs.get(e.dst);
  if (src === undefined || dst === undefined) return [];
  const pts: Array<[number, number]> = [[src.x + src.w / 2.0, src.y + src.h / 2.0]];
  pts.push(...e.waypoints);
  pts.push([dst.x + dst.w / 2.0, dst.y + dst.h / 2.0]);
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

export function toSvg(model: Model, padding = 24): string {
  assignDefaultPositions(model);
  const ents: Array<Signal | Func> = [...model.signals.values(), ...model.funcs.values()];

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

  const xs = [...ents.map((e) => e.x), ...[...boxes.values()].map((b) => b[0])];
  const ys = [...ents.map((e) => e.y), ...[...boxes.values()].map((b) => b[1])];
  const x2 = [...ents.map((e) => e.x + e.w), ...[...boxes.values()].map((b) => b[0] + b[2])];
  const y2 = [...ents.map((e) => e.y + e.h), ...[...boxes.values()].map((b) => b[1] + b[3])];

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

  const items: Array<{ kind: "signal" | "func"; ent: Signal | Func }> = [
    ...[...model.signals.values()].map((s) => ({ kind: "signal" as const, ent: s as Signal | Func })),
    ...[...model.funcs.values()].map((f) => ({ kind: "func" as const, ent: f as Signal | Func })),
  ];
  items.sort((a, b) => compareCodePoints(a.ent.id, b.ent.id));

  for (const { kind, ent: e } of items) {
    const cx = e.x + e.w / 2.0;
    const cy = e.y + e.h / 2.0;
    if (kind === "signal") {
      out.push(
        `<ellipse cx="${num(cx)}" cy="${num(cy)}" rx="${num(e.w / 2.0)}" ry="${num(e.h / 2.0)}" fill="${SIGNAL_FILL}" stroke="${SIGNAL_STROKE}" data-kind="signal"/>`,
      );
    } else {
      const dash = e.external ? ' stroke-dasharray="6 4"' : "";
      out.push(
        `<rect x="${num(e.x)}" y="${num(e.y)}" width="${num(e.w)}" height="${num(e.h)}" rx="4" fill="${e.external ? EXT_FILL : FUNC_FILL}" stroke="${e.external ? EXT_STROKE : FUNC_STROKE}"${dash} data-kind="func"/>`,
      );
    }
    out.push(text(cx, cy, nodeLines(kind, e)));
  }

  for (const e of model.edges) {
    const pts = edgePoints(model, e);
    if (pts.length === 0) continue;
    const d = `M ${pts.map(([px, py]) => `${num(px)} ${num(py)}`).join(" L ")}`;
    out.push(
      `<path d="${d}" fill="none" stroke="${EDGE_COLOR}" stroke-width="1.4" marker-end="url(#arrow)" data-edge="1"/>`,
    );
    const [mx, my] = pts[Math.floor(pts.length / 2)] as [number, number];
    out.push(text(mx, my - 8, [e.rw], { size: 10, fill: "#444444" }));
  }

  out.push("</svg>");
  return out.join("");
}
