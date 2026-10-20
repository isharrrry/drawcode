"""C 前端：扫源码产出一个 IR。

语法约定（新语法，旧版的 ``SIGNAL_*`` 宏与 ``drawcode_signals.h`` 已彻底取消）：

    /// @drawcode dir=in unit="LSB" alias="原始采样值"
    int16_t g_raw;

    /// @drawcode alias="ADC 采样" tooltip="上电后需先校准"
    /// @device vendor="TI" model="ADS1115" spec="16bit/860SPS"
    int16_t adc_read(void);

两条规则：
  1. 只有**紧跟在 ``///`` 注解块之后**的顶层声明才会被当成信号；
  2. 方向来自注解里的 ``dir`` 键，不再靠宏名。旧语法下方向由编译器保证，
     现在靠人写对——``dir=inn`` 会被静默忽略，这是这个语法选择的已知代价。

边的来源与注解无关：``reads``/``writes`` 全部由 ``_def_use`` 扫描**函数体代码**得出。
所以改注解只会改标签文字，一个像素的连线都不会动。
"""

import os
import re

from .model import Device, Edge, Func, Model, Param, Signal

# 注解里的方向词 -> IR 里的方向。io 与 inout 都归一到 inout（IR 只认三种）。
DIR_BY_KEY = {"in": "in", "out": "out", "io": "inout", "inout": "inout"}

# 长得像函数调用、其实是语言关键字的词，不能算「调用」。
CONTROL = {
    "if", "for", "while", "switch", "return", "sizeof", "do", "else", "case",
    "defined", "static_assert", "catch", "typeof",
}

# A signal is a top-level declaration carrying a `/// @drawcode` block. The type part is
# whatever precedes the declarator; an array suffix is folded into the recorded ctype,
# so `float g_coeff[32];` becomes ctype `float[32]` named `g_coeff`.
# （类型部分取声明符之前的整段；数组后缀并入 ctype，故 `float g_coeff[32];`
#   记为 ctype=`float[32]`、name=`g_coeff`。这样 C 与 C# 的数组写法差异留给
#   codegen 去转换，解析阶段保持原样。）
SIGNAL_RE = re.compile(
    r"^(?P<type>(?:[A-Za-z_]\w*[\s\*]+)+?)"
    r"(?P<name>[A-Za-z_]\w*)\s*(?P<arr>\[[^\]]*\])?\s*;$"
)

FUNC_RE = re.compile(
    r"^(?P<ret>(?:[A-Za-z_]\w*[\s\*]+)+)"
    r"(?P<name>[A-Za-z_]\w*)\s*\((?P<params>[^)]*)\)\s*(?P<tail>[;{]?)\s*$"
)

# 赋值识别：`=` 但排除 ==、!=、<=、>=、+= 等（lookaround 两头都挡住）。
ASSIGN_RE = re.compile(r"(?<![=!<>+\-*/%&|^])=(?!=)")
COMPOUND_RE = re.compile(r"(?:\+|-|\*|/|%|&|\||\^|<<|>>)=")
# 标识符字符集必须是 Unicode：C# 编译器接受中文名字，`a5_采样值 = …` 与
# `测试桩.处理(…)` 里的中文名都要能被 def/use 扫到，否则信号名中文化后所有边会静默
# 消失。C 侧只用到其中的 ASCII 子集，行为不变。
#
# Python 的 `re` 没有 `\p{L}`：`[^\W\d]` 是「`\w` 去掉数字」，即 Unicode 字母或
# 下划线；后续用 `\w`（字母/数字/下划线）。与 TS 的 `[\p{L}_][\p{L}\p{N}_]*` 等价。
IDENT_RE = re.compile(r"[^\W\d]\w*")
CALL_RE = re.compile(r"([^\W\d]\w*)\s*\(")
# `key="value"` and bare `key=value` both appear: metadata is quoted, `dir=in` is not.
# （两种写法都必须认：元数据带引号，而 `dir=in` 是裸值。曾经只认带引号的版本，
#   结果 `dir` 读不到、signal 判定失败、**所有信号静默消失且不报错**。改动这个
#   正则前请先想清楚这一点。）
KV_RE = re.compile(r'(\w+)\s*=\s*(?:"([^"]*)"|([^\s"]+))')


