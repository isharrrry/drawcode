# 任务

> 粒度 2-5 分钟；`[P]` 可并行；`[T]` 测试先行。阶段验收见 `design.md` §11。
> 每完成一个阶段跑一次 `openspec validate add-binary-artifact-viewer --strict` 与对应测试。

## 1. 契约与骨架（P0）

- [x] 1.1 新建 `typescript/src/artifact/model.ts`，落 `ArtifactModel` 及全部子结构（design §4）
- [x] 1.2 新建 `typescript/src/artifact/diagnostics.ts`，定义诊断码常量与收集器
- [x] 1.3 新建 `typescript/src/artifact/format.ts`，实现 magic bytes 分派：ar / PE / ELF / unknown（design D3）
- [x] 1.4 [T] 为 `format.ts` 写单测：`!<arch>`、`MZ`、`\x7fELF`、随机字节四类输入
- [x] 1.5 新建 `typescript/src/artifact/read.ts`，导出 `readArtifact(path): Promise<ArtifactModel>`，先只实现分派与空模型
- [x] 1.6 [T] 为 `read.ts` 写「未知格式返回空模型 + 诊断」的测试
- [x] 1.7 在 `typescript/src/index.ts` 导出 `readArtifact` 与 `ArtifactModel`

## 2. C# 读取器（P0，.NET sidecar）

> 解析交给 `tools/drawcode-metadata`（net10.0，`System.Reflection.Metadata`），TS 侧只调用。
> 见 design §5 与 §12 决策 5。前置条件：开发机有 .NET 10 运行时。

- [x] 2.1 新建 `tools/drawcode-metadata`，只读 `PEReader`，不 `Assembly.Load`、不执行目标产物
- [x] 2.2 落 `ArtifactModel` DTO，字段与 `typescript/src/artifact/model.ts` 一一对应（camelCase JSON）
- [x] 2.3 [T] `HasMetadata=false` → `unsupported-native-pe` 诊断，`format=pe-native`
- [x] 2.4 类型表：全名、kind（`<Clone>$` + `PrintMembers` 判 record）、`<Module>`/`<...>` 过滤
- [x] 2.5 字段/属性：属性优先于 `<X>k__BackingField`；带 `Direction != None` 的成员 → 信号
- [x] 2.6 特性解码：固定参数（枚举）+ 命名参数（Unit/Alias/Note/Tooltip/External/Tags/Store/Root/Exclude）
- [x] 2.7 方向映射从元数据里的 `Direction` 枚举常量读，不写死 0/1/2/3
- [x] 2.8 方法表：跳过 ctor / `<...>` / 泛型 / `[CompilerGenerated]`；重载追加参数串
- [x] 2.9 IL 扫描：单字节 + 0xFE 操作码长度表，未知操作码与越界立即失败
- [x] 2.10 `ldsfld/stsfld` → read/write 边；`call/callvirt/newobj` → call 边
- [x] 2.11 跨程序集方法不建节点；外部字段建 `external:` 占位信号
- [x] 2.12 稳定 id：程序集名 + 全名；`#字段` / `.方法`；无地址、无随机数
- [x] 2.13 模块树：assembly → namespace（按段拆） → type；counts 为子树计数
- [x] 2.14 sidecar 显式写 UTF-8 字节（不走 `Console.Out`，避免 GBK 控制台把中文变成 U+FFFD）
- [x] 2.15 [T] 用样本 DLL 断言 31 信号 / 22 组件函数 / 31 读 / 31 写 / 零悬空
- [x] 2.16 新建 `typescript/src/artifact/pe.ts`：定位 sidecar、`execFile`、解析 JSON、失败转 `tool-unavailable`
- [x] 2.17 `read.ts` 的 PE 分支改调 `readPeCli`
- [x] 2.18 删除手写 PE 解析文件（`pe-stream` / `pe-tables` / `pe-sig` / `pe-attr`）
- [x] 2.19 [T] 样本测试：`DRAWCODE_SAMPLE_DLL` 指向样本 DLL 时断言上述数字，未设置则 skip
- [x] 2.20 把 sidecar 构建纳入发布脚本（`tools/publish-metadata-tool.mjs`）：开发态、CI 与 VSIX 均框架依赖，`--self-contained` 作为可选形态
- [x] 2.21 [T] 断言同一 DLL 连续解析两次得到完全相同的 JSON（稳定 id 与排序）

