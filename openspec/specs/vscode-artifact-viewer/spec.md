# vscode-artifact-viewer Specification

## Purpose
定义 VS Code 只读自定义编辑器的行为：打开编译产物后提供概览、模块交联树与持久化数据视图，支持筛选、分组与活动栏产物树，且绝不修改或执行产物。
## Requirements
### Requirement: 以只读自定义编辑器打开编译产物

插件 SHALL 通过 `CustomReadonlyEditorProvider` 提供 `drawcode.artifact` 编辑器，用于打开 `.dll`、`.so`、`.out`、`.a`、`.o`。该编辑器 MUST NOT 提供保存、撤销或任何写回文件的入口。

#### Scenario: 打开 DLL

- **WHEN** 用户对 `medium-cs.dll` 执行「打开方式…」并选择 Drawcode
- **THEN** 打开只读 Webview，标题栏不出现保存按钮，文件内容不被修改

#### Scenario: 编辑被拒绝

- **WHEN** 自定义文档被以编程方式请求编辑
- **THEN** 文档不可变，抛出或返回「只读」语义的错误

### Requirement: 无法识别的产物回退默认编辑器

当文件的 magic bytes 不属于 ar/PE/ELF 时，插件 SHALL NOT 接管该文件，MUST 回退到 VS Code 默认编辑器，并给出一次性提示。

#### Scenario: 非产物二进制

- **WHEN** 用户用 Drawcode 打开一个真正的图片文件
- **THEN** 不显示 Drawcode Webview，回退默认编辑方式

#### Scenario: 损坏的产物

- **WHEN** 文件的 magic bytes 可识别但结构损坏
- **THEN** 打开 Drawcode Webview 并显示诊断信息，不崩溃、不阻塞编辑器

### Requirement: 提供概览、模块交联、持久化数据三个视图

Webview SHALL 提供三个可切换的 Tab：概览、模块交联、持久化数据。三者共享同一份 `ArtifactModel`。

#### Scenario: 概览内容

- **WHEN** 打开产物并停留在「概览」
- **THEN** 显示格式、架构、入口、模块数、信号数、函数数、类型数、元数据版本与诊断列表

#### Scenario: 持久化数据内容

- **WHEN** 切换到「持久化数据」
- **THEN** 显示 `Store=true` 的类型表与字段表，并按类型名分组
- **AND** 字段类型为自定义类型时可继续下钻到基本类型

### Requirement: 模块交联视图遵守既定布局与交互

「模块交联」SHALL 采用左右分栏：左侧为数据流画布，初始宽度约 20%，可拖拽调整；右侧为按层级遍历的条目树，子节点按需展开。左侧画布默认空白，只有右侧被勾选的信号条目才渲染。

#### Scenario: 分栏拖拽

- **WHEN** 用户拖动左右分栏手柄
- **THEN** 画布宽度随之变化，树保持可见，刷新后宽度保持

#### Scenario: 树形懒展开

- **WHEN** 用户点击一个含子模块的节点
- **THEN** 仅请求并渲染该节点的直接子节点，未展开的兄弟节点不被加载

#### Scenario: 默认不渲染任何流

- **WHEN** 打开产物并停留在「模块交联」，未勾选任何条目
- **THEN** 左栏画布为空白，不画任何箭头

#### Scenario: 勾选驱动渲染

- **WHEN** 用户勾选右栏一个信号条目
- **THEN** 左栏连线栏从写入端口行画到读取端口行

#### Scenario: 点击箭头显示信号信息

- **WHEN** 用户点击左栏箭头旁的标签
- **THEN** 显示该流的信号名、方向、单位、类型与来源函数

#### Scenario: 连线弯曲与车道错位

- **WHEN** 画布同时渲染多条流
- **THEN** 每条连线在右缘弯出，箭头指向目标行，且同一区间的多条线不重叠

#### Scenario: 点击信号显示引用位置

- **WHEN** 用户点击右栏一个信号条目
- **THEN** 左栏额外画出「被引用的地方」并高亮

#### Scenario: 点击空白清除引用

- **WHEN** 用户点击画布空白处
- **THEN** 引用线被清除，右栏勾选状态保留

#### Scenario: 按标签过滤

- **WHEN** 用户在过滤框输入 `telemetry`
- **THEN** 仅保留名称、别名或标签命中 `telemetry` 的条目，并自动展开其所在路径

#### Scenario: 根与排除

- **WHEN** 产物中某模块标注了 Root、某条目标注了 Exclude
- **THEN** 树默认只列 Root 模块且隐藏 Exclude 条目；打开「显示全部」与 `showExcluded` 后两者可见

### Requirement: 大数据量下保持可用

Webview SHALL 对树做虚拟化渲染，并在节点数超过阈值时对画布做模块级聚合；解析超过 8 MB 的产物 MUST 在 worker 线程执行，不得阻塞扩展宿主。

#### Scenario: 万级节点的树

- **WHEN** 打开一个含 10,000 个节点的模型并滚动树
- **THEN** 页面保持可交互，DOM 中同时存在的行数保持在视口附近

#### Scenario: 大产物解析

- **WHEN** 打开一个 50 MB 的 ELF
- **THEN** 解析在 worker 中进行，编辑器界面在解析期间保持响应

#### Scenario: 超限文件

- **WHEN** 产物大小超过 `drawcode.artifact.maxSizeMB`
- **THEN** 不解析，显示可调整上限的提示

### Requirement: Webview 内容安全

Webview SHALL 使用严格 CSP（`default-src 'none'`），脚本与样式仅允许本地 `webview.cspSource` 加 nonce；MUST NOT 加载远程资源、MUST NOT 使用 `eval` 或未净化的 HTML 拼接。

#### Scenario: 无远程请求

- **WHEN** 打开任意产物视图
- **THEN** DevTools 网络面板中没有任何跨域请求

#### Scenario: 恶意名称不执行

- **WHEN** 产物中含名为 `<img src=x onerror=alert(1)>` 的符号
- **THEN** 该名称以纯文本显示，不触发任何脚本执行

### Requirement: 解析与展示严格只读

插件 SHALL NOT 修改产物文件、MUST NOT 生成源码或 `.drawio`、MUST NOT 调用外部命令执行产物。

#### Scenario: 文件未被修改

- **WHEN** 打开产物、切换三个视图、执行过滤与刷新
- **THEN** 产物文件的 mtime 与哈希保持不变

#### Scenario: 无外部进程执行产物

- **WHEN** 打开一个可执行 ELF
- **THEN** 插件不启动该文件；调用随包 sidecar 时也只用它读取字节，不用 `dotnet`/`mono` 加载目标程序集

