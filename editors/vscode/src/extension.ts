/**
 * 扩展入口：只做注册，不含解析与渲染逻辑。
 *
 * 命令的定位：
 *   - `drawcode.openArtifact`：用户主动挑一个程序集，按自定义编辑器打开；
 *   - `drawcode.inspectArtifact`：把当前程序集的规范 JSON 复制到剪贴板，
 *     方便贴进 issue 或与 `drawcode inspect` 的输出比对；
 *   - `drawcode.refreshArtifact`：程序集被重新编译后，不关标签直接刷新。
 *
 * 自定义编辑器是 `priority: default`：双击 .dll/.so/.out/.a/.o 时默认用本视图，
 * 但仍可右键 “打开方式” 选择文本编辑器。没有 `drawcode.enabled` 开关：
 * contributes 是静态声明，运行时“禁用”只会让关联指向一个不存在的 provider，
 * 用户真正需要的是 VS Code 自带的 `workbench.editorAssociations`。
 */

import * as path from "node:path";
import * as vscode from "vscode";

import { ARTIFACT_FILTERS } from "./artifactFilters";
import { loadArtifactModel, readSettings } from "./modelLoader";
import { registerSourceDiagramCommands } from "./sourceDiagram";
import { registerArtifactTree } from "./tree";
import {
  activeArtifactUri,
  ArtifactEditorProvider,
  getHandle,
  getInitAck,
  VIEW_TYPE,
  waitForInitAck,
  type InitAck,
} from "./editor";

/**
 * 暴露给其他扩展与端到端测试的 API。
 *
 * 为什么不把测试钩子做成命令：命令会进命令面板，用户能点到却没有意义；
 * `extension.exports` 是 VS Code 给扩展间调用留的正门，测试宿主恰好也能拿到。
 */
export interface DrawcodeApi {
  getInitAck(uri: vscode.Uri): InitAck | undefined;
  waitForInitAck(uri: vscode.Uri, timeoutMs?: number): Promise<InitAck>;
}

async function pickArtifact(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: "选择程序集",
    filters: ARTIFACT_FILTERS,
  });
  return picked?.[0];
}

export function activate(context: vscode.ExtensionContext): DrawcodeApi {
  // 活动栏程序集树：与自定义编辑器共用同一份程序集解析核心，点击节点只是
  // 再走一次 vscode.openWith，不复制任何解析逻辑。
  registerArtifactTree(context);
  // 源码右键生成：与程序集树互不依赖，单独注册。
  registerSourceDiagramCommands(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new ArtifactEditorProvider(context), {
      // 切标签不销毁 webview：重新解析一个 50 MB 的 DLL 代价远大于保留一份 DOM。
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("drawcode.openArtifact", async () => {
      const uri = await pickArtifact();
      if (uri === undefined) return;
      await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    }),

    vscode.commands.registerCommand("drawcode.inspectArtifact", async () => {
      const uri = activeArtifactUri() ?? (await pickArtifact());
      if (uri === undefined) return;

      let json = getHandle(uri)?.modelJson() ?? "";
      if (json.length === 0) {
        try {
          const loaded = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "解析程序集…",
              cancellable: true,
            },
            (_progress, token) => loadArtifactModel(uri, context, token, readSettings()),
          );
          json = loaded.json;
        } catch (error) {
          // 用户关掉进度通知 = 取消，不是失败；弹红条只会让人以为出错了。
          if (error instanceof Error && error.name === "AbortError") return;
          void vscode.window.showErrorMessage(
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
      }

      await vscode.env.clipboard.writeText(json);
      void vscode.window.showInformationMessage(
        `已复制 ${path.basename(uri.fsPath)} 的 ArtifactModel JSON（${json.length} 字符）`,
      );
    }),

    vscode.commands.registerCommand("drawcode.refreshArtifact", async () => {
      const uri = activeArtifactUri();
      if (uri === undefined) {
        void vscode.window.showInformationMessage("当前编辑器不是 Drawcode 程序集视图。");
        return;
      }
      await getHandle(uri)?.refresh();
    }),
  );

  return { getInitAck, waitForInitAck };
}

export function deactivate(): void {
  // 自定义编辑器与命令都由 context.subscriptions 释放。
}
