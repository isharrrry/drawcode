---
type: Guide
title: 注解
description: 注解键的字段级参考 —— C 侧的 @drawcode 与 @device 注释块，以及 C# 侧的 Drawcode 与 Device 特性
tags: [annotations, parsing, attributes, comments, reference]
status: stable
---

# 注解

[English](annotations.md) | **中文** | [Español](annotations.es.md)

[← 文档索引](index.zh-CN.md)

注解承载的是解析器无法从源码推断的两样东西：**方向**（这个信号是输入还是输出？）与**给人看的元数据**（人怎么称呼它？）。其余一切 —— 哪个函数读了哪个信号、哪个信号被写 —— 都由代码本身派生。

> **注解从不决定一条连线是否存在。** 连线存在，是因为某个函数体读或写了某个信号。改注释只会改标签文字，绝不会增加、删除或移动一条线。见[为什么注解不控制连线](#为什么注解不控制连线)。

## C 侧的方向：`dir` 键

方向是写在声明正上方 `@drawcode` 注释里的一个键。**只有带注解的顶层变量才是信号** —— 没有注解的声明，无论怎么写，都不算信号。

| `dir` 取值 | IR 里的 `dir` | 图上表现 |
| :--- | :--- | :--- |
| `dir=in` | `in` | 右尖五边形，标签 `type / in / unit` |
| `dir=out` | `out` | 左尖五边形，标签 `type / out / unit` |
| `dir=io` | `inout` | 椭圆，标签 `type / inout / unit` |
| 缺省 | `""` | 椭圆，标签上没有方向 |

```c
/// @drawcode dir=in unit="LSB" alias="原始采样值" note="上电后需校准"
int16_t g_raw;
```

### 没有头文件，也没有宏

早期版本的 drawcode 需要一个 `drawcode_signals.h` 头文件和 `SIGNAL_IN` / `SIGNAL_OUT` / `SIGNAL_IO` 宏。**两者都已经取消。** 方向现在就在注释里，所以没有任何东西需要包含、也没有任何东西需要链接 —— 注解是从源码文本读的，从不取自编译产物。

### 语法约束

声明由一条面向行的正则识别，一行一条：

```
(?P<ctype>.+?)\s*(?P<name>[A-Za-z_]\w*)(\[[^\]]*\])?\s*;
```

- **一行一条声明，以 `;` 结尾。** 结尾的分号是匹配的一部分；跨行的声明不会被识别。
- **声明必须带 `@drawcode`。** 没有注解的注释块，或注解挂在不是顶层变量的构造上，都不会产生任何信号。
- **数组声明符会被并进类型。** `float g_coeff[32];` 得到 `name = g_coeff`、`ctype = float[32]`；后缀被贴回类型，所以标签读作 `float[32] / in / coeff`。
- **信号接受 `dir`、`unit`、`alias`、`note` 和 `external`。** 几何类的键属于函数 —— 见下面的键表。

## C# 里的方向：`[Drawcode]` 特性

C# 侧没有注释键这套约定，所以 C 侧写在注释里的**全部**东西，在这里由一个特性承担。方向是它的第一个位置参数。

```csharp
[Drawcode(Direction.In, Unit = "LSB", Alias = "原始采样值", Note = "上电后需校准")]
public static short g_raw;
```

| 特性写法 | IR 里的 `dir` |
| :--- | :--- |
| `[Drawcode(Direction.In)]` | `in` |
| `[Drawcode(Direction.Out)]` | `out` |
| `[Drawcode(Direction.Io)]` | `inout` |
| `[Drawcode]` / `[Drawcode(Direction.None)]` | `""` |

特性绑定到它**之后的下一个字段、属性或方法声明**，中间的空白行、`using`、`namespace`、`#` 开头的行和裸花括号都会跳过。位置参数可以整个省略（`[Drawcode(Alias = "…")]`），那时该成员只被记录、不带方向。`DrawcodeAttribute`、`DeviceAttribute` 和 `Direction` 必须存在于你的工程里 —— 把 [`examples/small/cs/DrawcodeAttributes.cs`](../examples/small/cs/DrawcodeAttributes.cs) 拷贝一份即可。

## 注解语法

### C：注释键

```c
/// @drawcode unit="LSB" alias="原始采样值" note="上电后需校准"
int16_t g_raw;
```

识别两个标签，都写在 `///` 行（可带前导空白）的开头：

| 标签 | 承载 | 键 |
| :--- | :--- | :--- |
| `@drawcode` | 实体自身的元数据 | 见下面两张键表 |
| `@device` | **函数**的器件主数据 | `vendor` `model` `spec` `size` `asset` |

### C#：特性

```csharp
[Drawcode(Alias = "ADC 采样", Tooltip = "上电后需先校准")]
[Device(Vendor = "TI", Model = "ADS1115", Spec = "16bit/860SPS", Size = "2.0x3.0mm", Asset = "assets/ads1115.svg")]
public static short AdcRead()
```

同样是这两个概念，只是用特性表达。`[Device]` 取代了旧的 `/// <device />` 注释，因此它不再是文档注释，也不再进入 XML 文档输出。

### 键怎么读

C 侧，连续的 `///` 行会积累，当遇到非 `///`、非空白的行时被**冲刷**；空白行会清空缓冲区，所以注释块必须紧贴它注解的东西。C# 侧，特性向后绑定到下一个声明，中间的空白行、`using`、`namespace`、`#` 开头的行和裸花括号都会跳过。

C 侧的键值对由 `(\w+)\s*=\s*"([^"]*)"` 读取：**键是裸词，值必须双引号包裹，且值里不能含双引号。** C# 侧的键则是特性的具名属性。未知的键被静默忽略而不是报错，这让注解在各实现之间可以向前兼容。
## 键参考：信号

适用于 C 侧带 `@drawcode` 注解的顶层变量，与 C# 侧带 `[Drawcode]` 特性的字段和属性。五个键在两种语言里行为完全一致；`dir` 已在上文说明。

| 键 | 类型 | 默认值 | 作用 | 示例 |
| :--- | :--- | :--- | :--- | :--- |
| `unit` | 字符串 | `""` | 节点标签的第三个元素，排在 `ctype / dir` 之后。纯描述，不对它做任何运算。 | `unit="LSB"` |
| `alias` | 字符串 | `""` | 人类名称，作为节点的**自定义属性**（不进标签）。标签始终显示 C 标识符。 | `alias="原始采样值"` |
| `note` | 字符串 | `""` | 自由文本备注，写入 `<object>` 自定义属性。不在标签里渲染。 | `note="上电后需校准"` |
| `external` | `"true"` / 缺省 | `false` | 标记该信号来自模块集合之外。按字符串 `"true"` 解析；其它任何值（含 `"True"`）都保持 `false`。 | `external="true"` |

标签的组装方式是：第一行 `name`，第二行 `ctype / dir / unit`，空的部分跳过 —— 所以没有 `unit` 的信号读作 `int16_t / in`，而不是 `int16_t / in / `。

## 键参考：函数

适用于 C 的函数声明与 C# 的方法。

| 键 | 类型 | 默认值 | 作用 | 示例 |
| :--- | :--- | :--- | :--- | :--- |
| `alias` | 字符串 | `""` | 用作节点的**标题行**，替代函数名（显示 `ADC 采样()` 而不是 `adc_read()`）。真名仍出现在第二行。 | `alias="ADC 采样"` |
| `note` | 字符串 | `""` | 自由文本备注，写入 `<object>` 自定义属性。 | `note="上电后需先校准"` |
| `tooltip` | 字符串 | `""` | 悬停提示，写入 `<object>` 自定义属性。 | `tooltip="上电后需先校准"` |
| `asset` | 字符串 | `""` | 节点图片路径，写入 `<object>` 自定义属性。**路径只是记录，不做解析** —— 不读文件，目标不存在也不算错。 | `asset="assets/ads1115.svg"` |
| `external` | `"true"` / 缺省 | `false` | 把节点样式切成虚线外部形态。 | `external="true"` |
| `xy` | `"x,y"` | 未设 | 节点在画布上的初始位置，用画布绝对坐标。对该节点覆盖默认堆叠。 | `xy="420,160"` |
| `size` | `"WxH"` | `180x72` | 节点初始尺寸。分隔符是小写 `x`；切分前会先转小写，所以 `180X72` 也可用。 | `size="180x72"` |

**节点几何只有 C 侧支持：`xy` 和节点 `size` 都只在一侧读。** `csparse.py` 从不调用 `meta.get("xy")` 或 `meta.get("size")`，所以 C# 方法永远由默认算法定位并定尺。不要把它与 `@device` / `[Device]` 上的 `size` 键混淆 —— 那是器件的物理封装尺寸，**两侧都会读**；它们是碰巧同名的两个不同的键。这是两个前端之间真实存在的不对称，不是本文档的疏漏。

## 键参考：器件

`@device`（C）/ `[Device]`（C#）把器件主数据挂到**函数**上 —— 典型场景是一个驱动入口对应一颗芯片。它存放在 `Model.devices`，以函数 id 为键。

| 键 | 类型 | 默认值 | 作用 | 示例 |
| :--- | :--- | :--- | :--- | :--- |
| `vendor` | 字符串 | `""` | 写入节点的 `<object>` 自定义属性。 | `vendor="TI"` |
| `model` | 字符串 | `""` | 同上。 | `model="ADS1115"` |
| `spec` | 字符串 | `""` | 同上。 | `spec="16bit/860SPS"` |
| `size` | 字符串 | `""` | 同上 —— 并且请留意下面的警告。 | `size="2.0x3.0mm"` |
| `asset` | 字符串 | `""` | 同上。**若函数自身的 `asset` 仍为空，还会回填到它上面**，这样器件图片只需声明一次。 | `asset="assets/ads1115.svg"` |

### 两个都叫 `size` 的键毫无关系

`@drawcode size="180x72"` 与 `@device size="2.0x3.0mm"` 只共享一个名字，别的什么都不共享。

| | `@drawcode size` | `@device size` |
| :--- | :--- | :--- |
| 含义 | 节点的**几何尺寸**，画布单位 | 关于物理器件的**描述字符串** |
| 解析方式 | 两个浮点数，按小写 `x` 切分 | 不透明字符串，原样存储 |
| 存储位置 | `Func.w` / `Func.h` | `Device.size` |
| 到达图上的形态 | `mxGeometry` 的 `width` / `height` | `<object>` 自定义属性 |
| 写错的后果 | `float()` 抛异常 —— 这是唯一一处格式错误的注解会致命 | 无；任何字符串都接受 |

因为两者都用同一个 `k="v"` 语法书写、又常出现在同一个注释块里，这是最常见的注解错误。区别在于这个键挂在哪个标签下。

## 每个键最终落在哪里

每个注解键最终落在三个位置之一。搞清这一点，就能解释大多数「我改了注解但什么都没发生」的反馈。

| 归宿 | 键 | 在图上表现为 |
| :--- | :--- | :--- |
| 节点**标签文字** | `unit`（信号）、`alias`（函数） | 图形内部渲染出来的字符 |
| `<object>` **自定义属性** | `alias` `note`（信号）；`ret` `alias` `note` `tooltip` `asset`（函数）；器件五个键 | 元素属性，在 draw.io 的 Edit Data 对话框里可见 |
| **几何** | `xy`、`@drawcode size`、以及被 `@device` 标注的函数的位置 | 节点坐标 |

信号的 `alias` 刻意*不*进标签：两个信号可以起同一个别名而不会在画布上变得无法区分。注意 `read_layout` 会把 `alias`、`unit`、`note`、`tooltip` 和 `dir` 从 `<object>` 属性里读回来，所以这五个键可以经过手工编辑的图往返；较新的器件键会被写出，但不在这条回读路径上。

## 为什么注解不控制连线

`rebuild_edges()` 是边的唯一生产者，而它从不看注释：

```
for f in funcs:
    for sid in f.reads:  edges.append(Edge(sid, f.id, "read"))
    for sid in f.writes: edges.append(Edge(f.id, sid, "write"))
```

`f.reads` 与 `f.writes` 来自 `_def_use()`，它在剥掉注释之后扫描**函数体文本**：

- 语句按 `;`、`{`、`}` 切分；
- 复合赋值（`+=`、`<<=` 等）把左侧同时标为读和写，右侧标为读；
- 普通 `=` 把左侧标为写、右侧标为读；
- 语句里的其它一切计为读；
- 找到的每个标识符再与已声明信号名集合过滤 —— 不是信号的名称（局部变量、形参、库函数）被丢弃。

由此直接得到两个结论，而两者都常让人意外：

1. **注释永远无法创建或删除一条边。** `alias` 是元数据，`unit` 是元数据；不存在「这个函数读了 `g_raw`」这种注解，因为函数体已经说了。
2. **箭头方向跟着读/写走，不跟着注解走。** `read` 边是*信号 → 函数*，`write` 边是*函数 → 信号*。把一个信号注成 `dir=out` 并不会把它的读边变成写边。

把 `g_raw` 从 `dir=in` 改成 `dir=out`，改的是标签文字和节点的 `dir` 属性。它不会移动任何一条线。想让一条边消失，就删掉读或写那个信号的那条语句。

## 解析器不靠注解推断出什么

下面这些规则不需要注解，因为它们从代码结构本身就能得出。

| 规则 | 图上的结果 |
| :--- | :--- |
| **形参是端口，不是节点。** 解析成 `Param(name, ctype)` 并挂在函数上。 | `void dsp_set_gain(uint8_t gain)` 产生一个函数节点。没有 `gain` 椭圆，也没有连到它的边。 |
| **局部变量不入图。** 只有能解析到已声明信号的标识符才能通过 `_def_use` 过滤。 | `adc_read()` 里的 `int16_t v` 不可见。 |
| **一条声明一个节点。** 解析器把声明的类型字符串原样带成 `ctype`，从不遍历类型的成员。 | 结构体类型的信号是一个椭圆，用结构体类型作标签；绝不会展开成每个字段一个节点。 |
| **函数按形态识别，不靠注解。** 匹配函数模式、且不是 C 控制关键字（`if`、`for`、`while`、`switch`、`return`、`sizeof` 等）的行就成为函数。 | 没有注解的函数照样得到节点 —— 只是没有别名，所以节点用真名作标题。 |
| **头文件声明优先于定义。** 同一个名字同时出现在 `.h` 和 `.c` 时，优先取头文件里的键。 | 在头文件里写注解，就像示例那样。 |
| **容器就是文件。** 每个实体的 `group` 是源文件的主名。 | `adc.h` 里的实体落进名为 `adc` 的容器。 |
| **多语言合并是拼接，不是符号解析。** | C 与 C# 输入产生同一个合并 IR，但跨语言引用同名符号不会被连接。 |

## 回写

`sync` 只重写声明层，别的什么都不碰。对每个实体，它从 IR 渲染出注解块并替换既有的 span，文件里其余每一个字节保持原样。

| 字段 | 回写成 |
| :--- | :--- |
| 信号 `unit` `alias` `note` `external` | `/// @drawcode …`（C）或 `[Drawcode(…)]`（C#） |
| 信号 `dir` | 键 `dir=in` / `dir=out` / `dir=io`（C），或位置参数 `Direction.X`（C#） |
| 函数 `alias` `note` `tooltip` `external` | `/// @drawcode …`（C）或 `[Drawcode(…)]`（C#） |
| 器件各键 | `/// @device …`（C）或 `[Device(…)]`（C#） |
| 函数**体** | **永不** —— 这是设计约束，不是缺失 |

`drawcode` 不管理的键 —— 尤其是手写在函数上的 `xy` 或 `size` —— 在重写注解行时会**原地保留**，并维持原有顺序。给一个已注解的函数加个 note，不会悄悄丢掉它的坐标。

## 相关

- [architecture.md](architecture.md) — 分层、数据流，以及为什么不落盘 IR
- [drawio-format.md](drawio-format.md) — 被注解的实体如何变成 `.drawio` 元素
- [`examples/small/cs/DrawcodeAttributes.cs`](../examples/small/cs/DrawcodeAttributes.cs) — C# 特性定义，拷贝即可用
- [`examples/small/c/adc.h`](../examples/small/c/adc.h) 与 [`examples/small/cs/Adc.cs`](../examples/small/cs/Adc.cs) — 所有键在一处的完整用例
