/**
 * 模型切片（宿主侧，纯函数，不依赖 vscode）。
 *
 * 为什么需要切片：规范 JSON 是「一次解析、整份展示」的程序集，一个十万级函数的
 * 程序集在 webview 里同时保留信号、函数、边三张大表，内存和首帧都会失控。切片
 * 不改变解析结果，只改变**下发时机**：
 *
 *   init        → 只发模块骨架、类型、诊断与计数；信号/函数等展开时再取。
 *   requestNode → 某个模块的直属信号与函数（模块树的一层）。
 *   select      → 某个实体的邻居（信号的读写函数、函数的读写信号与调用目标）。
 *   filter      → 宿主侧全量搜索；webview 只拿到命中的 id 与命中实体。
 *
 * 为什么切信号/函数而不切类型：ER 视图与字段关联需要同步拿到完整的类型表；
 * 类型数量由声明决定，通常不随实现规模线性膨胀。真正会失控的是信号与函数。
 *
 * 一致性约束：这里对「实体属于哪个模块」的判定必须与 `media/logic.js` 的
 * `moduleForPath` 一致（先精确匹配模块 path，再取最长前缀）。两处算法分叉会让
 * 懒加载拉回来的实体挂到别的模块下，表现是「展开了但树里没有」。
 */

import type {
  ArtifactFunc,
  ArtifactModel,
  ArtifactModule,
  ArtifactSignal,
  ArtifactType,
} from "./types";

/** 未归属实体在树里的伪模块 id，必须与 `media/logic.js` 保持一致。 */
export const ORPHAN_MODULE_ID = "__orphans__";

/** 设计文档 §8.4 的阈值：信号 + 函数超过它才切片。 */
export const DEFAULT_SLICE_THRESHOLD = 2000;

/**
 * 单次搜索最多记录多少个命中。过滤框里输入一个字母可能命中整份模型，
 * 把全部 id 发给 webview 等于绕过切片，所以给一个明确上限并在 UI 上标注。
 */
export const FILTER_MATCH_LIMIT = 500;

/**
 * 单次搜索最多携带多少个实体（含为了画流而带上的邻居）。
 * 命中实体之外还要带一跳邻居，否则勾选搜索结果后画不出读写关系。
 */
export const FILTER_ENTITY_LIMIT = 2000;

export interface ModelTotals {
  modules: number;
  types: number;
  signals: number;
  funcs: number;
  edges: number;
  storeTypes: number;
}

/**
 * 一次按需下发的内容。
 *
 * `loadedModules` 是「这次可以标记为已加载」的模块 id：宿主知道某个模块确实
 * 没有直属实体，标记后 webview 才不会一直显示「正在加载」。
 */
export interface EntitySlice {
  signals: ArtifactSignal[];
  funcs: ArtifactFunc[];
  types: ArtifactType[];
  loadedModules: string[];
}

export interface FilterHits {
  modules: string[];
  signals: string[];
  funcs: string[];
  types: string[];
}

export interface FilterSlice extends EntitySlice {
  hits: FilterHits;
  truncated: boolean;
}

function emptySlice(): EntitySlice {
  return { signals: [], funcs: [], types: [], loadedModules: [] };
}

/** 与 logic.js 相同的 path → 模块规则。 */
function moduleForPath(
  byPath: Map<string, ArtifactModule>,
  path: string,
): ArtifactModule | undefined {
  if (!path) return undefined;
  const exact = byPath.get(path);
  if (exact !== undefined) return exact;
  let best: ArtifactModule | undefined;
  for (const [modulePath, module] of byPath) {
    if (modulePath && path.startsWith(modulePath + "/")) {
      if (best === undefined || modulePath.length > best.path.length) best = module;
    }
  }
  return best;
}

