---
type: Guide
title: 版本策略
description: 全仓共用一个版本号——哪些文件携带它，以及如何升级
tags: [versioning, release, contributing]
status: stable
---

# 版本策略

[English](versioning.md) | **中文**

[← 文档索引](index.zh-CN.md)

本仓**全仓共用一个版本号**。核心库与 VS Code 扩展一起发布：扩展把 `typescript/src` 编译进
`dist/core/`，并与它装进同一个 VSIX，因此核心单独编号只会描述一个任何包都不会单独处于的状态。

这是策略 **B**（统一版本）。被否决的另一种做法是核心与扩展各自独立编号——本仓不存在只有其中
一方发生变化的发布。

## 携带版本号的文件

| 文件 | 字段 |
| :--- | :--- |
| [`package.json`](../package.json) | 根编排包 |
| [`typescript/package.json`](../typescript/package.json) | 核心库 |
| [`editors/vscode/package.json`](../editors/vscode/package.json) | `drawcode-artifact-viewer`；Marketplace 页面显示的版本 |
| [`editors/vscode/package-lock.json`](../editors/vscode/package-lock.json) | 锁文件，顶层与 `packages[""]` |
| [`package-lock.json`](../package-lock.json) | 根锁文件，顶层与 `packages[""]` |

它们必须始终一致。不一致时 `npm run version:check` 会失败。

## 升级

```bash
npm run bump -- 0.5.0     # 重写上面所有文件
npm test                  # 提交前验证整仓
```

脚本只接受无前缀的 `MAJOR.MINOR.PATCH`，也不会碰 git：把版本文件与改动一起提交。只有真正发布时
才给提交打标签。

## 规则

- **一次升级对应一次发布。** 随 VSIX 发布的改动会推动扩展版本；核心被编译进同一个 VSIX，所以
  核心版本随它一起走。
- **VSIX 文件名跟随扩展版本**——`out/drawcode-artifact-viewer-<version>.vsix`。
- **不要手改单个 `version` 字段。** 只改一处会让 manifest、锁文件与 VSIX 互相矛盾，这正是
  `npm run version:check` 要拦住的情况。
- **1.0 之前，破坏性变更仍然只升 minor。** 目前没有稳定的公开 API；判断改动大小的依据是
  变更记录与一致性测试，而不是版本号的某一位。