## 3. C 读取器（P1）

- [x] 3.1 [T] 写测试：`templates/c/example` 编译出的 `.o` 能读出全部记录
- [x] 3.2 新建 `typescript/src/artifact/elf.ts`，校验 `\x7fELF`、ELF64、小端
- [x] 3.3 实现 section header table 与 `.shstrtab` 解析
- [x] 3.4 实现 `dc_meta_entries` 段定位，报缺失诊断（`no-metadata`）
- [x] 3.5 实现 200 字节记录切片与字段解码（name/tag/kind/owner/type/size/offset/order）
- [x] 3.6 实现 anchor 版本校验，版本不符报错
- [x] 3.7 [T] 断言版本号写错时返回明确诊断
- [x] 3.8 实现记录到模型的映射：signal/field/function/read/write/call，含保留标签 `root`/`exclude`（design §6.2）
- [x] 3.9 实现模块路径：`DC_META_MODULE/<owner>`；字段类型回链 `typeId`
- [x] 3.10 [T] 断言 `.o` 的记录映射与 fixture 预期清单一致（合成字节 + 真实产物双测试）
- [x] 3.11 新建 `typescript/src/artifact/ar.ts`，解析 `!<arch>\n` 头、长名表 `//`、对齐填充
- [x] 3.12 实现 ar 成员递归解析，成员名去重（`member#index`）
- [x] 3.13 [T] 断言 `.a` 的成员数与每成员记录数；无元数据成员不建空模块
- [x] 3.14 实现 `.symtab` + `.rela.text` 读取（仅在 `--infer-edges` 时启用）
- [x] 3.15 实现重定位偏移到函数地址区间的归属，生成 `inferred: true` 的边
- [x] 3.16 [T] 断言 `strip --strip-all` 后声明层仍在、推断边关闭

> 3.14–3.16 已从 P4 提前实现，但**默认关闭**：只有 `--infer-edges` 才读 `.rela.text`，
> 按重定位偏移回落到 `.symtab` 的函数地址区间，补 `kind: "read", inferred: true` 的边，
> 并追加一条 `inferred-edges` 诊断；`strip --strip-all` 后 `.symtab` 缺失，推断自动关闭，
> 声明层（`dc_meta_entries`）不受影响。默认关闭是因为推断边会随优化与构建选项漂移，
> 与「声明层稳定」的目标冲突。

## 4. 模板包（P0/P1）

- [x] 4.1 新建 `templates/csharp/DrawcodeAttributes.cs`，扩展 Tags/Store/Root/Exclude 属性
- [x] 4.2 [T] 用模板编译样本工程的等价最小工程，断言可编译（临时工程验证；仓库内不保留夹具）
- [x] 4.3 新建 `templates/c/DrawcodeMeta.h`，落 `dc_meta_entry` 与全部宏
- [x] 4.4 新建 `templates/c/DrawcodeMeta.c`，落 anchor、迭代器、`__start_/__stop_`
- [x] 4.5 加 `DC_META_VERSION` 并写入 anchor
- [x] 4.6 加 `DC_CALL(fn, callee)` 宏
- [x] 4.7 [T] 编译 `templates/c/example/app.c`，断言 `_Static_assert(sizeof == 200)` 通过
- [x] 4.8 新建 `templates/c/example/Makefile`，覆盖 `.o/.a/.so/.out` 四个目标
- [x] 4.9 [T] 在 `-O0/-O2`、`strip`、`--gc-sections` 组合下跑解析器，断言记录数一致
- [x] 4.10 写 `templates/README.md`：两套模板对比、复制方式
- [x] 4.11 写 `templates/csharp/README.md`：Include 方式、禁止 Trim/SingleFile、信号字段要求
- [x] 4.12 写 `templates/c/README.md`：链接方式、`KEEP(dc_meta_entries)`、`-flto` 注意

