/**
 * 程序集树的纯数据层。
 *
 * 这里刻意不 import vscode：树的增删改、持久化前的清洗、拖拽时的环检测
 * 都能用 node:test 直接验证，VS Code 只负责把结果画出来。
 *
 * 为什么所有写操作都返回新 store：
 *   - 旧快照仍然可用，测试里能直接断言「原对象没有被改」；
 *   - workspaceState.update 是异步落盘，每次写入持有一份确定的快照，
 *     排队顺序就是提交顺序，不会出现「写到一半被下一次修改覆盖」的歧义；
 *   - 与项目既有代码的不可变风格一致，拖拽、撤销等后续能力不用重写。
 */

export const TREE_STORE_VERSION = 1 as const;

/** 单段名称上限：够长到能写清楚业务含义，又不会把树撑成一行。 */
export const MAX_NAME_LENGTH = 120;

/** 防御性上限：损坏的 workspaceState 不应该让扩展卡死或撑爆内存。 */
export const MAX_TREES = 50;
export const MAX_CHILDREN = 200;
export const MAX_NODES = 2000;
export const MAX_DEPTH = 12;

export interface ArtifactNode {
  kind: "artifact";
  id: string;
  /** 用户设置的别名；空串表示显示文件名。 */
  alias: string;
  /** 绝对 URI（通常是 file:///...）。用字符串保存，workspaceState 可直接序列化。 */
  uri: string;
}

export interface FolderNode {
  kind: "folder";
  id: string;
  name: string;
  children: TreeNode[];
}

/** 顶层节点：一个用户命名的「树」。和普通分组分开，右键菜单才能区分。 */
export interface TreeRoot {
  kind: "tree";
  id: string;
  name: string;
  children: TreeNode[];
}

export type ContainerNode = TreeRoot | FolderNode;
export type TreeNode = ContainerNode | ArtifactNode;

export interface TreeStore {
  version: number;
  trees: TreeRoot[];
}

export interface FoundNode {
  node: TreeNode;
  /** 树根没有 parent。 */
  parent: ContainerNode | undefined;
  /** 树根深度为 0。 */
  depth: number;
  /** 从树根到父级的名称链，不含当前节点。 */
  path: string[];
}

export interface ContainerEntry {
  node: ContainerNode;
  depth: number;
  path: string[];
}

export interface MutationResult<T extends TreeNode> {
  store: TreeStore;
  node: T | null;
}

let idCounter = 0;

