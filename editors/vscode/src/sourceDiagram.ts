/**
 * 资源管理器右键：把 C / C# 源码生成为 draw.io。
 *
 * 与程序集视图的区别：
 *   - 程序集视图读的是**编译产物**，命令这里读的是**源码**；
 *   - 源码解析核心已经在仓库的 `typescript/src` 里，扩展构建时编到
 *     `dist/core`，这里用 `require` 复用同一份实现（和 `coreWorker.ts` 一致）。
 *
 * 输出约定：
 *   - 单个文件 `Foo.cs`  → 同目录 `Foo.cs.drawio`；
 *   - 文件夹 `demo/`     → `demo/demo.drawio`，递归合并目录内所有支持的源码。
 *
 * 为什么不问用户要输出路径：右键菜单的预期就是“就地生成”。用户想改名或
 * 换位置可以在生成后自己移动文件；多一步保存对话框反而打断批量操作。
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const C_EXT = new Set([".c", ".h", ".cpp", ".hpp", ".cc", ".hh"]);
const CS_EXT = new Set([".cs"]);
const SUPPORTED = new Set([...C_EXT, ...CS_EXT]);
/** 递归扫描时跳过的目录：这些目录里的源码通常是生成物或第三方依赖。 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".vs", ".vscode", "bin", "obj", "dist"]);

interface ParseCore {
  parseAny(paths: string[], root?: string): unknown;
}

interface DrawioCore {
  toDrawio(model: unknown, cards?: boolean, rwLabels?: boolean, straightEdges?: boolean): string;
}

function coreModule<T>(name: string): T {
  // `__dirname` 在编译后是扩展的 `dist/`；`core` 由 tsconfig.core.json 产出。
  return require(path.join(__dirname, "core", name)) as T;
}

function isSupported(filePath: string): boolean {
  return SUPPORTED.has(path.extname(filePath).toLowerCase());
}

/**
 * 递归收集源码。符号链接不跟随：避免工作区里指向父目录的链接把扫描带出边界。
 */
async function collectSources(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectSources(full, out);
      continue;
    }
    if (entry.isFile() && isSupported(full)) out.push(full);
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

function buildDrawio(files: string[], root: string): string {
  const parse = coreModule<ParseCore>("parse.js");
  const drawio = coreModule<DrawioCore>("drawio.js");
  const model = parse.parseAny(files, root);
  // 默认参数：卡片式节点、显示读写标签、正交连线。与 CLI `build` 的默认一致。
  return drawio.toDrawio(model, false, true, false);
}

function targetFor(uri: vscode.Uri, isFolder: boolean): vscode.Uri {
  if (isFolder) {
    return vscode.Uri.file(path.join(uri.fsPath, `${path.basename(uri.fsPath)}.drawio`));
  }
  return vscode.Uri.file(`${uri.fsPath}.drawio`);
}

async function generate(uri: vscode.Uri, openAfter: boolean): Promise<void> {
  const stat = await fs.stat(uri.fsPath);
  const isFolder = stat.isDirectory();
  if (!isFolder && !isSupported(uri.fsPath)) {
    void vscode.window.showErrorMessage("Drawcode: 只支持 .cs 与 C/C++ 源码文件。");
    return;
  }

  const target = targetFor(uri, isFolder);
  try {
    const xml = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: isFolder ? "扫描源码并生成 Drawio…" : "生成 Drawio…",
        cancellable: false,
      },
      async () => {
        const files = isFolder ? await collectSources(uri.fsPath) : [uri.fsPath];
        if (files.length === 0) {
          throw new Error("目录下没有可解析的 .cs / .c / .h / .cpp 源码");
        }
        return buildDrawio(files, isFolder ? uri.fsPath : path.dirname(uri.fsPath));
      },
    );

    await fs.writeFile(target.fsPath, xml, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Drawcode 生成失败：${message}`);
    return;
  }

  if (openAfter) {
    await vscode.commands.executeCommand("vscode.open", target);
    return;
  }

  const action = await vscode.window.showInformationMessage(
    `已生成 ${path.basename(target.fsPath)}`,
    "打开",
  );
  if (action === "打开") {
    await vscode.commands.executeCommand("vscode.open", target);
  }
}

/** 命令入口：参数由 `explorer/context` 注入；从命令面板调用时没有参数。 */
async function run(arg: unknown, openAfter: boolean): Promise<void> {
  const uri = arg instanceof vscode.Uri ? arg : undefined;
  if (uri === undefined) {
    void vscode.window.showInformationMessage(
      "请在资源管理器里右键一个源码文件或文件夹，再选择生成 Drawio。",
    );
    return;
  }
  await generate(uri, openAfter);
}

export function registerSourceDiagramCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("drawcode.generateSourceDiagram", (uri: unknown) =>
      run(uri, false),
    ),
    vscode.commands.registerCommand("drawcode.generateSourceDiagramAndOpen", (uri: unknown) =>
      run(uri, true),
    ),
  );
}
