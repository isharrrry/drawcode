/**
 * 纯逻辑层测试。
 *
 * 用 `vm` 加载 `media/logic.js`：它本来是挂到 `globalThis.DCLogic` 的
 * 传统脚本，没有 ESM 导出。用隔离的全局对象跑同一份实现，测试与 webview
 * 不会出现“两份逻辑各自演化”的漂移。
 *
 * 夹具刻意做成“生产者 / 两个消费者 / 空模块”：
 *   - `frame` 是结构信号，用来测模块端口、groupbox 字段树一路展开到基本类型；
 *   - `cmd` 是跨模块的声明输入，用来测输出行与输入行的配对；
 *   - `status` 在同一个模块里既写又读，用来测同模块双向端口；
 *   - `solo` 只有写者，用来测“有端口但没有边”的流；
 *   - `orphan` 没有归属模块，用来测未归属桶；
 *   - `hidden` 是排除项，用来测默认过滤。
 *
 * 这一版对应“单棵树 + groupbox + 行号连线”的数据形状：
 *   buildCascade → {rows, groups, indexByKey, ...}
 *   buildPortFlow → {nodes, edges, ...}，边直接带 fromRow/toRow，不再经过
 *   layoutFlow/routeEdges 的节点坐标计算。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = fs.readFileSync(new URL("../media/logic.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(SOURCE, context, { filename: "logic.js" });
const D = context.DCLogic;

// ── 夹具 ────────────────────────────────────────────────────────────────

function moduleRow(id, name, path, children, counts) {
  return {
    id,
    name,
    path,
    kind: children.length > 0 ? "assembly" : "namespace",
    children,
    root: false,
    exclude: false,
    counts: counts || { signals: 0, funcs: 0, types: 0 },
  };
}

function signal(id, name, dir, extra = {}) {
  return {
    id,
    name,
    ctype: "int32",
    dir,
    unit: "",
    alias: "",
    note: "",
    tags: [],
    path: "M/" + name,
    ownerType: undefined,
    exclude: false,
    external: false,
    inferred: false,
    ...extra,
  };
}

function func(id, name, path, reads, writes) {
  return {
    id,
    name,
    ret: "void",
    params: [],
    path,
    tags: [],
    reads,
    writes,
    calls: [],
    exclude: false,
    external: false,
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
    moduleRow("M", "M", "", ["M.Producer", "M.Consumer", "M.Consumer2", "M.Empty"], {
      signals: 5,
      funcs: 5,
      types: 3,
    }),
    moduleRow("M.Producer", "Producer", "M.Producer", [], { signals: 4, funcs: 3, types: 0 }),
    moduleRow("M.Consumer", "Consumer", "M.Consumer", [], { signals: 2, funcs: 1, types: 0 }),
    moduleRow("M.Consumer2", "Consumer2", "M.Consumer2", [], { signals: 1, funcs: 1, types: 0 }),
    moduleRow("M.Empty", "Empty", "M.Empty", [], { signals: 0, funcs: 0, types: 0 }),
  ],
  types: [
    {
      id: "Frame",
      name: "Frame",
      kind: "struct",
      path: "M/Frame",
      tags: [],
      store: false,
      exclude: false,
      size: 16,
      fields: [
        { name: "level", ctype: "float", offset: 0, size: 4, tags: [] },
        { name: "cfg", ctype: "Cfg", typeId: "Cfg", offset: 4, size: 8, tags: [] },
        {
          name: "children",
          ctype: "System.Collections.Generic.IReadOnlyList`1<Frame>",
          typeId: "Frame",
          offset: 12,
          size: 4,
          tags: [],
        },
      ],
    },
    {
      id: "Cfg",
      name: "Cfg",
      kind: "struct",
      path: "M/Cfg",
      tags: ["config", "Drawcode.Store=true"],
      store: true,
      exclude: false,
      size: 8,
      fields: [
        { name: "gain", ctype: "float", offset: 0, size: 4, tags: ["persist"] },
        { name: "inner", ctype: "Inner", typeId: "Inner", offset: 4, size: 4, tags: [] },
      ],
    },
    {
      id: "Inner",
      name: "Inner",
      kind: "struct",
      path: "M/Inner",
      tags: [],
      store: false,
      exclude: false,
      size: 4,
      fields: [{ name: "flag", ctype: "int32", offset: 0, size: 4, tags: [] }],
    },
    {
      id: "Hidden",
      name: "Hidden",
      kind: "struct",
      path: "M/Hidden",
      tags: [],
      store: false,
      exclude: true,
      size: 4,
      fields: [],
    },
  ],
  signals: [
    signal("frame", "frame", "out", {
      ctype: "Frame",
      ownerType: "Frame",
      path: "M.Producer/frame",
      alias: "FRM",
      tags: ["语义:实时数据", "Device.Model=示例型号"],
    }),
    signal("cmd", "cmd", "in", {
      path: "M.Consumer/cmd",
      tags: ["语义:控制指令"],
    }),
    signal("status", "status", "out", {
      path: "M.Producer/status",
      tags: ["Device.Model=示例型号"],
    }),
    signal("solo", "solo", "out", { path: "M.Producer/solo" }),
    signal("hidden", "hidden", "out", { path: "M.Producer/hidden", exclude: true }),
    signal("orphan", "orphan", "in", { path: "NoModule/orphan" }),
  ],
  funcs: [
    func("fProd", "Produce", "M.Producer/Produce", [], ["frame", "cmd", "solo", "status"]),
    func("fCons", "Consume", "M.Consumer/Consume", ["frame", "cmd"], []),
    func("fCons2", "Consume2", "M.Consumer2/Consume2", ["frame"], []),
    func("fLoop", "Loop", "M.Producer/Loop", ["status"], ["status"]),
    func("fGen", "<Generated>$", "M.Producer/Generated", [], ["solo"]),
  ],
  edges: [],
  diagnostics: [{ severity: "warning", code: "W001", message: "测试告警", subject: "frame" }],
};

const KEY = {
  frameOut: () => D.portKeyOf("o", "M.Producer", "frame"),
  frameIn: () => D.portKeyOf("i", "M.Consumer", "frame"),
  frameIn2: () => D.portKeyOf("i", "M.Consumer2", "frame"),
  cmdOut: () => D.portKeyOf("o", "M.Producer", "cmd"),
  cmdIn: () => D.portKeyOf("i", "M.Consumer", "cmd"),
  statusOut: () => D.portKeyOf("o", "M.Producer", "status"),
  statusIn: () => D.portKeyOf("i", "M.Producer", "status"),
  soloOut: () => D.portKeyOf("o", "M.Producer", "solo"),
  hiddenOut: () => D.portKeyOf("o", "M.Producer", "hidden"),
  orphanIn: () => D.portKeyOf("i", D.ORPHAN_MODULE_ID, "orphan"),
};

function cascade(extra = {}) {
  return D.buildCascade(MODEL, {
    collapsed: new Set(),
    checked: new Set(),
    ...extra,
  });
}

function rowByKey(data, key) {
  return data.rows.find((row) => row.key === key);
}

function portKeysOf(data) {
  return data.rows
    .filter((row) => row.kind === "port")
    .map((row) => row.key);
}

function groupOf(data, portKey) {
  return data.groups.find((group) => group.portKey === portKey);
}

// ── 端口生成 ────────────────────────────────────────────────────────────

test("端口：写函数所在模块有输出端口，读函数所在模块有输入端口", () => {
  const ports = D.getPorts(MODEL, {});
  const frame = ports.bySignal.get("frame");
  assert.equal(frame.outputs.length, 1);
  assert.equal(frame.outputs[0].key, KEY.frameOut());
  assert.equal(frame.outputs[0].moduleId, "M.Producer");
  assert.deepEqual(Array.from(frame.outputs[0].funcIds), ["fProd"]);
  assert.equal(frame.outputs[0].declared, false);

  const inputs = Array.from(frame.inputs, (port) => port.moduleId).sort();
  assert.deepEqual(inputs, ["M.Consumer", "M.Consumer2"]);
  const consumer = frame.inputs.find((port) => port.moduleId === "M.Consumer");
  assert.deepEqual(Array.from(consumer.funcIds), ["fCons"]);
  assert.equal(consumer.declared, false);
});

test("端口：同一模块既写又读同一信号时同时有输出行与输入行", () => {
  const ports = D.getPorts(MODEL, {});
  const status = ports.bySignal.get("status");
  assert.equal(status.outputs.length, 1);
  assert.equal(status.inputs.length, 1);
  assert.equal(status.outputs[0].moduleId, "M.Producer");
  assert.equal(status.inputs[0].moduleId, "M.Producer");
  assert.ok(status.outputs[0].key !== status.inputs[0].key, "方向不同，端口键不能相同");
  // fGen 的名字以 `<` 开头，默认按编译器生成过滤掉；它写的是 solo，不是 status。
  assert.deepEqual(Array.from(status.outputs[0].funcIds), ["fLoop", "fProd"]);
  assert.deepEqual(Array.from(status.inputs[0].funcIds), ["fLoop"]);
});

test("端口：没有写者时按声明方向补端口，未归属信号进入未归属桶", () => {
  const ports = D.getPorts(MODEL, {});
  const orphan = ports.bySignal.get("orphan");
  assert.equal(orphan.outputs.length, 0);
  assert.equal(orphan.inputs.length, 1);
  assert.equal(orphan.inputs[0].key, KEY.orphanIn());
  assert.equal(orphan.inputs[0].declared, true);
  assert.equal(orphan.inputs[0].moduleId, D.ORPHAN_MODULE_ID);

  // solo 只有写者：dir=out，不补输入端口。
  const solo = ports.bySignal.get("solo");
  assert.equal(solo.outputs.length, 1);
  assert.equal(solo.inputs.length, 0);
});

test("端口：方向未知但有读者时补输出端，勾选后能连出数据流", () => {
  // 无元数据 ELF 的真实形状：一个模块、方向为空、只有 read 边。
  // 若这里不补输出端，勾选信号只会得到孤立输入行，画布无 out → in 可连。
  const elf = {
    info: { path: "plain.out", format: "elf", hasMetadata: false },
    modules: [
      moduleRow("plain::plain", "plain", "plain", [], { signals: 1, funcs: 2, types: 0 }),
    ],
    types: [],
    signals: [
      signal("plain::plain.g_raw", "g_raw", "", { path: "plain", inferred: true }),
    ],
    funcs: [
      func("plain::plain.main", "main", "plain", ["plain::plain.g_raw"], []),
      func("plain::plain.sensor_read", "sensor_read", "plain", ["plain::plain.g_raw"], []),
    ],
    edges: [],
    diagnostics: [],
  };

  const ports = D.getPorts(elf, {});
  const raw = ports.bySignal.get("plain::plain.g_raw");
  assert.equal(raw.inputs.length, 1, "读者所在模块应有输入端口");
  assert.equal(raw.outputs.length, 1, "方向未知但有读者时也要补输出端");
  assert.equal(raw.outputs[0].declared, true, "补出来的输出端不能冒充真实写者");

  const checked = new Set([raw.outputs[0].key]);
  const data = D.buildCascade(elf, { checked });
  const flow = D.buildPortFlow(elf, checked, {
    indexByKey: data.indexByKey,
    rowIndexByPortKey: data.rowIndexByPortKey,
  });
  assert.equal(flow.edges.length, 1, "勾选信号后应有且只有一条 out → in 的流");
  assert.equal(flow.edges[0].from, raw.outputs[0].key);
  assert.equal(flow.edges[0].to, raw.inputs[0].key);
  assert.equal(flow.edges[0].drawable, true);
  assert.notEqual(flow.edges[0].fromRow, flow.edges[0].toRow, "两端应在不同行，线不能是零长度");
});

test("树：无元数据程序集把方向未知的信号与无端口函数分开列出", () => {
  // UDPServer.out 的真实形状：没有 drawcode 元数据，符号表只给出 25 个全局变量
  // 和 63 个函数。方向未知的信号不能标成「输出信号」，函数也不能因为没端口就消失。
  const elf = {
    info: { path: "UDPServer.out", format: "elf", hasMetadata: false },
    modules: [
      moduleRow("UDPServer::UDPServer", "UDPServer", "UDPServer", [],
        { signals: 1, funcs: 2, types: 0 }),
    ],
    types: [],
    signals: [
      signal("UDPServer::UDPServer.g_raw", "g_raw", "", { path: "UDPServer", inferred: true }),
    ],
    funcs: [
      func("UDPServer::UDPServer.main", "main", "UDPServer", [], []),
      func("UDPServer::UDPServer.sensor_read", "sensor_read", "UDPServer", [], []),
    ],
    edges: [],
    diagnostics: [],
  };

  const ports = D.getPorts(elf, {});
  const raw = ports.bySignal.get("UDPServer::UDPServer.g_raw");
  assert.equal(raw.outputs[0].inferredDir, true, "方向未知的补出端口要带推断标记");

  const data = D.buildCascade(elf, { collapsed: new Set(), checked: new Set() });
  const unknownGroup = data.rows.find((row) => row.dir === "unknown");
  assert.ok(unknownGroup, "方向未知的信号要有独立分组");
  assert.equal(unknownGroup.label, "信号（方向未标注）");
  assert.equal(unknownGroup.portKeys.length, 1);
  assert.equal(data.rows.filter((row) => row.kind === "group" && row.dir === "out").length, 0,
    "不能把方向未知的端口混进输出分组");

  const funcGroup = data.rows.find((row) => row.dir === "func");
  assert.ok(funcGroup, "无端口函数要有折叠组");
  assert.equal(funcGroup.portKeys.length, 0);
  assert.equal(data.rows.filter((row) => row.kind === "func").length, 2);
});

test("端口流：同向端口没有方向性对端时，连无箭头的同信号关联线", () => {
  // 两个模块都写同一个信号、但程序集里没人读：这是 small-cs 里
  // g_filtered 的真实形状。它没有 out → in，不能伪造箭头；但同名端口
  // 之间应有一条“同信号”关联线，否则勾选后画布看起来像坏了。
  const sharedModel = {
    info: { path: "shared.dll", format: "pe-cli", hasMetadata: true },
    modules: [
      moduleRow("A", "A", "A", [], { signals: 1, funcs: 1, types: 0 }),
      moduleRow("B", "B", "B", [], { signals: 0, funcs: 1, types: 0 }),
    ],
    types: [],
    signals: [signal("sig", "g_shared", "out", { path: "A" })],
    funcs: [
      func("fa", "WriteA", "A", [], ["sig"]),
      func("fb", "WriteB", "B", [], ["sig"]),
    ],
    edges: [],
    diagnostics: [],
  };

  const ports = D.getPorts(sharedModel, {});
  const outputs = ports.bySignal.get("sig").outputs.map((port) => port.key);
  assert.equal(outputs.length, 2);
  const checked = new Set(outputs);
  const data = D.buildCascade(sharedModel, { checked });
  const flow = D.buildPortFlow(sharedModel, checked, {
    indexByKey: data.indexByKey,
    rowIndexByPortKey: data.rowIndexByPortKey,
  });
  assert.equal(flow.edges.length, 1);
  assert.equal(flow.edges[0].kind, "same-signal");
  // 两个输出端互连 = 都在写，界面/导出都要能区分「同写」与「同读」。
  assert.equal(flow.edges[0].sharedDir, "out");
  assert.equal(flow.sharedCount, 1);
  assert.equal(flow.edges[0].drawable, true);
  assert.notEqual(flow.edges[0].fromRow, flow.edges[0].toRow);

  // 一旦出现真正的读者，就只画方向性数据流，不再叠同信号线。
  const withReader = {
    ...sharedModel,
    modules: [
      ...sharedModel.modules,
      moduleRow("C", "C", "C", [], { signals: 0, funcs: 1, types: 0 }),
    ],
    funcs: [...sharedModel.funcs, func("fc", "ReadC", "C", ["sig"], [])],
  };
  const readerPorts = D.getPorts(withReader, {});
  const input = readerPorts.bySignal.get("sig").inputs[0].key;
  const directed = D.buildPortFlow(withReader, new Set([...outputs, input]), {});
  assert.equal(directed.sharedCount, 0);
  assert.equal(directed.edges.length, 2);
  assert.ok(directed.edges.every((edge) => edge.kind === "flow"));
});

test("端口：排除项默认不生成，打开 showExcluded 后才出现", () => {
  assert.equal(D.getPorts(MODEL, {}).bySignal.has("hidden"), false);
  const withExcluded = D.getPorts(MODEL, { showExcluded: true });
  assert.equal(withExcluded.byKey.has(KEY.hiddenOut()), true);
  assert.equal(withExcluded.byKey.get(KEY.hiddenOut()).declared, true);
});

test("端口：编译器生成函数默认不参与，打开 showCompilerGenerated 后才计入", () => {
  const normal = D.getPorts(MODEL, {}).byKey.get(KEY.soloOut());
  assert.deepEqual(Array.from(normal.funcIds), ["fProd"]);
  const generated = D.getPorts(MODEL, { showCompilerGenerated: true }).byKey.get(KEY.soloOut());
  assert.deepEqual(Array.from(generated.funcIds), ["fGen", "fProd"]);
});

test("端口：键可编码任意 id，解析后完全还原", () => {
  const key = D.portKeyOf("o", "模块 A|B", "信号/1");
  const parsed = D.parsePortKey(key);
  assert.equal(parsed.dir, "out");
  assert.equal(parsed.moduleId, "模块 A|B");
  assert.equal(parsed.signalId, "信号/1");
  assert.equal(D.parsePortKey("x|a|b"), null);
  assert.equal(D.parsePortKey("o|a"), null);

  const fieldKey = D.fieldKeyOf(KEY.frameOut(), 2, "cfg/inner");
  const field = D.parseFieldKey(fieldKey);
  assert.equal(field.portKey, KEY.frameOut());
  assert.equal(field.column, 2);
  assert.equal(field.path, "cfg/inner");
  assert.equal(D.parseFieldKey("sf|broken"), null);
});

// ── 类型解析 ────────────────────────────────────────────────────────────

test("类型解析：泛型、数组、指针、可空都剥到元素类型", () => {
  const ix = D.getIndex(MODEL);
  const generic = D.resolveCtype(ix, "System.Collections.Generic.IReadOnlyList`1<M.Frame>");
  assert.equal(generic.type.id, "Frame");
  assert.equal(generic.collection, true);

  const dictionary = D.resolveCtype(ix, "Dictionary<string, M.Cfg>");
  assert.equal(dictionary.type.id, "Cfg");
  assert.equal(dictionary.collection, true);

  const array = D.resolveCtype(ix, "M.Frame[]");
  assert.equal(array.type.id, "Frame");
  assert.equal(array.collection, true);

  const pointer = D.resolveCtype(ix, "const M.Frame *");
  assert.equal(pointer.type.id, "Frame");
  assert.equal(pointer.collection, false);

  const nullable = D.resolveCtype(ix, "Nullable<M.Inner>");
  assert.equal(nullable.type.id, "Inner");
  assert.equal(nullable.collection, false);

  const primitive = D.resolveCtype(ix, "float");
  assert.equal(primitive.type, null);
  assert.equal(primitive.collection, false);
});

test("类型标签：数组必须带 []，不能退化成元素类型", () => {
  const ix = D.getIndex(MODEL);
  // 基本类型数组：byte[] 与 byte 是两种数据形态。
  assert.equal(D.basicTypeLabel(ix, "byte[]"), "byte[]");
  assert.equal(D.basicTypeLabel(ix, "byte"), "byte");
  assert.equal(D.basicTypeLabel(ix, "float[][]"), "float[][]");
  // 泛型集合也按数组展示（编辑器里同样是「一块数据」）。
  assert.equal(D.basicTypeLabel(ix, "List<float>"), "float[]");

  const frameArray = D.resolveCtype(ix, "M.Frame[]");
  assert.equal(D.displayTypeName(frameArray, "M.Frame[]"), "Frame[]");
  assert.equal(D.displayTypeName(D.resolveCtype(ix, "M.Frame"), "M.Frame"), "Frame");
  // 原始 ctype 已带括号时不能重复追加。
  assert.equal(D.displayTypeName(D.resolveCtype(ix, "M.Frame[][]"), "M.Frame[][]"), "Frame[][]");
});

test("类型解析：信号的 ctype 优先于 ownerType", () => {
  // C# 读取器把 ownerType 写成“声明该成员的类”，它通常没有字段；
  // 真正的结构在 ctype 里。若优先 ownerType，真实样本的所有 groupbox 都会是空框。
  const model = {
    ...MODEL,
    types: [
      ...MODEL.types,
      {
        id: "Comp",
        name: "Comp",
        kind: "class",
        path: "M/Comp",
        tags: [],
        store: false,
        exclude: false,
        size: 0,
        fields: [],
      },
    ],
    signals: MODEL.signals.map((s) => (s.id === "frame" ? { ...s, ownerType: "Comp" } : s)),
  };
  const data = D.buildCascade(model, { collapsed: new Set(), checked: new Set([KEY.frameOut()]) });
  const group = groupOf(data, KEY.frameOut());
  assert.ok(group, "ctype=Frame 有字段，不能因为 ownerType 指向无字段的类而丢失 groupbox");
  assert.equal(group.typeName, "Frame");
  assert.equal(rowByKey(data, KEY.frameOut()).typeName, "Frame");
});

test("类型解析：字段有 typeId 时仍从 ctype 读集合形态", () => {
  const data = cascade({ checked: new Set([KEY.frameOut()]) });
  const group = groupOf(data, KEY.frameOut());
  const children = group.fields.find((row) => row.label === "children");
  assert.equal(children.collection, true, "IReadOnlyList<Frame> 应标记为集合");
  assert.equal(children.targetTypeId, "Frame");
  assert.equal(children.expandable, false, "自引用类型不能继续展开，否则会无限递归");
});

// ── 模块树（单棵） ──────────────────────────────────────────────────────

test("树：只有一棵，行号连续；默认展开到每个模块的首层端口行", () => {
  const data = cascade();
  assert.equal(data.columns, undefined, "不再有向右加列的 columns");
  assert.equal(data.rowCount, data.rows.length);
  assert.equal(data.height, data.rows.length);
  assert.ok(data.rows.every((row, i) => row.index === i), "行号必须连续且从 0 开始");

  const keys = data.rows.map((row) => row.key);
  assert.ok(keys.includes("m|M"));
  assert.ok(keys.includes("m|M.Consumer"));
  assert.ok(keys.includes("m|M.Consumer2"));
  assert.ok(keys.includes("m|M.Producer"));
  assert.ok(!keys.includes("m|M.Empty"), "没有端口的模块默认剪枝");

  const ports = data.rows.filter((row) => row.kind === "port");
  assert.equal(ports.length, 9);
  assert.ok(ports.every((row) => row.checkable === true));
  assert.ok(ports.every((row) => row.dir === "out" || row.dir === "in"));
  assert.ok(ports.some((row) => row.dir === "out"));
  assert.ok(ports.some((row) => row.dir === "in"));

  // Producer 有两个可见函数（Produce / Loop），各自拥有专属端口，因此
  // status 的“写”端口（两个函数共用）留在模块级，其余输出挂到 Produce 下。
  const outGroup = rowByKey(data, "g|out|M.Producer");
  const inGroup = rowByKey(data, "g|in|M.Consumer");
  assert.equal(outGroup.label, "输出信号");
  assert.equal(inGroup.label, "输入信号");
  assert.deepEqual(Array.from(outGroup.portKeys).sort(), [KEY.statusOut()].sort());

  const produce = rowByKey(data, "f|M.Producer|fProd");
  const loop = rowByKey(data, "f|M.Producer|fLoop");
  assert.equal(produce.kind, "func");
  assert.equal(produce.label, "Produce");
  assert.equal(produce.depth, 2);
  assert.deepEqual(Array.from(produce.portKeys).sort(), [
    KEY.cmdOut(),
    KEY.frameOut(),
    KEY.soloOut(),
  ].sort());
  assert.equal(loop.label, "Loop");
  assert.deepEqual(Array.from(loop.portKeys).sort(), [KEY.statusIn()].sort());

  const produceOut = rowByKey(data, "gf|out|M.Producer|fProd");
  assert.equal(produceOut.label, "输出信号");
  assert.deepEqual(Array.from(produceOut.portKeys).sort(), [
    KEY.cmdOut(),
    KEY.frameOut(),
    KEY.soloOut(),
  ].sort());
});

test("树：模块行带子树出入计数，分组可整选", () => {
  const data = cascade();
  const producer = rowByKey(data, "m|M.Producer");
  assert.deepEqual(Array.from(producer.badges), ["出 4", "入 1"]);
  assert.equal(producer.checkable, true);
  assert.equal(producer.checked, false);

  const group = rowByKey(data, "g|out|M.Producer");
  assert.equal(group.kind, "group");
  assert.equal(group.checkable, true);
  assert.equal(group.checked, false);
});

test("树：显示空模块开关让零端口模块出现", () => {
  const data = cascade({ showEmptyModules: true });
  assert.ok(data.rows.some((row) => row.key === "m|M.Empty"));
});

test("树：过滤只保留命中信号及其模块，隐藏无关分组", () => {
  const data = cascade({ filter: "frame" });
  const keys = data.rows.map((row) => row.key);
  assert.ok(keys.includes("m|M"));
  assert.ok(keys.includes("m|M.Producer"));
  assert.ok(!keys.includes("m|M.Empty"));
  // rows 来自 vm 域：它的 filter/map 返回 vm 的 Array，deepStrictEqual 会因
  // 原型不同而失败（内容其实一致），所以先 Array.from 拉回当前 realm。
  assert.deepEqual(Array.from(portKeysOf(data)).sort(), [KEY.frameOut(), KEY.frameIn(), KEY.frameIn2()].sort());
  assert.ok(keys.includes("g|out|M.Producer"));
  assert.ok(!keys.includes("g|in|M.Producer"), "状态端口不匹配 frame，整组不应出现");

  const m = rowByKey(data, "m|M");
  assert.deepEqual(Array.from(m.portKeys).sort(), [KEY.frameOut(), KEY.frameIn(), KEY.frameIn2()].sort());
});

// ── 属性筛选（第 8 条） ─────────────────────────────────────────────────

test("属性筛选：按 [Device] / [Drawcode] 等特性值分类成组", () => {
  const groups = D.facetGroups(MODEL);
  const names = groups.map((group) => group.name);
  assert.ok(names.includes("Device.Model"), "Device 特性值应单独成组");
  assert.ok(names.includes("Drawcode.Store"));
  assert.ok(names.includes("语义"), "业务标签也参与筛选");

  const device = groups.find((group) => group.name === "Device.Model");
  const modelValue = device.values.find((value) => value.value === "示例型号");
  assert.equal(modelValue.tag, "Device.Model=示例型号", "下拉框的值是完整标签");
  assert.equal(modelValue.count, 2, "frame 与 status 各一次");
});

test("属性筛选：facet 独立命中，与文本过滤取交集", () => {
  const onlyDevice = cascade({ facet: "Device.Model=示例型号" });
  assert.deepEqual(
    Array.from(portKeysOf(onlyDevice)).sort(),
    [KEY.frameOut(), KEY.frameIn(), KEY.frameIn2(), KEY.statusOut(), KEY.statusIn()].sort(),
  );

  const both = cascade({ filter: "status", facet: "Device.Model=示例型号" });
  assert.deepEqual(Array.from(portKeysOf(both)).sort(), [KEY.statusOut(), KEY.statusIn()].sort());
});

// ── groupbox ────────────────────────────────────────────────────────────

test("groupbox：勾选结构端口生成一个框，字段默认展开全部层级并重新编号", () => {
  const data = cascade({ checked: new Set([KEY.frameOut()]) });
  const group = groupOf(data, KEY.frameOut());
  assert.ok(group, "结构信号必须生成 groupbox");
  assert.equal(group.title, "FRM  ·  frame");
  assert.deepEqual(
    Array.from(group.fields, (row) => row.label),
    ["level", "cfg", "gain", "inner", "flag", "children"],
  );
  assert.deepEqual(Array.from(group.fields, (row) => row.index), [1, 2, 3, 4, 5, 6]);
  assert.equal(group.fields[0].expandable, false);
  assert.equal(group.fields[1].expandable, true);
  assert.equal(group.fields[1].expanded, true, "默认展开全部层级");
  // 嵌套结构里的 flag 也应直接可见，这正是「默认展开」要解决的问题。
  const flag = group.fields.find((row) => row.label === "flag");
  assert.equal(flag.depth, 2);
});

test("groupbox：收起某一层后按可见行重编号，深度用缩进表达", () => {
  const cfgKey = D.fieldKeyOf(KEY.frameOut(), 1, "cfg");
  const data = cascade({
    checked: new Set([KEY.frameOut()]),
    groupCollapsed: new Set([cfgKey]),
  });
  const group = groupOf(data, KEY.frameOut());
  assert.deepEqual(
    Array.from(group.fields, (row) => [row.label, row.depth, row.index]),
    [
      ["level", 0, 1],
      ["cfg", 0, 2],
      ["children", 0, 3],
    ],
  );
  assert.equal(group.fields[1].expanded, false, "手动收起的节点不再展开");
});

test("groupbox：每个端口一个框、各自从 1 编号；基本类型不生成空框", () => {
  const data = cascade({ checked: new Set([KEY.frameOut(), KEY.frameIn()]) });
  assert.equal(data.groups.length, 2);
  assert.deepEqual(Array.from(data.groups, (group) => group.portKey), [
    KEY.frameOut(),
    KEY.frameIn(),
  ]);
  for (const group of data.groups) {
    assert.equal(group.fields[0].index, 1, "每个框的序号独立重排");
  }

  const basicOnly = cascade({ checked: new Set([KEY.soloOut()]) });
  assert.equal(basicOnly.groups.length, 0, "int32 端口没有字段，不应生成空 groupbox");
});

test("基本类型：左树用 [int] chip，结构类型名不进树行", () => {
  const data = cascade();
  const solo = rowByKey(data, KEY.soloOut());
  assert.equal(solo.typeChip, "int32");
  assert.equal(solo.meta, "", "类型名不再挂在行尾");

  const frame = rowByKey(data, KEY.frameOut());
  assert.equal(frame.typeChip, null, "结构体不在左树显示类型名");
  assert.equal(frame.meta, "");

  const withGroup = cascade({ checked: new Set([KEY.frameOut()]) });
  const group = groupOf(withGroup, KEY.frameOut());
  const level = group.fields.find((row) => row.label === "level");
  const cfg = group.fields.find((row) => row.label === "cfg");
  assert.equal(level.typeChip, "float", "基本类型字段在字段行显示 chip");
  assert.equal(cfg.typeChip, null, "结构字段不在字段行显示类型名");
});

test("勾选字段让端口行呈部分选中，勾选端口让 groupbox 字段全部选中", () => {
  const cfgKey = D.fieldKeyOf(KEY.frameOut(), 1, "cfg");
  const partial = cascade({ checked: new Set([cfgKey]) });
  const port = rowByKey(partial, KEY.frameOut());
  assert.equal(port.checked, false);
  assert.equal(port.indeterminate, true);
  const cfg = groupOf(partial, KEY.frameOut()).fields.find((row) => row.key === cfgKey);
  assert.equal(cfg.checked, true);

  const whole = cascade({ checked: new Set([KEY.frameOut()]) });
  assert.equal(rowByKey(whole, KEY.frameOut()).checked, true);
  assert.ok(
    groupOf(whole, KEY.frameOut()).fields.every((row) => row.checked === true),
    "端口整选表示它的所有字段都选",
  );
});

// ── 端口流（行号 → 行号） ───────────────────────────────────────────────

function flowFor(checked, extra = {}) {
  const data = cascade({ ...extra, checked });
  return D.buildPortFlow(MODEL, checked, {
    indexByKey: data.indexByKey,
    rowIndexByPortKey: data.rowIndexByPortKey,
    ...extra,
  });
}

test("端口流：只勾输出端口时自动带出对端输入，作为 context 节点", () => {
  const flow = flowFor(new Set([KEY.frameOut()]));
  assert.equal(flow.nodes.length, 3);
  assert.equal(flow.edges.length, 2);
  const out = flow.nodes.find((node) => node.nodeId === KEY.frameOut());
  assert.equal(out.context, false);
  assert.equal(out.role, "out");
  const inputs = flow.nodes.filter((node) => node.role === "in");
  assert.deepEqual(Array.from(inputs, (node) => node.nodeId).sort(), [KEY.frameIn(), KEY.frameIn2()].sort());
  assert.ok(inputs.every((node) => node.context === true));
  assert.ok(flow.edges.every((edge) => edge.kind === "flow"));
  assert.ok(flow.edges.every((edge) => edge.from === KEY.frameOut()));
  assert.ok(flow.edges.every((edge) => edge.label === "FRM  ·  frame"));
  assert.ok(flow.edges.every((edge) => edge.context === true));
});

test("端口流：边带 1 起的起止行号，可直接画到树的行号左侧", () => {
  const data = cascade({ checked: new Set([KEY.frameOut()]) });
  const flow = D.buildPortFlow(MODEL, new Set([KEY.frameOut()]), {
    indexByKey: data.indexByKey,
  });
  for (const edge of flow.edges) {
    assert.equal(edge.fromRow, data.indexByKey.get(edge.from) + 1);
    assert.equal(edge.toRow, data.indexByKey.get(edge.to) + 1);
    assert.equal(edge.drawable, true);
    assert.match(edge.color, /^#[0-9a-f]{6}$/i);
  }
  assert.ok(flow.edges[0].fromRow < flow.edges[1].fromRow ||
    flow.edges[0].toRow < flow.edges[1].toRow, "边按起止行号稳定排序");
});

test("端口流：对端端口行被折叠时，线锚到它所在的分组行", () => {
  const data = cascade({
    checked: new Set([KEY.frameOut()]),
    collapsed: new Set(["g|in|M.Consumer"]),
  });
  const flow = D.buildPortFlow(MODEL, new Set([KEY.frameOut()]), {
    indexByKey: data.indexByKey,
    rowIndexByPortKey: data.rowIndexByPortKey,
  });
  const hidden = flow.edges.find((edge) => edge.to === KEY.frameIn());
  const visible = flow.edges.find((edge) => edge.to === KEY.frameIn2());
  assert.equal(hidden.drawable, true, "端口行收起了，线仍然要画出来");
  assert.equal(hidden.toAnchored, true);
  assert.equal(hidden.toRow, data.indexByKey.get("g|in|M.Consumer") + 1);
  assert.equal(hidden.fromAnchored, false);
  assert.equal(visible.drawable, true);
  assert.equal(visible.toAnchored, false);
  assert.equal(flow.drawableCount, 2);
});

test("端口流：整个模块收起时，线锚到模块行（找不到分组再往上找）", () => {
  const data = cascade({
    checked: new Set([KEY.frameOut()]),
    collapsed: new Set(["m|M.Producer"]),
  });
  const flow = D.buildPortFlow(MODEL, new Set([KEY.frameOut()]), {
    indexByKey: data.indexByKey,
    rowIndexByPortKey: data.rowIndexByPortKey,
  });
  const edge = flow.edges.find((item) => item.from === KEY.frameOut());
  assert.equal(edge.drawable, true);
  assert.equal(edge.fromAnchored, true);
  assert.equal(edge.fromRow, data.indexByKey.get("m|M.Producer") + 1);
  // 两端都收在同一行的极端情况也不报错，线照样存在。
  assert.ok(edge.toRow > 0);
});

test("端口流：祖先模块也收起时，继续往上找可用的行", () => {
  const data = cascade({
    checked: new Set([KEY.frameOut()]),
    collapsed: new Set(["m|M"]),
  });
  const flow = D.buildPortFlow(MODEL, new Set([KEY.frameOut()]), {
    indexByKey: data.indexByKey,
    rowIndexByPortKey: data.rowIndexByPortKey,
  });
  const edge = flow.edges.find((item) => item.from === KEY.frameOut());
  assert.equal(edge.drawable, true);
  assert.equal(edge.fromRow, 1, "整棵树只剩根模块一行，两端都锚到它");
  assert.equal(edge.toRow, 1);
});

test("端口流：只勾输入端口时也会补出对端输出，流仍然可见", () => {
  const flow = flowFor(new Set([KEY.frameIn()]));
  assert.equal(flow.nodes.length, 2);
  assert.equal(flow.edges.length, 1);
  const input = flow.nodes.find((node) => node.nodeId === KEY.frameIn());
  const out = flow.nodes.find((node) => node.nodeId === KEY.frameOut());
  assert.equal(input.context, false);
  assert.equal(out.context, true);
  assert.equal(flow.edges[0].from, KEY.frameOut());
  assert.equal(flow.edges[0].to, KEY.frameIn());
});

test("端口流：两端都显式勾选时 context 为 false", () => {
  const flow = flowFor(new Set([KEY.frameOut(), KEY.frameIn()]));
  const edge = flow.edges.find((item) => item.to === KEY.frameIn());
  assert.equal(edge.context, false);
});

test("端口流：字段勾选折算到所属端口，并把字段路径记在节点与边上", () => {
  const cfgKey = D.fieldKeyOf(KEY.frameOut(), 1, "cfg");
  const flow = flowFor(new Set([cfgKey]));
  const out = flow.nodes.find((node) => node.nodeId === KEY.frameOut());
  assert.equal(out.context, false);
  assert.deepEqual(Array.from(out.fieldPaths), ["cfg"]);
  assert.equal(flow.edges.length, 2, "字段勾选仍然产生端口到端口的数据流");
  assert.deepEqual(Array.from(flow.edges[0].fieldPaths), ["cfg"]);
});

test("端口流：只有写者的端口显示孤立节点，没有边", () => {
  const flow = flowFor(new Set([KEY.soloOut()]));
  assert.equal(flow.nodes.length, 1);
  assert.equal(flow.nodes[0].nodeId, KEY.soloOut());
  assert.equal(flow.edges.length, 0);
  assert.equal(flow.empty, true);
});

test("端口流：未知勾选键被忽略，不生成幽灵节点", () => {
  const flow = D.buildPortFlow(MODEL, new Set(["o|no|such"]), {});
  assert.equal(flow.nodes.length, 0);
  assert.equal(flow.empty, true);
  assert.equal(flow.drawableCount, 0);
});

// ── 树辅助线（经典 +/− 与虚线） ─────────────────────────────────────────

test("树辅助线：末子画 └，非末子画 ├，祖先列按“还有后续兄弟”延续", () => {
  // A
  // ├─ B
  // │  └─ C
  // └─ D
  // E
  const rows = [
    { key: "A", depth: 0 },
    { key: "B", depth: 1 },
    { key: "C", depth: 2 },
    { key: "D", depth: 1 },
    { key: "E", depth: 0 },
  ];
  const g = D.treeGuides(rows);
  assert.deepEqual(Array.from(g[0].guides), [], "根行没有缩进格");
  assert.equal(g[0].last, false, "A 后面还有 E，根行本身不画拐角");
  assert.deepEqual(Array.from(g[1].guides), [true], "B 后面有 D，第一格竖线延续");
  assert.equal(g[1].last, false, "B 不是末子 → ├");
  assert.deepEqual(Array.from(g[2].guides), [true, false],
    "C：B 有后续兄弟 → 第一格延续；C 自己是末子 → 第二格拐角");
  assert.equal(g[2].last, true, "C 是末子 → └");
  // D 只有一格缩进，那一格就是它自己的拐角：后面接的是根行 E，
  // 所以 guides[0] 为 false、last 为 true（└）。
  assert.deepEqual(Array.from(g[3].guides), [false]);
  assert.equal(g[3].last, true);
  assert.equal(g[4].last, true, "E 是根且最后一行");
});

test("树辅助线：连续深层的末子不会多画竖线", () => {
  // A
  // └─ B
  //    └─ C
  const g = D.treeGuides([
    { key: "A", depth: 0 },
    { key: "B", depth: 1 },
    { key: "C", depth: 2 },
  ]);
  assert.deepEqual(Array.from(g[1].guides), [false]);
  assert.equal(g[1].last, true);
  assert.deepEqual(Array.from(g[2].guides), [false, false]);
  assert.equal(g[2].last, true);
});

test("配色：显式颜色优先，其次传输平面，最后按信号 id 稳定散列", () => {
  assert.equal(D.colorOfSignal({ id: "x", tags: ["颜色:#e0a0ff"] }), "#e0a0ff");
  assert.equal(D.colorOfSignal({ id: "x", tags: ["color:red"] }), "red");
  assert.equal(D.colorOfSignal({ id: "x", tags: ["平面:网络"] }), "#3794ff");
  assert.equal(D.colorOfSignal({ id: "x", tags: ["平面:共享内存"] }), "#b180d7");
  const a = D.colorOfSignal({ id: "same", tags: [] });
  const b = D.colorOfSignal({ id: "same", tags: [] });
  assert.equal(a, b, "没有显式颜色时也要稳定，重绘不能换色");
});

// ── 实体查询与信息 ──────────────────────────────────────────────────────

test("portsForEntity：信号输出优先，函数按读写方向取端口，类型取使用它的信号", () => {
  const frame = D.portsForEntity(MODEL, "signal", "frame", {});
  assert.deepEqual(Array.from(frame, (port) => port.key), [
    KEY.frameOut(),
    KEY.frameIn(),
    KEY.frameIn2(),
  ]);

  const produced = D.portsForEntity(MODEL, "func", "fProd", {});
  assert.equal(produced.length, 4);
  assert.ok(produced.every((port) => port.dir === "out"));

  const frameType = D.portsForEntity(MODEL, "type", "Frame", {});
  assert.equal(frameType.length, 3);

  const module = D.portsForEntity(MODEL, "module", "M.Producer", {});
  assert.ok(module.some((port) => port.key === KEY.statusIn()));
  assert.ok(module.some((port) => port.key === KEY.frameOut()));
  assert.deepEqual(Array.from(D.portsForEntity(MODEL, "func", "missing", {})), []);
});

test("describePort：给出模块、读写函数与对端端口", () => {
  const info = D.describePort(MODEL, KEY.frameOut(), {});
  assert.equal(info.module.name, "Producer");
  assert.deepEqual(Array.from(info.writers, (ref) => ref.id), ["fProd"]);
  assert.deepEqual(Array.from(info.readers, (ref) => ref.id).sort(), ["fCons", "fCons2"]);
  assert.equal(info.counterparts.length, 2);
  assert.equal(info.port.declared, false);

  const orphan = D.describePort(MODEL, KEY.orphanIn(), {});
  assert.equal(orphan.module.name, "（未归属）");
  assert.equal(orphan.port.declared, true);
  assert.equal(D.describePort(MODEL, "o|no|such", {}), null);
});

test("describeSignal 与 describeFunc 给出一跳邻居", () => {
  const info = D.describeSignal(MODEL, "frame");
  assert.equal(info.signal.alias, "FRM");
  assert.deepEqual(Array.from(info.writers, (ref) => ref.id), ["fProd"]);
  assert.deepEqual(Array.from(info.readers, (ref) => ref.id).sort(), ["fCons", "fCons2"]);
  assert.equal(info.ownerType.name, "Frame");

  const fn = D.describeFunc(MODEL, "fProd");
  assert.deepEqual(Array.from(fn.writes, (ref) => ref.name), ["frame", "cmd", "solo", "status"]);
  assert.deepEqual(Array.from(fn.reads), []);
});

test("moduleChain 返回根到自身的链，未归属是单点", () => {
  assert.deepEqual(Array.from(D.moduleChain(MODEL, "M.Producer")), ["M", "M.Producer"]);
  assert.deepEqual(Array.from(D.moduleChain(MODEL, D.ORPHAN_MODULE_ID)), [D.ORPHAN_MODULE_ID]);
});

// ── 切片 ────────────────────────────────────────────────────────────────

const SLICED_MODEL = {
  ...MODEL,
  signals: [],
  funcs: [],
};

test("切片：内容未加载时保留模块入口，但不提供整选", () => {
  const data = D.buildCascade(SLICED_MODEL, {
    collapsed: new Set(),
    checked: new Set(),
    sliced: true,
    loadedModules: new Set(),
    hasOrphans: true,
  });
  const producer = rowByKey(data, "m|M.Producer");
  assert.equal(producer.expandable, true, "counts 说有内容，就应保留展开箭头");
  assert.equal(producer.checkable, false, "子树未加载完时不能整选");
  assert.equal(portKeysOf(data).length, 0);

  const orphan = rowByKey(data, "m|" + D.ORPHAN_MODULE_ID);
  assert.ok(orphan, "hasOrphans 应让未归属入口出现");
  assert.equal(orphan.checkable, false);
});

test("切片：模块加载完后端口出现，整选恢复；空叶子不阻塞祖先", () => {
  const model = { ...MODEL, signals: MODEL.signals, funcs: MODEL.funcs };
  const data = D.buildCascade(model, {
    collapsed: new Set(),
    checked: new Set(),
    sliced: true,
    // 故意不加载 M.Empty：它没有直属实体，没有任何切片可请求。
    loadedModules: new Set(["M", "M.Producer", "M.Consumer", "M.Consumer2"]),
    hasOrphans: true,
  });
  const producer = rowByKey(data, "m|M.Producer");
  assert.equal(producer.checkable, true);
  // 端口是否存在只取决于模型里有没有信号；loadedModules 影响的是“能否整选”。
  // 未归属桶还没加载，但它的端口已经在 9 条里，只是整选复选框不可用。
  assert.equal(portKeysOf(data).length, 9);
  assert.equal(rowByKey(data, "m|" + D.ORPHAN_MODULE_ID).checkable, false);
  const m = rowByKey(data, "m|M");
  assert.equal(m.checkable, true, "空叶子应视为已加载，否则祖先永远不能整选");
  assert.deepEqual(Array.from(m.badges), ["出 4", "入 4"]);
});

test("切片：已加载未归属桶后，未归属端口可整选", () => {
  const model = { ...MODEL, signals: MODEL.signals, funcs: MODEL.funcs };
  const data = D.buildCascade(model, {
    collapsed: new Set(),
    checked: new Set(),
    sliced: true,
    loadedModules: new Set(["M", "M.Producer", "M.Consumer", "M.Consumer2", D.ORPHAN_MODULE_ID]),
    hasOrphans: true,
  });
  const orphan = rowByKey(data, "m|" + D.ORPHAN_MODULE_ID);
  assert.equal(orphan.checkable, true);
  assert.ok(portKeysOf(data).includes(KEY.orphanIn()));
});

// ── 持久化数据与概览 ────────────────────────────────────────────────────

test("ER：只包含 Store 类型，字段带关联结构", () => {
  const stores = D.buildEr(MODEL);
  assert.equal(stores.length, 1);
  assert.equal(stores[0].name, "Cfg");
  const gain = stores[0].fields.find((field) => field.name === "gain");
  const inner = stores[0].fields.find((field) => field.name === "inner");
  assert.equal(gain.target, null);
  assert.equal(inner.target.name, "Inner");
  assert.equal(inner.target.store, false);
});

test("erFieldRefs：字段信号能反查到读写函数，没有映射时返回空数组", () => {
  assert.deepEqual(Array.from(D.erFieldRefs(MODEL, "Cfg", "gain")), []);

  const gainSignal = signal("gainSig", "gain", "in", {
    ownerType: "Cfg",
    path: "M.Consumer/gain",
  });
  const model = {
    ...MODEL,
    signals: [...MODEL.signals, gainSignal],
    funcs: [
      ...MODEL.funcs,
      func("fWriteGain", "WriteGain", "M.Producer/WriteGain", [], ["gainSig"]),
      func("fReadGain", "ReadGain", "M.Consumer/ReadGain", ["gainSig"], []),
    ],
  };
  const refs = D.erFieldRefs(model, "Cfg", "gain");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].signal.id, "gainSig");
  assert.deepEqual(Array.from(refs[0].writers, (ref) => ref.id), ["fWriteGain"]);
  assert.deepEqual(Array.from(refs[0].readers, (ref) => ref.id), ["fReadGain"]);
  assert.deepEqual(Array.from(refs[0].funcs, (ref) => ref.id).sort(), ["fReadGain", "fWriteGain"]);
});

test("概览：统计总量、Store 类型并按严重度排序诊断", () => {
  const data = D.overview(MODEL);
  assert.equal(data.counts.modules, 5);
  assert.equal(data.counts.types, 4);
  assert.equal(data.counts.signals, 6);
  assert.equal(data.counts.funcs, 5);
  assert.equal(data.counts.storeTypes, 1);
  assert.equal(data.counts.diagnostics, 1);
  assert.equal(data.diagnostics[0].severity, "warning");
});

// ── 分组模式与配置 ──────────────────────────────────────────────────────

test("分组配置：清洗层级时去空、去重、限长、限量，从不抛异常", () => {
  // 逻辑跑在 vm 沙箱里，数组原型与本文件不同；比较前统一转成本地数组。
  assert.equal(D.cleanGroupLevels(null).length, 0);
  assert.equal(D.cleanGroupLevels("平面").length, 0);
  assert.deepEqual(
    Array.from(
      D.cleanGroupLevels([" 平面 ", "平面", "", null, 3, "x".repeat(101), "A", "B", "C", "D", "E", "F"]),
    ),
    ["平面", "A", "B", "C", "D", "E"],
  );
  assert.equal(D.cleanGroupLevels(["1", "2", "3", "4", "5", "6", "7"]).length, D.GROUP_MAX_LEVELS);
});

test("分组配置：坏 JSON 形状与失效别名都降级，不阻断视图", () => {
  const scalar = D.sanitizeGroupingConfig("not-an-object");
  assert.equal(scalar.levels.length, 0);
  assert.equal(scalar.issues.length, 1);

  const config = D.sanitizeGroupingConfig({
    levels: ["平面", 7],
    active: "已删除的别名",
    defaultPreset: "p",
    presets: [
      { alias: "p", levels: ["语义", "语义"] },
      { alias: "p", levels: ["重复别名"] },
      { alias: "", levels: ["空别名"] },
      { alias: "x".repeat(D.GROUP_ALIAS_MAX + 1), levels: ["超长"] },
      null,
      "nope",
    ],
  });
  assert.deepEqual(Array.from(config.levels), ["平面"]);
  assert.equal(config.active, null);
  assert.equal(config.defaultPreset, "p");
  assert.deepEqual(
    Array.from(config.presets, (preset) => ({ alias: preset.alias, levels: Array.from(preset.levels) })),
    [{ alias: "p", levels: ["语义"] }],
  );
  assert.ok(Array.from(config.issues).some((issue) => issue.indexOf("已删除的别名") >= 0));
});

test("分组配置：解析层级时优先指定别名，其次默认，最后上次层级", () => {
  const config = D.sanitizeGroupingConfig({
    levels: ["上次的层级"],
    presets: [
      { alias: "a", levels: ["平面"] },
      { alias: "b", levels: ["语义", "Device.Model"] },
    ],
    defaultPreset: "b",
  });
  const first = D.resolveGroupLevels(config, "a");
  assert.equal(first.alias, "a");
  assert.deepEqual(Array.from(first.levels), ["平面"]);

  const fallback = D.resolveGroupLevels(config, "不存在");
  assert.equal(fallback.alias, "b");
  assert.deepEqual(Array.from(fallback.levels), ["语义", "Device.Model"]);

  const plain = D.resolveGroupLevels(D.sanitizeGroupingConfig({ levels: ["L"] }), "x");
  assert.equal(plain.alias, null);
  assert.deepEqual(Array.from(plain.levels), ["L"]);
});

test("分组：单层按属性值建桶，模块挂到桶下，同一模块可多次出现", () => {
  const data = cascade({ groupLevels: ["语义"] });
  assert.equal(data.grouping.enabled, true);
  const buckets = data.rows.filter((row) => row.kind === "bucket");
  assert.deepEqual(Array.from(buckets, (row) => row.valueLabel), ["实时数据", "控制指令", "（未标注）"]);
  assert.ok(buckets.every((row) => row.depth === 0 && row.checkable));

  // Producer 同时写 frame（实时数据）与 cmd（控制指令），因此在两个桶下各出现一次。
  const producerRows = data.rows.filter(
    (row) => row.kind === "module" && row.moduleId === "M.Producer",
  );
  assert.equal(producerRows.length, 2);
  assert.notEqual(producerRows[0].key, producerRows[1].key);

  const keys = data.rows.map((row) => row.key);
  assert.equal(new Set(keys).size, keys.length, "分组行的 key 必须唯一");

  const realtime = buckets[0];
  assert.ok(realtime.portKeys.includes(KEY.frameOut()));
  assert.ok(realtime.portKeys.includes(KEY.frameIn2()));
  assert.equal(realtime.meta, "3 模块");

  // 端口键仍指向第一次出现的那个端口行。
  const portRow = rowByKey(data, data.portRowKey.get(KEY.frameOut()));
  assert.equal(portRow.kind, "port");
  assert.equal(portRow.portKey, KEY.frameOut());
  assert.equal(portRow.moduleId, "M.Producer");
});

test("分组：多层逐层嵌套，第二层属性值成为下一层桶", () => {
  const data = cascade({ groupLevels: ["语义", "Device.Model"] });
  const top = data.rows.filter((row) => row.kind === "bucket" && row.depth === 0);
  const second = data.rows.filter((row) => row.kind === "bucket" && row.depth === 1);
  assert.deepEqual(Array.from(top, (row) => row.valueLabel), ["实时数据", "控制指令", "（未标注）"]);
  assert.ok(second.every((row) => row.level === "Device.Model"));
  assert.ok(second.some((row) => row.valueLabel === "示例型号"));
  assert.ok(second.some((row) => row.valueLabel === "（未标注）"));

  // 模块行在第二层桶下；有函数子模块后，端口再深三层：
  // 模块 → 函数 → I/O 分组 → 端口。
  const moduleRow = data.rows.find(
    (row) => row.kind === "module" && row.moduleId === "M.Producer",
  );
  assert.equal(moduleRow.depth, 2);
  const functionRow = data.rows.find(
    (row) => row.kind === "func" && row.funcId === "fProd",
  );
  assert.equal(functionRow.depth, 3);
  const portRow = rowByKey(data, data.portRowKey.get(KEY.frameOut()));
  assert.equal(portRow.depth, 5);
  assert.deepEqual(Array.from(moduleRow.groupPath), ["实时数据", "示例型号"]);
});

test("分组：产物缺少该属性时落到未标注桶，并报告 missingLevels", () => {
  const data = cascade({ groupLevels: ["Device.Type"] });
  assert.deepEqual(Array.from(data.grouping.missingLevels), ["Device.Type"]);
  const buckets = data.rows.filter((row) => row.kind === "bucket");
  assert.deepEqual(Array.from(buckets, (row) => row.valueLabel), ["（未标注）"]);
  assert.ok(data.rows.some((row) => row.kind === "module"));
  assert.equal(data.grouping.truncated, false);
});

test("分组：裸标签归入「标签」分类，C/ELF 产物也能分层", () => {
  const bare = D.facetOfTag("telemetry");
  assert.equal(bare.name, "标签");
  assert.equal(bare.value, "telemetry");
  assert.equal(bare.tag, "telemetry");
  const model = {
    ...MODEL,
    signals: MODEL.signals.map((item) => {
      if (item.id === "frame") return { ...item, tags: ["telemetry", "rmem"] };
      return { ...item, tags: [] };
    }),
  };
  const data = D.buildCascade(model, {
    collapsed: new Set(),
    checked: new Set(),
    groupLevels: ["标签"],
  });
  assert.equal(data.grouping.missingLevels.length, 0);
  const labels = data.rows
    .filter((row) => row.kind === "bucket")
    .map((row) => row.valueLabel);
  // status 没有标签，Producer 因此还有一个「（未标注）」桶；未标注永远排最后。
  assert.deepEqual(Array.from(labels), ["rmem", "telemetry", "（未标注）"]);
});

test("分组：桶折叠后端口锚到桶行，数据流仍可画", () => {
  const data = cascade({ groupLevels: ["语义"] });
  const realtime = data.rows.find((row) => row.kind === "bucket" && row.value === "实时数据");
  const folded = D.buildCascade(MODEL, {
    collapsed: new Set([realtime.key]),
    checked: new Set([KEY.frameOut()]),
    groupLevels: ["语义"],
  });
  const bucketIndex = folded.rows.findIndex((row) => row.key === realtime.key);
  assert.equal(bucketIndex, 0);
  // Consumer2 只出现在被折叠的桶里：自身行不存在，锚点是桶行（0）。
  assert.equal(folded.portRowIndex.get(KEY.frameIn2()), undefined);
  assert.equal(folded.rowIndexByPortKey.get(KEY.frameIn2()), bucketIndex);

  const flow = D.buildPortFlow(MODEL, new Set([KEY.frameOut()]), {
    rowIndexByPortKey: folded.rowIndexByPortKey,
    portRowIndex: folded.portRowIndex,
  });
  const edge = flow.edges.find((item) => item.to === KEY.frameIn2());
  assert.ok(edge !== undefined);
  assert.equal(edge.toRow, bucketIndex + 1);
  assert.equal(edge.toAnchored, true);
  assert.equal(edge.drawable, true);
});

test("分组：层级路径超过上限时截断并标记", () => {
  const tags = [];
  for (let i = 0; i < 9; i += 1) tags.push("A:a" + i);
  for (let i = 0; i < 9; i += 1) tags.push("B:b" + i);
  const model = {
    ...MODEL,
    types: [],
    signals: [signal("huge", "huge", "out", { path: "M.Producer/huge", tags })],
    funcs: [func("fHuge", "Huge", "M.Producer/Huge", [], ["huge"])],
  };
  const data = D.buildCascade(model, {
    collapsed: new Set(),
    checked: new Set(),
    groupLevels: ["A", "B"],
  });
  assert.equal(data.grouping.truncated, true);
  assert.equal(data.rows.filter((row) => row.kind === "module").length, 64);
});

test("函数：折叠函数后端口行消失，连线锚到函数行", () => {
  const data = cascade({ collapsed: new Set(["f|M.Producer|fProd"]) });
  const functionRow = rowByKey(data, "f|M.Producer|fProd");
  assert.ok(functionRow !== undefined);
  assert.equal(functionRow.expanded, false);
  assert.equal(data.portRowIndex.get(KEY.frameOut()), undefined, "折叠后不再有端口行");
  assert.equal(
    data.rowIndexByPortKey.get(KEY.frameOut()),
    functionRow.index,
    "端口应锚到它所属的函数行，而不是模块级 I/O 分组",
  );

  const flow = D.buildPortFlow(MODEL, new Set([KEY.frameOut(), KEY.frameIn()]), {
    rowIndexByPortKey: data.rowIndexByPortKey,
    portRowIndex: data.portRowIndex,
  });
  const edge = flow.edges.find((item) => item.to === KEY.frameIn());
  assert.ok(edge !== undefined);
  assert.equal(edge.fromRow, functionRow.index + 1);
  assert.equal(edge.fromAnchored, true);
});

test("连线车道：竖直区间重叠时分开，互不重叠时复用", () => {
  const lanes = D.assignWireLanes([
    [10, 100],
    [20, 30],
    [25, 60],
    [110, 120],
  ]);
  // 第一条长线占住 lane 0；20-30 与 25-60 相互重叠，必须再开一条 lane。
  assert.equal(lanes[0], 0);
  assert.notEqual(lanes[1], lanes[0]);
  assert.notEqual(lanes[2], lanes[1]);
  // 110 开始的新线已经在第一条结束后，可以复用 lane 0。
  assert.equal(lanes[3], 0);
});
