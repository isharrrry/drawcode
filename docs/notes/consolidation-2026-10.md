# 仓库整合审计（2026-10-21）

本文回答「多语言实现、重复意思的测试案例、文档该留什么、改什么、删什么」。
它是**决策建议**，不是规格；标【已做】的是本轮已经落地并有测试/命令佐证的部分，
标【需批准】的删除或迁移在得到确认前不动手。

三语对照文档不复制本文：它是内部决策记录，读者只有项目维护者。

## 1. 现状测量

| | Python | TypeScript | .NET |
| :--- | ---: | ---: | ---: |
| `src` 代码行 | 4,193 | 8,108 | 6,356 |
| 测试数（本次实测） | 145 | 210（3 skip） | 120 |
| 独有能力 | 参考实现（无依赖、可直接跑） | **二进制产物读取**（PE/ELF/ar）+ VS Code 扩展 | 独立实现，用于性能对照 |

`editors/vscode` 另有 11,479 行（`src` + `media` + `test`，不含 `dist`），79 条前端单元测试，
以及一套 `test:e2e`。

## 2. 本轮发现并已修的跨语言缺陷【已做】

这三个缺陷共同说明：**三套实现是同一份契约的三次手写，任何一套缺测试，缺陷就会潜伏。**

1. **跨行 `[Drawcode(...)]`**：参数多时 IDE 会换行。Python 与 .NET 的解析只收「行首是 `[`」的行，
   第二行被当声明行 ⇒ 信号静默消失（C# 侧没方向就不算信号）；回写侧则判定「没有注解」，
   在字段上方**再插一条** `[Drawcode]`，源码编译不过。TS 早已支持，两套落后。
2. **`record` 主构造参数**：`public sealed record X(...);` 的参数表跨行、以 `);` 收尾、没有记录体。
   Python/.NET 原来「找第一个 `{` 再配平」，把后面紧邻的 `class` 整段当成记录体吞掉 ——
   `examples/small/cs/Dsp.cs` 曾整份解析不出任何节点。
3. **`return g_raw;` 被当成字段声明**：字段正则看到的是 `type=return, name=g_raw`。
   解析侧靠「必须有方向」天然挡住，**回写侧只按名字匹配**，会在方法体里插注解、写坏源码。
   三套实现同时中招，同时修复，并各加了一条同名回归测试。

修复后三套实现对 `examples/small/cs` 的产物**逐字节相同**：

```
signals=12 funcs=9 edges=25
SHA256  da5d2d89…b2f148   (.drawio，三份一致)
```

另外补了 .NET 的跨行特性/record 回归测试，并把三套测试的期望值对齐到同一份夹具。

## 3. 结构性重复（建议处理）

### 3.1 金标准夹具与 examples 的「冻结副本」【需批准】

`tests/golden/small-cs/input/` 是 `examples/small/cs/` 的**手工冻结副本**，现已漂移：
前者仍是 3 信号 / 3 函数的旧版，后者是 12 / 9 的新版。.NET 的 C# 测试只读冻结副本，
所以第 2 节的两个解析缺陷在 .NET 里长期无人发现。

两个方案，二选一：

- **A（推荐）保留副本，加一致性校验**：新增 `tools/check-fixtures.mjs`，比较
  `tests/golden/*/input` 与 `examples/*` 的 SHA256，不一致就失败。金标准的「自包含」
  性质不变（CI 不依赖 examples），漂移会立刻暴露。
- B 删掉副本，金标准直接读 `examples/`。少一份文件，但破坏自包含；一旦 examples
  为演示而改，金标准也会跟着动，conformance 的「契约钉死」意义被削弱。

### 3.2 三份手写的同一组期望值【需批准】

同一个夹具（`small-cs`）在三种语言里各写了一遍信号名、函数名、边数。今天修夹具时，
三处要分别改，漏一处就是假绿。建议：

- 新增 `tests/cases/small-cs.expected.json`：`{signals:[...], funcs:[...], edgeCount:25}`；
- 三套测试各写 5 行加载器 + 断言，删除手写清单。

收益：夹具演进只改一处；三套实现仍各自验证自己的代码。

### 3.3 文档三语对照【需批准】

`docs/` 下 8 篇正文 × 3 种语言 = 24 个文件，另有只写了一版的 `artifact-format.md`。
本轮更新测试数时，6 个文件都要改（`implementations.*` 与 `README.*`）。

建议：

- 英文为**规范版**；zh-CN 继续维护；**es 若无实际读者则删除**（省 1/3 同步成本）；
- 新增文档（如 artifact-format）先只写英文，在索引里标注「暂无中文版」，不强制三语；
- 每篇文档头部已有 `status:`，给翻译版加 `translation-of:` 与 `reviewed-at:`，明确它可能滞后。

