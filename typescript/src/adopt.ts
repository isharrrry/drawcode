/**
 * 把「用户在 draw.io 里新加的元素」接回 IR。对等 Python `adopt.py`。
 *
 * `sync` 的方向本来是 **源码 -> 图**，所以图里多出来的东西会被三层静默丢掉：
 *
 *   1. `readLayout` 只收带 `symbolId` 的 `<object>`；
 *   2. `applyLayout` 对不认识的 id 直接跳过；
 *   3. `sync` 遍历的是**源码文件列表**，不是图里的节点。
 *
 * 于是「我在 draw.io 里加了个方块」不会报错、也不会生成任何代码 —— 元素凭空消失。
 *
 * 本模块补上反向那一步：把图里多出来的顶点变成新的 `Signal` / `Func`，
 * 剩下的交给 `codegen` 既有的 missing 分支写回源码。要决的东西（哪一类、叫什么）
 * 按下面的规则定，定不下来的**一律回报**，绝不猜。
 */

import { exists } from "./fsutil.ts";
import type { ForeignCell, Layout } from "./drawio.ts";
import { makeFunc, makeSignal } from "./model.ts";
import type { Direction, Func, Model, Param, Signal } from "./model.ts";
import { matchAt } from "./regex.ts";

/** `int16_t g_new` / `void fir_apply(void)` / `g_plain` */
const DECL_RE =
  /^\s*(?:(?<ctype>[A-Za-z_][\w\s*]*?)\s+)?(?<name>[A-Za-z_]\w*)\s*(?:\((?<params>[^)]*)\))?\s*$/;

/**
 * 我们生成的信号用的是五边形（`shape=path`）或椭圆；函数用默认矩形。
 * 用户照着现有节点画，就能被认出来。
 *
 * 注意 `ellipse` 必须写成**裸词**：draw.io 自己的椭圆 style 就是 `ellipse;`，
 * 只有 drawcode 生成时才会写成 `shape=ellipse`。只认后者的话，用户在工具栏上
 * 随手画的椭圆会被判成函数、写进 .c —— 而且不报错。
 */
const SIGNAL_MARKERS = ["shape=path", "shape=ellipse", "ellipse"];

/** 按形状判断新元素是变量还是函数。 */
export function classify(style: string): "signal" | "func" {
  const s = style ?? "";
  return SIGNAL_MARKERS.some((m) => s.includes(m)) ? "signal" : "func";
}

/** 从五边形的朝向推断方向；认不出返回空串，交给调用方决定。 */
export function direction(style: string): Direction | "" {
  const s = style ?? "";
  if (s.includes("direction=east")) return "in";
  if (s.includes("direction=west")) return "out";
  return "";
}

/**
 * 把节点文字当成一行声明来解析。
 *
 * 返回 `[ctype, name, params]`：`params === null` 表示这不是函数写法。
 *   `int16_t g_new`        -> `["int16_t", "g_new", null]`
 *   `void fir(void)`       -> `["void", "fir", ""]`
 *   `g_plain`              -> `["", "g_plain", null]`
 */
export function parseLabel(label: string): [string, string, string | null] {
  const m = matchAt(DECL_RE, label ?? "");
  if (m === null) return ["", "", null];
  return [(m.groups?.ctype ?? "").trim(), m.groups?.name ?? "", m.groups?.params ?? null];
}

/**
 * group 名 -> 该组的源文件集合。
 *
 * 一个组通常横跨两个文件（`adc.h` 声明 + `adc.c` 实现），所以这里是**集合**
 * 而不是单值：信号属于 `.h`、函数实现属于 `.c`，落点按类型再挑一次。
 * 早先写成单值映射时，先命中的是函数、把整组都指到 `.c`，
 * 结果新信号被写进头文件之外的地方 —— 那是错的。
 */
function groupFiles(model: Model): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const push = (group: string, file: string): void => {
    if (group === "" || file === "") return;
    const set = out.get(group);
    if (set === undefined) out.set(group, new Set([file]));
    else set.add(file);
  };
  for (const e of model.signals.values()) push(e.group, e.file);
  for (const e of model.funcs.values()) push(e.group, e.file);
  return out;
}

