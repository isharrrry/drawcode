# 文档

[English](index.md) | **中文** | [Español](index.es.md)

> [drawcode](../README.zh-CN.md) 的文档 —— 一个代码 ↔ 数据流图双向工具，源码是唯一的真相来源。

英文版先写、写完整；中文版与它同步维护。2026-10 整合之前留下的西语页面标为「已过时」，
并指向英文版。

## 主题

| 主题 | 语言版本 | 涵盖内容 |
| :--- | :--- | :--- |
| **架构** | [English](architecture.md) · [中文](architecture.zh-CN.md) · [Español](architecture.es.md) | 分层、每个模块的职责边界、两条数据流（build 与 sync），以及拒绝持久化中间表示的理由 |
| **注解** | [English](annotations.md) · [中文](annotations.zh-CN.md) · [Español](annotations.es.md) | 每个注解键的字段级参考：`@drawcode` 与 `@device` 注释（C）、`[Drawcode]`、`[Device]` 与 `[Callout]` 特性（C#）—— 含类型、默认值与示例 |
| **`.drawio` 格式** | [English](drawio-format.md) · [中文](drawio-format.zh-CN.md) · [Español](drawio-format.es.md) | 元素映射、坐标系语义、锚点与路由规则，以及 draw.io 的压缩存储形态 |
| **实现** | [English](implementations.md) · [中文](implementations.zh-CN.md) · [Español](implementations.es.md) | 如何构建、测试与调用 TypeScript 实现，以及金标准钉住什么 |
| **程序集产物格式** | [English](artifact-format.md)（暂无中文版） | `inspect` 输出的 `ArtifactModel`：支持的二进制、稳定 id、诊断、规范化 JSON，以及这条路径为何与源码 IR 分离 |
| **示例** | [English](examples.md)（暂无中文版） | `small/`、`medium/`、`plain/` 三个示例工程、用作拒绝样本的 draw.io 导出件，以及各自的跑法 |
| **元数据模板** | [中文](templates.md)（暂无英文版） | 让编译产物可解析的最小附加物：C（ELF）的 `DrawcodeMeta.h/.c` 与 C# 的 `DrawcodeAttributes.cs` |
| **VS Code 扩展** | [中文](vscode-extension.md)（暂无英文版） | Drawcode Artifact Viewer：只读浏览程序集、三个视图、程序集树、导出与设置 |
| **参与贡献** | [English](contributing.md) · [中文](contributing.zh-CN.md) · [Español](contributing.es.md) | 环境、跑测试、加金标准用例、加一门源语言，以及刻意未验证的事项 |

## 从哪里开始

| 你想…… | 去这里 |
| :--- | :--- |
| 理解设计为什么是这个形状 | [架构](architecture.zh-CN.md) |
| 第一次给自己的代码加注解 | [注解](annotations.zh-CN.md) → 然后是[快速开始](../README.zh-CN.md#快速开始) |
| 新增一门源语言（Rust、Go……） | [架构](architecture.zh-CN.md#模块分层) → [参与贡献](contributing.zh-CN.md) |
| 自己实现完整能力 | [`typescript/SKILL.md`](../typescript/SKILL.md) |
| 了解一致性测试比较什么 | [`conformance.md`](conformance.md) |
| 让编译产物变得可读 | [元数据模板](templates.md) |
| 在 VS Code 里浏览程序集 | [VS Code 扩展](vscode-extension.md) |
| 跑一下仓库自带的示例工程 | [示例](examples.md) |
| 诊断一张丢了排版的图 | [`.drawio` 格式](drawio-format.zh-CN.md#压缩存储形态) |
| 不装 draw.io 就把 `.drawio` 渲染成图片 | [参与贡献 § 离线渲染](contributing.zh-CN.md#离线渲染) |

## 关于这些文档

1. **每个数字都来自真正跑过的命令。** 没有任何估测。凡是尚未测量的数字，
   文档会如实说明，并指向[已知限制](../README.zh-CN.md#已知限制诚实列出)，
   而不是把它填上。
2. **改行为就要在同一次改动里更新英文文档与中文翻译。** 一个只存在于
   单一语言版本里的行为描述是缺陷，不是翻译滞后；未修订的西语页面会标注「已过时」。
3. **未验证与已知损坏的行为都会被明确写出。** 有两个例子值得点明：
   SVG 预览不与 `.drawio` 共享边路由，离线渲染器也画不出
   `jumpStyle` 跳线。两处都写在读者会撞见的地方，而不是埋起来。
