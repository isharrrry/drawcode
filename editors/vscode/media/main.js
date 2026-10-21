/**
 * Webview 主程序：状态、事件与三个视图的装配。
 *
 * 分工：
 *   - `logic.js` 只算（端口、树行、groupbox、连线、ER、概览），无 DOM；
 *   - `cascade.js` / `groups.js` / `graph.js` 只画，不做语义判断；
 *   - 本文件持有唯一一份状态，每次变化都“改状态 → 重算 → 重绘”，不做局部补丁。
 *     数据规模是千级实体，重算成本远低于维护增量更新的正确性成本。
 *
 * 三个视图对应三列：
 *   - 左列 `graph.js`：连线。只画 `buildPortFlow` 给出的“行号 → 行号”，
 *     与中间模块树同步滚动；
 *   - 中列 `cascade.js`：模块树。唯一一棵树，端口行是叶子；
 *   - 右列 `groups.js`：勾选端口各自的 groupbox，字段树在框内向下展开。
 *
 * 状态为什么这样切：
 *   - `checked` 是唯一决定“画什么”的集合（端口键与字段键并集）；
 *   - `groupExpanded` 是 groupbox 内字段树的展开集合，与树的 `collapsed` 分开：
 *     同一个字段路径在树里没有行，混在一起会互相误伤；
 *   - `selectedRowKey` / `selectedGroupKey` / `selectedEdgeKey` 是三个视图各自的
 *     选中项，互不清除——底部三块信息区各显示各的，正是用户要的效果。
 *
 * 状态持久化用 `vscode.getState()/setState()`。版本号整体丢弃旧形状：
 * v2 存档里有 `chain`（按深度向右加列）与另一套宽度字段，按新状态解释只会
 * 得到一堆无效键。
 */
