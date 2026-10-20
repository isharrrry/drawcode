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

from drawcode.dump import dump_ir as dump  # noqa: E402
from drawcode.parse import parse_any  # noqa: E402

# 具体口径已收进 `drawcode.dump`（包实现与脚本共用一份）：
# 布局坐标刻意不入 JSON，键序/缩进/末尾换行按 json.dump(sort_keys=True, indent=2) 来。


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
