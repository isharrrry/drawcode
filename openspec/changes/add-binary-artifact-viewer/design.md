# 设计：二进制产物前端与 VS Code 只读视图

## 1. 问题与约束

### 1.1 现状

drawcode 的输入只有源码。`parse_any` 按扩展名分派到 `cparse` 或 `csparse`，产出内存 IR，再由
`drawio` 布局成图，`sync` 只回写声明层。三实现（Python / TypeScript / .NET）对同一输入必须
产出字节一致的 `.drawio`，这是仓库最硬的约束（见 `docs/contributing.md` 与金标准目录）。

### 1.2 要解决的问题

交付现场拿到的是编译产物（`.dll/.so/.out/.a/.o`），源码不一定在手；且 drawcode 从未支持 C#。
为 C# 写一套完整的语法 + 语义分析器（部分类、泛型、`using`、`global using`、源生成器、条件编译）
的维护成本，远高于从**编译产物**里读回同样的信息。

### 1.3 硬约束

- **不执行目标**：解析器只读文件字节，绝不 `Assembly.Load`、`dlopen`、`subprocess` 运行产物。
- **只读视图**：不从产物反向生成源码或 `.drawio`；与用户笔记「dc 源码转 uml，但不要反向转译」一致。
- **不碰金标准**：二进制前端不产出 `.drawio`，因此不进入 `tests/golden` 的 L1/L2/L3 比较链。
- **可离线**：插件不得依赖网络、不得依赖本机装有 .NET SDK / binutils / Python。

## 2. 前置研究：用真实产物验证可行性

以下结论均来自本机实跑，探针源码留在临时目录（`%TEMP%\dc_probe`），不随提案提交。

### 2.1 C#：PE/CLI 元数据足以还原数据流

探针 `MetaProbe` 只用 `System.Reflection.Metadata`（BCL，无第三方包）：

1. `PEReader` 打开 DLL，`HasMetadata` 判断是否 CLI 程序集；
2. `MetadataReader` 遍历 `TypeDefinitions / FieldDefinitions / MethodDefinitions / Properties`；
3. `CustomAttribute.DecodeValue(...)` 解码 `DrawcodeAttribute` 的固定参数与命名参数；
4. `pe.GetMethodBody(rva).GetILReader()` 扫描 IL：`ldsfld/stsfld`（静态字段读写）、
   `call/callvirt/newobj`（调用）；`MethodSpecification` 递归解析到 `spec.Method` 以覆盖泛型调用；
5. record 的 positional 属性不在 `FieldDefinitions` 里，从 `Properties` + `DecodeSignature` 读取。

**实测结果**（`sample-app`，Debug 与 Release 各测一次，均未裁剪）：

| 指标 | 产物读出 | 源码/README |
| :--- | :--- | :--- |
| 信号 | 31 | 31 |
| 组件（函数） | 22 | 22 |
| 类型 | 131 | — |
| 每信号读写 | 恰好 1 读 1 写（Release 逐信号统计，零悬空） | 一致 |
| `Direction` | 枚举值 2 = Out | 一致 |
| 泛型调用 `测试桩.生成/处理` | 可解析 | 一致 |
| 记录属性（含泛型） | `头/飞机/目标/架号/参数` 可读 | 一致 |

**结论**：C# 侧不需要语法分析，也不需要 PDB；特性 + IL + 类型签名足够。Release 优化没有削掉静态字段访问，说明这条路径不依赖 Debug 构建。

### 2.2 C：自定义段里的定长 POD 记录可静态切片

模板 `dc_meta.h` 的核心手法：

```c
#define DC_META_ATTR __attribute__((used, section("dc_meta_entries"), aligned(8)))
typedef struct dc_meta_entry {          /* 定长 200 字节，无指针 */
    char name[48]; char tag[48]; char kind[16];
    char owner[32]; char type[40];
    uint32_t size; uint32_t offset;
    uint64_t order;                     /* __COUNTER__，见下 */
} dc_meta_entry;
```

`order` 不是可选的装饰：GCC/Clang 会**逆序**往自定义段追加静态对象，没有它，
字段表会以 `gain、count、voltage` 的倒序出现，看起来像读取器解析错了。
`__COUNTER__` 是编译期常量，不产生重定位；读取器按它稳定排序即可恢复声明顺序。
旧产物全为 0，稳定排序退回段序，不会更糟。

