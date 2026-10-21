---
type: Guide
title: 贡献
description: 环境、跑测试、重生成金标准、给工具加一门源语言，以及刻意未验证事项的清单
tags: [contributing, testing, workflow]
status: stable
---

# 贡献

[English](contributing.md) | **中文** | [Español](contributing.es.md)

[← 文档索引](index.zh-CN.md)

仓库只有一套实现。让改动可评审的规则很简单：**可以改“算得多快”，不能改“算出什么”。** IR 或几何一变，金标准就会出现 diff，评审就该发生在那里。

## 环境

| 工具链 | 版本要求 | 用途 |
| :--- | :--- | :--- |
| Node | 22.6 或更高 | 实现、测试、`tools/render/` |
| .NET SDK / 运行时 | 10 | 仅 PE 元数据 sidecar（`tools/drawcode-metadata`） |

解析、布局、路由与 XML 写出只用 Node 标准库。`npm run typecheck` 需要 `typescript` 这个
devDependency，但它不在测试路径上。PE sidecar 是独立的 net10.0 工程：没有 .NET 10 时，
`.dll` 的 `inspect` 会报 `tool-unavailable`，ELF/ar 读取仍在进程内完成。

## 仓库地图

| 路径 | 内容 |
| :--- | :--- |
| [`typescript/`](../typescript/) | 实现：`cparse.ts`、`csparse.ts`、`model.ts`、`drawio.ts`、`codegen.ts`、`svg.ts`、`cli.ts`、`artifact/` |
| [`typescript/test/`](../typescript/test/) | 测试套件：单元、conformance、产物、XSD、CLI；在 `typescript/` 下 `node --test` |
| [`editors/vscode/`](../editors/vscode/) | 自定义编辑器、webview 与资源管理器命令 |
| [`tools/golden/`](../tools/golden/) | 金标准：输入源码、期望 IR、期望图、预览 |
| [`tools/drawcode-metadata/`](../tools/drawcode-metadata/) | PE/CLI 产物的 .NET 10 sidecar；`dotnet build` 构建，`tools/publish-metadata-tool.mjs` 发布 |
| [`tools/xsd/mxfile.xsd`](../tools/xsd/mxfile.xsd) | 随仓库内置的 draw.io Schema，保证校验测试不跳过；来源见 [`tools/xsd/NOTICE.md`](../tools/xsd/NOTICE.md) |
| [`tools/render/`](../tools/render/) | 离线 `.drawio` → SVG/PNG 渲染器（见[离线渲染](#离线渲染)） |
| [`templates/`](../templates/) | C 与 C# 元数据模板（用法见 [元数据模板](templates.md)） |
| [`examples/`](../examples/) | C 与 C# 样例工程（走查见 [示例](examples.md)） |
| [`openspec/`](../openspec/) | 变更记录与规格 |

`tools/` 下的东西一律是**仓库资产，不是随包发布的产物**：不进 npm 包、不进运行时依赖图、
也不在测试发现路径上。只有两个例外会跟着某个产品走 —— `drawcode-metadata` 由
`editors/vscode/scripts/package-vsix.mjs` 发布进 VSIX，`golden/` 被测试套件读取。

## 跑测试

```bash
cd typescript && node --test                              # 211 条，3 条跳过
cd editors/vscode && node --test test/*.test.mjs          # 79 条
```

失败会按层报出来——解析、IR/边、`.drawio` 读写、代码生成、Schema、SVG、conformance——与
[`conformance.md`](conformance.md) 的层次对应。

**跳过的测试比失败的测试更糟。** 一致性资源随仓库内置；缺金标准文件必须显式失败，不能算通过。

## 离线渲染

`tools/render/` 用 **draw.io 自己的渲染内核 mxGraph** 把 `.drawio` 出成 SVG 或 PNG，
不需要装 draw.io 桌面版，也不需要 GUI。它是手工验证工具：不在 CLI 路径上，不进 npm 包，
也不参与任何测试。

```bash
cd tools/render
npm install

node render_drawio.js input.drawio output.svg 10      # .drawio -> SVG（mxGraph）
node render_png.js     output.svg   output.png 2022   # SVG -> PNG（resvg）

# 局部放大，用于肉眼复核大图上的小字（只改 viewBox，正文不动）
node zoom_svg.js       input.svg    zoom.svg 120 80 640 360 3
```

不用自己重画：手写 SVG 会在中文换行、箭头裁剪、正交路由圆角、连线避让上全面失真，
而这些正是 mxGraph 已经做对的。Windows 上要用 `npm.cmd`，PowerShell 的默认执行策略
会拒绝 `npm.ps1`。

`mxgraph@4.2.2` 上游已弃用（jgraph 归档了它，转向 maxGraph）。这是刻意接受的：
draw.io 桌面版本身就基于这个引擎，用它才能保证离线渲染与客户端一致；风险被限制在本目录。
两条限制是真的，记在[刻意未验证的事项](#刻意未验证的事项)：画不出 `jumpStyle=arc` 跳线，
中文宽度是估算的。把设计逼成现在这样的五个失败，写在
[`notes/drawio-render-pitfalls.md`](notes/drawio-render-pitfalls.md)。

## 加一个金标准案例

金标准是 `tools/golden/<name>/` 下自包含的目录：

```
tools/golden/small-c/
├── input/                 # 源码
├── expected.ir.json       # L1
├── expected.drawio        # L2 + L3
└── preview.svg            # 结构比较
```

IR 金标准由 CLI 生成，不手写：

```bash
node typescript/bin/drawcode.ts dump-ir \
    tools/golden/small-c/input/adc.h tools/golden/small-c/input/adc.c \
    tools/golden/small-c/input/dsp.h tools/golden/small-c/input/dsp.c \
    --root tools/golden/small-c/input \
    --out tools/golden/small-c/expected.ir.json
```

它刻意**不记录布局坐标**：布局属于 `.drawio` 层，混进来会让路由 bug 看起来像解析 bug。

`expected.drawio` 由实现生成，经人工审阅后提交。**只有刻意的行为变更才重生成金标准**，并在提交信息里写清动了哪一层；说不出原因的金标准变化就是回归。

## 加一门源语言

1. 在 `cparse.ts` 旁加一个解析模块——例如 Rust 的 `rsparse.ts`——暴露
   `parseRsProject(paths, root): Model`。
2. **复用现有 IR。** 不要另造并行数据结构。
3. 决定该语言如何表达方向（C 用注释里的 `dir=`，C# 用位置特性参数）。
4. 在 `parse.ts` 按扩展名分派。
5. 在 `codegen.ts` 加对应的声明层回写，并从 `syncSource` 分派。
6. 在 `examples/small/<lang>/` 加样例与测试；语法形态是新的就加金标准。
7. 更新 [`conformance.md`](conformance.md) 的能力清单。

**不要在 `drawio.ts` 里加语言分支。** 图是 IR 的像，IR 与语言无关。

## 几何契约

几何是精确比较的，所以改路由就会动金标准。改动 `route`、`candidates`、`crossGap` 或
`assignDefaultPositions` 后，重生成受影响的 `.drawio`，审阅 diff，再跑全套测试。给障碍查询
加空间索引是受欢迎的；路由结果不同则是规范变更。

## 刻意未验证的事项

| 未验证 | 原因与影响 |
| :--- | :--- |
| **PE 产物需要 .NET 10。** | sidecar 是独立 net10.0 工程；没有它，`.dll` 的 `inspect` 报 `tool-unavailable`，ELF/ar 读取不受影响。 |
| **产物模型不在源码金标准内。** | `inspect` 有自己的测试（`artifact.test.ts`、`artifact-elf.test.ts`）；L1–L3 只覆盖源码管线。 |
| **离线渲染器画不出 `jumpStyle=arc`。** | `jumpStyle` 是 draw.io 扩展，mxGraph 核心没有；生成文件配置正确，但要在 draw.io 里看跳线。 |
| **离线渲染器的中文宽度是估算的。** | jsdom 的 `offsetWidth = 0`，字宽只能近似，标签避让可能不准。 |
| **SVG 预览不共享 `.drawio` 的边走线。** | 节点坐标共享，边按中心到中心画；把 SVG 当结构速览。 |
| **混合语言图只合并、不做符号解析。** | C 与 C# 输入会合成一个 IR，但跨语言同名引用不建立链接。 |
| **多页、图层与标签过滤尚未接到 CLI。** | IR 能表达的内容多于 CLI 当前输出。 |

## 相关

- [`architecture.md`](architecture.md) —— 你要扩展的分层
- [`annotations.md`](annotations.md) —— 解析器的输入契约
- [`drawio-format.md`](drawio-format.md) —— 不能破坏的输出格式
- [`conformance.md`](conformance.md) —— 比较层次与规范化
- [`typescript/SKILL.md`](../typescript/SKILL.md) —— 实现指南与坑