def _rel(path, root):
    return os.path.relpath(path, root).replace("\\", "/")


def _stem(rel):
    """文件名（去扩展名）——没标 ``path`` 时的默认容器名。"""
    return os.path.splitext(os.path.basename(rel))[0]


def _container_path(meta, rel):
    """容器的斜杠路径，例如 ``adc/采样前端``。

    标了 ``path="adc/采样前端"`` 就用它；没标则退回模块名（``adc.h`` -> ``adc``）。
    这样旧源码一个字不改也照常工作，而且下游拿到的 path **永远非空** ——
    「没标」和「标成空」是同一种情况，不需要在别处再判一次。
    """
    return (meta.get("path") or "").strip().strip("/") or _stem(rel)


def _top_group(path):
    """path 的第一段，即最外层容器名。"""
    return path.split("/")[0]


def _read_annotations(buf):
    """把一段连续的 ``///`` 行解析成 (drawcode 键值, device 键值)。"""
    meta, dev = {}, {}
    for raw in buf:
        body = raw.lstrip()[3:].strip()
        m = re.match(r"@(\w+)\s*(.*)$", body)
        if not m:
            continue
        tag, rest = m.group(1), m.group(2)
        # `findall` yields '' (not None) for capture groups that did not participate,
        # so pick whichever alternative actually matched.
        # （未参与匹配的捕获组得到的是 '' 而不是 None，所以要用 `v or bare` 取真正命中的那一支。）
        kv = {k: (v or bare) for k, v, bare in KV_RE.findall(rest)}
        if tag == "drawcode":
            meta.update(kv)
        elif tag == "device":
            dev.update(kv)
    return meta, dev


def _js_number(text):
    """模拟 JavaScript 的 ``Number()`` —— 几何键的容差契约以它为准。

    为什么不能直接用 ``float()``：两个实现（TypeScript / .NET）与 Python 在这
    三个病态输入上会得出不同结果，而坐标一旦分叉，同一份源码在三种语言里就会
    排出三种图：

      * ``float("1_0")`` == 10.0，但 ``Number("1_0")`` 是 NaN（JS 不认数字分隔符）；
      * ``float("infinity")`` 可用，``Number("infinity")`` 是 NaN（只认大小写精确的
        ``Infinity``）；
      * ``float("0x10")`` 抛 ValueError，``Number("0x10")`` 是 16。

    畸形与缺失一律得到 NaN，**不抛异常**：TS 的 ``applyGeometry`` 从不校验，下游
    自己承担。这里若抛异常，一份写错坐标的源码会让 Python 版直接崩掉，而另外两个
    版本照常出图 —— 那才是最难查的跨语言差异。
    """
    t = text.strip()
    if t == "":
        return 0.0  # Number("") === 0，与 Number(" ") 相同
    try:
        if re.fullmatch(r"0[xX][0-9a-fA-F]+", t):
            return float(int(t, 16))
        if re.fullmatch(r"0[oO][0-7]+", t):
            return float(int(t[2:], 8))
        if re.fullmatch(r"0[bB][01]+", t):
            return float(int(t[2:], 2))
        # JS 的十进制字面量：允许 `1.` / `.5` / 指数；Infinity 区分大小写且可带符号。
        if re.fullmatch(r"[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)", t):
            return float(t)
    except (ValueError, OverflowError):
        pass
    return float("nan")


def _split_numbers(value, sep):
    """按分隔符切分并逐段转数字；**缺段补 NaN**，与 TS 的 ``parts[1]`` 一致。

    例如 ``"40"`` 的 xy 在 TS 里得到 ``x=40, y=undefined`` —— 后续算术变 NaN。
    这里返回 ``[40.0, nan]``，下游行为相同。
    """
    return [_js_number(part) for part in value.split(sep)]


def _apply_geometry(ent, meta):
    """把 ``xy`` / ``size`` 套到实体上。**两个前端、两类实体共用这一个入口。**

    容差与 ``applyGeometry``（TS）逐字对齐：缺键或空串不动默认值；分隔符写错不
    报错，只得到 NaN。``xy`` 用逗号、``size`` 用小写 ``x`` —— 写混会静默得到
    NaN 尺寸，这是契约的一部分（回写侧 codegen 按同样的切法生成字符串）。
    """
    xy = meta.get("xy")
    if xy is not None and xy != "":
        parts = _split_numbers(xy, ",")
        ent.x = parts[0] if len(parts) > 0 else float("nan")
        ent.y = parts[1] if len(parts) > 1 else float("nan")
    size = meta.get("size")
    if size is not None and size != "":
        parts = _split_numbers(size.lower(), "x")
        ent.w = parts[0] if len(parts) > 0 else float("nan")
        ent.h = parts[1] if len(parts) > 1 else float("nan")


