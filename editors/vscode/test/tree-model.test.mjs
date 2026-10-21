/**
 * 产物树纯数据层测试。
 *
 * 这些用例只依赖 dist/tree/model.js，不启动 VS Code：树的清洗、增删改、
 * 拖拽环检测都是纯函数，跑一次只要几十毫秒。`npm test` 会先 build，确保
 * 测的是刚编译出来的代码而不是上一次的残留。
 */
import test from "node:test";
import assert from "node:assert/strict";

import * as M from "../dist/tree/model.js";

/** 每棵测试树都从同一份最小样本开始，避免用例之间互相污染。 */
function sample() {
  let store = M.createStore();
  const tree = M.addTree(store, "试验");
  assert.ok(tree.node);
  store = tree.store;

  const folder = M.addFolder(store, tree.node.id, "输入");
  assert.ok(folder.node);
  store = folder.store;

  const artifact = M.addArtifact(store, folder.node.id, "file:///C:/x/a.dll", "");
  assert.ok(artifact.node);
  store = artifact.store;

  return {
    store,
    treeId: tree.node.id,
    folderId: folder.node.id,
    artifactId: artifact.node.id,
  };
}

test("清洗：坏数据降级为空树，不抛异常", () => {
  for (const raw of [undefined, null, 42, "x", {}, { trees: "no" }, [], { trees: [null, 1, "x"] }]) {
    const store = M.normalizeStore(raw);
    assert.equal(store.version, M.TREE_STORE_VERSION);
    assert.deepEqual(store.trees, []);
  }
});

test("清洗：保留合法节点，压平名称，丢弃空 URI", () => {
  const store = M.normalizeStore({
    version: 99,
    trees: [
      {
        kind: "tree",
        id: "t1",
        name: "  试验   产物 ",
        children: [
          { kind: "artifact", id: "a1", uri: "file:///C:/x/%E4%BA%A7%E7%89%A9.dll" },
          {
            kind: "folder",
            id: "f1",
            name: "分组",
            children: [{ kind: "artifact", id: "a2", uri: "file:///C:/y/b.so", alias: "  主库  " }],
          },
          { kind: "artifact", id: "bad", uri: "   " },
        ],
      },
    ],
  });

  assert.equal(store.version, M.TREE_STORE_VERSION);
  assert.equal(store.trees.length, 1);
  assert.equal(store.trees[0].name, "试验 产物");
  assert.equal(store.trees[0].children.length, 2);
  assert.equal(M.artifactLabel(store.trees[0].children[0]), "产物.dll");
  assert.equal(store.trees[0].children[1].children[0].alias, "主库");
});

test("清洗：重复 id 重新生成，深度超限截断", () => {
  const duplicate = M.normalizeStore({
    trees: [{
      kind: "tree",
      id: "dup",
      name: "A",
      children: [{ kind: "artifact", id: "dup", uri: "file:///a" }],
    }],
  });
  assert.notEqual(duplicate.trees[0].id, duplicate.trees[0].children[0].id);

  let node = { kind: "artifact", uri: "file:///deep" };
  for (let index = 0; index < 20; index += 1) {
    node = { kind: "folder", name: `L${index}`, children: [node] };
  }
  const deep = M.normalizeStore({ trees: [{ kind: "tree", name: "T", children: [node] }] });
  const depths = M.flattenContainers(deep).map((entry) => entry.depth);
  assert.equal(Math.max(...depths), M.MAX_DEPTH);
  // 深度上限处仍保留容器本身，用户能看见并删除它。
  assert.equal(M.flattenContainers(deep).length, M.MAX_DEPTH + 1);
});

test("增删：树、分组、产物落到正确父级，路径与计数正确", () => {
  const { store, treeId, folderId, artifactId } = sample();
  const found = M.findNode(store, artifactId);
  assert.ok(found);
  assert.equal(found.depth, 2);
  assert.equal(found.parent.id, folderId);
  assert.deepEqual(found.path, ["试验", "输入"]);
  assert.equal(M.artifactLabel(found.node), "a.dll");
  assert.equal(M.countArtifacts(M.findNode(store, treeId).node), 1);
});

test("不可变：新增产物不会改旧快照", () => {
  const { store, treeId } = sample();
  const before = M.findNode(store, treeId).node.children.length;
  const added = M.addArtifact(store, treeId, "file:///C:/x/b.dll", "乙");
  assert.ok(added.node);
  assert.notEqual(added.store, store);
  assert.equal(M.findNode(store, treeId).node.children.length, before);
  assert.equal(M.findNode(added.store, treeId).node.children.length, before + 1);
});

test("重命名：产物改别名，清空别名回到文件名；分组改名称", () => {
  const { store, treeId, artifactId } = sample();
  const renamed = M.renameNode(store, artifactId, "主程序");
  assert.equal(M.findNode(renamed, artifactId).node.alias, "主程序");

  const cleared = M.renameNode(renamed, artifactId, "  ");
  assert.equal(M.artifactLabel(M.findNode(cleared, artifactId).node), "a.dll");

  const treeRenamed = M.renameNode(cleared, treeId, "  新树  ");
  assert.equal(M.findNode(treeRenamed, treeId).node.name, "新树");
});

test("移除：删分组带走子树；删不存在的 id 返回原引用", () => {
  const { store, folderId, artifactId } = sample();
  const removed = M.removeNode(store, folderId);
  assert.equal(M.findNode(removed, artifactId), undefined);
  assert.equal(M.removeNode(removed, "missing"), removed);
});

test("移动：跨树移动；拒绝树根、自身与后代", () => {
  const { store, treeId, folderId, artifactId } = sample();
  const second = M.addTree(store, "第二棵");
  assert.ok(second.node);

  const moved = M.moveNode(second.store, artifactId, second.node.id);
  assert.equal(M.findNode(moved, artifactId).parent.id, second.node.id);
  assert.equal(M.findNode(moved, folderId).node.children.length, 0);

  // 树根不能降级成普通分组。
  assert.equal(M.moveNode(store, treeId, folderId), store);
  // 自己拖到自己。
  assert.equal(M.moveNode(store, folderId, folderId), store);

  // 父分组不能拖进自己的后代，否则整棵子树从根上消失。
  const nested = M.addFolder(store, folderId, "嵌套");
  assert.ok(nested.node);
  assert.equal(M.moveNode(nested.store, folderId, nested.node.id), nested.store);
});

test("扁平容器：先序展开并带深度，供目标选择器缩进", () => {
  const { store } = sample();
  const second = M.addTree(store, "第二棵");
  const entries = M.flattenContainers(second.store);
  assert.deepEqual(
    entries.map((entry) => [entry.depth, entry.node.name]),
    [[0, "试验"], [1, "输入"], [0, "第二棵"]],
  );
  assert.deepEqual(entries[1].path, ["试验"]);
});

test("文件名：解码 URI，兼容 Windows 路径与空串", () => {
  assert.equal(M.basenameFromUri("file:///C:/Program%20Files/%E4%BA%A7%E7%89%A9.dll"), "产物.dll");
  assert.equal(M.basenameFromUri("C:\\x\\a.dll"), "a.dll");
  assert.equal(M.basenameFromUri(""), "未命名程序集");
});
