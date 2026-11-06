---
type: Guide
title: 实测验证
description: 本仓库每一个数字都是跑出来的 —— 测试数量、幂等、schema、金标准复现与性能特征
tags: [verification, tests, goldens, performance]
status: stable
---

# 实测验证

[← 文档索引](index.zh-CN.md)

**本仓库没有任何一个数字是估计的。** 下表中每一个数字都是由同一列的命令跑出来的。
金标准的比对规则本身（L1–L4 四个层级、归一化规则）定义在
[`conformance.md`](conformance.md)；本页只记录「跑出来是多少」。

## 正确性

| 主张 | 如何测量 | 结果 |
| :--- | :--- | :--- |
| TypeScript 实现是正确的 | `cd typescript && node --test` | **229 个测试，0 失败，5 跳过** |
| 扩展测试 | `cd editors/vscode && node --test test/*.test.mjs` | **93 个测试，0 失败** |
| 压缩态 `.drawio` 被正确读取 | 读回一个 draw.io 压缩过的金标准文件 | **nodes=6, edges=6, attrs=6** —— 与纯文本形态完全相同 |
| 读不出的载荷不会静默失败 | `read_layout('<mxfile><diagram>not-a-payload</diagram></mxfile>')` | 抛错（绝不返回空布局） |
| 生成的 `.drawio` 符合 schema | 对着 `tools/xsd/mxfile.xsd` 做 XSD 校验 | **3/3 通过**（C、C#，以及一张带拐点的图） |
| 往返幂等 | 构建 → sync → 构建，比较 | **第二次 sync 零改动** |
| 金标准 IR 被精确复现 | `dump-ir` 与 `tools/golden/*/expected.ir.json` 逐字节比对 | **两个金标准用例均完全一致** |

那 5 个跳过的测试不是失败，也不是被禁用：它们依赖仓库外的东西（`DRAWCODE_SAMPLE_DLL`
指向的样本 DLL，以及 `templates/c/example` 是否已编译），拿不到时按设计 skip 并打印原因。

## 性能特征

2026-10 基准测试得到的性能数字（布局随模块数呈二次增长、解析线性）是在已退役的 Python
参考实现上测的；这里保留它们，是因为算法相同，但明确标注为历史数据而非当前数据。

| 主张 | 如何测量 | 结果 |
| :--- | :--- | :--- |
| 布局开销（历史，Python） | 5/10/20/40/80 个模块 | 0.36 s / 1.45 s / 5.89 s / 23.3 s / 95.4 s —— **超线性** |
| 解析开销（历史，Python） | 同上 | 4.0 / 6.6 / 12.9 / 26.8 / 52.9 ms —— 线性 |

**解析是线性扩展的，而布局是二次的。** 路由每条边都要拿候选路径去试所有其它节点，
所以一个 80 模块的工程会在布局上花 95 秒，而解析只花 53 毫秒。这一点是作为特征写出来的，
而不是当作舍入误差藏起来。

布局的二次开销记在[已知限制](../README.zh-CN.md)一节的「布局是 O(n²)」条，不是隐藏项。
