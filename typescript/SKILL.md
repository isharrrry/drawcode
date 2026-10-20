# SKILL — 用 TypeScript 实现「源码 ↔ drawio」转换

面向**下一个要加一门语言解析器的人**，也面向任何要在 Node 里做同类图转换的人。

参考实现是 `python/src/drawcode/`。判定口径在 `../docs/conformance.md`（四个比较层次）。
本包与 Python 版**几何结果精确相等**：`../tests/golden/` 的两个金标准，生成的 `.drawio` 与
`preview.svg` 都是**逐字节相同**，不只是结构相等。

---

## 0. 三十秒版本

```bash
cd typescript
npm test                    # 175 个测试（报表 176，含 helpers.ts 条目），0 依赖，0 skip
node bin/drawcode.ts build src/*.c src/*.h --root src --out flow.drawio --svg flow.svg
```

**零运行时依赖。** devDependency 只有 `typescript` 与 `@types/node`，且仅服务 `typecheck` 与 IDE；
Node ≥ 22.6 原生擦除类型直接跑 `.ts`，测试不需要 tsc，
也不需要 `@xmldom/xmldom`（XML 解析器 200 行就够，而且让三版 benchmark 站在同一起跑线）。

---

## 1. 模块划分与职责

| 文件 | 职责 | 对应的 Python |
| :--- | :--- | :--- |
| `src/model.ts` | IR 数据结构（Signal / Param / Func / Edge / Device / Model） | `model.py` |
| `src/cparse.ts` | C → IR：`/// @drawcode dir=`、`/// @device`、普通变量声明即信号、struct、形参作端口、局部变量不入图 | `cparse.py` |
| `src/csparse.ts` | C# → IR：`[Drawcode(Direction.X, …)]`、`[Device(…)]` | `csparse.py` |
| `src/parse.ts` | 按扩展名分派、多语言结果合并 | `parse.py` |
| `src/drawio.ts` | **IR ↔ .drawio**：默认布局、容器、锚点选择、障碍规避路由、跨容器缝隙、泳道绕行、压缩态读写 | `drawio.py` |
| `src/codegen.ts` | IR → 代码（**仅声明层**，永不改函数体） | `codegen.py` |
| `src/svg.ts` | IR → SVG 预览（与 .drawio 同坐标） | `svg.py` |
| `src/cli.ts` + `bin/drawcode.ts` | 命令行 build / sync | `cli.py` |
| `src/dump.ts` | IR → 规范化 JSON（L1 金标准的口径） | `../tools/dump_ir.py` |

**Python 没有、TS 必须自己有的三个**：

| 文件 | 为什么 |
| :--- | :--- |
| `src/xml.ts` | Node 没有 `DOMParser`。手写最小 XML 解析/序列化，语义对齐 `xml.etree.ElementTree` 用到的子集 |
| `src/xsd.ts` | Node 没有 XML Schema。手写 XSD 子集校验器满足 L4（已用 lxml 交叉验证：9/9 判断一致） |
| `src/regex.ts` / `src/order.ts` / `src/num.ts` | Python `re` / `sorted` / `repr` 的语义桥；差异全在第 5 节 |

---

## 2. IR 的 TypeScript 类型（完整字段）

