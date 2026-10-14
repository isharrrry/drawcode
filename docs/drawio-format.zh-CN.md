---
type: Guide
title: .drawio 格式
description: 元素映射、坐标系语义、路由规则与 draw.io 的压缩存储形态 —— drawcode 与图文件之间的完整契约
tags: [drawio, format, xml, coordinates, compression]
status: stable
---

# `.drawio` 格式

[English](drawio-format.md) | **中文** | [Español](drawio-format.es.md)

[← 文档索引](index.zh-CN.md)

`.drawio` 文件是 `drawcode` 除源码之外唯一写出的产物，它同时扮演两个角色：它是 IR 的**派生的视图**，又是**布局的唯一载体** —— 而布局正是这个系统里唯一无法从代码重建的东西。下面每一条规则都源自这两个角色之一。

## 生成文件的外形

```xml
<mxfile host="app.diagrams.net" agent="drawcode" type="device">
  <diagram id="drawcode" name="dataflow">
    <mxGraphModel dx="1200" dy="800" ... >
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <!-- containers, then nodes, then edges -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

`mxCell id="0"` 是图根，`id="1"` 是它的默认图层；两者都是 schema 要求的，也都不承载数据。其余一切都挂在 `id="1"` 下。

## 元素映射

| IR 概念 | XML 形态 | 父元素 | 说明 |
| :--- | :--- | :--- | :--- |
| 容器（`group`） | `<mxCell vertex="1">`，带 `swimlane` 样式 | `1` | `value` 是组名；几何坐标是**绝对**的 |
| 信号 / 函数 | `<object>` 包一个 `<mxCell vertex="1">` | 所在容器 cell | 几何坐标**相对容器** |
| 边 | `<object>` 包一个 `<mxCell edge="1">` | 源与目标同容器时为该容器，否则为 `1` | 几何坐标相对于父元素 |

### 节点用 `<object>` 属性承载数据

裸的 `<mxCell>` 没有地方放自定义属性，所以每个节点与每条边都被包进一个 `<object>` 元素，语义载荷就放在那里：

```xml
<object id="n3" label="g_raw&lt;br&gt;int16_t / in / LSB" symbolId="adc.h::g_raw"
        kind="signal" ctype="int16_t" dir="in" unit="LSB"
        alias="原始采样值" note="上电后需校准">
  <mxCell style="shape=path;path=0,0 115,0 160,30 115,60 0,60;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;"
          vertex="1" parent="grp1">
    <mxGeometry x="30" y="202" width="160" height="60" as="geometry" />
  </mxCell>
</object>
```

| 属性 | 含义 | 是否回读 |
| :--- | :--- | :--- |
| `symbolId` | IR 的 id，形如 `"<文件>::<名称>"` —— 图与代码之间的连接键 | 是，作为映射的键 |
| `kind` | `signal` 或 `func`，决定样式与标签形态 | 否 |
| `label` | 渲染出来的文字；`&lt;br&gt;` 是换行 | 否 |
| `ctype` `dir` `unit` | 信号语义在属性里的镜像 | `dir` 是，其余否 |
| `alias` `note` `tooltip` | 注解值 | 是 |
| `ret` `asset` | 函数返回类型与图片路径 | 否 |
| `vendor` `model` `spec` `size` | 器件数据，仅在用了 `@device` / `[Device]` 时存在 | 否 |

`read_layout` 恰好回读五个可写字段 —— `alias`、`unit`、`note`、`tooltip` 和 `dir` —— 因为这几个才是人会在 draw.io 里编辑的字段。其余都只是为了显示而写出，读入时忽略。

### 节点样式就是五个常量

| 常量 | 适用于 | 样式串 |
| :--- | :--- | :--- |
| `SIGNAL_IN_STYLE` | `dir=in` 的信号 | `shape=path;path=0,0 115,0 160,30 115,60 0,60;…` —— 右尖五边形 |
| `SIGNAL_OUT_STYLE` | `dir=out` 的信号 | `shape=path;path=45,0 160,0 160,60 45,60 0,30;…` —— 左尖五边形 |
| `SIGNAL_STYLE` | `dir=io` 或无方向的信号 | `shape=ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;` |
| `FUNC_STYLE` | 函数 | `rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;` |
| `FUNC_EXT_STYLE` | `external="true"` 的函数 | 同上，外加 `dashed=1`，填充与描边转灰 |

五边形把流向做进形状本身，所以不再往节点上叠任何记号。
尖角精确落在左右边缘中点 —— 正是 `ANCHOR_SETS` 首选的那两个点 ——
所以进出线咬在尖角上而不是平边上。`_conn_side` 把这一点固定下来：
`in` 信号一律接在**右侧**、`out` 信号一律接在**左侧**，
无论它是边的起点还是终点。

容器样式由 `CONT_STYLE` 加上 `startSize=30` 构成：swimlane 标题带高 30 单位，而 `_container_box` 正是为最上方的成员额外预留了这么多高度。

## 坐标系语义

> **`mxGeometry` 与 `mxPoint` 的坐标是相对父 cell 的，不是相对画布的。** 容器内的节点存的是它相对该容器左上角的偏移。容器自己存的是它在画布上的位置，因为它的父元素是图层。

两个函数负责在两种空间之间换算，而且换算必须严格互逆，否则每一次往返都会让位置漂移一点：

| 方向 | 函数 | 操作 |
| :--- | :--- | :--- |
| IR → XML | `to_drawio` | 减去容器原点：`x - ox`、`y - oy` |
| XML → IR | `read_layout` | 调用 `_origin(cells, parent)` 并**加上**累加出来的偏移 |

### `_origin` 是读入方向唯一的换算点

```python
def _origin(cells, cid):
    x = y = 0.0
    while cid and cid not in ("0", "1") and cid in cells and cid not in seen:
        geom = cells[cid]["cell"].find("mxGeometry")
        if geom is not None:
            x += float(geom.get("x") or 0)
            y += float(geom.get("y") or 0)
        cid = cells[cid]["parent"]
    return x, y
