/**
 * 程序集树视图的命令层：输入框、文件选择、确认框都在这里。
 *
 * 命令与视图分开的原因：
 *   - provider 只认数据，命令可以在命令面板、右键菜单、标题栏三种入口复用；
 *   - 所有入口都可能不带参数（例如命令面板），这里统一用 view.selection
 *     兜底，避免出现“只有右键才可用”的半套功能。
 *
 * 每个命令处理器都保持短小：注册表只负责把入口接到函数上，流程本身
 * 放在下面按动作命名的函数里，便于单独阅读和替换。
 */

import * as fs from "node:fs";
import * as vscode from "vscode";

import { ARTIFACT_FILTERS } from "../artifactFilters";
import { activeArtifactUri, VIEW_TYPE } from "../editor";
import { ArtifactCountBadgeProvider } from "./badge";
import {
  artifactLabel,
  basenameFromUri,
  countArtifacts,
  isArtifact,
  isContainer,
  type ContainerEntry,
  type ContainerNode,
  type TreeNode,
  type TreeRoot,
} from "./model";
import { ArtifactTreeProvider } from "./provider";

interface ContainerPick extends vscode.QuickPickItem {
  entry: ContainerEntry;
}

interface ArtifactPick extends vscode.QuickPickItem {
  uri: vscode.Uri;
}

interface CommandDeps {
  provider: ArtifactTreeProvider;
  view: vscode.TreeView<TreeNode>;
  selected(arg?: TreeNode): TreeNode | undefined;
}

export function registerArtifactTree(context: vscode.ExtensionContext): vscode.TreeView<TreeNode> {
  const provider = new ArtifactTreeProvider(context);
  const view = vscode.window.createTreeView(ArtifactTreeProvider.viewType, {
    treeDataProvider: provider,
    dragAndDropController: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(view, provider);

  // 计数徽标：容器项的 resourceUri 是本 provider 提供的伪 URI，
  // 树一变就重算，避免拖入/移除后数字停在旧值。
  const badges = new ArtifactCountBadgeProvider((id) => {
    const found = provider.find(id);
    return found !== undefined && isContainer(found.node) ? countArtifacts(found.node) : 0;
  });
  context.subscriptions.push(
    badges,
    vscode.window.registerFileDecorationProvider(badges),
    provider.onDidChangeTreeData(() => badges.refresh()),
  );

  const deps: CommandDeps = {
    provider,
    view,
    selected: (arg) => arg ?? view.selection[0],
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("drawcode.tree.create", () => promptCreateTree(provider)),
    vscode.commands.registerCommand("drawcode.tree.addFolder", (arg?: TreeNode) => createFolder(deps, arg)),
    vscode.commands.registerCommand("drawcode.tree.addArtifact", (arg?: TreeNode) => pickArtifacts(deps, arg)),
    vscode.commands.registerCommand("drawcode.tree.scan", (arg?: TreeNode) => scanWorkspace(deps, arg)),
    vscode.commands.registerCommand("drawcode.tree.addActive", (arg?: TreeNode) => addActiveArtifact(deps, arg)),
    vscode.commands.registerCommand("drawcode.tree.rename", (arg?: TreeNode) => renameNode(deps, arg)),
    vscode.commands.registerCommand("drawcode.tree.remove", (arg?: TreeNode) => removeNode(deps, arg)),
    vscode.commands.registerCommand("drawcode.tree.openArtifact", (arg?: TreeNode) => openArtifact(deps.provider, arg ?? deps.selected())),
    vscode.commands.registerCommand("drawcode.tree.revealArtifact", (arg?: TreeNode) => revealArtifact(deps.selected(arg))),
    vscode.commands.registerCommand("drawcode.tree.refresh", () => provider.refresh()),
  );

  return view;
}

async function promptCreateTree(provider: ArtifactTreeProvider): Promise<TreeRoot | undefined> {
  const name = await vscode.window.showInputBox({
    title: "新建程序集树",
    prompt: "给这棵树起个名字，例如「示例程序集」",
    value: "程序集树",
    validateInput: validateRequiredName,
  });
  if (name === undefined) return undefined;
  return provider.createTree(name);
}

async function createFolder(deps: CommandDeps, arg?: TreeNode): Promise<void> {
  const parent = await resolveContainer(deps, arg);
  if (parent === undefined) return;
  const name = await vscode.window.showInputBox({
    title: `在「${parent.name}」下新建分组`,
    prompt: "分组名称",
    validateInput: validateRequiredName,
  });
  if (name === undefined) return;
  const folder = deps.provider.createFolder(parent.id, name);
  if (folder !== undefined) {
    await deps.view.reveal(folder, { expand: true, select: true, focus: false });
  }
}

async function pickArtifacts(deps: CommandDeps, arg?: TreeNode): Promise<void> {
  const parent = await resolveContainer(deps, arg);
  if (parent === undefined) return;
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    title: `添加程序集到「${parent.name}」`,
    filters: ARTIFACT_FILTERS,
  });
  if (picked === undefined || picked.length === 0) return;

  if (picked.length === 1) {
    await addOneArtifact(deps, parent, picked[0]);
    return;
  }
  // 多选时不逐个弹别名：先按文件名加入，用户之后可右键批量改名。
  for (const uri of picked) deps.provider.createArtifact(parent.id, uri.toString(), "");
}

