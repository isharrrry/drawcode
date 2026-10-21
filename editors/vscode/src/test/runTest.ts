/**
 * 端到端测试的启动器（在普通 Node 里跑，不在扩展宿主里）。
 *
 * 为什么不用无头浏览器 + 假 webview：那条路能验证 DOM，却验证不了 VS Code
 * 真正的注册链路——`contributes.customEditors`、`vscode.openWith`、
 * webview 的 CSP 与资源 URI 重写、`retainContextWhenHidden`。这些恰好是
 * 「扩展装进 VS Code 之后」才会暴露的问题，只能起一个真实的扩展宿主。
 *
 * 可执行文件默认取本机安装的 VS Code；换机器时用环境变量覆盖：
 *   DRAWCODE_VSCODE=/path/to/Code.exe npm run test:e2e
 */

import * as path from "node:path";

import { runTests } from "@vscode/test-electron";

/** 本机已验证的 VS Code；找不到时 test-electron 会尝试下载，但国内网络很慢。 */
const DEFAULT_VSCODE = "F:/app/VSCodeEXE/Code.exe";

async function main(): Promise<void> {
  // 关键：Claude Code / 其他 Electron 宿主常把 ELECTRON_RUN_AS_NODE=1 注入环境，
  // Code.exe 继承后会**按 Node 解释器运行**，把所有 VS Code 参数都当成 node 参数，
  // 报一串 "bad option"。这里必须显式删掉，让 Code.exe 回到正常的 Electron 模式。
  delete process.env.ELECTRON_RUN_AS_NODE;

  // __dirname 编译后是 <extension>/dist/test，向上一级是 dist，再上一级才是扩展根。
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index.js");
  const vscodeExecutablePath = process.env.DRAWCODE_VSCODE ?? DEFAULT_VSCODE;

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    // --disable-extensions：测试只加载本扩展，避免机器上其他扩展抢注册自定义编辑器。
    // --disable-workspace-trust：临时工作区不弹信任对话框，否则测试会卡在首屏。
    launchArgs: ["--disable-extensions", "--disable-gpu", "--disable-workspace-trust"],
  });
}

main().catch((error: unknown) => {
  console.error("[drawcode-e2e] 失败：", error);
  process.exitCode = 1;
});
