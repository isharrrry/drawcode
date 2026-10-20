# SKILL — 用 Python 实现「源码 ↔ drawio」双向转换

给 AI agent 的操作指南。读完这一篇，你应该能：看懂本实现、按它移植到别的语言、或给它加一门新的源语言。

参考实现：`python/src/drawcode/`（8 个模块，零第三方依赖）。判定口径见 [`../../docs/conformance.md`](../docs/conformance.md)。

## 一、先理解设计内核

**代码是唯一事实源。** 语义写在源码里，图是派生产物：

| 层 | 形态 | 持久 | 可重建 |
| :--- | :--- | :--- | :--- |
| 语义（信号/函数/方向/注解/器件） | **C / C# 源码** | ✅ 唯一事实源 | — |
| IR | 内存对象图 | ❌ **不落盘** | 每次从代码重建 |
| 布局（坐标/折线）+ 纯外观 | **`.drawio`** | ✅ 派生产物兼布局载体 | 语义可重建，**人工排版不可重建** |

推论（决定了后面所有取舍）：

- **不写中间 JSON**。一旦落盘 IR，就会有两份语义事实源，必然漂移，然后被迫发明 hash/drift 检测/三方合并来收拾。
- **布局不进代码**。坐标不参与编译；每拖一下就改 `.c` 会让 diff 爆炸、评审全是坐标噪声。所以布局留在 `.drawio`，由人拖拽产生，再回读进 IR。
- **反向只回写声明层**：`SIGNAL_*` 宏语句、`@drawcode`/`@device` 注解属性。**永不改写函数体逻辑**，这是设计约束不是缺失。

## 二、模块划分

| 模块 | 职责 | 关键入口 |
| :--- | :--- | :--- |
| `model.py` | IR：`Signal` / `Func` / `Param` / `Edge` / `Device` / `Model` | `Model.rebuild_edges()` |
| `cparse.py` | C → IR | `parse_project(files, root)` |
| `csparse.py` | C# → IR（同一套 IR） | `parse_cs_project(files, root)` |
| `parse.py` | 按扩展名分派、多语言结果合并 | `parse_any(files, root)` |
| `drawio.py` | IR ↔ `.drawio`（布局 + 路由 + 读回） | `to_drawio` / `read_layout` / `apply_layout` |
| `codegen.py` | IR → 代码（仅声明层） | `sync_source` / `sync_header` / `sync_functions` |
| `svg.py` | IR → SVG 预览（与 `.drawio` 同坐标） | `to_svg` |
| `cli.py` | `build` / `sync` 两个子命令 | `main(argv)` |

## 三、IR 的形状

```
Model
├── signals:  {id -> Signal}     id 形如 "adc.h::g_raw"
├── funcs:    {id -> Func}       id 形如 "adc.h::adc_read"
├── edges:    [Edge]             ← rebuild_edges() 从 reads/writes 派生
├── devices:  {func_id -> Device}
├── callouts: [Callout]          ← C# 前端的 [Callout(...)]，列表不是字典
├── pinned:   {id -> PinnedGeom} ← apply_layout 记下的「人拖过」几何，供回写
└── files:    [相对路径]

Signal: id, name, ctype, dir(in/out/inout), file, line, unit, alias, note,
        external, group, path, style, x, y, w, h
Func:   id, name, ret, params[Param], file, line, alias, note, tooltip,
        asset, external, group, path, style, reads[], writes[], calls[], x, y, w, h
Edge:   src, dst, rw(read/write|inline), waypoints[(x, y)], sig(被折叠的信号 id)
Callout: id, text, owner, shape(text|box|band), font_size, x, y, w, h
PinnedGeom: xy?[x, y], size?[w, h]   ← 两个键各自独立，只记真正变过的

Param:  name, ctype, dir
Device: vendor, model, spec, size, asset
```

**边不是解析出来的，是派生的**：`rebuild_edges()` 遍历每个 `Func`，为每个 `reads` 产生 `Edge(signal, func, "read")`，为每个 `writes` 产生 `Edge(func, signal, "write")`。所以「图上有没有这条线」完全由**函数体的代码扫描**决定（谁被读、谁被写），**与注释无关**——改注释只会改标签文字，一个像素都不会动连线。

## 四、正向流程：源码 → `.drawio`