def _parse_params(text):
    """解析形参表。形参随后会被当作函数节点的「端口」参与方向排序。"""
    text = text.strip()
    if not text or text == "void":
        return []
    out = []
    for part in text.split(","):
        part = part.strip()
        # 形参名同样要 Unicode：`编码器输入 输入` 这类中文形参在 C# 侧完全合法，
        # 名字若只认 ASCII，整个形参会从端口表里消失（TS 的 PARAM_RE 早已是 Unicode）。
        m = re.match(r"^(?P<ctype>.+?)\s*(?P<name>[^\W\d]\w*)$", part)
        if m:
            out.append(Param(name=m.group("name"), ctype=m.group("ctype").strip()))
    return out


def _strip_comments(text):
    """去掉注释再做 def/use 扫描——否则注释里的词会被当成读写。"""
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return re.sub(r"//[^\n]*", " ", text)


def _bodies(lines):
    """扫描 .c 行列表，抽出 name -> (body_line_no, body_text)。"""
    bodies = {}
    i = 0
    while i < len(lines):
        m = FUNC_RE.match(lines[i].strip())
        if m and m.group("name") not in CONTROL:
            j = i
            # 函数签名与 `{` 之间最多允许隔 2 行。这个 2 是**几何契约**：
            # 改大或改小会让「畸形输入」上的判定与其它两个语言实现分道扬镳。
            while j < len(lines) and "{" not in lines[j] and j - i <= 2:
                j += 1
            if j < len(lines) and "{" in lines[j]:
                # 按花括号配平取整段函数体（不是遇到第一个 } 就停，否则嵌套块会截断）
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


def _def_use(body, signals_by_name, funcs_by_name):
    """从函数体推出它读了哪些信号、写了哪些信号、调了哪些函数。

    按语句逐条判定，三种形态：
      复合赋值 `a += b`  -> a 既读又写，b 只读
      简单赋值 `a = b`   -> a 只写，b 只读
      其它语句           -> 出现的标识符全部算读
    只保留能在 signals_by_name 里查到的名字，所以局部变量天然被滤掉。
    返回排序后的 id 列表——**排序是必需的**：边序会影响几何，不能依赖 set 的迭代顺序。
    """
    body = _strip_comments(body)
    reads, writes, calls = set(), set(), set()
    # 按 ; { } 切分语句，粗但够用；不追求构建真正的 C 语法树
    for stmt in re.split(r"[;{}]", body):
        stmt = stmt.strip()
        if not stmt:
            continue
        for name in CALL_RE.findall(stmt):
            if name in CONTROL:
                continue
            if name in funcs_by_name:
                calls.add(funcs_by_name[name])
        comp = COMPOUND_RE.search(stmt)
        simple = ASSIGN_RE.search(stmt)
        if comp:
            lhs, rhs = stmt[: comp.start()], stmt[comp.end():]
            writes.update(IDENT_RE.findall(lhs))
            reads.update(IDENT_RE.findall(lhs))
            reads.update(IDENT_RE.findall(rhs))
        elif simple:
            lhs, rhs = stmt[: simple.start()], stmt[simple.end():]
            writes.update(IDENT_RE.findall(lhs))
            reads.update(IDENT_RE.findall(rhs))
        else:
            reads.update(IDENT_RE.findall(stmt))
    rd = {signals_by_name[n] for n in reads if n in signals_by_name}
    wr = {signals_by_name[n] for n in writes if n in signals_by_name}
    return sorted(rd), sorted(wr), sorted(calls)


