---
type: Guide
title: 贡献
description: 环境、跑测试、重生成金标准、给工具加一门源语言，以及刻意未验证事项的清单
tags: [contributing, testing, benchmark, workflow]
status: stable
---

# 贡献

[English](contributing.md) | **中文** | [Español](contributing.es.md)

[← 文档索引](index.zh-CN.md)

`drawcode` 要求三个独立实现产出可比对到字节的输出。这让贡献规则在一个方向上比通常更严 —— **你可以改「算得多快」，绝不能改「算出什么」** —— 在另一个方向上则更松：任何实现都可以用自己的语言习惯写，只要输出一致。

## 环境

| 工具链 | 版本要求 | 用途 |
| :--- | :--- | :--- |
| Python | 3.10 或更高（`requires-python = ">=3.10"`） | 参考实现、金标准导出器 |
| Node | 18 或更高 | TypeScript 实现、`tools/render/` |
| .NET SDK | 10 | .NET 实现及其测试工程 |
| PowerShell | 5.1 或更高（`#Requires -Version 5.1`） | `bench/run.ps1` |

**三个实现都零第三方运行时依赖。** 解析、布局、路由与 XML 写出都只用各语言的标准库。这不是苦行：[`docs/benchmark.md`](benchmark.md) 里的基准比较的是三个实现做同一件事，如果某个依赖替其中一个干了活，数字就不再可比。给 `python/`、`typescript/` 或 `dotnet/` 加运行时依赖属于行为变更，不是图方便。

