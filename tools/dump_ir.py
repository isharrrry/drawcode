"""把 IR 导成规范化 JSON，用作 tests/golden 的解析层金标准。

不属于任何语言实现：它读的是 Python 参考实现，产出的是三版共用的比较基准。
布局坐标（x/y/w/h）刻意不入 JSON —— 那是 .drawio 层的事，见 ../docs/conformance.md。

用法:
    python tools/dump_ir.py <root> <out.json> <file> [file...]
"""
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "python", "src"))

from drawcode.parse import parse_any  # noqa: E402


def dump(model):
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


def main(argv):
    root, out, files = argv[1], argv[2], argv[3:]
    model = parse_any(files, root=root)
    payload = dump(model)
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    print(
        "signals=%d funcs=%d edges=%d devices=%d -> %s"
        % (
            len(payload["signals"]),
            len(payload["funcs"]),
            len(payload["edges"]),
            len(payload["devices"]),
            out,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