每条标注展开成一条记录。`sizeof` / `offsetof` 是编译期常量，不带重定位；字符串内联在记录里，
所以 `.o` 中也能直接读出名字，不必先解重定位。`dc_meta.c` 里的锚点保证「有链接就至少有记录」。
段保留不能只靠 `used`：它挡的是编译器，不是链接器。GCC 11 / Clang 13 起模板用
`retain`（SHF_GNU_RETAIN）让段在 `--gc-sections` 下存活；旧工具链没有该属性，必须写
`KEEP(*(dc_meta_entries))`。

**实测矩阵**（GCC 10.3 交叉工具链，x86-64，示例 11 条记录）：

| 产物 | 段存在 | 记录数 | 说明 |
| :--- | :--- | :--- | :--- |
| `.o` | 是 | 11 | 无需重定位即可读全部字段 |
| `.a` | 是 | 成员各自 | app.o 11 / meta.o 1（仅 anchor）/ main.o 0 |
| `.so` | 是 | 12 | 含锚点 |
| `.out`（可执行） | 是 | 12 | 同上 |
| `strip --strip-all` | 是 | 不变 | 自定义段不受 strip 影响 |
| `--gc-sections` + `.so` | 是 | 12 | 导出符号使引用函数存活 |
| `--gc-sections` + `.out` | **否** | 0 | GCC 10.3 无 `retain`；读取器报 `no-metadata` |

最后一行是模板 README 反复强调 `KEEP` 的原因：同一个 `--gc-sections` 对共享库与
可执行文件的结果不同，不能靠「`.so` 没事」推断 `.out` 也没事。GCC 11+ 的 `retain`
路径因本机没有 ELF 目标的新编译器，尚未实测，只做了属性可用性探测。

**结论**：C 侧离线遍历不需要运行时、不需要 binutils、不需要 DWARF。

### 2.3 研究暴露的坑（已进模板与读取器设计）

1. `__FUNCTION__` 不是编译期常量，不能初始化 `char[]` → `DC_READ(fn, var)` 显式传函数名。
2. `__LINE__` 在 `##` 拼接里不展开 → 需要两级 `DC_CAT2`。
3. 记录里放指针会让 `.o` 里全是 0 → 字符串必须内联；`order` 只存编译期计数器。
4. `--gc-sections` 可能丢掉段，且可执行文件比 `.so` 更容易丢 → 模板在 ELF 上用 `retain`（GCC 11+/Clang 13+），旧工具链要求链接脚本 `KEEP`。
5. MSVC 的 `__declspec(allocate(".dcmeta$m"))` 段名与 ELF 不同 → 第一版 C 侧只支持 ELF（GCC/Clang）。

## 3. 架构决策

### D1：二进制前端产出 `ArtifactModel`，不塞进现有 IR

现有 `Signal/Func/Edge/Model` 服务于「画图」：坐标、样式、容器路径是必需字段，而产物视图需要
类型字段、标签、地址、引用位置、诊断，且**不需要坐标**。把两者合并会同时污染 IR 与布局层。

因此新增平行结构 `ArtifactModel`（见 §4）。若将来需要把产物画成 `.drawio`，再加一个
`ArtifactModel -> Model` 适配器，而不是让读取器直接吐 IR。

### D2：第一版在 TypeScript 实现

- 插件宿主是 Node，TS 读取器零跨进程依赖；Python/.NET 版本需要用户另装运行时。
- 读取器不产出 `.drawio`，不参与三实现一致性比较，因此不存在「只实现一份」的违约问题。
- Python / .NET 的读取器列为后续能力；届时复用同一份 `ArtifactModel` 契约与同一套金标准 JSON。

### D3：按 magic bytes 分派，不按扩展名

`.dll` 可能是 native PE（非 CLI），`.so/.out` 在 Linux 上都是 ELF，`.a` 是 ar。分派顺序：

```
ar  ("!<arch>\n")            -> archive: 逐成员再按 ELF/COFF 分派
PE  ("MZ" + PE\0\0)          -> 有 CLI header 走 C# 读取器；否则报 unsupported-native-pe
ELF ("\x7fELF")              -> C 读取器（第一版 ELF64 小端）
其他                          -> 回退 VS Code 默认编辑器（不接管）
```

扩展名只用于 VS Code 的 `selector` 与默认打开策略，解析本身不信任它。

### D4：元数据优先，IL / 重定位只作补全

- **C#**：`DrawcodeAttribute` 定义信号的方向、单位、别名与标签；IL 只负责补读写/调用边。
  没有特性的静态字段不进信号列表，只在「未标注符号」分组里出现。