```

它从某个 cell 沿 `parent` 链一路走到图层，把每一级祖先的 `x`/`y` 求和。`seen` 集合用来防住父链成环的畸形文件 —— 没有它，一个被手工改坏的图会让读取器挂死，而不是失败。

这是嵌套深度被压平的唯一位置。任何跨不同嵌套层级的坐标比较都必须在这层换算**之后**做；比较原始值只会报出幽灵漂移。见[归一化规则](#归一化规则)。

边的拐点同理：`to_drawio` 写出的是 `px - ox`、`py - oy`，其中 `(ox, oy)` 是**该边自己父元素**的原点 —— 对跨容器的边来说就是 `(0, 0)`，因为那种边挂在图层上，本来就已经处于画布空间。

## 容器与嵌套

容器按**源文件**创建，而不是按目录。每个实体的 `group` 是文件主名（`adc.h` 与 `adc.c` 都得到 `adc`），所以头文件与它的实现共享一个容器。

| 步骤 | 规则 |
| :--- | :--- |
| 容器 id | `grp1`、`grp2`…… 按**组名排序**分配，因此 id 跨多次运行保持稳定 |
| 容器边界 | `_container_box`：`min(x) - 30`、`min(y) - 60`，宽 `max(x2) - min(x) + 60`，高 `max(y2) - min(y) + 60 + 30` |
| 水平避让 | 各组按排序顺序排布；若某组的框会落在上一组右边界再加 `4 * 30` 的左侧，整组右移 |
| 边归属 | 源与目标同组时 `parent = grpN`，否则 `parent = "1"` |

`PAD = 30` 的边距与 `HEADER = 30` 的标题带就是这些常量的贡献：四边各 30，再加最上方成员之上预留的 30 给 swimlane 标题。

**关于「最内层公共容器」。** 规范是这么描述边归属的，而它落到的就是上面这两条：由于容器目前只有一层，两个实体共同的最内层容器在组相同时就是它们自己的组，不同时就是根图层。深度是容器模型的性质，不是归属规则的性质。

## 边的表达

边是文件里不变量最多的部分，因为若不加以约束，draw.io 会自己给它选路由。

### 基础样式

```
edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;jumpStyle=arc;jumpSize=6;
```

`orthogonalEdgeStyle` 把线段限制在水平与垂直方向；`rounded=1` 让拐角变圆；`jumpStyle=arc` 要求两条边交叉处画弧形跳线。注意 `jumpStyle` 是 draw.io 的扩展，不在开源 mxGraph 核心里 —— 生成的文件把它配置正确、draw.io 客户端也会照做，但随仓库附带的离线渲染器画不出来。这一限制在[已知限制](../README.md#known-limitations-listed-honestly)里有说明。

### 锚点

锚点把一个端点钉在节点包围盒的确定位置上，用宽高的比例表示：

```
exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;
```

`exitX`/`exitY` 定位源节点上的起点，`entryX`/`entryY` 定位目标节点上的终点；`Dx`/`Dy` 那两对是 draw.io 的偏移槽位，这里恒为零。`0,0` 是左上角，`1,1` 是右下角，所以 `exitX=1;exitY=0.5` 意思是「右边中点」。

路由器按固定顺序尝试八组锚点组合 —— 先试四组对向组合，再试四组同侧组合，后者存在的意义就是支撑侧向绕行：

| 顺序 | exitX, exitY | entryX, entryY | 形态 |
| :--- | :--- | :--- | :--- |
| 1 | 1, 0.5 | 0, 0.5 | 右边到左边 |
| 2 | 0, 0.5 | 1, 0.5 | 左边到右边 |
| 3 | 0.5, 1 | 0.5, 0 | 底边到顶边 |
| 4 | 0.5, 0 | 0.5, 1 | 顶边到底边 |
| 5 | 1, 0.5 | 1, 0.5 | 右边到右边 |
| 6 | 0, 0.5 | 0, 0.5 | 左边到左边 |
| 7 | 0.5, 0 | 0.5, 0 | 顶边到顶边 |
| 8 | 0.5, 1 | 0.5, 1 | 底边到底边 |

顺序只用于打破平局：每一组组合都按最终路径长度评分，最短且不撞的那个胜出。如果**没有任何**组合能得到干净路径，就完全不输出锚点属性，交回 draw.io 自己路由 —— 一条没有锚点的边，被认为比一条带着锚点却穿过节点的边更好。

### 拐点与路由

中间点放进边 `mxGeometry` 的 `<Array as="points">` 子元素：

```xml
<mxGeometry relative="1" as="geometry">
  <Array as="points">
    <mxPoint x="690" y="332" />
    <mxPoint x="690" y="238" />
  </Array>