### 3.4 生成物混入示例目录【已做】

`examples/small/c/c.drawio`、`examples/small/cs/Adc.cs.drawio` 是构建/测试的产物，
不属于示例源码，已删除。若需要长期保留，应写进 `.gitignore` 而不是提交。

## 4. 淘汰 / 保留判断

| 对象 | 建议 | 理由 |
| :--- | :--- | :--- |
| `dotnet/src` 源码管线 | **保留** | 项目定位就是「同一能力三语言」（见 `implementations.*`），删掉会推翻已公开的设计；但必须补上 examples 级测试 |
| `python/` | **保留，冻结在契约内** | 它是规范的可执行参考；新能力（产物读取）只在 TS，不要求 Python 跟进 |
| `editors/vscode` | 保留并加强 | 唯一的产品化入口；`test:e2e` 已有骨架，应覆盖导出 drawio、右键菜单 |
| `docs/*.es.md` | **候选删除** | 若无西语读者，纯维护负担 |
| `tests/golden/*/input` | 保留 + 校验 | 见 3.1 |
| `examples/plain/` | 保留 | 无元数据二进制的**手工验证样本**，产物已 gitignore，源码与 Makefile 有用 |

## 5. 文档待更新清单

- [x] `implementations.*` 测试数 144/175/119 → 145/210/120
- [x] `README.*` 的 144 → 145
- [ ] `conformance.md`：补一句「金标准 input 是冻结副本，需与 examples 校验」（若采纳 3.1A）
- [x] `artifact-format.md`：三份 `index.*` 已收录并标注「英文单语」，索引开头也改成「除标注外三语」
- [x] `editors/vscode/README.md`：补「勾选与导出」「从源码生成 Drawio 图」两节
- [ ] `benchmark.*`：三实现测试数变化后重跑一次，确认没有因夹具变大而失真

## 6. 验收命令（本文所有结论可复现）

```bash
(cd python && python -m unittest discover -q)          # 145 OK
(cd typescript && node --test)                          # 210, 3 skipped
(cd dotnet && dotnet test --nologo -v q)                # 120 passed
(cd editors/vscode && node --test test/*.test.mjs)      # 79 passed

# 三实现产物一致性（同一 SHA256）
python -m drawcode.cli build examples/small/cs/*.cs --root examples/small/cs --merge --out /tmp/py.drawio
node typescript/src/cli.ts build examples/small/cs/*.cs --root examples/small/cs --merge --out /tmp/ts.drawio
dotnet dotnet/src/DrawCode/bin/Debug/net10.0/DrawCode.dll build examples/small/cs/*.cs --root examples/small/cs --merge --out /tmp/dn.drawio
sha256sum /tmp/{py,ts,dn}.drawio
```

> 上面的命令是审计当时的记录，Python/.NET 已于同日稍后退役，现不可直接运行；历史提交里仍可复现。

## 7. 决议与执行（2026-10-21）

用户拍板方案 **C：只保留 TypeScript 实现**。判断依据（基于本文第 1 节的测量）：

- 只有 TS 具备 VS Code 扩展与 `inspect`（PE/ELF/ar 产物读取），Python/.NET 均无；
- 三条源码管线功能重合，Python 是参考实现、.NET 是独立对照，二者不承载独有产品能力；
- TS 的 `dump-ir` 与 `build` 已对 `tests/golden/` 的两个金标准**逐字节**复现，参考实现退役后契约仍被钉住。

执行口径（用户原话：「不要删git历史，删工作区即可」）：

