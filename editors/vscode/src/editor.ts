/**
 * 程序集自定义编辑器。
 *
 * 生命周期（VS Code 的契约）：
 *   openCustomDocument → resolveCustomEditor → webview 发 "ready" → 解析 → 发 "init"。
 * 解析不放在 openCustomDocument：那时页面还没建好，失败只能弹通知；
 * 放在 "ready" 之后，错误可以就地显示在页面里（解析核心缺失、sidecar 缺失、格式不支持）。
 *
 * webview 与宿主之间的消息方向：
 *   宿主 → webview：loading / init / slice / filterResult / error / groupingSaved
 *   webview → 宿主：ready / reload / forceLoad / requestNode / select / filter /
 *                   saveGrouping / openDefault / copy
 *
 * 模型默认整份下发；信号 + 函数超过 `drawcode.artifactSliceThreshold`
 * （默认 2000）时改走切片：init 只发模块骨架、类型、诊断与计数，其余实体由
 * requestNode（展开模块）、select（选中实体取邻居）、filter（宿主侧搜索）按需
 * 下发。阈值设为 0 可让所有程序集走切片路径；设为 -1 强制全量。
 * 解析始终在 worker 线程里进行，扩展宿主只负责渲染。
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  ArtifactTooLargeError,
  CoreUnavailableError,
  InspectFailedError,
  loadArtifactModel,
  readSettings,
} from "./modelLoader";
import { createModelSlicer, type ModelSlicer, type ModelTotals } from "./slicer";
import type { ArtifactModel } from "./types";

export const VIEW_TYPE = "drawcode.artifact";

/**
 * webview 完成 init 后的回执。
 *
 * 宿主发出 init 只代表消息进了 webview 的消息队列，不代表脚本成功建好了树：
 * CSP 写错、脚本抛异常、模块加载失败都会让页面停在空白，而宿主毫不知情。
 * 回执把「webview 真的处理完 init」变成一个可观测事件：端到端测试用它作为
 * 完成点（不必 sleep 猜时间），排障时也能区分「还没解析完」与「解析完但渲染失败」。
 */
export interface InitAck {
  /** webview 实际收到的模块数。 */
  modules: number;
  /** 是否走切片路径。 */
  sliced: boolean;
  /** 模型真实总量；全量模式下由 webview 数出来，切片模式下取自宿主。 */
  totals?: ModelTotals;
}

/** 最近一次 initAck，按 document URI 存；只服务于命令与测试，不参与渲染。 */
const initAcks = new Map<string, InitAck>();
/** 正在等回执的调用方；retainContextWhenHidden 下可能先到回执后注册等待，故两者都要查。 */
const ackWaiters = new Map<string, Array<(ack: InitAck) => void>>();

export interface ArtifactHandle {
  refresh(options?: { ignoreSize?: boolean }): Promise<void>;
  modelJson(): string;
  model(): ArtifactModel | undefined;
}

/** 每个打开的 webview 一份；命令（刷新、复制 JSON）通过 URI 找到它。 */
const handles = new Map<string, ArtifactHandle>();

export function getHandle(uri: vscode.Uri): ArtifactHandle | undefined {
  return handles.get(uri.toString());
}

/** 当前活动标签若是程序集视图，返回它的 URI。 */
export function activeArtifactUri(): vscode.Uri | undefined {
  for (const group of vscode.window.tabGroups.all) {
    const input = group.activeTab?.input;
    if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) return input.uri;
  }
  return undefined;
}

/** 读取最近一次 initAck；没有则返回 undefined。 */
export function getInitAck(uri: vscode.Uri): InitAck | undefined {
  return initAcks.get(uri.toString());
}

/**
 * 等这一次打开的回执。
 *
 * 先查已到达的回执，再注册等待：webview 可能在 `vscode.openWith` 返回之前
 * 就完成 init（缓存命中时尤其快），只注册等待会永远错过。
 * 超时抛错而不是返回 undefined，避免调用方把「超时」误当成「模块数为 0」。
 */
export function waitForInitAck(uri: vscode.Uri, timeoutMs = 30_000): Promise<InitAck> {
  const key = uri.toString();
  const existing = initAcks.get(key);
  if (existing !== undefined) return Promise.resolve(existing);

  return new Promise<InitAck>((resolve, reject) => {
    const list = ackWaiters.get(key) ?? [];
    let settled = false;
    const waiter = (ack: InitAck): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ack);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const remaining = (ackWaiters.get(key) ?? []).filter((item) => item !== waiter);
      if (remaining.length === 0) ackWaiters.delete(key);
      else ackWaiters.set(key, remaining);
      reject(new Error(`等待 webview initAck 超时（${timeoutMs} ms）：${key}`));
    }, timeoutMs);
    list.push(waiter);
    ackWaiters.set(key, list);
  });
}