</mxGeometry>
```

`relative="1"` 标记这个数组是相对边父元素的偏移。没有中间点时，几何塌缩成自闭合的 `<mxGeometry relative="1" as="geometry" />` 形态。

路由器是一个小规模的「生成—检验」循环，而不是通用寻路器：

| 步骤 | 函数 | 做什么 |
| :--- | :--- | :--- |
| 候选生成 | `_candidates` | 对一组锚点，产出若干正交走法：走跨容器缝隙、两种顺序的 L 形、侧向通道，以及带通道偏移的变体 |
| 缝隙路由 | `_cross_gap` | 两容器不重叠时，返回它们之间空缝的轴向与中点；重叠时返回空 |
| 通道偏移 | `_lane_pt` | 把端点沿它所在边的外法线方向挪 15 单位，让线先离开边框再拐弯，而不是贴着边框走 |
| 碰撞检测 | `_crosses` | 线段是否进入节点框？两端各收缩 3 单位、框各外扩 2 单位，所以停在边界上的端点不算碰撞 |
| 评分 | `_length` | 曼哈顿长度；活下来最短的那条胜出 |

塑造这一切的常量是 `DETOUR = 15`（通道偏移）、`SLACK = 2`（碰撞检测的框外扩）与 `SHRINK = 3`（端点回缩）。障碍集合**包含源节点与目标节点自己** —— 没有这一条，一条路径完全可以沿着自己节点的边框走，看起来就像线是**穿过**框画过去的。

## 压缩存储形态

> **这就是会弄丢工作的那个失败模式。** draw.io 保存时默认压缩图内容。只读纯 XML 的实现会在用户刚手工排好版之后，**报出空布局且不报错** —— 用户设过的每一个坐标都被无声丢弃。

### 确切的变换

```
base64( raw-deflate( url-quote( xml ) ) )
```

在 Python 里读它是三次调用，而 `decompress` 的第三个参数正是关键：

```python
urllib.parse.unquote(zlib.decompress(base64.b64decode(data), -15).decode("utf-8"))
```

`-15` 选择 raw DEFLATE，也就是去掉 2 字节头与 4 字节校验和的 zlib 流。用默认的 `zlib.decompress(data)` 会抛异常，因为这个流没有 zlib 包裹。还要注意载荷是**先解压再做 UTF-8 解码**：XML 是百分号编码的，所以多字节字符是以 `%XX` 转义而不是原始字节的形式活过往返的。

写出侧，转义字符集同样要紧。不做转义的字符是 `~()*!.'` —— Python 的 `urlquote` 还会额外放过 `/` 和 `:`，那会产出 draw.io 读不回去的载荷。

