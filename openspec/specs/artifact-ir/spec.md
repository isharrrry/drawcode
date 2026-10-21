# artifact-ir Specification

## Purpose
定义编译产物的中间表示（`ArtifactModel`）：从 PE/CLI、ELF 与 ar 产物中静态读取模块、信号、类型字段及读写/调用边，不加载、不执行目标程序，并为 `drawcode inspect` 与编辑器视图提供同一份规范 JSON。
## Requirements
### Requirement: 产物格式按 magic bytes 识别

读取器 SHALL 依据文件内容的 magic bytes 判定格式，不得仅凭扩展名判定。识别顺序为 ar（`!<arch>\n`）、PE（`MZ` 且存在 `PE\0\0` 签名）、ELF（`\x7fELF`）；无法识别时 MUST 返回 `format: "unknown"` 并回退调用方的默认处理。

#### Scenario: 扩展名与实际格式不符

- **WHEN** 读取一个扩展名为 `.dll` 但内容以 `\x7fELF` 开头的文件
- **THEN** 读取器按 ELF 解析，`info.format` 为 `"elf"`，不报格式错误

#### Scenario: 无法识别的文件

- **WHEN** 读取一个内容为随机字节的 `.so` 文件
- **THEN** 读取器返回 `info.format === "unknown"`，并产生 `severity: "error"` 的诊断，不抛出未捕获异常

### Requirement: C# PE/CLI 产物还原信号与数据流

对含 CLI 元数据的 PE 文件，读取器 SHALL 静态读取程序集元数据，产出 `types`、`signals`、`funcs`、`edges`。实现 MAY 委托随仓库提供的 .NET sidecar（`System.Reflection.Metadata`）完成解析；无论实现方式，MUST NOT `Assembly.Load` 目标程序集、解析其依赖或执行任何代码。

#### Scenario: 读取带 Drawcode 特性的 DLL

- **WHEN** 读取一个静态字段标注了 `DrawcodeAttribute`、且方法体读写该字段的 .NET DLL
- **THEN** `signals` 含该字段，`dir/unit/alias/tags` 与特性参数一致
- **AND** `edges` 含该方法的 read 与 write 边，`kind` 分别为 `"read"` 与 `"write"`

#### Scenario: 记录类型的字段展开

- **WHEN** 产物含 positional record 类型且字段带 `DrawcodeAttribute`
- **THEN** `types[].fields` 含全部 positional 属性，`ctype` 与源码类型一致；无法确定布局时 `offset`/`size` 为 `0`（未知）

#### Scenario: 泛型方法调用不产生悬空边

- **WHEN** 方法体通过 `MethodSpecification` 调用泛型方法，而目标方法按规则不建函数节点
- **THEN** 不产生 `call` 边；模型内不得出现指向不存在函数的边

#### Scenario: 跨程序集调用

- **WHEN** 方法体调用 BCL 或第三方程序集的成员
- **THEN** 默认不为其建立函数节点或 `call` 边，避免上千条框架调用淹没数据流

#### Scenario: 不执行目标程序集

- **WHEN** 读取一个带静态构造函数或模块初始化器的 DLL
- **THEN** 读取器只返回模型，不触发任何静态构造、不产生副作用

### Requirement: C ELF 产物读取 dc_meta_entries 段

对 ELF 产物，读取器 SHALL 通过 section header table 定位 `dc_meta_entries` 段，按固定记录大小切片并解码。记录大小 MUST 与模板的 `_Static_assert` 一致；不一致时 MUST 报错而不是越界读取。

#### Scenario: 从 .o 读取记录

- **WHEN** 读取由模板编译、含 12 条记录的 `.o`
- **THEN** 读取器解出 12 条记录，字段 `name/tag/kind/owner/type/size/offset` 与源码一致

#### Scenario: 从共享库读取记录

- **WHEN** 读取链接了模板的 `.so`
- **THEN** 读取器解出全部记录，并跳过 `kind="anchor"` 的记录

#### Scenario: 段缺失

- **WHEN** 读取一个不含 `dc_meta_entries` 段的 ELF
- **THEN** 读取器返回空模型，并产生 `code: "no-metadata"` 的警告

#### Scenario: 版本不匹配

- **WHEN** anchor 记录中的元数据版本与读取器支持的版本不同
- **THEN** 读取器产生 `severity: "error"` 的诊断，并停止解码该段

### Requirement: ar 归档逐成员解析

对 ar 归档，读取器 SHALL 遍历全部成员，对每个 ELF 成员按 ELF 规则解析，并把成员组织为 `archive` 模块的子模块。

#### Scenario: 静态库成员枚举

- **WHEN** 读取一个含多个 `.o` 成员的 `.a`
- **THEN** `modules` 含一个 `kind: "archive"` 的根模块，其 `children` 覆盖每个成员

#### Scenario: 同名成员

- **WHEN** 归档中存在两个同名成员
- **THEN** 两者的模型 id 不冲突，后者带 `#index` 后缀

### Requirement: 模型 id 稳定可重复

同一产物在多次解析、不同机器上 SHALL 得到完全相同的 id 集合。id MUST NOT 包含文件绝对路径、加载地址或随机值。

#### Scenario: 重复解析

- **WHEN** 对同一 DLL 连续解析两次
- **THEN** 两次得到的 `signals[].id`、`funcs[].id`、`types[].id` 集合逐一相等

#### Scenario: 不同路径的同一产物

- **WHEN** 同一产物被复制到两个不同目录后分别解析
- **THEN** 两次的 id 集合相同

### Requirement: 缺失一端的数据链以诊断呈现

当信号只有写没有读、或只有读没有声明时，读取器 SHALL 保留该信号或生成外部占位，并 MUST 产生对应诊断；不得静默丢弃。

#### Scenario: 有写无读

- **WHEN** 产物中某信号仅被写入、无任何读取
- **THEN** 该信号保留在 `signals` 中，且 `diagnostics` 含 `code: "dangling-write"`

#### Scenario: 读取未声明的外部符号

- **WHEN** 方法的 IL 读取了另一个程序集中的静态字段
- **THEN** 生成 `external: true` 的占位信号，并产生 `code: "dangling-read"` 的诊断

### Requirement: 规范 JSON 输出可稳定比对

`drawcode inspect` SHALL 输出规范化 JSON：对象键按字典序、数组按稳定键排序、省略运行期地址。相同输入两次运行的输出 MUST 字节一致。

#### Scenario: 两次运行字节一致

- **WHEN** 对同一产物执行两次 `drawcode inspect --out a.json` 与 `--out b.json`
- **THEN** `a.json` 与 `b.json` 字节相同

#### Scenario: 无元数据产物

- **WHEN** 对不含 drawcode 元数据的产物执行 `inspect`
- **THEN** 退出码为 0，JSON 含 `info` 与 `diagnostics`，不崩溃

### Requirement: 输入边界与大小受限

读取器 SHALL 对全部偏移、长度、表项数做边界检查，并 MUST 支持调用方设置文件大小上限。任何畸形输入 MUST 以诊断或异常形式返回，不得越界读取或无限循环。

#### Scenario: 截断的 ELF

- **WHEN** 读取一个被截断到只剩 32 字节的 ELF
- **THEN** 读取器返回 `truncated-section` 或等价诊断，不崩溃

#### Scenario: 超过上限

- **WHEN** 读取一个大于配置上限的产物
- **THEN** 读取器拒绝解析并返回明确提示，不分配对应大小的内存

