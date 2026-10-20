"""IR → 规范化 JSON，L1 一致性比较的产物。

对等 TS ``src/dump.ts`` 与 .NET ``IrJson.cs``，也等价于 ``tools/dump_ir.py`` 的
``dump()`` —— 从本模块落地后，脚本与包实现共用同一份口径，不再各抄一遍。

刻意**不包含**布局坐标（x/y/w/h）：布局是 ``.drawio`` 层的事，混进 L1 会让
路由 bug 看起来像解析 bug（见 ``docs/conformance.md``）。

排序统一用 Python 默认的字符串比较（Unicode 码点序），TS 侧用 ``compareCodePoints``
逐字对齐；JSON 输出按 ``sort_keys=True``、两空格缩进、``ensure_ascii=False``、末尾换行，
与 ``tools/dump_ir.py`` 的产物逐字节一致。
"""

import json


def dump_ir(model):
    """把 Model 摊平成与语言无关的 dict（键名是 L1 契约，不能随意改）。"""
    signals = [
        {
            "id": s.id,
            "name": s.name,
            "ctype": s.ctype,
            "dir": s.dir,
            "file": s.file,
            "line": s.line,
            "unit": s.unit,
            "alias": s.alias,
            "note": s.note,
            "external": s.external,
            "group": s.group,
        }
        for s in sorted(model.signals.values(), key=lambda s: s.id)
    ]
    funcs = [
        {
            "id": f.id,
            "name": f.name,
            "ret": f.ret,
            "params": [{"name": p.name, "ctype": p.ctype, "dir": p.dir} for p in f.params],
            "file": f.file,
            "line": f.line,
            "alias": f.alias,
            "note": f.note,
            "tooltip": f.tooltip,
            "asset": f.asset,
            "external": f.external,
            "group": f.group,
            "reads": sorted(f.reads),
            "writes": sorted(f.writes),
            "calls": sorted(f.calls),
        }
        for f in sorted(model.funcs.values(), key=lambda f: f.id)
    ]
    edges = sorted(
        [{"src": e.src, "dst": e.dst, "rw": e.rw} for e in model.edges],
        key=lambda e: (e["src"], e["dst"], e["rw"]),
    )
    devices = [
        {"id": k, **{kk: getattr(v, kk) for kk in ("vendor", "model", "spec", "size", "asset")}}
        for k, v in sorted(model.devices.items())
    ]
    return {
        "signals": signals,
        "funcs": funcs,
        "edges": edges,
        "devices": devices,
        "files": sorted(model.files),
    }


def dump_ir_json(model):
    """规范化 JSON 文本：键有序、两空格缩进、非 ASCII 原样保留、末尾一个换行。"""
    return json.dumps(dump_ir(model), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
