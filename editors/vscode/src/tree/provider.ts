/**
 * 活动栏「程序集树」的 TreeDataProvider。
 *
 * 只做三件事：把 store 映射成 TreeItem、把拖拽落到 store、把每次变更写进
 * workspaceState。具体的增删改规则都在 model.ts，方便单测。
 *
 * 持久化为什么用 workspaceState 而不是写仓库文件：
 *   - 用户要的是「随工作空间保存」，workspaceState 天然按工作空间隔离，
 *     换一个文件夹就是另一套树，不会把个人整理习惯提交进 git；
 *   - 值必须是可 JSON 序列化的普通对象，model.ts 的 store 正好满足。
 */

import * as fs from "node:fs";
import * as vscode from "vscode";

import { ArtifactCountBadgeProvider } from "./badge";
import {
  addArtifact,
  addFolder,
  addTree,
  artifactLabel,
  basenameFromUri,
  countArtifacts,
  findNode,
  flattenContainers,
  isArtifact,
  isContainer,
  moveNode,
  normalizeStore,
  removeNode,
  renameNode,
  type ArtifactNode,
  type ContainerEntry,
  type ContainerNode,
  type FolderNode,
  type FoundNode,
  type TreeNode,
  type TreeRoot,
  type TreeStore,
} from "./model";

export const TREE_STORAGE_KEY = "drawcode.artifactTrees.v1";

/** 内部拖拽载荷：只传 id，不传整棵子树，避免把过期快照拖进新状态。 */
const TREE_MIME = "application/vnd.code.tree.drawcode.artifacttrees";

export class ArtifactTreeProvider
implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode>, vscode.Disposable {
  static readonly viewType = "drawcode.artifactTrees";

  readonly dragMimeTypes: readonly string[] = [TREE_MIME, "text/uri-list"];
  readonly dropMimeTypes: readonly string[] = [TREE_MIME, "text/uri-list"];

