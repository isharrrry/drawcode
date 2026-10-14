# 文档

[English](index.md) | **中文** | [Español](index.es.md)

> [drawcode](../README.zh-CN.md) 的文档 —— 一个代码 ↔ 数据流图双向工具，源码是唯一的真相来源。

下列每个主题都有三种语言版本。英文版先写、写完整；
另外两版是忠实翻译而非摘要。三版始终在同一次改动里一起更新。

## 主题

| 主题 | 语言版本 | 涵盖内容 |
| :--- | :--- | :--- |
| **架构** | [English](architecture.md) · [中文](architecture.zh-CN.md) · [Español](architecture.es.md) | 分层、每个模块的职责边界、两条数据流（build 与 sync），以及拒绝持久化中间表示的理由 |
| **注解** | [English](annotations.md) · [中文](annotations.zh-CN.md) · [Español](annotations.es.md) | 每个注解键的字段级参考：`@drawcode` 与 `@device` 注释（C）、`[Drawcode]` 与 `[Device]` 特性（C#）—— 含类型、默认值与示例 |
| **`.drawio` 格式** | [English](drawio-format.md) · [中文](drawio-format.zh-CN.md) · [Español](drawio-format.es.md) | 元素映射、坐标系语义、锚点与路由规则，以及 draw.io 的压缩存储形态 |
| **基准测试** | [English](benchmark.md) · [中文](benchmark.zh-CN.md) · [Español](benchmark.es.md) | 三套实现的实测性能，含原始数字与耗时实际去向 |
| **各语言实现** | [English](implementations.md) · [中文](implementations.zh-CN.md) · [Español](implementations.es.md) | 如何构建、测试与调用 Python、TypeScript、.NET 三套实现 |
| **参与贡献** | [English](contributing.md) · [中文](contributing.zh-CN.md) · [Español](contributing.es.md) | 环境、跑测试、加金标准用例、加一门源语言，以及刻意未验证的事项 |

## 从哪里开始

| 你想…… | 去这里 |
| :--- | :--- |
| 理解设计为什么是这个形状 | [架构](architecture.zh-CN.md) |
| 第一次给自己的代码加注解 | [注解](annotations.zh-CN.md) → 然后是[快速开始](../README.zh-CN.md#快速开始) |
| 新增一门源语言（Rust、Go……） | [架构](architecture.zh-CN.md#模块分层) → [参与贡献](contributing.zh-CN.md) |
| 自己实现完整能力 | [`python/SKILL.md`](../python/SKILL.md)、[`typescript/SKILL.md`](../typescript/SKILL.md)、[`dotnet/SKILL.md`](../dotnet/SKILL.md) |
| 了解三版如何保持一致 | [`conformance.md`](conformance.md) |
| 看实测数字 | [基准测试](benchmark.zh-CN.md) |
| 诊断一张丢了排版的图 | [`.drawio` 格式](drawio-format.zh-CN.md#压缩存储形态) |
| 不装 draw.io 就把 `.drawio` 渲染成图片 | [`tools/render/`](../tools/render/README.md) |

## 关于这些文档

1. **每个数字都来自真正跑过的命令。** 没有任何估测。凡是尚未测量的数字，
   文档会如实说明，并指向[已知限制](../README.zh-CN.md#已知限制诚实列出)，
   而不是把它填上。
2. **改代码就要在同一次提交里改动这三种语言的文档。** 一个只存在于
   单一语言版本里的行为描述是缺陷，不是翻译滞后。
3. **未验证与已知损坏的行为都会被明确写出。** 有两个例子值得点明：
   SVG 预览不与 `.drawio` 共享边路由，离线渲染器也画不出
   `jumpStyle` 跳线。两处都写在读者会撞见的地方，而不是埋起来。