```
files
 └─ parse_any(files, root)
     ├─ 按扩展名分派：.c/.h -> cparse，.cs -> csparse
     └─ 合并成单个 Model，再 rebuild_edges()
 └─ [可选] apply_layout(model, read_layout(旧 .drawio))      ← 复用人工排版
 └─ to_drawio(model) -> XML 字符串
     ├─ _assign_default_positions(model)   默认布局（无旧布局时）
     ├─ 按目录/文件建 swimlane 容器，计算嵌套
     ├─ 每个信号/函数 -> <object> + <mxCell> + <mxGeometry>
     ├─ 每条边 -> 锚点选择 _endpoints/_candidates -> 障碍规避 _route -> <Array as="points">
     └─ 边挂到「最内层公共容器」上
 └─ [可选] to_svg(model) -> 只读预览，与 .drawio 同坐标
```

### 标注语法（解析器的输入契约）

```c
/// @drawcode dir=in unit="LSB" alias="原始采样值" note="上电后需校准"
int16_t g_raw;

/// @drawcode alias="ADC 采样" tooltip="上电后需先校准"
/// @device vendor="TI" model="ADS1115" spec="16bit/860SPS" size="2.0x3.0mm"
int16_t adc_read(void);
```

```csharp
[Drawcode(Direction.In, Unit = "LSB")]
public static short g_raw;
```

C 侧方向写在 `dir=` 键里，C# 侧是 `[Drawcode]` 的第一个位置参数。两侧都零运行时：C 侧不需要任何头文件，C# 侧把 `DrawcodeAttributes.cs` 拷进工程即可。

## 五、反向流程：`.drawio` → 源码

```
read_layout(xml) -> {nodes, edges, attrs}
 ├─ _unpack(xml)           ← 展开 draw.io 的压缩存储形态
 ├─ _load_cells(xml)       ← <object> 与 <mxCell> 都收集
 ├─ _origin(cells, parent) ← 逐级累加父容器偏移，还原成画布绝对坐标
 └─ 产出：symbolId -> (x,y,w,h) / 边 key -> [(x,y)] / symbolId -> 可回写属性

apply_layout(model, layout)   ← 把布局与 attrs 灌回 IR
sync_source(path, model, rel) ← 逐文件回写
 ├─ .cs -> sync_cs_source()
 └─ 其他 -> sync_header() + sync_functions()
```

回写规则：只动声明层。定位方式是「往上扫连续的 `///` 行找到注释块 + 匹配 `SIGNAL_*` 宏行或字段声明行」，替换这个 span，其余代码原样保留（`sync_leaves_other_code_untouched` 断言了这点）。

| 人在 draw.io 里做的 | 回写结果 |
| :--- | :--- |
| 拖动/缩放节点 | 下一次 `sync --write` 把 `xy`/`size` 写回声明层；`build` 之后沿用该坐标 |
| 拉折线、改连接点 | 存进 `<Array as="points">`，**代码不动** |
| 改 `alias`/`unit`/`note`/`tooltip` | 原地更新源码注释块 |
| 改 `dir` | 把 `dir=in` 改写成 `dir=out`/`dir=io`（C），或改 `Direction.X`（C#） |
| 新增变量节点 | 追加带 `@drawcode` 的变量声明（C）/ 字段 + `[Drawcode]`（C#） |
| 改函数体逻辑 | **永不回写**（设计约束） |

## 六、踩坑清单（本实现真实踩到的）

### 1. 压缩态 `.drawio` 会静默返回空布局 ★最坑

draw.io **保存时默认压缩** `<diagram>` 的内容：

```
base64( raw-deflate( urllib-quote( xml ) ) )
```

其中 `~()*!.'` 是仅有的不做百分号编码的字符。未处理时 `read_layout` 找不到 `<mxGraphModel>` 子元素 → 遍历不到任何 cell → **返回空 dict，不抛异常**。后果：用户在 draw.io 里拖了半小时排版，回来 `build --layout-from` 把人工排版**全部无声丢弃**，退回自动布局。

**做法**：`_unpack()` 检测 `<diagram>` 有无 `<mxGraphModel>` 子元素，没有就尝试解压；**解压失败抛 `ValueError`，绝不静默返回空**。测试 `test_unreadable_diagram_raises_instead_of_empty` 锁住这个行为。

```python
def _decompress(data):
    return urllib.parse.unquote(zlib.decompress(base64.b64decode(data), -15).decode("utf-8"))
```

