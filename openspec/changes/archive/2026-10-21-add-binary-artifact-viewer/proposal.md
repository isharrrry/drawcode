## Why

drawcode 的输入只有源码：要浏览组件交联，必须先有源码再跑 `build`。但交付现场拿到的常是编译产物（.dll/.so/.out/.a/.o），源码不在手边；且 drawcode 从未支持 C#，补一个完整的 C# 语义分析器，成本远超收益。

前置研究用真实产物验证了另一条路——**把语义写进编译期元数据，再从产物里静态读回**。C# 的 `DrawcodeAttribute` 与 IL 的 `ldsfld/stsfld`、`call/callvirt` 足以还原信号读写与调用关系；C 的 `__attribute__((section))` POD 记录在 .o/.a/.so/.out 里是同一段可直接切片的字节，`sizeof/offsetof` 由编译器算好、不依赖重定位。实测一个仓库外的 C# 样本工程 DLL（Debug 与 Release 各一次）：31 个信号、22 个组件、每信号恰好 1 读 1 写、零悬空，与源码解析结果完全一致。

## What Changes

- 新增二进制前端：`.dll`（PE/CLI）、`.so/.out/.o`（ELF）、`.a`（ar），产出 `ArtifactModel`（模块 → 子模块 → 信号 → 类型字段 + 读写/调用边 + 结构化标签）。不加载、不执行目标程序。
- 新增 `drawcode inspect <artifact>`，输出规范 JSON，供插件与测试复用。
- 新增 `templates/`：C# `DrawcodeAttributes.cs`（扩展 Tags/Store/Root/Exclude）、C `DrawcodeMeta.h/.c`，连同 README 与最小示例，整文件夹复制即可编译。
- 新增 `editors/vscode/` 插件：只读自定义编辑器，Webview 三视图——「模块交联」（右栏懒加载树按勾选驱动左栏 20% 流画布，直角箭头、竖线错位、点空白清除引用）、「持久化数据」（ER 表）、「概览」；支持 Root/Exclude、标签过滤与引用定位。
- 升级 `examples/`，并另用一个仓库外的 C# 样本工程做验收。

## Capabilities

### New Capabilities

- `artifact-ir`: 二进制产物 → 规范化数据流模型（C# PE/CLI、C ELF/ar）。
- `artifact-metadata-template`: C#/C 两套可编译模板包与结构化标签规范。
- `vscode-artifact-viewer`: VS Code 只读编辑器与三视图。

### Modified Capabilities

（无。二进制解析不产出 .drawio，现有 build/sync 与三实现金标准不受影响。）

## Non-goals

- 不做反向转译：不从产物生成源码或 .drawio 回写；视图严格只读。
- 不做反编译（IL → C# 源码、机器码 → 汇编）。
- 未带元数据的第三方产物只给符号清单与提示，不给数据流。
- 第一阶段不支持 `.exe`、`.dylib`、`.pdb`、跨程序集符号解析。
- 不改变 `build`/`sync` 的行为，不重算任何既有金标准。

## Impact

- 新增：`typescript/src/artifact/`、`tools/drawcode-metadata/`（PE/CLI 解析 sidecar）、`templates/`、`editors/vscode/`、`tests/artifact/`、`examples/artifact/`
- 修改：`typescript/src/cli.ts`（新增 `inspect`）、`docs/architecture.md`、新增 `docs/artifact-format.md`
- 前置依赖：打开 `.dll` 需要 .NET 10 运行时（开发态与随扩展发布的 sidecar 都是框架依赖）；目标机不能装 .NET 时可改用 `--self-contained` 按平台打包。sidecar 用 BCL 的 `System.Reflection.Metadata` 只读字节，不加载目标程序集。这是对原「零运行时依赖」假设的修正
- 外部验收：仓库外的一个 C# 样本工程，由环境变量指向其产物（验收脚本引用，不复制进仓库）
