---
type: Guide
title: 元数据模板
description: 让编译产物可被 inspect 读出的最小附加物 —— C 的 DrawcodeMeta 与 C# 的 DrawcodeAttributes
tags: [templates, c, csharp, inspect, artifact]
status: stable
---

# 元数据模板

[← 文档索引](index.zh-CN.md)

模板是「让编译产物可解析」的最小附加物。复制文件、加几行标注、编译，产物就能被
`inspect` 与 VS Code 插件读出模块、信号、类型、函数与边。本页合并了原
`templates/README.md`、`templates/c/README.md` 与 `templates/csharp/README.md`
（2026-10-21 整合）。

两套模板互不依赖，按语言选一套：

| | C# | C |
| :--- | :--- | :--- |
| 目录 | [`csharp/`](../templates/csharp/) | [`c/`](../templates/c/) |
| 形式 | 一个 `DrawcodeAttributes.cs`，普通特性类 | `DrawcodeMeta.h` + `DrawcodeMeta.c`，定长记录进自定义段 |
| 读取方式 | .NET sidecar（`System.Reflection.Metadata`） | 读取器直接切 `dc_meta_entries` 段 |
| 产物 | `.dll`（PE/CLI） | `.o` / `.a` / `.so` / `.out`（ELF64 LE） |
| 运行时依赖 | 无 | 无 |
| 执行目标代码 | 否 | 否 |
| 版本 | `ArtifactModel.info.metadataVersion` | `DC_META_VERSION = 1`，写在 anchor 里 |

## 复制哪一套