/** 优先用平台 UUID；老 Node 没有 crypto.randomUUID 时退化为时间戳计数器。 */
function newId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject !== undefined && typeof cryptoObject.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  idCounter += 1;
  return `n${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isContainer(node: TreeNode): node is ContainerNode {
  return node.kind === "tree" || node.kind === "folder";
}

export function isArtifact(node: TreeNode): node is ArtifactNode {
  return node.kind === "artifact";
}

export function createStore(): TreeStore {
  return { version: TREE_STORE_VERSION, trees: [] };
}

/** 去掉首尾空白、把连续空白压成一个空格，并截断到上限。 */
export function cleanName(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length === 0 ? "未命名" : text.slice(0, MAX_NAME_LENGTH);
}

/** 别名允许为空：空串是「清空别名，回到文件名」的合法表达。 */
export function cleanAlias(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.slice(0, MAX_NAME_LENGTH);
}

/**
 * 从 URI 取文件名。先按 URL 解析（能正确解码 %20 与中文），
 * 失败再按 Windows/Unix 路径切分，覆盖用户手写的 "C:\\a\\b.dll"。
 */
export function basenameFromUri(uri: string): string {
  const trimmed = typeof uri === "string" ? uri.trim() : "";
  if (trimmed.length === 0) return "未命名程序集";
  try {
    const parsed = new URL(trimmed);
    const decoded = decodeURIComponent(parsed.pathname);
    // 同一个函数要同时吃两种输入：标准 file URI 用 "/" 分隔，用户手写的
    // "C:\x\a.dll" 被 URL 解析后 pathname 里仍是 "\"，所以两种分隔符都切。
    const name = decoded.split(/[\\/]/).filter((part) => part.length > 0).pop();
    if (name !== undefined && name.length > 0) return name;
  } catch {
    // 不是标准 URL，继续按普通路径处理。
  }
  const parts = trimmed.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}

export function artifactLabel(node: ArtifactNode): string {
  return node.alias.length > 0 ? node.alias : basenameFromUri(node.uri);
}

/**
 * 把 workspaceState 里拿到的任意值清洗成可用 store。
 *
 * 原则：坏数据只丢坏节点，不抛异常。用户在旧版本里保存的树、手工改坏的
 * JSON、甚至完全不相干的数字，都应该让视图正常打开而不是弹红条。
 */
export function normalizeStore(raw: unknown): TreeStore {
  const source = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.trees)
      ? raw.trees
      : [];
  const seenIds = new Set<string>();
  const budget = { remaining: MAX_NODES };
  const trees: TreeRoot[] = [];

  for (const item of source) {
    if (trees.length >= MAX_TREES || budget.remaining <= 0) break;
    const tree = sanitizeContainer(item, "tree", 0, seenIds, budget);
    if (tree !== null && tree.kind === "tree") trees.push(tree);
  }

  return { version: TREE_STORE_VERSION, trees };
}

function sanitizeContainer(
  raw: unknown,
  kind: "tree" | "folder",
  depth: number,
  seenIds: Set<string>,
  budget: { remaining: number },
): ContainerNode | null {
  if (!isRecord(raw) || budget.remaining <= 0) return null;
  budget.remaining -= 1;

  const children: TreeNode[] = [];
  // 到达深度上限后保留这个容器本身，但丢弃更深的内容：
  // 用户至少还能看到并删除它，而不是整棵树消失。
  if (depth < MAX_DEPTH && Array.isArray(raw.children)) {
    for (const child of raw.children) {
      if (children.length >= MAX_CHILDREN || budget.remaining <= 0) break;
      const childKind = isRecord(child) && child.kind === "artifact" ? "artifact" : "folder";
      const node = childKind === "artifact"
        ? sanitizeArtifact(child, seenIds, budget)
        : sanitizeContainer(child, "folder", depth + 1, seenIds, budget);
      if (node !== null) children.push(node);
    }
  }

  return {
    kind,
    id: takeId(raw.id, seenIds),
    name: cleanName(raw.name),
    children,
  };
}

function sanitizeArtifact(
  raw: unknown,
  seenIds: Set<string>,
  budget: { remaining: number },
): ArtifactNode | null {
  if (!isRecord(raw) || budget.remaining <= 0) return null;
  const uri = typeof raw.uri === "string" ? raw.uri.trim() : "";
  if (uri.length === 0) return null;
  budget.remaining -= 1;
  return {
    kind: "artifact",
    id: takeId(raw.id, seenIds),
    alias: cleanAlias(raw.alias),
    uri,
  };
}

function takeId(value: unknown, seenIds: Set<string>): string {
  if (typeof value === "string" && value.length > 0 && value.length <= 100 && !seenIds.has(value)) {
    seenIds.add(value);
    return value;
  }
  let id = newId();
  while (seenIds.has(id)) id = newId();
  seenIds.add(id);
  return id;
}

/** 递归找节点，同时带回父级与路径；拖拽的环检测依赖这套信息。 */
export function findNode(store: TreeStore, id: string): FoundNode | undefined {
  return searchNodes(store.trees, id, undefined, 0, []);
}

function searchNodes(
  nodes: readonly TreeNode[],
  id: string,
  parent: ContainerNode | undefined,
  depth: number,
  path: string[],
): FoundNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return { node, parent, depth, path };
    if (isContainer(node)) {
      const found = searchNodes(node.children, id, node, depth + 1, [...path, node.name]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** 给「选择一个目标树/分组」的下拉列表用：先序展开，深度用于缩进。 */
export function flattenContainers(store: TreeStore): ContainerEntry[] {
  const entries: ContainerEntry[] = [];
  const visit = (node: ContainerNode, depth: number, path: string[]): void => {
    entries.push({ node, depth, path });
    for (const child of node.children) {
      if (isContainer(child)) visit(child, depth + 1, [...path, node.name]);
    }
  };
  for (const tree of store.trees) visit(tree, 0, []);
  return entries;
}

export function countArtifacts(node: ContainerNode): number {
  let total = 0;
  for (const child of node.children) {
    if (isArtifact(child)) total += 1;
    else total += countArtifacts(child);
  }
  return total;
}

export function addTree(store: TreeStore, name: string): MutationResult<TreeRoot> {
  if (store.trees.length >= MAX_TREES) return { store, node: null };
  const tree: TreeRoot = {
    kind: "tree",
    id: newId(),
    name: cleanName(name),
    children: [],
  };
  return { store: { ...store, trees: [...store.trees, tree] }, node: tree };
}

export function addFolder(
  store: TreeStore,
  parentId: string,
  name: string,
): MutationResult<FolderNode> {
  const parent = findNode(store, parentId);
  if (parent === undefined || !isContainer(parent.node)) return { store, node: null };
  if (parent.depth >= MAX_DEPTH) return { store, node: null };
  if (parent.node.children.length >= MAX_CHILDREN) return { store, node: null };

  const folder: FolderNode = {
    kind: "folder",
    id: newId(),
    name: cleanName(name),
    children: [],
  };
  return { store: appendChild(store, parentId, folder), node: folder };
}

export function addArtifact(
  store: TreeStore,
  parentId: string,
  uri: string,
  alias: string,
): MutationResult<ArtifactNode> {
  const parent = findNode(store, parentId);
  if (parent === undefined || !isContainer(parent.node)) return { store, node: null };
  // 与 addFolder 的上限保持一致：超过 MAX_DEPTH 的节点在下次启动清洗时
  // 会被截掉，与其静默丢失，不如当场拒绝。
  if (parent.depth >= MAX_DEPTH) return { store, node: null };
  if (parent.node.children.length >= MAX_CHILDREN) return { store, node: null };
  const trimmed = typeof uri === "string" ? uri.trim() : "";
  if (trimmed.length === 0) return { store, node: null };

  const artifact: ArtifactNode = {
    kind: "artifact",
    id: newId(),
    alias: cleanAlias(alias),
    uri: trimmed,
  };
  return { store: appendChild(store, parentId, artifact), node: artifact };
}

export function renameNode(store: TreeStore, id: string, name: string): TreeStore {
  return updateNode(store, id, (node) => (
    isArtifact(node)
      ? { ...node, alias: cleanAlias(name) }
      : { ...node, name: cleanName(name) }
  ));
}

export function removeNode(store: TreeStore, id: string): TreeStore {
  return updateNode(store, id, () => null);
}

/**
 * 把节点移动到另一个容器下。以下情况原样返回：
 *   - 目标是程序集而不是容器；
 *   - 目标就是自己或自己的后代（否则会形成环，递归时直接消失）；
 *   - 移动的是顶层「树」：树是视图的根，不允许降级成分组。
 */
export function moveNode(store: TreeStore, id: string, targetParentId: string): TreeStore {
  if (id === targetParentId) return store;
  const found = findNode(store, id);
  const target = findNode(store, targetParentId);
  if (found === undefined || target === undefined) return store;
  if (!isContainer(target.node)) return store;
  if (found.node.kind === "tree") return store;
  if (isInside(store, targetParentId, id)) return store;

  const without = removeNode(store, id);
  return appendChild(without, targetParentId, found.node);
}

/** maybeDescendant 是否位于 ancestorId 的子树内（含自身）。 */
function isInside(store: TreeStore, maybeDescendantId: string, ancestorId: string): boolean {
  let current = findNode(store, maybeDescendantId);
  while (current !== undefined) {
    if (current.node.id === ancestorId) return true;
    current = current.parent === undefined ? undefined : findNode(store, current.parent.id);
  }
  return false;
}

function appendChild(store: TreeStore, parentId: string, child: TreeNode): TreeStore {
  return updateNode(store, parentId, (node) => (
    isContainer(node)
      ? { ...node, children: [...node.children, child] }
      : node
  ));
}

/**
 * 对整棵树做不可变更新。
 *
 * 返回值语义：更新函数返回 null 表示删除；没有命中 id 时返回原 store 引用，
 * 调用方可以据此判断「什么都没发生」，避免无意义的重绘与落盘。
 */
function updateNode(
  store: TreeStore,
  id: string,
  update: (node: TreeNode) => TreeNode | null,
): TreeStore {
  let changed = false;
  const trees: TreeRoot[] = [];

  for (const tree of store.trees) {
    if (tree.id === id) {
      changed = true;
      const next = update(tree);
      if (next !== null) trees.push(next as TreeRoot);
      continue;
    }
    const next = updateContainer(tree, id, update);
    if (next !== tree) changed = true;
    if (next !== null) trees.push(next as TreeRoot);
  }

  return changed ? { ...store, trees } : store;
}

function updateContainer(
  container: ContainerNode,
  id: string,
  update: (node: TreeNode) => TreeNode | null,
): ContainerNode | null {
  let changed = false;
  const children: TreeNode[] = [];

  for (const child of container.children) {
    if (child.id === id) {
      changed = true;
      const next = update(child);
      if (next !== null) children.push(next);
      continue;
    }
    if (isContainer(child)) {
      const next = updateContainer(child, id, update);
      if (next !== child) changed = true;
      if (next !== null) children.push(next);
      continue;
    }
    children.push(child);
  }

  return changed ? { ...container, children } : container;
}
