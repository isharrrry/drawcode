# drawcode — TypeScript

`drawcode` 的 TypeScript 实现，与 [`python/src/drawcode`](../python/src/drawcode) **功能等价**。

核心主张：**源码是语义的唯一事实源，图只是派生产物。** 语义（信号、结构体、函数、
调用、方向、注解、器件参数）全部写在 C/C# 里；`.drawio` 由代码重建，同时也是
人工排版的载体。落盘的"中间数据"是 0 套。

三版（Python / TypeScript / .NET）必须产出**同一份几何**，判定口径见
[`../docs/conformance.md`](../docs/conformance.md)。

---

## 依赖：零运行时依赖；devDependency 只服务类型检查与 IDE

```json
"dependencies": {},
"devDependencies": {
  "@types/node": "^22",
  "typescript": "^5.9.3"
}
```

**运行时零依赖这个决定是刻意的，请勿轻易改动。** `devDependencies` 里的两项只在
`npm install` 后供 `npm run typecheck` 与编辑器补全使用；**`npm test` 不加载它们**
（Node ≥ 22.6 原生擦除类型，测试直接跑 `.ts`），所以离线克隆后不装依赖也能跑测试。

| 候选依赖 | 为什么不用 |
| :--- | :--- |
| `@xmldom/xmldom` | drawio 文档结构简单（无命名空间、无 DTD、无混合内容）。`src/xml.ts` 手写 200 行就够，而且能精确对齐 `xml.etree.ElementTree` 的空元素拼写、属性转义、`text`/`tail` 归属 —— 引库反而要去适配它的怪癖 |
| `typescript`（运行时） | Node ≥ 22.6 **原生擦除类型**直接运行 `.ts`，`npm test` 不需要编译。`tsconfig.json` 仍然提供，供 IDE 与可选的 `npm run typecheck` 使用 |
| 任何 XSD 库 | `src/xsd.ts` 是覆盖 `mxfile.xsd` 所用构造的子集校验器，已与 lxml 交叉验证（见下） |
| 测试框架 | `node --test` 内置 |

**对基准可比性的影响**：这是**正向**影响。三版做同样的工作、加载同样的依赖，
TS 版不会被 V8 之外的第三方解析器开销干扰；反过来说，如果 TS 版用了
`@xmldom` 而 Python 版用标准库，基准比的就不再是算法本身。

> 唯一需要网络的场景：想跑 `npm run typecheck` 时先 `npm install` 拉取
> `typescript` 与 `@types/node`。**测试不依赖它们。**

---

## 快速开始

```bash
cd typescript

npm test                     # 175 个测试，0 依赖，0 skip（报表显示 176，多出的 1 项是 test/helpers.ts 文件条目）

node bin/drawcode.ts build ../../tests/golden/small-c/input/adc.h \
                          ../../tests/golden/small-c/input/adc.c \
                          ../../tests/golden/small-c/input/dsp.h \
                          ../../tests/golden/small-c/input/dsp.c \
                          --root ../../tests/golden/small-c/input \
                          --out flow.drawio --svg flow.svg
```

要求 **Node ≥ 22.6**（原生 TypeScript 类型擦除）。本次开发与验证用的是 Node 24.16.0。

---

## CLI

```
drawcode build <files...> [--root DIR] [--out FILE] [--merge] [--inline] [--cards]
                           [--no-rw-labels] [--straight-edges] [--layout-from FILE] [--svg FILE]
drawcode sync <FILE.drawio> <files...> [--root DIR] [--write]
```

| 命令 | 行为 |
| :--- | :--- |
| `build` | 源码 → `.drawio`；`--svg` 同时出一份同坐标的只读预览 |
| `build --layout-from X.drawio` | 复用已有图里的人工排版，再按当前代码重建（幂等） |
| `build --merge` | 多个模块合成**一张**图（默认每个模块各出一张） |
| `build --inline` | 折叠「一写一读」的信号：两端设备直连，中间的信号节点不画 |
| `build --cards` | 带 `Asset` 的函数渲染成图片卡片（设备总览图用） |
| `build --no-rw-labels` | 边上的 `read` / `write` 字去掉，只留线 |
| `build --straight-edges` | 每条边画成**直线**，不跑避障正交布线（见下） |
| `sync` | `.drawio` → 源码，**只回写声明层**；不带 `--write` 是 dry-run |

`sync` 永不改写函数体逻辑 —— 这是设计约束，不是未实现。

`--inline` 与 `--layout-from` 同时用时，先折叠再套排版（折叠改的是图的内容，
少掉的节点必须由重新布局补位，不是在原位留个洞）。`--cards` 只对 C# 前端的
`[Device(Asset = "…")]` / `[Drawcode(Asset = "…")]` 有效，C 侧没有对应键。

### `--straight-edges`：为什么不能直接改默认值