> 4.9 实测：GCC 10.3 下 `.o/.a/.so/.out` 与 `strip` 计数一致；`--gc-sections` 的 `.so` 保留，
> `.out` 丢失（无 `retain`）。文档已把「GCC 11+ retain / 旧工具链 KEEP」写成硬要求。

## 5. CLI `inspect`（P0）

- [x] 5.1 在 `typescript/src/cli.ts` 的 `USAGE` 增加 `inspect <artifact> [--out FILE] [--infer-edges]`
- [x] 5.2 实现参数解析与错误码（参数错 2，正常 0）
- [x] 5.3 实现规范 JSON 序列化：键排序、数组稳定排序、剔除地址（与 `dump-ir` 同风格）
- [x] 5.4 [T] 断言两次运行的 JSON 字节一致
- [x] 5.5 [T] 断言 `--out` 省略时写 stdout
- [x] 5.6 更新 `README.md` 与三语言 README 的命令表
- [x] 5.7 新建 `docs/artifact-format.md`：`ArtifactModel` 字段、id 规则、诊断码

## 6. 示例与金标准（P1）

- [ ] 6.1（改由仓库外的 C# 样本工程承担）新建 `examples/artifact/csharp/`：最小工程
- [x] 6.2 示例 C 工程落在 `templates/c/example/`：结构体 + 读写 + 调用 + 四个产物目标
- [ ] 6.3（改为合成字节）新建 `tests/artifact/` 目录与 README，说明 fixture 生成方式
- [ ] 6.4（不再需要）写 `tests/artifact/build-fixtures.mjs`：调用 `dotnet build` / `gcc` 产出样本
- [x] 6.5 不提交二进制 fixture：`test/artifact-elf.test.ts` 在测试内构造 ELF/ar 字节
- [x] 6.6 在 `typescript/package.json` 增加 `test:artifact` 脚本
- [x] 6.7 [T] 跑通 `test:artifact`，失败信息包含具体字段路径

> 6.3–6.5 的调整理由：二进制夹具无法在 diff 中审阅，且随工具链版本漂移；
> 合成 ELF 能把每个字段放到边界上，真实产物另有一条「若已编译」的集成测试。

## 7. VS Code 插件（P2）

- [x] 7.1 新建 `editors/vscode/package.json`：name、engines、contributes
- [x] 7.2 注册 `customEditors`：viewType、selector、priority `default`
- [x] 7.3 注册命令 `drawcode.openArtifact` / `inspectArtifact` / `refreshArtifact`
- [x] 7.4 注册配置 `maxSizeMB` / `showCompilerGenerated` / `showExcluded` / `inferEdges` / `artifactSliceThreshold`（无 `cliPath` / `nodePath`：解析核心随 VSIX 打包）
- [x] 7.5 新建 `src/extension.ts`：activate 注册 provider
- [x] 7.6 新建 `src/editor.ts`：`CustomReadonlyEditorProvider` 三个方法，`openCustomDocument` 返回只读文档
- [x] 7.7 实现大小检查与超限提示
- [x] 7.8 实现 `worker_threads` 解析分支（>= 8 MB）
- [x] 7.9 实现 Webview HTML（CSP + nonce），骨架由 `src/editor.ts` 的 `renderHtml` 生成
- [x] 7.10 实现模型切片协议：`init` / `requestNode` / `select` / `filter`
- [x] 7.11 实现「概览」Tab：格式、架构、计数、诊断列表
- [x] 7.12 实现虚拟化级联表：每列只渲染视口 ± 12 行（22px 共享行网格）
- [x] 7.13 实现「持久化数据」Tab：`Store=true` 类型表 + 字段表 + 类型下钻
- [x] 7.14 实现字段点击 -> 高亮读写函数
- [x] 7.15 实现「模块交联」Tab 的左右分栏与拖拽（初始 38%，范围 10%-70%）
- [x] 7.16 实现模块/分组/端口/字段四类复选框，勾选状态驱动左栏端口流
- [x] 7.17 实现默认空白画布与「勾选后才画流」；画布只画端口，不画模块/函数
- [x] 7.18 实现 SVG 正交折线路由与直角箭头
- [x] 7.19 实现竖线 X 坐标错位（同一 X 不重复）
- [x] 7.20 实现点击箭头标签 -> 显示信号信息（方向/单位/类型/来源函数）
- [x] 7.21 实现只勾一端时补出对端端口（虚线 context），节点副标题带「模块名 · 行 N」
- [x] 7.22 实现点击空白 -> 只清除选中，保留勾选
- [x] 7.23 实现 `Exclude` 默认隐藏与两个开关；不使用 `Root` 限制范围（`Root` 只标记 ICD 根）
- [x] 7.24 实现过滤框：名称/别名/类型/字段/标签，命中路径自动保留
- [x] 7.25 取消模块级聚合：端口流节点数远小于旧的「函数→信号→函数」三列模型
- [x] 7.26 实现点选双向定位（画布节点 ↔ 级联行）
- [x] 7.27 实现主题适配：只用 `--vscode-*` CSS 变量
- [x] 7.28 新建 `.vscodeignore`、`tsconfig.json`、构建脚本
- [x] 7.29 [T] 新建 `src/test/runTest.ts` + `suite/extension.test.ts`，断言打开 fixture 成功
- [x] 7.30 [T] 断言非产物文件走默认编辑器
- [x] 7.31 [T] 断言 Webview 收到 `init` 消息且模块数正确