```ts
type Direction = "in" | "out" | "inout" | "";  // 空串合法：没写 dir 的信号照样成立，只是没方向

interface Signal {
  id: string;        // "<rel-path>::<name>"，例如 "adc.h::g_raw"
  name: string;
  ctype: string;     // "int16_t"、"float[32]"
  dir: Direction;
  file: string;      // 相对 root 的路径
  line: number;      // 1-based
  unit: string;      // 来自 /// @drawcode unit="..."
  alias: string;
  note: string;
  external: boolean; // @drawcode external="true"
  group: string;     // 文件名去扩展名 —— 容器的来源
  path: string;      // 容器层级 "adc/采样前端"；空串会归一化成模块名，所以下游拿到的恒非空
  style: string;     // 追加到节点样式串末尾的原始片段（[Drawcode(Style="…")]）；C 侧没有这个键
  // 以下是**布局维度**，不进 L1 金标准
  x: number; y: number;
  w: number;  // 默认 160
  h: number;  // 默认 60
}

interface Param { name: string; ctype: string; dir: Direction }  // dir 恒为 "in"

interface Func {
  id: string; name: string;
  ret: string;               // 默认 "void"
  params: Param[];           // 形参是端口，不是节点
  file: string; line: number;
  alias: string; note: string; tooltip: string; asset: string;
  style: string;             // 同 Signal.style
  external: boolean; group: string; path: string;
  reads: string[];   // signalId[]，来自**函数体扫描**
  writes: string[];  // signalId[]
  calls: string[];   // funcId[]
  x: number; y: number;
  w: number;  // 默认 180
  h: number;  // 默认 72
}

interface Edge {
  src: string; dst: string;
  rw: "read" | "write";
  waypoints: Array<[number, number]>;  // **绝对画布坐标**；空数组 = 交给路由器
}

interface Device { vendor: string; model: string; spec: string; size: string; asset: string }

/**
 * 自由文本块（`[Callout("…", Xy = "40,40", Size = "260x60", Style = "box")]`）。
 * **不挂在被建模的实体上**：它寄存在某个真实方法上，只是为了跟图待在同一个文件里 ——
 * 位置完全由 `Xy` 的绝对画布坐标决定，与宿主方法的位置无关。
 */
interface Callout {
  id: string;
  text: string;                    // 可含 <br>：draw.io 按 HTML 换行，离线渲染器把它转成换行
  owner: string;                   // 宿主实体 id，仅作溯源；空串 = 整张图的说明
  shape: "text" | "box" | "band";  // 无边框文字 / 带底色说明框 / 大片分区带
  fontSize: number;                // 0 = 用该种类的默认值
  x: number; y: number; w: number; h: number;
}

class Model {
  signals: Map<string, Signal>;
  funcs: Map<string, Func>;
  edges: Edge[];
  devices: Map<string, Device>;
  callouts: Callout[];       // 与实体无关的自由文本块
  inlined: Set<string>;      // 被 --inline 折叠成直连边的信号 id —— entities() 必须跳过它们
  files: string[];
  rebuildEdges(): Edge[];   // reads → (signal → func, read)；writes → (func → signal, write)
}
```

**两条硬规则**：

1. **边只来自函数体。** `f.reads`/`f.writes` 由 `defUse()` 扫描 `=` 左右标识符得出，
   与注释零关系。改注释不会移动任何一条线。
2. **布局坐标不属于 IR 的语义层。** 它们存在（因为 `.drawio` 层要用），但
   `dump.ts` 刻意不导出，否则路由 bug 会伪装成解析 bug。

---

## 3. 转换流程

### 正向：源码 → `.drawio`

```
纯文本
  → splitlines()                        按 Unicode 行边界切；**不能用 split(/\r?\n/)**
  → 逐行状态机（buf 收集 `///` 注释块 / `[...]` 特性行）
       ├─ 注解含 dir= → SIGNAL_RE  命中 → rawSignals
       └─ FUNC_RE    命中 → rawFuncs（.h 覆盖 .c 的元数据）
  → 注解块 readAnnotations() → Map<string,string>（dir/unit/alias/note/xy/size/...）
       └─ C# 侧另有 readMeta() → 四元组，第四位是 [Callout] 列表（一个声明可挂多个）
  → 建 Signal/Func，id = `${rel}::${name}`，group = stem(rel)
  → bodies() 抽函数体 → defUse() → reads/writes/calls
  → Model.rebuildEdges()
  → cli.ts 的两道**改内容**的预处理（都在布局之前，顺序不能反）
       ├─ --inline   → collapseSignals()：一写一读的信号折成设备直连，
       │                节点进 model.inlined，entities() 跳过它们；id 留在边的 sig 属性上
       └─ --layout-from → applyLayout(model, readLayout(file))：人工排版覆盖默认坐标
  → toDrawio(model, cards, rwLabels)
       ├─ assignDefaultPositions()  组内按 id 垂直堆叠，组间水平避让
       ├─ containerTree() → 容器按 codepoint 排序，gid = grpN；boxes = 各容器的绝对矩形
       ├─ entities() → 节点按 id 排序，cellId = nN（inlined 的已排除）
       ├─ emitCallouts("band")   ★ 必须**早于容器**（见下）
       ├─ 容器：每 group 一个 swimlane，geometry 相对**父容器**原点
       ├─ 节点：写 <object symbolId=… kind=…>，geometry 相对**自己的容器**原点
       │    样式 = 基样式 + 源码里的 Style 片段（空 Style 时产物逐字节不变）
       │    --cards 且 asset ≠ "" → funcImageStyle(asset)，卡片变成图片
       ├─ emitCallouts("text")   box / text，此时在卡片之上
       └─ 每条边：
            waypoints 非空 → 直接用（人工排版，坐标是绝对的）
            waypoints 为空 → route() 选锚点+拐点（写进 <Array as="points">）
            → 写 <Array as="points"> 时把绝对坐标**减掉父容器原点**
       └─ 边标签去叠印（见下一节）
