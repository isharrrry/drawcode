# drawcode — TypeScript

`drawcode` 的 TypeScript 实现，与 [`python/src/drawcode`](../python/src/drawcode) **功能等价**。

核心主张：**源码是语义的唯一事实源，图只是派生产物。** 语义（信号、结构体、函数、
调用、方向、注解、器件参数）全部写在 C/C# 里；`.drawio` 由代码重建，同时也是
人工排版的载体。落盘的"中间数据"是 0 套。

三版（Python / TypeScript / .NET）必须产出**同一份几何**，判定口径见
[`../docs/conformance.md`](../docs/conformance.md)。

---

## 依赖：零运行时依赖，零 devDependency

```json
"dependencies": {},
"devDependencies": {}
```

**这个决定是刻意的，请勿轻易改动。**

| 候选依赖 | 为什么不用 |
| :--- | :--- |
| `@xmldom/xmldom` | drawio 文档结构简单（无命名空间、无 DTD、无混合内容）。`src/xml.ts` 手写 200 行就够，而且能精确对齐 `xml.etree.ElementTree` 的空元素拼写、属性转义、`text`/`tail` 归属 —— 引库反而要去适配它的怪癖 |
| `typescript`（作为 devDependency） | Node ≥ 22.6 **原生擦除类型**直接运行 `.ts`，`npm test` 不需要编译。`tsconfig.json` 仍然提供，供 IDE 与可选的 `npm run typecheck` 使用 |
| 任何 XSD 库 | `src/xsd.ts` 是覆盖 `mxfile.xsd` 所用构造的子集校验器，已与 lxml 交叉验证（见下） |
| 测试框架 | `node --test` 内置 |

**对基准可比性的影响**：这是**正向**影响。三版做同样的工作、加载同样的依赖，
TS 版不会被 V8 之外的第三方解析器开销干扰；反过来说，如果 TS 版用了
`@xmldom` 而 Python 版用标准库，基准比的就不再是算法本身。

> 唯一需要网络的场景：想跑 `npm run typecheck` 时要自行准备 `typescript` 与
> `@types/node`。**测试不依赖它们。**

---

## 快速开始

```bash
cd typescript

npm test                     # 105 个测试，0 依赖，0 skip

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
drawcode build <files...> [--root DIR] [--out FILE] [--layout-from FILE] [--svg FILE]
drawcode sync <FILE.drawio> <files...> [--root DIR] [--write]
```

| 命令 | 行为 |
| :--- | :--- |
| `build` | 源码 → `.drawio`；`--svg` 同时出一份同坐标的只读预览 |
| `build --layout-from X.drawio` | 复用已有图里的人工排版，再按当前代码重建（幂等） |
| `sync` | `.drawio` → 源码，**只回写声明层**；不带 `--write` 是 dry-run |

`sync` 永不改写函数体逻辑 —— 这是设计约束，不是未实现。

---

## 测试

```bash
npm test                      # 全部 105 个
npm run test:conformance      # 只跑 L1–L4 金标准（16 个）
npm run test:unit             # 其余单元测试
```

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
├── test/                         105 个测试
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
| 3 | **`\w` 只匹配 ASCII**（JS 语义），Python 是 Unicode 感知 | 本项目的标识符全是 ASCII，无影响。**若将来支持 Unicode 标识符会分叉** —— 届时两边都要显式写 `[\p{L}\p{N}_]` |
| 4 | **`String.replace` 只替换第一处** | 仅影响测试代码写法（用 `replaceAll`）；生产代码没有依赖"全替换"的地方 |
| 5 | **CLI 参数解析**用 `node:util.parseArgs` | 覆盖 `build` / `sync` 的全部选项；差异在帮助文本措辞。退出码约定一致（成功 0、用法错误 2） |
| 6 | **`str.splitlines()` / 排序 / `repr`** 均为手写等价物 | 已在 `fsutil.ts` / `order.ts` / `num.ts` 中逐条对齐并测试 |

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
