# C# 元数据模板

把 `DrawcodeAttributes.cs` 复制进你的工程即可，不需要 NuGet 包、不需要生成器、不需要改构建脚本。
文件是普通 C# 源码（`namespace Drawcode`），特性会像其他类型一样编译进程序集。

## 接入

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

## 标注

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

## 哪些成员能被读到

- **字段**：必须是 `static`。`const` 会被编译器内联成字面量，IL 里没有字段访问，读不到；
  `static readonly` 仍编译为 `ldsfld`，**可以**读到，不必避免。
- **属性**：自动属性也可以；读取器会优先读属性，跳过 `<X>k__BackingField`。
- **方法**：带 `[Drawcode]` 的方法成为函数节点；方法体的 `ldsfld/stsfld` 生成读写边。
- 类型上的 `Drawcode` 用于 `Store/Root/Tags`，不会把类型本身变成信号。

## 构建约束

- **不要开启 `PublishTrimmed`**：裁剪器可能移除未被引用的特性与字段，元数据随之消失。
  读取器会报 `trimmed-metadata`。
- **不要开启 `PublishSingleFile`**：单文件会把程序集塞进 bundle，`PEReader` 读不到内部元数据。
- Debug / Release 都可以；本模板的验收样本两版都试过。

## 验证

```bash
dotnet build -c Release

# 需要 .NET 8 运行时；工具在 drawcode 仓库的 tools/drawcode-metadata
node <drawcode>/tools/publish-metadata-tool.mjs
drawcode inspect bin/Release/net8.0/YourProject.dll --out model.json
```

`model.json` 里应能看到信号数、读写边与 `Store/Root/Exclude` 标记。

## 已知限制

- 跨程序集调用不建 `call` 边；泛型方法与编译器合成方法不建函数节点。
- 未带 Drawcode 特性的第三方程序集只能给出格式与符号概览，没有数据流。
- P0 不支持 `.exe`、`.pdb` 的深入解析。