```

★ 分区带为什么要抢在容器前面：draw.io 按文档顺序叠放，而**一个单元格是连同它的整棵子树
一起画的**。「根 → 容器 → 卡片」这棵子树会在容器那一格被画到时整块画完，带是根的直接子节点，
排在容器后面就落在整棵子树**上面**，把容器里每张卡片都盖住。只把带排到卡片前不解决问题 ——
卡片不是根的兄弟，是容器的孩子。

### 边标签去叠印

信号一多，两三条边的中点会撞在同一个位置，标签叠成一片黑。做法是**只挪文字，不动线**：

```
每条边求 [出锚点, …拐点, 入锚点] → midAndNormal() → 边上弧长中点 + 单位法向
  → labelBox()                     以中点为心量出标签盒
  → separateLabels(boxes, LANE)    撞上的做并查集连通分量，逐条试格
  → 位移写进子单元格的 <mxPoint as="offset">，边自己的 label 置空
```

- `laneShift(step) = (step % 2 === 1 ? 1 : -1) * ceil(step / 2)`（+1, −1, +2, −2…）× `LABEL_LANE(17)`。
  **试格直到与已落位的每一条都 `!overlapsY`** —— 少了这一步会过冲，为了躲 A 又压上 B。
- 同一条边上的两条标签是**串联**处理的：挪走一条后另一条跟着整体平移，不然组内的相对关系会散。

两个几何坑，改这附近代码前务必先看 `drawio.ts` 里那段长注释：

- `mxGeometry` 的 `y` 是**垂直于边**的位移（`mxGraphView.js:2011` 沿 `(dy/L, -dx/L)` 走），
  所以一条竖边的标签看起来会横着跑 —— 按下推开的算法会长出横着散开的结果。**别用它。**
- `<mxPoint as="offset">` 加的是**全局坐标轴**位移，正数往右/往下，与边的走向无关。用它。
- `mxGeometry` 的 `x`（=0）是沿边的位置，0 表示弧长中点，保持不动。

去叠印已在 Python 与 .NET 对齐，三份实现使用同一套常量（`LABEL_LANE=17`、`LABEL_FONT=12`、
2px 容差、+1/−1/+2… 的交替位移）和同一套子单元格写法。金标准 `small-c` 里没有一对撞上的标签，
所以**金标准全绿也照不出这套逻辑的退化** —— 每份实现各有确定性夹具（TS 的在
`test/drawio.test.ts` 末尾，自带「两条边折线完全重合」的用例）。见 `docs/conformance.md` 的
“Aligned extensions”。

### 反向：`.drawio` → IR

```
XML 文本
  → unpack()          <diagram> 下没有 <mxGraphModel> 就当作 draw.io 压缩串解压
                      失败**必须抛错**，绝不返回空布局
  → loadCells()       收集 object/mxCell，记 parent / symbolId / source / target / rw
  → originOf()        沿 parent 链累加 mxGeometry，把父相对坐标还原成**绝对**坐标
  → readLayout()      { nodes: Map<symbolId,[x,y,w,h]>, edges: Map<"src->dst:rw", Point[]>, attrs }
  → applyLayout()     写回 IR；随后用 autoWaypoints() 认出"这是生成器写的"并清空，
                      只保留人工拖出来的拐点
  → foreignCells()    找「图里有、IR 里没有」的顶点，交给 adopt 接回源码
