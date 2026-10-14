"""生成规模可调的 C / C# 示例工程，用于性能基准与压力验证。

生成物不入库（见 .gitignore），因为一条命令就能重建；规模与 seed 固定，保证基准可复现。

用法:
    python examples/large/generate.py --modules 60 --signals 12 --funcs 8 --out examples/large/c
    python examples/large/generate.py --lang cs --modules 60 --signals 12 --funcs 8 --out examples/large/cs
"""
import argparse
import os
import random


def gen_c(root, modules, signals, funcs, seed):
    rng = random.Random(seed)
    for m in range(modules):
        mod = "mod%03d" % m
        d = os.path.join(root, mod)
        os.makedirs(d, exist_ok=True)

        # 每个模块读上一模块的两个信号，制造跨容器边
        prev = "mod%03d" % (m - 1) if m > 0 else None

        h = ["#ifndef %s_H" % mod.upper(), "#define %s_H" % mod.upper(), "",
             '#include <stdint.h>', ""]
        for s in range(signals):
            names = ("g_%s_s%d" % (mod, s), "float", "coeff", "signal %d of %s" % (s, mod))
            h.append('/// @drawcode dir=in unit="%s" alias="%s"' % (names[2], names[3]))
            h.append("%s %s;" % (names[1], names[0]))
            h.append("")
        for f in range(funcs):
            h.append("void %s_f%d(void);" % (mod, f))
        h.append("")
        h.append("#endif")
        with open(os.path.join(d, mod + ".h"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(h) + "\n")

        c = ['#include "%s.h"' % mod]
        if prev:
            c.append('#include "../%s/%s.h"' % (prev, prev))
        c.append("")
        for f in range(funcs):
            body = ["void %s_f%d(void) {" % (mod, f)]
            # 读 2~3 个本模块信号
            for s in rng.sample(range(signals), min(3, signals)):
                body.append("    (void)g_%s_s%d;" % (mod, s))
            # 跨模块读
            if prev:
                body.append("    (void)g_%s_s%d;" % (prev, rng.randrange(signals)))
            # 写 1 个信号
            body.append("    g_%s_s%d = %d;" % (mod, rng.randrange(signals), f))
            body.append("}")
            body.append("")
            c.extend(body)
        with open(os.path.join(d, mod + ".c"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(c) + "\n")

    return modules * (signals + funcs), modules * funcs


def gen_cs(root, modules, signals, funcs, seed):
    rng = random.Random(seed + 1)
    os.makedirs(root, exist_ok=True)
    for m in range(modules):
        mod = "Mod%03d" % m
        prev = "Mod%03d" % (m - 1) if m > 0 else None
        lines = ["using System;", "", "namespace Drawcode.Large", "{",
                 "    public static class %s" % mod, "    {"]
        for s in range(signals):
            lines.append('        [Drawcode(Direction.In, Unit = "coeff", Alias = "signal %d of %s")]' % (s, mod))
            lines.append("        public static float G_%s_S%d;" % (mod, s))
            lines.append("")
        for f in range(funcs):
            # module-prefixed: every module shares one namespace, so a bare `F0` would collide
            lines.append("        public static void %s_F%d()" % (mod, f))
            lines.append("        {")
            for s in rng.sample(range(signals), min(3, signals)):
                lines.append("            _ = G_%s_S%d;" % (mod, s))
            if prev:
                lines.append("            _ = %s.G_%s_S%d;" % (prev, prev, rng.randrange(signals)))
            lines.append("            G_%s_S%d = %d;" % (mod, rng.randrange(signals), f))
            lines.append("        }")
            lines.append("")
        lines.extend(["    }", "}"])
        with open(os.path.join(root, mod + ".cs"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(lines) + "\n")

    return modules * (signals + funcs), modules * funcs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", choices=["c", "cs"], default="c")
    ap.add_argument("--modules", type=int, default=40)
    ap.add_argument("--signals", type=int, default=10)
    ap.add_argument("--funcs", type=int, default=6)
    ap.add_argument("--seed", type=int, default=20261014)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    if a.lang == "c":
        ents, fns = gen_c(a.out, a.modules, a.signals, a.funcs, a.seed)
    else:
        ents, fns = gen_cs(a.out, a.modules, a.signals, a.funcs, a.seed)

    print(
        "lang=%s modules=%d entities=%d funcs=%d -> %s"
        % (a.lang, a.modules, ents, fns, os.path.abspath(a.out))
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
