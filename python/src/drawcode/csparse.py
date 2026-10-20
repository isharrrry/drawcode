"""C# 前端：扫源码产出一个 IR。

语法约定（``[Signal(...)]`` 与 ``/// <drawcode />`` 已彻底取消）：

    [Drawcode(Direction.In, Unit = "LSB", Alias = "原始采样值")]
    public static short g_raw;

    [Drawcode(Alias = "ADC 采样", Tooltip = "上电后需先校准")]
    [Device(Vendor = "TI", Model = "ADS1115", Spec = "16bit/860SPS")]
    public static short AdcRead() { ... }

方向是**第一个位置参数**（可省略），其余是命名属性。之所以做成真 attribute 而不是
注释，就是为了让编辑器能补全 ``Direction.`` 和属性名——这是选这个语法的唯一理由。
attribute 的类型定义见 ``examples/*/cs/DrawcodeAttributes.cs``（解析器不需要它，只看用法）。

**与 C 前端的两处有意不对称**（改之前先想清楚，这是设计不是遗漏）：
  1. C 侧「有 ``@drawcode`` 注解就算信号」；C# 侧必须**有方向**才算信号，
     没写 ``Direction`` 的 ``[Drawcode]`` 只当作文档，节点类型落到函数上。
  2. 节点几何键 ``xy`` 与节点 ``size`` **只有 C 侧读**。这里的 ``[Drawcode]`` 没有
     ``Size`` 属性，本文件也从不调用 ``meta.get("size")``——所以 C# 方法永远由默认
     堆叠算法定位定尺。（注意别把它和 ``[Device]`` 上的 ``Size`` 搞混，那是器件的
     物理封装尺寸，两侧都读，两个键同名但毫无关系。）
"""

import os
import re

from .cparse import _container_path, _def_use, _parse_params, _rel, _stem, _top_group
from .model import Device, Func, Model, Signal

# Direction values come from the `Direction` enum that ships with the toolchain
# (`DrawcodeAttributes.cs`). Accept both spellings of the bidirectional case.
# （双向有两种写法都接受；`None` 映射成空串 —— 空方向意味着「不是信号」。）
DIRS = {"In": "in", "Out": "out", "Io": "inout", "InOut": "inout", "None": ""}

# `[Drawcode(Direction.In, Unit = "LSB", Alias = "…")]` — direction is positional and
# optional, everything else is a named property.
# （方向是位置参数且可省略，其余是命名属性。用 re.S 以容忍跨行的 attribute。）
DRAWCODE_ATTR_RE = re.compile(r"\[\s*Drawcode\s*\((.*?)\)\s*\]", re.S)
DEVICE_ATTR_RE = re.compile(r"\[\s*Device\s*\((.*?)\)\s*\]", re.S)
DIR_ARG_RE = re.compile(r"Direction\.(\w+)")
NAMED_ARG_RE = re.compile(r'(\w+)\s*=\s*"([^"]*)"')

# 字段/方法声明前面可能出现的一堆修饰符，全部吃掉再取类型与名字。
MODIFIERS = (
    "public|private|internal|protected|static|readonly|const|volatile|"
    "virtual|override|abstract|sealed|async|extern|unsafe|new|partial"
)

# C# 类型片段与名字的字符集：首字符是任意 Unicode 字母或下划线，后续是字母、数字、
# 下划线与类型语法里常见的 `. < > , [ ] ?`。
#
# 为什么不能用 `[A-Za-z_]`：本项目的部分关系字段类型是中文结构体（`数据包`），
# ASCII 正则会让整条声明**静默地**不被当成信号 —— 图上少一个节点，而且不报任何错。
# 名字位置与类型位置必须是同一字符集：C# 编译器接受中文标识符，解析器没有理由只认
# ASCII；信号名、函数名都可能是中文，图上要显示的就是「哪个模块、传了什么」。
#
# Python 的 `re` 没有 `\p{L}`，用 `[^\W\d]` 表达「Unicode 字母或下划线」：
# Python 3 的 `\w` 默认就是 Unicode 语义，从中去掉数字（`\d`）即可。与 TS 的
# `[\p{L}_]` 等价（`\w` 里的标识符字符 = 字母 + 数字 + 下划线）。
#
# 放宽名字后，原本靠「ASCII 看不见」挡在图外的两类声明必须显式处理：
#   · `record` 类型声明与记录体里的方法 → 由 RECORD_DECL_RE 整段跳过；
#   · 支撑件里的泛型桩方法（`生成<T>()` / `处理<T>(T)`）→ 名字后跟 `<` 而不是 `(`，
#     天然不匹配 CS_FUNC_RE。
_IDENT = r"[^\W\d]\w*"
_TYPE = r"[^\W\d][\w\.<>,\[\]\?]*"