- 工程是 C# / .NET：复制 [`csharp/DrawcodeAttributes.cs`](../templates/csharp/DrawcodeAttributes.cs)，
  在字段、方法、类型上加特性。静态字段、`PublishTrimmed` / `PublishSingleFile` 的限制见
  [C# 模板](#c-template-net)。
- 工程是 C（GCC/Clang，ELF 目标）：复制 [`c/DrawcodeMeta.h`](../templates/c/DrawcodeMeta.h) 与
  [`c/DrawcodeMeta.c`](../templates/c/DrawcodeMeta.c)，用宏写声明层。链接次数、`--gc-sections`
  与 `-flto` 的坑见 [C 模板](#c-template-elf)。

两套模板的语义一致：都只描述**声明层**（谁读写谁、哪个类型是持久化数据、哪个模块是根），
不记录运行时行为，也不从机器码或 IL 做语义推断。推断会随优化与构建选项漂移，
而声明层在 `-O0` 与 `-O2` 下是同一份数据。

## 最小验证

```bash
# C#：编译后指向 dll
drawcode inspect bin/Release/net8.0/YourProject.dll

# C：示例工程
cd templates/c/example && make -B CC=gcc AR=ar
drawcode inspect app.out
```

（在仓库里，`drawcode` 写作 `node typescript/bin/drawcode.ts`。）输出是规范 JSON；
插件打开同一产物时消费同一份 `ArtifactModel`。字段含义、id 规则与诊断码见
[`artifact-format.md`](artifact-format.md)。

## C template (ELF)

把两件事复制进你的 C 工程，编译产物（`.o` / `.a` / `.so` / `.out`）就能被
`drawcode inspect` 与 VS Code 插件直接读取：

| 文件 | 作用 | 链接次数 |
| :--- | :--- | :--- |
| `DrawcodeMeta.h` | 记录结构、宏、编译期布局断言 | 每个翻译单元 include |
| `DrawcodeMeta.c` | anchor 记录与段边界访问器 | **整个二进制只编译一次** |

模板只写声明层：不注册回调、不初始化运行时、不引用目标变量地址。
读取器按 200 字节定长切片，因此 `.o` 未链接时也能读，`strip` 也不影响。

### 接入

1. 复制 `DrawcodeMeta.h`、`DrawcodeMeta.c` 到工程（例如 `third_party/drawcode/`）。
2. 给每个模块定义名字。构建系统注入或源文件顶部写：

   ```c
   #define DC_META_MODULE "motor"
   #include "DrawcodeMeta.h"
   ```

   名字会进稳定 id（`<文件>::<模块>.<符号>`），不要用构建机绝对路径。
3. 编译 `DrawcodeMeta.c` 一次。它提供 anchor（版本 + 模块名）和
   `dc_meta_begin/end`；重复链接会得到重复的 `dc_meta_anchor`。
4. 在声明处写宏（每条宏都必须带分号）：

   ```c
   typedef struct DcState { double voltage; int32_t count; } DcState;

   DcState g_state;
   double  g_out;

   DC_SIGNAL(g_out,   "telemetry,direction=in,unit=V,init=0", "double");
   DC_SIGNAL(g_state, "store,direction=inout,path=state",     "DcState");
   DC_FIELD(DcState, voltage, "rmem,unit=V,init=0,alias=电压");
   DC_FIELD(DcState, count,   "rmem,init=0");
   DC_FUNCTION_AS(producer, "void", "alias=Produce,note=产生遥测");
   DC_PARAM(producer, 0, step, "uint32", "direction=in,unit=ms");
   DC_FUNCTION_AS(consumer, "void", "");
   DC_WRITE(producer, g_out);
   DC_READ(consumer,  g_out);
   DC_CALL(consumer,  producer);
   DC_MODULE_ROOT();               // 可选：树默认只列根模块
   ```

   常用的结构化属性都写在 tag 里（与 C# 的 `[Drawcode(...)]` 同义）：

   | tag | 模型字段 | 说明 |
   | :--- | :--- | :--- |
   | `direction=in\|out\|inout` | `Signal.dir` / `Param.dir` | 不写就是未知，读取器不会猜 |
   | `alias=` / `unit=` / `note=` | 同名展示字段 | 仅用于展示 |
   | `init=` | `Signal.initial` / `TypeField.initial` | 初值 |
   | `path=a/b` | `Signal.path` / `Func.path` | 显示分组 |
   | `store` | `Type.store`；信号上保留为标签 | 持久化（ER 视图） |
   | `exclude` | `exclude` | 默认隐藏 |
   | `kind=enum\|struct\|...`、`size=` | `Type.kind` / `Type.size` | 仅 `DC_TYPE` |

   `DC_FUNCTION_AS` 与 `DC_FUNCTION` 二选一：前者把返回类型写进 `type` 列，
   后者保持空串（未知）。`DC_PARAM` 的第三个参数是参数名，第四个是类型串，
   第五个是 tag；序号（第二个参数）决定参数顺序。参数 tag 目前消费
   `direction`、`alias`、`unit` 三项，其余属性会被忽略。枚举成员用
   `DC_ENUM_MEMBER` 登记，必须写在枚举定义之后。

5. 编译后用 `drawcode inspect build/app.out` 查看模型；插件打开同一文件即可得到树视图。

`DC_FIELD` 用 `_Generic` 推断基本类型；成员是自定义结构体时用
`DC_FIELD_AS(Owner, member, "TypeName", "tags")` 显式给类型串。

### 段保留（最容易踩的坑）

`__attribute__((used))` 只阻止**编译器**删掉静态变量，**不阻止链接器**。
`-Wl,--gc-sections` 下，如果 `dc_meta_begin/end` 没有被任何存活代码引用，整段会被回收。

模板的应对：

- **GCC 11+ / Clang 13+（ELF 目标）**：自动使用 `__attribute__((retain))`，
  每条记录都带 SHF_GNU_RETAIN，整段保留。无需额外配置。
- **更旧的工具链**：在链接脚本里加一行：

  ```ld
  .dc_meta : {
      KEEP(*(dc_meta_entries))
  }
  ```

  或让启动代码调用一次 `dc_meta_begin()`（例如自检函数），使引用链存活。

本机 GCC 10.3 实测：`.so` 加 `--gc-sections` 仍保留（导出符号让访问器存活），
但 `.out` 会整段丢失，读取器报 `no-metadata`。不要用「`.so` 没事」推断可执行文件也没事。

### 其他构建选项

| 选项 | 结果 |
| :--- | :--- |
| `-O0` / `-O2` | 记录数与字段顺序一致；模板记录是编译期常量 |
| `strip --strip-all` | 段与记录不受影响（不依赖符号表） |
| `--gc-sections` | 见上一节；GCC 11+ 用 `retain`，旧工具链用 `KEEP` |
| `-flto` | **不支持**。LTO 会重排/合并段，第一版不处理；请对含元数据的翻译单元关闭 LTO，或链接后验证段仍存在 |
| MSVC | 不支持。`section` 与 `__start_/__stop_` 语义不同，第一版只覆盖 GCC/Clang + ELF |

### 限制

- 字段是定长数组：`name` 48、`tag` 48、`kind` 16、`owner` 32、`type` 40。
  超长会在编译期报错，不会静默截断。注意 `tag` 的 48 字节含结尾 NUL，
  UTF-8 下一个汉字占 3 字节 —— 一条 tag 大约只放得下 3~4 个中文属性值，
  写不下时优先保 `direction`/`unit`/`init` 这类调试要用的。
- `DC_ENUM_MEMBER` 把成员值编码在 `offset` 列（uint32），示例使用非负值。
- `order` 用 `__COUNTER__` 记录声明顺序。GCC/Clang 逆序往段里追加对象，
  没有它就得到倒序的字段表。
- 宏只记录**你写下的**读写与调用；不会从机器码推断。漏写就是漏边，
  `inspect` 会给出 `dangling-read` / `dangling-write` 诊断。
- 函数名以字符串传入，编译器不会校验它是否真的存在。

### 示例

[`templates/c/example/`](../templates/c/example/) 是最小可编译工程，覆盖四个目标：

```bash
cd templates/c/example
make CC=gcc AR=ar          # app.o / libapp.a / libapp.so / app.out
drawcode inspect app.out
```

Windows 上没有常规 `cc` 时，可用本机的 Linux 交叉工具链：

```bash
export PATH="$CROSS_ROOT/bin:\
$CROSS_ROOT/usr/x86_64-unknown-linux-gnu/bin:$PATH"
make -B CC=x86_64-unknown-linux-gnu-gcc AR=x86_64-unknown-linux-gnu-ar all
```

产物被 `.gitignore` 忽略，`make -B` 可随时重建。

## C# template (.NET)

把 [`templates/csharp/DrawcodeAttributes.cs`](../templates/csharp/DrawcodeAttributes.cs)
复制进你的工程即可，不需要 NuGet 包、不需要生成器、不需要改构建脚本。
文件是普通 C# 源码（`namespace Drawcode`），特性会像其他类型一样编译进程序集。

### 接入

方式一：复制文件到工程目录。

```
YourProject/
  YourProject.csproj
  DrawcodeAttributes.cs   <- 来自本目录
  Signals.cs
```

方式二：保持模板在仓库外，用 `Compile Include` 链接：

```xml
<ItemGroup>
  <Compile Include="path/to/DrawcodeAttributes.cs" Link="DrawcodeAttributes.cs" />
</ItemGroup>
```

### 标注

```csharp
using Drawcode;

public static class Signals
{
    // 信号：Direction != None
    [Drawcode(Direction.In, Unit = "V", Alias = "电压", Tags = "telemetry,rmem")]
    public static double Voltage;

    // 从树中默认隐藏（仍存在于模型）
    [Drawcode(Direction.Out, Exclude = true)]
    public static double DebugOnly;
}

// 持久化数据：进 ER 表
[Drawcode(Store = true)]
public sealed class State
{
    public double Speed;
    public int Count;
}

// ICD 根：树默认只列根，可切换全量
[Drawcode(Root = "主程序")]
public sealed class FlightControl { }
```

| 参数 | 落在哪 | 作用 |
| :--- | :--- | :--- |
| `Direction`（位置参数） | `signal.dir` | `None/In/Out/Io` 原样映射为 `""/in/out/inout` |
| `Unit` / `Alias` / `Note` / `Tooltip` | `signal` / `func` | 展示信息 |
| `External` | `signal.external` | 外部占位样式 |
| `Asset` / `Path` | `signal` / `func` | 图片与容器层级（`sync` 回写用） |
| `Tags` | `signal.tags` / `type.tags` / `func.tags` | 逗号分隔；查看器过滤 |
| `Store` | `type.store` | 类型进入「持久化数据」ER 表 |
| `Root` | `module.root`（类型对应的模块） | 树默认只列根 |
| `Exclude` | 实体的 `exclude` | 树默认隐藏，开关后可见 |

`Direction` 的注释按「相对模块」定义：`In` = 本模块产生、`Out` = 本模块消费。
这与很多人的直觉相反，但 **drawcode 按枚举名原样映射、不做纠正** ——
纠正会把视图里的箭头方向整个翻过来。

### 哪些成员能被读到

- **字段**：必须是 `static`。`const` 会被编译器内联成字面量，IL 里没有字段访问，读不到；
  `static readonly` 仍编译为 `ldsfld`，**可以**读到，不必避免。
- **属性**：自动属性也可以；读取器会优先读属性，跳过 `<X>k__BackingField`。
- **方法**：带 `[Drawcode]` 的方法成为函数节点；方法体的 `ldsfld/stsfld` 生成读写边。
- 类型上的 `Drawcode` 用于 `Store/Root/Tags`，不会把类型本身变成信号。

### 构建约束

- **不要开启 `PublishTrimmed`**：裁剪器可能移除未被引用的特性与字段，元数据随之消失。
  读取器会报 `trimmed-metadata`。
- **不要开启 `PublishSingleFile`**：单文件会把程序集塞进 bundle，`PEReader` 读不到内部元数据。
- Debug / Release 都可以；本模板的验收样本两版都试过。

### 验证

```bash
dotnet build -c Release

# 需要 .NET 10 运行时；sidecar 在 drawcode 仓库的 tools/drawcode-metadata
node <drawcode>/tools/publish-metadata-tool.mjs
drawcode inspect bin/Release/net8.0/YourProject.dll --out model.json
```

`model.json` 里应能看到信号数、读写边与 `Store/Root/Exclude` 标记。

### 已知限制

- 跨程序集调用不建 `call` 边；泛型方法与编译器合成方法不建函数节点。
- 未带 Drawcode 特性的第三方程序集只能给出格式与符号概览，没有数据流。
- P0 不支持 `.exe`、`.pdb` 的深入解析。

## 相关

- [`artifact-format.md`](artifact-format.md) —— 产物模型、稳定 id、诊断码
- [`annotations.md`](annotations.md) —— 源码标注的完整键表（`@drawcode` / `[Drawcode]`）
- [`examples.md`](examples.md) —— 仓库自带的示例工程与金标准