| 动作 | 对象 | 结果 |
| :--- | :--- | :--- |
| 移出工作区 | `python/`、`dotnet/`、`bench/`、`examples/large/`、`tools/dump_ir.py`、`typescript/tools/make-fixtures.py`、`docs/benchmark.*` | 移到 `C:\Users\links\AppData\Local\Temp\drawcode-retired-20261021\`，需要时原路移回 |
| 保留 | git 索引与历史 | 未做 `git rm`，提交历史完整；`431a340` 是退役前的最后一个功能提交 |
| 代码迁移 | `python/tests/test_drawio.py::TestHandDrawnDiagram` | 等价测试迁入 `typescript/test/cli.test.ts` |
| 文档改为单实现事实 | `README*`、`docs/index*`、`docs/implementations*`、`docs/contributing*`、`docs/conformance.md`、`docs/architecture*`、`docs/annotations*`、`docs/drawio-format*`、`docs/artifact-format.md`、`examples/README.md`、`typescript/README.md`、`typescript/SKILL.md` | 已完成；西语过时页标 `status: outdated` 并指向英文版 |
| 历史性能数据 | 布局二次、解析线性的测量 | 保留在 `README.md` 的「Measured verification」并明确标为历史（Python 测） |

`docs/benchmark.*` 删除后，`README*` 中指向它的链接已全部移除；`examples/large/` 的生成脚本一并退役，
5/10/20/40/80 模块的成本表只在 README 里作为历史数据保留。

**未跟进的部分（刻意）**：源码注释中大量「对等 Python `xxx.py`」是逐函数移植的出处说明，
作为历史注记保留；它们不构成运行依赖，也不指向现存路径。

## 8. 目录边界（2026-10-21 执行）

> **已被第 9 节取代**：同日稍后用户改判 —— `tests/golden/` 移入 `tools/`，`tests/` 删除，
> 非根目录的 README 全部拆解。下表保留为当时的决策记录。

用户确认方案 A：只做零路径变更的边界说明，不改目录名。

| 目录 | 角色 | 处置 |
| :--- | :--- | :--- |
| `tests/golden/` | 跨实现的契约夹具（无测试代码） | 留在根；新增 `tests/README.md` 说明 |
| `typescript/test/` | 实现测试代码 | 不动 |
| `typescript/tools/` | `make-fixtures.py` 退役后的空壳 | 删除（git 不跟踪空目录） |
| `tools/drawcode-metadata/` | .NET 8 sidecar，VSIX 打包引用 | 留根；新增 `tools/README.md` 说明 |
| `tools/xsd/`、`tools/render/` | L4 契约、离线渲染工具 | 留 |
| `typescript/README.md` | 与 `docs/implementations*` 重叠 | 收缩为包级入口；独有内容迁入 docs |

未采纳方案 B（`tests/` → `spec/`）：48 处文档引用、`CASES_DIR` 与 `.gitignore` 的改名成本，
与当前单实现规模不相称。若将来出现第二实现，再考虑。

## 9. 目录再收敛与 README 拆解（2026-10-21 晚，取代第 8 节）

用户原话：「golden/ 挪 tools吧，空目录删了，我就是不想要那么多readme……这些readme除了根目录的
全拆到合适的地方」。执行口径不变：只删工作区，不回写 git 历史。

### 9.1 金标准移位

| 动作 | 对象 | 连带改动 |
| :--- | :--- | :--- |
| 移动 | `tests/golden/` → `tools/golden/` | `typescript/test/helpers.ts` 的 `CASES_DIR`；`.gitignore` 两条 C# fixture 产物路径 |
| 删除 | 空目录 `tests/` | 无代码引用（测试代码一直在 `typescript/test/`） |
| 留根 | `tools/drawcode-metadata/`、`tools/xsd/`、`tools/render/`、`tools/publish-metadata-tool.mjs` | 见 9.3 的定位说明 |

`small-cs/obj/` 被 MSBuild 占用无法移动，作为可重建的中间产物删除（`dotnet build tools/golden/small-cs` 恢复）；
`bin/`（含验收用 `small-cs.dll`）随目录移走。

### 9.2 README 处置：根目录之外清零

| 原文件 | 去处 |
| :--- | :--- |
| `tests/README.md`、`tools/README.md` | 删除；内容并入 `docs/contributing.md` 的仓库地图与 `tools/` 定位段 |
| `typescript/README.md` | 删除；内容与 `docs/implementations*` 重叠，`typescript/package.json` 的 `files` 去掉该项 |
| `examples/README.md`、`examples/medium/README.md`、`examples/plain/README.md` | 合并为 `docs/examples.md` |
| `templates/README.md`、`templates/c/README.md`、`templates/csharp/README.md` | 合并为 `docs/templates.md`（中文；稳定锚点 `#c-template-elf` / `#c-template-net`，两个头文件里加了指向它的注释） |
| `tools/render/README.md` | 用法并入 `docs/contributing.md` §Offline rendering；五个失败记录本就在 `docs/notes/drawio-render-pitfalls.md` |
| `tools/xsd/README.md` | 改名 `tools/xsd/NOTICE.md`（它是第三方素材出处声明，不是使用说明）；顺带修正失效的 `python/tests/test_xsd.py` 路径 |
| `editors/vscode/README.md` | 迁为 `docs/vscode-extension.md`；`package-vsix.mjs` 改读该页，去掉 frontmatter、文档索引行与「相关」小节后写成 VSIX 内的 `extension/README.md` |

根目录三份 README（`README.md`、`README.zh-CN.md`、`README.es.md`）不动，链接改指上述 docs 页。

### 9.3 `tools/` 的定位

`tools/` 是**仓库资产，不是随包发布的产物**：不进 npm 包、不进运行时依赖图、不在测试发现路径上。
两个例外随产品走 —— `drawcode-metadata` 被打进 VSIX，`golden/` 被测试套件读取。
这句话写进了 `docs/contributing*.md` 的仓库地图，作为今后新增 `tools/` 子目录的判据。