/** 单个文件允许当场起别名；保留文件名视为“没有别名”。 */
async function addOneArtifact(
  deps: CommandDeps,
  parent: ContainerNode,
  uri: vscode.Uri,
): Promise<void> {
  const base = basenameFromUri(uri.toString());
  const alias = await vscode.window.showInputBox({
    title: `「${base}」的别名`,
    prompt: "留空则显示文件名；之后可右键重命名",
    value: base,
  });
  if (alias === undefined) return;
  deps.provider.createArtifact(parent.id, uri.toString(), alias.trim() === base ? "" : alias);
}

async function scanWorkspace(deps: CommandDeps, arg?: TreeNode): Promise<void> {
  const parent = await resolveContainer(deps, arg);
  if (parent === undefined) return;
  const found = await vscode.workspace.findFiles(
    "**/*.{dll,so,out,a,o}",
    "**/{node_modules,.git,obj,bin}/**",
    500,
  );
  if (found.length === 0) {
    void vscode.window.showInformationMessage("工作空间里没有找到 .dll/.so/.out/.a/.o 程序集。");
    return;
  }
  if (found.length >= 500) {
    void vscode.window.showWarningMessage("程序集较多，只列出了前 500 个；可缩小工作空间或用「添加程序集」逐个选择。");
  }

  const picks = found.map((uri): ArtifactPick => ({
    label: basenameFromUri(uri.toString()),
    description: vscode.workspace.asRelativePath(uri, false),
    uri,
  }));
  const chosen = await vscode.window.showQuickPick(picks, {
    title: `从工作空间加入「${parent.name}」`,
    placeHolder: "可多选；别名先按文件名，之后可右键修改",
    canPickMany: true,
  });
  if (chosen === undefined) return;
  for (const pick of chosen) deps.provider.createArtifact(parent.id, pick.uri.toString(), "");
}

async function addActiveArtifact(deps: CommandDeps, arg?: TreeNode): Promise<void> {
  const uri = activeArtifactUri();
  if (uri === undefined) {
    void vscode.window.showInformationMessage("当前没有 Drawcode 程序集视图，请先打开一个 .dll/.so/.out/.a/.o 程序集。");
    return;
  }
  const parent = await resolveContainer(deps, arg);
  if (parent === undefined) return;
  const base = basenameFromUri(uri.toString());
  const alias = await vscode.window.showInputBox({
    title: `把「${base}」加入「${parent.name}」`,
    prompt: "别名，留空显示文件名",
    value: "",
  });
  if (alias === undefined) return;
  deps.provider.createArtifact(parent.id, uri.toString(), alias.trim() === base ? "" : alias);
}

async function renameNode(deps: CommandDeps, arg?: TreeNode): Promise<void> {
  const node = deps.selected(arg);
  if (node === undefined) {
    void vscode.window.showInformationMessage("请先在程序集树中选择一个树、分组或程序集。");
    return;
  }
  if (isArtifact(node)) {
    await renameArtifact(deps.provider, node);
    return;
  }
  const value = await vscode.window.showInputBox({
    title: `重命名「${node.name}」`,
    value: node.name,
    validateInput: validateRequiredName,
  });
  if (value === undefined) return;
  deps.provider.rename(node.id, value);
}

async function renameArtifact(provider: ArtifactTreeProvider, node: TreeNode): Promise<void> {
  if (!isArtifact(node)) return;
  const base = basenameFromUri(node.uri);
  const value = await vscode.window.showInputBox({
    title: `设置「${base}」的别名`,
    prompt: "留空恢复显示文件名",
    value: node.alias,
  });
  if (value === undefined) return;
  provider.rename(node.id, value.trim() === base ? "" : value);
}

