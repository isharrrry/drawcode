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

三处关键实现细节（与 TS 的 ``codegen.ts`` 逐条对齐）：

  1. **合并而非覆盖**。注解行绝不允许「整行重建」：重建只能输出受管键，源码上手写的
     ``xy`` / ``size`` / ``style`` 会被静默抹掉。C 与 C# 的合并**不能共用一套实现**：
     C 是空格分隔的 ``k="v"``（``dir`` 是唯一裸值键），C# 是逗号分隔的
     ``Key = "value"``，且第一个实参是位置参数 ``Direction.X``，其中 ``Xy = "360,130"``
     的逗号在引号内、不能当实参分隔符切。唯一共享的纪律是「值没变就连原始空白都不动」。
  2. **几何回写**（``model.pinned``）：只有「人拖过」的实体（读回值与 build 本来会写出的
     值不同）才在注解里生成/替换 ``xy`` / ``size``（C# 是 ``Xy`` / ``Size``）。没人动过
     ⇒ 所有 sync 产物与源文件**逐字节相同**，这是本能力的头号验收标准。
  3. **C 与 C# 的追加分支必须对称**：两边都要能处理「IR 里有、源码里还没有」的新信号，
     否则 sync 只能改已有声明、无法新增。
"""

import re

from .cparse import FUNC_RE, SIGNAL_RE
from .drawio import _num

CTYPE_RE = re.compile(r"^(?P<base>.+?)(?P<arr>\[[^\]]*\])?$")
NAME_RE = re.compile(r"^([A-Za-z_]\w*)")

# 合并既有注解时扫键值对：同时认带引号（`k="v"`）与裸值（`dir=in`）。
# 与 TS 的 `/(\w+)\s*=\s*("[^"]*"|[A-Za-z_]\w*)/g` 逐字一致 —— 旧实现复用 cparse 的
# KV_RE，它允许裸值里出现空格以外的一切字符，会把 `style=rounded=1;` 这类写法切得
# 面目全非。
MERGE_KV_RE = re.compile(r'(\w+)\s*=\s*("[^"]*"|[A-Za-z_]\w*)')

# 认不出类型时落的占位类型，以及提醒用户去改的那行注释。
PLACEHOLDER_CTYPE = "int"
PLACEHOLDER_TODO = "/* drawcode: 未能从图里认出类型，暂用 %s —— 请改成实际类型 */"


def split_ctype(ctype):
    """把 `float[32]` 拆成 (`float`, `[32]`)；无数组则 arr 为空串。

    类型可以为空——用户在 draw.io 里新加的节点只有个名字，adopt.py 明确选择
    「解析不出就留空并报告」而不是替它编一个类型。所以这里必须容忍空串，
    早先直接 match 会在 `ctype=""` 时抛 AttributeError，把整个 sync 打断。
    """
    text = (ctype or "").strip()
    if not text:
        return "", ""
    m = CTYPE_RE.match(text)
    if not m:
        return text, ""
    return m.group("base").strip(), (m.group("arr") or "")


def _kv_text(pairs):
    """`dir=in` is a bare enum value; every other key is a quoted string.

    （`dir` 是裸值、其余键带引号——写回时必须与解析端支持两种形态的写法一致，
      否则自己写的注解自己读不回来。）
    """
    return " ".join(('%s=%s' % (k, v)) if k == "dir" else ('%s="%s"' % (k, v)) for k, v in pairs)


def _geom_kv(xy_key, size_key, pinned):
    """「人拖过的几何」→ 注解键值对；没有 pinned 项时返回空列表（一个键都不写）。

    两个键名因语言而不同（C 是 ``xy``/``size``，C# 是 ``Xy``/``Size``），分隔符却必须
    两个前端一致：``xy`` 用**逗号**、``size`` 用**小写 x** —— 两边解析器就是那么切的。
    写错分隔符不会报错，只会静默得到 NaN 尺寸，所以这里按解析器的切法逐字对齐。

    数字一律走 ``_num``：与 drawio 写 XML 几何是同一个格式化函数，保证 ``120`` 不会
    写成 ``120.0``。否则同一份几何在 .drawio 与源码里两个写法，回读比对永远对不上。
    """
    if pinned is None:
        return []
    out = []
    if pinned.xy is not None:
        x, y = pinned.xy
        out.append((xy_key, "%s,%s" % (_num(x), _num(y))))
    if pinned.size is not None:
        w, h = pinned.size
        out.append((size_key, "%sx%s" % (_num(w), _num(h))))
    return out


def _signal_kv(sig, pinned=None):
    """一个信号注解的受管键值对（C 侧，含 dir）。

    ``dir`` 只在方向是合法枚举值时出现：IR 里 ``dir`` 是空串是**合法状态**（注解没写
    方向），但注解语法认不出「空方向」这个值，硬写会得到 ``dir=undefined``。
    """
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
    kv.extend(_geom_kv("xy", "size", pinned))
    return kv


def render_annotation(sig, pinned=None):
    """渲染一个信号的 ``/// @drawcode`` 行。

    **键全空时也必须落一个键**：解析侧把「注解里至少有一个键」当作信号的判据，光写
    ``/// @drawcode`` 的声明读不回 IR，下一次 sync 会把它当成新元素再追加一遍。
    ``dir=""`` 表示「没有方向」—— 它是 IR 里的合法值，解析侧两种识别规则都认它。
    注意这只影响**渲染新行**；合并既有行时 ``_signal_kv`` 在方向为空时不含 ``dir``，
    免得给一条本来就没写方向的注解硬塞一个 ``dir=""``，破坏「没人动过 ⇒ 逐字节不变」。
    """
    kv = _signal_kv(sig, pinned)
    return "/// @drawcode " + (_kv_text(kv) if kv else 'dir=""')


def render_signal(sig, pinned=None):
    """渲染「注解行 + 声明行」。

    类型可能为空（元素是从图里接回来的，label 只写了名字）。这时**必须**落一个
    真实类型名，不能只写标识符本身：

      1. 文件作用域的 `g_unknown;` 不是声明，不是合法 C；
      2. 解析器要求 `<type> <name>;`，只写名字就读不回来 —— 下一次 sync 会把
         它当成「图里新加的元素」再追加一遍，于是 sync 不幂等。

    TODO 放在**单独一行**（不是行尾），否则 SIGNAL_RE 的 ``;$`` 就匹配不上。而且
    **必须排在注解行之前**：TODO 是块注释，夹在注解与声明之间会把注解从缓冲里截断
    （解析侧遇到非 ``///`` 行就清缓冲），那条注解就丢了，信号下次又会被当成新元素。
    """
    base, arr = split_ctype(sig.ctype)
    untyped = not base
    if untyped:
        base = PLACEHOLDER_CTYPE
    line = ("%s %s%s" % (base, sig.name, arr)).strip() + ";"
    out = render_annotation(sig, pinned) + "\n" + line
    if untyped:
        out = (PLACEHOLDER_TODO % base) + "\n" + out
    return out


def render_func_kv(func, pinned=None):
    kv = []
    if func.alias:
        kv.append(("alias", func.alias))
    if func.tooltip:
        kv.append(("tooltip", func.tooltip))
    if func.note:
        kv.append(("note", func.note))
    if func.external:
        kv.append(("external", "true"))
    kv.extend(_geom_kv("xy", "size", pinned))
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
    """把 kv_new 合并进一行既有的 C 注解，返回整行。**逐段原地改，不整行重建。**

    保留 drawcode 不管理的属性（手写的 ``xy``/``size``/``style``）并维持原有顺序。
    与「整行重建」的差别（都是为了「没人动过 ⇒ 逐字节不变」这条硬标准）：

      - 行前缀（``/// @drawcode`` 与任何缩进）、键与键之间的空白、行尾原样保留；
      - **值没变的键连写法都不动**：``dir = in``（多余空格、裸值）不会因为一次无关的
        合并被规范化成 ``dir=in``，否则每次 sync 都会产生无意义的 diff；
      - 值确实要改的键沿用**原键的引号风格**：``dir=in → dir=out``（裸值）、
        ``alias="旧" → alias="新"``；
      - 追加的新键用规范写法。
    """
    want = dict(kv_new)
    used = set()
    out = []
    cursor = 0
    for m in MERGE_KV_RE.finditer(orig_line):
        start, end = m.span()
        out.append(orig_line[cursor:start])
        cursor = end
        key, raw = m.group(1), m.group(2)
        value = raw[1:-1] if raw.startswith('"') else raw
        if key not in want:
            # 不受管的键（手写 xy/size/style 等）：原样保留
            out.append(m.group(0))
            continue
        # 只要 kv_new 里也有这个键，无论值是否相同都算「已消费」——否则收尾的
        # 「追加缺失键」循环会把值相同的键再追加一遍，注解里出现重复键。
        used.add(key)
        if want[key] == value:
            out.append(m.group(0))
        elif raw.startswith('"'):
            out.append('%s="%s"' % (key, want[key]))
        else:
            out.append("%s=%s" % (key, want[key]))
    out.append(orig_line[cursor:])
    text = "".join(out)
    for k, v in kv_new:
        if k in used:
            continue
        text += ("" if text.endswith(" ") else " ") + _kv_text([(k, v)])
    return text


def render_func_skeleton(f):
    """为一个只有图形、没有源码的函数生成「签名 + 空实现」。

    带空实现是刻意的：只给声明的话 C 侧能编译、链接时才报未定义符号，
    错误暴露得太晚；空实现让产物立刻可编译，缺口以注释形式留在原地。
    """
    ret = f.ret or "void"
    if f.params:
        params = ", ".join(
            ("%s %s" % (p.ctype, p.name)) if p.ctype else p.name for p in f.params
        )
    else:
        params = "void"
    return "%s %s(%s)\n{\n    /* TODO: drawcode 从图里新建，尚未实现 */\n}" % (ret, f.name, params)


def _func_block(func, dev, orig, pinned=None):
    """渲染一个函数的声明层：@drawcode 行、@device 行，然后是原有的非注解行。

    原块里的 ``///`` 普通文档注释会被**保留**（只剔除 @drawcode/@device 两行），
    这样用户写的函数说明不会因为一次 sync 就消失。
    """
    kv = render_func_kv(func, pinned)
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
        rendered = _func_block(f, model.devices.get(f.id), block, model.pinned.get(f.id))
        if block != rendered:
            new_lines[start:end] = rendered

    # 图里有、源码里还没有的函数 —— 这正是「用户在 draw.io 里新加了一个函数节点」
    # 的情形（见 adopt.py）。追加到文件末尾，并带上空实现骨架，使产物仍能编译过：
    # 只给声明的话，C 侧能编译但链接会报未定义符号。
    known = {name for _, _, name in spans}
    missing = [f for n, f in funcs.items() if n not in known]
    if missing:
        add = []
        for f in sorted(missing, key=lambda f: f.name):
            kv = render_func_kv(f, model.pinned.get(f.id))
            if kv:
                add.append("/// @drawcode " + _kv_text(kv))
            dev_kv = render_device_kv(model.devices.get(f.id))
            if dev_kv:
                add.append("/// @device " + " ".join('%s="%s"' % p for p in dev_kv))
            add.append(render_func_skeleton(f))
            add.append("")
        while new_lines and not new_lines[-1].strip():
            new_lines.pop()
        new_lines.append("")
        new_lines.extend(add)

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
        # C# 信号与方法分两趟：定位规则不同（字段声明 vs 方法签名 + 连读的 `[...]` 属性行）。
        # 两趟都必须跑、不能用 `or` 短路 —— 信号没变不等于方法没变。
        signals = sync_cs_source(path, model, rel)
        methods = sync_cs_methods(path, model, rel)
        return signals or methods
    touched = sync_header(path, model, rel)
    # 两个都要跑，且用 or 合并结果：信号写在 .h、函数注解写在 .h 与 .c 都可能
    return sync_functions(path, model, rel) or touched


CS_DIR = {"in": "In", "out": "Out", "inout": "Io"}
CS_ATTR_RE = re.compile(r"^\s*\[\s*Drawcode\s*\(")
CS_DEVICE_ATTR_RE = re.compile(r"^\s*\[\s*Device\s*\(")
# 类型与名字都必须与 csparse 的 _TYPE / _IDENT 用同一字符集：sync 回写时要能认出
# 「中文类型 + 中文字段名」的声明（`public static 数据包 a1_数据包;`），否则
# 中文名信号在回写时会被静默漏掉。
# Python 的 `[^\W\d]` 等价于 TS 的 `[\p{L}_]`（Unicode 字母或下划线）。
CS_FIELD_LINE_RE = re.compile(
    r"^\s*(?:(?:public|private|internal|protected|static|readonly|const|volatile)\s+)*"
    r"(?P<ctype>[^\W\d][\w\.<>,\[\]\?]*)\s+(?P<name>[^\W\d]\w*)\s*(?P<init>=[^;]*)?;\s*$"
)
CS_PROP_MAP = {"unit": "Unit", "alias": "Alias", "note": "Note", "external": "External"}
# C# declares arrays as `T[]`, not `T[N]`; a model signal may still carry the C spelling.
# （C# 数组是 `T[]` 而不是 `T[N]`；IR 里可能还留着 C 的写法，追加声明时要转过来，
#   否则会生成 `public static float[16] x;` 这种编译不过的代码。）
# 只替换**带数字**的方括号：`List<int>` 这类泛型参数里没有方括号，不受影响；而
# `int[][]` 本来就没有数字，TS 侧也不动它。
CS_ARRAY_RE = re.compile(r"\[\s*\d+\s*\]")

# `Key = "value"` / `Key = bareword` 的命名实参（裸值不含逗号；含逗号的只可能是引号值）。
CS_NAMED_ARG_RE = re.compile(r'^\s*(?P<key>\w+)\s*=\s*(?:"(?P<quoted>[^"]*)"|(?P<bare>\w+))\s*$')
# 位置参数：`Direction.Out`。方向在 C# 侧是位置参数，让编辑器能补全 `Direction.`。
CS_DIR_ARG_RE = re.compile(r"^\s*Direction\s*\.\s*(?P<member>\w+)\s*$")


def _cs_args(pairs):
    # "Direction" 是 _cs_signal_args 里的伪键：它是位置参数，规范形态是 `Direction.In`，
    # 不是 `Direction = "In"`。走这里兜底，任何追加路径都不会写出错误形态。
    return ", ".join(
        ("Direction.%s" % v) if k == "Direction" else ('%s = "%s"' % (k, v))
        for k, v in pairs
    )


def _cs_signal_args(sig, pinned=None):
    """C# 信号注解的受管实参（渲染与合并共用同一份，防止两处集合/顺序漂移）。

    ``Direction`` 在源码里是**位置参数**（``Direction.In``，不写 ``Key = "value"``）。
    这里用伪键 "Direction" 表示它：渲染时落回位置形态，合并时与既有的位置参数对齐替换。
    方向为空串（IR 合法值）时不产出该参数，既不写出 ``Direction.undefined``，也让合并跳过它。
    """
    args = []
    if sig.dir:
        args.append(("Direction", CS_DIR.get(sig.dir, "None")))
    if sig.unit:
        args.append(("Unit", sig.unit))
    if sig.alias:
        args.append(("Alias", sig.alias))
    if sig.note:
        args.append(("Note", sig.note))
    if sig.external:
        args.append(("External", "true"))
    args.extend(_geom_kv("Xy", "Size", pinned))
    return args


def render_cs_annotation(sig, pinned=None):
    """One `[Drawcode(...)]` line: direction positional, metadata as named properties.

    （方向是位置参数、其余是命名属性。属性名用 PascalCase，与 DrawcodeAttributes.cs
      里定义的属性一一对应——名字对不上编辑器就补全不出来，这个语法的价值也就没了。）

    与 TS 的 ``renderCsAnnotation`` 有一处**刻意的差异**：方向为空串而其余键也全空时，
    这里返回 ``[]``（不落注解行），TS 会写出 ``Direction.undefined``。C# 前端要求有
    ``Direction`` 才算信号，解析产物不可能带空方向，所以这条路径只在手工构造 Model 时
    可达；Python 保持旧行为，不把「undefined」写进用户代码。
    """
    args = _cs_signal_args(sig, pinned)
    if not args:
        return []
    return ["[Drawcode(%s)]" % _cs_args(args)]


# 旧名字：测试与外部脚本直接导入它；统一走 render_cs_annotation，避免两份实现漂移。
def render_cs_drawcode(sig, pinned=None):
    return render_cs_annotation(sig, pinned)


def _split_top_level_commas(body):
    """引号感知的顶层逗号切分。

    ``Xy = "360,130"`` 的逗号在引号里，直接 ``body.split(",")`` 会把它当一个实参切成
    两半，合并后写出 ``Xy = "360`` + 半个 ``130"`` 这种会编译失败的垃圾。引号内不做
    转义处理 —— 与 csparse 的 ARG_RE（``[^"]*``）保持同一套假设，两处对「什么算引号值」
    的判断必须一致。
    """
    out = []
    start = 0
    in_quote = False
    for i, ch in enumerate(body):
        if ch == '"':
            in_quote = not in_quote
        elif ch == "," and not in_quote:
            out.append(body[start:i])
            start = i + 1
    out.append(body[start:])
    return out


def _merge_cs_args(body, updates):
    """``[Drawcode(...)]`` 的实参体 → 合并后的实参体。**参数级** merge，不是整行重建：

      - 位置参数（``Direction.Out``）与认不出的实参一律原样保留（逐字节，连空白都不动）；
      - 命名参数只有受管值确实不同才重写（重写为 ``Key = "value"`` 规范形态）；值相同
        ⇒ 原样，这正是「无人拖动 ⇒ 逐字节不变」的实现方式，也让 ``Unit="LSB"`` 这种
        紧凑写法不会被顺手规范化；
      - 缺失的受管参数追加到末尾；
      - 键名按大小写不敏感匹配（解析侧 ARG_RE 也把键名小写化后再查表），但重写时沿用
        原键写法。
    """
    if not updates:
        return body
    want = {k.lower(): v for k, v in updates}
    used = set()
    out = []
    for seg in _split_top_level_commas(body):
        named = CS_NAMED_ARG_RE.match(seg)
        if named is not None:
            key = named.group("key")
            value = named.group("quoted")
            if value is None:
                value = named.group("bare")
            w = want.get(key.lower())
            if w is None:
                out.append(seg)  # 不受管的实参（手写 Style 等）：原样保留
                continue
            # 与 C 侧同理：值相同也要算「已消费」，否则会被当成缺失键追加成重复实参
            # —— `Direction` 伪键尤其致命，那会写出 `Direction.Out, Direction = "Out"`。
            used.add(key.lower())
            if w == value:
                out.append(seg)
                continue
            lead = seg[: len(seg) - len(seg.lstrip())]
            out.append('%s%s = "%s"' % (lead, key, w))
            continue
        d = CS_DIR_ARG_RE.match(seg)
        if d is not None:
            w = want.get("direction")
            if w is None:
                out.append(seg)
                continue
            used.add("direction")
            if w == d.group("member"):
                out.append(seg)
                continue
            lead = seg[: len(seg) - len(seg.lstrip())]
            out.append("%sDirection.%s" % (lead, w))
            continue
        out.append(seg)
    missing = [(k, v) for k, v in updates if k.lower() not in used]
    if not missing:
        return ",".join(out)
    add = _cs_args(missing)
    last = out[-1]
    if last.strip() == "":
        # 体是空的（`[Drawcode()]`）或尾随逗号：没有实参可依附，直接落规范写法
        out[-1] = add if len(out) == 1 and last == "" else " " + add
    else:
        out.append(" " + add)
    return ",".join(out)


def _merge_cs_annotation_line(line, updates):
    """在一行 ``[Drawcode(...)]`` 上找到实参体（引号感知地配对 ``)``），对它做参数级合并。

    认不出（没有 ``[Drawcode(``、括号不闭合）时**原样返回整行** —— 回写工具对看不懂的
    东西必须闭嘴：把一行没改动的注解改写坏掉，比不写回更糟。
    """
    m = CS_ATTR_RE.match(line)
    if m is None:
        return line
    body_start = m.end()
    in_quote = False
    depth = 0
    for i in range(body_start, len(line)):
        ch = line[i]
        if ch == '"':
            in_quote = not in_quote
            continue
        if in_quote:
            continue
        if ch == "(":
            depth += 1
            continue
        if ch != ")":
            continue
        if depth > 0:
            depth -= 1
            continue
        body = line[body_start:i]
        merged = _merge_cs_args(body, updates)
        # 行尾（`)]` 之后，可能有注释）原样保留：只换实参体这一段
        return line if merged == body else line[:body_start] + merged + line[i:]
    return line


def _find_cs_drawcode_above(lines, frm):
    """从第 ``frm`` 行向上扫过连续的 ``[...]`` 属性行，返回最近一行 ``[Drawcode(`` 的
    行号，找不到返回 None。

    为什么不能只看「上一行」：设备卡片的真实形状是
        [Drawcode(...)]            ← 要合并的目标
        [Device(Model = "…")]      ← 它的「下一行」，也就是签名的「上一行」
        public static Hardware dev_xxx()
    ``[Device]`` 卡在中间，「签名的上一行」这个定位法直接失效：会把方法误判成「没有
    注解」，然后（若照旧逻辑）在上面插一行重复的 ``[Drawcode]``。所以必须扫过**连续的**
    属性行。停扫条件与解析侧一致：readMeta 同样只把连续无空行、无注释的 ``[...]`` 块当
    同一个注解块，两边用同一条边界才能在「解析认得出」的行上写回。多个 ``[Drawcode]``
    时取**最近**的一行：解析侧同类键是后写覆盖前写，即离声明最近者胜。
    """
    j = frm - 1
    while j >= 0 and lines[j].strip().startswith("["):
        if CS_ATTR_RE.match(lines[j]):
            return j
        j -= 1
    return None


def sync_cs_source(path, model, rel):
    """回写 C# 声明层：每个声明上方一行 `[Drawcode(...)]`。

    既有注解行走**参数级合并**（``_merge_cs_annotation_line``）：手写的 ``Style``、
    ``Xy``/``Size`` 和其他不认识的参数全部原样存活，只有受管参数里值确实变了的才被就地
    替换。旧实现是整行重建，手写参数会被静默抹掉 —— 与 C 侧的 ``sync_header`` 是同一个
    缺陷，这次一并修掉。
    """
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    lines = text.splitlines()
    wanted = {s.name: s for s in model.signals.values() if s.file == rel}

    # 定位每个已有字段：dc_idx = 上方最近的 [Drawcode( 行（没有则 None），field_idx = 字段行
    spans = []
    for i, line in enumerate(lines):
        m = CS_FIELD_LINE_RE.match(line)
        if not m or m.group("name") not in wanted:
            continue
        spans.append({
            "dc_idx": _find_cs_drawcode_above(lines, i),
            "field_idx": i,
            "name": m.group("name"),
        })

    new_lines = list(lines)
    # 从后往前替换，这样前面的区间下标不会被改动而失效
    for span in reversed(spans):
        sig = wanted[span["name"]]
        pinned = model.pinned.get(sig.id)
        if span["dc_idx"] is not None:
            merged = _merge_cs_annotation_line(new_lines[span["dc_idx"]], _cs_signal_args(sig, pinned))
            if merged != new_lines[span["dc_idx"]]:
                new_lines[span["dc_idx"]] = merged
            continue
        # 字段上方没有 Drawcode 注解行：插一行新的，字段行本身一格不动
        field_line = lines[span["field_idx"]]
        indent = field_line[: len(field_line) - len(field_line.lstrip())]
        rendered = [indent + l for l in render_cs_annotation(sig, pinned)] + [field_line]
        new_lines[span["field_idx"]:span["field_idx"] + 1] = rendered

    # 追加分支：模型里有、但文件里还没写的信号。
    # 缺了这一段，sync 就只能改已有字段、无法新增——曾经因此有一个测试失败、
    # 另一个「幂等」测试空转（文件从没变过，断言恒真）。与 C 侧 sync_header 对称。
    known = {s["name"] for s in spans}
    missing = [s for n, s in wanted.items() if n not in known]
    if missing:
        # 插到最后一个字段行之后；找不到字段就插到类体收尾 `}` 之前
        anchor = None
        for i, line in enumerate(new_lines):
            if CS_FIELD_LINE_RE.match(line):
                anchor = i + 1
        if anchor is None:
            for i in range(len(new_lines) - 1, -1, -1):
                if new_lines[i].strip() == "}":
                    anchor = i
                    break
        if anchor is None:
            anchor = len(new_lines)
        indent = "        "
        for line in new_lines:
            if CS_FIELD_LINE_RE.match(line):
                indent = line[: len(line) - len(line.lstrip())]
                break
        add = []
        # 按名字排序，保证同样输入永远得到同样的插入顺序（幂等 + 可复现）
        for s in sorted(missing, key=lambda s: s.name):
            add.extend(indent + l for l in render_cs_annotation(s, model.pinned.get(s.id)))
            ctype = CS_ARRAY_RE.sub("[]", s.ctype)
            add.append("%spublic static %s %s;" % (indent, ctype, s.name))
            add.append("")
        new_lines[anchor:anchor] = add

    if new_lines == lines:
        return False
    result = "\n".join(new_lines)
    if text.endswith("\n"):
        result += "\n"
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(result)
    return True


def sync_cs_methods(path, model, rel):
    """C# 方法注解的**几何**回写：把 ``pinned`` 里的 Xy/Size 合并进方法上方
    ``[Drawcode(...)]`` 行；``[Device(...)]`` 行与签名一个字都不动。

    为什么只碰几何、不碰 Alias/Note/Asset：
      - 本轮契约只要求几何；
      - ``Asset`` 在解析侧有一个隐蔽来源：``Func.asset`` 在 ``[Drawcode]`` 没有 Asset
        时会从 ``[Device(Asset=…)]`` 回填（见 csparse.parse_cs_project）。若把 Asset
        也纳入合并，就会把 Device 行上的 Asset 悄悄复制一份进 Drawcode 行 —— 凭空多出
        一个键；
      - 写回范围越小，破坏面越小。其余键的回写是后续工作，不是这里顺手做的事。

    定位方法签名复用 csparse 的 ``CS_FUNC_RE``（方法签名的单一事实源），绝不另写一套
    正则 —— 两套写法迟早漂移，届时「解析认得出、回写找不到」会静默丢失改动。

    已知限制（本轮不做）：图里有、源码里没有的**新方法**不会自动插入骨架；找不到
    ``[Drawcode(...)]`` 的既有方法也一行都不碰。
    """
    from .csparse import CS_FUNC_RE  # 延迟导入：csparse 依赖 cparse，避免顶层循环

    funcs = {f.name: f for f in model.funcs.values() if f.file == rel}
    if not funcs:
        return False

    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    lines = text.splitlines()
    new_lines = list(lines)
    for i, line in enumerate(lines):
        m = CS_FUNC_RE.match(line.strip())
        if m is None:
            continue
        f = funcs.get(m.group("name"))
        if f is None:
            continue
        dc_idx = _find_cs_drawcode_above(lines, i)
        if dc_idx is None:
            continue
        updates = _geom_kv("Xy", "Size", model.pinned.get(f.id))
        if not updates:
            continue
        merged = _merge_cs_annotation_line(new_lines[dc_idx], updates)
        if merged != new_lines[dc_idx]:
            new_lines[dc_idx] = merged

    if new_lines == lines:
        return False
    result = "\n".join(new_lines)
    if text.endswith("\n"):
        result += "\n"
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(result)
    return True


def _blocks(lines):
    """找出文件里所有「信号声明块」的位置：块 = 声明行本身 + 它上方连续的 ``///`` 行。

    与解析侧的规则一致：注解块必须紧贴声明，中间不能有空行。回写时按 start..end
    整块替换，所以块的边界画错会吃掉相邻代码。

    这里**不要求**块里已经有 ``@drawcode``：模型里有的名字才走到合并，没注解的行会由
    ``_merge_signal_block`` 把注解插到声明行正上方。旧实现要求有注解，结果一条注解被
    人删掉的信号会被当成「源码里没有」再追加一遍，声明重复出现。
    """
    out = []
    for i, line in enumerate(lines):
        m = SIGNAL_RE.match(line.strip())
        if not m:
            continue
        j = i - 1
        while j >= 0 and lines[j].strip().startswith("///"):
            j -= 1
        out.append((j + 1, i, m.group("name")))
    return out


def _merge_signal_block(sig, orig, pinned=None):
    """一个既有信号块的合并渲染：注解行**就地合并**，其余行不动。

    为什么注解行绝不能整行重建（旧实现的做法）：重建只能输出受管键
    （dir/unit/alias/note/external/几何），源码上手写的 ``style`` 会被静默抹掉 ——
    这是个既存缺陷。合并后：没人拖动 ⇒ 手写键原样存活；人拖过 ⇒ 就地替换。

    未定类型的 TODO 注释行必须留在注解行**之前**（原因见 render_signal 的说明）。
    """
    rendered = render_signal(sig, pinned).splitlines()
    rendered_ann = next(
        (i for i, l in enumerate(rendered) if l.lstrip().startswith("/// @drawcode")), None,
    )
    orig_ann = next(
        (i for i, l in enumerate(orig) if l.lstrip().startswith("/// @drawcode")), None,
    )
    kv = _signal_kv(sig, pinned)
    if orig_ann is not None:
        annotation = _merge_annotation(orig[orig_ann], kv)
    else:
        annotation = rendered[rendered_ann]
    head = rendered[:rendered_ann]
    body = [l for i, l in enumerate(orig) if i != orig_ann] if orig_ann is not None else list(orig)
    if orig_ann is None:
        # 块里没有 @drawcode 行：把注解插在声明行正上方，其余 `///` 行保持原序
        return head + body[:-1] + [annotation, body[-1]]
    # 去掉原注解行后，下标 orig_ann 正好是它原来的位置（后面整体前移一位）
    return head + body[:orig_ann] + [annotation] + body[orig_ann:]


def sync_header(path, model, rel):
    """回写 .h 里的信号声明（注解行 + 声明行）。

    两段：(1) 已存在的声明块把注解行合并一遍；(2) **IR 里有、文件里没有的信号追加到
    ``#endif`` 之前**。第 (2) 段是 C 与 C# 必须对称的能力 —— 代码里新建一个信号、跑
    ``sync``，它得真的出现在源码里。
    """
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    lines = text.splitlines()
    wanted = {s.name: s for s in model.signals.values() if s.file == rel}
    blocks = _blocks(lines)

    new_lines = list(lines)
    for start, end, name in reversed(blocks):
        sig = wanted.get(name)
        if sig is None:
            continue
        current = new_lines[start:end + 1]
        rendered = _merge_signal_block(sig, current, model.pinned.get(sig.id))
        if current != rendered:
            new_lines[start:end + 1] = rendered

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
            add.extend(render_signal(s, model.pinned.get(s.id)).splitlines())
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
