# C 元数据模板

把两件事复制进你的 C 工程，编译产物（`.o` / `.a` / `.so` / `.out`）就能被
`drawcode inspect` 与 VS Code 插件直接读取：

| 文件 | 作用 | 链接次数 |
| :--- | :--- | :--- |
| `DrawcodeMeta.h` | 记录结构、宏、编译期布局断言 | 每个翻译单元 include |
| `DrawcodeMeta.c` | anchor 记录与段边界访问器 | **整个二进制只编译一次** |

模板只写声明层：不注册回调、不初始化运行时、不引用目标变量地址。
读取器按 200 字节定长切片，因此 `.o` 未链接时也能读，`strip` 也不影响。

## 接入

1. 复制 `DrawcodeMeta.h`、`DrawcodeMeta.c` 到工程（例如 `third_party/drawcode/`）。
2. 给每个模块定义名字。构建系统注入或源文件顶部写：

   ```c
   #define DC_META_MODULE "motor"
   #include "DrawcodeMeta.h"
   ```

   名字会进稳定 id（`<文件>::<模块>.<符号>`），不要用构建机绝对路径。
3. 编译 `DrawcodeMeta.c` 一次。它提供 anchor（版本 + 模块名）和
   `dc_meta_begin/end`；重复链接会得到重复的 `dc_meta_anchor`。
4. 在声明处写宏（每条宏都必须带分号）：

   ```c
   typedef struct DcState { double voltage; int32_t count; } DcState;

   DcState g_state;
   double  g_out;

   DC_SIGNAL(g_out,   "telemetry,direction=in,unit=V,init=0", "double");
   DC_SIGNAL(g_state, "store,direction=inout,path=state",     "DcState");
   DC_FIELD(DcState, voltage, "rmem,unit=V,init=0,alias=电压");
   DC_FIELD(DcState, count,   "rmem,init=0");
   DC_FUNCTION_AS(producer, "void", "alias=Produce,note=产生遥测");
   DC_PARAM(producer, 0, step, "uint32", "direction=in,unit=ms");
   DC_FUNCTION_AS(consumer, "void", "");
   DC_WRITE(producer, g_out);
   DC_READ(consumer,  g_out);
   DC_CALL(consumer,  producer);
   DC_MODULE_ROOT();               // 可选：树默认只列根模块
   ```

   常用的结构化属性都写在 tag 里（与 C# 的 `[Drawcode(...)]` 同义）：

   | tag | 模型字段 | 说明 |
   | :--- | :--- | :--- |
   | `direction=in\|out\|inout` | `Signal.dir` / `Param.dir` | 不写就是未知，读取器不会猜 |
   | `alias=` / `unit=` / `note=` | 同名展示字段 | 仅用于展示 |
   | `init=` | `Signal.initial` / `TypeField.initial` | 初值 |
   | `path=a/b` | `Signal.path` / `Func.path` | 显示分组 |
   | `store` | `Type.store`；信号上保留为标签 | 持久化（ER 视图） |
   | `exclude` | `exclude` | 默认隐藏 |
   | `kind=enum\|struct\|...`、`size=` | `Type.kind` / `Type.size` | 仅 `DC_TYPE` |

   `DC_FUNCTION_AS` 与 `DC_FUNCTION` 二选一：前者把返回类型写进 `type` 列，
   后者保持空串（未知）。`DC_PARAM` 的第三个参数是参数名，第四个是类型串，
   第五个是 tag；序号（第二个参数）决定参数顺序。参数 tag 目前消费
   `direction`、`alias`、`unit` 三项，其余属性会被忽略。枚举成员用
   `DC_ENUM_MEMBER` 登记，必须写在枚举定义之后。

5. 编译后用 `drawcode inspect build/app.out` 查看模型；插件打开同一文件即可得到树视图。

`DC_FIELD` 用 `_Generic` 推断基本类型；成员是自定义结构体时用
`DC_FIELD_AS(Owner, member, "TypeName", "tags")` 显式给类型串。

## 段保留（最容易踩的坑）

`__attribute__((used))` 只阻止**编译器**删掉静态变量，**不阻止链接器**。
`-Wl,--gc-sections` 下，如果 `dc_meta_begin/end` 没有被任何存活代码引用，整段会被回收。

模板的应对：

- **GCC 11+ / Clang 13+（ELF 目标）**：自动使用 `__attribute__((retain))`，
  每条记录都带 SHF_GNU_RETAIN，整段保留。无需额外配置。
- **更旧的工具链**：在链接脚本里加一行：

  ```ld
  .dc_meta : {
      KEEP(*(dc_meta_entries))
  }
  ```

  或让启动代码调用一次 `dc_meta_begin()`（例如自检函数），使引用链存活。

本机 GCC 10.3 实测：`.so` 加 `--gc-sections` 仍保留（导出符号让访问器存活），
但 `.out` 会整段丢失，读取器报 `no-metadata`。不要用「`.so` 没事」推断可执行文件也没事。

## 其他构建选项

| 选项 | 结果 |
| :--- | :--- |
| `-O0` / `-O2` | 记录数与字段顺序一致；模板记录是编译期常量 |
| `strip --strip-all` | 段与记录不受影响（不依赖符号表） |
| `--gc-sections` | 见上一节；GCC 11+ 用 `retain`，旧工具链用 `KEEP` |
| `-flto` | **不支持**。LTO 会重排/合并段，第一版不处理；请对含元数据的翻译单元关闭 LTO，或链接后验证段仍存在 |
| MSVC | 不支持。`section` 与 `__start_/__stop_` 语义不同，第一版只覆盖 GCC/Clang + ELF |

## 限制

- 字段是定长数组：`name` 48、`tag` 48、`kind` 16、`owner` 32、`type` 40。
  超长会在编译期报错，不会静默截断。注意 `tag` 的 48 字节含结尾 NUL，
  UTF-8 下一个汉字占 3 字节 —— 一条 tag 大约只放得下 3~4 个中文属性值，
  写不下时优先保 `direction`/`unit`/`init` 这类调试要用的。
- `DC_ENUM_MEMBER` 把成员值编码在 `offset` 列（uint32），示例使用非负值。
- `order` 用 `__COUNTER__` 记录声明顺序。GCC/Clang 逆序往段里追加对象，
  没有它就得到倒序的字段表。
- 宏只记录**你写下的**读写与调用；不会从机器码推断。漏写就是漏边，
  `inspect` 会给出 `dangling-read` / `dangling-write` 诊断。
- 函数名以字符串传入，编译器不会校验它是否真的存在。

## 示例

`example/` 是最小可编译工程，覆盖四个目标：

```bash
cd templates/c/example
make CC=gcc AR=ar          # app.o / libapp.a / libapp.so / app.out
drawcode inspect app.out
```

Windows 上没有常规 `cc` 时，可用本机的 Linux 交叉工具链：

```bash
export PATH="<toolchain>/bin:\
<toolchain>/usr/x86_64-unknown-linux-gnu/bin:$PATH"
make -B CC=x86_64-unknown-linux-gnu-gcc AR=x86_64-unknown-linux-gnu-ar all
```

产物被 `.gitignore` 忽略，`make -B` 可随时重建。