/** webview 回执入库，并唤醒所有等待者。 */
function recordInitAck(key: string, ack: InitAck): void {
  initAcks.set(key, ack);
  const waiters = ackWaiters.get(key);
  if (waiters === undefined) return;
  ackWaiters.delete(key);
  for (const waiter of waiters) waiter(ack);
}

/** 把 webview 发来的 totals 校验成结构化的数值；任何一项不合法就整体丢弃。 */
function readTotals(raw: unknown): ModelTotals | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const out = {} as ModelTotals;
  for (const field of ["modules", "types", "signals", "funcs", "edges", "storeTypes"] as const) {
    const n = value[field];
    if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
    out[field] = n;
  }
  return out;
}

// ── 分组配置（<程序集名>.drawcode.json） ──────────────────────────────────
//
// 配置放在程序集同目录，而不是扩展的 globalState：同一份程序集常被多人/多台
// 机器打开，配置跟着程序集走才有意义。宿主负责唯一的磁盘读写；webview 只
// 拿到已解析的配置，不碰文件系统（webview 没有 Node 权限）。

/** 与 media/logic.js 的 GROUP_CONFIG_VERSION 保持一致。 */
const GROUPING_CONFIG_VERSION = 1;
const GROUP_MAX_LEVELS = 6;
const GROUP_MAX_PRESETS = 32;
const GROUP_ALIAS_MAX = 80;

export interface GroupingConfig {
  version: number;
  levels: string[];
  active: string | null;
  defaultPreset: string | null;
  presets: Array<{ alias: string; levels: string[] }>;
}

/** 只保留“非空、不过长、不重复”的层级名。未知属性名不删：程序集重编译后可能暂时缺失。 */
function readGroupLevels(raw: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const text = typeof item === "string" ? item.trim() : "";
    if (text === "" || text.length > 100 || out.includes(text)) continue;
    if (out.length >= GROUP_MAX_LEVELS) break;
    out.push(text);
  }
  return out;
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/**
 * 把磁盘上的任意 JSON 洗成可写回的配置。
 *
 * 与 webview 的清洗规则一致：宁可丢掉坏条目，也不让坏配置把视图卡住。
 * `active` / `defaultPreset` 指向不存在的别名时降级为 null——这正是
 * “程序集或配置变了以后不能异常”的兜底。
 */
export function sanitizeGroupingConfig(raw: unknown): GroupingConfig {
  const out: GroupingConfig = {
    version: GROUPING_CONFIG_VERSION,
    levels: [],
    active: null,
    defaultPreset: null,
    presets: [],
  };
  const record = asRecord(raw);
  if (record === undefined) return out;

  out.levels = readGroupLevels(record.levels);

  const presets: GroupingConfig["presets"] = [];
  const seen = new Set<string>();
  const rawPresets = Array.isArray(record.presets) ? record.presets : [];
  for (const item of rawPresets) {
    if (presets.length >= GROUP_MAX_PRESETS) break;
    const preset = asRecord(item);
    if (preset === undefined) continue;
    const alias = typeof preset.alias === "string" ? preset.alias.trim() : "";
    if (alias === "" || alias.length > GROUP_ALIAS_MAX || seen.has(alias)) continue;
    seen.add(alias);
    presets.push({ alias, levels: readGroupLevels(preset.levels) });
  }
  out.presets = presets;

  const pickAlias = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const alias = value.trim();
    return seen.has(alias) ? alias : null;
  };
  out.active = pickAlias(record.active);
  out.defaultPreset = pickAlias(record.defaultPreset);
  return out;
}

/**
 * 程序集旁边的配置路径：同目录、同 basename，扩展名换成 `.drawcode.json`。
 * 只对本地文件生效；untitled / 远程 URI 没有可写的同目录。
 */