async function removeNode(deps: CommandDeps, arg?: TreeNode): Promise<void> {
  const node = deps.selected(arg);
  if (node === undefined) {
    void vscode.window.showInformationMessage("请先在程序集树中选择要移除的节点。");
    return;
  }
  const label = isArtifact(node) ? artifactLabel(node) : node.name;
  const nested = isContainer(node) ? countArtifacts(node) : 0;
  const detail = nested > 0 ? `，其中包含 ${nested} 个程序集` : "";
  const confirmed = await vscode.window.showWarningMessage(
    `从程序集树移除「${label}」${detail}？`,
    { modal: true },
    "移除",
  );
  if (confirmed !== "移除") return;
  deps.provider.remove(node.id);
}

async function openArtifact(provider: ArtifactTreeProvider, node?: TreeNode): Promise<void> {
  if (node === undefined || !isArtifact(node)) {
    // 命令面板里没有树节点参数时，退化为“打开当前正在看的程序集”，
    // 与扩展原有的打开命令行为一致。
    const uri = activeArtifactUri();
    if (uri === undefined) {
      void vscode.window.showInformationMessage("请选择一个程序集，或先打开一个程序集视图。");
      return;
    }
    await openUri(uri);
    return;
  }

  const uri = parseUri(node.uri);
  if (uri === undefined) {
    void vscode.window.showErrorMessage(`程序集路径无效：${node.uri}`);
    return;
  }
  if (uri.scheme === "file" && !fs.existsSync(uri.fsPath)) {
    const action = await vscode.window.showWarningMessage(
      `文件不存在：${uri.fsPath}`,
      "仍然尝试",
      "从树中移除",
    );
    if (action === "从树中移除") {
      provider.remove(node.id);
      return;
    }
    if (action !== "仍然尝试") return;
  }
  await openUri(uri);
}

async function revealArtifact(node: TreeNode | undefined): Promise<void> {
  if (node === undefined || !isArtifact(node)) {
    void vscode.window.showInformationMessage("请选择一个程序集节点。");
    return;
  }
  const uri = parseUri(node.uri);
  if (uri === undefined) {
    void vscode.window.showErrorMessage(`程序集路径无效：${node.uri}`);
    return;
  }
  try {
    await vscode.commands.executeCommand("revealFileInOS", uri);
  } catch (error) {
    void vscode.window.showErrorMessage(`无法在文件管理器中显示：${messageOf(error)}`);
  }
}

/**
 * 决定「加到哪」：优先当前选中项；选中的是程序集就落到它的父分组；
 * 什么都没选就从所有树/分组里挑，没有树时顺手引导新建。
 */
async function resolveContainer(deps: CommandDeps, arg?: TreeNode): Promise<ContainerNode | undefined> {
  const node = arg ?? deps.view.selection[0];
  if (node !== undefined) {
    if (isContainer(node)) return node;
    const found = deps.provider.find(node.id);
    if (found?.parent !== undefined) return found.parent;
  }
  return pickContainer(deps.provider);
}

async function pickContainer(provider: ArtifactTreeProvider): Promise<ContainerNode | undefined> {
  const entries = provider.containers();
  if (entries.length === 0) {
    const action = await vscode.window.showInformationMessage(
      "还没有程序集树。先建一棵，再把程序集放进去？",
      "新建程序集树",
    );
    if (action !== "新建程序集树") return undefined;
    return promptCreateTree(provider);
  }
  const picked = await vscode.window.showQuickPick(
    entries.map((entry): ContainerPick => ({
      label: `${"  ".repeat(entry.depth)}${entry.node.name}`,
      description: entry.depth === 0 ? "树" : "分组",
      detail: entry.path.length > 0 ? entry.path.join(" / ") : undefined,
      entry,
    })),
    { title: "选择目标树或分组", placeHolder: "程序集会加到所选项下面" },
  );
  return picked?.entry.node;
}

async function openUri(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
  } catch (error) {
    void vscode.window.showErrorMessage(`打开程序集失败：${messageOf(error)}`);
  }
}

function parseUri(value: string): vscode.Uri | undefined {
  try {
    return vscode.Uri.parse(value, true);
  } catch {
    return undefined;
  }
}

function validateRequiredName(value: string): string | undefined {
  return value.trim().length === 0 ? "名称不能为空" : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
