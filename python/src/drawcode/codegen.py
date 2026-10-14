"""回写：把 IR 写回源码的**声明层**。

这是 sync 方向的最后一环，也是全项目里唯一会**修改用户源文件**的模块，所以规则很严：

    只动「注解 + 声明」这几行，实现体（函数花括号里的一切）永远不碰。

换来的能力是：在 draw.io 里改一个信号的 alias/unit，``drawcode sync`` 能把改动落到
代码里；而代码里的业务逻辑完全不受影响。

两条语言各自的落点：
    C  声明在 .h 里，注解是 ``/// @drawcode …`` 注释行
    C# 声明在 .cs 里，注解是 ``[Drawcode(...)]`` 特性行

所有写回都**幂等**：重写一遍内容不变则直接返回 False 且不落盘（见各函数的
``if new_lines == lines: return False``）。幂等是硬要求——否则每次 sync 都会产生
一个无意义的 diff，用户没法判断哪次是真改动。
"""

import re

from .cparse import FUNC_RE, KV_RE, SIGNAL_RE

CTYPE_RE = re.compile(r"^(?P<base>.+?)(?P<arr>\[[^\]]*\])?$")
NAME_RE = re.compile(r"^([A-Za-z_]\w*)")


def split_ctype(ctype):
    """把 `float[32]` 拆成 (`float`, `[32]`)；无数组则 arr 为空串。"""
    m = CTYPE_RE.match(ctype.strip())
    return m.group("base").strip(), (m.group("arr") or "")


def _kv_text(pairs):
    """`dir=in` is a bare enum value; every other key is a quoted string.

    （`dir` 是裸值、其余键带引号——写回时必须与解析端 KV_RE 支持的两种形态一致，
      否则自己写的注解自己读不回来。）
    """
    return " ".join(('%s=%s' % (k, v)) if k == "dir" else ('%s="%s"' % (k, v)) for k, v in pairs)


def render_annotation(sig):
    """渲染一个信号的 ``/// @drawcode`` 行；没有可写内容时返回空串。"""
    kv = []
    if sig.dir:
        # IR 用 inout，写回 C 时用更短的 io
        kv.append(("dir", {"inout": "io"}.get(sig.dir, sig.dir)))
    if sig.unit:
        kv.append(("unit", sig.unit))
    if sig.alias:
        kv.append(("alias", sig.alias))
    if sig.note:
        kv.append(("note", sig.note))
    if sig.external:
        kv.append(("external", "true"))
    if not kv:
        return ""
    return "/// @drawcode " + _kv_text(kv)


def render_signal(sig):
    """渲染「注解行 + 声明行」。无注解时只输出声明行（不留空注释）。"""
    base, arr = split_ctype(sig.ctype)
    line = "%s %s%s;" % (base, sig.name, arr)
    ann = render_annotation(sig)
    return ann + "\n" + line if ann else line


def render_func_kv(func):
    kv = []
    if func.alias:
        kv.append(("alias", func.alias))
    if func.tooltip:
        kv.append(("tooltip", func.tooltip))
    if func.note:
        kv.append(("note", func.note))
    if func.external:
        kv.append(("external", "true"))
    return kv


def render_device_kv(dev):
    if dev is None:
        return []
    pairs = [
        ("vendor", dev.vendor),
        ("model", dev.model),
        ("spec", dev.spec),
        ("size", dev.size),
        ("asset", dev.asset),
    ]
    return [(k, v) for k, v in pairs if v]


def _merge_annotation(orig_line, kv_new):
    """保留原行里 drawcode 未管理的属性（如手写的 xy/size），并保持原有顺序。

    做法是「以原行为骨架，遇到托管键就换成新值，原行没有的托管键再追加」。
    这样用户在注解里手写的 ``xy="420,160"`` 不会被 sync 冲掉——**这条很重要**，
    否则每次 sync 都会把人工排版坐标抹掉，而坐标恰恰是用户最不想丢的东西。
    """
    newd = dict(kv_new)
    out, used = [], set()
    for k, v, bare in KV_RE.findall(orig_line):
        val = v or bare
        if k in newd:
            out.append((k, newd[k]))
            used.add(k)
        else:
            out.append((k, val))
    for k, v in kv_new:
        if k not in used:
            out.append((k, v))
    return "/// @drawcode " + _kv_text(out)


