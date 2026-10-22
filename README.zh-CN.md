# drawcode

[English](README.md) | **中文** | [Español](README.es.md)

> 让编译产物讲清系统骨架：模块怎么交联、信号怎么流转、哪些数据要持久化。
> 在 VS Code 里浏览程序集，或把源码画成可编辑的 [draw.io](https://www.drawio.com/) 图。

可在 Windows、Linux 与 macOS 上运行。CLI 没有第三方运行时依赖：需要 Node 22.6+。
只有在 `inspect` 读取 PE/CLI `.dll` 时才需要 .NET 10 运行时，由随附的 sidecar 承担。

![drawcode output](docs/assets/small-c.png)

## 它是什么

drawcode 让**程序集代码本身成为系统的孪生概要建模代码**：不另起一份建模工程，只在代码里补一层声明。

| 能力 | 做什么 | 入口 |
| :--- | :--- | :--- |
| **程序集浏览**（主线） | 打开 `.dll` / `.so` / `.out` / `.a` / `.o`，读概览、模块交联、信号数据与持久化定义；多个产物可组织成程序集树，支持分组与别名 | VS Code 插件 |
| **元数据模板** | 复制一个头文件或特性文件，把交联方向、信号语义、持久化标记写进声明层 —— 产物才「可解读」 | [`docs/templates.md`](docs/templates.md) |
| **源码出图** | 源码文件或整个目录 → `.drawio`；资源管理器右键就地生成，适合只看某个局部模块的交联 | 插件右键 / `build` |
| **产物 JSON** | 从产物读回结构，输出规范 JSON 供二次加工或接入自己的工具 | `inspect` |

完整实现总是跑得比设计文档快，思路又总比代码落笔得早。这三者之间缺的从来不是又一份文档，
而是一份**跟着代码一起编译、一起演进**的概要：它精确到能编译，又结构化到能读出架构。

drawcode 把这份概要放回代码本身。一段声明层元数据，就足以让程序集同时是「可运行实现」和
「系统概览」—— 而因为它就是代码，它不会漂移。

## 浏览编译产物

`drawcode inspect` 同时驱动一个只读的 VS Code 视图：打开 `.dll`、`.so`、`.out`、`.a` 或 `.o`，
自定义编辑器会显示产物里编译进去的内容：

- **概览** —— 格式、架构、实体计数与读取诊断。
- **模块交联** —— 模块、类型、信号与函数的虚拟化树；勾选信号后，左侧连线栏从写入行连到读取行。
- **持久化数据** —— 标了 `Store` 的类型以 ER 表展示，含字段类型与嵌套结构链接。
- **程序集树** —— 把多个产物组织成树，支持分组、别名，与从工作空间批量添加。

![模块交联：勾选端口后，连线从写入行连到读取行](docs/assets/artifact-viewer.png)

*模块交联：勾选端口后连线从写入行连到读取行；结构体信号在右侧 groupbox 展开字段。*

| 持久化数据（`Store` 类型以 ER 表展示） | C 产物按标签分组 |
| :---: | :---: |
| ![持久化数据视图](docs/assets/artifact-viewer-store.png) | ![C 产物按标签分组](docs/assets/artifact-viewer-c.png) |

插件与 CLI 复用同一份解析核心（`readArtifact`），不启动外部进程，也从不加载或执行被读的产物。
前提与设置见 [`docs/vscode-extension.md`](docs/vscode-extension.md)。

## 元数据模板：让产物可解读

产物能被读出多少，取决于你往声明层写了多少。两套模板各给一份最小附加物：

- **C#** 复制 [`templates/csharp/DrawcodeAttributes.cs`](templates/csharp/DrawcodeAttributes.cs)，
  在字段、属性、方法或类型上加特性。
- **C** 复制 [`templates/c/DrawcodeMeta.h`](templates/c/DrawcodeMeta.h) 与 `.c`，用宏写声明层，
  定长记录进自定义段。

两套模板语义一致，都**只描述声明层**（谁读写谁、哪个类型是持久化数据、哪个模块是分解根），
不记录运行时行为 —— 所以 `-O0` 与 `-O2` 读出来是同一份数据。

`size` 与 `offset` 由编译器算出（C 侧用 `sizeof` / `offsetof`）。两者的差别在强类型程度：
C# 是特性类，属性名或类型写错**编译期就报错**；C 是字符串标签，写错的键会被当作未知标签忽略。

参数表、`--gc-sections` 与 `PublishTrimmed` 等构建约束见 [`docs/templates.md`](docs/templates.md)。

## 源码出图

不想先编译也能出图：**资源管理器右键**单个源文件或整个目录，选「生成 Drawio 图」，
就地生成 `.drawio`（单文件 `Foo.cs` → `Foo.cs.drawio`；目录 `demo/` → `demo/demo.drawio`，
递归合并目录内所有支持的源码）。适合只想看**某几个模块之间的交联**，而不是整个工程。

已支持的源码扩展名：C 侧 `.c .h .cpp .hpp .cc .hh`，C# 侧 `.cs`。

## 为什么源码是唯一事实源

下面这几条讲的是「源码 → 图」这条线的立场；程序集浏览那条线同样以代码为唯一事实源。

大多数「代码转图」工具生成一张图就到此为止。一旦有人改动代码，图立刻就过期了，
因为**这张图悄悄变成了第二份事实源** —— 而两份事实源总会漂移。通常的补救更糟：导出一份中间 JSON，
再发明哈希、漂移检测与三方合并去调和它们。

`drawcode` 采取的是相反的立场。

- **源码是唯一事实源。** 语义写在代码里，用宏、特性和结构化注释表达。
  任何中间 JSON 都不会落盘 —— IR 只存在于内存中，每次运行都从代码重建。
- **图上只承载代码无法表达的东西**：布局，而布局是人的决定。在 draw.io 里拖动一个节点，
  新位置会在下一次运行时回写进 IR。
- **反向是刻意收窄的。** 只有*声明层*会被回写 —— `SIGNAL_*` 宏语句与注解属性。
  **函数体逻辑永不改写**，这是设计使然。
- **幂等。** 构建 → 编辑 → sync → 构建，产生零代码变更。这一点由测试断言，而不是假定。
- **金标准钉住契约。** IR 与几何都与已提交的金标准用例逐字节比对，
  所以解析器或路由的一处改动会显示成一条可审阅的 diff，而不是悄悄漂移。

## 快速开始

按你手上有什么选一条路，三条互不依赖。

| 你手上有什么 | 想做什么 | 走哪条 |
| :--- | :--- | :--- |
| C / C# **源码** | 看模块之间的交联图 | 路径 A |
| 已编译的**程序集** | 浏览模块、信号、持久化数据 | 路径 B |
| 已编译的**程序集** | 拿结构化的 JSON 数据 | 路径 C |
| 一个还没加注解的工程 | 让它的产物变得可读 | 先做[元数据模板](docs/templates.md)，再走路径 B |

### 路径 A：源码 → drawio 图

**最快：插件右键。** 装好路径 B 的扩展后，在资源管理器里右键一个源文件或目录，
选「生成 Drawio 图」，就地生成 `.drawio`。

**或者用 CLI**（需要 Node 22.6+，无第三方依赖）：

```bash
git clone <this-repo> && cd drawcode

# 解析 examples/small/c 下四个文件，输出图与预览
node typescript/bin/drawcode.ts build \
    examples/small/c/adc.h examples/small/c/adc.c \
    examples/small/c/dsp.h examples/small/c/dsp.c \
    --root examples/small/c \
    --out out/flow.drawio --svg out/flow.svg
```

生成后用 draw.io 打开 `out/flow.drawio` 就能编辑。

**布局往返**（可选）：在 draw.io 里拖好位置保存，再用 `--layout-from` 复用这份排版，
或把注解回写进源码：

```bash
node typescript/bin/drawcode.ts build ... --layout-from out/flow.drawio --out out/flow.drawio
node typescript/bin/drawcode.ts sync out/flow.drawio examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c                    # 空跑：只报告会改什么
node typescript/bin/drawcode.ts sync out/flow.drawio examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --write            # 真正写入
```

### 路径 B：在 VS Code 里浏览程序集

扩展目前**从仓库打包安装**，尚未发布到扩展市场。

```bash
cd editors/vscode
npm install
npm run package     # 产出 out/drawcode-artifact-viewer-0.2.0.vsix
```

然后在 VS Code 里执行「扩展: 从 VSIX 安装…」，选中那个文件。装好后双击任一
`.dll` / `.so` / `.out` / `.a` / `.o`，或执行命令 `Drawcode: 打开程序集`。

想改代码调试：`npm install && npm run build`，然后按 `F5` 启动 Extension Development Host。

前提：VS Code >= 1.90；`.dll` 需要 .NET 10 运行时（sidecar 随 VSIX 打包），ELF 与 `ar` 不需要。
详细说明见 [`docs/vscode-extension.md`](docs/vscode-extension.md)。

### 路径 C：读程序集的结构化数据

要拿 JSON 而不是看图，用 `inspect`（产物不会被加载或执行）：

```bash
node typescript/bin/drawcode.ts inspect path/to/Your.dll --out model.json
```

字段含义见 [`docs/artifact-format.md`](docs/artifact-format.md)。

构建命令、仓库地图与测试命令见
[`docs/implementations.md`](docs/implementations.md)。

## 命令行用法

```
drawcode build <files...> [--root DIR] [--out FILE] [--merge] [--layout-from FILE] [--svg FILE]
                [--inline] [--cards] [--no-rw-labels] [--straight-edges]
drawcode sync  <drawio> <files...> [--root DIR] [--write]
drawcode inspect <artifact> [--out FILE] [--infer-edges]
```

| 命令 | 作用 |
| :--- | :--- |
| `build` | 解析源码 → 构建 IR → 写出 `.drawio`。`--layout-from` 复用既有图的人工布局。`--svg` 额外产出一份只读预览，与 `.drawio` 共享同一套坐标。 |
| `sync` | 读取 `.drawio` → 应用布局与注解属性 → 把**声明层**回写到源码。不加 `--write` 时是空跑。 |
| `inspect` | 只读解析编译产物（`.dll` / `.so` / `.out` / `.a` / `.o`），输出规范 JSON。不加载、不执行目标程序；PE `.dll` 由随附的 .NET sidecar 读取，ELF 与 `ar` 归档在进程内解析。 |

`--inline` 把「一写一读」的信号折叠成设备直连边，`--cards` 把带 `asset` 的函数画成图片卡片，
`--no-rw-labels` 去掉边上的 `read`/`write`，`--straight-edges` 用直线替代正交布线。
不带开关时产物与默认行为逐字节相同。

## 核心概念

1. **一份持久事实源，一个派生产物。** 代码是事实；`.drawio` 是视图，外加只有人能提供的布局。
   细节：[`docs/architecture.md`](docs/architecture.md)。
2. **注解是解析器唯一推断不出来的东西。** 方向与元数据是*写进代码*的：
   C 侧写成 `/// @drawcode` 注释、C# 侧写成 `[Drawcode(Direction.In)]` 特性。
   字段级参考：
   [`docs/annotations.md`](docs/annotations.md)。
3. **边是派生的，不是解析出来的。** `read`/`write` 边来自扫描函数*体*里碰了哪些全局量。
   改一条注释只会改一个标签；它永远不会移动一条线。这常常令人意外，而且这是刻意的。
4. **坐标是相对父容器的。** 在 `.drawio` 里，
   `mxGeometry` 与 `mxPoint` 都相对于其容器。
   `read_layout` 换算成画布绝对坐标，
   `to_drawio` 换算回去 —— 这个唯一换算点防止漂移在多次往返中累积。
5. **draw.io 默认压缩。** 保存时它把 `<diagram>` 内容存成 
   `base64(raw-deflate(url-quote(xml)))`。
   只读纯 XML 意味着**静默返回空布局**，并丢弃用户手工排好的版。这里两种形态都读，
   读不出来的载荷会抛错而不是返回空。格式细节：
   [`docs/drawio-format.md`](docs/drawio-format.md)。

## 与 SysML v2 的取舍

drawcode 不做 SysML v2 能做的事。下表是取舍，不是能力对比 —— 两者解决的问题不在同一层。

| 维度 | drawcode | SysML v2 |
| :--- | :--- | :--- |
| 目标用户与门槛 | 熟悉 C / C# 的团队；十来个注解键，不引入新语言 | 跨专业系统工程团队；需掌握 SysML v2 / KerML 语义体系 |
| 存量代码 | 直接对已有产物只读解析，无需改造 | 需重建模型 |
| 对既有构建 | 复制一个模板文件，零侵入 | 需接入建模工具与构建流程 |
| 能否从已有二进制反读 | **能**（`.dll` / `.so` / `.out` / `.a` / `.o`） | 不能 |
| 事实源与漂移 | 源码或产物是唯一事实源，没有第二份要维护的数据 | 模型是主产物；模型与代码需双维护 |
| 编译可校验 | `size` / `offset` 由编译器算出（C 用 `sizeof` / `offsetof`）；C# 是强类型特性，属性名或类型写错编译期即报错；C 是字符串标签，写错的键会被当作未知标签忽略 | 模型级语义校验，但与实现代码是否一致无关 |
| 行为与时序 | 有交互流（模块交联、信号读写路径）；状态机与时序图**尚未支持** | 有（状态机、交互、时序） |
| 图与导出 | 输出标准 `.drawio`；PNG / SVG 导出与「PNG 拖回 draw.io 再编辑」由 draw.io 官方工具承担，本仓不重复实现 | 布局与导出由建模工具管理 |
| 版本控制 | 源码与 `.drawio` 都是文本，普通 git diff 即可 | 文本记法同样便于 git，但需独立模型仓 |
| 标准化与生态 | MIT，开源在本仓；自有约定，无第三方工具互操作 | OMG 标准（2.0 版 2025-09 通过，Document Status: formal），Boeing、Airbus、Lockheed Martin、Siemens、Dassault Systèmes、Ansys、MathWorks、IBM、PTC、Sparx Systems 等厂商参与制定 |
| Agent 辅助 | 注解即结构、输出确定性文本（金标准逐字节比对）、`SKILL.md` 写给下一个代码语言适配者 | 文本记法同样可被 agent 读写，但需先掌握一整套语义体系 |

**为什么选它**

思路落在设计文档里，设计落进完整实现里，三者之间总有落差：文档跟不上代码，代码又读不出设计。
通常的补救是再写一份建模文档，可它从写下那一刻就开始过期。

drawcode 主张**让程序集代码本身承担这份概要**。一段声明层元数据写进源码，随编译一起进入产物，
于是同一个程序集既是可运行的完整实现，又是一份**结构化的系统孪生概要**：模块怎么交联、信号怎么
流转、哪些数据要持久化、哪些模块是分解根。它精确到能编译，又结构化到能读出架构。

这就是它的位置 —— 在思路、设计、完整实现之间做那座桥，而且因为桥就架在代码上，它不会单独漂移。

**什么时候选哪个**

- 你希望程序集代码同时是**系统的孪生概要建模代码**，让实现本身能讲出结构，并把思路、设计与完整实现连起来 → drawcode。
- 组织层面要做需求追溯、验证案例、参数化分析、多专业协同，模型需要先于代码独立存在 → SysML v2。

两者不互斥：drawcode 可以作为 SysML 模型在实现侧的只读视图 —— 模型说「应该是什么」，
从产物读出来的说「实际是什么」，两者的差就是需要核对的清单。

## 文档

| 想了解 | 读 |
| :--- | :--- |
| 为什么设计是这个形状 | [`docs/architecture.md`](docs/architecture.md) |
| 每一个注解键，含类型与默认值 | [`docs/annotations.md`](docs/annotations.md) |
| `.drawio` 映射、路由规则、坐标系语义 | [`docs/drawio-format.md`](docs/drawio-format.md) |
| 金标准钉住了什么、为什么冻结 | [`docs/conformance.md`](docs/conformance.md) |
| 测试与验证数字、性能特征 | [`docs/verification.md`](docs/verification.md) |
| 在 VS Code 里浏览编译产物 | [`docs/vscode-extension.md`](docs/vscode-extension.md) |
| 让自己的 C / C# 构建产物可读 | [`docs/templates.md`](docs/templates.md) |
| 跑一下仓库自带的示例工程 | [`docs/examples.md`](docs/examples.md) |
| 构建、测试、加一门语言 | [`docs/contributing.md`](docs/contributing.md) |
| 为下一门代码语言写适配层 | [`typescript/SKILL.md`](typescript/SKILL.md) |

## 开发

```bash
cd typescript && node --test                       # CLI、解析器、IR、布局、一致性
cd editors/vscode && node --test test/*.test.mjs   # 扩展测试（不依赖扩展宿主）
```

`tools/drawcode-metadata/` 下的 PE sidecar 是纯 .NET 10，只在 `inspect` 读 `.dll` 时才构建/运行；
工具链其余部分只需要 Node 22.6+。

当前测试与验证数字（测试条数、幂等、schema、金标准复现、性能特征）见
[`docs/verification.md`](docs/verification.md)。

## 已知限制（诚实列出）

- **布局是 O(n²)**，所以大工程慢。目前没有使用任何空间索引。
- **离线渲染器画不出 `jumpStyle=arc` 跳线。** `jumpStyle` 是 
  draw.io 的扩展，开源 mxGraph 核心没有。生成的文件把它配置正确，
  draw.io 客户端也会照做，但 `tools/render/` 不会显示跳线。
  请在 draw.io 里验证跳线。
- **swimlane 容器标题在离线渲染器里渲染在中央**，而在 draw.io 里出现在左上角。
  这是渲染器的限制，不是生成器的 bug。
- **离线渲染器的中日韩文字测量是估算的。** jsdom 没有排版引擎，
  报告的 `offsetWidth = 0`，所以字宽是近似值。文字本身渲染正确（SVG 定位不依赖该测量）；
  标签的*避让*可能不准。
- **SVG 预览不共享 `.drawio` 的边路由。** 节点位置是共享的（两者都调用同一套默认布局），
  但 `svg.ts` 是中心连中心画边，而 `to_drawio` 会跑完整的锚点选择与避障。
  因此 SVG 的边会穿过 `.drawio` 绕开的节点形状。把 SVG 当作结构性速读，而不是忠实预览。
  修好它需要把 `to_drawio` 重构出共享的边几何函数。
- **函数体永不回写。** 这是设计约束，不是缺口。
- **混合语言的单张图不做符号解析。** C 与 C# 的模型可以合并，但跨语言引用同名符号不会被解析。
- **多页 / 多视图、图层与标签过滤没有接到 CLI。**
- **状态机与时序图尚未支持。** 当前只有模块交联与信号读写路径这一种交互流。
- **几何被冻结在金标准上。** 更快的布局算法可以接受，但只能改*算得多快*，
  不能改*算出什么* —— 否则每个金标准用例都会 diff，手工布局也不再对得上。

## 许可

[MIT](LICENSE)。
随仓库附带的第三方材料列在 
[`tools/xsd/NOTICE.md`](tools/xsd/NOTICE.md)。
