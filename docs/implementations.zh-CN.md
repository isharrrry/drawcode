---
type: Guide
title: 各语言实现
description: 如何构建、测试与调用 Python、TypeScript、.NET 三套实现，以及它们如何被约束到输出一致
tags: [implementations, python, typescript, dotnet, conformance]
status: stable
---

# 各语言实现

[English](implementations.md) | **中文** | [Español](implementations.es.md)

[← 文档索引](index.zh-CN.md)

`drawcode` 把同一份能力发了三次，每种语言一次，这样 [benchmark.md](benchmark.zh-CN.md) 里的
性能比较比的是实现，而不是生态。

| | Python | TypeScript | .NET |
| :--- | :--- | :--- | :--- |
| 目录 | [`python/`](../python/) | [`typescript/`](../typescript/) | [`dotnet/`](../dotnet/) |
| 需要 | Python 3.10+ | Node 22.6+ | .NET SDK 10 |
| 运行时依赖 | **无**（仅标准库） | **无**（没有 `node_modules`） | **无**（仅 BCL） |
| 入口 | `python -m drawcode.cli` | `node typescript/bin/drawcode.ts` | `dotnet dotnet/src/DrawCode/bin/Release/net10.0/DrawCode.dll` |
| 测试 | `python -m unittest discover -s tests -t .` | `node --test` | `dotnet test dotnet/DrawCode.slnx -c Release` |
| 测试数量 | 145 | 210 | 120 |
| 各实现指南 | [`python/SKILL.md`](../python/SKILL.md) | [`typescript/SKILL.md`](../typescript/SKILL.md) | [`dotnet/SKILL.md`](../dotnet/SKILL.md) |

表里的每条命令都在仓库根目录执行。每个实现目录另有一份 `README.md`，
以及一份讲移植走查的 `SKILL.md`。

## 共享契约

三套都提供同样的两个操作：

```
build <files...> [--root DIR] [--out FILE] [--merge] [--layout-from FILE] [--svg FILE]
                [--inline] [--cards] [--no-rw-labels] [--straight-edges]
sync  <drawio> <files...> [--root DIR] [--write]
```

| 操作 | 作用 |
| :--- | :--- |
| `build` | 解析源码 → IR → 写出 `.drawio`。`--layout-from` 复用既有图的手工排版；`--svg` 额外产出一份预览。 |
| `sync` | 读 `.drawio` → 应用排版与注解属性 → 只回写**声明层**。不给 `--write` 就是试跑。 |

四个内容/排版开关在三份 CLI 上同名同义：`--inline` 把「一写一读」的信号折叠成设备直连边；
`--cards` 把带 `asset` 的函数画成图片卡片；`--no-rw-labels` 去掉边上的 `read`/`write`；
`--straight-edges` 用直线替代正交布线（人工拐点与出入锚点保留，自动肘点丢弃）。不带这些开关时
产物与加开关之前逐字节相同 —— 这是共享金标准仍然有意义的前提。

## Python

参考实现。只用标准库，所以从源码检出即可直接运行，无需安装：

```bash
export PYTHONPATH=python/src          # Windows: $env:PYTHONPATH = "python/src"
python -m drawcode.cli build examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --out out/flow.drawio --svg out/flow.svg

cd python && python -m unittest discover -s tests -t .
```

已验证：在 `python/` 里执行 `pip install -e .` 也会暴露一个 `drawcode` 控制台脚本，
且 `drawcode --help` 会列出两个子命令。

## TypeScript

位于 [`typescript/`](../typescript/)。

**没有安装步骤，也没有 `node_modules`。** Node 22.6 及以后会自己剥掉类型标注，
所以 `.ts` 入口是直接运行的，不会先编译成 JavaScript。

```bash
node typescript/bin/drawcode.ts build examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --out out/flow-ts.drawio

cd typescript && node --test
```

`npm run typecheck` 确实需要外部的 `typescript` 包，而仓库有意不 vendor 它；
它不在测试路径上。

## .NET

位于 [`dotnet/`](../dotnet/)，是一个面向 `net10.0` 的 `.slnx` 解决方案。

先构建一次，再运行构建产出的程序集：

```bash
dotnet build dotnet/DrawCode.slnx -c Release

dotnet dotnet/src/DrawCode/bin/Release/net10.0/DrawCode.dll build \
    examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --out out/flow-net.drawio

dotnet test dotnet/DrawCode.slnx -c Release
```

上面两套实现各自附带一份 `SKILL.md`，记录了 Node 与 .NET 特有的坑
（正则语义、XML 序列化、没有 `DOMParser`；`XDocument` 会写出金标准文件没有的 XML 声明、
浮点格式化要用 `CultureInfo.InvariantCulture`，以及原始 deflate
需要 `DeflateStream` 而不是 `ZLibStream`）。

## 一致性是如何被强制的

三套实现一致不是感觉，而是测试。三套都被 [`conformance.md`](conformance.md)
和 `tests/golden/` 下的金标准用例约束：

| 级别 | 比较内容 | 容差 |
| :--- | :--- | :--- |
| L1 —— 解析（IR） | 信号、函数、参数、边、设备、文件 | 精确 |
| L2 —— 图结构 | 容器、嵌套、节点归属、边的端点 | 精确 |
| L3 —— 几何 | 节点 `x`/`y`/`w`/`h`、折线点、边锚点 | 精确 |
| L4 —— schema | 通过 `tools/xsd/mxfile.xsd` 校验 | 必须通过 |

**三套实现都逐字节复现了 `small-c` 与 `small-cs` 金标准用例** ——
`expected.drawio` 与 `expected.ir.json` 的 SHA256 完全相同。这比规格所要求的
归一化比较更严格：它是精确到最后一位数字的 L3 几何一致，而不仅仅是结构
相等。

**一致性运行器在缺少金标准文件时必须大声失败，而不是跳过。**
一个被静默跳过的合规测试，会让未验证的实现看起来已验证。这件事在本项目自己的开发过程中
真的发生过：XSD 校验测试从同级仓库解析 schema，于是任何没有那个检出的人都会
跳过三个测试。schema 现在已 vendor 到
[`tools/xsd/mxfile.xsd`](../tools/xsd/mxfile.xsd)，三个测试都会执行。

## 为什么输出一致比看上去更重要

只有当三套实现做的是**同样的工作**，基准测试才有意义。一个画得更漂亮但更快的
路由器会拿到更好看的数字，却什么也证明不了。

所以约束是显式的：**优化可以改变计算得多快，永不改变
计算什么。** 加速障碍物查询的空间索引是正当的。换一套路由
启发式则不是 —— 那会悄悄把基准测试变成三个不同程序之间的
比较。

这是对实现如何演进的一项真实限制，而它是有意被接受的。

## 相关

- [`conformance.md`](conformance.md) —— 完整的比较规格
- [benchmark.md](benchmark.zh-CN.md) —— 实测数字
- [architecture.md](architecture.zh-CN.md) —— 设计为什么是这个形状
