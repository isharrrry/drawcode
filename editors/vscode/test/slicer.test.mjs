/**
 * 切片协议测试（宿主侧纯函数）。
 *
 * 这里的夹具刻意比 logic.test.mjs 更「有形状」：两层模块 + 一个空模块 +
 * 一个未归属信号。切片最容易出错的不是阈值判断，而是**归属判定**：
 * 信号属于哪个模块必须与 webview 的 moduleForPath 完全一致，否则展开模块
 * 拉回来的实体在树里挂不到任何节点上。最后一条测试直接拿 logic.js 的索引
 * 做对照，防止两处算法悄悄分叉。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  createModelSlicer,
  FILTER_MATCH_LIMIT,
  ModelSlicer,
  ORPHAN_MODULE_ID,
} from "../dist/slicer.js";

const LOGIC_SOURCE = fs.readFileSync(new URL("../media/logic.js", import.meta.url), "utf8");
const logicContext = vm.createContext({});
vm.runInContext(LOGIC_SOURCE, logicContext, { filename: "logic.js" });
const D = logicContext.DCLogic;

function moduleRow(id, name, path, children, root = false) {
  return {
    id,
    name,
    path,
    kind: root ? "assembly" : "namespace",
    children,
    root,
    exclude: false,
    counts: { signals: 0, funcs: 0, types: 0 },
  };
}

function signal(id, path, extra = {}) {
  return {
    id,
    name: id,
    ctype: "float",
    dir: "",
    unit: "",
    alias: "",
    note: "",
    tags: [],
    path,
    exclude: false,
    external: false,
    inferred: false,
    ...extra,
  };
}

function func(id, path, reads, writes, calls = []) {
  return {
    id,
    name: id,
    ret: "void",
    params: [],
    path,
    tags: [],
    reads,
    writes,
    calls,
    exclude: false,
    external: false,
  };
}

function typeRow(id, path, extra = {}) {
  return {
    id,
    name: id,
    kind: "struct",
    path,
    tags: [],
    store: false,
    exclude: false,
    size: 8,
    fields: [],
    ...extra,
  };
}

const MODEL = {
  info: {
    path: "C:\\demo\\Demo.dll",
    format: "pe-cli",
    arch: "x64",
    kind: "dll",
    hasMetadata: true,
    metadataVersion: 1,
  },
  modules: [
    moduleRow("A", "A", "A", ["A/B"], true),
    moduleRow("A/B", "B", "A/B", []),
    moduleRow("Empty", "Empty", "Empty", []),
  ],
  types: [typeRow("T1", "A/T1", { store: true }), typeRow("T2", "A/T2")],
  signals: [
    signal("s1", "A/s1", { ownerType: "T1" }),
    signal("s2", "A/B/s2"),
    signal("s3", "Z/s3"),
  ],
  funcs: [
    func("f1", "A/f1", [], ["s1"]),
    func("f2", "A/B/f2", ["s1"], ["s2"]),
    func("f3", "A/f3", ["s2"], []),
  ],
  edges: [
    { src: "f1", dst: "s1", kind: "write", inferred: false },
    { src: "f2", dst: "s1", kind: "read", inferred: false },
    { src: "f2", dst: "s2", kind: "write", inferred: false },
  ],
  diagnostics: [{ severity: "info", code: "X", message: "demo" }],
};

const IDS = (items) => items.map((item) => item.id).sort();

test("阈值：低于等于阈值不切片，0 强制切片，负数强制全量", () => {
  assert.equal(createModelSlicer(MODEL, 100), undefined);
  assert.equal(createModelSlicer(MODEL, 6), undefined, "信号+函数=6，等于阈值不切");
  assert.equal(createModelSlicer(MODEL, -1), undefined);
  assert.ok(createModelSlicer(MODEL, 0) instanceof ModelSlicer);
  assert.ok(createModelSlicer(MODEL, 5) instanceof ModelSlicer);
  // 默认阈值远大于夹具。
  assert.equal(createModelSlicer(MODEL), undefined);
});

test("init 只发结构：模块/类型/诊断在，信号/函数/边为空，计数齐全", () => {
  const slicer = createModelSlicer(MODEL, 0);
  const init = slicer.initModel();
  assert.equal(init.signals.length, 0);
  assert.equal(init.funcs.length, 0);
  assert.equal(init.edges.length, 0);
  assert.deepEqual(IDS(init.modules), ["A", "A/B", "Empty"]);
  assert.deepEqual(IDS(init.types), ["T1", "T2"]);
  assert.equal(init.diagnostics.length, 1);
  assert.deepEqual(slicer.totals, {
    modules: 3,
    types: 2,
    signals: 3,
    funcs: 3,
    edges: 3,
    storeTypes: 1,
  });
});

test("空模块从 init 起就标记为已加载，有内容的模块不会", () => {
  const slicer = createModelSlicer(MODEL, 0);
  assert.deepEqual(slicer.initiallyLoadedModules(), ["Empty"]);
});

test("requestNode 只回直属实体：子模块的实体不跟着上来", () => {
  const slicer = createModelSlicer(MODEL, 0);
  const a = slicer.moduleSlice("A");
  assert.deepEqual(IDS(a.signals), ["s1"]);
  assert.deepEqual(IDS(a.funcs), ["f1", "f3"]);
  assert.deepEqual(a.loadedModules, ["A"]);

  const b = slicer.moduleSlice("A/B");
  assert.deepEqual(IDS(b.signals), ["s2"]);
  assert.deepEqual(IDS(b.funcs), ["f2"]);

  const empty = slicer.moduleSlice("Empty");
  assert.equal(empty.signals.length + empty.funcs.length, 0);
  assert.deepEqual(empty.loadedModules, ["Empty"]);

  // 未知模块也要回 loadedModules，否则 webview 会一直转圈重试。
  const unknown = slicer.moduleSlice("NoSuch");
  assert.deepEqual(unknown.loadedModules, ["NoSuch"]);
});

test("未归属实体只在 __orphans__ 桶里出现，hasOrphans 为真", () => {
  const slicer = createModelSlicer(MODEL, 0);
  assert.equal(slicer.hasOrphans(), true);
  const orphans = slicer.moduleSlice(ORPHAN_MODULE_ID);
  assert.deepEqual(IDS(orphans.signals), ["s3"]);
  assert.deepEqual(orphans.loadedModules, [ORPHAN_MODULE_ID]);

  const noOrphans = createModelSlicer(
    { ...MODEL, signals: MODEL.signals.slice(0, 2), funcs: MODEL.funcs.slice(0, 2) },
    0,
  );
  assert.equal(noOrphans.hasOrphans(), false);
});

test("select 信号：带回写者与读者，且去重", () => {
  const slicer = createModelSlicer(MODEL, 0);
  const slice = slicer.selectSlice("signal", "s1");
  assert.deepEqual(IDS(slice.signals), ["s1"]);
  assert.deepEqual(IDS(slice.funcs), ["f1", "f2"]);

  // 同一函数既读又写时不能出现两次。
  const both = {
    ...MODEL,
    funcs: [...MODEL.funcs, func("f4", "A/f4", ["s1"], ["s1"])],
  };
  const slicer2 = createModelSlicer(both, 0);
  const ids = slicer2.selectSlice("signal", "s1").funcs.map((f) => f.id);
  assert.equal(ids.filter((id) => id === "f4").length, 1);
});

test("select 函数：带回读写信号与被调用函数；auto 能识别 id 类型", () => {
  const slicer = createModelSlicer(MODEL, 0);
  const slice = slicer.selectSlice("func", "f2");
  assert.deepEqual(IDS(slice.signals), ["s1", "s2"]);
  assert.deepEqual(IDS(slice.funcs), ["f2"]);

  const auto = slicer.selectSlice("auto", "f2");
  assert.deepEqual(IDS(auto.signals), ["s1", "s2"]);
  const autoSignal = slicer.selectSlice("auto", "s2");
  assert.deepEqual(IDS(autoSignal.funcs), ["f2", "f3"]);

  assert.equal(slicer.selectSlice("auto", "nope").signals.length, 0);
});

test("select 类型：按 ownerType 找字段信号，再找读写函数", () => {
  const slicer = createModelSlicer(MODEL, 0);
  const slice = slicer.selectSlice("type", "T1");
  assert.deepEqual(IDS(slice.signals), ["s1"]);
  assert.deepEqual(IDS(slice.funcs), ["f1", "f2"]);
});

test("filter：命中与邻居分开，邻居补进模型但不进 hits", () => {
  const slicer = createModelSlicer(MODEL, 0);
  const result = slicer.filterSlice("s2");
  assert.deepEqual(result.hits.signals.sort(), ["s2"]);
  assert.deepEqual(result.hits.funcs, [], "读写 s2 的函数是邻居，不是命中");
  // 邻居函数要带上，否则勾选命中后画不出流。
  assert.deepEqual(IDS(result.funcs), ["f2", "f3"]);
  assert.equal(result.truncated, false);

  const empty = slicer.filterSlice("   ");
  assert.equal(empty.hits.signals.length, 0);
  assert.equal(empty.signals.length, 0);

  const moduleHit = slicer.filterSlice("Empty");
  assert.deepEqual(moduleHit.hits.modules, ["Empty"]);
});

test("filter：命中超过上限时截断，并且 hits 里的每一条都已下发", () => {
  const many = {
    ...MODEL,
    signals: Array.from({ length: FILTER_MATCH_LIMIT + 50 }, (_, i) =>
      signal("sig" + i, "A/sig" + i),
    ),
    funcs: [],
    edges: [],
  };
  const slicer = createModelSlicer(many, 0);
  const result = slicer.filterSlice("sig");
  assert.equal(result.hits.signals.length, FILTER_MATCH_LIMIT);
  assert.equal(result.truncated, true);
  const delivered = new Set(result.signals.map((s) => s.id));
  assert.ok(result.hits.signals.every((id) => delivered.has(id)));
});

test("归属判定与 logic.js 的索引一致（防止两处 moduleForPath 分叉）", () => {
  const slicer = createModelSlicer(MODEL, 0);
  const ix = D.getIndex(MODEL);
  for (const module of MODEL.modules) {
    // vm 里创建的数组原型与本 realm 不同：先 Array.from 再深比较。
    const expectedSignals = Array.from(ix.ownSignals.get(module.id) || [], (s) => s.id).sort();
    const expectedFuncs = Array.from(ix.ownFuncs.get(module.id) || [], (f) => f.id).sort();
    const slice = slicer.moduleSlice(module.id);
    assert.deepEqual(IDS(slice.signals), expectedSignals, "模块 " + module.id + " 的信号归属");
    assert.deepEqual(IDS(slice.funcs), expectedFuncs, "模块 " + module.id + " 的函数归属");
  }
});