export function groupingConfigPath(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== "file" || uri.fsPath.length === 0) return undefined;
  const base = path.basename(uri.fsPath, path.extname(uri.fsPath));
  return path.join(path.dirname(uri.fsPath), `${base}.drawcode.json`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

interface LoadedGrouping {
  path: string;
  config: GroupingConfig | null;
  warning: string;
}

/** 读配置。任何失败都折算成 warning，不让它阻断程序集解析。 */
async function readGroupingConfig(uri: vscode.Uri): Promise<LoadedGrouping> {
  const target = groupingConfigPath(uri);
  if (target === undefined) {
    return {
      path: "",
      config: null,
      warning: "该程序集不是本地文件，分组配置只保留在当前会话里。",
    };
  }
  try {
    const text = await fs.readFile(target, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        path: target,
        config: null,
        warning: `分组配置不是合法 JSON，已忽略：${path.basename(target)}`,
      };
    }
    return { path: target, config: sanitizeGroupingConfig(parsed), warning: "" };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { path: target, config: null, warning: "" };
    return {
      path: target,
      config: null,
      warning: `分组配置读取失败：${errorText(error)}`,
    };
  }
}

/**
 * 原子写入：先写同目录临时文件，再 rename 覆盖。
 * 直接覆盖目标文件时，写到一半崩溃会留下半截 JSON，下次打开就解析失败。
 */
async function writeGroupingConfig(
  uri: vscode.Uri,
  raw: unknown,
): Promise<{ ok: boolean; path: string; message: string }> {
  const target = groupingConfigPath(uri);
  if (target === undefined) {
    return { ok: false, path: "", message: "非本地文件，未写入分组配置" };
  }
  const config = sanitizeGroupingConfig(raw);
  const temp = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await fs.rename(temp, target);
    return { ok: true, path: target, message: "" };
  } catch (error) {
    try {
      await fs.unlink(temp);
    } catch {
      // 临时文件可能根本没创建；清理失败不覆盖主错误。
    }
    return { ok: false, path: target, message: `分组配置写入失败：${errorText(error)}` };
  }
}

export class ArtifactDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {
    // 没有需要释放的原生资源；模型留在 handle 里，标签关闭后由 handle 的 map 移除。
  }
}

