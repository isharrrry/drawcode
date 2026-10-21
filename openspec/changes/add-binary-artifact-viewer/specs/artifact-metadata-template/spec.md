## ADDED Requirements

### Requirement: 模板包可整文件夹复制并直接编译

`templates/csharp/` 与 `templates/c/` SHALL 各自成为自包含的文件夹：复制进用户工程后，不安装额外包、不运行生成器、不改构建脚本即可编译。

#### Scenario: C# 模板独立编译

- **WHEN** 把 `templates/csharp/` 复制进一个空的 .NET 项目并编译
- **THEN** 编译成功，无警告、无额外 NuGet 依赖

#### Scenario: C 模板独立编译

- **WHEN** 把 `templates/c/` 连同 `example/app.c` 用 `gcc -std=c11 -c` 编译
- **THEN** 编译成功，`sizeof(dc_meta_entry)` 的静态断言通过

### Requirement: C# 特性保持源兼容并支持结构化标签

C# 模板 SHALL 保留现有 `DrawcodeAttribute` 的构造参数顺序与含义，并新增可选命名参数 `Tags`、`Store`、`Root`。旧代码不加参数时 MUST 继续编译且行为不变。

#### Scenario: 旧代码不改动

- **WHEN** 用带 `[Drawcode(Direction.In, Unit = "V", Alias = "电压")]` 的既有源码配合新模板编译
- **THEN** 编译通过，产物中的方向/单位/别名与旧版一致

#### Scenario: 新增标签

- **WHEN** 字段标注 `[Drawcode(Direction.Out, Tags = "telemetry,rmem", Store = true)]`
- **THEN** 产物元数据中可读出 `Tags="telemetry,rmem"` 与 `Store=true`

### Requirement: 树浏览元数据支持根与排除

C# 模板 SHALL 提供 `Root` 与 `Exclude` 两个可选属性；读取器 SHALL 将其映射为 `ArtifactModule.root` 与各实体的 `exclude`。C 侧 SHALL 以保留标签 `root` / `exclude` 表达同一语义。

#### Scenario: 根模块

- **WHEN** 某类型标注 `[Drawcode(Root = "主程序")]`
- **THEN** 对应模块的 `root === true`，树视图默认只列根模块

#### Scenario: 排除条目

- **WHEN** 某字段标注 `[Drawcode(Exclude = true)]`
- **THEN** 该信号的 `exclude === true`，树视图默认隐藏，`showExcluded` 打开后可见

#### Scenario: C 侧保留标签

- **WHEN** C 记录 `DC_SIGNAL(g_state, "exclude", "State")`
- **THEN** 读取器产出 `exclude === true`

### Requirement: C 元数据记录必须是定长无指针 POD

`dc_meta_entry` SHALL 为固定大小的 POD 结构，MUST NOT 含指针字段；字符串 MUST 以定长内联数组保存。结构体大小变化时 MUST 在编译期失败。

#### Scenario: 编译期布局自检

- **WHEN** 修改记录字段导致大小不再是模板声明值
- **THEN** `_Static_assert(sizeof(dc_meta_entry) == DC_META_ENTRY_SIZE)` 编译失败

#### Scenario: .o 中可直接读取字符串

- **WHEN** 解析一个未链接的 `.o`
- **THEN** 无需解重定位即可读出 `name/tag/kind/owner/type`

### Requirement: 自定义段在常见构建选项下保留

模板 MUST 使用 `used` 属性并保证 `dc_meta.c` 对 `__start_/__stop_` 的引用，使 `dc_meta_entries` 段在 `--gc-sections` 与 `strip` 后仍然存在。模板 README MUST 说明不链接 `dc_meta.c` 时的 `KEEP` 方案。

#### Scenario: --gc-sections

- **WHEN** 用 `gcc -ffunction-sections -fdata-sections -Wl,--gc-sections` 链接模板示例
- **THEN** 产物中仍能读到全部元数据记录

#### Scenario: strip

- **WHEN** 对产物执行 `strip --strip-all`
- **THEN** 元数据段仍在，记录数与 strip 前一致

### Requirement: 元数据版本可被读取器识别

模板 SHALL 定义元数据版本号，并在 anchor 记录中写入；读取器据此判断兼容性。

#### Scenario: 版本写入

- **WHEN** 解析由模板编译的产物
- **THEN** anchor 记录中的版本与 `DC_META_VERSION` 一致

#### Scenario: 版本过旧

- **WHEN** 产物由旧版模板编译，版本号低于读取器支持的最低版本
- **THEN** 读取器报出版本不匹配，并提示升级模板

### Requirement: 模板文档覆盖接入方式与已知坑

每套模板 SHALL 附带 README，至少覆盖：如何接入、编译/链接选项、已知限制、验证方法。

#### Scenario: C# 文档覆盖裁剪

- **WHEN** 阅读 `templates/csharp/README.md`
- **THEN** 能找到关于 `PublishTrimmed`、`PublishSingleFile`、`const` 会被内联而 `static readonly` 不受影响的明确说明

#### Scenario: C 文档覆盖段保留

- **WHEN** 阅读 `templates/c/README.md`
- **THEN** 能找到 `--gc-sections` 的 `KEEP` 写法与 MSVC 不支持说明
