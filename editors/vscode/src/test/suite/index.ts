/**
 * 端到端断言（运行在真实扩展宿主内）。
 *
 * 三条链路，分别对应一类「单元测试覆盖不到」的失败：
 *
 *   1. 程序集 → `vscode.openWith` → 自定义编辑器标签 → webview 回执 initAck。
 *      验证 contributes、自定义编辑器注册、webview 脚本与 CSP、宿主解析 CLI
 *      的完整链路。夹具用模板示例 `app.o`：模块 1、信号 2、函数 2、边 3。
 *   2. 非程序集 `.txt` → `vscode.open` → 文本编辑器标签。
 *      验证自定义编辑器的 selector 没有越界吞掉普通文件。
 *   3. 阈值设为 0 → 强制切片 → initAck.sliced 为真、总量仍是真实值。
 *      验证「大模型才走切片」不是一条只有单测跑过的死路径。
 *
 * 这里不用 mocha：VS Code 只要求模块导出 `run()`，失败直接抛异常即可。
 * 少一层依赖，测试宿主里能少一类「找不到 describe」的启动噪音。
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import type { DrawcodeApi } from "../../extension";

const VIEW_TYPE = "drawcode.artifact";
const EXTENSION_ID = "harrrry.drawcode-artifact-viewer";
const ARTIFACT_RELATIVE = "../../templates/c/example/app.o";

/** 示例程序集 `app.o` 的期望值；与模板示例源码一一对应，改示例时同步改这里。 */
const EXPECTED_TOTALS = {
  modules: 1,
  types: 1,
  signals: 2,
  funcs: 2,
  edges: 3,
  storeTypes: 0,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询直到 probe 返回真值。
 *
 * 为什么不用固定 sleep：VS Code 的标签创建是异步的，机器快慢差异很大；
 * 固定等待要么慢，要么在忙时偶发失败。轮询把「等到出现」写成显式契约。
 */
async function waitFor<T>(
  what: string,
  probe: () => T | undefined,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs} ms）：${what}`);
    await sleep(100);
  }
}

/** 当前活动标签如果是自定义编辑器，返回它的 input。 */
function activeCustomTab(): vscode.TabInputCustom | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom ? input : undefined;
}

/** 当前活动标签如果是文本编辑器，返回它的 input。 */
function activeTextTab(): vscode.TabInputText | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputText ? input : undefined;
}

async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  // 关闭是命令式的，标签组更新不一定在 Promise 返回的同一 tick 完成。
  await waitFor("所有编辑器关闭", () =>
    vscode.window.tabGroups.all.every((group) => group.tabs.length === 0) ? true : undefined,
  );
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<DrawcodeApi>(EXTENSION_ID);
  assert.ok(extension, `找不到扩展 ${EXTENSION_ID}（extensionDevelopmentPath 是否指向 editors/vscode？）`);
  const api = await extension.activate();
  assert.equal(typeof api.waitForInitAck, "function", "activate 必须导出 waitForInitAck");

  const artifactPath = path.resolve(extension.extensionPath, ARTIFACT_RELATIVE);
  assert.ok(fs.existsSync(artifactPath), `夹具不存在：${artifactPath}（先运行模板示例的构建）`);
  const artifact = vscode.Uri.file(artifactPath);

  // —— 1. 程序集走自定义编辑器，webview 回执与模型总量一致 ——
  await closeAllEditors();
  await vscode.commands.executeCommand("vscode.openWith", artifact, VIEW_TYPE);
  const customTab = await waitFor("程序集自定义编辑器标签", activeCustomTab);
  assert.equal(customTab.viewType, VIEW_TYPE, "打开程序集后活动标签应是 drawcode.artifact");

  const fullAck = await api.waitForInitAck(artifact, 60_000);
  assert.equal(fullAck.modules, EXPECTED_TOTALS.modules, "webview 收到的模块数");
  assert.equal(fullAck.sliced, false, "默认阈值下小程序集应整份下发");
  assert.deepEqual(fullAck.totals, EXPECTED_TOTALS, "webview 数出的模型总量");
  console.log("[drawcode-e2e] 自定义编辑器 + initAck：通过", JSON.stringify(fullAck));

  // —— 2. 非程序集文件不能被自定义编辑器接管 ——
  await closeAllEditors();
  const textFile = path.join(os.tmpdir(), `drawcode-e2e-${process.pid}.txt`);
  fs.writeFileSync(textFile, "drawcode e2e plain text\n", "utf8");
  const textUri = vscode.Uri.file(textFile);
  try {
    await vscode.commands.executeCommand("vscode.open", textUri);
    const textTab = await waitFor("普通文本编辑器标签", activeTextTab);
    assert.equal(textTab.uri.toString(), textUri.toString(), "活动文本编辑器应是刚打开的文件");
    console.log("[drawcode-e2e] 非程序集走默认编辑器：通过");
  } finally {
    await closeAllEditors();
    fs.rmSync(textFile, { force: true });
  }

  // —— 3. 阈值 0 强制切片：结构照发，实体延后 ——
  const config = vscode.workspace.getConfiguration("drawcode");
  await config.update("artifactSliceThreshold", 0, vscode.ConfigurationTarget.Global);
  try {
    await vscode.commands.executeCommand("vscode.openWith", artifact, VIEW_TYPE);
    const slicedAck = await api.waitForInitAck(artifact, 60_000);
    assert.equal(slicedAck.sliced, true, "阈值 0 时必须走切片路径");
    assert.equal(slicedAck.modules, EXPECTED_TOTALS.modules, "切片不减少模块骨架");
    // 切片 init 只发骨架，总量由宿主随 init 一起给出；webview 必须原样带回。
    assert.deepEqual(slicedAck.totals, EXPECTED_TOTALS, "切片模式下回执总量");
    console.log("[drawcode-e2e] 切片 init 回执：通过", JSON.stringify(slicedAck));
  } finally {
    await config.update("artifactSliceThreshold", undefined, vscode.ConfigurationTarget.Global);
    await closeAllEditors();
  }

  console.log("[drawcode-e2e] 全部通过");
}