```

读回时会碰到的三类「看着像节点、其实不是」的单元格，`foreignCells()` 逐一排除：

| 单元格 | 特征 | 不排除的后果 |
| :--- | :--- | :--- |
| 容器 | id 在 `containers` 里 | 把 swimlane 当成用户新加的函数 |
| 去叠印标签 | `parent` 指向一条 `edge="1"` 的单元格 | **往源码里写一个名叫「经局域网读取数据集」的函数** |
| 文字块 | 带 `symbolId`（= `Callout.id`）| 把一段说明文字当成新函数写进源码 |

文字块的位置**读不回来**：`applyLayout()` 只查 `model.signals` / `model.funcs`，查不到就
`continue`，所以 `--layout-from` 时文字块会弹回源码里的 `Xy`，在 draw.io 里拖动它没有用。
这不是遗漏而是没做的功能 —— 两版的 `codegen` 都不回写几何，节点拖了位置也照样不写回 `.cs`，
只是节点能在同一个 `.drawio` 里被复用、文字块不能。要让它生效得先让 `Callout` 可被
`applyLayout` 寻址，并给 `codegen` 加一行 `Xy`/`Size` 的写回，两件都不在最小改动范围内。

### 压缩态（能力 8，非可选）

```
base64( raw-deflate( urlquote(xml) ) )
```

`urlquote` 的 safe 集是 `~()*!.'` —— 它**覆盖**了 urllib 默认的 `/`，所以 `/ & ; = < >`
全部要百分号编码。`.drawio` 里 `<diagram>` 若有非空文本却解不出来，
`unpack()` 抛 `Error`；返回空布局会让人工排版被无声丢弃。

---

## 4. 如何跑测试与一致性验证

```bash
npm test                          # 全部
npm run test:conformance          # 只跑 L1–L4 金标准
```

一致性测试在 `test/conformance.test.ts`，对 `../tests/golden/<name>/` 逐层断言：

| 层次 | 断言 | 关键点 |
| :--- | :--- | :--- |
| L1 | `dumpIr(model)` 深等于 `expected.ir.json` | 不含布局坐标 |
| L2 | 容器集合与嵌套、节点归属、边 `(src,dst,rw)` 及其所属容器 | 比较 symbolId→container 的**映射**，不是 id 字符串 |
| L3 | 节点 `[x,y,w,h]`、边折线序列、锚点 `exitX/…/entryY` | 全部转成绝对坐标后比 |
| L3+ | 生成的 `.drawio` 与金标准**逐字节相同** | 比 spec 要求更严；通过说明连属性顺序和浮点拼写都一致 |
| L4 | 生成的 `.drawio` 过 `mxfile.xsd` | 手写校验器；附带"金标准自身也要过"的自检 |

**金标准缺失一律抛错，绝不 skip。** `mustRead()` / `loadCase()` 在文件不存在、
JSON 不可解析、或案例目录没有登记在 `CASE_INPUTS` 时都会 throw。
`conformance.md` 的原话：*a skipped conformance test is worse than a failing one*。

**校验器不能是橡皮图章。** `test/xsd.test.ts` 和 `conformance.test.ts` 里都有一组
故意损坏的文档（违反 fixed、未声明属性、枚举越界、缺必需属性、多余子元素），
断言它们**必须**被拒。改校验器时这组测试是安全网。

跨实现验证：`test/fixtures/*.compressed.drawio` 是 **Python 生成的**压缩串
（`python tools/make-fixtures.py`），TS 读它并与明文结果对比 —— 避免"自己 pack
又被自己 unpack"的自证循环。

---

## 5. TS / Node 特有的踩坑清单

> 这一节全部是本次实现**真实撞到**的，不是泛泛而谈。每条都给了症状和写法。

### 5.1 Node 原生跑 TS 的三条硬约束（strip-only）

Node 只是**擦除**类型，不做类型分析，也不生成任何代码。所以：