注意是 **raw deflate（`-15`）**，不是 zlib 包装格式。C# 对应 `DeflateStream`（不是 `ZLibStream`）。

### 2. 障碍检测必须包含起点/终点自己 ★

路由器最初把 `src`/`dst` 从障碍列表里排除（"自己的框不算障碍"），结果出现**线贴着起点框的边框爬 36px** 这种遮挡。正确做法是把 src/dst 也放进障碍列表，靠 `_crosses` 里的端点收缩（`SHRINK = 3`）让正常的边界接触不被误判。

### 3. 自动生成的拐点会被误认成人工编辑 ★

`--layout-from` 复用旧图时，上一轮**自动生成**的 `<Array as="points">` 会被当成「人工拖的折线」锁死，锚点还会丢。做法：自动拐点也写进 XML，但回读时能识别并丢弃重算；**人工拖的点仍然保留**。

### 4. `mxGeometry` 坐标是相对父容器的

`.drawio` 里 `mxGeometry` 与 `<mxPoint>` 的坐标都**相对父容器**。不统一处理就会在每次往返里累积漂移。约定：`read_layout` 统一还原成画布绝对坐标，`to_drawio` 统一换算回相对坐标（`_origin` 是唯一的换算点）。

### 5. 浮点格式化

金标准里整数写成 `420` 而非 `420.0`。跨语言移植时注意：Python `str(420.0)` → `"420.0"`，需要显式去掉多余小数位。比较时按数值比（见 conformance 归一化规则 3），但**生成的 XML 是给人看的**，尽量与金标准一致。

### 6. 正则的 `\w` 是 Unicode 语义

Python 3 的 `re` 默认 `\w` 匹配 Unicode 单词字符。移植到 JS（不带 `u` 标志时 `\w` 只匹配 ASCII）或 .NET（`\w` 也是 Unicode）时行为会分叉，影响标识符匹配。

### 7. 测试别依赖同级目录的其他仓库

原始实现的 XSD 校验测试去同级目录的 `drawio-mcp/` 仓库取 `mxfile.xsd`，克隆本项目的人没有那个目录 → **3 条测试静默 skip**（不是失败，是跳过，最容易被忽略）。现在 XSD 已 vendor 到 [`../tools/xsd/mxfile.xsd`](../tools/xsd/mxfile.xsd)，这 3 条真正执行。

**通则**：conformance 相关资源缺失时必须**报错**，不许 skip——跳过的测试让未验证的实现看起来像已验证。

## 七、跑测试

```bash
cd python
python -m unittest discover -s tests -t .          # 144 tests，0 skipped
```

测试规模：144 条，覆盖 C/C# 解析、drawio 往返、代码回写、adopt、CLI、SVG 与 XSD；
其中 `test_ts_parity.py` 的 20 条专门钉住「三实现行为一致」这件事本身（几何读取、
`[Callout]`、标签去叠印、sync 几何回写、四个渲染开关）。

## 八、给这门工具加一门新源语言

以「加 Rust 解析器」为例：

1. 在 `drawcode/` 下加 `rsparse.py`，实现 `parse_rs_project(paths, root) -> Model`。
2. **复用同一套 IR**（`model.py`），不要为 Rust 新建数据结构——三版一致性全靠 IR 统一。
3. 决定该语言的「方向怎么表达」：C 用注释里的 `dir=` 键，C# 用特性的位置参数。Rust 可以选属性宏 `#[drawcode(dir = "in")]`。
4. 在 `parse.py` 的 `parse_any` 里按扩展名加分支。
5. 在 `codegen.py` 里加对应的回写函数（声明层），并在 `sync_source` 里分派。
6. 加 `examples/small/rs/` 样例 + 测试；如果是新语法形态，在 `../tests/golden/` 加金标准。
7. 更新 `../docs/conformance.md` 的能力清单。

**别做的事**：不要在 `drawio.py` 里加语言分支。图画的是 IR，与源语言无关——这一层被污染，三个语言版本就没法共享同一套布局与路由规格了。

## 九、相关

- [`../../docs/conformance.md`](../docs/conformance.md) — 三语言一致性判定口径
- [`../docs/architecture.md`](../docs/architecture.md) — 架构与设计理由
- [`../docs/annotations.md`](../docs/annotations.md) — 标注语法字段级参考