- **C**：`DC_SIGNAL/DC_FIELD/DC_FUNC/DC_READ/DC_WRITE` 是唯一语义来源；`.rela.text` 仅当用户
  没写 `DC_READ/DC_WRITE` 时作为「推断边」的退路，且必须标 `inferred: true`。

理由：IL 与重定位只能说明「碰过这个地址」，不能说明业务方向（in/out）与单位；让工具猜会制造假边，
而假边比缺边更难发现。

### D5：产物视图只读，入口与写回都留在源码

插件不提供「保存」「同步」；`drawcode inspect` 也只输出 JSON。要对图做修改，仍然回到源码 +
`sync`。这是用户笔记「不要反向转译」的直接落地。

## 4. `ArtifactModel` 契约

> 以下是设计契约，不是实现。字段名会在 `typescript/src/artifact/model.ts` 落地。

```ts
export interface ArtifactInfo {
  path: string;
  format: "pe-cli" | "pe-native" | "elf" | "ar";
  arch: string;                  // "x64" | "x86" | "arm64" | ...
  kind: "dll" | "so" | "exe" | "object" | "archive" | "unknown";
  hasMetadata: boolean;          // 是否找到 drawcode 元数据
  metadataVersion: number;       // 0 = 无
  entryPoint?: string;
}

export interface TypeField {
  name: string; ctype: string;
  typeId?: string;               // ctype 是自定义类型时指向 ArtifactType.id，供 ICD 递归下钻
  offset: number; size: number;
  tags: string[];
}

export interface ArtifactType {
  id: string;                    // 稳定 id，见 §4.1
  name: string;
  kind: "class" | "struct" | "record" | "enum" | "interface";
  path: string;                  // 树路径：Namespace/Type 或 file/struct
  tags: string[];
  store: boolean;                // 持久化数据 -> ER 视图
  exclude: boolean;              // 元数据标了排除：树中默认隐藏
  fields: TypeField[];
  size: number;                  // 0 = 未知
}

export interface ArtifactSignal {
  id: string;
  name: string; ctype: string;
  dir: "in" | "out" | "inout" | "";
  unit: string; alias: string; note: string;
  tags: string[];
  path: string;                  // 模块/子模块
  ownerType?: string;            // 字段信号所属类型 id
  fieldOffset?: number;
  exclude: boolean;              // 元数据标了排除：树中默认隐藏
  external: boolean;             // 跨程序集/未定义符号
  inferred: boolean;             // 语义来自 IL/重定位推断
  address?: string;              // "0x..."，可缺
}

export interface ArtifactFunc {
  id: string;
  name: string; ret: string;
  params: { name: string; ctype: string; dir: string }[];
  path: string; tags: string[];
  reads: string[]; writes: string[]; calls: string[];
  exclude: boolean;
  external: boolean;
  address?: string;
}

export interface ArtifactEdge {
  src: string; dst: string;      // func id -> signal id | func id
  kind: "read" | "write" | "call";
  inferred: boolean;
}

export interface ArtifactModule {
  id: string; name: string; path: string;
  kind: "assembly" | "namespace" | "type" | "file" | "cu";
  children: string[];            // 子模块 id，树按此懒加载
  root: boolean;                 // 元数据标了根：默认只列根模块，可切换全量
  exclude: boolean;              // 元数据标了排除：树中默认隐藏
  counts: { signals: number; funcs: number; types: number };
}

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: "no-metadata" | "dangling-read" | "dangling-write" | "truncated-section"
      | "unsupported-arch" | "trimmed-metadata" | "gc-sections-risk";
  message: string;
  subject?: string;
}

export interface ArtifactModel {
  info: ArtifactInfo;
  modules: ArtifactModule[];
  types: ArtifactType[];
  signals: ArtifactSignal[];
  funcs: ArtifactFunc[];
  edges: ArtifactEdge[];
  diagnostics: Diagnostic[];
}
```

### 4.1 稳定 id 规则

id 必须可重复：同一产物解析两次、两台机器解析同一产物，必须得到相同 id（**不得含地址或随机数**）。

- C#：`<assembly-stem>::<namespace>.<type>`（类型）、`...::<type>.<method>`（函数）、
  `...::<type>#<field>`（字段信号）。重载方法追加参数类型串。
- C：`<file-stem>::<symbol>`；静态（`static`）符号若重名，追加所属编译单元。
- 跨程序集引用：`external:<assembly>::<full-name>`，只展示，不展开。