> **7 的实施偏差**（以代码为准，保留的差异如下）：
>
> - 7.1 未声明 `activationEvents`：VS Code 从 `contributes` 自动生成，手写反而可能与实际贡献点漂移。
> - 7.4 未提供 `drawcode.enabled`：禁用自定义编辑器用 VS Code 内置的「打开方式」，多一个开关只会多一条配置路径。
> - 7.9 没有独立 `media/index.html`：HTML 骨架与 CSP nonce 在 `src/editor.ts` 的 `renderHtml` 里生成，避免模板和消息协议分居两处。
> - 7.10 切片阈值是 `drawcode.artifactSliceThreshold`（默认 2000，按信号+函数计），不是固定的实体数：
>   切片只下发模块/类型/诊断/计数，`requestNode` 按模块懒加载；置 0 可强制切片，置 -1 可强制全量。
> - 7.14 ER 字段反查依赖读取器把字段建模成信号；C 源码需同时写 `DC_FIELD`（布局）与 `DC_SIGNAL`（数据流），
>   只有字段没有信号时，信息面板会明确说明「没有字段信号映射」而不是静默无反应。
> - 7.25 最终没有做聚合：节点语义从「函数/信号三列」改成「端口行两列」，节点数由
>   写者×读者降为端口数，2000 节点阈值不再有实际意义；直接画全量端口流更可读。
> - 7.26 的「联动」实现为**点选双向定位**：点画布节点会打开并滚动级联表到对应端口行，
>   点/勾选级联行会把对应端口节点滚进画布视野；未做滚动条按比例同步——级联表按树序、
>   画布按端口列排序，比例同步没有语义。
> - 7.28 用 `tsc`（CommonJS）而不是 esbuild：构建只剩一条命令，少一个打包器与一份 sourcemap 约定。
> - 7.29–7.31 用 `@vscode/test-electron` 起真实扩展宿主，三条断言分别是：自定义编辑器标签 + `initAck`
>   （模块数/总数精确相等）、`.txt` 走 `TabInputText`、切片阈值置 0 后 `sliced=true` 且 totals 不变。
>   测试文件是 `src/test/suite/index.ts`（任务原文写的 `extension.test.ts` 没有另建，单文件已覆盖三条断言）。
>   本机用 `DRAWCODE_VSCODE` 指向已安装的 VS Code，避免下载；启动前必须删掉环境里的
>   `ELECTRON_RUN_AS_NODE`，否则 `Code.exe` 会按 Node 解释器运行并拒绝 VS Code 参数。