FIELD_RE = re.compile(
    r"^\s*(?:(?:%s)\s+)*(?P<ctype>%s)\s+"
    r"(?P<name>%s)\s*(?:=[^;]*)?;\s*$" % (MODIFIERS, _TYPE, _IDENT)
)

CS_FUNC_RE = re.compile(
    r"^\s*(?:(?:%s)\s+)*(?P<ret>%s)\s+"
    r"(?P<name>%s)\s*\((?P<params>[^)]*)\)\s*\{?\s*$" % (MODIFIERS, _TYPE, _IDENT)
)

# `record` 声明的开头。解析时必须**整段跳过**（与 TS 的 RECORD_DECL_RE 同义）。
#
# 名字位置放开到 Unicode 之后，`public sealed record 采样帧(...)` 与普通方法签名
# 完全同形；记录体里的 `public 帧头 下一帧()` 也会变成组件函数。数据类型文件
# （`示例数据结构.cs`）不是被测模型，整段跳过记录声明是唯一不误伤设备类里真实方法的
# 办法 —— 设备类用 `class`，不在这个正则里。
#
# 只跳过 `record`，不跳过 `class`：模型源文件本身就是 `public static class 设备名`，
# 连类一起跳会把整张图清空。
RECORD_DECL_RE = re.compile(
    r"^\s*(?:(?:public|private|internal|protected|static|sealed|abstract|readonly|partial|unsafe|new)\s+)*record\b"
)

# These lines end an annotation block without consuming it as a declaration.
# （这几类行会**清空**注解缓冲：注解必须紧贴它标注的成员，中间隔着 using/namespace
#   或裸花括号就不算数了。）
SKIP_PREFIX = ("using ", "namespace ", "#")


def _read_meta(buf):
    """把一段 ``///`` 与 ``[...]`` 混合的行解析成 (drawcode 键值, device 键值)。

    属性名统一转小写，好和 C 侧的 IR 键（unit/alias/note/…）对齐。
    """
    meta, dev = {}, {}
    for raw in buf:
        m = DRAWCODE_ATTR_RE.search(raw)
        if m:
            args = m.group(1)
            d = DIR_ARG_RE.search(args)
            if d:
                meta["dir"] = DIRS.get(d.group(1), "")
            for key, val in NAMED_ARG_RE.findall(args):
                meta[key.lower()] = val
            continue
        m = DEVICE_ATTR_RE.search(raw)
        if m:
            for key, val in NAMED_ARG_RE.findall(m.group(1)):
                dev[key.lower()] = val
    return meta, dev


def _cs_bodies(lines):
    """与 C 侧的 ``_bodies`` 同构：按花括号配平取方法体。

    同样保留 ``j - i <= 2`` 的签名到 ``{`` 间距上限——它是几何契约，三语言必须一致。
    """
    bodies = {}
    i = 0
    while i < len(lines):
        m = CS_FUNC_RE.match(lines[i].strip())
        if m:
            j = i
            while j < len(lines) and "{" not in lines[j] and j - i <= 2:
                j += 1
            if j < len(lines) and "{" in lines[j]:
                depth, chunk, k = 0, [], j
                while k < len(lines):
                    depth += lines[k].count("{") - lines[k].count("}")
                    chunk.append(lines[k])
                    if depth == 0:
                        break
                    k += 1
                bodies[m.group("name")] = "\n".join(chunk)
                i = k + 1
                continue
        i += 1
    return bodies


