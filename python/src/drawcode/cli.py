"""命令行入口：``build`` 与 ``sync`` 两个子命令。

    build  <源码...>  ->  .drawio（可选 --svg 预览、--layout-from 复用既有排版）
    sync   <.drawio> <源码...>  ->  把图上的注解写回源码（只动声明层）

两条命令互为逆过程，合起来就是「源码是唯一真相，图是派生物」这个主线的具体操作：
build 让图跟上源码，sync 让源码跟上在图里改过的注解。
"""

import argparse
import os
import sys

from .adopt import adopt_foreign
from .codegen import sync_source
from .drawio import apply_layout, read_layout, to_drawio
from .parse import parse_any
from .svg import to_svg

# 同名不同扩展名 = 同一个模块（dsp.h 与 dsp.c 是一个模块的两个面）。
_SIBLING_EXTS = (".h", ".c", ".hpp", ".cpp", ".cc", ".cs")


def _module_stem(path):
    """模块名：文件名去掉扩展名。"""
    return os.path.splitext(os.path.basename(path))[0]


def _expand_modules(files):
    """给一个文件，就把它同名的兄弟文件一起带上。

    ``build dsp.h`` 和 ``build dsp.c`` 都应当指「dsp 这个模块」——用户不该为了
    画一张图而把同一个模块的两个扩展名都写出来。找不到兄弟文件时原样保留。
    """
    seen, out = set(), []
    for f in files:
        d = os.path.dirname(os.path.abspath(f))
        stem = _module_stem(f)
        sibs = [os.path.join(d, stem + e) for e in _SIBLING_EXTS]
        sibs = [p for p in sibs if os.path.exists(p)] or [os.path.abspath(f)]
        for p in sibs:
            key = os.path.normcase(os.path.abspath(p))
            if key not in seen:
                seen.add(key)
                out.append(p)
    return out


def _default_out(path):
    """模块旁的 ``<模块名>.drawio``。"""
    return os.path.splitext(os.path.abspath(path))[0] + ".drawio"


def _plan_build(files, out, merge):
    """决定产出几张图、各自包含哪些文件、写到哪里。

    默认**一个模块一张图**：把不相干的模块硬塞进一张图，读的人得先在一堆框里
    找自己要的那块。只有 ``--merge`` 才合成一张总览图。
    """
    if merge:
        return [{"files": files, "out": os.path.abspath(out or "flow.drawio"), "name": None}]

    modules = {}
    for f in files:
        modules.setdefault(_module_stem(f), []).append(f)

    if len(modules) == 1:
        name, members = next(iter(modules.items()))
        return [{"files": members, "out": os.path.abspath(out or _default_out(members[0])), "name": name}]

    if out:
        raise SystemExit(
            "--out names a single file, but %d modules were given: %s\n"
            "Leave --out off to get one .drawio per module (next to each module),\n"
            "or pass --merge to put them all in one file."
            % (len(modules), ", ".join(sorted(modules)))
        )
    return [
        {"files": members, "out": _default_out(members[0]), "name": name}
        for name, members in sorted(modules.items())
    ]