**测试依赖是另一回事，而且可选。** Python 测试套件用 `lxml` 把生成的文件对着官方 schema（[`tools/xsd/mxfile.xsd`](../tools/xsd/mxfile.xsd)）校验。没有 `lxml` 时那三条测试会**跳过**而不是失败；见[刻意未验证的事项](#刻意未验证的事项)。

## 仓库地图

| 路径 | 内容 |
| :--- | :--- |
| [`examples/`](../examples/) | C 与 C# 的样例工程，包括三模块的 `medium/` |
| [`python/src/drawcode/`](../python/src/drawcode/) | 参考实现 —— 八个模块 |
| [`python/tests/`](../python/tests/) | Python 测试套件 |
| [`python/SKILL.md`](../python/SKILL.md) | 本实现的移植与扩展指南 |
| [`typescript/`](../typescript/) | TypeScript 实现 |
| [`dotnet/`](../dotnet/) | .NET 10 实现 |
| [`conformance.md`](conformance.md) | 实现之间一致性怎么判定 |
| [`tests/golden/`](../tests/golden/) | 金标准：输入源码、期望 IR、期望图 |
| [`tools/dump_ir.py`](../tools/dump_ir.py) | 从 Python 实现重生成解析层金标准 |
| [`tools/xsd/mxfile.xsd`](../tools/xsd/mxfile.xsd) | 官方 draw.io schema，已 vendor 进来，保证测试不跳过 |
| [`examples/small/`](../examples/small/) | 到处都在用的 C 与 C# 样例工程 |
| [`examples/large/generate.py`](../examples/large/generate.py) | 为基准生成放大的样例工程 |
| [`bench/run.ps1`](../bench/run.ps1) | 三语言基准 |
| [`tools/render/`](../tools/render/) | 离线 `.drawio` → SVG → PNG 渲染 |

## 跑测试

```bash
cd python && python -m unittest discover -s tests -t .    # reference implementation

cd typescript && npm test                                  # see typescript/ for build steps
cd dotnet && dotnet test                                   # see dotnet/ for build steps
```

本仓库里 Python 测试套件的一次运行：

```
Ran 71 tests in 0.215s

OK
```

测试的组织方式让失败能直接说出它在哪一层，与 [`conformance.md`](conformance.md) 的四个比较层级对应：

| 领域 | 覆盖内容 |
| :--- | :--- |
| C 解析 | 宏方向、注解键、数组声明符、注释块边界 |
| C# 解析 | `[Drawcode]` 与 `[Device]` 特性绑定 |
| IR 与边 | 由 `reads`/`writes` 派生边、合并行为 |
| `.drawio` 读写 | 坐标、拐点、属性的往返；两种存储形态 |
| 代码生成 | 声明层回写，以及函数体确实没被动过 |
| Schema 校验 | 生成的输出对着 vendored 官方 XSD |
| 端到端 | 构建 → sync → 构建，源码保持不变 |
| SVG 预览 | 节点坐标与文本，按结构比较 |

**跳过的测试比失败的测试更糟。** 一条跳过的测试会让未验证的实现看起来像已验证，所以一致性资源被 vendor 进仓库、而不是从同级目录去取，并且缺金标准文件必须报错。同一条规则适用于 TypeScript 与 .NET 的 runner：找不到金标准用例时必须报错，不能算通过。

## 跑基准

```bash
pwsh bench/run.ps1
```

在 Windows 上，脚本自己的头部就建议写成显式形式，因为默认执行策略会拦下未签名的本地脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File bench/run.ps1
```

常用参数：

| 参数 | 默认值 | 含义 |
| :--- | :--- | :--- |
| `-Sizes` | `s,m,l` | 跑哪些规模预设 |
| `-Langs` | `python,typescript,dotnet` | 测量哪些实现 |
| `-Repeat` | `3` | 每种组合跑几遍；报告的是**中位数** |

每轮都会先生成样例源码 —— 这是确定性的，因为生成器的参数与随机种子是固定的 —— 然后计时整条 `parse → IR → .drawio` 流水线，**包含进程启动**，因为那才是用户真实感受到的耗时。

读结果表之前有两件事值得知道：

- **规模预设写死在脚本里。** `$Scale` 表定义 `s = 5 个模块`、`m = 10`、`l = 20`，每个模块 10 个信号、6 个函数。不在表里的规模会以 `unknown size` 被拒。要测别的规模，得先改这张表。
- **没构建的实现报 `SKIP (not built)`，不算失败。** 就绪与否靠文件存在性判断：`python/src/drawcode/cli.py`、`typescript/dist/cli.js`、`dotnet/src/DrawCode/bin/Release/net10.0/DrawCode.dll`。结果行里 `median_ms = $null` 且 `note = "not built"` 说明是构建顺序问题，不是性能发现。

结果写到 `bench/results/bench-<时间戳>.json`，同时记下机器与工具链版本 —— 这正是让一个历史数字可复现、而不是变成轶事的原因。

## 加一个金标准用例

金标准用例是 `tests/golden/<名称>/` 下一个自包含目录，装着两个比较层级的输入与期望输出：

```
tests/golden/small-c/
├── input/                 # the sources
├── expected.ir.json       # L1 — parse-level golden
├── expected.drawio        # L2 + L3 — structure and geometry golden
└── preview.svg            # SVG golden, compared structurally
```

IR 金标准由 [`tools/dump_ir.py`](../tools/dump_ir.py) 生成，不手写：

```bash
python tools/dump_ir.py tests/golden/small-c/input tests/golden/small-c/expected.ir.json \
    tests/golden/small-c/input/adc.h tests/golden/small-c/input/adc.c \
    tests/golden/small-c/input/dsp.h tests/golden/small-c/input/dsp.c
```

前两个参数是根目录与输出路径，其余是输入文件。注意导出器刻意不写什么：**它不记录任何布局坐标**。布局是 `.drawio` 层的事，把两者混在一起会让路由 bug 看起来像解析 bug。扩展它时请保持这条分界。

`expected.drawio` 由某个实现生成，然后经人工审阅再提交 —— 所以重新生成它是一次会出现在 diff 里的刻意行为。**只在有意变更行为时才重生成金标准**，并在提交信息里说明动了哪一层。如果一个金标准变了而你说不出原因，那这个变更就是回归。

## 加一门源语言

完整走查见 [`python/SKILL.md`](../python/SKILL.md) 第 8 节；以下是简版：

1. 在 `cparse.py` 旁边加一个解析模块 —— 比如给 Rust 前端加 `rsparse.py` —— 暴露 `parse_rs_project(paths, root) -> Model`。
2. **复用既有的 IR。** 不要另造一套并行数据结构；三方一致性全靠所有前端产出同一个 `Model`。
3. 决定这门语言怎么表达方向。C 用注释里的 `dir=` 键，C# 用特性的位置参数；Rust 前端可以用 `#[drawcode(dir = "in")]`。
4. 在 `parse.py` 里按扩展名分派。
5. 在 `codegen.py` 里加配套的声明层回写函数，并在 `sync_source` 里分派。
6. 在 `examples/small/<语言>/` 下加样例工程与测试；若语法形态是新的，在 `tests/golden/` 下加金标准。
7. 更新 [`conformance.md`](conformance.md) 的能力清单。

**唯一不要做的事：绝不在 `drawio.py` 里加语言分支。** 图画的是 IR，而 IR 与源语言无关。布局层一旦出现语言判断，三个实现就没法再共享同一套路由规格，基准也就失去意义。

## 几何契约

因为几何是精确比较的，路由器的改动会同时波及三个实现。当你在某个实现里改动 `_route`、`_candidates`、`_cross_gap` 或 `_assign_default_positions` 时：

1. 把同样的改动移植到另外两个实现。
2. 重新生成受影响的 `.drawio` 金标准。
3. 重跑基准并记录，因为大输入的开销主要由路由主导。

加一个加速障碍查询的空间索引是允许而且受欢迎的。让路由器产出**不同**的边则不行，哪怕更好看 —— 那会破坏可比性。如果确实想要一项路由改进，那是一次规格变更，三个实现一起动。

## 刻意未验证的事项

在这里写清，而不是让贡献者改到一半才发现。

| 未验证 | 原因，以及对你的意义 |
| :--- | :--- |
| **TypeScript 与 .NET 的测试套件不在此处断言。** | 本文档只报告了一次 Python 运行。那两个实现的可信度，恰好等于它们自己测试通过的程度；入口与状态见各自目录。 |
| **Schema 校验取决于 `lxml`。** | 没有它就跳过三条测试。把 XSD vendor 进来是为了让这几条不再有条件，但库本身仍是可选的，所以裸环境会静默失去这部分覆盖。 |
| **离线渲染器画不出 `jumpStyle=arc`。** | `jumpStyle` 是 draw.io 的扩展，mxGraph 核心没有。生成的文件的配置是对的；要验证跳线必须用 draw.io 打开。 |
| **离线渲染器的中文文字测量是估算的。** | jsdom 报告 `offsetWidth = 0`，所以字宽是近似值，标签**避让**可能不准。文字渲染本身不受影响。 |
| **SVG 预览不共享 `.drawio` 的边路由。** | 节点共享坐标；边是中心到中心画的。把 SVG 当作结构性速读，而不是忠实预览。 |
| **只有 `$Scale` 里的规模有预设。** | `s`、`m`、`l` 分别是 5、10、20 个模块。别的规模要先改脚本。 |
| **混合语言图是合并的，不是符号解析的。** | 一个 C 输入与一个 C# 输入产出一个 IR，但跨语言引用同名符号不会被连接。 |
| **多页输出、图层与标签过滤没有接到 CLI。** | IR 能表达的东西比 CLI 当前输出的多。 |

这些没有一条是藏起来的：每一条都出现在读者真会撞见它的位置，而本文档其它地方的每一个「实测」数字都来自真跑过的命令，从不来自估计。

## 相关

- [architecture.md](architecture.md) — 你正在扩展的分层
- [annotations.md](annotations.md) — 解析器的输入契约
- [drawio-format.md](drawio-format.md) — 你不能弄坏的输出格式
- [`conformance.md`](conformance.md) — 比较层级、归一化、必需能力
- [`python/SKILL.md`](../python/SKILL.md) — 移植指南，含本实现自己踩过的坑清单
