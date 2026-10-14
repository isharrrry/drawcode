# 基准测试

**drawcode 的三种语言：同样的算法、同样的输出、差别极大的常数。**

[English](benchmark.md) | **中文** | [Español](benchmark.es.md)

三套实现产出的 `.drawio` 逐字节相同（见
[`conformance.md`](conformance.md) 与 `docs/implementations.zh-CN.md`）。
本页测量的是那份同样的工作在各运行时里要花多少代价。

## 测量什么

完整的 `parse → IR → .drawio` 流水线，通过每套实现自己的
CLI 驱动，**包含进程启动** —— 因为那才是用户运行 `drawcode build`
时真正体验到的。

生成的输入来自 [`examples/large/generate.py`](../examples/large/generate.py)，
使用固定的 RNG 种子，所以运行可复现。

```
powershell -ExecutionPolicy Bypass -File bench/run.ps1 -Sizes s,m,l,xl,xxl
```

| size | modules | files | signals | funcs | edges |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `s` | 5 | 10 | 50 | 30 | 144 |
| `m` | 10 | 20 | 100 | 60 | 294 |
| `l` | 20 | 40 | 200 | 120 | 594 |
| `xl` | 40 | 80 | 400 | 240 | 1 194 |

第五个预设 `xxl`（80 个模块）存在于 `bench/run.ps1`，但不在
这里测量 —— 单次 Python 运行约需 95 s。见下面的外推。

注意 **边的数量随模块数线性增长**，而**时间
二次增长**。那是 `edges × nodes` 乘积的特征，也是
成本模型最直接的证据。

## 结果（3 次的中位数，毫秒）

机器：Windows 10（build 22631），Intel Core i5-10200H，8 逻辑核。工具链：Python 3.14.6、Node v24.16.0、.NET 10.0.203。

| size | modules | python | typescript | dotnet |
| :--- | ---: | ---: | ---: | ---: |
| `s` | 5 | 464.8 | 174.8 | 152.8 |
| `m` | 10 | 1 603.6 | 208.5 | 177.5 |
| `l` | 20 | 5 966.7 | 325.9 | 255.1 |
| `xl` | 40 | 23 951.4 | 791.3 | 527.8 |

原始运行写入 `bench/results/bench-<timestamp>.json`，每一份都把
机器描述与工具链版本和数字记录在一起。

## 曲线的形状

这条流水线**在节点数上是二次的**，每种语言都一样。路由
阶段把每条边的每个候选路线与其他每一个节点做检测，
所以成本随 `edges × candidates × nodes` 增长。

把 `T(n) = C + k·n²`（n = 模块数）拟合到 `s` 与 `xl` 的测量值：

| implementation | startup constant `C` | quadratic coefficient `k` | `m` predicted / measured | `l` predicted / measured |
| :--- | ---: | ---: | :--- | :--- |
| python | 92.0 ms | **14.91** | 1 583 / 1 604 | 6 057 / 5 967 |
| typescript | 165.0 ms | **0.391** | 204 / 209 | 322 / 326 |
| dotnet | 146.9 ms | **0.238** | 171 / 178 | 242 / 255 |

预测值在两个插值点上落在实测值的 1–5% 之内，
这就是为什么这条曲线被读作干净的 `n²`，而不是"大致超线性"。

**三套实现在算法上完全相同 —— 只有常数不同。**
Python 的二次系数是 .NET 的 **62.6×**，是
TypeScript 的 **38.1×**。

这就是那个醒目差距背后的全部故事。它不是 C# 或 TypeScript 里
有更聪明的算法；而是每次运行 2.5 百万次解释器级函数调用
改由 JIT 来执行。

### 为什么 TypeScript 和 .NET 在小规模下*看起来*是平的

它们的增长比（TypeScript 依次为 1.19×、1.56×、2.43×，每次模块数翻倍）
远低于二次方本该给出的 4×。那不是次二次行为 ——
而是约 150 ms 的进程启动淹没了在这些规模下仍只有几十毫秒的
二次项。

用拟合模型外推，复现了 README 里的那张表：

```
python @ 80 modules = 92.0 + 14.91 × 6400 ≈ 95 500 ms ≈ 95.4 s
```

## 时间花在哪里

对 `m`（10 个模块）规模下 Python 实现跑 `cProfile`：

```
2 482 500 calls   drawio.py:131(_crosses)   3.37 s cumulative   (69%)
      294 calls   drawio.py:152(_route)     4.81 s cumulative
```

`_crosses` —— 线段与矩形相交的障碍检测 —— 被调用了 2.5 百万
次，而图只有 294 条边。这一个函数就是热点，
也是唯一一处算法改进能在三种语言里
都回本的地方。

## 这对"优化版本"意味着什么

三套实现是刻意**参照等价**的，而不是各自独立优化的：
它们共享同一套路由策略、同一组锚点候选集，
以及同样的几何常量（`ANCHOR_SETS` 顺序、`SHRINK=3`、
`SLACK=2`），这正是它们输出逐字节相同的原因。

两个推论：

1. **上面的数字测量的是运行时间，不是设计。** 一个真正的算法
   优化 —— 用空间索引削减 `edges × candidates × nodes`
   乘积 —— 需要同时施加到三套实现并重新对金标准用例钉死，
   因为它可能改变哪条路线在平局中胜出。
2. **Python 不会靠微观优化追上来。** 62.6× 的常数差距是
   语言执行差距；要弥合它，要么减少工作量（更少的
   `_crosses` 调用），要么把内层循环移出解释器。

## 复现

```powershell
# all sizes, all languages, 3 repeats
powershell -ExecutionPolicy Bypass -File bench/run.ps1

# one size, one language, 5 repeats
powershell -ExecutionPolicy Bypass -File bench/run.ps1 -Sizes m -Langs dotnet -Repeat 5
```

入口点缺失的语言会被报告为 `SKIP (not built)`，
而不是被静默省略。