def main(argv=None):
    """解析参数并分派到 build 或 sync；返回进程退出码。"""
    ap = argparse.ArgumentParser(
        prog="drawcode",
        description="Source code is the single source of truth; the diagram is a derived view.",
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="source code -> .drawio")
    b.add_argument("files", nargs="+")
    b.add_argument("--root", default=None, help="path base, defaults to the first file's directory")
    b.add_argument("--out", default=None, help="output file; only valid when a single module is given (default: <module>.drawio next to its source)")
    b.add_argument("--merge", action="store_true", help="write all modules into one .drawio instead of one diagram per module")
    b.add_argument("--layout-from", default=None, help="reuse the hand-made layout in an existing .drawio")
    b.add_argument("--svg", default=None, help="also export a read-only SVG (same coordinates as the .drawio)")

    s = sub.add_parser("sync", help=".drawio -> source code (declaration layer only)")
    s.add_argument("drawio")
    s.add_argument("files", nargs="+")
    s.add_argument("--root", default=None)
    s.add_argument("--write", action="store_true", help="actually write; without it this is a dry run")

    a = ap.parse_args(argv)

    # root 只在计算相对路径时用到；缺省取第一个文件所在目录
    root = a.root
    if root is None and a.files:
        root = os.path.dirname(os.path.abspath(a.files[0]))

    if a.cmd == "build":
        files = _expand_modules(a.files)
        plans = _plan_build(files, a.out, a.merge)
        if len(plans) > 1 and (a.layout_from or a.svg):
            # 这两个选项都是「针对一张图」的：布局只有一个，SVG 也只有一个文件名。
            # 多模块时静默只作用于第一张图才是最坏的做法。
            raise SystemExit(
                "%d modules given, so %d diagrams would be written; --layout-from and --svg\n"
                "only make sense for a single diagram. Narrow the file list, or pass --merge."
                % (len(plans), len(plans))
            )
        for plan in plans:
            model = parse_any(plan["files"], root=root)
            if a.layout_from:
                # 这里的两个守卫都是「宁可报错也不静默」：
                # 用户显式传了 --layout-from 就是想复用排版，拿到空布局却继续跑的话，
                # 所有节点会静默落在 0,0，看起来像「工具把我的排版弄丢了」。
                if not os.path.exists(a.layout_from):
                    raise SystemExit("--layout-from: no such file: %s" % a.layout_from)
                with open(a.layout_from, encoding="utf-8") as fh:
                    layout = read_layout(fh.read())
                if not layout["nodes"]:
                    raise SystemExit(
                        "--layout-from: %s holds no drawcode nodes, so there is no layout to reuse.\n"
                        "Only a .drawio written by drawcode (or edited from one) carries the symbolId\n"
                        "on each node. A diagram drawn by hand in draw.io cannot be used here."
                        % a.layout_from
                    )
                apply_layout(model, layout)
            xml = to_drawio(model)
            out = plan["out"]
            os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
            # newline="" 很关键：不让 Python 把 \n 翻译成 \r\n，否则产物哈希随平台变化
            with open(out, "w", encoding="utf-8", newline="") as fh:
                fh.write(xml)
            svg_note = ""
            if a.svg:
                svg_out = os.path.abspath(a.svg)
                os.makedirs(os.path.dirname(svg_out) or ".", exist_ok=True)
                with open(svg_out, "w", encoding="utf-8", newline="") as fh:
                    fh.write(to_svg(model))
                svg_note = " + " + svg_out
            print(
                "signals=%d funcs=%d edges=%d -> %s%s"
                % (len(model.signals), len(model.funcs), len(model.edges), out, svg_note)
            )
        return 0

    # ---- sync：图 -> 源码 ----
    with open(a.drawio, encoding="utf-8") as fh:
        layout = read_layout(fh.read(), include_foreign=True)
    if not layout["nodes"] and not layout["edges"]:
        # 同上：手工图没有 symbolId，没有任何可回写的东西，必须说清楚而不是假装成功
        raise SystemExit(
            "%s holds no drawcode cells, so there is nothing to write back.\n"
            "Only a .drawio written by drawcode (or edited from one) carries the symbolId\n"
            "that identifies each node." % a.drawio
        )
    model = parse_any(a.files, root=root)
    # 先把图里的坐标套回 IR，再回写声明层——排版信息不会丢
    apply_layout(model, layout)

    # 图里有、源码里没有的元素（用户在 draw.io 里新加的）接回 IR，
    # 这样 codegen 的 missing 分支才能把它们写进源码。定不下来的只报告、不猜。
    added, problems = adopt_foreign(model, layout, root)
    for note in problems:
        print("note: %s" % note)
    if added:
        print("adopted %d element(s) added in the diagram: %s" % (len(added), ", ".join(added)))

    if not a.write:
        # 默认 dry-run：回写会改用户的源码，先让人看清楚读到了什么
        print(
            "dry-run: %d nodes / %d edges read back; pass --write to apply"
            % (len(layout["nodes"]), len(layout["edges"]))
        )
        return 0

    changed = []
    for path in a.files:
        # IR 里的 file 字段统一用正斜杠，回写时按同样的规则算 rel，两边才能对上
        rel = os.path.relpath(os.path.abspath(path), os.path.abspath(root)).replace("\\", "/")
        if sync_source(path, model, rel):
            changed.append(rel)
    print("updated: %s" % (", ".join(changed) if changed else "(no change)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