def _func_block(func, dev, orig):
    """渲染一个函数的声明层：@drawcode 行、@device 行，然后是原有的非注解行。

    原块里的 ``///`` 普通文档注释会被**保留**（只剔除 @drawcode/@device 两行），
    这样用户写的函数说明不会因为一次 sync 就消失。
    """
    kv = render_func_kv(func)
    dev_kv = render_device_kv(dev)
    orig_annotation = next((l for l in orig if l.lstrip().startswith("/// @drawcode")), None)
    out = []
    if kv or orig_annotation:
        out.append(_merge_annotation(orig_annotation, kv) if orig_annotation else ("/// @drawcode " + _kv_text(kv)))
    if dev_kv:
        out.append("/// @device " + " ".join('%s="%s"' % p for p in dev_kv))
    out.extend(l for l in orig if not l.lstrip().startswith(("/// @drawcode", "/// @device")))
    return out


def sync_functions(path, model, rel):
    """回写函数上的注解。返回是否真的改了文件。"""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    lines = text.splitlines()
    funcs = {f.name: f for f in model.funcs.values() if f.file == rel}
    if not funcs:
        return False

    # 定位每个函数的「注解块起点 -> 签名行」区间：从签名往上吃掉连续的 /// 行
    spans = []
    for i, line in enumerate(lines):
        m = FUNC_RE.match(line.strip())
        if not m or m.group("name") not in funcs:
            continue
        j = i - 1
        while j >= 0 and lines[j].strip().startswith("///"):
            j -= 1
        spans.append((j + 1, i, m.group("name")))

    new_lines = list(lines)
    # 从后往前替换，这样前面的区间下标不会被改动而失效
    for start, end, name in reversed(spans):
        f = funcs[name]
        block = new_lines[start:end]
        rendered = _func_block(f, model.devices.get(f.id), block)
        if block != rendered:
            new_lines[start:end] = rendered

    if new_lines == lines:
        return False
    result = "\n".join(new_lines)
    if text.endswith("\n"):
        result += "\n"
    # newline="" 保证不把 \n 翻成 \r\n，往返哈希才稳定
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(result)
    return True


def _signal_name(raw):
    m = NAME_RE.match(raw.strip())
    return m.group(1) if m else raw.strip()


def sync_source(path, model, rel):
    """按语言分派回写；C 与 C# 的声明语法不同，绝不能互相套用。"""
    if path.lower().endswith(".cs"):
        return sync_cs_source(path, model, rel)
    touched = sync_header(path, model, rel)
    # 两个都要跑，且用 or 合并结果：信号写在 .h、函数注解写在 .h 与 .c 都可能
    return sync_functions(path, model, rel) or touched


CS_DIR = {"in": "In", "out": "Out", "inout": "Io"}
CS_ATTR_RE = re.compile(r"^\s*\[\s*Drawcode\s*\(")
CS_DEVICE_ATTR_RE = re.compile(r"^\s*\[\s*Device\s*\(")
CS_FIELD_LINE_RE = re.compile(
    r"^\s*(?:(?:public|private|internal|protected|static|readonly|const|volatile)\s+)*"
    r"(?P<ctype>[A-Za-z_][\w\.<>,\[\]\?]*)\s+(?P<name>[A-Za-z_]\w*)\s*(?P<init>=[^;]*)?;\s*$"
)
CS_PROP_MAP = {"unit": "Unit", "alias": "Alias", "note": "Note", "external": "External"}
# C# declares arrays as `T[]`, not `T[N]`; a model signal may still carry the C spelling.
# （C# 数组是 `T[]` 而不是 `T[N]`；IR 里可能还留着 C 的写法，追加声明时要转过来，
#   否则会生成 `public static float[16] x;` 这种编译不过的代码。）
CS_ARRAY_RE = re.compile(r"\[[^\]]*\]")


def render_cs_drawcode(sig):
    """One `[Drawcode(...)]` line: direction positional, metadata as named properties.

    （方向是位置参数、其余是命名属性。属性名用 PascalCase，与 DrawcodeAttributes.cs
      里定义的属性一一对应——名字对不上编辑器就补全不出来，这个语法的价值也就没了。）
    """
    parts = []
    if sig.dir:
        parts.append("Direction.%s" % CS_DIR.get(sig.dir, "None"))
    kv = []
    if sig.unit:
        kv.append(("unit", sig.unit))
    if sig.alias:
        kv.append(("alias", sig.alias))
    if sig.note:
        kv.append(("note", sig.note))
    if sig.external:
        kv.append(("external", "true"))
    parts.extend('%s = "%s"' % (CS_PROP_MAP[k], v) for k, v in kv)
    if not parts:
        return []
    return ["[Drawcode(%s)]" % ", ".join(parts)]