## 8. C# 样本验收（P3）

- [x] 8.1 在仓库外的 C# 样本工程补 `Tags`/`Store`（只加标签，不改数据流）
- [x] 8.2 编译 Release 产物，记录 DLL 路径与大小
- [x] 8.3 运行 `drawcode inspect`，断言 31/22/31/31
- [x] 8.4 用插件打开 DLL，人工核对四个视图
- [x] 8.5 截图归档到验收记录（不入仓库）
- [x] 8.6 若与样本工程自带的图检查脚本期望不一致，定位是读取器还是工程标注问题

> 8.1 实现方式：把样本工程的 `DrawcodeAttributes.cs` 换成当前模板（新增 `Tags`/`Store`/`Root`/`Exclude` 四个命名参数），
> 由样本工程自己的生成脚本给 31 个关系信号统一生成两维 `Tags`；样本工程的数据结构文件给两个记录类型
> 标 `[Drawcode(Store = true)]`。数据流（读写语句）未改，样本工程自带的 959 条图断言仍全过。
> 8.2 产物：样本工程 `bin/Release/net9.0/` 下的 DLL，198144 字节。
> 8.3 结果：signals 31、funcs 49（组件 22）、reads 31、writes 31、dangling 0、diagnostics 0；
> `Tags` 31/31（类别/区域两维），`Store` 2 个，`moduleRoots` 为空（样本未标 Root）。
> 验收中发现并修复：PE 侧字段表原先把 record 的合成属性 `EqualityContract` 与一个计算属性当成存储列；
> 现在只收有 `<Name>k__BackingField` 的属性，ER 表在 `size = 0`（PE 无布局信息）时把偏移/大小显示为「—」。
> 8.4 已在 VS Code 1.137.0 的真实 Extension Host 内完成：手工打包 VSIX，装入隔离的
> `--extensions-dir/--user-data-dir`，先起空窗口等扩展扫描完成，再 `code --reuse-window "<dll>"` 打开。
> 概览、模块交联（默认/勾选）、信号信息、持久化数据四视图逐项核对，计数与 `acceptance.md` 一致。
> 期间发现并修复两个视觉缺陷：勾选后画布被滚到最右导致目标不可见；节点文字按字符数截断导致中文溢出。
> 详细结果、打开顺序的坑与剩余边界见 `acceptance.md` 的「真实安装核对」。
> 8.5 截图在样本工程旁的验收目录（01–05 无头 Edge，06–11 真实安装），不在 drawcode 仓库内。
> 8.6 样本工程自带的图检查脚本全过；`DRAWCODE_SAMPLE_DLL=<产物> npm run test:artifact` 23/23 通过，
> 其中「真实样本的读写边与源码解析结果一致」「两次解析字节一致」直接覆盖本条。

## 9. 文档与收尾（P3）

- [x] 9.1 `docs/architecture.md` 增加「产物前端」一节，说明它不参与 `.drawio` 链路
- [x] 9.2 `docs/conformance.md` 说明产物模型不在 L1/L2/L3 范围内
- [x] 9.3 `README.md` 增加「浏览编译产物」章节与截图
- [x] 9.4 在 `openspec/changes/add-binary-artifact-viewer/` 补验收记录
- [x] 9.5 运行 `openspec validate add-binary-artifact-viewer --strict`
- [x] 9.6 提交前跑全量测试：Python / TS / .NET 既有金标准不受影响

> 9.5 `Change 'add-binary-artifact-viewer' is valid`。
> 9.6 实测：Python 144 通过 + 2 子测试；TS 205 项（不设样本 202 通过、3 跳过，0 失败）；
> .NET 119/119；插件 34/34 + 真实扩展宿主 e2e 3/3。设置样本 DLL 后 TS 205/205，
> `test:artifact` 29/29，包含真实 PE 与源码边一致、两次解析字节一致。
> 9.3 截图放在 `docs/assets/artifact-viewer.png`，与仓库既有的 `docs/assets/small-c.png` 同一约定。
