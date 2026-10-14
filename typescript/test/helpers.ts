import * as fs from "node:fs";
import * as path from "node:path";

import { loadCells, readLayout } from "../src/drawio.ts";

export const REPO = path.resolve(import.meta.dirname, "..", "..");
export const CASES_DIR = path.join(REPO, "tests", "golden");
export const XSD_PATH = path.join(REPO, "tools", "xsd", "mxfile.xsd");
export const EXAMPLES_C = path.join(REPO, "examples", "small", "c");
export const EXAMPLES_CS = path.join(REPO, "examples", "small", "cs");

export function examplesC(names: string[] = ["adc.h", "adc.c", "dsp.h", "dsp.c"]): string[] {
  return names.map((n) => path.join(EXAMPLES_C, n));
}

export function examplesCs(names: string[] = ["Adc.cs", "Dsp.cs"]): string[] {
  return names.map((n) => path.join(EXAMPLES_CS, n));
}

/**
 * 金标准缺失必须**报错**，不许 skip。
 * conformance.md: "A skipped conformance test is worse than a failing one."
 */
export function mustRead(file: string): string {
  if (!fs.existsSync(file)) {
    throw new Error(`conformance: required file is missing: ${file}`);
  }
  return fs.readFileSync(file, "utf8");
}

export function mustReadJson(file: string): unknown {
  const text = mustRead(file);
  try {
    return JSON.parse(text);
  } catch (exc) {
    throw new Error(`conformance: golden JSON is unparseable: ${file}: ${String(exc)}`);
  }
}

/** 每个金标准案例的输入文件清单 —— 与 ../../tools/dump_ir.py 的调用保持一致。 */
const CASE_INPUTS: Record<string, string[]> = {
  "small-c": ["adc.h", "adc.c", "dsp.h", "dsp.c"],
  "small-cs": ["Adc.cs", "Dsp.cs"],
};

export interface GoldenCase {
  name: string;
  root: string;
  files: string[];
  ir: unknown;
  drawio: string;
  svg: string;
}

export function caseNames(): string[] {
  if (!fs.existsSync(CASES_DIR)) {
    throw new Error(`conformance: cases directory is missing: ${CASES_DIR}`);
  }
  return fs
    .readdirSync(CASES_DIR)
    .filter((n) => fs.statSync(path.join(CASES_DIR, n)).isDirectory())
    .sort();
}

export function loadCase(name: string): GoldenCase {
  const dir = path.join(CASES_DIR, name);
  const inputs = CASE_INPUTS[name];
  if (inputs === undefined) {
    throw new Error(
      `conformance: case "${name}" has no input manifest in test/helpers.ts — ` +
        `add it rather than skipping the case`,
    );
  }
  const root = path.join(dir, "input");
  const files = inputs.map((f) => {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) {
      throw new Error(`conformance: input file is missing for case "${name}": ${p}`);
    }
    return p;
  });
  return {
    name,
    root,
    files,
    ir: mustReadJson(path.join(dir, "expected.ir.json")),
    drawio: mustRead(path.join(dir, "expected.drawio")),
    svg: mustRead(path.join(dir, "preview.svg")),
  };
}

export interface DiagramShape {
  /** 容器，按嵌套路径排序。 */
  containers: Array<{ path: string; box: [number, number, number, number] }>;
  /** 节点：symbolId → 所属容器路径。 */
  nodes: Array<{ symbolId: string; kind: string; container: string }>;
  /** 边：src/dst/rw → 挂载的容器路径。 */
  edges: Array<{ src: string; dst: string; rw: string; container: string }>;
}

export interface DiagramGeometry {
  /** symbolId → 绝对 [x, y, w, h]。 */
  nodes: Record<string, [number, number, number, number]>;
  /** "src->dst:rw" → 绝对折线。 */
  edges: Record<string, Array<[number, number]>>;
  /** "src->dst:rw" → "exitX=..;exitY=..;entryX=..;entryY=.."。 */
  anchors: Record<string, string>;
  /** 容器 label 路径 → 绝对 [x, y, w, h]。 */
  containers: Record<string, [number, number, number, number]>;
}

function anchorsOf(style: string): string {
  return ["exitX", "exitY", "entryX", "entryY"]
    .map((key) => {
      const m = new RegExp(`${key}=([^;]*)`).exec(style);
      return `${key}=${m === null ? "" : (m[1] as string)}`;
    })
    .join(";");
}

