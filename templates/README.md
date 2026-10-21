# 元数据模板

模板是「让编译产物可解析」的最小附加物。复制文件、加几行标注、编译，
产物就能被 `drawcode inspect` 与 VS Code 插件读出模块、信号、类型、函数与边。

两套模板互不依赖，按语言选一套：

| | C# | C |
| :--- | :--- | :--- |
| 目录 | [`csharp/`](csharp/README.md) | [`c/`](c/README.md) |
| 形式 | 一个 `DrawcodeAttributes.cs`，普通特性类 | `DrawcodeMeta.h` + `DrawcodeMeta.c`，定长记录进自定义段 |
| 读取方式 | .NET sidecar（`System.Reflection.Metadata`）| 读取器直接切 `dc_meta_entries` 段 |
| 产物 | `.dll`（PE/CLI） | `.o` / `.a` / `.so` / `.out`（ELF64 LE） |
| 运行时依赖 | 无 | 无 |
| 执行目标代码 | 否 | 否 |
| 版本 | `ArtifactModel.info.metadataVersion` | `DC_META_VERSION = 1`，写在 anchor 里 |

## 复制哪一套

- 工程是 C# / .NET：复制 `csharp/DrawcodeAttributes.cs`，在字段、方法、类型上加特性。
  注意静态字段、`PublishTrimmed` / `PublishSingleFile` 的限制，见 [csharp/README](csharp/README.md)。
- 工程是 C（GCC/Clang，ELF 目标）：复制 `c/DrawcodeMeta.h` 与 `c/DrawcodeMeta.c`，
  用宏写声明层。链接次数、`--gc-sections` 与 `-flto` 的坑，见 [c/README](c/README.md)。

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

输出是规范 JSON；插件打开同一产物时消费同一份 `ArtifactModel`。
字段含义、id 规则与诊断码见 [`docs/artifact-format.md`](../docs/artifact-format.md)。