### 4.2 悬空处理

用户笔记指出 dc 源码是「非完整数据链的伪代码」，产物同样可能缺一端：

- 信号有写无读 → 保留信号，`Diagnostic(code="dangling-write")`；
- 有读无定义 → 生成 `external: true` 的占位信号 + `dangling-read`；
- 函数调用了未解析的外部符号 → 生成 `external: true` 的函数占位，不递归展开。

树与画布都不隐藏这些节点，而是用虚线/警示色标出——缺半边本身就是需要看到的信息。

## 5. C# 读取器（.NET sidecar）

### 5.0 实现方式与代价

CLI 元数据的解析交给随仓库构建的小工具 `tools/drawcode-metadata`（.NET，`System.Reflection.Metadata`）。
TS 侧 `artifact/pe.ts` 只负责定位工具、`execFile("dotnet", [dll, 文件])`、解析 stdout 上的 JSON。

选这条路的理由：手写要覆盖表行宽、编码索引、签名 blob、特性 blob、IL 操作数长度，
约 2,500–3,500 行，且每个边角都可能在真实产物上静默读错（读错一位，后面全错）。
`System.Reflection.Metadata` 是 BCL 官方实现，稳定且无需第三方包。

**代价与发布策略**：框架依赖发布只有几百 KB，但打开 `.dll` 的机器需要 .NET 8 运行时；
自包含发布把运行时打进包，单平台几十 MB，目标机无需安装 .NET。两种形态由
`tools/publish-metadata-tool.mjs` 统一产出：

- 开发机与 CI 默认框架依赖（`dotnet publish -c Release`），路径 `tools/drawcode-metadata/bin/Release/net8.0`；
- 发布给最终用户的 VS Code 扩展按平台自包含（`--self-contained --runtime <rid>`），
  扩展优先加载随包目录里的 sidecar，找不到再回退 PATH 中的 `dotnet` + 框架依赖版本；
- 两者都读同一份源码、产出同一份 JSON；差异只在「要不要带运行时」，不影响模型。

sidecar 仍然只读字节：`PEReader` 不 `Assembly.Load`，不执行目标产物。

### 5.1 输入判定

`PEReader.HasMetadata` 为真才走 CLI 路径；native PE（含 NativeAOT）返回
`unsupported-native-pe`，插件据此回退默认编辑器。

### 5.2 提取顺序

1. 程序集名 → 稳定 id 前缀（`xxx.dll` 改名不影响 id）；无 Assembly 表时退回文件名；
2. 类型：`TypeDefinitions` → 全名、kind（`<Clone>$` + `PrintMembers` 判 record）、
   `Fields`（属性优先于 `<X>k__BackingField`）；字段类型指向本程序集类型时填 `TypeField.typeId`；
3. 类型级特性：`DrawcodeAttribute` 的 `Tags/Store/Root/Exclude`（新增命名参数，见 §7.1）；
4. 字段/属性：带 `Direction != None` 的特性 → `ArtifactSignal`，并记下「字段句柄 -> 信号 id」；
5. 方法：跳过构造函数、`<...>`、泛型方法、`[CompilerGenerated]`；方法级特性 → `ArtifactFunc`；
6. 每个方法体扫 IL，token 翻回信号/函数 id；
7. 交叉核对：边端点必须在模型里（零悬空）。

方向映射按枚举名原样进行：`None -> ""`、`In -> "in"`、`Out -> "out"`、`Io -> "inout"`。
值到名字的对照从元数据里的 `Direction` 枚举常量读，不写死 0/1/2/3。
注意模板注释把 `In` 写成「Produced by the module」、`Out` 写成「Consumed by the module」，与直觉相反；
读取器**不得纠正**，否则产物视图会与源码图相反、`sync` 回写也会翻转语义。

### 5.3 IL 扫描规则

| 操作码 | 语义 | 归类 |
| :--- | :--- | :--- |
| `ldsfld` (0x7E) / `ldsflda` (0x7F) | 读静态字段 | read |
| `stsfld` (0x80) | 写静态字段 | write |
| `ldfld` (0x7B) / `ldflda` (0x7C) | 读实例字段 | 不默认成边 |
| `stfld` (0x7D) | 写实例字段 | 同上 |
| `call` (0x28) / `callvirt` (0x6F) / `newobj` (0x73) | 调用 | call |
| `calli` (0x29) | 间接调用 | 只计数，不产边 |

操作数解析：