/** 从 .drawio 抽出 L2（容器/节点/边及其归属）。 */
export function extractShape(xml: string): DiagramShape {
  const cells = loadCells(xml);

  const containers = new Map<string, { label: string; parent: string | null }>();
  for (const [cid, info] of cells) {
    const style = info.cell.attrib.get("style") ?? "";
    if (style.includes("swimlane")) {
      containers.set(cid, {
        label: info.cell.attrib.get("value") ?? "",
        parent: info.parent,
      });
    }
  }

  const containerPath = (cid: string | null): string => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let cur = cid;
    while (cur !== null && cur !== "" && !seen.has(cur)) {
      seen.add(cur);
      const c = containers.get(cur);
      if (c === undefined) break;
      parts.unshift(c.label);
      cur = c.parent;
    }
    return parts.join("/");
  };

  const containerRows: Array<{ path: string; box: [number, number, number, number] }> = [];
  for (const [cid, info] of cells) {
    if (!containers.has(cid)) continue;
    const path = containerPath(cid);
    if (path === "") continue;
    const geom = info.cell.children.find((c) => c.tag === "mxGeometry");
    if (geom === undefined) continue;
    containerRows.push({
      path,
      box: [
        Number(geom.attrib.get("x") ?? 0),
        Number(geom.attrib.get("y") ?? 0),
        Number(geom.attrib.get("width") ?? 0),
        Number(geom.attrib.get("height") ?? 0),
      ],
    });
  }

  const nodes: DiagramShape["nodes"] = [];
  for (const info of cells.values()) {
    if (info.edge || info.symbolId === null) continue;
    nodes.push({
      symbolId: info.symbolId,
      kind: info.el.attrib.get("kind") ?? "",
      container: containerPath(info.parent),
    });
  }
  nodes.sort((a, b) => (a.symbolId < b.symbolId ? -1 : a.symbolId > b.symbolId ? 1 : 0));

  const edges: DiagramShape["edges"] = [];
  for (const info of cells.values()) {
    if (!info.edge || info.srcCell === null) continue;
    const src = cells.get(info.srcCell)?.symbolId ?? null;
    const dst = info.dstCell === null ? null : (cells.get(info.dstCell)?.symbolId ?? null);
    if (src === null || dst === null) continue;
    edges.push({ src, dst, rw: info.rw ?? "read", container: containerPath(info.parent) });
  }
  edges.sort((a, b) =>
    a.src < b.src ? -1 : a.src > b.src ? 1 : a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : a.rw < b.rw ? -1 : a.rw > b.rw ? 1 : 0,
  );

  return {
    containers: containerRows
      .filter((c) => c.path !== "")
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    nodes,
    edges,
  };
}

/** 从 .drawio 抽出 L3（绝对几何 + 锚点）。 */
export function extractGeometry(xml: string): DiagramGeometry {
  const layout = readLayout(xml);
  const cells = loadCells(xml);

  const nodes: Record<string, [number, number, number, number]> = {};
  for (const [sid, box] of layout.nodes) nodes[sid] = box;

  const edges: Record<string, Array<[number, number]>> = {};
  const anchors: Record<string, string> = {};
  for (const info of cells.values()) {
    if (!info.edge || info.srcCell === null) continue;
    const src = cells.get(info.srcCell)?.symbolId ?? null;
    const dst = info.dstCell === null ? null : (cells.get(info.dstCell)?.symbolId ?? null);
    if (src === null || dst === null) continue;
    const key = `${src}->${dst}:${info.rw ?? "read"}`;
    edges[key] = layout.edges.get(key) ?? [];
    anchors[key] = anchorsOf(info.cell.attrib.get("style") ?? "");
  }

  const containers: Record<string, [number, number, number, number]> = {};
  for (const [cid, info] of cells) {
    const style = info.cell.attrib.get("style") ?? "";
    if (!style.includes("swimlane")) continue;
    const geom = info.cell.children.find((c) => c.tag === "mxGeometry");
    if (geom === undefined) continue;
    containers[info.cell.attrib.get("value") ?? cid] = [
      Number(geom.attrib.get("x") ?? 0),
      Number(geom.attrib.get("y") ?? 0),
      Number(geom.attrib.get("width") ?? 0),
      Number(geom.attrib.get("height") ?? 0),
    ];
  }

  return { nodes, edges, anchors, containers };
}