| 写法 | 结果 | 正确写法 |
| :--- | :--- | :--- |
| `constructor(private readonly src: string) {}` | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | 显式字段 + 构造函数体赋值 |
| `enum Dir { In, Out }` | 同上（enum 会生成运行时代码） | `const DIRS = {...} as const` + union 类型 |
| `namespace X {}`（带运行时） | 同上 | 普通模块 |
| `import { XmlElement } from "./xml.ts"` | `does not provide an export named 'XmlElement'` | `import type { XmlElement } from "./xml.ts"` |

**`import type` 是被强制的**，因为擦除器无法判断某个名字是值还是类型 ——
它只会把 `import { X }` 原样保留成运行时导入。凡是 interface / type alias，
必须走 `import type`。**建议在 tsconfig 打开 `erasableSyntaxOnly: true`**，
让 tsc 提前把这类错误挡在编辑器里。

### 5.2 注释里不能出现 `*/`

我在 JSDoc 里引用 Python 正则的块注释字面量（把 `*/` 原样写进注释），
那个 `*/` 直接终结了块注释，报
`ERR_INVALID_TYPESCRIPT_SYNTAX: Expected ';', '}' or <eof>`。
**别在注释里写完整正则字面量**，用文字描述代替。

### 5.3 Python `re.findall` 的返回形状随捕获组数量变化 ⚠️ 最隐蔽

```python
IDENT_RE = re.compile(r"[A-Za-z_]\w*")          # 无捕获组
IDENT_RE.findall(stmt)                           # → ['v', 'g_raw']   整体匹配
CALL_RE = re.compile(r"([A-Za-z_]\w*)\s*\(")     # 1 个捕获组
CALL_RE.findall(stmt)                            # → ['fir_apply']    组内容
```

我一开始写了两个辅助函数 `findAll`（取 `m[0]`）和 `findAll1`（取 `m[1]`），
却对**无捕获组**的 `IDENT_RE` 用了 `findAll1` —— 全部拿到 `undefined`。

**症状极其难查**：不抛异常、不报错，只是 `reads`/`writes` 变成空集合，
`edges=0`，图里一条边都没有。而 `calls` 是对的（`CALL_RE` 恰好有捕获组），
所以"看起来一半在工作"，很容易误判成函数体扫描的问题。

**规矩**：`findAll` / `findAll1` / `findAllGroups` 三个函数语义各自独立，
调用点必须自己看清用的哪个。不要写"智能"函数去猜。

### 5.4 JS 正则的 `lastIndex` 是有状态的

带 `g` 的正则对象复用两次，第二次会从上次的位置继续 —— 静默漏掉前半段。
`regex.ts` 里所有辅助函数**每次都 `new RegExp(...)`**，从根上消除这个类 bug。

```ts
function withGlobal(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.replace(/[gy]/g, "") + "g");
}
```

### 5.5 `re.match` 没有直接对应物

Python 的 `re.match(p, s)` 锚定在位置 0，但**不是整串匹配**。
JS 的 `String.prototype.match` 做不到（要么是 search，要么整串）。
自己封一个：

```ts
export function matchAt(re: RegExp, text: string): RegExpExecArray | null {
  const m = new RegExp(re.source, re.flags.replace(/[gy]/g, "")).exec(text);
  return m !== null && m.index === 0 ? m : null;
}
```

另外一个细节：Python 非 MULTILINE 的 `$` 匹配**字符串末尾或末尾换行之前**，
JS 无 `m` 标志的 `$` 只匹配字符串末尾。对 `.strip()` 过的行没影响，对原始行有影响。

### 5.6 `\w` 的 Unicode 行为不同

Python 3 的 `\w` **默认 Unicode 感知**（能匹配中文、全角字符）；
JS 的 `\w` 只有 `[A-Za-z0-9_]`。

本项目已经踩到了：`csparse.ts` 为了让中文信号名/组件方法名出图，显式写
`[\p{L}_][\p{L}\p{N}_]*` 加 `u`，并整段跳过 `record` 声明。Python 的 `_IDENT`（Python 3 的
`\w` 本身 Unicode 感知）与 .NET 的 `\p{L}` 已按同样口径对齐，所以**中文标识符三版都能出图**。
JS 的裸 `\w` 仍然只认 ASCII —— 在这个项目里不要用它匹配标识符。