- `FieldDef` → 查「字段句柄 -> 信号 id」；没有标注的普通字段直接忽略；
- `MemberRef` → 外部字段建 `external:` 占位信号；**外部方法不建节点**（见下）；
- `MethodSpec` → 递归 `spec.Method`；目标是泛型方法时通常解析为 null。

**跨程序集调用不建节点**：一个普通组件方法就会拖出上千条 `Add` / `ContainsKey` / `.ctor`，
它们既不是组件间关系，也会淹没真正的数据流。这与源码解析器「泛型名不是函数」的口径一致，
验收时 22 个组件方法的 `calls` 必须为空。

### 5.4 需要主动过滤的编译器生成物

- `<X>k__BackingField`：不单独出现，成员由属性代表；
- `get_/set_`：属性已由 `Properties` 表达，不重复成函数；
- `<Module>`、`<>c`、`<>c__DisplayClass`、名字以 `<` 开头的方法：跳过；
- record 的 `ToString`/`Equals`/`GetHashCode`/`Deconstruct`/`PrintMembers`：靠
  `[CompilerGenerated]` 过滤（它们名字正常，只靠名字认不出来）；
- 构造函数 `.ctor`/`.cctor`、泛型方法：跳过；
- 异步状态机 `MoveNext`：P0 不折叠，留到后续按需处理。

### 5.5 不支持与诊断

| 情形 | 诊断码 | 行为 |
| :--- | :--- | :--- |
| NativeAOT / ReadyToRun 无 CLI 元数据 | `unsupported-native-pe` | 只显示 PE 头信息 |
| `PublishTrimmed=true` 导致特性被裁 | `trimmed-metadata` | `hasMetadata=false` 并提示关闭裁剪 |
| sidecar 缺失、`dotnet` 不在 PATH、超时 | `tool-unavailable` | 空模型 + 提示所需运行时与构建命令 |
| 方法体越界 / 操作码未知 | `truncated-section` | 该方法不产边，其余继续 |
| 方法无方法体（`abstract`/`extern`） | — | 不产边 |

输出编码是硬约束：sidecar 必须显式写 UTF-8 字节，不能走 `Console.Out`。
Windows 控制台默认代码页是 GBK，被 Node 按 UTF-8 读走时中文会变成 U+FFFD ——
数字全对、名字全错，且没有任何报错。本机已实测踩到并修复。

## 6. C 读取器（ELF / ar）

### 6.1 段定位

1. 校验 `\x7fELF`、`EI_CLASS=2`（ELF64）、`EI_DATA=1`（小端）；其余报 `unsupported-arch`；
2. 读 section header table，经 `.shstrtab` 找 `dc_meta_entries`；
3. 段内按 200 字节切片，首条通常是 `kind="anchor"`，其 `tag` 存 `DC_META_VERSION`；
4. 版本不符 → 报错并给出模板版本提示。

> 为什么不在段首放 magic 头：会破坏「定长数组 + `__start_/__stop_`」这个链接器契约。
> 版本校验放在 anchor 记录里，既不增加记录大小，也不影响遍历。

### 6.2 记录到模型

| `kind` | 产出 |
| :--- | :--- |
| `signal` | `ArtifactSignal`，`owner` = 模块名，`type` = ctype |
| `field` | `TypeField`（`owner` = 类型名，`offset/size` 直接用） |
| `function` | `ArtifactFunc` |
| `read` / `write` | `ArtifactEdge`，`owner` = 函数名，`name` = 变量名 |
| `call`（可选） | `ArtifactEdge(kind="call")` |
| `anchor`/`header` | 跳过，仅用于版本与段存在性校验 |

树路径：`<模块>/<owner>`；`DC_META_MODULE` 宏决定模块名（未定义时为 `"unknown"`）。
`tag` 中的保留值：`root` 置 `ArtifactModule.root = true`，`exclude` 置对应实体的 `exclude = true`；
其余值按逗号切分为 `tags`。

### 6.3 缺 `DC_READ/DC_WRITE` 时的退路

仅在 `--infer-edges` 开启时：

1. 读 `.symtab` 拿函数与变量的地址/大小；
2. 读 `.rela.text`（需要 `--emit-relocs`）把重定位偏移归到函数地址区间；
3. 生成 `inferred: true` 的边，方向未知时记为 `read` 并在诊断中列出，让用户补显式宏。

`strip --strip-all` 后 `.symtab` 不存在，退路自动关闭，只保留声明层——这是可接受的降级。

### 6.4 ar 归档

