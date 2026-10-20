"""金标准一致性：IR JSON / .drawio / SVG 三件产物与 ``tests/golden`` 逐字节一致。

对等 TS ``test/conformance.test.ts`` 与 .NET ``ConformanceTests.cs`` 的严格档。

为什么参考实现也要测：金标准是**历史的 Python 实现**生成的，不是手写的。
一次无意的排序改动、一个多出来的空格，都会让金标准过期而没有任何本语言测试报警；
等另外两版对不上时，已经很难判断是哪边错了。这层断言把「参考实现的当前行为」
和「签入仓库的基准」钉在一起，换实现或改产物时先红后绿。
"""

import json
import os
import sys
import unittest
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
# tools/dump_ir.py 是生成金标准的同一个脚本，直接复用它，避免测试里再抄一份口径。
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), "tools"))

from drawcode.drawio import to_drawio  # noqa: E402
from drawcode.parse import parse_any  # noqa: E402
from drawcode.svg import to_svg  # noqa: E402
from dump_ir import dump  # noqa: E402

GOLDEN = os.path.join(os.path.dirname(ROOT), "tests", "golden")


def _cases():
    """所有 golden 用例目录名；一个都没有时直接失败，不能让空循环假装通过。"""
    names = sorted(n for n in os.listdir(GOLDEN) if os.path.isdir(os.path.join(GOLDEN, n)))
    if not names:
        raise AssertionError("no golden cases found — a vacuous pass is not a pass")
    return names


def _read(path):
    # newline="" 保留文件里的原始换行，逐字节比较才有意义
    with open(path, encoding="utf-8", newline="") as fh:
        return fh.read()


def _svg_shape(text):
    """把 SVG 归一化成可比较的形状：标签计数、文字列表、坐标序列。

    TS 侧 ``svgShape()`` 的同构实现；与文档一致，SVG 不逐字节比较 ——
    它是渲染产物，浮点拼写和属性顺序都不该被当成语义契约。
    """
    root = ET.fromstring(text)
    counts, texts, coords = {}, [], []
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        # 默认命名空间会让 tag 变成 `{http://www.w3.org/2000/svg}rect`；
        # TS 的解析器保留裸标签名，这里剥掉前缀才能得到同一套计数。
        tag = el.tag.rsplit("}", 1)[-1]
        counts[tag] = counts.get(tag, 0) + 1
        if tag in ("text", "tspan"):
            value = (el.text or "").strip()
            if value:
                texts.append(value)
        for key in ("x", "y", "cx", "cy", "rx", "ry", "width", "height"):
            raw = el.get(key)
            if raw:
                try:
                    coords.append(float(raw))
                except ValueError:
                    pass
    return counts, texts, coords


class TestGoldenConformance(unittest.TestCase):
    def test_cases_exist(self):
        self.assertGreater(len(_cases()), 0, "no golden cases found")

    def test_artifacts_are_byte_identical(self):
        for name in _cases():
            with self.subTest(case=name):
                case_dir = os.path.join(GOLDEN, name)
                inp = os.path.join(case_dir, "input")
                files = [os.path.join(inp, f) for f in sorted(os.listdir(inp))]
                model = parse_any(files, root=inp)

                # L1：规范化 IR JSON。缩进、键序、末尾换行都按 dump_ir.py 的口径来。
                ir = json.dumps(dump(model), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
                self.assertEqual(
                    ir,
                    _read(os.path.join(case_dir, "expected.ir.json")),
                    "IR JSON drifted from the golden; regenerate with tools/dump_ir.py only for an intended change",
                )

                # L2/L3：图结构与几何。这里更严——连属性顺序和浮点拼写都要一致。
                self.assertEqual(
                    to_drawio(model),
                    _read(os.path.join(case_dir, "expected.drawio")),
                    ".drawio drifted from the golden",
                )

                # 预览图按文档口径只比结构：标签计数、文字内容、坐标个数与 0.5 容差。
                # （docs/conformance.md：SVG 是渲染产物，不参与逐字节比较。）
                got = _svg_shape(to_svg(model))
                expected = _svg_shape(_read(os.path.join(case_dir, "preview.svg")))
                self.assertEqual(got[0], expected[0], "SVG tag counts drifted")
                self.assertEqual(got[1], expected[1], "SVG texts drifted")
                self.assertEqual(len(got[2]), len(expected[2]), "SVG coordinate count drifted")
                for i, (value, other) in enumerate(zip(got[2], expected[2])):
                    self.assertLessEqual(abs(value - other), 0.5, "SVG coord[%d]: %r vs %r" % (i, value, other))


if __name__ == "__main__":
    unittest.main()