def parse_cs_project(paths, root=None):
    """把一批 .cs 解析成一个 Model。"""
    root = root or os.path.dirname(os.path.abspath(paths[0]))
    loaded = []
    for p in paths:
        rel = _rel(os.path.abspath(p), os.path.abspath(root))
        with open(p, encoding="utf-8") as fh:
            loaded.append((rel, fh.read().splitlines()))

    model = Model(files=[rel for rel, _ in loaded])
    raw_signals = []
    raw_funcs = {}

    for rel, lines in loaded:
        buf = []
        # 用下标循环而不是 enumerate：record 声明要连同记录体**整段**跳过，
        # 必须能移动游标（与 TS 的 `index = j; continue`、.NET 的 `idx = j` 同构）。
        index = 0
        while index < len(lines):
            raw = lines[index]
            lineno = index + 1
            s = raw.strip()
            # 注解行：`///` 文档注释或 `[...]` 特性，先攒着
            if s.startswith("///") or s.startswith("["):
                buf.append(raw)
                index += 1
                continue
            if not s:
                buf = []
                index += 1
                continue
            if s.startswith(SKIP_PREFIX) or s in ("{", "}", "};"):
                buf = []
                index += 1
                continue

            # 数据类型文件里的记录声明不是组件：连同记录体里的方法一起跳过。
            # 一行到底（`...);` 或 `... { }`）直接跳过；带多行记录体的按花括号配平。
            #
            # 注意 depth 的起点取自**记录声明这一行**：`record 数据帧(帧头 头)` 本身
            # 没有花括号，于是先向后找到第一个含 `{` 的行（记录体的开括号），再从那里
            # 开始配平。跳过结束后 index=j+1 —— 记录体的闭括号也被吃掉，记录体里的
            # 方法不会进入下面的声明识别。
            if RECORD_DECL_RE.match(s):
                buf = []
                j = index
                depth = raw.count("{") - raw.count("}")
                if "{" not in raw and not s.endswith(";"):
                    k = j + 1
                    while k < len(lines) and "{" not in lines[k]:
                        k += 1
                    if k < len(lines):
                        j = k
                        depth = lines[k].count("{") - lines[k].count("}")
                if depth > 0:
                    k = j + 1
                    while k < len(lines) and depth > 0:
                        depth += lines[k].count("{") - lines[k].count("}")
                        k += 1
                    j = k - 1
                index = j + 1
                continue

            meta, dev = _read_meta(buf)
            buf = []

            mf = FIELD_RE.match(s)
            # 与 C 侧不同：这里要求**有方向**才算信号。只写 [Drawcode(Alias="…")]
            # 的纯文档性标注不会产出信号节点。
            if mf and meta.get("dir"):
                raw_signals.append((rel, lineno, meta["dir"], mf.group("ctype"), mf.group("name"), meta))
                index += 1
                continue

            mfn = CS_FUNC_RE.match(s)
            if mfn:
                # 与 C 侧不同：这里不做 .h/.c 合并（C# 没有分离式声明），后写覆盖先写
                raw_funcs[mfn.group("name")] = {
                    "rel": rel,
                    "line": lineno,
                    "ret": mfn.group("ret"),
                    "params": _parse_params(mfn.group("params")),
                    "meta": meta,
                    "device": dev,
                }

            index += 1

    for rel, lineno, direction, ctype, name, meta in raw_signals:
        cpath = _container_path(meta, rel)
        model.add_signal(
            Signal(
                id="%s::%s" % (rel, name),
                name=name,
                ctype=ctype,
                dir=direction,
                file=rel,
                line=lineno,
                unit=meta.get("unit", ""),
                alias=meta.get("alias", ""),
                note=meta.get("note", ""),
                external=meta.get("external", "") == "true",
                group=_top_group(cpath),
                path=cpath,
            )
        )

    signals_by_name = {s.name: s.id for s in model.signals.values()}
    funcs_by_name = {}
    for name, info in raw_funcs.items():
        fid = "%s::%s" % (info["rel"], name)
        funcs_by_name[name] = fid
        meta = info["meta"]
        fpath = _container_path(meta, info["rel"])
        model.add_func(
            Func(
                id=fid,
                name=name,
                ret=info["ret"],
                params=info["params"],
                file=info["rel"],
                line=info["line"],
                alias=meta.get("alias", ""),
                note=meta.get("note", ""),
                tooltip=meta.get("tooltip", ""),
                asset=meta.get("asset", ""),
                external=meta.get("external", "") == "true",
                group=_top_group(fpath),
                path=fpath,
            )
        )
        # 注意这里只读 dev 的 size（器件封装），不读 meta 的 size（节点几何）——
        # 见模块头第 2 条不对称说明。
        dev = info["device"]
        if dev:
            model.devices[fid] = Device(
                vendor=dev.get("vendor", ""),
                model=dev.get("model", ""),
                spec=dev.get("spec", ""),
                size=dev.get("size", ""),
                asset=dev.get("asset", ""),
            )
            if not model.funcs[fid].asset:
                model.funcs[fid].asset = dev.get("asset", "")

    for rel, lines in loaded:
        for name, body in _cs_bodies(lines).items():
            if name not in funcs_by_name:
                continue
            # 复用 C 的 def/use 扫描：C# 的赋值/调用语法在这里够近似，
            # 且三语言共用同一份判定逻辑才能让边序完全一致。
            rd, wr, cl = _def_use(body, signals_by_name, funcs_by_name)
            f = model.funcs[funcs_by_name[name]]
            f.reads, f.writes, f.calls = rd, wr, cl

    model.rebuild_edges()
    return model