`!<arch>\n` 之后逐成员：处理 60 字节头、长名表 `//`、2 字节对齐填充；成员按 ELF 解析，
模型加一层 `archive` 模块，成员作为子模块。同名成员以 `member#index` 去重。

## 7. 模板包

### 7.1 C#：`templates/csharp/DrawcodeAttributes.cs`

真实签名（已核对 `样本工程/DrawcodeAttributes.cs`）是**位置参数枚举 + 属性式命名参数**，在它基础上扩展四个属性，保持源兼容：

```csharp
public enum Direction { None, In, Out, Io }

[AttributeUsage(AttributeTargets.Field | AttributeTargets.Property | AttributeTargets.Method)]
public sealed class DrawcodeAttribute : Attribute
{
    public DrawcodeAttribute(Direction direction = Direction.None) => Direction = direction;
    public Direction Direction { get; }
    public string? Unit { get; set; }
    public string? Alias { get; set; }
    public string? Note { get; set; }
    public string? Tooltip { get; set; }
    public bool External { get; set; }
    public string? Asset { get; set; }
    public string? Path { get; set; }
    // 本次新增：
    public string? Tags { get; set; }      // "rmem,telemetry"
    public bool Store { get; set; }        // 持久化数据，进 ER 视图
    public string? Root { get; set; }      // 根模块标记
    public bool Exclude { get; set; }      // 树中默认隐藏
}
```

- `Tags`：逗号分隔的业务标签，用于过滤与分组（`rmem,telemetry`）。
- `Store`：标记「持久化数据」，进 ER 视图。
- `Root`：标记 ICD 分解的根节点（设备/系统）；存在根时树默认只列根，可切换全量。
- `Exclude`：树中默认隐藏（原图中不参与浏览的条目）。

模板同时带一个 `README.md`，说明三件事：如何 Include、**不要开启 `PublishTrimmed`/`PublishSingleFile`**、
信号字段必须是可变的 `static`。补充说明：`const` 会被编译器内联成字面量，IL 里没有字段访问，读不到；
`static readonly` 仍编译为 `ldsfld`，**可以**读到，不必避免。

### 7.2 C：`templates/c/DrawcodeMeta.h` + `DrawcodeMeta.c`

沿用探针验证过的宏，补三处：

1. `DC_META_VERSION` 常量 + anchor 记录写版本；
2. `DC_CALL(fn, callee)` 宏（可选，显式表达调用边）；
3. `DC_META_MODULE` 未定义时回退为 `"unknown"`，由构建系统用 `-DDC_META_MODULE=\"app\"` 传入模块名。
   不用 `__FILE__`：它会带上构建机的路径，既泄露路径，又让模型 id 随构建目录变化。

`README.md` 说明接入方式与坑：`--gc-sections` 需要 `KEEP(dc_meta_entries)` 或保留 `dc_meta.c` 链接；
`-flto` 需实测；MSVC 第一版不支持；`strip` 不影响自定义段。

### 7.3 模板包形态

```
templates/
  README.md                 # 两套模板的对比与选择
  csharp/
    DrawcodeAttributes.cs
    README.md
  c/
    DrawcodeMeta.h
    DrawcodeMeta.c
    example/{app.c, Makefile}
    README.md
```

整个文件夹复制进用户工程即可编译，无构建脚本依赖、无包管理器依赖。

## 8. VS Code 插件

### 8.1 包与注册

- 包位置：`editors/vscode/`，独立 `package.json`（name `drawcode-artifact-viewer`）。
- 依赖：`vscode` API + `drawcode` 的 TS 读取器（workspace 引用）。TS 依赖仍是零第三方包；
  PE/CLI 解析由 `tools/drawcode-metadata` sidecar 完成，运行期依赖本机 .NET 8 运行时。
- `contributes.customEditors`：
  - `viewType: "drawcode.artifact"`，`priority: "default"`（双击产物即进入插件视图，
    与「打开 .dll 就是看数据流」的意图一致）；可用 `drawcode.artifact.enabled=false` 整体关闭，
    关闭后回退默认编辑器；
  - `selector: [{ filenamePattern: "**/*.{dll,so,out,a,o}" }]`。
- 命令：`drawcode.openArtifact`、`drawcode.inspectArtifact`（把规范 JSON 输出到 untitled 文档）、
  `drawcode.refreshArtifact`。
- 配置：`drawcode.artifact.enabled`（默认 true）、`drawcode.artifact.maxSizeMB`（默认 200）、
  `drawcode.artifact.showCompilerGenerated`（默认 false）、`drawcode.artifact.showExcluded`（默认 false）。

