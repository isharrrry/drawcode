"""把「用户在 draw.io 里新加的元素」接回 IR。

``sync`` 的方向本来是 **源码 -> 图**，所以图里多出来的东西会被三层静默丢掉：

  1. ``read_layout`` 只收带 ``symbolId`` 的 ``<object>``；
  2. ``apply_layout`` 对不认识的 id 直接 ``continue``；
  3. ``sync`` 遍历的是**源码文件列表**，不是图里的节点。

于是「我在 draw.io 里加了个方块」不会报错、也不会生成任何代码 —— 元素凭空消失。

本模块补上反向那一步：把图里多出来的顶点变成新的 ``Signal`` / ``Func``，
剩下的交给 ``codegen`` 既有的 missing 分支写回源码。要决的东西（哪一类、叫什么）
按下面的规则定，定不下来的**一律回报**，绝不猜。
"""

import os
import re

from .model import Func, Param, Signal

# `int16_t g_new` / `void fir_apply(void)` / `g_plain`
_DECL_RE = re.compile(
    r"^\s*(?:(?P<ctype>[A-Za-z_][\w\s\*]*?)\s+)?(?P<name>[A-Za-z_]\w*)\s*"
    r"(?:\((?P<params>[^)]*)\))?\s*$"
)

# 我们生成的信号用的是五边形（shape=path）或椭圆；函数用默认矩形。
# 用户照着现有节点画，就能被认出来。
#
# 注意 `ellipse` 必须写成**裸词**：draw.io 自己的椭圆 style 就是 `ellipse;`，
# 只有 drawcode 生成时才会写成 `shape=ellipse`。只认后者的话，用户在工具栏上
# 随手画的椭圆会被判成函数、写进 .c —— 而且不报错。
_SIGNAL_MARKERS = ("shape=path", "shape=ellipse", "ellipse")


def classify(style):
    """按形状判断新元素是变量还是函数。"""
    return "signal" if any(m in (style or "") for m in _SIGNAL_MARKERS) else "func"


def direction(style):
    """从五边形的朝向推断方向；认不出返回空串，交给调用方决定。"""
    if "direction=east" in (style or ""):
        return "in"
    if "direction=west" in (style or ""):
        return "out"
    return ""


def parse_label(label):
    """把节点文字当成一行声明来解析。

    返回 ``(ctype, name, params)``：``params is None`` 表示这不是函数写法。
    ``int16_t g_new`` -> ``("int16_t", "g_new", None)``
    ``void fir(void)`` -> ``("void", "fir", "")``
    ``g_plain``        -> ``("", "g_plain", None)``
    """
    m = _DECL_RE.match(label or "")
    if not m:
        return "", "", None
    return (m.group("ctype") or "").strip(), m.group("name"), m.group("params")


def _group_files(model):
    """group 名 -> 该组的源文件集合。

    一个组通常横跨两个文件（``adc.h`` 声明 + ``adc.c`` 实现），所以这里是**集合**
    而不是单值：信号属于 ``.h``、函数实现属于 ``.c``，落点按类型再挑一次。
    早先写成单值映射时，`setdefault` 会先命中函数、把整组都指到 ``.c``，
    结果新信号被写进头文件之外的地方 —— 那是错的。
    """
    out = {}
    for coll in (model.signals, model.funcs):
        for e in coll.values():
            if getattr(e, "group", "") and getattr(e, "file", ""):
                out.setdefault(e.group, set()).add(e.file)
    return out


def _pick_file(candidates, prefer, root=None):
    """挑落点：优先 prefer 后缀。

    C 侧的组通常只在 IR 里登记了头文件（函数节点归属到它声明所在的 ``.h``），
    所以函数实现要找**同名** ``.c``：``dsp.h`` -> ``dsp.c``。找不到才退回 ``.h``，
    否则函数体会被写进头文件里。
    """
    for f in sorted(candidates):
        if f.endswith(prefer):
            return f
    if prefer == ".c":
        for f in sorted(candidates):
            if f.endswith(".h"):
                sibling = f[:-2] + ".c"
                if root is None or os.path.exists(os.path.join(root, sibling)):
                    return sibling
    for f in sorted(candidates):
        if f.endswith(".h") or f.endswith(".cs"):
            return f
    return sorted(candidates)[0]


def _entities(model):
    return list(model.signals.values()) + list(model.funcs.values())


def adopt_foreign(model, layout, root=None):
    """把 ``layout["foreign"]`` 里的元素接进 model。

    ``root`` 是源码根目录，用来判断 ``xxx.h`` 的同名 ``xxx.c`` 是否存在
    （函数实现该落到那里）。省略时只按 IR 里登记的文件落点。

    返回 ``(added, problems)``：

      ``added``    —— 接进来的新 id 列表，供调用方报告；
      ``problems`` —— 没能自动决定的，每条是一句话。**这些不会被猜**，
                      也不会被写进源码，只是如实告诉用户。
    """
    added, problems = [], []
    group_file = _group_files(model)
    seq = {"signal": 0, "func": 0}

    for cell in layout.get("foreign", []):
        kind = classify(cell["style"])
        label = cell["label"]
        ctype, name, params = parse_label(label)
        is_func = params is not None or kind == "func"
        kind = "func" if is_func else "signal"

        where = cell["cell_id"]
        if label:
            where = "%s (%s)" % (cell["cell_id"], label)

        group = cell["container"]
        if not group:
            problems.append(
                "%s: 不在任何容器里，无法判断该写进哪个源文件 —— 把它拖进某个模块容器后重试" % where
            )
            continue
        target_files = group_file.get(group)
        if not target_files:
            problems.append(
                "%s: 容器 %r 不对应任何已知源文件，无法落盘" % (where, group)
            )
            continue
        if is_func:
            target = _pick_file(target_files, ".c", root)
        else:
            target = _pick_file(target_files, ".h", root)

        if not name:
            seq[kind] += 1
            name = "%s_%d" % ("new_func" if kind == "func" else "new_signal", seq[kind])
            problems.append("%s: 节点没有文字，按序号命名为 %s" % (where, name))

        new_id = "%s::%s" % (target, name)
        if new_id in model.signals or new_id in model.funcs:
            problems.append("%s: %s 已存在，跳过" % (where, new_id))
            continue

        d = direction(cell["style"])
        if kind == "signal":
            if not ctype:
                problems.append(
                    "%s: 认不出类型，先按空类型生成 —— 请在源码里补上（例如 int16_t）" % where
                )
            elif not d:
                problems.append("%s: 认不出方向（节点形状没有朝向），先按 in 生成" % where)
            model.signals[new_id] = Signal(
                id=new_id, name=name, ctype=ctype, dir=d or "in",
                file=target, group=group,
                x=cell["x"], y=cell["y"], w=cell["w"], h=cell["h"],
            )
        else:
            plist = []
            for raw in (params or "").split(","):
                raw = raw.strip()
                if not raw or raw == "void":
                    continue
                ptype, pname, _ = parse_label(raw)
                if pname:
                    plist.append(Param(name=pname, ctype=ptype))
            model.funcs[new_id] = Func(
                id=new_id, name=name, ret=ctype or "void", params=plist,
                file=target, group=group,
            )
        added.append(new_id)

    return added, problems
