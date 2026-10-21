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