### 8.2 解析所在的线程

| 产物大小 | 策略 |
| :--- | :--- |
| < 8 MB | 扩展宿主内异步解析（分片 `await`，避免长时间阻塞） |
| >= 8 MB | `worker_threads` 解析，主线程只收 `ArtifactModel` |
| > 上限 | 拒绝并提示调高 `maxSizeMB` |

Webview 只拿「首屏需要的切片」：根模块、当前展开的节点、当前选中节点的邻居。其余按
`requestNode` 消息回取。这样避免一次性把几万节点序列化进 Webview。

### 8.3 视图

三个 Tab 共用一份模型。交互以 `备忘旧数据截图/Drawcode逻辑思考.md` 的「方式角度分解」原文为准：

1. **模块交联**（默认）
   - **右栏（约 62%）**：wispkit 风格的**多列级联表**。
     - 第 1 列是模块层级树，默认展开到每个模块的首层端口行；端口行由「写函数所在模块
       → 输出端口、读函数所在模块 → 输入端口」派生，带「输出 / 输入」标记；
     - 点击端口行打开第 2 列，列出该信号类型的字段；点击结构字段继续向右展开，
       直到基本类型或出现类型环；
     - 所有列共享同一套 22px 行网格，字段列首行 = 父行全局索引 + 1，子列不遮挡父行；
     - 模块、分组、端口、字段都有复选框；模块/分组的勾选等价于其子树全部端口；
     - `Exclude` 默认隐藏；`showExcluded` / `showCompilerGenerated` 控制两类噪声；
     - 过滤框按名称/别名/类型/字段/标签过滤，命中路径自动保留。
   - **左栏（默认 38%，可拖 10%–70%）**：端口行数据流画布。
     - 画布只画端口节点，不画模块或函数；一条边就是「某个输出端口行 → 某个输入端口行」；
     - 节点副标题给出「模块名 · 行 N」，行号与右侧级联表一致；
     - 只勾选一端时，对端端口以虚线（context）补出；
     - 字段勾选折算到所属端口，字段路径记在节点上并在信息面板列出；
     - 多条竖线不得落在同一 X 坐标：按节点顺序依次错开；
     - 点击端口节点会展开并滚动右侧级联表到对应行。
2. **持久化数据（ER）**
   - 元数据标了 `Store=true` 的 List/表类型，按表呈现：类型 → 字段（名称/类型/偏移/大小/标签）；
   - 点击类型展开字段；字段类型是自定义类型时可继续下钻到基本类型；
   - 列出对该表做读/写（CURD）的函数，便于评估数据合理性。
3. **概览**
   - 格式、架构、入口、模块/信号/函数/类型计数、元数据版本；
   - 诊断列表（悬空边、无元数据、裁剪风险）。

### 8.4 性能

- 级联表虚拟化：每列只渲染视口 ± 12 行，列数上限为 1 + `MAX_FIELD_DEPTH`（8）；
- 行高固定 22px，字段列首行取父行索引 + 1，跨列共用一个滚动容器；
- 端口流只画端口节点，节点数远小于「函数 → 信号 → 函数」三列模型；
- 消息分块：单个消息 payload 上限 512 KB，超出则分页；
- 首次打开目标 < 1.5 s（8 MB DLL，样本工程规模 < 100 ms）。

### 8.5 安全

- CSP：`default-src 'none'`；脚本、样式仅 `webview.cspSource` + nonce；无远程资源；
- 所有二进制读取做边界检查（偏移 + 长度不得越界；表项数设上限）；
- 不 `eval`、不拼接 HTML（用 DOM API / `textContent`）；
- 解析器不产生也不执行任何代码；不调用外部命令。

## 9. 风险与对策