function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export class ModelSlicer {
  readonly totals: ModelTotals;

  private readonly signalsById = new Map<string, ArtifactSignal>();
  private readonly funcsById = new Map<string, ArtifactFunc>();
  private readonly signalsByModule = new Map<string, ArtifactSignal[]>();
  private readonly funcsByModule = new Map<string, ArtifactFunc[]>();
  private readonly writersBySignal = new Map<string, ArtifactFunc[]>();
  private readonly readersBySignal = new Map<string, ArtifactFunc[]>();
  private readonly signalsByOwnerType = new Map<string, ArtifactSignal[]>();
  private readonly orphanSignals: ArtifactSignal[] = [];
  private readonly orphanFuncs: ArtifactFunc[] = [];
  /** 没有直属信号/函数的模块：请求它们只会得到空结果，直接视为已加载。 */
  private readonly emptyModuleIds: string[] = [];

  constructor(private readonly model: ArtifactModel) {
    this.totals = {
      modules: model.modules.length,
      types: model.types.length,
      signals: model.signals.length,
      funcs: model.funcs.length,
      edges: model.edges.length,
      storeTypes: model.types.filter((type) => type.store).length,
    };

    const byPath = new Map<string, ArtifactModule>();
    for (const module of model.modules) {
      if (module.path) byPath.set(module.path, module);
    }

    for (const signal of model.signals) {
      this.signalsById.set(signal.id, signal);
      const owner = moduleForPath(byPath, signal.path);
      if (owner === undefined) this.orphanSignals.push(signal);
      else pushToMap(this.signalsByModule, owner.id, signal);
      if (signal.ownerType) pushToMap(this.signalsByOwnerType, signal.ownerType, signal);
    }

    for (const func of model.funcs) {
      this.funcsById.set(func.id, func);
      const owner = moduleForPath(byPath, func.path);
      if (owner === undefined) this.orphanFuncs.push(func);
      else pushToMap(this.funcsByModule, owner.id, func);
      // 索引按「谁读写这个信号」建，而不是按边表：边表在规范 JSON 里是
      // 冗余的（函数上的 reads/writes 才是源头），少读一张表就少一份内存。
      for (const signalId of func.writes) pushToMap(this.writersBySignal, signalId, func);
      for (const signalId of func.reads) pushToMap(this.readersBySignal, signalId, func);
    }

    for (const module of model.modules) {
      const ownSignals = this.signalsByModule.get(module.id);
      const ownFuncs = this.funcsByModule.get(module.id);
      if ((ownSignals?.length ?? 0) === 0 && (ownFuncs?.length ?? 0) === 0) {
        this.emptyModuleIds.push(module.id);
      }
    }
  }

  /** init 只发结构：模块、类型、诊断、计数，信号与函数留空。 */
  initModel(): ArtifactModel {
    return {
      info: this.model.info,
      modules: this.model.modules,
      types: this.model.types,
      signals: [],
      funcs: [],
      edges: [],
      diagnostics: this.model.diagnostics,
    };
  }

  /** init 时就可以标记为「内容已就绪」的模块（它们本来就没有直属实体）。 */
  initiallyLoadedModules(): string[] {
    return this.emptyModuleIds.slice();
  }

  /**
   * 是否存在未归属实体。切片模式下 webview 本地看不到它们，必须由宿主动告，
   * 否则「（未归属）」入口不会出现，用户没有机会触发对应的 requestNode。
   */
  hasOrphans(): boolean {
    return this.orphanSignals.length + this.orphanFuncs.length > 0;
  }

  /** 模块的一层：只发直属信号/函数。子模块属于骨架，已经在 init 里。 */
  moduleSlice(moduleId: string): EntitySlice {
    if (moduleId === ORPHAN_MODULE_ID) {
      return {
        signals: this.orphanSignals.slice(),
        funcs: this.orphanFuncs.slice(),
        types: [],
        loadedModules: [ORPHAN_MODULE_ID],
      };
    }
    // 未知模块也标记为已加载：否则 webview 会反复请求一个永远拿不到内容的 id。
    return {
      signals: (this.signalsByModule.get(moduleId) ?? []).slice(),
      funcs: (this.funcsByModule.get(moduleId) ?? []).slice(),
      types: [],
      loadedModules: [moduleId],
    };
  }

  /**
   * 选中某个实体时取它的邻居。
   *
   * 只取一跳：信号 → 读写函数；函数 → 读写信号与被调用函数；类型 → 字段信号
   * 及其读写函数。取两跳会让一次点击把整个连通分量拖进来，切片就失去意义。
   */
  selectSlice(kind: string, id: string): EntitySlice {
    // kind:"auto"：webview 从 localStorage 恢复勾选时只有一个 id，不知道它是
    // 信号还是函数。宿主持有两张索引，判断成本 O(1)，比让 webview 猜更可靠。
    let resolved = kind;
    if (resolved !== "signal" && resolved !== "func" && resolved !== "type") {
      if (this.signalsById.has(id)) resolved = "signal";
      else if (this.funcsById.has(id)) resolved = "func";
      else return emptySlice();
    }
    kind = resolved;

    if (kind === "signal") {
      const signal = this.signalsById.get(id);
      if (signal === undefined) return emptySlice();
      const funcs = dedupeById([
        ...(this.writersBySignal.get(id) ?? []),
        ...(this.readersBySignal.get(id) ?? []),
      ]);
      return { signals: [signal], funcs, types: [], loadedModules: [] };
    }

    if (kind === "func") {
      const func = this.funcsById.get(id);
      if (func === undefined) return emptySlice();
      const signals: ArtifactSignal[] = [];
      for (const signalId of [...func.writes, ...func.reads]) {
        const signal = this.signalsById.get(signalId);
        if (signal !== undefined) signals.push(signal);
      }
      const callees: ArtifactFunc[] = [];
      for (const calleeId of func.calls) {
        const callee = this.funcsById.get(calleeId);
        if (callee !== undefined) callees.push(callee);
      }
      return {
        signals: dedupeById(signals),
        funcs: dedupeById([func, ...callees]),
        types: [],
        loadedModules: [],
      };
    }

    if (kind === "type") {
      // 类型本身在 init 里已全量下发，这里只补它的字段信号与读写函数。
      const signals = this.signalsByOwnerType.get(id) ?? [];
      const funcs: ArtifactFunc[] = [];
      for (const signal of signals) {
        funcs.push(...(this.writersBySignal.get(signal.id) ?? []));
        funcs.push(...(this.readersBySignal.get(signal.id) ?? []));
      }
      return { signals: signals.slice(), funcs: dedupeById(funcs), types: [], loadedModules: [] };
    }

    return emptySlice();
  }

  /**
   * 宿主侧全量搜索。
   *
   * 返回两部分：
   *   - `signals/funcs/types`：为了显示和画流需要补进 webview 的实体；
   *   - `hits`：**真正命中**的 id，树用它决定显示范围。两者刻意分开：
   *     为了画流补进来的一跳邻居不在 hits 里，否则搜索「altitude」会把
   *     所有读写它的函数也当成命中，树里冒出一堆无关行。
   */
  filterSlice(query: string): FilterSlice {
    const needle = query.trim().toLowerCase();
    const emptyHits: FilterHits = { modules: [], signals: [], funcs: [], types: [] };
    if (needle.length === 0) {
      return { ...emptySlice(), hits: emptyHits, truncated: false };
    }

    const textHit = (parts: Array<string | undefined>): boolean =>
      parts.some((part) => typeof part === "string" && part.toLowerCase().includes(needle));

    const matchedSignals: ArtifactSignal[] = [];
    const matchedFuncs: ArtifactFunc[] = [];
    const matchedTypes: ArtifactType[] = [];
    const matchedModules: ArtifactModule[] = [];
    let truncated = false;

    for (const signal of this.model.signals) {
      if (!textHit([signal.name, signal.alias, signal.ctype, signal.unit, signal.path, ...signal.tags])) {
        continue;
      }
      if (matchedSignals.length >= FILTER_MATCH_LIMIT) {
        truncated = true;
        break;
      }
      matchedSignals.push(signal);
    }
    for (const func of this.model.funcs) {
      if (!textHit([func.name, func.path, ...func.tags])) continue;
      if (matchedFuncs.length >= FILTER_MATCH_LIMIT) {
        truncated = true;
        break;
      }
      matchedFuncs.push(func);
    }
    for (const type of this.model.types) {
      const fieldHit = type.fields.some((field) =>
        textHit([field.name, field.ctype, ...field.tags]),
      );
      if (!fieldHit && !textHit([type.name, type.path, ...type.tags])) continue;
      if (matchedTypes.length >= FILTER_MATCH_LIMIT) {
        truncated = true;
        break;
      }
      matchedTypes.push(type);
    }
    for (const module of this.model.modules) {
      if (!textHit([module.name, module.path])) continue;
      if (matchedModules.length >= FILTER_MATCH_LIMIT) {
        truncated = true;
        break;
      }
      matchedModules.push(module);
    }

    const outSignals: ArtifactSignal[] = [];
    const outFuncs: ArtifactFunc[] = [];
    const outSignalIds = new Set<string>();
    const outFuncIds = new Set<string>();
    const hitSignalIds = new Set<string>();
    const hitFuncIds = new Set<string>();
    let budget = FILTER_ENTITY_LIMIT;

    const addSignal = (signal: ArtifactSignal): boolean => {
      if (outSignalIds.has(signal.id)) return true;
      if (budget <= 0) {
        truncated = true;
        return false;
      }
      outSignalIds.add(signal.id);
      outSignals.push(signal);
      budget -= 1;
      return true;
    };
    const addFunc = (func: ArtifactFunc): boolean => {
      if (outFuncIds.has(func.id)) return true;
      if (budget <= 0) {
        truncated = true;
        return false;
      }
      outFuncIds.add(func.id);
      outFuncs.push(func);
      budget -= 1;
      return true;
    };

    // 先放命中实体；装不下就如实标记截断，并把该条从 hits 里去掉，
    // 保证「hits 里的每一条都一定能在树里显示」这个不变量。
    for (const signal of matchedSignals) {
      if (addSignal(signal)) hitSignalIds.add(signal.id);
    }
    for (const func of matchedFuncs) {
      if (addFunc(func)) hitFuncIds.add(func.id);
    }

    // 再补一跳邻居，只为画流/信息面板可读，不加入 hits。
    for (const signal of matchedSignals) {
      for (const func of this.writersBySignal.get(signal.id) ?? []) addFunc(func);
      for (const func of this.readersBySignal.get(signal.id) ?? []) addFunc(func);
    }
    for (const func of matchedFuncs) {
      for (const signalId of [...func.writes, ...func.reads]) {
        const signal = this.signalsById.get(signalId);
        if (signal !== undefined) addSignal(signal);
      }
      for (const calleeId of func.calls) {
        const callee = this.funcsById.get(calleeId);
        if (callee !== undefined) addFunc(callee);
      }
    }

    return {
      signals: outSignals,
      funcs: outFuncs,
      types: [],
      loadedModules: [],
      hits: {
        modules: matchedModules.map((module) => module.id),
        signals: [...hitSignalIds],
        funcs: [...hitFuncIds],
        types: matchedTypes.map((type) => type.id),
      },
      truncated,
    };
  }
}

/**
 * 阈值语义：
 *   - 负数 → 永不切片（排障时想验证全量路径）；
 *   - 0    → 只要模型非空就切片（端到端测试走这条路，样本程序集太小）；
 *   - n    → 信号 + 函数超过 n 才切片。
 */
export function createModelSlicer(
  model: ArtifactModel,
  threshold: number = DEFAULT_SLICE_THRESHOLD,
): ModelSlicer | undefined {
  if (threshold < 0) return undefined;
  if (model.signals.length + model.funcs.length <= threshold) return undefined;
  return new ModelSlicer(model);
}