### 5.7 字符串排序：码点 vs UTF-16 码元

`Array.prototype.sort()` 默认按 UTF-16 码元比较，Python `sorted()` 按**码点**。
两者在补充平面字符上结论相反：

```ts
compareCodePoints("\uFFFD", "\u{10000}")  // -1（对的：65533 < 65536）
["\uFFFD", "\u{10000}"].sort()            // 反过来（0xD800 < 0xFFFD）
```

所有需要排序的地方（容器名、symbolId、边键、文件列表）都走
`order.ts::compareCodePoints`，不要用裸 `sort()`。

### 5.8 `str.splitlines()` ≠ `split(/\r?\n/)`

```ts
"a\n".split(/\r?\n/)      // ["a", ""]   ← 多一个空串
splitlines("a\n")         // ["a"]       ← 与 Python 一致
```

**后果不是格式问题，是行为问题**：codegen 靠"行数组是否相等"决定要不要写盘，
多出来的空串会让**每个没被改动的文件都被重写一遍**。

`splitlines()` 还要覆盖 Python 认的全部行边界：`\n \r \v \f \x1c \x1d \x1e \x85 \u2028 \u2029`。

### 5.9 `String.replace(str, str)` 只替换第一处

Python 的 `str.replace` **默认全替换**，JS 的要显式 `replaceAll`。

这个差异害我写错过一个测试：`xml.replace('width="160" height="60"', …)` 只改了
**第一个**匹配（那是 `g_filtered`），断言却检查 `g_raw`，于是测试"失败"而实现是对的。
从 Python 移植测试代码时**逐个检查每个 `.replace`**。

### 5.10 浮点打印

Python：`str(int(v)) if v == int(v) else repr(v)`。三处要对齐：

| 情况 | Python | JS 裸写 | 正确写法 |
| :--- | :--- | :--- | :--- |
| 整数值 | `420` | `"420"` ✅ | `String(v)` |
| `1e21` | `1000000000000000000000` | `"1e+21"` ❌ | `BigInt(v).toString()` |
| `1e-5` | `1e-05` | `"0.00001"` ❌ | `toExponential()` 后补两位指数 |
| `-0.0` | `0`（走 int 分支） | `"0"` ✅ | — |

切换阈值也不同：Python 在 exp < -4 或 exp ≥ 16 时用指数，JS 要到 1e-6 / 1e21。
见 `num.ts::num` / `reprFloat`。

### 5.11 XML：Node 没有 `DOMParser`

`xml.ts` 是手写的，对齐 `ElementTree` 的这些语义（**每一条都影响 L3**）：

- **空元素写成 `<x />`**（斜杠前有空格），不是 `<x/>`；解析时两种都要吃。
- **属性值里的 `\r \n \t` 序列化成 `&#13; &#10; &#09;`**，解析时再解回来。
  draw.io 的 base64 往返依赖这一点。
- **注释完全丢弃，且注释里的文本不进入 `text`/`tail`**。
- **`iter()` 是含自身的深度优先前序遍历**；**`find()` 只看直接子元素**，
  不是后代选择器 —— 写成 `querySelector` 语义会静默找错元素。
- **`text` / `tail` 的归属**：第一个子元素之前的是 `text`，子元素之后的是那个子元素的 `tail`。

### 5.12 label 的转义走两遍，两遍都必要

```ts
// 第一遍：把用户数据里可能出现的 < & 变成安全文本，然后拼上我们自己的 <br>
nodeLabel(...)  →  "g_raw<br>int16_t / in / LSB"
// 第二遍：作为 XML 属性值再转义一次（attrs() 统一做）
attrs(...)      →  label="g_raw&lt;br&gt;int16_t / in / LSB"
```

金标准里看到的是**第二遍之后**的形态。两个容易绊到的点：

1. **两遍都不能省。** 省掉 `attrs` 的转义，属性值里就有裸 `<`，XML 非法；
   省掉 `nodeLabel` 的 `escapeHtml`，用户数据里的 `<` 会被 draw.io 当 HTML 标签解析。