export class ArtifactEditorProvider implements vscode.CustomReadonlyEditorProvider<ArtifactDocument> {
  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): ArtifactDocument {
    return new ArtifactDocument(uri);
  }

  resolveCustomEditor(
    document: ArtifactDocument,
    panel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): void {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      // 只放行 media/：webview 里不加载远端资源，CSP 才有意义。
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webview.html = renderHtml(webview, this.context.extensionUri);

    let current: { model: ArtifactModel; json: string } | undefined;
    // 当前这代模型对应的切片器；undefined 表示走全量下发。它必须和 `current`
    // 同一代更新：刷新时旧切片器继续应答，会把旧模型的实体拼进新模型。
    let slicer: ModelSlicer | undefined;
    // 同一面板可能连续触发 ready/reload/forceLoad；用代号丢弃过期结果，
    // 否则慢的旧解析会覆盖快的新解析。
    let generation = 0;

    const post = (message: unknown): void => {
      void webview.postMessage(message);
    };

    const key = document.uri.toString();

    const load = async (options: { ignoreSize?: boolean } = {}): Promise<void> => {
      const mine = ++generation;
      // 旧回执对应旧一代模型：刷新后若保留它，waitForInitAck 会立刻返回过期数据。
      initAcks.delete(key);
      post({ type: "loading" });
      try {
        const settings = readSettings();
        // 配置读取与程序集解析互不依赖，并行发起；配置读失败只降级成提示。
        const loadingGrouping = readGroupingConfig(document.uri);
        const loaded = await loadArtifactModel(document.uri, this.context, token, settings, options);
        const grouping = await loadingGrouping;
        if (mine !== generation || token.isCancellationRequested) return;
        current = loaded;
        slicer = createModelSlicer(loaded.model, settings.artifactSliceThreshold);
        const config = {
          showCompilerGenerated: settings.showCompilerGenerated,
          showExcluded: settings.showExcluded,
        };
        if (slicer === undefined) {
          post({ type: "init", sliced: false, model: loaded.model, config, grouping });
          return;
        }
        // 切片模式：模块骨架与类型一次给全，信号/函数留空。`totals` 让概览与
        // 状态栏仍显示真实总量，而不是「0 个信号」。
        post({
          type: "init",
          sliced: true,
          model: slicer.initModel(),
          totals: slicer.totals,
          loadedModules: slicer.initiallyLoadedModules(),
          hasOrphans: slicer.hasOrphans(),
          config,
          grouping,
        });
      } catch (error) {
        if (mine !== generation || token.isCancellationRequested) return;
        post(describeError(error));
      }
    };

    const handle: ArtifactHandle = {
      refresh: (options) => load(options),
      modelJson: () => current?.json ?? "",
      model: () => current?.model,
    };
    handles.set(key, handle);

    panel.onDidDispose(() => {
      generation += 1;
      if (handles.get(key) === handle) handles.delete(key);
      // 面板关闭后回执不再有意义；留着会让「关掉再开」的测试读到上一份模型。
      initAcks.delete(key);
    });

    webview.onDidReceiveMessage((message: {
      type?: unknown;
      text?: unknown;
      moduleId?: unknown;
      kind?: unknown;
      id?: unknown;
      query?: unknown;
      modules?: unknown;
      sliced?: unknown;
      totals?: unknown;
      config?: unknown;
      xml?: unknown;
      fileName?: unknown;
    }) => {
      switch (message.type) {
        case "ready":
        case "reload":
          void load();
          break;
        case "forceLoad":
          void load({ ignoreSize: true });
          break;
        case "requestNode": {
          // 展开一个模块：只回它直属的信号与函数。模块骨架本来就在 init 里。
          const moduleId = typeof message.moduleId === "string" ? message.moduleId : "";
          if (slicer === undefined || moduleId.length === 0) break;
          post({
            type: "slice",
            request: "requestNode",
            moduleId,
            ...slicer.moduleSlice(moduleId),
          });
          break;
        }
        case "select": {
          // 选中实体：回一跳邻居，让信息面板与画布不因切片而缺边。
          const kind = typeof message.kind === "string" ? message.kind : "";
          const id = typeof message.id === "string" ? message.id : "";
          if (slicer === undefined || id.length === 0) break;
          post({
            type: "slice",
            request: "select",
            kind,
            id,
            ...slicer.selectSlice(kind, id),
          });
          break;
        }
        case "filter": {
          // 搜索在宿主侧全量执行：webview 手里只有已加载的切片，本地搜不全。
          const query = typeof message.query === "string" ? message.query : "";
          if (slicer === undefined) break;
          post({ type: "filterResult", query, ...slicer.filterSlice(query) });
          break;
        }
        case "initAck": {
          // webview 的完成信号：到这里才说明 init 已被脚本处理，树/概览都画过了。
          // 数值来自 webview，按不可信输入校验；非法就记 0，让测试明确失败而不是
          // 把 NaN 传播到断言里（NaN !== NaN 的断言信息很难读）。
          recordInitAck(key, {
            modules: typeof message.modules === "number" && Number.isFinite(message.modules)
              ? message.modules
              : 0,
            sliced: message.sliced === true,
            totals: readTotals(message.totals),
          });
          break;
        }
        case "saveGrouping":
          // 路径只由 document.uri 推导，消息里不接受任何路径参数：
          // 即便 webview 被注入，也只能写程序集旁边那一个固定文件。
          void writeGroupingConfig(document.uri, message.config).then((result) => {
            post({ type: "groupingSaved", ...result });
          });
          break;
        case "exportDrawio":
          void exportDrawio(document.uri, message.xml, message.fileName);
          break;
        case "openDefault":
          // "default" 是 VS Code 的内置 viewType：用文件默认编辑器（文本/二进制）打开。
          void vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
          break;
        case "copy": {
          const text = typeof message.text === "string" ? message.text : "";
          void vscode.env.clipboard.writeText(text).then(() => {
            void vscode.window.setStatusBarMessage("已复制到剪贴板", 2000);
          });
          break;
        }
        default:
          break;
      }
    });
  }
}

/**
 * 导出 webview 画好的 draw.io 文件。
 *
 * 为什么由宿主落盘而不是 webview 直接下载：
 *   - VS Code webview 没有任意路径写权限，`showSaveDialog` 只能从宿主调；
 *   - 导出位置默认在程序集同目录，但最终路径必须由用户确认，避免悄悄覆盖；
 *   - 消息里的文件名只是“建议值”，这里再做一次 basename 清洗，防止 `../`。
 */
