---
type: Guide
title: 实现
description: 如何构建、测试与调用 TypeScript 实现，以及金标准现在钉住什么
tags: [implementations, typescript, conformance]
status: stable
---

# 实现

[English](implementations.md) | **中文** | [Español](implementations.es.md)

[← 文档索引](index.zh-CN.md)

`drawcode` 只保留一套实现：TypeScript。Node 直接运行 `.ts` 入口，CLI 没有构建步骤，测试路径上也不依赖 `node_modules`。

| | TypeScript |
| :--- | :--- |
| 目录 | [`typescript/`](../typescript/) |
| 运行要求 | Node 22.18+（原生类型擦除） |
| 运行时依赖 | **无**（只用 Node 标准库） |
| 入口 | `node typescript/bin/drawcode.ts` |
| 测试 | `cd typescript && node --test` |
| 测试数 | 229（5 条跳过） |
| 维护指南 | [`typescript/SKILL.md`](../typescript/SKILL.md) |

## 命令

```
build   <files...> [--root DIR] [--out FILE] [--merge] [--layout-from FILE] [--svg FILE]
                    [--inline] [--cards] [--no-rw-labels] [--straight-edges]
sync    <drawio> <files...> [--root DIR] [--write]
dump-ir <files...> [--root DIR] [--out FILE]
inspect <artifact> [--out FILE] [--infer-edges]
```

```bash
node typescript/bin/drawcode.ts build examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --merge --out out/flow.drawio --svg out/flow.svg

node typescript/bin/drawcode.ts sync out/flow.drawio examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c          # 试运行；加 --write 才写回

node typescript/bin/drawcode.ts inspect tools/golden/small-cs/bin/Debug/net10.0/small-cs.dll
```

| 开关 | 作用 |
| :--- | :--- |
| `build --merge` | 多个模块合成一张图（默认每个模块各出一张） |
| `build --layout-from FILE` | 复用已有图的人工排版，再按当前源码重建（幂等） |
| `build --inline` | 把「一写一读」的信号折叠成函数直连边 |
| `build --cards` | 带 `Asset` 的函数渲染成图片卡片 |
| `build --no-rw-labels` | 去掉边上的 `read` / `write` 标签，只留线 |
| `build --straight-edges` | 直线代替正交布线（见下） |
| `build --svg FILE` | 同时输出只读 SVG 预览 |
| `sync` | 图 → 源码，只回写声明层；不带 `--write` 是试运行 |
| `inspect` | 把 `.dll` / `.so` / `.out` / `.a` / `.o` 读成规范 JSON；不加载、不执行目标程序 |

`--inline` 与 `--layout-from` 同时使用时，先折叠再套排版；被折叠掉的节点必须重新布局补位，不能在原位留洞。

## 依赖

零运行时依赖是刻意属性，不是偶然。Node 22.18+ 在加载时擦除类型，`.ts` 入口无需构建步骤，也不需要 `node_modules`。XML 读写与 XSD 子集校验器是手写的：文档结构小，而且要与金标准逐字节对齐，引库反而要迁就它的怪癖。测试框架用内置的 `node --test`。

`@types/node` 与 `typescript` 只是 devDependencies，供 `npm run typecheck` 与编辑器补全；测试路径不加载它们。唯一例外是 `inspect` 的 PE/CLI 分支，它调用 [`tools/drawcode-metadata`](../tools/drawcode-metadata/)（.NET 10 sidecar，不在 npm 包内）；ELF 与 `ar` 在进程内读取。

## 测试

`cd typescript && node --test` 跑 229 个测试（5 条跳过）。跳过的是因为它们依赖仓库之外的东西——样本 DLL，或已编译的 `templates/c/example`——运行时会把原因打印出来。

## 有设计后果的开关

### `--straight-edges` 不能改成默认

默认是正交布线。两份金标准都写死了 `orthogonalEdgeStyle` 与 `<Array as="points">`；改默认会让它们立刻变红，并让所有按旧几何记录的手工布局失效。所以这个开关只能显式打开。换样式时四件事必须一起做：去掉 `edgeStyle=orthogonalEdgeStyle`、`rounded=1` 与 `jumpStyle=arc`，**保留** `exitX`/`exitY`/`entryX`/`entryY` 锚点。直线适合「一行一个节点」的拓扑；在分区带 + 卡片布局里会变成斜线网，可能穿过卡片和标签。

## 范围限制

- 不支持多页、draw.io Layer 分层、tags 过滤：都没有接到 CLI。
- 混合语言输入可以合并，但跨语言的同名符号不做解析。
- `npm run typecheck` 需要先 `npm install`；测试不需要。

## 金标准钉住什么

[`tools/golden/`](../tools/golden/) 下有 `small-c` 与 `small-cs`：输入源码、规范化 IR、期望的 `.drawio` 与预览 SVG。测试逐项精确比较 L1（IR）、L2（图结构）、L3（几何），并用 [`tools/xsd/mxfile.xsd`](../tools/xsd/mxfile.xsd) 做 L4（Schema）校验。重生成金标准是刻意动作，见 [contributing.zh-CN.md](contributing.zh-CN.md)。

## 已退役的实现

2026-10 之前仓库还带有独立的 Python 与 .NET 实现。它们的作用是互相校验同一份契约，并做性能对照。产品线收敛到 TypeScript 实现（VS Code 扩展 + 二进制产物读取）之后，维护三套解析器不再划算，两套目录已于 2026-10-21 从工作区移除。

移除改变的是**测什么**，不是**要求什么**：金标准仍然钉住 IR 与几何。退役的两套代码仍保留在该日期之前的 git 历史中。

## 相关

- [`conformance.md`](conformance.md) —— 测试比较什么、怎么比较
- [`artifact-format.md`](artifact-format.md) —— 二进制产物模型
- [`contributing.zh-CN.md`](contributing.zh-CN.md) —— 环境、测试与金标准
