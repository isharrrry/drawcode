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

**与 C 前端的一处有意不对称**（改之前先想清楚，这是设计不是遗漏）：
  C 侧「有 ``@drawcode`` 注解就算信号」；C# 侧必须**有方向**才算信号，
  没写 ``Direction`` 的 ``[Drawcode]`` 只当作文档，节点类型落到函数上。

**几何与样式**：``Xy``（``"x,y"``）、``Size``（``"宽x高"``）、``Style``（原样追加
到节点样式串末尾）在 C 与 C# 两个前端、信号与函数两类实体上都读 —— 与 TS 实现
一致。容差见 ``cparse._apply_geometry``：缺键不动默认值、畸形得 NaN、不报错。
别把这里的 ``Size`` 和 ``[Device]`` 上的 ``Size`` 搞混：后者是器件物理封装尺寸，
同名但毫无关系，各在自己的命名空间里。

``[Callout("文本", Xy="…", Size="…", Style="text|box|band", Font=12)]`` 是**独立的
注释层**：一个声明可以挂多块说明文字，它们不参与连线、不进容器包围盒。
"""

import os
import re

from .cparse import (
    _apply_geometry, _container_path, _def_use, _js_number, _parse_params, _rel,
    _split_numbers, _stem, _top_group,
)
from .model import Callout, Device, Func, Model, Signal

# Direction values come from the `Direction` enum that ships with the toolchain
# (`DrawcodeAttributes.cs`). Accept both spellings of the bidirectional case.
# （双向有两种写法都接受；`None` 映射成空串 —— 空方向意味着「不是信号」。）
DIRS = {"In": "in", "Out": "out", "Io": "inout", "InOut": "inout", "None": ""}

# `[Drawcode(Direction.In, Unit = "LSB", Alias = "…")]` — direction is positional and
# optional, everything else is a named property.
#
# 三种特性共用一个正则，与 TS 的 ATTR_RE 同形：贪婪的 `(.*)`、不跨行。
# 跨行属性（`re.S`）在旧版里被容忍，但 TS/.NET 都按行解析；三版对同一输入的
# 判定必须一致，所以这里也回到逐行语义。
ATTR_RE = re.compile(r"\[\s*(Drawcode|Device|Callout)\s*\((.*)\)\s*\]")
DIR_ARG_RE = re.compile(r"Direction\.(\w+)")
# 命名参数：带引号值与裸词都认（`Style = "box"` 与 `External = true` 两种写法）。
# 旧版只认带引号的值，导致 `Style=box` 被静默丢弃、文字块退回默认种类。
ARG_RE = re.compile(r'(\w+)\s*=\s*(?:"([^"]*)"|(\w+))')

# `[Drawcode]` 认的键。与 C 侧的「全收」不同：C# 是真 attribute，键名由
# DrawcodeAttributes.cs 定义，未知键本来就不该出现。Xy/Size/Style 与 C 侧同名。
META_KEY = {
    "unit", "alias", "note", "tooltip", "external", "asset", "path",
    "xy", "size", "style",
}

# `[Callout]` 的键**刻意与 META_KEY 分开**：`Style` 在 `[Drawcode]` 上是
# 「追加到节点样式」，在 `[Callout]` 上是「文字块种类」，同名不同义。
CALLOUT_KEY = {"xy", "size", "style", "font"}
CALLOUT_SHAPES = {"text", "box", "band"}
# 文本必须是第一个位置参数、用双引号括起（内部不能有双引号）。
CALLOUT_TEXT_RE = re.compile(r'^"([^"]*)"\s*(?:,\s*(.*))?$', re.S)

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


def _parse_args(body):
    """``Key = "value"`` / ``Key = bare`` → ``[(小写键, 值)]``，按出现顺序。

    带引号时可含空格与逗号（``Xy = "40,40"`` 不会再被切开，因为这里不切逗号，
    只逐段找键值对）；裸词只收 ``\\w+``，与 TS 的 ``ARG_RE`` 逐字一致。
    """
    out = []
    for m in ARG_RE.finditer(body):
        quoted, bare = m.group(2), m.group(3)
        out.append((m.group(1).lower(), quoted if quoted is not None else (bare or "")))
    return out


def _parse_callout(body):
    """``[Callout("文本", ...)]`` → 原始形态（还没挂到宿主实体上）。

    默认值与 TS 的 parseCallout 逐字相同：``240x40`` 的文字块、无边框、字号 0
    （= 用种类默认值）。认不出的 ``Style`` 退回 ``text``，而不是把原始串当样式用
    —— 后者会静默产出非法样式。``Font`` 走 ``Number(v) || 0``：畸形与 0 都归 0。
    """
    out = {"text": "", "shape": "text", "font_size": 0.0, "x": 0.0, "y": 0.0, "w": 240.0, "h": 40.0}
    tm = CALLOUT_TEXT_RE.match(body.strip())
    rest = body if tm is None else (tm.group(2) or "")
    if tm is not None:
        out["text"] = tm.group(1)
    for key, val in _parse_args(rest):
        if key not in CALLOUT_KEY:
            continue
        if key == "style":
            out["shape"] = val if val in CALLOUT_SHAPES else "text"
        elif key == "font":
            n = _js_number(val)
            # JS 的 `Number(v) || 0`：NaN 与 0 都落 0，Infinity 保留。
            out["font_size"] = 0.0 if n != n else n
        else:
            parts = _split_numbers(val, ",") if key == "xy" else _split_numbers(val.lower(), "x")
            if key == "xy":
                out["x"] = parts[0] if len(parts) > 0 else float("nan")
                out["y"] = parts[1] if len(parts) > 1 else float("nan")
            else:
                out["w"] = parts[0] if len(parts) > 0 else float("nan")
                out["h"] = parts[1] if len(parts) > 1 else float("nan")
    return out


def _read_meta(buf):
    """一段相邻特性行 → ``(drawcode 键值, device 键值, [Callout…])``。

    属性名统一转小写，好和 C 侧的 IR 键（unit/alias/note/…）对齐。方向仍放在
    ``meta["dir"]``（C 侧同一套 IR 键）；Callout 用**列表**而不是塞进 meta：一个
    声明挂两块文字是正常需求，塞进 dict 会被后一条静默覆盖。
    """
    meta, dev, callouts = {}, {}, []
    for raw in buf:
        m = ATTR_RE.search(raw)
        if not m:
            continue
        kind = m.group(1)
        args = m.group(2)
        if kind == "Callout":
            callouts.append(_parse_callout(args))
            continue
        if kind == "Device":
            for key, val in _parse_args(args):
                dev[key] = val
            continue
        d = DIR_ARG_RE.search(args)
        if d:
            meta["dir"] = DIRS.get(d.group(1), "")
        for key, val in _parse_args(args):
            if key in META_KEY:
                meta[key] = val
    return meta, dev, callouts


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

            meta, dev, callouts = _read_meta(buf)
            buf = []

            mf = FIELD_RE.match(s)
            # 与 C 侧不同：这里要求**有方向**才算信号。只写 [Drawcode(Alias="…")]
            # 的纯文档性标注不会产出信号节点。
            if mf and meta.get("dir"):
                raw_signals.append((
                    rel, lineno, meta["dir"], mf.group("ctype"), mf.group("name"), meta, callouts,
                ))
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
                    "callouts": callouts,
                }

            index += 1

    def _attach_callouts(owner, raws):
        """把一条声明上的文字块挂进模型。

        坐标是**画布绝对坐标** —— 文字块不属于任何容器（见 model.Callout），
        所以这里不做任何容器偏移。id 形如 ``owner#callout1``，从 1 开始。
        """
        for i, raw in enumerate(raws):
            model.add_callout(Callout(
                id="%s#callout%d" % (owner, i + 1),
                text=raw["text"],
                owner=owner,
                shape=raw["shape"],
                font_size=raw["font_size"],
                x=raw["x"],
                y=raw["y"],
                w=raw["w"],
                h=raw["h"],
            ))

    for rel, lineno, direction, ctype, name, meta, callouts in raw_signals:
        sid = "%s::%s" % (rel, name)
        cpath = _container_path(meta, rel)
        signal = Signal(
            id=sid,
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
            style=meta.get("style", ""),
        )
        _apply_geometry(signal, meta)
        model.add_signal(signal)
        _attach_callouts(sid, callouts)

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
                style=meta.get("style", ""),
            )
        )
        # 节点几何：Xy / Size（与信号共用 _apply_geometry）。
        # 下面的 dev["size"] 是器件封装尺寸，同名但无关，别合并。
        _apply_geometry(model.funcs[fid], meta)
        _attach_callouts(fid, info["callouts"])
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
