# 无元数据演示（plain）

这组演示刻意**不包含** `[Drawcode]` / `[Device]` 特性、`DrawcodeMeta.h` / `.c`
或 `@drawcode` 注释。产物里没有 `dc_meta_entries` 段，读取器只能退回符号表
（C/ELF）或普通 .NET 元数据（C#），属于“能读到多少就多少”的浏览模式。

源码与构建脚本提交；编译产物由 `.gitignore` 忽略，但保留在工作区，供手工验证。

## 构建

```bash
# C：需要能产出 ELF 的 GCC；本机默认用 Linux 交叉工具链
cd examples/plain/c
make -B

# C#：普通类库，不引用特性文件
dotnet build examples/plain/cs -c Debug
```

## 四套对照

| 版本 | 产物路径 | 预期 |
| :--- | :--- | :--- |
| C 有元数据 | `templates/c/example/app.out`（同目录 `libapp.so` / `libapp.a` / `app.o`） | `hasMetadata=true`；模块 `app::demo`；2 信号、2 函数、3 条显式边 |
| C 无元数据 | `examples/plain/c/plain.out`（同目录 `libplain.so` / `libplain.a` / `sensor.o`） | `hasMetadata=false`；模块 `plain::plain`；2 信号（方向空）、3 函数、5 条推断读边 |
| C# 有元数据 | `tests/golden/small-cs/bin/Debug/net10.0/small-cs.dll` | `hasMetadata=true`；`AdcModule` / `DspModule`；3 信号带 in/out、3 函数、6 条显式边 |
| C# 无元数据 | `examples/plain/cs/bin/Debug/net10.0/plain-cs.dll` | `hasMetadata=false`；`Sensor` / `Filter` 两个类型模块；4 信号（方向空）、4 函数、7 条推断边 |

补充：

- `sensor.o`：未链接目标文件，2 函数、2 信号、3 条推断边。
- `libplain.a`：两个成员分别成模块（`libplain/main::main`、`libplain/sensor::sensor`）。
- `libplain.so` 与 `plain.out` 用 `-Wl,--emit-relocs` 链接，保留 `.rela.text`，
  因此能推断出“函数访问过哪个信号”。ELF 无法区分读写，推断边统一记为 `read`。
- 无元数据时，视图默认勾选「显示空模块」；C# 的类型模块与命名空间模块会直接展开，
  C 的归档成员也不会因为 0 计数而消失。