2. **含 `&` 的用户数据会被转两次**（`&` → `&amp;` → `&amp;amp;`）。这与 Python 版
   **一致**（Python 也是两遍 `escape`），不是 bug。但改 label 逻辑时必须清楚
   手里的字符串是"原始文本"还是"已转义文本"，分不清就会多转或少转一次 ——
   症状只是金标准 diff 里多几个字符，很难往回追。

### 5.13 base64 / URL 解码的退化路径

- Python `base64.b64decode` 与 Node `Buffer.from(s, "base64")` 都忽略非法字符，
  但**解码出的垃圾字节不同**；两者最终都会在 `inflateRaw` 上失败 —— 我们要的就是
  失败，因为静默返回空布局更糟。
- **不要用 `decodeURIComponent`** 代替 `urllib.parse.unquote`：前者对畸形
  `%` 序列抛 `URIError`，后者保留原样。`drawio.ts::unquote` 手写了容错版本。

### 5.14 XSD 校验器的两个非直觉点

1. **「组出现一次」≠「消耗了一个元素」。**
   `<xs:sequence><xs:element minOccurs="0"/></xs:sequence>` 可以既出现一次、
   又消耗 0 个元素。把两者划等号，`mxCell` 里那两行没有 `mxGeometry` 的
   structural cell 就会被误判成违规。`repeat()` 因此返回 `{index, matched}` 两个量。
2. **试探缓冲里的错误必须在成功时提交。**
   我第一版在成功路径丢弃了 `trial` 数组，结果**所有深层校验错误被静默吞掉**，
   校验器退化成"什么都通过"（9 个变异只拦下 2 个）。修好之后 9/9，与 lxml 完全一致。

写这类校验器的**验收方式**：准备一组**故意损坏**的文档，断言全部被拒；
再拿权威引擎（这里是 lxml）跑同一组，逐条比对判断。没有这一步，
你无法区分"校验通过"和"校验没跑"。

### 5.15 别用 PowerShell 的 `Get-Content` / `Set-Content` 改 UTF-8 文本文件 ⚠️ 我踩了

我用这一对 cmdlet 给 `README.md` / `SKILL.md` 做一次字符串替换，结果是：

```
Get-Content -Raw  →  -replace  →  Set-Content -NoNewline
```

**两个文件都变成无效 UTF-8**：中文变成 `乱码 + ?`，`read` 工具直接报
`invalid UTF-8 text`，源码级的替换也没生效（模式本身已被编码破坏）。
本机（zh-CN Windows）上 `Get-Content` 的**默认读取编码**不是 UTF-8，
`Set-Content` 又按 UTF-8 写出，一次往返就把多字节字符毁了。

**规避**：

```powershell
# 要么显式指定编码
Get-Content -LiteralPath $p -Raw -Encoding utf8
Set-Content  -LiteralPath $p -Value $t -NoNewline -Encoding utf8
```

**要么干脆别用 PowerShell 改文本** —— 用编辑器的写入工具。批量改文本不值得冒这个险：
损坏是**静默**的，只有当别的工具读它时才炸。

**顺带一个相关坑**：`[System.IO.File]::ReadAllBytes("相对路径")` 用的是
**进程的当前目录**，而 PowerShell 的 `Set-Location`/`cd` 只改 PowerShell 的 location，
**不改** `.NET` 的 `Environment.CurrentDirectory`。所以在 pwsh 里 `cd` 之后用
`.NET` 静态方法读相对路径，会读到**别处**（这里是仓库根目录），报
`Could not find file`。要么先 `Resolve-Path` 拿绝对路径，要么用 cmdlet。

---

## 6. 如何新增一门语言支持

以加 Rust 为例：

1. **新建 `src/rsparse.ts`**，导出 `parseRustProject(paths, root?) → Model`。
   照抄 `csparse.ts` 的骨架（它是最短的一份）：
   - `loadSources(paths, root)` 读文件（自动 UTF-8 + `splitlines`）
   - 逐行状态机：注释块 → `readMeta`，声明行 → 正则；**别用真正的 parser**，
     参考实现是正则驱动的，几何结果取决于正则的具体行为
   - 建 `Signal`/`Func`，`id = \`${rel}::${name}\``，`group = stem(rel)`
   - `bodies()` 抽函数体 → `defUse()`（**可以直接复用**，它是语言无关的标识符扫描）
   - `model.rebuildEdges()`