默认仍是正交布线（`EDGE_STYLE` 里的 `edgeStyle=orthogonalEdgeStyle;rounded=1;jumpStyle=arc;…`），
开关打开才换成 `edgeStyle=none;html=1;`。**不能直接改默认值**，两个理由：

1. 金样 `tests/golden/*/expected.drawio` 里写死了 `orthogonalEdgeStyle` 与 `<Array as="points">`，
   改默认它们立刻全红；
2. 那两份金样是 TS / Python / .NET **共享的契约** —— 只动 TS 的默认值，等于单方面撕毁它。

换样式时四件事必须一起做，漏一件线还是弯的：清掉 `edgeStyle=orthogonalEdgeStyle`
（不清，draw.io 会**自己**再算一遍正交走线）、去掉 `rounded=1`（没有拐角，圆角无从谈起）、
去掉 `jumpStyle=arc` / `jumpSize=6`（跨线跳弧只在布线器算拐点时才产生）、
**保留 `exitX/exitY/entryX/entryY` 锚点**（它决定线从节点哪条边出发，与走法无关；
丢了它 draw.io 会自己就近挑边，「左右相连」可能变成从上下出线）。

自动算出的拐点会被丢掉，但 `--layout-from` 里**人工画上的**拐点照样保留 ——
那是人明确放上去的东西，不该被一个样式开关悄悄吞掉。

**什么时候不该开**：正交路由在「横向分区带 + 节点成行排列」的布局下是**贴合**的；
换成直线，跨带的连线全部化成对角线，会形成一片斜线交叉网，还可能斜穿卡片图片和标签框。
设备级总览图（分区带 + 卡片）属于后一类，实测更难看。**要不要开取决于图的拓扑，不取决于偏好。**

---

## 测试

```bash
npm test                      # 全部 175 个（报表 176，含 helpers.ts 条目）
npm run test:conformance      # 只跑 L1–L4 金标准（18 个）
npm run test:unit             # 其余单元测试（157 个）
```

裸 `node --test` 按 `**/test/**/*.ts` 发现文件，会把不含测试的 `test/helpers.ts`
也算成一个顶层条目 —— 所以报表上的总数比真实测试数**多 1**。上面写的是真实数。

### 一致性结果（`../tests/golden/` 两个案例）

| 层次 | 内容 | `small-c` | `small-cs` |
| :--- | :--- | :--- | :--- |
| **L1** | 解析（IR）精确相等 | ✅ | ✅ |
| **L2** | 图结构（容器/嵌套/节点归属/边）精确相等 | ✅ | ✅ |
| **L3** | 几何（节点 x/y/w/h、折线、锚点）精确相等 | ✅ | ✅ |
| **L3+** | 生成的 `.drawio` 与金标准**逐字节相同** | ✅ | ✅ |
| **L4** | 过 `../tools/xsd/mxfile.xsd` 校验 | ✅ | ✅ |
| SVG | 预览与金标准结构一致（标签计数/文本/坐标 ±0.5px） | ✅ | ✅ |

L3+ 比 spec 要求更严：spec 只要求结构相等，逐字节相同说明连属性顺序、
浮点拼写、排序 tie-break 都对齐了。

**金标准缺失一律报错，绝不 skip。** `test/helpers.ts::mustRead` / `loadCase`
在文件不存在、JSON 不可解析、或案例未登记时都会 throw。

### L4 校验器的可信度

`src/xsd.ts` 是手写的 XSD 子集校验器。为了证明它**不是橡皮图章**：

- 测试里有一组**故意损坏**的文档（违反 `fixed`、未声明属性、枚举越界、
  `positiveInteger` 越界、`xs:double` 非法、多余子元素、缺必需属性），
  断言全部被拒。
- 同一组文档用 **Python + lxml**（权威 XSD 引擎）跑一遍：
  **9/9 判断一致，0 分歧**。变异用例保留在 `test/xsd.test.ts` 与
  `test/conformance.test.ts` 中。

### 跨实现的压缩态验证

draw.io 保存时默认把 `<mxGraphModel>` 压成 base64，只读明文 XML 的实现会在
用户保存后**静默返回空布局**，把人工排版丢掉（conformance.md 把这条列为"非可选"）。

`test/fixtures/*.compressed.drawio` 是 **Python 生成的**压缩串
（`npm run fixtures`），TS 侧读它并与明文结果逐项对比 —— 避免"自己 pack
又被自己 unpack"的自证循环。

---

## 目录