(function () {
  "use strict";

  var vscode = acquireVsCodeApi();
  var D = globalThis.DCLogic;
  // v4：新增分组模式字段。旧存档里的 selectedRowKey 可能是普通树的键，
  // 与分组树的行键不通用，因此整体丢弃重来（只影响视图状态，不丢磁盘配置）。
  var SAVED_VERSION = 5;

  /** 与 cascade.js 的 HEADER_H 一致：树的表头高度。 */
  var TREE_HEADER_H = 30;

  // ── DOM ────────────────────────────────────────────────────────────────

  var dom = {
    title: document.getElementById("artifact-title"),
    subtitle: document.getElementById("artifact-subtitle"),
    tabs: Array.prototype.slice.call(document.querySelectorAll(".tab")),
    panes: {
      overview: document.getElementById("pane-overview"),
      flow: document.getElementById("pane-flow"),
      er: document.getElementById("pane-er"),
    },
    flowTop: document.querySelector(".flow-top"),
    wireHost: document.getElementById("wire-host"),
    wireCount: document.getElementById("wire-count"),
    canvasHint: document.getElementById("canvas-hint"),
    splitter: document.getElementById("splitter"),
    splitterGroup: document.getElementById("splitter-group"),
    hsplitter: document.getElementById("hsplitter"),
    cascadeHost: document.getElementById("cascade"),
    groupHost: document.getElementById("group-host"),
    groupCount: document.getElementById("group-count"),
    exportDrawio: document.getElementById("export-drawio"),
    wireInfo: document.getElementById("wire-info"),
    treeInfo: document.getElementById("tree-info"),
    groupInfo: document.getElementById("group-info"),
    filter: document.getElementById("filter"),
    facet: document.getElementById("facet"),
    toolbarToggle: document.getElementById("toolbar-toggle"),
    toolbarAdvanced: document.getElementById("toolbar-advanced"),
    toolbarSummary: document.getElementById("toolbar-summary"),
    showEmpty: document.getElementById("show-empty"),
    showExcluded: document.getElementById("show-excluded"),
    showCompiler: document.getElementById("show-compiler"),
    collapseAll: document.getElementById("collapse-all"),
    expandAll: document.getElementById("expand-all"),
    groupToggle: document.getElementById("group-toggle"),
    groupbar: document.getElementById("groupbar"),
    groupLevels: document.getElementById("group-levels"),
    groupAddLevel: document.getElementById("group-add-level"),
    groupAdd: document.getElementById("group-add"),
    groupPreset: document.getElementById("group-preset"),
    groupAlias: document.getElementById("group-alias"),
    groupSave: document.getElementById("group-save"),
    groupDefault: document.getElementById("group-default"),
    groupDelete: document.getElementById("group-delete"),
    groupHint: document.getElementById("group-hint"),
    refresh: document.getElementById("refresh-button"),
    openDefault: document.getElementById("default-button"),
    status: document.getElementById("status"),
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function fmtBytes(n) {
    if (!n || n <= 0) return "—";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // ── 状态 ───────────────────────────────────────────────────────────────

  var saved = vscode.getState() || {};
  var restored = saved.version === SAVED_VERSION;

  var state = {
    tab: saved.tab === "overview" || saved.tab === "er" ? saved.tab : "flow",
    collapsed: new Set(restored && Array.isArray(saved.collapsed) ? saved.collapsed : []),
    checked: new Set(restored && Array.isArray(saved.checked) ? saved.checked : []),
    // groupbox 字段树默认全展开，只记录被用户收起的节点。
    // 这样新勾选的信号不用逐个点开，也不会因为旧版 groupExpanded
    // 里残留的“展开项”把新节点漏掉。
    groupCollapsed: new Set(
      restored && Array.isArray(saved.groupCollapsed) ? saved.groupCollapsed : [],
    ),
    filter: typeof saved.filter === "string" ? saved.filter : "",
    facet: restored && typeof saved.facet === "string" ? saved.facet : "",
    showEmptyModules: restored && saved.showEmptyModules === true,
    showExcluded: restored && saved.showExcluded === true,
    showCompilerGenerated: restored && saved.showCompilerGenerated === true,
    // 布局：左栏像素宽 + 树/groupbox 的宽度比 + 底部信息区像素高。
    // 存像素而不是百分比：拖动分隔条时用户预期的是“这条线停在鼠标下”，
    // 百分比会在窗口缩放后跳到别处。
    wireWidth: restored && typeof saved.wireWidth === "number" ? saved.wireWidth : 190,
    treeFr: restored && typeof saved.treeFr === "number" ? saved.treeFr : 1.35,
    groupFr: restored && typeof saved.groupFr === "number" ? saved.groupFr : 1,
    bottomHeight: restored && typeof saved.bottomHeight === "number" ? saved.bottomHeight : 190,
    groupIndexWidth:
      restored && typeof saved.groupIndexWidth === "number" ? saved.groupIndexWidth : 30,
    selectedRowKey: restored && typeof saved.selectedRowKey === "string"
      ? saved.selectedRowKey
      : null,
    selectedGroupKey: restored && typeof saved.selectedGroupKey === "string"
      ? saved.selectedGroupKey
      : null,
    selectedEdgeKey: null,

    // ── 工具栏形态 ──
    // 默认收纳：只留搜索、属性筛选与分组开关一行。高级开关与批量展开
    // 收进 toolbar-advanced，需要时由用户手动展开。
    toolbarExpanded: restored && saved.toolbarExpanded === true,

    // ── 分组模式 ──
    // 层级为空 = 普通树。`groupEnabled` 与层级分开，是为了让用户关掉模式后
    // 再打开时还能看到原来的层级配置。
    groupEnabled: restored && saved.groupEnabled === true,
    groupLevels: restored && Array.isArray(saved.groupLevels)
      ? D.cleanGroupLevels(saved.groupLevels)
      : [],
    groupActive: restored && typeof saved.groupActive === "string" ? saved.groupActive : null,
    // 磁盘配置的镜像。字段与 .drawcode.json 一一对应，由宿主读写。
    groupConfig: {
      version: D.GROUP_CONFIG_VERSION,
      levels: [],
      active: null,
      defaultPreset: null,
      presets: [],
    },
    groupConfigPath: "",
    groupConfigWarning: "",
    groupIssues: [],

    // ── 切片状态（不持久化：模型换了，这些集合就作废） ──
    sliced: false,
    totals: null,
    hasOrphans: false,
    loadedModules: new Set(),
    pendingModules: new Set(),
    loadedIds: { signals: new Set(), funcs: new Set(), types: new Set() },
    filterHits: null,
    filterTruncated: false,
    selectRequested: new Set(),
    configured: restored,
  };

  var model = null;
  var cascade = null;
  var cascadeRows = new Map();
  var flow = null;
  // 底部两块信息区最近一次展示的内容；切片到达后据此重绘。
  var lastTreeInfo = null;
  var lastGroupInfo = null;
  var pendingFocus = null;
  var rebuildScheduled = false;
  var afterRebuild = [];
  var facetSignature = "";
  // 分组配置只在“第一次 init”时决定是否启用；之后的 init（刷新/切片重载）
  // 不能把用户刚关掉的分组模式又打开。
  var groupInitApplied = false;

  function save() {
    vscode.setState({
      version: SAVED_VERSION,
      tab: state.tab,
      collapsed: Array.from(state.collapsed),
      checked: Array.from(state.checked),
      groupCollapsed: Array.from(state.groupCollapsed),
      filter: state.filter,
      facet: state.facet,
      showEmptyModules: state.showEmptyModules,
      showExcluded: state.showExcluded,
      showCompilerGenerated: state.showCompilerGenerated,
      wireWidth: state.wireWidth,
      treeFr: state.treeFr,
      groupFr: state.groupFr,
      bottomHeight: state.bottomHeight,
      groupIndexWidth: state.groupIndexWidth,
      selectedRowKey: state.selectedRowKey,
      selectedGroupKey: state.selectedGroupKey,
      toolbarExpanded: state.toolbarExpanded,
      groupEnabled: state.groupEnabled,
      groupLevels: state.groupLevels,
      groupActive: state.groupActive,
    });
  }

  function selectionFlags() {
    return {
      showExcluded: state.showExcluded,
      showCompilerGenerated: state.showCompilerGenerated,
    };
  }

  function moduleName(moduleId) {
    if (moduleId === D.ORPHAN_MODULE_ID || model === null) return "未归属";
    var m = D.getIndex(model).moduleById.get(moduleId);
    return m === undefined ? "未归属" : m.name;
  }

  /**
   * 端口键 → 树行号。
   *
   * 分组模式下一个端口可能出现在多个桶里，`indexByKey` 里没有端口键
   * （行键带出现路径），必须用 `rowIndexByPortKey`；折叠时它还会给出
   * 锚定到的祖先行号，与左侧连线一致。
   */
  function rowNumber(key) {
    if (cascade === null) return null;
    var index = cascade.rowIndexByPortKey.get(key);
    return index === undefined ? null : index + 1;
  }

  function groupByPort(portKey) {
    if (cascade === null) return null;
    for (var i = 0; i < cascade.groups.length; i += 1) {
      if (cascade.groups[i].portKey === portKey) return cascade.groups[i];
    }
    return null;
  }

  function findGroupField(key) {
    if (cascade === null) return null;
    for (var i = 0; i < cascade.groups.length; i += 1) {
      var fields = cascade.groups[i].fields;
      for (var k = 0; k < fields.length; k += 1) {
        if (fields[k].key === key) return fields[k];
      }
    }
    return null;
  }

  // ── 切片 ───────────────────────────────────────────────────────────────

  /**
   * 合并一批按需下发的实体。
   *
   * 必须创建新的 model / 数组对象：`logic.js` 的索引缓存是 WeakMap，键是
   * model 对象本身；原地 push 会让索引继续用旧快照，树里看不到新端口。
   */
  function mergeSlice(message) {
    if (model === null) return false;
    var changed = false;

    function mergeList(existing, incoming, seen) {
      if (!Array.isArray(incoming) || incoming.length === 0) return existing;
      var out = existing;
      for (var i = 0; i < incoming.length; i += 1) {
        var item = incoming[i];
        if (!item || typeof item.id !== "string" || seen.has(item.id)) continue;
        if (out === existing) out = existing.slice();
        seen.add(item.id);
        out.push(item);
        changed = true;
      }
      return out;
    }

    var types = mergeList(model.types, message.types, state.loadedIds.types);
    var signals = mergeList(model.signals, message.signals, state.loadedIds.signals);
    var funcs = mergeList(model.funcs, message.funcs, state.loadedIds.funcs);

    if (Array.isArray(message.loadedModules)) {
      message.loadedModules.forEach(function (id) {
        if (typeof id !== "string") return;
        state.loadedModules.add(id);
        state.pendingModules.delete(id);
      });
    }

    if (changed) {
      model = {
        info: model.info,
        modules: model.modules,
        types: types,
        signals: signals,
        funcs: funcs,
        edges: model.edges,
        diagnostics: model.diagnostics,
      };
    }
    return changed;
  }

  function requestModule(moduleId) {
    if (!state.sliced || typeof moduleId !== "string" || moduleId.length === 0) return;
    if (state.loadedModules.has(moduleId) || state.pendingModules.has(moduleId)) return;
    state.pendingModules.add(moduleId);
    vscode.postMessage({ type: "requestNode", moduleId: moduleId });
  }

  function requestSelect(kind, id) {
    if (!state.sliced || typeof kind !== "string" || typeof id !== "string") return;
    var key = kind + ":" + id;
    if (state.selectRequested.has(key)) return;
    state.selectRequested.add(key);
    vscode.postMessage({ type: "select", kind: kind, id: id });
  }

  function entityExists(kind, id) {
    if (model === null) return false;
    var ix = D.getIndex(model);
    if (kind === "signal") return ix.signalById.has(id);
    if (kind === "func") return ix.funcById.has(id);
    if (kind === "type") return ix.typeById.has(id);
    if (kind === "module") return ix.moduleById.has(id) || id === D.ORPHAN_MODULE_ID;
    return false;
  }

  function prefetchModules() {
    if (!state.sliced || model === null) return;
    var limit = 500;
    var sent = 0;
    for (var i = 0; i < model.modules.length && sent < limit; i += 1) {
      var m = model.modules[i];
      if (m.exclude && !state.showExcluded) continue;
      if (state.loadedModules.has(m.id) || state.pendingModules.has(m.id)) continue;
      var counts = m.counts || {};
      if ((counts.signals || 0) + (counts.funcs || 0) === 0) continue;
      requestModule(m.id);
      sent += 1;
    }
    if (state.hasOrphans) requestModule(D.ORPHAN_MODULE_ID);
  }

  // ── 视图装配 ───────────────────────────────────────────────────────────

  var cascadeView = new globalThis.CascadeView(dom.cascadeHost, {
    onSelect: selectRow,
    onCheck: checkRow,
    onExpand: expandRow,
    // 连线端点跟着树的滚动位置走；graph 内部只平移图层，不重建。
    onScroll: function () {
      graph.setScroll(dom.cascadeHost.scrollTop);
    },
  });

  var groupView = new globalThis.GroupView(dom.groupHost, {
    onClose: closeGroup,
    onCheck: checkGroupRow,
    onExpand: expandGroupRow,
    onSelect: selectGroupRow,
    onColumns: function (width) {
      // 列宽拖完才写状态：拖动过程中每个 pointermove 都 setState 没必要。
      state.groupIndexWidth = width;
      save();
    },
  });

  var graph = new globalThis.Graph(dom.wireHost, {
    onEdge: function (edge, key) {
      state.selectedEdgeKey = key;
      graph.setSelected(key);
      showEdgeInfo(dom.wireInfo, edge);
    },
    onBlank: function () {
      if (state.selectedEdgeKey === null) return;
      state.selectedEdgeKey = null;
      graph.setSelected(null);
      showEmptyInfo(dom.wireInfo, "点击左侧连线，查看这条数据流的起止行。");
    },
  });

  function scheduleRebuild(after) {
    if (typeof after === "function") afterRebuild.push(after);
    if (rebuildScheduled) return;
    rebuildScheduled = true;
    requestAnimationFrame(function () {
      rebuildScheduled = false;
      rebuild();
      var queue = afterRebuild;
      afterRebuild = [];
      queue.forEach(function (fn) {
        try {
          fn();
        } catch (error) {
          console.error(error);
        }
      });
    });
  }

  function cascadeState() {
    return {
      collapsed: state.collapsed,
      checked: state.checked,
      groupCollapsed: state.groupCollapsed,
      filter: state.filter,
      facet: state.facet,
      filterHits: state.filterHits,
      showExcluded: state.showExcluded,
      showCompilerGenerated: state.showCompilerGenerated,
      showEmptyModules: state.showEmptyModules,
      // 关掉分组模式时传空数组：buildCascade 走普通树路径，不再计算分组。
      groupLevels: state.groupEnabled ? state.groupLevels : [],
      sliced: state.sliced,
      loadedModules: state.loadedModules,
      hasOrphans: state.hasOrphans,
    };
  }

  /**
   * 重算树、groupbox 与连线。
   *
   * groupbox 容器在换数据时会短暂清空，滚动位置会被浏览器归零；
   * 先存后还，用户拖完一个字段树的滚动条不会跳回顶部。
   */
  function rebuild() {
    if (model === null) {
      renderStatus();
      return;
    }
    var groupScroll = dom.groupHost.scrollTop;
    cascade = D.buildCascade(model, cascadeState());

    cascadeRows = new Map();
    cascade.rows.forEach(function (row) {
      if (!cascadeRows.has(row.key)) cascadeRows.set(row.key, row);
    });
    if (state.selectedRowKey !== null && !cascade.indexByKey.has(state.selectedRowKey)) {
      state.selectedRowKey = null;
    }
    if (state.selectedGroupKey !== null && findGroupField(state.selectedGroupKey) === null) {
      state.selectedGroupKey = null;
    }

    cascadeView.setData(cascade, { selectedKey: state.selectedRowKey });
    groupView.setData(cascade.groups, {
      selectedKey: state.selectedGroupKey,
      indexWidth: state.groupIndexWidth,
    });
    dom.groupHost.scrollTop = groupScroll;
    dom.groupCount.textContent = String(cascade.groups.length);
    renderFacetOptions();
    renderGroupBar();
    renderFlow();
  }

  // ── 树交互 ─────────────────────────────────────────────────────────────

  function expandRow(row) {
    if (row.kind === "module") {
      if (state.collapsed.has(row.key)) {
        state.collapsed.delete(row.key);
        requestModule(row.moduleId);
      } else {
        state.collapsed.add(row.key);
      }
    } else if (row.kind === "group" || row.kind === "bucket" || row.kind === "func") {
      // 分组行、桶行与函数行都只是“范围折叠”，不加载数据，键可以直接复用。
      // 函数行折叠后其端口会锚回函数行（logic 的 portAnchorKeys）。
      if (state.collapsed.has(row.key)) state.collapsed.delete(row.key);
      else state.collapsed.add(row.key);
    } else if (row.kind === "port") {
      // 端口行是叶子：点击等价于“去右边看它的 groupbox”。
      if (state.checked.has(row.portKey)) groupView.reveal(row.portKey);
      else setStatus("该端口还没有勾选；勾选后右侧才会生成 groupbox。");
      return;
    } else {
      return;
    }
    rebuild();
    save();
    requestAnimationFrame(function () {
      cascadeView.scrollToKey(state.selectedRowKey);
    });
  }

  /**
   * 点选树行：只改“我在看哪一行”，不动勾选。
   * 端口行若已勾选，右侧对应 groupbox 会滚进视野并闪一下——
   * 这是用户要求的“再次点击左侧信号条目能够右侧定位跳转”。
   */
  function selectRow(row) {
    state.selectedRowKey = row.key;
    cascadeView.setSelected(row.key);

    if (row.kind === "module") {
      if (row.moduleId !== undefined) requestModule(row.moduleId);
      showModuleInfo(dom.treeInfo, row.moduleId);
    } else if (row.kind === "func") {
      // 函数行不是模块：不请求切片，只把函数自身的读写端口展示出来。
      showFuncInfo(dom.treeInfo, row.funcId);
      requestSelect("func", row.funcId);
    } else if (row.kind === "group") {
      showGroupInfo(dom.treeInfo, row);
    } else if (row.kind === "bucket") {
      showBucketInfo(dom.treeInfo, row);
    } else if (row.kind === "port") {
      showPortInfoByKey(dom.treeInfo, row.portKey);
      requestSelect("signal", row.signalId);
      if (state.checked.has(row.portKey) || state.checked.has(row.key)) {
        groupView.reveal(row.portKey);
      } else if (groupByPort(row.portKey) === null) {
        setStatus("勾选该端口后，右侧会生成它的 groupbox。");
      }
    }
    save();
  }

  /** 组内字段键：某端口在 checked 里的 sf| 前缀键。 */
  function fieldKeysForPort(portKey) {
    var keys = [];
    state.checked.forEach(function (key) {
      var field = D.parseFieldKey(key);
      if (field !== null && field.portKey === portKey) keys.push(key);
    });
    return keys;
  }

  function togglePortKeys(keys) {
    if (!keys || keys.length === 0) return;
    var next = new Set(state.checked);
    var all = keys.every(function (key) { return next.has(key); });
    var wanted = new Set(keys);
    // 整选/整消端口时清掉它下面的字段勾选：端口键已经表达了“全部字段”，
    // 两者并存会让取消整选后残留一批看不见的字段。
    Array.from(next).forEach(function (key) {
      var field = D.parseFieldKey(key);
      if (field !== null && wanted.has(field.portKey)) next.delete(key);
    });
    keys.forEach(function (key) {
      if (all) next.delete(key);
      else next.add(key);
    });
    state.checked = next;
  }

  function togglePortKey(portKey) {
    var next = new Set(state.checked);
    if (next.has(portKey)) {
      next.delete(portKey);
    } else {
      next.add(portKey);
      Array.from(next).forEach(function (key) {
        var field = D.parseFieldKey(key);
        if (field !== null && field.portKey === portKey) next.delete(key);
      });
    }
    state.checked = next;
  }

  function checkRow(row) {
    if (row.kind === "module" || row.kind === "group" || row.kind === "bucket") {
      // 桶的 portKeys 是子树聚合：勾一个桶 = 勾它下面所有模块的端口。
      togglePortKeys(row.portKeys || []);
    } else if (row.kind === "port") {
      togglePortKey(row.portKey);
      state.selectedRowKey = row.key;
    }
    var isChecked = row.kind === "port"
      ? state.checked.has(row.portKey)
      : (row.portKeys || []).some(function (key) { return state.checked.has(key); });
    rebuild();
    save();
    if (row.kind === "port" && isChecked) {
      requestAnimationFrame(function () {
        groupView.reveal(row.portKey);
      });
    }
  }

  /**
   * groupbox 里的字段勾选/取消。
   *
   * 端口键在 checked 里表示“该端口全部字段”。用户取消其中一个字段时，
   * 先把端口键换成“当前 groupbox 里可见字段”的显式集合，再去掉点中的那一行；
   * 否则取消会被端口键整选直接吞掉。
   *
   * 已知边界：这里只补当前展开可见的字段。更深层、当前折叠着的字段不会
   * 被显式保留——数据流按端口计算，字段集合只影响提示里的路径列表，
   * 因此这个损失不影响左侧连线是否正确。
   */
  function toggleFieldKey(row) {
    var next = new Set(state.checked);
    if (next.has(row.portKey)) {
      next.delete(row.portKey);
      var group = groupByPort(row.portKey);
      if (group !== null) {
        group.fields.forEach(function (field) { next.add(field.key); });
      }
      next.delete(row.key);
    } else if (next.has(row.key)) {
      next.delete(row.key);
    } else {
      next.add(row.key);
    }
    state.checked = next;
  }

  function checkGroupRow(row) {
    toggleFieldKey(row);
    state.selectedGroupKey = row.key;
    rebuild();
    save();
  }

  function expandGroupRow(row) {
    if (!row.expandable) return;
    // 取反“收起集合”：默认展开时，点一下记为收起；再点一下移除收起。
    if (state.groupCollapsed.has(row.key)) state.groupCollapsed.delete(row.key);
    else state.groupCollapsed.add(row.key);
    rebuild();
    save();
  }

  function selectGroupRow(row) {
    state.selectedGroupKey = row.key;
    groupView.setSelected(row.key);
    showFieldInfo(dom.groupInfo, row);
    save();
  }

  function closeGroup(group) {
    var next = new Set(state.checked);
    next.delete(group.portKey);
    Array.from(next).forEach(function (key) {
      var field = D.parseFieldKey(key);
      if (field !== null && field.portKey === group.portKey) next.delete(key);
    });
    state.checked = next;
    if (state.selectedGroupKey !== null) {
      var row = findGroupField(state.selectedGroupKey);
      if (row === null || row.portKey === group.portKey) state.selectedGroupKey = null;
    }
    rebuild();
    save();
  }

  // ── 连线 ───────────────────────────────────────────────────────────────

  /** 树容器与连线容器的顶差：两边顶部工具条高度不同也能对齐。 */
  function wireOrigin() {
    var treeRect = dom.cascadeHost.getBoundingClientRect();
    var wireRect = dom.wireHost.getBoundingClientRect();
    return treeRect.top - wireRect.top;
  }

  function renderFlow() {
    if (model === null) {
      renderStatus();
      return;
    }
    flow = D.buildPortFlow(model, state.checked, {
      flags: selectionFlags(),
      indexByKey: cascade === null ? null : cascade.indexByKey,
      // 折叠的端口行会锚到最近的可见祖先行，连线不因收起模块而消失。
      rowIndexByPortKey: cascade === null ? null : cascade.rowIndexByPortKey,
      // 区分“端口就在这一行”与“锚到了祖先行”，决定信息面板是否提示已折叠。
      portRowIndex: cascade === null ? null : cascade.portRowIndex,
    });
    var drawable = flow.edges.filter(function (edge) { return edge.drawable === true; });
    graph.render(drawable, {
      selectedEdge: state.selectedEdgeKey,
      originY: wireOrigin(),
      headerH: TREE_HEADER_H,
      rowH: D.ROW_HEIGHT,
    });
    graph.setScroll(dom.cascadeHost.scrollTop);

    dom.wireCount.textContent = flow.edges.length === 0 ? "" : String(flow.edges.length);
    dom.wireCount.title = flow.sharedCount > 0
      ? "连线 " + (flow.edges.length - flow.sharedCount) + " 条 · 同信号 " +
        flow.sharedCount + " 段（无方向性）"
      : "";
    var empty = drawable.length === 0;
    dom.canvasHint.hidden = !empty;
    if (empty) {
      dom.canvasHint.textContent =
        state.checked.size === 0
          ? "在中间勾选端口，这里会把「第 N 行 → 第 M 行」连起来。"
          : flow.edges.length > 0
            ? (flow.sharedCount > 0
              ? "同信号关联的两端当前被折叠到同一行；展开模块树后即可画出。"
              : "勾选的端口有数据流，但对端行当前被折叠或过滤掉了；展开模块树后即可画出。")
            : "勾选的端口没有对端（只写不读或只读不写），因此没有连线。";
    }
    renderStatus();
  }

  // ── 导出 draw.io ───────────────────────────────────────────────────────
  //
  // 导出不重新解析模型，而是复用当前这帧的 `flow`：
  //   - 用户看到什么就导出什么，不会因为折叠/过滤状态不同而变一张图；
  //   - 模块按当前树行号排序，矩形从上往下排，和左侧模块树阅读顺序一致；
  //   - 每个模块拆成「输出」「输入」两个矩形，信号作为连线标签。

  function xmlEscape(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function buildDrawioXml() {
    if (flow === null) return null;
    var nodeById = new Map();
    (flow.nodes || []).forEach(function (node) { nodeById.set(node.nodeId, node); });

    var edges = (flow.edges || []).filter(function (edge) {
      return nodeById.has(edge.from) && nodeById.has(edge.to);
    });
    var used = new Set();
    edges.forEach(function (edge) {
      used.add(edge.from);
      used.add(edge.to);
    });
    // 没有连线时仍把勾选的模块画出来：用户可能只想导出模块清单。
    if (used.size === 0) {
      (flow.nodes || []).forEach(function (node) { used.add(node.nodeId); });
    }

    var orderByModule = new Map();
    used.forEach(function (nodeId) {
      var node = nodeById.get(nodeId);
      if (node === undefined) return;
      var current = orderByModule.get(node.moduleId);
      if (current === undefined || node.order < current.order) {
        orderByModule.set(node.moduleId, { order: node.order, path: node.modulePath });
      }
    });
    var modules = Array.from(orderByModule.keys()).sort(function (a, b) {
      var A = orderByModule.get(a);
      var B = orderByModule.get(b);
      if (A.order !== B.order) return A.order - B.order;
      return A.path < B.path ? -1 : A.path > B.path ? 1 : 0;
    });

    var ROW_H = 120;
    var BOX_W = 250;
    var BOX_H = 58;
    var OUT_X = 60;
    var IN_X = 430;
    var TOP = 60;
    var boxByModule = new Map();
    var cells = [];
    var idSeq = 0;

    function addBox(moduleId, dir, lane) {
      var info = orderByModule.get(moduleId);
      var name = (info.path || moduleId) + (dir === "out" ? "-输出" : "-输入");
      var id = "dc-box-" + (idSeq += 1);
      var style = [
        "rounded=0",
        "whiteSpace=wrap",
        "html=1",
        "fontSize=12",
        "align=center",
        "verticalAlign=middle",
        dir === "out"
          ? "fillColor=#d5e8d4;strokeColor=#82b366"
          : "fillColor=#dae8fc;strokeColor=#6c8ebf",
      ].join(";");
      cells.push(
        '<mxCell id="' + id + '" value="' + xmlEscape(name) + '" style="' + style +
          '" vertex="1" parent="1">' +
          '<mxGeometry x="' + (dir === "out" ? OUT_X : IN_X) + '" y="' + lane.y +
          '" width="' + BOX_W + '" height="' + BOX_H + '" as="geometry"/>' +
          "</mxCell>",
      );
      return id;
    }

    modules.forEach(function (moduleId, index) {
      var lane = { y: TOP + index * ROW_H };
      boxByModule.set(moduleId + "|out", addBox(moduleId, "out", lane));
      boxByModule.set(moduleId + "|in", addBox(moduleId, "in", lane));
    });

    var outSeq = new Map();
    var inSeq = new Map();
    edges.forEach(function (edge, index) {
      var fromNode = nodeById.get(edge.from);
      var toNode = nodeById.get(edge.to);
      if (fromNode === undefined || toNode === undefined) return;

      var fromKey = fromNode.moduleId + "|" + (fromNode.role === "in" ? "in" : "out");
      var toKey = toNode.moduleId + "|" + (toNode.role === "in" ? "in" : "out");
      var source = boxByModule.get(fromKey);
      var target = boxByModule.get(toKey);
      if (source === undefined || target === undefined) return;

      // 同一矩形上可能挂多条线：在边的 25%/50%/75% 处错开端口，
      // 比全部挤在中点更容易看出有几条信号。
      var oi = outSeq.get(source) || 0;
      outSeq.set(source, oi + 1);
      var ii = inSeq.get(target) || 0;
      inSeq.set(target, ii + 1);
      var exitY = 0.25 + (oi % 3) * 0.25;
      var entryY = 0.25 + (ii % 3) * 0.25;

      // 同信号（无方向性）边不连「输出 → 输入」，而是同类端口互连：
      //   - 输出框从右侧出、右侧进，走图形外圈；
      //   - 输入框从左侧出、左侧进。
      // 普通数据流仍按「输出框右侧 → 输入框左侧」连接。
      var sameDir = fromNode.role === toNode.role;
      var exitX = sameDir && fromNode.role === "in" ? 0 : 1;
      var entryX = sameDir && toNode.role === "out" ? 1 : 0;

      // 同向关联线没有方向：draw.io 里也不能带箭头，否则「输出→输出」看起来
      // 像一条画反了的数据流。用 `endArrow=none` + 虚线表达「共享同一信号」。
      var sameSignal = edge.kind === "same-signal";
      var style = [
        "edgeStyle=orthogonalEdgeStyle",
        "curved=1",
        "rounded=1",
        "html=1",
        sameSignal ? "endArrow=none" : "endArrow=block",
        sameSignal ? "endFill=0" : "endFill=1",
        "strokeWidth=1.5",
        "fontSize=11",
        "strokeColor=" + (edge.color || "#6c8ebf"),
        edge.kind === "same-signal" ? "dashed=1" : "",
        "exitX=" + exitX,
        "exitY=" + exitY,
        "exitDx=0",
        "exitDy=0",
        "entryX=" + entryX,
        "entryY=" + entryY,
        "entryDx=0",
        "entryDy=0",
      ].filter(function (part) { return part.length > 0; }).join(";");

      var label = edge.label || "信号";
      if (edge.kind === "same-signal") {
        // out↔out 是两边都在写，in↔in 是两边都在读。
        label = (fromNode.role === "in" ? "同读 · " : "同写 · ") + label;
      }
      cells.push(
        '<mxCell id="dc-edge-' + (index + 1) + '" value="' + xmlEscape(label) +
          '" style="' + style + '" edge="1" parent="1" source="' + source +
          '" target="' + target + '"><mxGeometry relative="1" as="geometry"/></mxCell>',
      );
    });

    var width = IN_X + BOX_W + 80;
    var height = TOP + modules.length * ROW_H + 80;
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<mxfile host="drawcode" agent="drawcode-artifact-viewer">',
      '  <diagram id="drawcode-module-flow" name="模块交联">',
      '    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" ' +
        'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" ' +
        'pageWidth="' + width + '" pageHeight="' + height + '" math="0" shadow="0">',
      "      <root>",
      '        <mxCell id="0"/>',
      '        <mxCell id="1" parent="0"/>',
      cells.map(function (cell) { return "        " + cell; }).join("\n"),
      "      </root>",
      "    </mxGraphModel>",
      "  </diagram>",
      "</mxfile>",
    ].join("\n");
  }

  function exportDrawio() {
    if (flow === null || flow.nodes.length === 0) {
      setStatus("先在模块树里勾选端口，再导出 Drawio");
      return;
    }
    var xml = buildDrawioXml();
    if (xml === null) {
      setStatus("当前没有可导出的模块");
      return;
    }
    var base = model && model.info && model.info.path
      ? model.info.path.split(/[\\/]/).pop()
      : "模块交联";
    vscode.postMessage({
      type: "exportDrawio",
      xml: xml,
      fileName: base + "-模块交联.drawio",
    });
    setStatus("已生成 Drawio，请在保存对话框里选择位置");
  }

  // ── 布局 ───────────────────────────────────────────────────────────────

  function applyLayout() {
    var style = dom.panes.flow.style;
    style.setProperty("--wire-w", state.wireWidth + "px");
    style.setProperty("--tree-fr", String(state.treeFr));
    style.setProperty("--group-fr", String(state.groupFr));
    style.setProperty("--bottom-h", state.bottomHeight + "px");
  }

  /** 拖完分隔条再重排树：虚拟化窗口依赖容器的真实尺寸。 */
  function relayoutViews() {
    cascadeView.relayout();
    renderFlow();
  }

  function dragHandle(handle, onMove, onEnd) {
    handle.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      function move(moveEvent) { onMove(moveEvent); }
      function up() {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        if (onEnd) onEnd();
      }
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  dragHandle(dom.splitter, function (event) {
    var bounds = dom.flowTop.getBoundingClientRect();
    state.wireWidth = clamp(event.clientX - bounds.left, 70, Math.min(460, bounds.width / 2));
    applyLayout();
    // 连线栏变窄/变宽由 graph 的 ResizeObserver 处理；树的可视行数变了，
    // 需要重排虚拟化窗口。
    cascadeView.relayout();
  }, function () {
    relayoutViews();
    save();
  });

  dragHandle(dom.splitterGroup, function (event) {
    var bounds = dom.flowTop.getBoundingClientRect();
    // flex-grow 直接吃像素值：basis 为 0 时，宽度比例就是 fr 之比。
    var free = bounds.width - state.wireWidth - 8;
    var treePx = event.clientX - bounds.left - state.wireWidth - 4;
    treePx = clamp(treePx, 140, Math.max(140, free - 140));
    state.treeFr = treePx;
    state.groupFr = Math.max(80, free - treePx);
    applyLayout();
    cascadeView.relayout();
  }, function () {
    relayoutViews();
    save();
  });

  dragHandle(dom.hsplitter, function (event) {
    var bounds = dom.panes.flow.getBoundingClientRect();
    state.bottomHeight = clamp(bounds.bottom - event.clientY - 2, 80, bounds.height - 160);
    applyLayout();
    cascadeView.relayout();
  }, function () {
    relayoutViews();
    save();
  });

  // ── 信息区 ─────────────────────────────────────────────────────────────

  function formatFileSize(bytes) {
    if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return null;
    if (bytes < 1024) return bytes + " B";
    var units = ["KB", "MB", "GB"];
    var value = bytes;
    var unit = "B";
    for (var i = 0; i < units.length && value >= 1024; i++) {
      value /= 1024;
      unit = units[i];
    }
    return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + " " + unit + "（" + bytes + " 字节）";
  }

  function infoTable(pairs) {
    var table = el("table", "info-table");
    pairs.forEach(function (pair) {
      if (pair[1] === undefined || pair[1] === null || pair[1] === "") return;
      var tr = el("tr");
      tr.appendChild(el("th", null, pair[0]));
      tr.appendChild(el("td", null, String(pair[1])));
      table.appendChild(tr);
    });
    return table;
  }

  /** 把“引用按钮列表”追加到指定信息块；返回是否真的追加了。 */
  function refList(host, title, refs, kind) {
    if (!refs || refs.length === 0) return false;
    host.appendChild(el("div", "info-section", title + "（" + refs.length + "）"));
    var box = el("div");
    refs.forEach(function (ref) {
      var button = el("button", "info-ref", ref.name + (ref.path ? "  ·  " + ref.path : ""));
      button.addEventListener("click", function () {
        requestSelect(kind, ref.id);
        focusEntity(kind, ref.id, false);
      });
      box.appendChild(button);
    });
    host.appendChild(box);
    return true;
  }

  function portRefList(host, title, ports) {
    if (!ports || ports.length === 0) return false;
    host.appendChild(el("div", "info-section", title + "（" + ports.length + "）"));
    var box = el("div");
    ports.forEach(function (port) {
      var number = rowNumber(port.key);
      var label = D.portDirLabel(port.dir) + " · " + moduleName(port.moduleId) +
        (number === null ? "" : " · 行 " + number);
      var button = el("button", "info-ref", label);
      button.title = port.key;
      button.addEventListener("click", function () {
        selectPortKey(port.key, true);
      });
      box.appendChild(button);
    });
    host.appendChild(box);
    return true;
  }

  function selectedFieldPaths(portKey) {
    if (state.checked.has(portKey)) return ["（全部字段）"];
    var group = groupByPort(portKey);
    if (group === null) return [];
    return group.fields.filter(function (row) { return row.checked; }).map(function (row) {
      return row.fieldPath;
    });
  }

  function showEmptyInfo(host, text) {
    clear(host);
    host.appendChild(el("div", "info-empty", text));
  }

  function showPortInfoByKey(host, portKey) {
    lastTreeInfo = { kind: "port", key: portKey };
    var info = D.describePort(model, portKey, selectionFlags());
    clear(host);
    if (info === null) {
      host.appendChild(el("div", "info-empty", "端口不在当前模型里（可能已刷新）。"));
      return;
    }
    var s = info.signal;
    var p = info.port;
    var number = rowNumber(portKey);
    host.appendChild(
      el("div", "info-title",
        (p.inferredDir ? "方向未知" : D.portDirLabel(p.dir)) + " · " +
        (s.alias ? s.alias + " · " : "") + s.name),
    );
    host.appendChild(
      infoTable([
        ["端口", p.inferredDir
          ? "方向未标注（符号表只有全局变量，无法判断谁写谁读；暂按信号归属挂在输出端）"
          : (p.dir === "out"
            ? (p.declared
              ? "输出（补出：未观察到写者，按信号归属补出）"
              : "输出（本模块里的函数写入此信号）")
            : (p.declared
              ? "输入（补出：未观察到本端读者）"
              : "输入（本模块里的函数读取此信号）"))],
        ["模块", info.module === null || info.module === undefined ? "未归属" : info.module.name],
        ["行号", number === null ? "—" : String(number)],
        ["声明", p.inferredDir
          ? "是（方向未知，仅表示信号归属）"
          : (p.declared ? "是（未观察到本端函数，按信号方向或归属补出）" : "否")],
        ["信号方向", D.dirLabel(s.dir)],
        ["类型", s.ctype],
        ["单位", s.unit],
        ["说明", s.note],
        ["路径", s.path],
        ["标签", (s.tags || []).join(", ")],
        ["地址", s.address],
        ["标记", [s.external ? "外部" : "", s.exclude ? "排除" : "", s.inferred ? "推断" : ""]
          .filter(Boolean).join(" ")],
      ]),
    );

    var fields = selectedFieldPaths(portKey);
    if (fields.length > 0) {
      host.appendChild(el("div", "info-section", "已勾选字段：" + fields.join("、")));
    }

    var counterpartList = portRefList(
      host,
      p.dir === "out" ? "输入端口行" : "输出端口行",
      info.counterparts,
    );
    if (!counterpartList) {
      host.appendChild(el("div", "info-section", "对端：无（信号没有另一端的函数）"));
    }
    if (!refList(host, "写入函数", info.writers, "func")) {
      // 没有写者也是一种信息；只在完全没有任何读写引用时说明一次。
      if (info.readers.length === 0) {
        host.appendChild(el("div", "info-section", "没有读写引用（可能只被外部符号访问）。"));
      }
    } else {
      refList(host, "读取函数", info.readers, "func");
    }
  }

  /**
   * groupbox 字段信息。
   *
   * 非基本类型的结构字段只在这里显示类型名与布局——树行里不挂类型名，
   * 否则长路径会把字段名挤没（用户第 6 条要求）。
   */
  function showFieldInfo(host, row) {
    lastGroupInfo = { kind: "field", key: row.key };
    clear(host);
    host.appendChild(el("div", "info-title", "字段 · " + row.fieldPath));
    var field = row.field || {};
    // offset 与 size 的“未知”是两件事：引用类型字段有大小（指针槽）但没有
    // 有意义的偏移。负数表示未知，0 是合法值。
    var hasOffset = typeof field.offset === "number" && field.offset >= 0;
    var hasSize = typeof field.size === "number" && field.size >= 0;
    var ix = D.getIndex(model);
    var signal = ix.signalById.get(row.signalId);
    host.appendChild(
      infoTable([
        ["所属信号", signal === undefined ? row.signalId : D.signalLabel(signal)],
        ["所属结构", row.typeName],
        ["字段类型", field.ctype],
        ["偏移", hasOffset ? String(field.offset) : "—"],
        ["大小", hasSize ? String(field.size) : "—"],
        ["目标结构", row.expandable ? row.typeName : ""],
        ["位置", "第 " + (row.depth + 1) + " 层 · 序号 " + row.index],
        ["标签", (field.tags || []).join(", ")],
      ]),
    );
    if (row.collection) {
      host.appendChild(el("div", "info-section", "集合字段：展开的是元素类型的字段。"));
    }
    if (row.expandable) {
      host.appendChild(el("div", "info-section", "点击行前的虚线 +/- 可继续展开，一直展开到基本类型。"));
    }
    var locate = el("button", "info-ref", "定位所属端口行：" + moduleName(row.moduleId));
    locate.addEventListener("click", function () {
      selectPortKey(row.portKey, true);
    });
    host.appendChild(locate);
  }

  function showGroupInfo(host, row) {
    lastTreeInfo = null;
    var selected = (row.portKeys || []).filter(function (key) {
      return state.checked.has(key);
    }).length;
    clear(host);
    host.appendChild(el("div", "info-title", moduleName(row.moduleId) + " · " + row.label));
    var meaning = "本模块里的函数写入的信号（每个信号一行）";
    if (row.dir === "in") meaning = "本模块里的函数读取的信号（每个信号一行）";
    else if (row.dir === "unknown") {
      meaning = "符号表只能列出全局变量，无法判断谁写谁读；方向是推断的，不是元数据";
    } else if (row.dir === "func") {
      meaning = "符号表里的函数；没有读写关系，因此不拥有端口";
    }
    host.appendChild(
      infoTable([
        ["含义", meaning],
        ["数量", String((row.portKeys || []).length)],
        ["已勾选", String(selected)],
      ]),
    );
    if (row.dir === "func") {
      host.appendChild(
        el("div", "info-section",
          "程序集没有 drawcode 元数据：可以看到函数名，但没有读取/写入关系，" +
          "因此这些函数没有端口，也不能勾选。"),
      );
      return;
    }
    if (row.dir === "unknown") {
      host.appendChild(
        el("div", "info-section",
          "勾选后端口仍会出现在画布上，但没有可连接的对端——它只表示" +
          "“这个模块拥有该符号”，不表示数据流方向。"),
      );
    }
    host.appendChild(
      el("div", "info-section", "勾选分组 = 整组端口行；展开分组可逐个勾选。"),
    );
  }

  /**
   * 分组桶信息。
   *
   * 桶是“第 N 层属性的某个值”，不是模块；这里列出的模块按钮让读者能
   * 从分组视图回到模块本身。模块可能很多，只列前 30 个并给出总数。
   */
  function showBucketInfo(host, row) {
    lastTreeInfo = { kind: "bucket", key: row.key };
    var portKeys = row.portKeys || [];
    var selected = portKeys.filter(function (key) { return state.checked.has(key); }).length;
    clear(host);
    host.appendChild(
      el("div", "info-title",
        "第 " + (row.levelIndex + 1) + " 层 · " + row.level + "：" + row.valueLabel),
    );
    host.appendChild(
      infoTable([
        ["属性", row.level],
        ["属性值", row.value === "" ? "（未标注）" : row.value],
        ["层级", "第 " + (row.levelIndex + 1) + " 层"],
        ["分组路径", (row.pathValues || []).join(" → ")],
        ["模块", String((row.moduleIds || []).length)],
        ["端口", String(portKeys.length)],
        ["已勾选", String(selected)],
      ]),
    );
    host.appendChild(
      el("div", "info-section",
        "勾选桶 = 勾选它下面所有模块的端口；展开桶可继续往下看。"),
    );

    var moduleIds = row.moduleIds || [];
    if (moduleIds.length > 0) {
      host.appendChild(el("div", "info-section", "桶内模块（" + moduleIds.length + "）"));
      var box = el("div");
      moduleIds.slice(0, 30).forEach(function (moduleId) {
        var button = el("button", "info-ref", moduleName(moduleId));
        button.addEventListener("click", function () {
          focusEntity("module", moduleId, true);
        });
        box.appendChild(button);
      });
      host.appendChild(box);
      if (moduleIds.length > 30) {
        host.appendChild(
          el("div", "info-section", "还有 " + (moduleIds.length - 30) + " 个模块未列出。"),
        );
      }
    }
  }

  function showModuleInfo(host, moduleId) {
    lastTreeInfo = { kind: "module", id: moduleId };
    var ix = D.getIndex(model);
    var m = moduleId === D.ORPHAN_MODULE_ID
      ? { id: D.ORPHAN_MODULE_ID, name: "（未归属）", path: "", kind: "namespace", counts: {}, root: false, exclude: false }
      : ix.moduleById.get(moduleId);
    clear(host);
    if (m === undefined) {
      host.appendChild(el("div", "info-empty", "模块不在当前模型里。"));
      return;
    }
    var ports = D.getPorts(model, selectionFlags());
    var own = ports.byModule.get(moduleId);
    var outputs = own === undefined ? 0 : own.outputs.length;
    var inputs = own === undefined ? 0 : own.inputs.length;
    var subtree = ports.subtreeCounts.get(moduleId) || { outputs: 0, inputs: 0 };
    host.appendChild(el("div", "info-title", m.name));
    host.appendChild(
      infoTable([
        ["路径", m.path],
        ["种类", m.kind],
        ["本模块端口", "输出 " + outputs + " · 输入 " + inputs],
        ["子树端口", "输出 " + subtree.outputs + " · 输入 " + subtree.inputs],
        ["子树信号", String((m.counts || {}).signals || 0)],
        ["子树函数", String((m.counts || {}).funcs || 0)],
        ["子树类型", String((m.counts || {}).types || 0)],
        ["标记", [m.root ? "根模块" : "", m.exclude ? "排除" : ""].filter(Boolean).join(" ")],
      ]),
    );
    host.appendChild(
      el(
        "div",
        "info-section",
        "勾选端口后，右侧生成它的 groupbox，左侧画出「第 N 行 → 第 M 行」的连线。",
      ),
    );
  }

  function showSignalInfo(host, signalId) {
    lastTreeInfo = { kind: "signal", id: signalId };
    var info = D.describeSignal(model, signalId);
    clear(host);
    if (info === null) {
      host.appendChild(el("div", "info-empty", "信号不在模型中。"));
      return;
    }
    var s = info.signal;
    host.appendChild(el("div", "info-title", (s.alias ? s.alias + " · " : "") + s.name));
    host.appendChild(
      infoTable([
        ["方向", D.dirLabel(s.dir)],
        ["类型", s.ctype],
        ["单位", s.unit],
        ["说明", s.note],
        ["路径", s.path],
        ["标签", (s.tags || []).join(", ")],
        ["地址", s.address],
        ["标记", [s.external ? "外部" : "", s.exclude ? "排除" : "", s.inferred ? "推断" : ""]
          .filter(Boolean).join(" ")],
      ]),
    );
    portRefList(host, "端口行", D.portsForEntity(model, "signal", signalId, selectionFlags()));
    if (info.ownerType) {
      var owner = el("button", "info-ref", "所属结构：" + info.ownerType.name);
      owner.addEventListener("click", function () {
        focusEntity("type", info.ownerType.id, true);
      });
      host.appendChild(owner);
    }
    if (!refList(host, "写入位置", info.writers, "func") &&
        !refList(host, "读取位置", info.readers, "func")) {
      host.appendChild(el("div", "info-section", "没有读写引用（可能只被外部符号访问）。"));
    }
  }

  function showFuncInfo(host, funcId) {
    lastTreeInfo = { kind: "func", id: funcId };
    var info = D.describeFunc(model, funcId);
    clear(host);
    if (info === null) {
      host.appendChild(el("div", "info-empty", "函数不在模型中。"));
      return;
    }
    var f = info.func;
    host.appendChild(el("div", "info-title", f.name));
    host.appendChild(
      infoTable([
        ["返回", f.ret],
        ["路径", f.path],
        // 参数行沿用信号的属性语义：类型和名字是主体，alias/unit 放在括号里。
        // 只写类型和名字会让模板里 `unit=ms,alias=毫秒` 这类标注看起来“写了没生效”。
        ["参数", (f.params || []).map(function (p) {
          var extra = [p.alias, p.unit ? "单位 " + p.unit : ""]
            .filter(function (part) { return typeof part === "string" && part.length > 0; })
            .join("，");
          return p.ctype + " " + p.name + (extra ? "（" + extra + "）" : "");
        }).join(", ")],
        ["地址", f.address],
      ]),
    );
    portRefList(host, "关联端口行", D.portsForEntity(model, "func", funcId, selectionFlags()));
    if (!refList(host, "写入信号", info.writes, "signal") &&
        !refList(host, "读取信号", info.reads, "signal")) {
      host.appendChild(el("div", "info-section", "没有记录读写信号。"));
    }
  }

  function showTypeInfo(host, typeId) {
    var ix = D.getIndex(model);
    var t = ix.typeById.get(typeId);
    if (t === undefined) return;
    lastTreeInfo = { kind: "type", id: typeId };
    clear(host);
    host.appendChild(el("div", "info-title", t.name));
    host.appendChild(
      infoTable([
        ["种类", t.kind + (t.store ? " · Store" : "")],
        ["路径", t.path],
        ["大小", fmtBytes(t.size)],
        ["字段", String((t.fields || []).length)],
        ["标签", (t.tags || []).join(", ")],
      ]),
    );
    var ports = D.portsForEntity(model, "type", typeId, selectionFlags());
    if (!portRefList(host, "使用该类型的端口行", ports)) {
      host.appendChild(el("div", "info-section", "没有信号使用该类型（可能只作为内嵌字段出现）。"));
    }
  }

  /** 连线信息进左栏信息块：起止行号是这条边最短的坐标。 */
  function showEdgeInfo(host, edge) {
    clear(host);
    var ix = D.getIndex(model);
    var signal = ix.signalById.get(edge.signalId);
    var from = D.parsePortKey(edge.from);
    var to = D.parsePortKey(edge.to);
    // 同信号关联线没有方向：两端都叫“端口”，并明确说明它不是数据流。
    var shared = edge.kind === "same-signal";
    function endLabel(key, parsed, row, anchored) {
      if (parsed === null) return row === null ? "?" : "行 " + row;
      return (row === null ? "?" : "行 " + row) +
        (anchored ? "（端口已折叠，锚到祖先行）" : "") +
        " · " + moduleName(parsed.moduleId) + " · " + (parsed.dir === "out" ? "输出" : "输入");
    }
    host.appendChild(
      el("div", "info-title",
        (shared ? "同信号关联 · " : "数据流 · ") +
        (edge.label || (signal ? signal.name : edge.signalId))),
    );
    host.appendChild(
      infoTable([
        ["信号", signal === undefined ? edge.signalId : D.signalLabel(signal)],
        ["信号 ID", edge.signalId],
        [shared ? "端口 A" : "从", endLabel(edge.from, from, edge.fromRow, edge.fromAnchored)],
        [shared ? "端口 B" : "到", endLabel(edge.to, to, edge.toRow, edge.toAnchored)],
        ["类型", signal === undefined ? "" : signal.ctype],
        ["颜色", edge.color],
        [shared ? "说明" : "对端",
          shared
            ? "同向端口，仅表示引用同一信号，没有方向性数据流"
            : (edge.context ? "未显式勾选（自动带出）" : "")],
      ]),
    );
    if (edge.fieldPaths && edge.fieldPaths.length > 0) {
      host.appendChild(el("div", "info-section", "已选字段：" + edge.fieldPaths.join("、")));
    }
    var locateFrom = el("button", "info-ref", shared ? "定位端口 A" : "定位输出行");
    locateFrom.addEventListener("click", function () {
      if (edge.from) selectPortKey(edge.from, true);
    });
    host.appendChild(locateFrom);
    var locateTo = el("button", "info-ref", shared ? "定位端口 B" : "定位输入行");
    locateTo.addEventListener("click", function () {
      if (edge.to) selectPortKey(edge.to, true);
    });
    host.appendChild(locateTo);
  }

  /** 切片到达后重绘两块信息区：之前缺失的读写函数可能刚好补上了。 */
  function reloadInfo() {
    if (model === null) return;
    if (lastTreeInfo !== null) {
      if (lastTreeInfo.kind === "signal") showSignalInfo(dom.treeInfo, lastTreeInfo.id);
      else if (lastTreeInfo.kind === "func") showFuncInfo(dom.treeInfo, lastTreeInfo.id);
      else if (lastTreeInfo.kind === "type") showTypeInfo(dom.treeInfo, lastTreeInfo.id);
      else if (lastTreeInfo.kind === "port") showPortInfoByKey(dom.treeInfo, lastTreeInfo.key);
      else if (lastTreeInfo.kind === "module") showModuleInfo(dom.treeInfo, lastTreeInfo.id);
      else if (lastTreeInfo.kind === "bucket") {
        var bucket = cascadeRows.get(lastTreeInfo.key);
        // 层级被用户删掉后桶会消失：此时保留旧信息没有意义，清空。
        if (bucket !== undefined) showBucketInfo(dom.treeInfo, bucket);
        else showEmptyInfo(dom.treeInfo, "分组层级已变化，这个桶不再存在。");
      }
    }
    if (lastGroupInfo !== null && lastGroupInfo.kind === "field") {
      var row = findGroupField(lastGroupInfo.key);
      if (row !== null) showFieldInfo(dom.groupInfo, row);
    }
  }

  // ── 定位 ───────────────────────────────────────────────────────────────

  function preparePortVisibility(portKey) {
    var parsed = D.parsePortKey(portKey);
    if (parsed === null || model === null) return false;
    if (cascade !== null && cascade.grouping.enabled) {
      // 分组树里的行键带“出现路径”，普通树的 m| / g| 键一个都不适用。
      // buildCascade 已经提前登记了每个模块的所有桶/模块/分组键，直接全删。
      var keys = cascade.uncollapseByModule.get(parsed.moduleId);
      if (keys !== undefined) {
        keys.forEach(function (key) { state.collapsed.delete(key); });
      }
    } else {
      D.moduleChain(model, parsed.moduleId).forEach(function (moduleId) {
        state.collapsed.delete("m|" + moduleId);
      });
      state.collapsed.delete("g|" + parsed.dir + "|" + parsed.moduleId);
    }
    if (state.filter.length > 0 || state.filterHits !== null) {
      state.filter = "";
      state.filterHits = null;
      state.filterTruncated = false;
      dom.filter.value = "";
    }
    if (state.facet.length > 0) {
      state.facet = "";
      dom.facet.value = "";
    }
    return true;
  }

  /**
   * 选中端口行；若它已勾选，右侧 groupbox 一并滚进视野。
   * `withInfo=false` 用于“定位但不抢信息区”（例如 ER 已经写好了字段说明）。
   */
  function selectPortKey(portKey, withInfo) {
    if (model === null) return false;
    if (!preparePortVisibility(portKey)) return false;
    rebuild();
    // 分组模式下同一端口可能有多行；portRowKey 给出第一次出现的那行。
    var rowKey = cascade.portRowKey.get(portKey);
    if (rowKey === undefined && !state.showEmptyModules) {
      state.showEmptyModules = true;
      dom.showEmpty.checked = true;
      rebuild();
      rowKey = cascade.portRowKey.get(portKey);
    }
    if (rowKey === undefined) {
      state.selectedRowKey = null;
      return false;
    }
    state.selectedRowKey = rowKey;
    cascadeView.setSelected(rowKey);
    if (withInfo !== false) showPortInfoByKey(dom.treeInfo, portKey);
    requestAnimationFrame(function () {
      cascadeView.scrollToKey(rowKey);
      if (state.checked.has(portKey) || fieldKeysForPort(portKey).length > 0) {
        groupView.reveal(portKey);
      }
    });
    save();
    return true;
  }

  /**
   * 把某个实体定位到它的端口行。
   *
   * 过滤词、“显示空模块”都可能挡住目标：这里按代价从小到大解除。
   * 切片模式下实体可能还没下发：记下 pendingFocus，等切片到达后重试。
   */
  function focusEntity(kind, id, keepTab) {
    if (model === null || kind === null) return false;
    if (!keepTab) setTab("flow");

    if (kind === "module") {
      if (!state.showEmptyModules) {
        state.showEmptyModules = true;
        dom.showEmpty.checked = true;
      }
      if (cascade !== null && cascade.grouping.enabled) {
        // 分组树里模块是扁平叶子：展开它要清掉它所有出现位置的桶/模块/分组键。
        var groupKeys = cascade.uncollapseByModule.get(id);
        if (groupKeys !== undefined) {
          groupKeys.forEach(function (key) { state.collapsed.delete(key); });
        }
      } else {
        D.moduleChain(model, id).forEach(function (moduleId) {
          state.collapsed.delete("m|" + moduleId);
        });
      }
      if (state.sliced) requestModule(id);
      if (state.filter.length > 0) {
        state.filter = "";
        state.filterHits = null;
        dom.filter.value = "";
      }
      rebuild();
      // 分组模式下模块行键是“出现路径”，普通模式是 m|<id>。
      var moduleKey = cascade.moduleRowKey.get(id);
      if (moduleKey === undefined) moduleKey = "m|" + id;
      state.selectedRowKey = moduleKey;
      cascadeView.setSelected(moduleKey);
      var foundModule = cascadeView.scrollToKey(moduleKey);
      showModuleInfo(dom.treeInfo, id);
      if (!foundModule) {
        setStatus("模块行当前不可见（可能被排除），已在信息区显示：" + id);
      }
      save();
      return foundModule;
    }

    if (kind === "func" && cascade !== null) {
      // 函数作为子模块出现在树里时，优先定位函数行本身；只有该函数没有
      // 专属端口（或旧程序集没有函数层）时才退回“第一个关联端口行”。
      var fm = D.getIndex(model).funcModule.get(id);
      if (cascade.grouping.enabled && fm !== undefined && fm !== null) {
        var functionGroupKeys = cascade.uncollapseByModule.get(fm);
        if (functionGroupKeys !== undefined) {
          functionGroupKeys.forEach(function (key) { state.collapsed.delete(key); });
        }
      } else if (fm !== undefined && fm !== null) {
        D.moduleChain(model, fm).forEach(function (moduleId) {
          state.collapsed.delete("m|" + moduleId);
        });
      }
      if (state.filter.length > 0) {
        state.filter = "";
        state.filterHits = null;
        dom.filter.value = "";
      }
      rebuild();
      var functionRowKey = cascade.funcRowKey.get(id);
      if (functionRowKey !== undefined) {
        state.selectedRowKey = functionRowKey;
        cascadeView.setSelected(functionRowKey);
        var foundFunction = cascadeView.scrollToKey(functionRowKey);
        showFuncInfo(dom.treeInfo, id);
        if (!foundFunction) {
          setStatus("函数行当前不可见（可能被排除），已在信息区显示：" + id);
        }
        save();
        return foundFunction;
      }
    }

    var ports = D.portsForEntity(model, kind, id, selectionFlags());
    if (ports.length === 0) {
      var selectKey = kind + ":" + id;
      if (state.sliced && !state.selectRequested.has(selectKey)) {
        pendingFocus = { kind: kind, id: id };
        requestSelect(kind, id);
        setStatus("正在补充 " + kind + ":" + id + " 的关联切片…");
        save();
        return false;
      }
      if (kind === "signal") showSignalInfo(dom.treeInfo, id);
      else if (kind === "func") showFuncInfo(dom.treeInfo, id);
      else if (kind === "type") showTypeInfo(dom.treeInfo, id);
      setStatus("该 " + kind + " 没有可展示的端口行：" + id);
      save();
      return false;
    }

    var port = ports[0];
    var ok = selectPortKey(port.key, false);
    if (!ok) {
      setStatus("没有在模块树里找到端口行：" + port.key);
      save();
      return false;
    }
    if (kind === "signal") showSignalInfo(dom.treeInfo, id);
    else if (kind === "func") showFuncInfo(dom.treeInfo, id);
    else if (kind === "type") showTypeInfo(dom.treeInfo, id);
    save();
    return true;
  }

  function inferEntity(subject) {
    if (typeof subject !== "string" || subject.length === 0) return null;
    var ix = D.getIndex(model);
    if (ix.signalById.has(subject)) return { kind: "signal", id: subject };
    if (ix.funcById.has(subject)) return { kind: "func", id: subject };
    if (ix.typeById.has(subject)) return { kind: "type", id: subject };
    if (ix.moduleById.has(subject)) return { kind: "module", id: subject };

    var tables = [
      { kind: "signal", list: model.signals },
      { kind: "func", list: model.funcs },
      { kind: "type", list: model.types },
      { kind: "module", list: model.modules },
    ];
    for (var i = 0; i < tables.length; i += 1) {
      var list = tables[i].list;
      for (var j = 0; j < list.length; j += 1) {
        if (list[j].path === subject || list[j].name === subject) {
          return { kind: tables[i].kind, id: list[j].id };
        }
      }
    }
    return null;
  }

  function jumpToSubject(subject) {
    var target = inferEntity(subject);
    if (target === null) {
      setStatus("无法定位诊断对象：" + subject);
      return;
    }
    requestSelect(target.kind, target.id);
    var ports = D.portsForEntity(model, target.kind, target.id, selectionFlags());
    if (ports.length > 0) {
      var first = ports[0];
      if (!state.checked.has(first.key)) {
        var next = new Set(state.checked);
        next.add(first.key);
        state.checked = next;
      }
    }
    focusEntity(target.kind, target.id, false);
  }

  // ── 概览 ───────────────────────────────────────────────────────────────

  function renderOverview() {
    if (model === null) return;
    var data = D.overview(model);
    var pane = dom.panes.overview;
    clear(pane);

    var info = data.info;
    var infoCard = el("div", "card");
    infoCard.appendChild(el("div", "card-title", "程序集信息"));
    infoCard.appendChild(
      infoTable([
        ["路径", info.path],
        ["格式", info.format],
        ["架构", info.arch],
        ["种类", info.kind],
        ["版本", info.version],
        ["文件版本", info.fileVersion],
        ["产品版本", info.productVersion],
        ["目标框架", info.targetFramework],
        ["区域", info.culture],
        ["元数据", info.hasMetadata ? "有（版本 " + info.metadataVersion + "）" : "无"],
        ["入口", info.entryPoint],
        ["构建 ID", info.buildId],
        ["文件大小", formatFileSize(info.fileSize)],
      ]),
    );
    pane.appendChild(infoCard);

    var counts = data.counts;
    if (state.sliced && state.totals !== null) {
      counts = {
        modules: state.totals.modules,
        types: state.totals.types,
        signals: state.totals.signals,
        funcs: state.totals.funcs,
        edges: state.totals.edges,
        storeTypes: state.totals.storeTypes,
        diagnostics: data.counts.diagnostics,
      };
    }
    var grid = el("div", "count-grid");
    [
      ["模块", counts.modules],
      ["类型", counts.types],
      ["信号", counts.signals],
      ["函数", counts.funcs],
      ["边", counts.edges],
      ["Store 类型", counts.storeTypes],
      ["诊断", counts.diagnostics],
    ].forEach(function (pair) {
      var cell = el("div", "count-cell");
      cell.appendChild(el("div", "count-number", String(pair[1])));
      cell.appendChild(el("div", "count-label", pair[0]));
      grid.appendChild(cell);
    });
    pane.appendChild(grid);

    var diagCard = el("div", "card");
    diagCard.appendChild(el("div", "card-title", "诊断", String(counts.diagnostics)));
    if (data.diagnostics.length === 0) {
      diagCard.appendChild(el("div", "empty-hint", "没有诊断信息。"));
    } else {
      data.diagnostics.forEach(function (diag) {
        var row = el("div", "diag diag-" + diag.severity);
        row.appendChild(el("span", "diag-severity", diag.severity));
        row.appendChild(el("span", "diag-code", diag.code));
        row.appendChild(el("span", "diag-message", diag.message));
        if (diag.subject) {
          var jump = el("button", "diag-subject", diag.subject);
          jump.addEventListener("click", function () {
            jumpToSubject(diag.subject);
          });
          row.appendChild(jump);
        }
        diagCard.appendChild(row);
      });
    }
    pane.appendChild(diagCard);
  }

  // ── 持久化数据（ER） ───────────────────────────────────────────────────

  function highlightErField(type, field) {
    lastTreeInfo = null;
    lastGroupInfo = null;
    var refs = D.erFieldRefs(model, type.id, field.name);
    clear(dom.treeInfo);
    dom.treeInfo.appendChild(el("div", "info-title", type.name + " · " + field.name));
    dom.treeInfo.appendChild(
      infoTable([
        ["类型", field.ctype],
        ["偏移", typeof field.offset === "number" && field.offset >= 0 ? String(field.offset) : "—"],
        ["大小", typeof field.size === "number" && field.size >= 0 ? String(field.size) : "—"],
        ["标签", (field.tags || []).join(", ")],
      ]),
    );

    if (refs.length === 0) {
      var typeSelectKey = "type:" + type.id;
      if (state.sliced && !state.selectRequested.has(typeSelectKey)) {
        requestSelect("type", type.id);
        dom.treeInfo.appendChild(
          el(
            "div",
            "info-section",
            "切片尚未包含该类型的字段信号，正在补充；稍后再次点击字段即可看到读写函数。",
          ),
        );
      } else {
        dom.treeInfo.appendChild(
          el(
            "div",
            "info-section",
            "没有字段信号映射：该字段只在结构布局里出现，读取器没有为它建模读写边。" +
              "C 源码可用 DC_FIELD 描述布局、DC_SIGNAL 描述数据流；两者不是同一条记录。",
          ),
        );
      }
      return;
    }

    var portKeys = [];
    refs.forEach(function (ref) {
      D.portsForEntity(model, "signal", ref.signal.id, selectionFlags()).forEach(function (port) {
        if (portKeys.indexOf(port.key) < 0) portKeys.push(port.key);
      });
    });
    var outputs = portKeys.filter(function (key) {
      var parsed = D.parsePortKey(key);
      return parsed !== null && parsed.dir === "out";
    });
    var chosen = outputs.length > 0 ? outputs : portKeys;
    state.checked = new Set(chosen);
    setTab("flow");
    if (chosen.length > 0) {
      preparePortVisibility(chosen[0]);
      rebuild();
      // 分组模式下端口行键带出现路径，必须在 rebuild 之后用映射取。
      var erRowKey = cascade.portRowKey.get(chosen[0]);
      state.selectedRowKey = erRowKey === undefined ? null : erRowKey;
      if (erRowKey !== undefined) cascadeView.setSelected(erRowKey);
      requestAnimationFrame(function () {
        if (erRowKey !== undefined) cascadeView.scrollToKey(erRowKey);
        groupView.reveal(chosen[0]);
      });
    } else {
      rebuild();
    }

    refs.forEach(function (ref) {
      dom.treeInfo.appendChild(
        el("div", "info-section", "信号 " + D.signalLabel(ref.signal) + "（" + ref.signal.ctype + "）"),
      );
      if (!refList(dom.treeInfo, "写入函数", ref.writers, "func") &&
          !refList(dom.treeInfo, "读取函数", ref.readers, "func")) {
        dom.treeInfo.appendChild(
          el("div", "info-section", "该信号没有记录读写函数（可能只被外部符号访问）。"),
        );
      }
    });
    save();
  }

  function renderEr() {
    if (model === null) return;
    var stores = D.buildEr(model);
    var pane = dom.panes.er;
    clear(pane);
    if (stores.length === 0) {
      pane.appendChild(
        el(
          "div",
          "empty-hint",
          "没有标记 Store 的类型。Store 来自源码元数据（类型上的 Store 标记），不是数据库反射。",
        ),
      );
      return;
    }

    stores.forEach(function (type) {
      var card = el("div", "card");
      var title = el("div", "card-title");
      var nameButton = el("button", "type-link", type.name);
      nameButton.addEventListener("click", function () {
        focusEntity("type", type.id, false);
      });
      title.appendChild(nameButton);
      title.appendChild(el("span", "card-sub", type.path + " · " + fmtBytes(type.size)));
      if (type.tags.length > 0) title.appendChild(el("span", "card-sub", type.tags.join(", ")));
      card.appendChild(title);

      var table = el("table", "er-table");
      var head = el("tr");
      ["字段", "类型", "偏移", "大小", "标签", "关联结构"].forEach(function (text) {
        head.appendChild(el("th", null, text));
      });
      table.appendChild(head);

      // 未知偏移（-1）排在已知偏移之后，不要因为负数跑到第一行。
      var offsetRank = function (f) {
        return typeof f.offset === "number" && f.offset >= 0 ? f.offset : Number.MAX_SAFE_INTEGER;
      };
      type.fields.slice().sort(function (a, b) { return offsetRank(a) - offsetRank(b); }).forEach(function (field) {
        var row = el("tr");
        var nameCell = el("td");
        var nameButton = el("button", "field-link", field.name);
        nameButton.title = "查看读写该字段的函数";
        nameButton.addEventListener("click", function () {
          highlightErField(type, field);
        });
        nameCell.appendChild(nameButton);
        row.appendChild(nameCell);
        row.appendChild(el("td", null, field.ctype));
        var hasOffset = typeof field.offset === "number" && field.offset >= 0;
        var hasSize = typeof field.size === "number" && field.size >= 0;
        row.appendChild(el("td", null, hasOffset ? String(field.offset) : "—"));
        row.appendChild(el("td", null, hasSize ? String(field.size) : "—"));
        row.appendChild(el("td", null, field.tags.join(", ")));
        var targetCell = el("td");
        if (field.target) {
          var link = el("button", "type-link", field.target.name + (field.target.store ? " · Store" : ""));
          link.addEventListener("click", function () {
            focusEntity("type", field.target.id, false);
          });
          targetCell.appendChild(link);
        }
        row.appendChild(targetCell);
        table.appendChild(row);
      });
      card.appendChild(table);
      pane.appendChild(card);
    });
  }

  // ── 属性筛选（第 8 条） ────────────────────────────────────────────────

  /**
   * 把 `[Device]` / `[Drawcode]` 等特性值做成筛选下拉框。
   *
   * 选项按“分类”分组：`Device.Model`、`Drawcode.Store`、业务标签 `语义` 各成一组。
   * 选中的是**完整标签**（`Device.Model=示例型号`），这样 `hitSets` 只需
   * 做一次数组包含判断，不必再猜冒号/等号哪边是键。
   *
   * 每次重建都对比签名：属性集合没变就不动 DOM，避免切片消息成批到达时
   * 每个消息都重建一次下拉框，把用户正在展开的菜单关掉。
   */
  function renderFacetOptions() {
    var groups = D.facetGroups(model);
    var signature = groups.map(function (group) {
      return group.name + ":" + group.values.map(function (value) { return value.tag; }).join("|");
    }).join(";");
    if (signature === facetSignature) {
      dom.facet.value = state.facet;
      return;
    }
    facetSignature = signature;

    clear(dom.facet);
    var all = document.createElement("option");
    all.value = "";
    all.textContent = groups.length === 0 ? "无属性筛选" : "全部属性";
    dom.facet.appendChild(all);

    groups.forEach(function (group) {
      var optgroup = document.createElement("optgroup");
      optgroup.label = group.name;
      group.values.forEach(function (value) {
        var option = document.createElement("option");
        option.value = value.tag;
        option.textContent = value.value + "（" + value.count + "）";
        optgroup.appendChild(option);
      });
      dom.facet.appendChild(optgroup);
    });

    // 恢复的筛选值可能已经不在新模型里：回到“全部属性”，不留一个不存在的选项。
    var exists = Array.prototype.some.call(dom.facet.options, function (option) {
      return option.value === state.facet;
    });
    if (!exists) state.facet = "";
    dom.facet.value = state.facet;
  }

  // ── 分组模式与配置持久化 ───────────────────────────────────────────────

  function shortPath(text) {
    var parts = String(text || "").split(/[\\/]/);
    return parts[parts.length - 1] || String(text || "");
  }

  /**
   * 应用宿主下发的分组配置。
   *
   * 首次 init 决定“打开时用哪套层级”：
   *   1. 会话里正在用的别名（同一面板刷新）；
   *   2. 配置里的默认别名（用户设过默认）；
   *   3. 配置里上次的 levels；
   *   4. 都没有就保持空树。
   * 之后的 init 只更新配置镜像：刷新不该把用户刚改的层级回滚成磁盘旧值。
   */
  function applyGroupingMessage(grouping) {
    var info = grouping || {};
    var config = D.sanitizeGroupingConfig(info.config);
    state.groupConfig = {
      version: config.version,
      levels: config.levels,
      active: config.active,
      defaultPreset: config.defaultPreset,
      presets: config.presets,
    };
    state.groupConfigPath = typeof info.path === "string" ? info.path : "";
    state.groupConfigWarning = typeof info.warning === "string" ? info.warning : "";
    state.groupIssues = config.issues || [];

    if (!groupInitApplied) {
      groupInitApplied = true;
      var resolution = D.resolveGroupLevels(state.groupConfig, state.groupActive);
      if (resolution.alias !== null) {
        state.groupActive = resolution.alias;
        state.groupLevels = resolution.levels.slice();
      } else if (state.groupConfig.levels.length > 0 || state.groupConfig.presets.length > 0) {
        // 没选中别名时，用配置里上次的层级；presets 非空但 levels 为空是
        // “用户清空了层级但保留配置”，这时就该是普通树。
        state.groupActive = null;
        state.groupLevels = state.groupConfig.levels.slice();
      }
      state.groupEnabled = state.groupLevels.length > 0;
      if (state.groupEnabled) state.groupConfig.levels = state.groupLevels.slice();
    } else if (state.groupActive !== null &&
               D.findGroupPreset(state.groupConfig, state.groupActive) === null) {
      // 磁盘上的预设被外部删掉了：别名降级，层级保留。
      state.groupActive = null;
    }
    dom.groupAlias.value = state.groupActive || "";
    renderGroupBar();
  }

  /**
   * 把当前层级同步进配置对象。
   *
   * 选中别名时同时更新该别名的 levels——否则用户加了层、别名还指向旧层级，
   * 下次选这个别名会悄悄回滚。这是“别名 = 当前配置快照”的语义。
   */
  function groupingSnapshot() {
    var presets = state.groupConfig.presets.map(function (preset) {
      return { alias: preset.alias, levels: preset.levels.slice() };
    });
    if (state.groupActive !== null) {
      var found = false;
      presets.forEach(function (preset) {
        if (preset.alias !== state.groupActive) return;
        preset.levels = state.groupLevels.slice();
        found = true;
      });
      if (!found) state.groupActive = null;
    }
    state.groupConfig = {
      version: D.GROUP_CONFIG_VERSION,
      levels: state.groupLevels.slice(),
      active: state.groupActive,
      defaultPreset: state.groupConfig.defaultPreset,
      presets: presets,
    };
    return state.groupConfig;
  }

  function persistGrouping() {
    var config = groupingSnapshot();
    vscode.postMessage({
      type: "saveGrouping",
      config: {
        version: config.version,
        levels: config.levels.slice(),
        active: config.active,
        defaultPreset: config.defaultPreset,
        presets: config.presets.map(function (preset) {
          return { alias: preset.alias, levels: preset.levels.slice() };
        }),
      },
    });
  }

  /** 层级变化后的统一收尾：重算树 → 存视图状态 → 写磁盘。 */
  function applyGroupingChange() {
    state.groupIssues = [];
    groupingSnapshot();
    rebuild();
    save();
    persistGrouping();
  }

  function renderGroupBar() {
    if (dom.groupToggle === null) return;

    // ── 工具栏两态 ──
    // 收纳态只保留一行关键操作；分组条也属于“高级区域”，一并收起。
    // 分组本身的记忆（groupEnabled / levels）不受形态影响。
    if (dom.toolbarAdvanced !== null) dom.toolbarAdvanced.hidden = !state.toolbarExpanded;
    if (dom.toolbarToggle !== null) {
      dom.toolbarToggle.textContent = state.toolbarExpanded ? "收起筛选 ▴" : "筛选与分组 ▾";
      dom.toolbarToggle.title = state.toolbarExpanded
        ? "收起高级筛选与批量操作"
        : "展开筛选与分组的高级选项";
      dom.toolbarToggle.setAttribute("aria-expanded", state.toolbarExpanded ? "true" : "false");
      dom.toolbarToggle.classList.toggle("is-active", state.toolbarExpanded);
    }
    if (dom.toolbarSummary !== null) {
      var summary = state.groupEnabled && state.groupLevels.length > 0
        ? "分组：" + state.groupLevels.join(" → ")
        : "";
      dom.toolbarSummary.textContent = summary;
      // 展开态能看到分组条本身，摘要只在收纳态出现，避免重复。
      dom.toolbarSummary.hidden = state.toolbarExpanded || summary === "";
    }

    dom.groupToggle.classList.toggle("is-active", state.groupEnabled);
    dom.groupToggle.textContent = state.groupEnabled ? "分组模式：开" : "分组模式";
    dom.groupbar.hidden = !state.groupEnabled || !state.toolbarExpanded;
    if (!state.groupEnabled) return;

    // ── 层级 chips ──
    clear(dom.groupLevels);
    if (state.groupLevels.length === 0) {
      dom.groupLevels.appendChild(
        el("span", "groupbar-hint", "还没有层级；选择属性后点「加一层」。"),
      );
    } else {
      state.groupLevels.forEach(function (name, index) {
        var chip = el("span", "group-level-chip");
        chip.appendChild(el("span", "group-level-order", String(index + 1)));
        chip.appendChild(el("span", null, name));
        var remove = el("button", "group-level-remove", "×");
        remove.type = "button";
        remove.title = "移除第 " + (index + 1) + " 层（" + name + "）";
        remove.addEventListener("click", function () { removeGroupLevel(index); });
        chip.appendChild(remove);
        dom.groupLevels.appendChild(chip);
      });
    }

    // ── 可添加的属性 ──
    var facetNames = model === null ? [] : D.facetGroups(model).map(function (group) {
      return group.name;
    });
    var previous = dom.groupAddLevel.value;
    clear(dom.groupAddLevel);
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = facetNames.length === 0 ? "当前程序集没有属性" : "选择属性…";
    dom.groupAddLevel.appendChild(placeholder);
    facetNames.forEach(function (name) {
      var used = state.groupLevels.indexOf(name) >= 0;
      var option = document.createElement("option");
      option.value = name;
      option.textContent = name + (used ? "（已用）" : "");
      option.disabled = used;
      dom.groupAddLevel.appendChild(option);
    });
    if (facetNames.indexOf(previous) >= 0 && state.groupLevels.indexOf(previous) < 0) {
      dom.groupAddLevel.value = previous;
    }
    dom.groupAdd.disabled = state.groupLevels.length >= D.GROUP_MAX_LEVELS;

    // ── 已保存配置 ──
    clear(dom.groupPreset);
    var custom = document.createElement("option");
    custom.value = "";
    custom.textContent = "自定义（未保存）";
    dom.groupPreset.appendChild(custom);
    state.groupConfig.presets.forEach(function (preset) {
      var option = document.createElement("option");
      option.value = preset.alias;
      option.textContent = preset.alias +
        (preset.alias === state.groupConfig.defaultPreset ? "（默认）" : "");
      dom.groupPreset.appendChild(option);
    });
    dom.groupPreset.value = state.groupActive === null ? "" : state.groupActive;
    if (dom.groupPreset.value !== (state.groupActive || "")) dom.groupPreset.value = "";

    // 正在输入的别名不能被切片到达触发的 rebuild 覆盖。
    if (document.activeElement !== dom.groupAlias) {
      dom.groupAlias.value = state.groupActive || "";
    }
    dom.groupDefault.disabled = state.groupActive === null;
    dom.groupDelete.disabled = state.groupActive === null;

    // ── 提示：坏配置 / 失效属性 / 截断 / 落盘位置 ──
    var issues = [];
    if (state.groupConfigWarning) issues.push(state.groupConfigWarning);
    (state.groupIssues || []).forEach(function (issue) { issues.push(issue); });
    if (cascade !== null && cascade.grouping.enabled) {
      var missing = cascade.grouping.missingLevels;
      if (missing.length > 0) {
        issues.push("当前程序集没有属性：" + missing.join("、") + "（这些层的模块会落到「（未标注）」）");
      }
      if (cascade.grouping.truncated) {
        issues.push("分组路径或模块出现次数过多，已截断部分内容");
      }
    }
    var summary = state.groupLevels.length > 0
      ? "层级：" + state.groupLevels.join(" → ")
      : "尚未添加层级";
    var location = state.groupConfigPath.length > 0
      ? "配置：" + shortPath(state.groupConfigPath)
      : "配置不写入磁盘";
    dom.groupHint.textContent = issues.concat([summary, location]).join("  ·  ");
    dom.groupHint.classList.toggle("is-warning", issues.length > 0);
  }

  function removeGroupLevel(index) {
    state.groupLevels = state.groupLevels.filter(function (_, i) { return i !== index; });
    state.groupEnabled = true;
    applyGroupingChange();
  }

  if (dom.toolbarToggle !== null) {
    dom.toolbarToggle.addEventListener("click", function () {
      state.toolbarExpanded = !state.toolbarExpanded;
      // 形态是纯显示状态，不需要重建整棵树；只重绘工具栏与分组条。
      renderGroupBar();
      save();
    });
  }

  dom.groupToggle.addEventListener("click", function () {
    state.groupEnabled = !state.groupEnabled;
    if (state.groupEnabled && state.groupLevels.length === 0) {
      setStatus("分组模式已打开；先选择一个属性作为第一层分组。");
    }
    rebuild();
    save();
  });

  dom.groupAdd.addEventListener("click", function () {
    var name = dom.groupAddLevel.value;
    if (name === "") {
      setStatus("先在「选择属性」里选一个属性。");
      return;
    }
    if (state.groupLevels.indexOf(name) >= 0) return;
    if (state.groupLevels.length >= D.GROUP_MAX_LEVELS) {
      setStatus("最多 " + D.GROUP_MAX_LEVELS + " 层分组。");
      return;
    }
    state.groupLevels = state.groupLevels.concat([name]);
    state.groupEnabled = true;
    applyGroupingChange();
  });

  dom.groupPreset.addEventListener("change", function () {
    var alias = dom.groupPreset.value;
    if (alias === "") {
      // “自定义”：保留当前层级，只解除与别名的绑定。
      state.groupActive = null;
      applyGroupingChange();
      return;
    }
    var preset = D.findGroupPreset(state.groupConfig, alias);
    if (preset === null) {
      setStatus("这个分组配置已经不存在：" + alias);
      renderGroupBar();
      return;
    }
    state.groupActive = preset.alias;
    state.groupLevels = preset.levels.slice();
    state.groupEnabled = state.groupLevels.length > 0;
    applyGroupingChange();
  });

  dom.groupSave.addEventListener("click", function () {
    var alias = dom.groupAlias.value.trim();
    if (alias === "") alias = state.groupActive || "";
    if (alias === "") {
      setStatus("先输入配置别名，再保存。");
      dom.groupAlias.focus();
      return;
    }
    if (alias.length > D.GROUP_ALIAS_MAX) {
      setStatus("别名最多 " + D.GROUP_ALIAS_MAX + " 个字符。");
      return;
    }
    var exists = D.findGroupPreset(state.groupConfig, alias) !== null;
    if (!exists && state.groupConfig.presets.length >= D.GROUP_MAX_PRESETS) {
      setStatus("最多保存 " + D.GROUP_MAX_PRESETS + " 个配置；请先删除不用的。");
      return;
    }
    var presets = state.groupConfig.presets.filter(function (preset) {
      return preset.alias !== alias;
    });
    presets.push({ alias: alias, levels: state.groupLevels.slice() });
    state.groupConfig.presets = presets;
    state.groupActive = alias;
    applyGroupingChange();
    setStatus("已保存分组配置：" + alias);
  });

  dom.groupDefault.addEventListener("click", function () {
    if (state.groupActive === null) {
      setStatus("先把当前层级保存为别名，再设为默认。");
      return;
    }
    state.groupConfig.defaultPreset = state.groupActive;
    applyGroupingChange();
    setStatus("已设为默认配置：" + state.groupActive);
  });

  dom.groupDelete.addEventListener("click", function () {
    if (state.groupActive === null) {
      setStatus("当前没有选中的配置别名。");
      return;
    }
    var alias = state.groupActive;
    state.groupConfig.presets = state.groupConfig.presets.filter(function (preset) {
      return preset.alias !== alias;
    });
    if (state.groupConfig.defaultPreset === alias) {
      state.groupConfig.defaultPreset = null;
    }
    state.groupActive = null;
    applyGroupingChange();
    setStatus("已删除分组配置：" + alias);
  });

  // ── 状态栏 / 标签页 ────────────────────────────────────────────────────

  function setStatus(text) {
    dom.status.textContent = text;
  }

  function renderStatus() {
    if (model === null) {
      setStatus("等待解析…");
      return;
    }
    var totals = state.sliced && state.totals !== null
      ? state.totals
      : {
          modules: model.modules.length,
          types: model.types.length,
          signals: model.signals.length,
          funcs: model.funcs.length,
          edges: model.edges.length,
        };
    var parts = [
      "模块 " + totals.modules,
      "类型 " + totals.types,
      "信号 " + totals.signals,
      "函数 " + totals.funcs,
      "边 " + totals.edges,
    ];
    if (state.sliced) {
      parts.push("切片：已加载 " + state.loadedModules.size + "/" + model.modules.length + " 模块");
    }
    var portSelected = 0;
    var fieldSelected = 0;
    state.checked.forEach(function (key) {
      if (key.indexOf("sf|") === 0) fieldSelected += 1;
      else portSelected += 1;
    });
    if (portSelected + fieldSelected > 0) {
      parts.push("已选 端口 " + portSelected + " · 字段 " + fieldSelected);
    }
    if (flow !== null) {
      // 同信号关联不是数据流，分开计数，避免“连线 N 条”被误读成 N 条方向性流。
      var shared = flow.sharedCount || 0;
      parts.push("连线 " + (flow.edges.length - shared) + " 条");
      if (shared > 0) parts.push("同信号 " + shared + " 段");
    }
    if (cascade !== null) {
      parts.push("端口 " + cascade.portCount + " · 树行 " + cascade.rowCount +
        " · groupbox " + cascade.groups.length);
      if (cascade.grouping.enabled) {
        parts.push("分组 " + cascade.grouping.levels.join(" → "));
      }
    }
    if (state.filter.length > 0 && state.filterTruncated) parts.push("过滤结果已截断");
    setStatus(parts.join("  ·  "));
  }

  function setTab(name) {
    state.tab = name;
    dom.tabs.forEach(function (tab) {
      tab.classList.toggle("is-active", tab.dataset.tab === name);
    });
    Object.keys(dom.panes).forEach(function (key) {
      dom.panes[key].hidden = key !== name;
    });
    if (name === "flow") {
      // 三列都只在可见时有尺寸；切回来重排一次，虚拟化窗口才是正确的。
      requestAnimationFrame(function () {
        applyLayout();
        cascadeView.relayout();
        renderFlow();
      });
    }
    save();
  }

  // ── 工具栏 ─────────────────────────────────────────────────────────────

  var filterTimer = null;
  dom.filter.addEventListener("input", function () {
    if (filterTimer !== null) clearTimeout(filterTimer);
    filterTimer = setTimeout(function () {
      var next = dom.filter.value.trim();
      state.filter = next;
      state.filterHits = null;
      state.filterTruncated = false;
      // 属性筛选在本地算：宿主的 filter 协议只有 query，没有 facet。
      // 启用属性筛选时改走本地命中集合，宁可漏掉未加载切片，也不假装筛过。
      if (state.sliced && next.length > 0 && state.facet.length === 0) {
        vscode.postMessage({ type: "filter", query: next });
      }
      scheduleRebuild();
      save();
    }, 150);
  });

  dom.facet.addEventListener("change", function () {
    state.facet = dom.facet.value;
    state.filterHits = null;
    state.filterTruncated = false;
    if (state.sliced && state.filter.length > 0 && state.facet.length === 0) {
      vscode.postMessage({ type: "filter", query: state.filter });
    }
    rebuild();
    save();
  });

  dom.showEmpty.addEventListener("change", function () {
    state.showEmptyModules = dom.showEmpty.checked;
    rebuild();
    save();
  });

  dom.showExcluded.addEventListener("change", function () {
    state.showExcluded = dom.showExcluded.checked;
    prefetchModules();
    rebuild();
    save();
  });

  dom.showCompiler.addEventListener("change", function () {
    state.showCompilerGenerated = dom.showCompiler.checked;
    rebuild();
    save();
  });

  dom.collapseAll.addEventListener("click", function () {
    if (cascade === null) return;
    var grouping = cascade.grouping.enabled;
    var collapsed = new Set();
    cascade.rows.forEach(function (row) {
      // 普通树只收模块；分组树还要收桶与 I/O 分组，否则“全收起”后
      // 仍会看到一堆端口行挂在顶层桶下面。
      if (row.kind === "module" ||
          (grouping && (row.kind === "bucket" || row.kind === "group"))) {
        collapsed.add(row.key);
      }
    });
    state.collapsed = collapsed;
    rebuild();
    save();
  });

  dom.expandAll.addEventListener("click", function () {
    state.collapsed = new Set();
    prefetchModules();
    rebuild();
    save();
  });

  dom.tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      setTab(tab.dataset.tab);
    });
  });

  dom.refresh.addEventListener("click", function () {
    vscode.postMessage({ type: "reload" });
  });

  if (dom.exportDrawio !== null) {
    dom.exportDrawio.addEventListener("click", exportDrawio);
  }

  dom.openDefault.addEventListener("click", function () {
    vscode.postMessage({ type: "openDefault" });
  });

  window.addEventListener("resize", function () {
    requestAnimationFrame(function () {
      if (state.tab !== "flow") return;
      cascadeView.relayout();
      renderFlow();
    });
  });

  // ── 宿主消息 ───────────────────────────────────────────────────────────

  var overlay = el("div", "error-overlay");
  overlay.hidden = true;
  document.body.appendChild(overlay);

  function hideOverlay() {
    overlay.hidden = true;
    clear(overlay);
  }

  function showError(message) {
    clear(overlay);
    overlay.hidden = false;

    var card = el("div", "error-card");
    card.appendChild(el("div", "error-title", message.message || "解析失败"));

    if (message.kind === "tooLarge") {
      card.appendChild(
        el(
          "div",
          "info-section",
          "程序集超过设置的大小上限。可以在设置中调大 drawcode.maxSizeMB，或只解析这一次。",
        ),
      );
    } else if (message.kind === "coreMissing") {
      card.appendChild(
        el(
          "div",
          "info-section",
          "扩展自带的解析核心不完整。请重新安装 Drawcode Artifact Viewer；安装包已包含解析核心与 .NET sidecar。",
        ),
      );
    } else if (message.kind === "inspect") {
      card.appendChild(
        el(
          "div",
          "info-section",
          "解析失败。常见原因：程序集格式不受支持、.NET 8 未安装（PE 元数据 sidecar 需要）、程序集被占用或没有读取权限。",
        ),
      );
    }

    if (message.detail) {
      card.appendChild(el("div", "error-detail", message.detail));
    }

    var actions = el("div", "error-actions");
    if (message.kind === "tooLarge") {
      var force = el("button", "ghost-button", "仍要解析");
      force.addEventListener("click", function () {
        vscode.postMessage({ type: "forceLoad" });
      });
      actions.appendChild(force);
    }
    var fallback = el("button", "ghost-button", "以默认编辑器打开");
    fallback.addEventListener("click", function () {
      vscode.postMessage({ type: "openDefault" });
    });
    actions.appendChild(fallback);
    card.appendChild(actions);

    overlay.appendChild(card);
  }

  window.addEventListener("message", function (event) {
    var message = event.data || {};
    switch (message.type) {
      case "loading":
        hideOverlay();
        setStatus("解析中…");
        break;
      case "init":
        model = message.model;
        // 普通程序集没有 [Drawcode] 标注时，模块里往往只有类型/函数而没有端口；
        // 默认打开“显示空模块”，否则用户看到的是一棵空树。用户手动关掉后
        // saved.showEmptyModules 有值，这里就不再覆盖。
        if (saved.showEmptyModules === undefined && model.info && model.info.hasMetadata !== true) {
          state.showEmptyModules = true;
        }
        state.sliced = message.sliced === true;
        state.totals = message.totals || null;
        state.hasOrphans = message.hasOrphans === true;
        state.loadedModules = new Set(
          Array.isArray(message.loadedModules) ? message.loadedModules : [],
        );
        state.pendingModules = new Set();
        state.selectRequested = new Set();
        state.filterHits = null;
        state.filterTruncated = false;
        state.loadedIds = {
          signals: new Set(model.signals.map(function (s) { return s.id; })),
          funcs: new Set(model.funcs.map(function (f) { return f.id; })),
          types: new Set(model.types.map(function (t) { return t.id; })),
        };
        pendingFocus = null;
        facetSignature = "";
        hideOverlay();
        if (!state.configured) {
          state.showExcluded = (message.config || {}).showExcluded === true;
          state.showCompilerGenerated = (message.config || {}).showCompilerGenerated === true;
          state.configured = true;
        }
        dom.showEmpty.checked = state.showEmptyModules;
        dom.showExcluded.checked = state.showExcluded;
        dom.showCompiler.checked = state.showCompilerGenerated;
        dom.filter.value = state.filter;
        // 配置先应用：rebuild 需要 groupLevels 已经就位，否则第一帧是普通树。
        applyGroupingMessage(message.grouping);
        applyLayout();
        dom.title.textContent = message.model.info && message.model.info.path
          ? message.model.info.path.split(/[\\/]/).pop()
          : "程序集";
        dom.subtitle.textContent = [
          message.model.info && message.model.info.format,
          message.model.info && message.model.info.arch,
          message.model.info && message.model.info.kind,
        ].filter(Boolean).join(" · ");

        prefetchModules();
        rebuild();
        renderOverview();
        renderEr();
        setTab(state.tab);
        save();
        // 还原的过滤词在切片模式下要重新问宿主；本地只搜得到已加载的切片。
        if (state.sliced && state.filter.length > 0 && state.facet.length === 0) {
          vscode.postMessage({ type: "filter", query: state.filter });
        }
        var ackTotals = state.totals;
        if (ackTotals === null) {
          ackTotals = {
            modules: model.modules.length,
            types: model.types.length,
            signals: model.signals.length,
            funcs: model.funcs.length,
            edges: model.edges.length,
            storeTypes: model.types.filter(function (t) { return t.store === true; }).length,
          };
        }
        vscode.postMessage({
          type: "initAck",
          modules: model.modules.length,
          sliced: state.sliced,
          totals: ackTotals,
        });
        break;
      case "slice":
        mergeSlice(message);
        scheduleRebuild(function () {
          reloadInfo();
          if (pendingFocus !== null) {
            var target = pendingFocus;
            if (entityExists(target.kind, target.id)) {
              pendingFocus = null;
              focusEntity(target.kind, target.id, true);
            }
          }
        });
        break;
      case "filterResult":
        if (message.query !== state.filter) break;
        state.filterHits = message.hits || { modules: [], signals: [], funcs: [], types: [] };
        state.filterTruncated = message.truncated === true;
        mergeSlice(message);
        scheduleRebuild();
        break;
      case "groupingSaved":
        // 宿主写盘的结果：成功就清掉读/写警告；失败把原因留在分组条上，
        // 当前会话的分组仍然可用（内存里的配置不因落盘失败而丢）。
        if (typeof message.path === "string" && message.path.length > 0) {
          state.groupConfigPath = message.path;
        }
        if (message.ok === true) {
          state.groupConfigWarning = "";
          setStatus("分组配置已保存：" + shortPath(state.groupConfigPath));
        } else {
          state.groupConfigWarning =
            typeof message.message === "string" && message.message.length > 0
              ? message.message
              : "分组配置写入失败";
          setStatus(state.groupConfigWarning);
        }
        renderGroupBar();
        break;
      case "error":
        showError(message);
        setStatus("解析失败：" + (message.message || ""));
        break;
      default:
        break;
    }
  });

  applyLayout();
  setTab(state.tab);
  showEmptyInfo(dom.wireInfo, "点击左侧连线，查看这条数据流的起止行。");
  renderStatus();
  vscode.postMessage({ type: "ready" });
})();