### 两种形态都读，坏载荷抛错

`_unpack` 接受两种形状：

| 输入 | 行为 |
| :--- | :--- |
| `<diagram>` 带 `<mxGraphModel>` 子元素 | 原样返回 —— 这是纯文本形态 |
| `<diagram>` 的文本是压缩载荷 | 就地解开并追加 `<mxGraphModel>`，让下游代码只面对一种形状 |
| `<diagram>` 文本为空 | 跳过 —— 有些文件带着占位 diagram |
| `<diagram>` 文本解不开 | **抛 `ValueError`** |

最后一行是值得明说的设计决策：返回空布局与「这张图确实没有布局」无法区分，调用方会用默认值覆盖掉手工排版。抛错让损坏在失败点就可见。`conformance.md` 把这条列为必需能力而不是加分项，并要求三个实现行为一致。

因为两种形态展开成同一棵树，`read_layout` 对形态无感：同一个文件由 drawcode 生成、再被 draw.io 另存，读出来的 nodes、edges、attrs 完全相同。这条相等性是对着一个 draw.io 压缩过的金标准文件断言的。

## 往返幂等

构建两次不得移动任何东西。难点在于：**生成器把自己的拐点写进文件之后，就分不清哪些是自己的、哪些是人拖的** —— 于是下一次运行会把自家输出当成人的意图保留下来，路由算法从此再也无法改进。

解法是一次比较，而不是一个标记：

1. `apply_layout` 先从文件灌入节点坐标，让模型反映真实位置。
2. `_auto_waypoints(model)` 随后**针对这些坐标**重算：如果拐点由今天的生成器产生，每条边的拐点会是什么。
3. 对每条边，采用文件里的拐点；若它与刚算出的自动值相等，就**丢弃** —— 这条边不保留任何拐点，`to_drawio` 会从头重新为它路由。
4. 凡与自动值**不**相等的都保留，因为那一定是人动过。

由此得到的几条后果值得写清：

| 情形 | 结果 |
| :--- | :--- |
| 构建 → 不作任何编辑再构建 | 文件逐字节相同；自动拐点被重算成同一批值 |
| 构建 → 在 draw.io 里拖一个节点 → 构建 | 节点移动，各边针对新位置重新路由 |
| 构建 → 拖拽某一条边的走线 → 构建 | 那条边保留自己的路径；其余重算 |
| 路由算法发生变化 | 旧的自动拐点不再匹配，于是被**保留**下来，看起来像手工画的；不带 `--layout-from` 重建才能吃到新路由 |

最后一行是诚实的边界情形：这个启发式分不清「上一版自动生成的」与「人画的」。加一个标记属性可以解决，代价是把生成器的记账信息塞进一个由人编辑的文件里。

## 归一化规则

实现之间的比较是结构性的，绝不逐字节。属性顺序无关，无意义的空白无关，数字按值而非拼写比较 —— `420`、`420.0` 与 `4.2e2` 相等。生成的 `id` 值（`n1`、`e1`、`grp1`）除了「在一次运行内唯一且稳定」之外不属于契约；被比较的是从 `symbolId` 到几何的映射。完整清单（含一次失败该归到四个比较层级中的哪一层）在 [`conformance.md`](conformance.md)。

那条清单里有一条值得在这里重述，因为它是 `.drawio` 格式规则而非流程规则：**元素顺序按文档顺序，规范注明「排序」的地方除外** —— 容器按 id、节点按 `symbolId`、边按三元组 `(src, dst, rw)`。比较前先排序，才使得比较结果与字典迭代顺序无关，而那个顺序在 Python 与 .NET 之间是不一样的。

## 相关

- [annotations.md](annotations.md) — `<object>` 上那些属性从哪来
- [architecture.md](architecture.md) — 为什么只回写声明层
- [`conformance.md`](conformance.md) — 比较层级与归一化规则
- [`tools/render/README.md`](../tools/render/README.md) — 不装 draw.io 也能把 `.drawio` 渲成图片