def sync_cs_source(path, model, rel):
    """回写 C# 声明层：每个声明上方一行 `[Drawcode(...)]`。"""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    lines = text.splitlines()
    wanted = {s.name: s for s in model.signals.values() if s.file == rel}

    # 定位每个已有字段的替换区间：从字段行往上吃掉既有的 [Drawcode]/[Device] 特性和 /// 注释
    spans = []
    for i, line in enumerate(lines):
        m = CS_FIELD_LINE_RE.match(line)
        if not m or m.group("name") not in wanted:
            continue
        head = i
        while head > 0 and (
            CS_ATTR_RE.match(lines[head - 1]) or CS_DEVICE_ATTR_RE.match(lines[head - 1])
        ):
            head -= 1
        j = head - 1
        while j >= 0 and lines[j].strip().startswith("///"):
            j -= 1
        # replace [start, i): the doc comments, any existing attributes, and the field
        spans.append((j + 1, i, m.group("name")))

    new_lines = list(lines)
    for start, field_idx, name in reversed(spans):
        sig = wanted[name]
        block = lines[start:field_idx]
        # 缩进沿用本字段原来的那一份，而不是写死 8 空格
        ref = block[0] if block else lines[field_idx]
        indent = ref[: len(ref) - len(ref.lstrip())]
        # keep any `[Device(...)]` attribute in place; it is not drawcode's to rewrite
        # （[Device] 不归 signal 管，原样留在原位）
        kept = [l for l in block if CS_DEVICE_ATTR_RE.match(l)]
        rendered = [indent + l for l in render_cs_drawcode(sig)] + kept
        if block != rendered:
            new_lines[start:field_idx] = rendered

    # 追加分支：模型里有、但文件里还没写的信号。
    # 缺了这一段，sync 就只能改已有字段、无法新增——曾经因此有一个测试失败、
    # 另一个「幂等」测试空转（文件从没变过，断言恒真）。与 C 侧 sync_header 对称。
    known = {name for _, _, name in spans}
    missing = [s for n, s in wanted.items() if n not in known]
    if missing:
        # 插到类体末尾：从下往上找第一个单独的 `}`，那就是类的收尾
        idx = len(new_lines)
        for i in range(len(new_lines) - 1, -1, -1):
            if new_lines[i].strip() == "}":
                idx = i
                break
        indent = "        "
        for l in new_lines:
            if CS_FIELD_LINE_RE.match(l):
                indent = l[: len(l) - len(l.lstrip())]
                break
        add = []
        # 按名字排序，保证同样输入永远得到同样的插入顺序（幂等 + 可复现）
        for s in sorted(missing, key=lambda s: s.name):
            add.extend(indent + l for l in render_cs_drawcode(s))
            ctype = CS_ARRAY_RE.sub("[]", s.ctype)
            add.append("%spublic static %s %s;" % (indent, ctype, s.name))
            add.append("")
        new_lines[idx:idx] = add

    if new_lines == lines:
        return False
    result = "\n".join(new_lines)
    if text.endswith("\n"):
        result += "\n"
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(result)
    return True


def _blocks(lines):
    """Signal declarations are plain declarations, recognised by the `@drawcode` block above.

    （信号就是普通声明，靠上方有没有 ``@drawcode`` 来认定——**必须与 cparse 的判定
      一致**：那边同样是「有注解才算信号」。两处判定一旦不同，回写就会漏掉或多写。）
    """
    out = []
    for i, line in enumerate(lines):
        m = SIGNAL_RE.match(line.strip())
        if not m:
            continue
        j = i - 1
        annotated = False
        while j >= 0 and lines[j].strip().startswith("///"):
            if "@drawcode" in lines[j]:
                annotated = True
            j -= 1
        if not annotated:
            continue
        out.append((j + 1, i, m.group("name")))
    return out


def sync_header(path, model, rel):
    """回写 .h 里的信号声明（注解行 + 声明行）。"""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    lines = text.splitlines()
    wanted = {s.name: s for s in model.signals.values() if s.file == rel}
    blocks = _blocks(lines)

    new_lines = list(lines)
    for start, end, name in reversed(blocks):
        if name not in wanted:
            continue
        rendered = render_signal(wanted[name]).splitlines()
        if new_lines[start : end + 1] != rendered:
            new_lines[start : end + 1] = rendered

    # 追加分支：插到 `#endif` 之前（包裹在头文件保护里），保持文件结构合法
    known = {name for _, _, name in blocks}
    missing = [s for n, s in wanted.items() if n not in known]
    if missing:
        idx = len(new_lines)
        for i in range(len(new_lines) - 1, -1, -1):
            if new_lines[i].strip().startswith("#endif"):
                idx = i
                break
        add = []
        for s in sorted(missing, key=lambda s: s.name):
            add.extend(render_signal(s).splitlines())
            add.append("")
        new_lines[idx:idx] = add

    if new_lines == lines:
        return False
    result = "\n".join(new_lines)
    if text.endswith("\n"):
        result += "\n"
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(result)
    return True