async function exportDrawio(
  documentUri: vscode.Uri,
  xmlValue: unknown,
  fileNameValue: unknown,
): Promise<void> {
  const xml = typeof xmlValue === "string" ? xmlValue : "";
  if (xml.length === 0 || !xml.includes("<mxfile")) {
    void vscode.window.showErrorMessage("导出失败：没有收到有效的 draw.io 内容");
    return;
  }

  const base = path.basename(documentUri.fsPath);
  let suggested = typeof fileNameValue === "string" ? fileNameValue : "";
  suggested = suggested.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim();
  if (suggested.length === 0) suggested = base;
  if (!suggested.toLowerCase().endsWith(".drawio")) suggested += ".drawio";
  if (suggested.length > 120) suggested = suggested.slice(0, 120);

  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(documentUri.fsPath), suggested)),
    filters: { "draw.io 图": ["drawio"] },
    saveLabel: "导出",
  });
  if (target === undefined) return;

  try {
    await fs.writeFile(target.fsPath, xml, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`导出 draw.io 失败：${message}`);
    return;
  }

  const action = await vscode.window.showInformationMessage(
    `已导出 ${path.basename(target.fsPath)}`,
    "打开",
  );
  if (action === "打开") {
    await vscode.commands.executeCommand("vscode.open", target);
  }
}

function describeError(error: unknown): {
  type: "error";
  kind: "tooLarge" | "coreMissing" | "inspect" | "unknown";
  message: string;
  detail: string;
} {
  if (error instanceof ArtifactTooLargeError) {
    return { type: "error", kind: "tooLarge", message: error.message, detail: "" };
  }
  if (error instanceof CoreUnavailableError) {
    return { type: "error", kind: "coreMissing", message: error.message, detail: "" };
  }
  if (error instanceof InspectFailedError) {
    return { type: "error", kind: "inspect", message: error.message, detail: error.detail };
  }
  return {
    type: "error",
    kind: "unknown",
    message: error instanceof Error ? error.message : String(error),
    detail: "",
  };
}

function nonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * HTML 只做骨架与 CSP；交互全部在 `media/` 下的脚本里。
 * 用 `<script src>` 而不是内联字符串：编辑器对 media 文件有缓存与语法高亮，
 * 也让脚本能被 Node 单测直接加载。
 */
function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const media = (...segments: string[]): vscode.Uri =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", ...segments));
  const n = nonce();

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("style.css")}">
<title>Drawcode 程序集视图</title>
</head>
<body>
<header class="topbar">
  <div class="title-group">
    <span class="title" id="artifact-title">程序集</span>
    <span class="subtitle" id="artifact-subtitle"></span>
  </div>
  <nav class="tabs" role="tablist">
    <button class="tab" role="tab" data-tab="overview">概览</button>
    <button class="tab is-active" role="tab" data-tab="flow">模块交联</button>
    <button class="tab" role="tab" data-tab="er">持久化数据</button>
  </nav>
  <div class="actions">
    <button class="ghost-button" id="refresh-button" title="重新解析程序集">刷新</button>
    <button class="ghost-button" id="default-button" title="用默认编辑器打开">以默认编辑器打开</button>
  </div>
</header>

