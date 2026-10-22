---
type: Guide
title: Agent 提示词
description: 让 Agent 按思路写出一套带注解的孪生程序集代码 —— 可复制的提示词与验证闭环
tags: [agent, prompt, template, twin]
status: draft
---

# Agent 提示词

[← 文档索引](index.zh-CN.md)

**这不是随仓库发布的工具，是一组提示词起点。** drawcode 本身没有「agent 模式」；它的作用是让
Agent 写出的代码**可被验证**：注解键是固定的，读出来是确定的 JSON，编译一下就知道对不对。

所以用 Agent 做孪生程序集时，闭环始终是同一个：

```
思路 / 设计 → Agent 写带注解的代码 → 编译 → inspect 读出结构 → 数字对不对
```

前面可以很自由，最后一步不能省。

## 给 Agent 的硬规则（先贴这一段）

把下面这段连同你的具体任务一起给 Agent，它决定了产出能不能被读出来：

```text
你在为一个 drawcode 项目写代码。规则：

1. 先读这两个文件，不要凭印象：
   - templates/csharp/DrawcodeAttributes.cs（C# 可用的特性与全部键）
   - docs/annotations.md（每个键的语义与默认值）
2. 只使用模板里真实存在的键，绝对不要发明新键。写错的键会被静默忽略，
   不会报错，所以「看起来对」和「真的生效」是两件事。
3. 结构由编译器决定，你不要手写 size/offset —— C 侧由 sizeof/offsetof 自动填。
4. 不要修改函数体逻辑去「配合」注解。注释和特性只是声明层。
5. 写完后必须编译，并用 drawcode inspect 读一遍，把实际数字贴出来。
6. 读不出预期数量时，先怀疑注解键写错或成员不可被 IL 访问，
   而不是加大范围重写。
```

## 提示词 1：从思路生成 C# 孪生骨架

最典型的用法 —— 手上只有设计描述。

```text
读 templates/csharp/DrawcodeAttributes.cs 和 docs/annotations.md。

下面是我要建模的系统。请生成一套 C# 代码，让它编译后能被 drawcode 读出
模块交联、信号读写和持久化数据：

<在这里粘贴你的设计描述>

要求：
- 每个模块一个 public static class，类上用 [Drawcode(Root = "模块名")] 标成分解根
- 模块之间传递的数据用 static 字段声明为信号，加 [Drawcode(Direction.X, Unit, Alias)]
- 注意 Direction 是「相对本模块」的：In = 本模块产生，Out = 本模块消费。
  这与直觉相反，先确认每条信号的方向再写。
- 需要持久化的数据结构用 record 或 class，并标 [Drawcode(Store = true)]
- 模块之间的交互写成方法体里的读写语句（读 = 用到该字段，写 = 给它赋值），
  不要用注释描述交互 —— 边是从函数体扫出来的，注释不产生边

生成后请：
1. dotnet build 确认能编译
2. drawcode inspect 读产物，报告模块数、信号数、函数数、边数
3. 如果有信号没出现，说明原因
```

## 提示词 2：给已有 C# 代码补注解

代码已经存在，只是读不出结构。

```text
读 templates/csharp/DrawcodeAttributes.cs 和 docs/annotations.md。

下面是一个已有的 C# 模块。请不要改动任何业务逻辑，只补声明层注解：

<粘贴代码或给出文件路径>

要求：
- 先列出哪些成员适合作信号（可被 IL 访问的 static 字段），哪些不适合作
  （const 会被内联成字面量，IL 里没有字段访问，读不到）
- 每条信号给 Direction / Unit / Alias，方向按「相对本模块」判断
- 不要给方法加 Direction —— 方法默认就是组件函数
- 只改注解，不重排代码、不改格式

改完后 dotnet build，再 drawcode inspect 对比前后信号数与边数。
```

## 提示词 3：给 C 代码加元数据

C 侧用宏而不是特性，键是字符串标签。

```text
读 templates/c/DrawcodeMeta.h 和 docs/templates.md 的 C 部分。

给下面这个 C 模块补元数据声明：

<粘贴代码或给出文件路径>

要求：
- 类型用 DC_TYPE，信号用 DC_SIGNAL，函数用 DC_FUNCTION
- 标签写成 "tag1,tag2,alias=...,unit=...,init=..." 的形式
- 只使用头文件里定义过的标签名；写错的标签会被当作未知标签忽略，不会报错
- 不要用 -flto 编译（LTO 会重排/合并段），链接参数与 --gc-sections 的注意事项见 docs/templates.md
```

## 提示词 4：让 Agent 读产物解释系统

反过来用 —— 产物已经在了，让 Agent 讲清结构。

```text
执行：drawcode inspect <产物路径> --out model.json

读 model.json，回答：
1. 这个系统由哪些模块组成，哪些是分解根
2. 主要的数据流路径有哪些（谁写谁读）
3. 哪些类型是持久化数据，字段构成是什么
4. 有没有悬空信号（只写不读、或只读不写）

只根据 JSON 里的内容回答，不要推测运行时行为 —— 产物里没有运行时代码路径。
```

## 验证闭环

Agent 写的东西必须过这一关，否则「读起来像孪生」和「真的是孪生」分不清：

```bash
# 1. 能编译
dotnet build

# 2. 结构读得出来
node typescript/bin/drawcode.ts inspect bin/Release/net9.0/YourProject.dll --out model.json

# 3. 数字对得上（把预期数量和你看到的对比）
node -e "const m=require('./model.json');console.log('modules',m.modules.length,'types',m.types.length,'signals',m.signals.length,'funcs',m.funcs.length,'edges',m.edges.length)"
```

也可以在 VS Code 里直接打开产物看（见[快速开始路径 B](../README.zh-CN.md)）。

## 常见坑

| 现象 | 原因 |
| :--- | :--- |
| 信号数量比预期少 | 用了 `const`（被内联，IL 里没有字段访问）；或忘了写 `Direction` |
| 某个键不生效，也不报错 | 键名拼错。C# 是强类型会编译报错，C 是字符串标签会静默忽略 |
| 没有边 | 交互只写在注释里，函数体里没有实际的读写语句 |
| 产物读出来是空的 | 开了 `PublishTrimmed` 或 `PublishSingleFile`，特性被裁掉或元数据被藏进 bundle |
| 方向看起来全反了 | `In`/`Out` 是相对本模块，不是相对于数据的流向 |

## 相关

- 元数据模板的完整参数表：[`templates.md`](templates.md)
- 每个注解键的语义：[`annotations.md`](annotations.md)
- 产物 JSON 的字段定义：[`artifact-format.md`](artifact-format.md)
- 想给 drawcode 接一门新语言（不是写业务代码）：[`../typescript/SKILL.md`](../typescript/SKILL.md)
