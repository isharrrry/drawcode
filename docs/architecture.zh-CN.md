---
type: Guide
title: 架构
description: drawcode 如何分层、每个模块的职责边界，以及设计为何拒绝持久化中间表示
tags: [architecture, design, ir, dataflow]
status: stable
---

# 架构

[English](architecture.md) | **中文** | [Español](architecture.es.md)

[← 文档索引](index.zh-CN.md)

## 其余一切所依据的那个决定

`drawcode` 是在第一次尝试之后重写的，那一版每个工程要持久化三个文件：

```
model.ir.json     semantics
views/*.json      layout + annotations
devices.json      device master data
```

问题不在于文件数量。问题在于**语义存在了两份** —— 一份在 `.h`/`.c`
源码里，一份在 `model.ir.json` 里。两个真相来源总会漂移。要让它们一致，
就得发明 `irHash`、漂移检测和三方合并。那是你主动选择背上的债。

重写把它收敛成了一个答案：

> **源码是唯一的真相来源。**

语义本来就住在代码里。缺的只是*方向*（这个信号是输入
还是输出？）和*注解*（人怎么称呼它？）。所以它们被**移进了代码**，
以文档注释和特性的形式，而不是存在代码旁边。

## 持久化的层

| 层 | 形式 | 持久化 | 可重建 |
| :--- | :--- | :--- | :--- |
| 语义 —— 信号、函数、方向、注解、设备数据 | **C / C# 源码** | ✅ 唯一的真相来源 | — |
| IR | 内存中的对象图 | ❌ **从不写出** | 每次运行都从代码重建 |
| 排版（坐标、折线、折叠）+ 纯外观 | **`.drawio`** | ✅ 派生产物*兼*排版载体 | 语义可重建，**手工排版不可** |

**持久化的数据 = 代码（1 份）+ 图（1 个产物）。持久化的中间数据 = 0 份。**

### 为什么排版不进代码

坐标是视图属性。它不参与编译，而且每拖一下都会重写
`.c` 文件 —— diff 爆炸，代码评审被坐标噪音淹没。所以排版
住在 `.drawio` 里，由人拖动产生，并在下一次运行时读回 IR。

这也是为什么"丢失排版"这个失效模式被如此严肃对待：**手工排版是这个
系统里唯一无法重新生成的东西。** 关于压缩存储的陷阱，见
[drawio-format.md](drawio-format.zh-CN.md)。

## 模块分层

```
                    ┌──────────────────────────────┐
   source files ───▶│ cparse.py / csparse.py       │  language front ends
                    │  (one per source language)   │
                    └───────────────┬──────────────┘
                                    ▼
                    ┌──────────────────────────────┐
                    │ model.py                     │  IR (in memory only)
                    │  Signal / Func / Edge / ...  │
                    └───────────────┬──────────────┘
                                    ▼
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐         ┌──────────────────┐        ┌────────────────┐
│ drawio.py     │         │ svg.py           │        │ codegen.py     │
│ IR ↔ .drawio  │         │ IR → SVG preview │        │ IR → code      │
│ layout+route  │         │ (node layout     │        │ (declaration   │
│               │         │  only, see note) │        │  layer only)   │
└───────────────┘         └──────────────────┘        └────────────────┘
        ▲                                                      │
        └──────────────────── cli.py ──────────────────────────┘
                          build / sync
```

| 模块 | 负责 | **不**负责 |
| :--- | :--- | :--- |
| `model.py` | IR 类型与边的派生 | 任何 I/O |
| `cparse.py` | C 语法 → IR | 排版、绘制 |
| `csparse.py` | C# 语法 → IR | 排版、绘制 |
| `parse.py` | 扩展名分派、多语言合并 | 语法细节 |
| `drawio.py` | 排版、路由、`.drawio` 读写 | 源码语法 |
| `svg.py` | SVG 预览 | 路由（见下） |
| `codegen.py` | 声明层回写 | 函数体（永不） |
| `cli.py` | 参数处理、文件 I/O | 任何算法 |