/**
 * 挑落点：优先 `prefer` 后缀。
 *
 * C 侧的组通常只在 IR 里登记了头文件（函数节点归属到它声明所在的 `.h`），
 * 所以函数实现要找**同名** `.c`：`dsp.h` -> `dsp.c`。找不到才退回 `.h`，
 * 否则函数体会被写进头文件里。
 */
function pickFile(candidates: Set<string>, prefer: string, root?: string): string {
  const sorted = [...candidates].sort();
  for (const f of sorted) {
    if (f.endsWith(prefer)) return f;
  }
  if (prefer === ".c") {
    for (const f of sorted) {
      if (f.endsWith(".h")) {
        const sibling = f.slice(0, -2) + ".c";
        if (root === undefined || exists(`${root}/${sibling}`)) return sibling;
      }
    }
  }
  for (const f of sorted) {
    if (f.endsWith(".h") || f.endsWith(".cs")) return f;
  }
  return sorted[0] as string;
}

/**
 * 把 `layout.foreign` 里的元素接进 model。
 *
 * `root` 是源码根目录，用来判断 `xxx.h` 的同名 `xxx.c` 是否存在
 * （函数实现该落到那里）。省略时只按 IR 里登记的文件落点。
 *
 * 返回 `[added, problems]`：
 *   `added`    —— 接进来的新 id 列表，供调用方报告；
 *   `problems` —— 没能自动决定的，每条是一句话。**这些不会被猜**，
 *                 也不会被写进源码，只是如实告诉用户。
 */
export function adoptForeign(
  model: Model,
  layout: Layout,
  root?: string,
): [string[], string[]] {
  const added: string[] = [];
  const problems: string[] = [];
  const groupFile = groupFiles(model);
  const seq = { signal: 0, func: 0 };

  for (const cell of layout.foreign ?? []) {
    let kind: "signal" | "func" = classify(cell.style);
    const label = cell.label;
    const [ctype, name0, params] = parseLabel(label);
    const isFunc = params !== null || kind === "func";
    kind = isFunc ? "func" : "signal";

    const where = label ? `${cell.cell_id} (${label})` : cell.cell_id;

    const group = cell.container;
    if (group === "") {
      problems.push(
        `${where}: 不在任何容器里，无法判断该写进哪个源文件 —— 把它拖进某个模块容器后重试`,
      );
      continue;
    }
    const targetFiles = groupFile.get(group);
    if (targetFiles === undefined || targetFiles.size === 0) {
      problems.push(`${where}: 容器 '${group}' 不对应任何已知源文件，无法落盘`);
      continue;
    }
    const target = isFunc ? pickFile(targetFiles, ".c", root) : pickFile(targetFiles, ".h", root);

    let name = name0;
    if (name === "") {
      seq[kind] += 1;
      name = `${kind === "func" ? "new_func" : "new_signal"}_${seq[kind]}`;
      problems.push(`${where}: 节点没有文字，按序号命名为 ${name}`);
    }

    const newId = `${target}::${name}`;
    if (model.signals.has(newId) || model.funcs.has(newId)) {
      problems.push(`${where}: ${newId} 已存在，跳过`);
      continue;
    }

    const d = direction(cell.style);
    if (kind === "signal") {
      if (ctype === "") {
        problems.push(`${where}: 认不出类型，先按空类型生成 —— 请在源码里补上（例如 int16_t）`);
      } else if (d === "") {
        problems.push(`${where}: 认不出方向（节点形状没有朝向），先按 in 生成`);
      }
      // dir 必须非空：TS 侧的 renderAnnotation 无条件写 `dir=`，
      // 空值会渲染成字面量 `dir=undefined`。
      model.addSignal(
        makeSignal({
          id: newId,
          name,
          ctype,
          dir: d === "" ? "in" : d,
          file: target,
          group,
          x: cell.x,
          y: cell.y,
          w: cell.w,
          h: cell.h,
        }),
      );
    } else {
      const plist: Param[] = [];
      for (const raw0 of (params ?? "").split(",")) {
        const raw = raw0.trim();
        if (raw === "" || raw === "void") continue;
        const [ptype, pname] = parseLabel(raw);
        if (pname !== "") plist.push({ name: pname, ctype: ptype, dir: "in" });
      }
      const f: Func = makeFunc({
        id: newId,
        name,
        ret: ctype === "" ? "void" : ctype,
        params: plist,
        file: target,
        group,
      });
      model.addFunc(f);
    }
    added.push(newId);
  }

  return [added, problems];
}