2. **在 `src/parse.ts` 注册扩展名**，加进分派逻辑。

3. **在 `src/codegen.ts` 加回写分支**：`syncSource()` 里按扩展名分派。
   只回写**声明层**，永不改函数体 —— 这是硬约束。

4. **在 `test/helpers.ts` 的 `CASE_INPUTS` 登记金标准案例**。
   不登记会**报错**而不是跳过，这是故意的。

5. **跑 `npm test`**，确认 L1–L4 全绿。

**必须遵守的不变量**：

- `id` 的格式是 `<rel-path>::<name>`，相对 **root**，正斜杠分隔。
- `group` = 文件名去扩展名，它决定容器划分。
- `defUse` 的三种语句形态（复合赋值/简单赋值/其他）顺序不能变。
- `toDrawio` 里容器按名字排序、节点按 `id` 排序、边按 `(src,dst,rw)` 排序 ——
  排序决定 `n1/n2/grp1` 的编号，而 L3 虽然不比 id 字符串，金标准的文本 diff 会比。

---

## 7. 不要破坏的东西

- **`ANCHOR_SETS` 的顺序**就是优先级。重排会让所有几何变化。
- **`_crosses` 的 `SHRINK=3` / `SLACK=2`**：它们让"终点贴边"不被误判成穿透。
  调大调小都会改变路由选择。
- **`candidates()` 里各候选的先后**：同长度时取先出现的，顺序即 tie-break。
- **`applyLayout` 里 `autoWaypoints` 的比较**：它区分"生成器写的拐点"和"人拖的拐点"。
  去掉这一步，`--layout-from` 复用一次就会把自动拐点固化死。
- **`EDGE_STYLE` 的默认值（`edgeStyle=orthogonalEdgeStyle;rounded=1;…`）**：它不只是个样式串，
  而是 TS / Python / .NET **共享契约**的一部分 —— 每份金样的 `expected.drawio` 里都写死了它和
  `<Array as="points">`，改默认值会让 18/18 一致性当场全红。要换走法就**加开关**（现成的例子是
  `--straight-edges` 与 `STRAIGHT_EDGE_STYLE`）：在 `cli.ts` 里读成布尔量，一路透传给
  `toDrawio` / `toSvg`，默认 `false` 保证既有产物逐字节不变。换样式时有四件事必须一起做，
  漏一件线还是弯的：清掉 `edgeStyle=orthogonalEdgeStyle`（不清，draw.io 会**自己**再算一遍
  正交走线）、去掉 `rounded=1`（没有拐角，圆角无从谈起）、去掉 `jumpStyle=arc`/`jumpSize=6`
  （跳弧只在布线器算拐点时才产生）、**保留 `exitX/exitY/entryX/entryY`**（它决定线从哪条边出发，
  与走法无关；丢了它 draw.io 会自己就近挑边）。另外**只丢自动拐点，`--layout-from` 里人工画的
  拐点要留着** —— 那是人明确放上去的东西，不该被一个样式开关悄悄吞掉。
- **`model.pinned` 的判据**：它记的是"读回值与 build 本来会写出的值不同"的实体，
  基准是**源码声明值，没声明才是默认布局值**，不是"与默认布局比"。基准搞错的话，源码里本来就
  写了 `xy` 的节点每轮 sync 都会被重写一遍，`sync` 的零 diff 立刻就没了。填它的只有 `applyLayout`
  一处（它是唯一同时握着两个数的地方），消费它的是 `codegen.ts`。注意 `cli.ts` 里
  `applyLayout` 排在 `adoptForeign`**之前**，所以图里手画、当轮被采纳的格子永远拿不到 `pinned`
  —— 要钉住它得先 `build` 出带 `symbolId` 的单元格再去拖。
- **任何失败都抛错，不要吞**。压缩串解不出来、金标准找不到、类型不认识的扩展名 ——
  全部抛。这个项目的核心主张是"图是派生的、代码是事实源"，
  静默丢数据正好摧毁这个主张。