**让它可维护的那条规则**：`drawio.py` 里**没有语言分支**。图
是 IR 的图像，而 IR 与语言无关。如果 `drawio.py` 里出现了语言判断，
三套实现就无法再共享同一份排版规格，
基准测试也就失去意义了。

## 数据流：`build`

```
files
└─ parse_any(files, root)
   ├─ dispatch by extension: .c/.h → cparse, .cs → csparse
   └─ merge into one Model, then rebuild_edges()
└─ [optional] apply_layout(model, read_layout(old.drawio))   ← reuse hand-made layout
└─ to_drawio(model) → XML
   ├─ _assign_default_positions(model)      only when there is no prior layout
   ├─ build swimlanes from directories/files, compute nesting
   ├─ each signal/function → <object> + <mxCell> + <mxGeometry>
   ├─ each edge → anchors (_endpoints/_candidates) → obstacle-aware routing (_route)
   │             → <Array as="points">
   └─ attach each edge to its innermost common container
└─ [optional] to_svg(model) → read-only preview
```

## 数据流：`sync`

```
read_layout(xml) → {nodes, edges, attrs}
├─ _unpack(xml)            expand draw.io's compressed storage form
├─ _load_cells(xml)        collect both <object> and <mxCell>
├─ _origin(cells, parent)  accumulate parent offsets → absolute canvas coordinates
└─ yields: symbolId → (x,y,w,h) / edge key → [(x,y)] / symbolId → writable attributes

apply_layout(model, layout)    hydrate layout and attributes back into the IR
sync_source(path, model, rel)  write per file
├─ .cs → sync_cs_source()
└─ otherwise → sync_header() + sync_functions()
```

回写只触及声明层。它通过向上扫描连续的 `///` 行来定位一段
区间（或特性块），匹配到该声明后替换那一段，
其余一切保持字节不变。`test_sync_leaves_other_code_untouched`
断言的正是这一点。

## 双向边界是刻意不对称的

| 方向 | 允许 | 禁止 |
| :--- | :--- | :--- |
| 代码 → 图 | 重建节点、边、层次、注解；幂等 | — |
| 图 → 代码 | 只回写**声明层**：`@drawcode`/`@device` 注释（C）、`[Drawcode]`/`[Device]` 特性（C#） | 永不重写函数体；永不重排无关代码 |
| 冲突 | 语义冲突：**代码赢**；排版冲突：**图赢**（不同维度，不可能真的冲突） | 不做三方合并 |

反向为什么这么窄？因为图是*低保真*表示。它知道一个函数
读了 `g_raw`；它不知道循环边界、错误处理或算术。任何从图
写回函数体的工具都是在猜，而在源码文件里猜是不可接受的。
把反向限制在声明层，使这个操作可证明安全：它只能
触及图真正完整表示的那些行。

## 三套实现，一份规格

Python、TypeScript 和 .NET 10 各自以自己的习惯独立实现了这套架构。
它们由 [`conformance.md`](conformance.md) 和 `tests/golden/`
下的金标准用例约束到输出完全相同。

诚实的推论：**优化可以改变计算得多快，永不改变计算什么。**
加速障碍物查询的空间索引没问题；产出更漂亮边的更聪明路由器不行，
因为它破坏了可比性。正是这条约束让
[benchmark.md](benchmark.zh-CN.md) 有意义。

### 已知分歧：SVG 预览

`svg.py` 与 `drawio.py` 共享**节点**排版（两者都调 `_assign_default_positions`），
但**不共享边路由器**。它把边画成中心到中心，所以会明显穿过那些
`.drawio` 会绕开的节点形状。SVG 是结构性读取，不是忠实预览。要提供真正的
路由，需要重构 `to_drawio`，把边几何暴露成共享函数；两套
实现目前都有意复刻这个简化行为。

## 相关

- [annotations.md](annotations.zh-CN.md) —— 承载方向与元数据的注解键
- [drawio-format.md](drawio-format.zh-CN.md) —— 映射规则、坐标、路由、压缩
- [../conformance.md](conformance.md) —— 三套实现如何被约束在一起