  private store: TreeStore;
  private readonly emitter = new vscode.EventEmitter<void>();
  /** 串行落盘：快速拖多个节点时，最后一次写入必须是最后提交的状态。 */
  private writeChain: Promise<void> = Promise.resolve();
  private saveErrorShown = false;

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = normalizeStore(context.workspaceState.get(TREE_STORAGE_KEY));
  }

  // ── TreeDataProvider ───────────────────────────────────────────────────

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element.kind === "artifact" ? this.artifactItem(element) : this.containerItem(element);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element === undefined) return this.store.trees;
    return isContainer(element) ? element.children : [];
  }

  getParent(element: TreeNode): TreeNode | undefined {
    return findNode(this.store, element.id)?.parent;
  }

  private artifactItem(node: ArtifactNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      artifactLabel(node),
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.contextValue = "artifact";
    const parsed = this.parseUri(node.uri);
    const missing = parsed !== undefined && parsed.scheme === "file" && !fs.existsSync(parsed.fsPath);
    item.description = missing ? "文件不存在" : (node.alias.length > 0 ? basenameFromUri(node.uri) : undefined);
    item.tooltip = `${artifactLabel(node)}\n${node.uri}${missing ? "\n\n⚠ 文件不存在" : ""}`;
    if (parsed !== undefined) item.resourceUri = parsed;
    item.iconPath = missing
      ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"))
      : new vscode.ThemeIcon("file-binary");
    item.command = {
      command: "drawcode.tree.openArtifact",
      title: "打开程序集",
      arguments: [node],
    };
    return item;
  }

  private containerItem(node: ContainerNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.contextValue = node.kind;
    item.iconPath = new vscode.ThemeIcon(node.kind === "tree" ? "library" : "folder");
    // 计数交给 FileDecorationProvider 画在行尾；description 只留空，
    // 避免“3 个程序集”这种文字把行撑长。
    const count = countArtifacts(node);
    item.resourceUri = ArtifactCountBadgeProvider.uriFor(node.id);
    item.tooltip = [
      node.kind === "tree" ? `程序集树：${node.name}` : `分组：${node.name}`,
      `${count} 个程序集`,
    ].join("\n");
    return item;
  }

  // ── 查询与变更 ─────────────────────────────────────────────────────────

  getStore(): TreeStore {
    return this.store;
  }

  find(id: string): FoundNode | undefined {
    return findNode(this.store, id);
  }

  containers(): ContainerEntry[] {
    return flattenContainers(this.store);
  }

  createTree(name: string): TreeRoot | undefined {
    const result = addTree(this.store, name);
    return this.commit(result.store) ? result.node ?? undefined : undefined;
  }

  createFolder(parentId: string, name: string): FolderNode | undefined {
    const result = addFolder(this.store, parentId, name);
    return this.commit(result.store) ? result.node ?? undefined : undefined;
  }

  createArtifact(parentId: string, uri: string, alias: string): ArtifactNode | undefined {
    const result = addArtifact(this.store, parentId, uri, alias);
    return this.commit(result.store) ? result.node ?? undefined : undefined;
  }

  rename(id: string, name: string): boolean {
    return this.commit(renameNode(this.store, id, name));
  }

  remove(id: string): boolean {
    return this.commit(removeNode(this.store, id));
  }

  move(id: string, targetParentId: string): boolean {
    return this.commit(moveNode(this.store, id, targetParentId));
  }

  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private commit(next: TreeStore): boolean {
    if (next === this.store) return false;
    this.store = next;
    this.queueSave();
    this.emitter.fire();
    return true;
  }

  private queueSave(): void {
    // 捕获当前快照而不是在回调里读 this.store：排队期间还可能继续修改。
    const snapshot = this.store;
    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.context.workspaceState.update(TREE_STORAGE_KEY, snapshot);
        this.saveErrorShown = false;
      } catch (error) {
        console.error("drawcode: 保存程序集树失败", error);
        if (!this.saveErrorShown) {
          this.saveErrorShown = true;
          void vscode.window.showErrorMessage("程序集树保存失败，详见扩展宿主日志。");
        }
      }
    });
  }

  // ── 拖拽 ───────────────────────────────────────────────────────────────

  handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
    // 顶层“树”是视图根，拖动它没有合理落点，直接不提供内部载荷。
    const movable = source.filter((node) => node.kind !== "tree");
    if (movable.length === 0) return;
    dataTransfer.set(
      TREE_MIME,
      new vscode.DataTransferItem(JSON.stringify(movable.map((node) => node.id))),
    );
    const uris = movable.filter(isArtifact).map((node) => node.uri);
    if (uris.length > 0) {
      dataTransfer.set("text/uri-list", new vscode.DataTransferItem(uris.join("\r\n")));
    }
  }

  async handleDrop(
    target: TreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    // 内部拖拽优先：它同时带了 text/uri-list，若继续处理会重复添加。
    const internal = dataTransfer.get(TREE_MIME);
    if (internal !== undefined) {
      const ids = parseIdList(internal.value);
      if (ids.length === 0) return;
      const parentId = this.dropParentId(target) ?? this.createTree("程序集树")?.id;
      if (parentId === undefined) return;
      for (const id of ids) this.move(id, parentId);
      return;
    }

    // 从资源管理器拖进来的文件：按程序集加入，别名留空（显示文件名）。
    const external = dataTransfer.get("text/uri-list");
    if (external === undefined) return;
    const uris = parseUriList(external.value);
    if (uris.length === 0) return;
    const parentId = this.dropParentId(target) ?? this.createTree("程序集树")?.id;
    if (parentId === undefined) return;
    for (const uri of uris) this.createArtifact(parentId, uri.toString(), "");
  }

  /** 拖到程序集上时落到它所在的分组，符合“就近放入”的直觉。 */
  private dropParentId(target: TreeNode | undefined): string | undefined {
    if (target === undefined) return undefined;
    if (isContainer(target)) return target.id;
    return findNode(this.store, target.id)?.parent?.id;
  }

  private parseUri(value: string): vscode.Uri | undefined {
    try {
      return vscode.Uri.parse(value, true);
    } catch {
      return undefined;
    }
  }
}

function parseIdList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

function parseUriList(value: unknown): vscode.Uri[] {
  if (typeof value !== "string") return [];
  const uris: vscode.Uri[] = [];
  for (const line of value.split(/\r?\n/)) {
    const text = line.trim();
    // uri-list 规范允许 # 开头的注释行。
    if (text.length === 0 || text.startsWith("#")) continue;
    try {
      const uri = vscode.Uri.parse(text, true);
      if (uri.scheme === "file" || uri.scheme === "vscode-file") uris.push(uri);
    } catch {
      // 单行坏数据不影响其余文件。
    }
  }
  return uris;
}