```
typescript/
├── package.json / tsconfig.json
├── README.md / SKILL.md          ← SKILL.md 是给下一个实现者的操作指南
├── bin/drawcode.ts               CLI 入口
├── src/
│   ├── model.ts                  IR 数据结构
│   ├── cparse.ts                 C → IR
│   ├── csparse.ts                C# → IR
│   ├── parse.ts                  按扩展名分派与合并
│   ├── drawio.ts                 IR ↔ .drawio（布局 + 路由 + 压缩态）
│   ├── codegen.ts                IR → 代码（仅声明层）
│   ├── svg.ts                    IR → SVG 预览
│   ├── cli.ts                    命令行
│   ├── dump.ts                   IR → 规范化 JSON（L1 口径）
│   ├── xml.ts                    最小 XML 解析/序列化（对齐 ElementTree）
│   ├── xsd.ts                    XSD 子集校验器（L4）
│   ├── regex.ts / order.ts / num.ts   Python re / sorted / repr 的语义桥
│   ├── fsutil.ts / html.ts       行切分、路径、HTML 转义
│   └── index.ts                  公共 API
├── test/                         175 个测试
│   └── fixtures/                 Python 生成的压缩 fixture
└── tools/make-fixtures.py        生成上面那些 fixture
```

---

## 与 Python 版的已知差异

**几何结果无差异**（两个金标准全部逐字节相同）。以下是实现层面的差异：

| # | 差异 | 影响 |
| :--- | :--- | :--- |
| 1 | **XSD 校验器是手写子集**，Python 版用 lxml | 本 XSD 覆盖的构造全部支持；不在本 XSD 里的 XSD 特性（命名空间、`xs:import`、`xs:extension`、identity constraints）不支持。**不改判定结果**：9 个变异与 lxml 判断一致 |
| 2 | **浮点打印**在指数区间依赖 `toExponential()` | 实际坐标只可能是整数或 `x.5`，两条路径一致；`num.test.ts` 单独覆盖了 `1e-5` / `1e21` 等边界 |
| 3 | **C# 的 Unicode 名字是 TS 独有**：`csparse.ts` 的类型与名字位置都显式写 `[\p{L}]`，并整段跳过 `record` 声明；Python `csparse.py` 与 .NET `CsParse.cs` 的 C# 前端仍只认 ASCII | ASCII 源码三版结果一致；用中文信号名/组件方法名的源码目前只有 TS 能正确出图，另两版会**静默丢节点**。要三版对齐，需把同样的 IDENT 与 record 跳过逻辑移植过去 |
| 4 | **`String.replace` 只替换第一处** | 仅影响测试代码写法（用 `replaceAll`）；生产代码没有依赖"全替换"的地方 |
| 5 | **CLI 参数解析**用 `node:util.parseArgs` | 覆盖 `build` / `sync` 的全部选项；差异在帮助文本措辞。退出码约定一致（成功 0、用法错误 2） |
| 6 | **`str.splitlines()` / 排序 / `repr`** 均为手写等价物 | 已在 `fsutil.ts` / `order.ts` / `num.ts` 中逐条对齐并测试 |
| 7 | **边标签去叠印是 TS 独有** | 两条边的标签会撞在一起时，TS 把文字挪进 `eN_label` 子单元格；另外两版把标签全留在边上，同样的输入会叠字。金标准里没有一对撞上的标签，所以这条不会被一致性测试照出来 |
| 8 | **C# 前端的 `Xy` / `Size` / `Style` 与 `[Callout]` 是 TS 独有** | 设备总览图需要钉死坐标与自由文本框。Python 的 `csparse.py` 与 .NET 的 `CsParse.cs` 都不认这些键，且都是**忽略未知属性**而非报错 —— 喂给它们只会得到一张少了说明框、且没有报错的图 |

第 7、8 条另见 `../docs/conformance.md` 的 Known divergence。第 8 条要改实现才算消除：
`META_KEY` / `AttrKey` 里补键、两边都加 `CalloutAttribute` 解析。

---

## 未完成项 / 集成注意

- **没有实现**：多页/多视图、Layer 分层、tags 过滤（与 Python 版一致，都没接到 CLI）。
  混合语言单图可以构造（`parseAny` 会合并），但同名跨语言引用未做符号解析。
- **`npm run typecheck` 需要外部提供 `typescript` 与 `@types/node`**，本仓库不带。
  这不是测试路径的一部分。
- **`typescript/tools/make-fixtures.py` 需要系统 python3 + lxml**（仅用于重新生成
  fixture；平时不需要跑，fixture 已提交）。
- **`ANCHOR_SETS` 顺序、`SHRINK`/`SLACK` 取值、`candidates()` 的候选先后**
  都是几何契约的一部分，改动会让 L3 与金标准分叉。详见 `SKILL.md` 第 7 节。
- **不要用 PowerShell 的 `Get-Content` / `Set-Content` 改本目录的 UTF-8 文件**
  （见 `SKILL.md` §5.15）：本机 pwsh 的这次往返把中文写成了无效 UTF-8。
  用 `write` / `edit` 类工具，或至少显式 `-Encoding utf8`。

---

## 许可

与仓库其余部分一致。