<main id="content">
  <section class="pane" id="pane-overview" role="tabpanel" hidden></section>

  <!--
    模块交联页是三列 + 底部三块信息区：
      左：连线栏（画「第 N 行 → 第 M 行」，与模块树同步滚动）
      中：模块树（唯一一棵树，端口行不再向右长列）
      右：勾选端口各自的 groupbox（字段树在框内向下展开）
    底部三块分别属于一列，宽度与上方列一一对齐；中间两条竖分隔条贯穿上下，
    拖动时上下同时改变宽度，读图的人不会看到“信息块与列错位”。
  -->
  <section class="pane split" id="pane-flow" role="tabpanel">
    <div class="flow-top">
      <div class="wire-pane" id="wire-pane">
        <div class="pane-head">
          <span class="pane-head-title">数据流</span>
          <span class="pane-count" id="wire-count"></span>
        </div>
        <!--
          提示层放在 host 外面：graph.js 每次重绘都会清空 #wire-host，
          提示若作为它的子节点会被一起删掉。提示层用绝对定位覆盖在画布上，
          pointer-events 设为 none，不挡连线点击。
        -->
        <div class="wire-host" id="wire-host"></div>
        <div class="canvas-hint" id="canvas-hint">在中间勾选端口，这里会把「第 N 行 → 第 M 行」连起来。</div>
      </div>
      <div class="vsplitter" id="splitter" role="separator" aria-orientation="vertical" title="拖动调整连线栏宽度"></div>
      <div class="cascade-pane" id="cascade-pane">
        <!--
          工具栏分“收纳 / 展开”两态：收纳只留一行关键操作（搜索、属性筛选、分组开关），
          其余开关与批量展开收进 toolbar-advanced，避免长期占掉半屏树高。
        -->
        <div class="toolbar">
          <button class="ghost-button small toolbar-toggle" id="toolbar-toggle" type="button"
                  aria-expanded="false" title="展开筛选与分组的高级选项">筛选与分组 ▾</button>
          <input class="filter" id="filter" type="search" placeholder="过滤：模块 / 信号 / 类型 / 字段" />
          <select class="facet" id="facet" title="按源码属性值筛选"></select>
          <button class="ghost-button small" id="group-toggle" type="button" title="按源码属性值把模块分成多层">分组模式</button>
          <span class="toolbar-advanced" id="toolbar-advanced" hidden>
            <label class="toggle"><input type="checkbox" id="show-empty" /> 显示空模块</label>
            <label class="toggle"><input type="checkbox" id="show-excluded" /> 显示排除项</label>
            <label class="toggle"><input type="checkbox" id="show-compiler" /> 显示编译器生成</label>
            <button class="ghost-button small" id="collapse-all" type="button" title="收起所有模块">全收起</button>
            <button class="ghost-button small" id="expand-all" type="button" title="展开所有模块">全展开</button>
          </span>
          <span class="toolbar-summary" id="toolbar-summary" hidden></span>
        </div>
        <!--
          分组条：层级按顺序成为树的层层桶，属性值不同的模块各自挂到对应桶下。
          配置（层级、别名、默认项）写程序集同目录的 <程序集名>.drawcode.json。
        -->
        <div class="groupbar" id="groupbar" hidden>
          <span class="groupbar-title">分组层级</span>
          <div class="group-levels" id="group-levels"></div>
          <select class="facet" id="group-add-level" title="选择一个属性作为下一层分组"></select>
          <button class="ghost-button small" id="group-add" type="button" title="把选中的属性加为一层">加一层</button>
          <span class="groupbar-title">配置</span>
          <select class="facet" id="group-preset" title="已保存的分组配置"></select>
          <input class="group-alias" id="group-alias" type="text" maxlength="80" placeholder="配置别名" />
          <button class="ghost-button small" id="group-save" type="button" title="把当前层级保存为这个别名">保存配置</button>
          <button class="ghost-button small" id="group-default" type="button" title="打开该程序集时默认应用这个别名">设为默认</button>
          <button class="ghost-button small" id="group-delete" type="button" title="删除当前选中的配置">删除配置</button>
          <span class="groupbar-hint" id="group-hint"></span>
        </div>
        <div class="cascade-scroll" id="cascade" tabindex="0"></div>
      </div>
      <div class="vsplitter" id="splitter-group" role="separator" aria-orientation="vertical" title="拖动调整模块树与 groupbox 的宽度比例"></div>
      <div class="group-pane" id="group-pane">
        <div class="pane-head">
          <span class="pane-head-title">信号 Groupbox</span>
          <button class="ghost-button small" id="export-drawio" type="button"
                  title="把当前勾选的模块与信号导出为 draw.io 文件">导出 Drawio</button>
          <span class="pane-count" id="group-count"></span>
        </div>
        <div class="group-scroll" id="group-host"></div>
      </div>
    </div>
    <div class="hsplitter" id="hsplitter" role="separator" aria-orientation="horizontal" title="拖动调整下方信息区高度"></div>
    <div class="flow-bottom">
      <div class="info-cell" id="wire-info-cell">
        <div class="info-cell-head">连线信息</div>
        <div class="info-panel" id="wire-info">
          <div class="info-empty">点击左侧连线，查看这条数据流的起止行。</div>
        </div>
      </div>
      <div class="bottom-gap"></div>
      <div class="info-cell" id="tree-info-cell">
        <div class="info-cell-head">模块 / 信号信息</div>
        <div class="info-panel" id="tree-info">
          <div class="info-empty">点选模块、分组或端口行，这里显示它的信息。</div>
        </div>
      </div>
      <div class="bottom-gap"></div>
      <div class="info-cell" id="group-info-cell">
        <div class="info-cell-head">字段信息</div>
        <div class="info-panel" id="group-info">
          <div class="info-empty">点选右侧 groupbox 里的字段，这里显示结构布局。</div>
        </div>
      </div>
    </div>
  </section>

  <section class="pane" id="pane-er" role="tabpanel" hidden></section>
</main>

<footer class="statusbar"><span id="status"></span></footer>

<script nonce="${n}" src="${media("logic.js")}"></script>
<script nonce="${n}" src="${media("cascade.js")}"></script>
<script nonce="${n}" src="${media("groups.js")}"></script>
<script nonce="${n}" src="${media("graph.js")}"></script>
<script nonce="${n}" src="${media("main.js")}"></script>
</body>
</html>`;
}
