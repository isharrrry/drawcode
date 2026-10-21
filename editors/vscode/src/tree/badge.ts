/**
 * 活动栏树的计数徽标。
 *
 * VS Code 的 TreeItem 没有“右侧徽标”字段。原生能画带底色小徽标的入口只有
 * FileDecorationProvider：给容器项挂一个自定义 scheme 的 resourceUri，
 * 由 provider 返回 badge 文本，工作台就会把它画在行尾。
 *
 * 为什么不用 TreeItem.description：
 *   description 紧跟在标签后面，不会贴右；而用户要的是“靠右的圆形数字”。
 *   徽标颜色用主题的 badge.background，浅色/深色主题都能读。
 */

import * as vscode from "vscode";

const SCHEME = "drawcode-count";

export class ArtifactCountBadgeProvider
implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();

  readonly onDidChangeFileDecorations = this.emitter.event;

  /**
   * @param countOf 由树 provider 提供的计数函数：传入容器 id，返回子树里的程序集数。
   */
  constructor(private readonly countOf: (id: string) => number) {}

  /** 容器项挂这个 URI，FileDecorationProvider 才会被问到。 */
  static uriFor(id: string): vscode.Uri {
    return vscode.Uri.parse(`${SCHEME}:/${encodeURIComponent(id)}`, true);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SCHEME) return undefined;

    let id: string;
    try {
      id = decodeURIComponent(uri.path.replace(/^\//, ""));
    } catch {
      return undefined; // 手工改坏的 URI 不该让整棵树报错
    }

    const count = this.countOf(id);
    if (!Number.isFinite(count) || count <= 0) return undefined;

    return {
      badge: String(count),
      color: new vscode.ThemeColor("badge.background"),
      tooltip: `${count} 个程序集`,
    };
  }

  /** 树内容变化后重算所有徽标；挂到 provider 的 onDidChangeTreeData 上。 */
  refresh(): void {
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