def parse_project(paths, root=None):
    """把一批 .c/.h 解析成一个 Model。``root`` 用于计算相对路径。"""
    root = root or os.path.dirname(os.path.abspath(paths[0]))
    loaded = []
    for p in paths:
        rel = _rel(os.path.abspath(p), os.path.abspath(root))
        with open(p, encoding="utf-8") as fh:
            loaded.append((rel, fh.read().splitlines()))

    model = Model(files=[rel for rel, _ in loaded])

    # 第一遍：只收集原始信息，此时还不知道哪些函数有函数体
    raw_signals = []   # (rel, line, dir, ctype, name, meta)
    raw_funcs = {}     # name -> dict
    for rel, lines in loaded:
        buf = []
        for lineno, raw in enumerate(lines, 1):
            s = raw.strip()
            if s.startswith("///"):
                buf.append(raw)
                continue
            if not s:
                # 空行清空注解缓冲：注解必须紧贴它标注的声明，不允许中间空行
                buf = []
                continue
            meta, dev = _read_annotations(buf)
            buf = []

            ms = SIGNAL_RE.match(s)
            # 有注解才算信号——这是「普通变量声明」与「信号」的唯一分界
            if ms and meta:
                raw_signals.append((
                    rel,
                    lineno,
                    DIR_BY_KEY.get(meta.get("dir", ""), ""),
                    ms.group("type").strip() + (ms.group("arr") or ""),
                    ms.group("name"),
                    meta,
                ))
                continue

            mf = FUNC_RE.match(s)
            if mf and mf.group("name") not in CONTROL:
                name = mf.group("name")
                info = raw_funcs.setdefault(name, {"params": []})
                is_header = rel.endswith(".h")
                new = {
                    "rel": rel,
                    "line": lineno,
                    "ret": mf.group("ret").strip(),
                    "params": _parse_params(mf.group("params")),
                    "meta": meta,
                    "device": dev,
                }
                # 同名函数在 .h 和 .c 里各出现一次（声明 + 定义）。合并规则：
                # 头文件优先，且已有的非空字段不被空值覆盖——这样注解写在声明处
                # 还是定义处都能生效，而定义处能补上头文件没有的参数表。
                for key, val in new.items():
                    if key in ("params",) and info.get("params"):
                        continue
                    if val in ("", None, {}, []) and key in info:
                        continue
                    if key not in info or is_header:
                        info[key] = val

    for rel, lineno, direction, ctype, name, meta in raw_signals:
        sid = "%s::%s" % (rel, name)
        cpath = _container_path(meta, rel)
        sig = Signal(
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
        # 与 TS 一致：信号的 xy/size 也读（旧版只对函数读，信号上的坐标被静默丢弃）
        _apply_geometry(sig, meta)
        model.add_signal(sig)

    signals_by_name = {s.name: s.id for s in model.signals.values()}

    funcs_by_name = {}
    for name, info in raw_funcs.items():
        fid = "%s::%s" % (info["rel"], name)
        funcs_by_name[name] = fid
        meta = info.get("meta", {})
        fpath = _container_path(meta, info["rel"])
        model.add_func(
            Func(
                id=fid,
                name=name,
                ret=info.get("ret", "void"),
                params=info.get("params", []),
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
        # 下面两个 size 是**同名但无关的两个键**，别合并：
        #   meta["size"] —— 节点几何尺寸 "180x72"（与信号共用 _apply_geometry）
        #   dev["size"]  —— @device 的器件物理封装尺寸 "2.0x3.0mm"
        _apply_geometry(model.funcs[fid], meta)
        dev = info.get("device") or {}
        if dev:
            model.devices[fid] = Device(
                vendor=dev.get("vendor", ""),
                model=dev.get("model", ""),
                spec=dev.get("spec", ""),
                size=dev.get("size", ""),
                asset=dev.get("asset", ""),
            )
            # 器件图可以顶替函数自身的 asset，但不覆盖函数上已写明的那个
            if not model.funcs[fid].asset:
                model.funcs[fid].asset = dev.get("asset", "")

    # 第二遍：只对 .c/.cpp（有实现体的文件）做 def/use，头文件里是声明，扫不出东西
    for rel, lines in loaded:
        if not rel.endswith((".c", ".cpp")):
            continue
        for name, body in _bodies(lines).items():
            if name not in funcs_by_name:
                continue
            rd, wr, cl = _def_use(body, signals_by_name, funcs_by_name)
            f = model.funcs[funcs_by_name[name]]
            f.reads, f.writes, f.calls = rd, wr, cl

    model.rebuild_edges()
    return model
