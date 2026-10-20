/**
 * drawcode —— TypeScript 实现。
 *
 * 源码是语义的唯一事实源；`.drawio` 是派生产物兼人工排版载体。
 * 本实现与 `python/src/drawcode` 逐函数对应，几何结果精确相等
 * （见 `../../docs/conformance.md` 的 L1–L4）。
 */

export { parseProject, parseParams, readAnnotations, bodies, defUse, splitSignals, stripComments, DIR_BY_KEY, CONTROL, FUNC_RE, SIGNAL_RE, KV_RE } from "./cparse.ts";
export type { DefUse } from "./cparse.ts";
export { parseCsProject, csBodies, readMeta, DIRS, FIELD_RE, CS_FUNC_RE } from "./csparse.ts";
export type { RawCallout } from "./csparse.ts";
export { parseAny } from "./parse.ts";

export type { Callout, Device, Direction, Edge, EdgeKind, Func, Param, PinnedGeom, Signal } from "./model.ts";
export { collapseSignals, Model, makeCallout, makeDevice, makeFunc, makeSignal } from "./model.ts";

export {
  applyLayout,
  assignDefaultPositions,
  attrs,
  autoWaypoints,
  anchorStyle,
  calloutStyle,
  candidates,
  containerBox,
  crossGap,
  crosses,
  decompress,
  edgeKey,
  funcImageStyle,
  endpoints,
  entities,
  lanePt,
  loadCells,
  nodeLabel,
  originOf,
  polylineLength,
  quote,
  readLayout,
  rect,
  route,
  toDrawio,
  unpack,
  ANCHOR_SETS,
  CONT_STYLE,
  DETOUR,
  EDGE_STYLE,
  FUNC_EXT_STYLE,
  FUNC_STYLE,
  GAP_Y,
  HEADER,
  NODE_H,
  NODE_W,
  PAD,
  SIGNAL_STYLE,
  STRAIGHT_EDGE_STYLE,
  SHRINK,
  SLACK,
} from "./drawio.ts";
// Entity / EntityKind 定义在 drawio.ts（`entities()` 的返回元素类型），不在 model.ts ——
// 早先误挂在 model.ts 那行，导致 `tsc --noEmit` 报「没有导出的成员」。归位即可。
export type { Anchor, CellInfo, Entity, EntityKind, Gap, Layout, Point, Rect } from "./drawio.ts";

export { renderSignal, renderCsAnnotation, splitCtype, syncCsSource, syncFunctions, syncHeader, syncSource } from "./codegen.ts";
export { toSvg } from "./svg.ts";
export { dumpIr } from "./dump.ts";
export type { IrDump, IrEdge, IrDevice, IrFunc, IrParam, IrSignal } from "./dump.ts";

export { parseXml, serializeXml, iterElements, findChild, findChildren, attr, decodeEntities } from "./xml.ts";
export type { XmlElement } from "./xml.ts";

export { Schema } from "./xsd.ts";
export type { XsdError } from "./xsd.ts";

export { escapeHtml } from "./html.ts";
export { num, reprFloat } from "./num.ts";
export { compareCodePoints, sortedCopy } from "./order.ts";
export { main } from "./cli.ts";
