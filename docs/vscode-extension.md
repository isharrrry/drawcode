---
type: Guide
title: VS Code 扩展
description: Drawcode Artifact Viewer —— 在 VS Code 里只读浏览程序集的模块、类型、信号、函数与读写关系
tags: [vscode, extension, artifact, viewer]
status: stable
---

# VS Code 扩展

[← 文档索引](index.zh-CN.md)

在 VS Code 里打开 `.dll`、`.so`、`.out`、`.a`、`.o`，用可视化树浏览程序集里的模块、类型、
信号、函数与读写关系。

数据来自随扩展打包的解析核心：扩展与仓库里的 CLI 调用同一个 `readArtifact`
（`typescript/src/artifact/read.ts`），不启动外部 CLI，也不重新实现解析器。
扩展只按字节读取程序集，不加载、不执行被查看的文件。

## 前提

| 依赖 | 说明 |
|---|---|
| VS Code >= 1.90 | 自定义编辑器 API |
| .NET 10 运行时（或更高主版本） | 仅 PE/CLI 程序集（`.dll`）需要。sidecar 随扩展打包，但**不携带、不裁剪运行时**；ELF/ar 不需要 |

Node.js 不再是运行前提：扩展宿主自带 Node，解析核心以 CommonJS 随 VSIX 提供。

同一份 VSIX 同时用于 Windows 与 Linux：sidecar 是框架依赖的 `net10.0` 程序集，
由目标机的 `dotnet` 启动，安装包本身不含平台相关的运行时。

### 没有 .NET 时

打开 `.dll` 时如果找不到可用的 .NET 运行时，扩展不会停在空白页或一直“解析中”，
而是显示一张错误卡片，说明原因并给出当前平台的安装命令：

- Windows：`winget install Microsoft.DotNet.Runtime.10`
- Debian / Ubuntu：`sudo apt-get install -y dotnet-runtime-10.0`
- Fedora：`sudo dnf install -y dotnet-runtime-10.0`
- 其他发行版与离线安装包：<https://dotnet.microsoft.com/download/dotnet/10.0>

卡片上可以直接打开安装说明，或安装后点“重新检查”。查找 `dotnet` 的顺序是
`drawcode.dotnetPath` → `DRAWCODE_DOTNET` 环境变量 → `PATH` → `DOTNET_ROOT` →
Windows / Linux 常见安装目录（例如 `%ProgramFiles%\dotnet`、`/usr/share/dotnet`、
`/usr/lib/dotnet`、`~/.dotnet`、`/snap/bin`）。因此用 `dotnet-install.sh` 装在
用户目录、没有进 `PATH` 的场景也能自动找到。

Remote-SSH、WSL 与 Dev Container 下扩展运行在远端，请在远端安装；安装后通常需要
重新加载窗口，再点“重新检查”。

## 使用

1. 用 VS Code 打开 `editors/vscode` 目录。
2. `npm install`，再 `npm run build`（同时编译解析核心到 `dist/core/`）。
3. 按 `F5` 启动 Extension Development Host。
4. 在新窗口里双击任一程序集，或执行命令 `Drawcode: 打开程序集`。

打包安装：

```bash
npm run package   # 程序集为 out/drawcode-artifact-viewer-0.4.1.vsix
```

打包脚本会重新构建扩展、发布**框架依赖**的 `.NET` sidecar，并把 `dist/core`
与 sidecar 一起放进 VSIX；打包时会校验 runtimeconfig 不是自包含形态，确保
安装包里不出现 .NET 运行时。安装后无需配置路径，也不需要仓库在场；
`.dll` 解析仍要求目标机有 .NET 10+ 运行时。

## 程序集树（活动栏）

活动栏新增「Drawcode资源管理器」入口，里面是一棵按工作空间保存的程序集树：

- 顶层可以建多棵树，树内可以继续建多层分组；程序集可以挂在任意树或分组下。
- 程序集支持别名：`alias` 只影响显示，真实路径不变；留空则显示文件名。
- 点击程序集节点用本扩展的自定义编辑器打开，和双击 `.dll` 的行为一致。
- 标题栏按钮：新建树、从工作空间扫描程序集、把当前程序集加入树、刷新。
- 右键菜单：新建分组、添加程序集、重命名/设置别名、在文件管理器中显示、移除。
- 支持把资源管理器里的文件拖进树，也支持在树内拖动分组/程序集换位置。

树存在 `context.workspaceState` 的 `drawcode.artifactTrees.v1` 键里，随工作空间
隔离保存，不写进仓库，也不要求程序集仍然存在——路径失效时节点显示警告图标，
点击后可以“仍然尝试”或“从树中移除”。

## 三个视图

- **概览**：程序集信息（路径、格式、架构、种类、版本 / 文件版本 / 产品版本、
  目标框架、区域、入口、元数据版本、文件大小）、实体计数与诊断；诊断条目可点击
  跳转到对应实体。字段按读取器实际解析到的内容显示，没有的项不占位。
- **模块交联**：右侧是 wispkit 风格的多列级联表。第 1 列按模块层级展开到每个模块的
  首层输入/输出端口行（带「输出 / 输入」标记）；点击端口行打开第 2 列，列出该信号类型的
  字段；点击结构字段继续向右展开，直到基本类型或类型环。每一行的行号是跨列共享的
  纵坐标，字段列首行固定为父行 + 1，所以子列不会盖住父行。
- **持久化数据**：把元数据里标记 `Store` 的类型展开为 ER 表，字段可下钻到关联结构。

### 勾选与导出