| # | 风险 | 影响 | 对策 |
| :-- | :--- | :--- | :--- |
| R1 | 只在 TS 实现，与「三实现一致」的直觉冲突 | 评审疑问 | 明示：产物前端不进 `.drawio` 金标准；契约独立，后续可补 Python/.NET |
| R2 | `PublishTrimmed`/`PublishSingleFile` 裁掉特性 | 读不到元数据 | 模板 README + `trimmed-metadata` 诊断 |
| R3 | `--gc-sections` 丢段 | C 侧空视图 | 模板 `used` + `__start_/__stop_` + README 的 `KEEP` 说明 + 诊断 |
| R4 | IL 推断出的方向不可靠 | 假边 | 元数据优先；推断边标 `inferred`，UI 用虚线 |
| R5 | 编译器内联 `const` | 漏读写边 | 文档要求可变 `static`；缺失时给 `dangling` 诊断 |
| R6 | C# 编译器生成物（属性/异步/闭包）造成重复边 | 图噪声 | 折叠规则（§5.4）+ 开关 |
| R7 | 大产物导致 Webview 卡死 | 不可用 | worker + 分块 + 虚拟化 + 聚合（§8.2/8.4） |
| R8 | 非 ELF64 小端（32 位/大端/COFF） | 解析失败 | 第一版明确报 `unsupported-arch`，列为后续 |
| R9 | 跨程序集类型只知名字 | 信息缺失 | `external: true` 占位，不递归 |
| R10 | 二进制金标准入库体积 | 仓库膨胀 | fixture 由脚本在测试时编译生成；仅最小样本入库（< 64 KB） |

## 10. 验证方案

### 10.1 读取器

- 单元：为 PE/ELF 头、截断文件、空段、错误版本各写用例；
- 金标准：`tests/artifact/<case>/{input, expected.model.json}`，比对规则与 `dump-ir` 一致
  （键排序、数组稳定排序、无地址字段）；
- 样本工程验收：脚本编译 `样本工程` → `inspect` → 断言 31 信号 / 22 函数 / 31 读边 + 31 写边 /
  `测试桩.生成` 与 `测试桩.处理` 调用存在。该工程不在本仓库内，找不到时 skip 并打印原因。

### 10.2 C 模板

- 编译环境：Linux gcc，或 Windows 的 MinGW/WSL gcc；缺少 gcc 时该组用例 skip 并打印原因；
- 用 `templates/c/example` 在 `-O0/-O2`、`strip`、`--gc-sections`、`.o/.a/.so/.out` 组合下编译并断言；
- 断言 `dc_meta_entry` 大小恒为 200（`_Static_assert` 已在编译期保证）。

### 10.3 插件

- `@vscode/test-electron`：打开 fixture → 断言 `openCustomDocument` 成功、Webview 收到模型；
- Webview 侧自检：无头加载测试页，断言三个 Tab 渲染、过滤、分栏拖拽、点击清空；
- 性能基准：8 MB DLL 首屏 < 1.5 s。

### 10.4 示例工程

- `examples/artifact/csharp/`：最小 C# 工程（信号、函数、record、泛型调用各一）；
- `examples/artifact/c/`：`templates/c/example` 的完整版（结构体 + 读写 + 调用）；
- 升级现有 `examples/small/*` 与 `样本工程`：补 `tags/store`，不改数据流语义。

## 11. 分期

| 阶段 | 内容 | 验收 |
| :--- | :--- | :--- |
| P0 | `ArtifactModel` + C# 读取器 + `inspect` CLI + C# 模板 | `样本工程` 读出 31/22/31 |
| P1 | C 读取器（ELF 段 + ar）+ C 模板 | 模板示例在 6 种编译组合下一致 |
| P2 | VS Code 插件：概览 + 树 + ER | `@vscode/test-electron` 通过 |
| P3 | 交联画布 + 交互 + 大产物优化 | 样本工程可视化验收 + 性能基准 |
| P4（可选） | `.rela.text` 推断边、Python/.NET 读取器 | 与 TS 的金标准 JSON 一致 |

## 12. 已确认的决策（2026-10-20）

1. **插件落点**：`editors/vscode/`，本仓库内。读取器与插件共享同一份 `ArtifactModel`，同仓改动可一次验证。
2. **左侧滚动联动**：左侧画布纵向滚动时带动右侧列表同步滚动（笔记「滚动条滚动右侧」取此读法）。
3. **`.o/.a` 深度**：P1 只做「段读取 + 成员枚举」，不做符号级反推；`.symtab` / `.rela.text`
   推断边退到 P4 可选。
4. **二进制样本入库**：只入最小 fixture（< 64 KB），大样本由脚本临时编译。
5. **PE/CLI 解析**：改为同协议栈的 .NET sidecar（`tools/drawcode-metadata`，用
   `System.Reflection.Metadata`），TS 侧只调用并消费 JSON。原方案「自研最小子集」作废：
   手写量约 2,500–3,500 行且边角易静默读错，稳定好维护优先。
   代价是打开 `.dll` 需要 .NET 8 运行时；若后续不接受，改为自包含发布（包体增大几十 MB）。