- 在模块树里勾选端口后，右侧「信号 GroupBox」为每个信号生成一张定义表：
  字段树**默认展开全部层级**，表头固定显示 `序号 / 字段 / 初值 / 偏移 / 大小`
  （枚举类型把「初值」列改名为「值」，隐藏偏移与大小）。窄栏时类型 chip 自动
  让位给字段名，窗口拖宽或拖动分栏后自动恢复。
- 导出条位于模块树表头「模块 / 信号端口」右侧：左侧是「流可悬空」勾选框，
  中间是导出格式下拉框（Drawio / Mermaid / Markdown），右侧是「导出」按钮。
  格式与勾选随视图状态保存，默认 Drawio、默认不勾选。
- 默认导出会补出对端：只勾一端时，`buildPortFlow` 带出的 context 对端也进入
  导出图，保证每条数据流两端都有模块。
- 勾选「流可悬空」后，导出只创建**实际勾选**的一侧。对侧模块名不创建，
  只保留这条流：
  - Drawio 的边允许只有一端，悬空端用 `targetPoint` / `sourcePoint` 落在
    输出列右侧或输入列左侧的空白处；
  - Mermaid 的 `flowchart` / `sequenceDiagram` 语法要求两端都存在，因此用
    一个共享的 `void` 节点（时序图里是 `participant PV as void`）承接悬空端；
  - Markdown 内的两张 mermaid 图同上，信号定义章节也不会出现对侧模块。
- 格式选 **Drawio** 时生成 `.drawio`，默认文件名 `<程序集名>-模块交联.drawio`，
  默认目录就是程序集所在目录（可另存为）。导出布局与屏幕一致：每个模块拆成
  `模块路径-输出` / `模块路径-输入` 两个矩形，信号名作为连线标签，同信号多跳
  用虚线连接，正交曲线走线。
- 格式选 **Mermaid** 时生成 `.mmd`（`<程序集名>-模块交联.mmd`），内容是与
  Drawio 同构的 `flowchart LR`：每个模块拆成输出/输入两个节点，普通数据流用
  实线箭头，同信号关联用无箭头虚线并标注「同写 / 同读」。
- 格式选 **Markdown** 时生成 `.md`（`<程序集名>-模块交联.md`），依次包含：
  1. **部署交联图**：与 `.mmd` 相同的 mermaid 流程图；
  2. **时序图**：mermaid `sequenceDiagram`，参与者是参与本次导出的模块，
     消息按模块树当前阅读顺序排列（程序集元数据没有运行时时序，文档里会写明）；
  3. **信号定义**：按模块树的多层级标题（程序集 → 命名空间 → 类型）分组，
     每组一张信号定义表（信号 / 别名 / 方向 / 类型 / 单位 / 初值 / 标签 / 说明），
     结构体与枚举信号再附一张完整字段定义表（字段 / 类型 / 初值 / 偏移 / 大小）。

## 从源码生成 Drawio 图

在资源管理器里右键受支持的源码文件（`.cs`、`.c`、`.h` 等），菜单提供：

- **生成 Drawio 图**：在文件同目录写出 `<文件名>.drawio`（例如 `Adc.cs.drawio`）。
- **生成 Drawio 图并打开**：生成后立即用 draw.io 编辑器打开。

右键文件夹时，「生成 Drawio 图」会递归收集该目录下的所有源码（跳过
`node_modules`、`.git`、`.vs`、`.vscode`、`bin`、`obj`、`dist`），以合并模式
生成 `<文件夹名>.drawio`，与 CLI 的 `build --merge` 结果是同一份图。

交互约定：

- 左侧默认占 38%，拖动分隔条可在 10%–70% 之间调整。
- 模块行、分组行、端口行、字段行都可以勾选；勾选后左侧只画端口，不画模块或函数。
  一条边就是「某个输出端口行 → 某个输入端口行」。
- 只勾一端时，对端端口以虚线（context）补出，避免看到孤立节点不知道流向。
- 端口行整选等价于它的全部字段；勾选部分字段时端口复选框显示不确定态。
  关闭字段列时，该列里的字段勾选会一并移除。
- 点击端口行会在信息面板显示信号、读写函数与对端端口；点击空白只清除选中，不改动勾选。

## 设置

| 设置 | 默认 | 作用 |
|---|---|---|
| `drawcode.maxSizeMB` | 64 | 超过该大小先提示，不自动解析 |
| `drawcode.showExcluded` | false | 默认显示元数据标记 Exclude 的条目 |
| `drawcode.showCompilerGenerated` | false | 显示 `<Clone>$` 之类编译器生成的方法 |
| `drawcode.inferEdges` | false | ELF 缺少显式元数据时，用符号表与重定位补出推断边 |
| `drawcode.dotnetPath` | 空 | 自定义 `dotnet` 可执行文件路径；留空时自动查找（见上文“没有 .NET 时”） |

## 边界

- 模型按阈值切片：信号 + 函数超过 `drawcode.artifactSliceThreshold`（默认 2000）时按需下发。
- 解析始终在 worker 线程里进行，扩展宿主只收结构化克隆的结果，不阻塞 UI。
- 关联是纯静态分析结果（含元数据标注），不是运行时观测；`inferred` 会出现“推断”标记。
- 程序集是二进制，视图只读：不写回、不执行、不反编译代码段。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # 先 build，再跑 media/logic.js 与程序集树数据层测试
```

`media/logic.js` 不依赖 DOM，测试用 `node:vm` 加载它；`cascade.js`、`graph.js`、
`main.js` 是渲染与事件层。目录结构见仓库的 `editors/vscode/`。

## 相关

- [`artifact-format.md`](artifact-format.md) —— `inspect` 与扩展共用的 `ArtifactModel`
- [`templates.md`](templates.md#c-template-elf) —— 让 C / C# 产物带上声明层
