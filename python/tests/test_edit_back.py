import os
import shutil
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
_REPO = os.path.dirname(ROOT)

from drawcode.codegen import sync_source
from drawcode.cparse import parse_project
from drawcode.drawio import apply_layout, read_layout, to_drawio

EX = os.path.join(_REPO, "examples", "small", "c")
NAMES = ("adc.h", "adc.c", "dsp.h", "dsp.c")


def edit_like_drawio(xml):
    """用 XML 结构化编辑模拟人在 draw.io 里的四类操作。"""
    tree = ET.fromstring(xml)

    for o in tree.iter("object"):
        sid = o.get("symbolId")
        if sid == "adc.h::g_raw":
            o.set("alias", "原始采样")
            o.set("dir", "out")
        if sid == "adc.h::adc_read":
            g = o.find("mxCell/mxGeometry")
            g.set("x", str(float(g.get("x")) + 100))
            g.set("y", str(float(g.get("y")) + 100))
            g.set("width", "220")
        if o.get("src") == "adc.h::g_raw" and o.get("dst") == "adc.h::adc_read":
            geom = o.find("mxCell/mxGeometry")
            for old in list(geom.findall("Array")):
                geom.remove(old)
            arr = ET.SubElement(geom, "Array")
            arr.set("as", "points")
            p = ET.SubElement(arr, "mxPoint")
            p.set("x", "180")
            p.set("y", "150")

    return ET.tostring(tree, encoding="unicode")


class TestEditBack(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        for f in NAMES:
            shutil.copy(os.path.join(EX, f), os.path.join(self.dir, f))
        self.paths = [os.path.join(self.dir, f) for f in NAMES]

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def read(self, name):
        with open(os.path.join(self.dir, name), encoding="utf-8") as fh:
            return fh.read()

    def parse(self):
        return parse_project(self.paths, root=self.dir)

    def test_edited_drawio_flows_back_into_code(self):
        xml = to_drawio(self.parse())
        self.assertIn('alias="原始采样值"', xml)
        self.assertIn('dir="in"', xml)
        self.assertIn("int16_t g_raw;", self.read("adc.h"))

        edited = edit_like_drawio(xml)
        layout = read_layout(edited)
        m = self.parse()
        apply_layout(m, layout)

        for p in self.paths:
            sync_source(p, m, os.path.basename(p))

        header = self.read("adc.h")
        self.assertIn('alias="原始采样"', header)
        self.assertNotIn('alias="原始采样值"', header)
        self.assertIn("dir=out", header)
        self.assertNotIn("dir=in", header)
        self.assertIn("#include <stdint.h>", header)

    def test_edited_layout_survives_and_edge_got_waypoints(self):
        xml = to_drawio(self.parse())
        before = read_layout(xml)["nodes"]["adc.h::adc_read"]
        layout = read_layout(edit_like_drawio(xml))
        after = layout["nodes"]["adc.h::adc_read"]

        self.assertEqual(after[0], before[0] + 100)
        self.assertEqual(after[1], before[1] + 100)
        self.assertEqual(after[2], 220.0)

        # mxPoint 与 mousGeometry 同在父容器坐标系里，回读时统一还原成画布绝对坐标
        root = ET.fromstring(xml)
        rel = [
            o.find("mxCell/mxGeometry")
            for o in root.iter("object")
            if o.get("symbolId") == "adc.h::adc_read"
        ][0]
        ox = before[0] - float(rel.get("x"))
        oy = before[1] - float(rel.get("y"))

        key = "adc.h::g_raw->adc.h::adc_read:read"
        self.assertEqual(layout["edges"][key], [(180.0 + ox, 150.0 + oy)])

    def test_roundtrip_after_edit_is_stable(self):
        xml = to_drawio(self.parse())
        m1 = self.parse()
        apply_layout(m1, read_layout(edit_like_drawio(xml)))
        for p in self.paths:
            sync_source(p, m1, os.path.basename(p))
        first = {n: self.read(n) for n in NAMES}

        for p in self.paths:
            sync_source(p, self.parse(), os.path.basename(p))
        self.assertEqual(first, {n: self.read(n) for n in NAMES})

    def test_editing_a_file_drawio_on_disk(self):
        """走一遍真实路径：生成文件 -> 改文件 -> 从磁盘读回 -> 回写代码。"""
        path = os.path.join(self.dir, "g.drawio")
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(to_drawio(self.parse()))
        with open(path, encoding="utf-8") as fh:
            edited = edit_like_drawio(fh.read())
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(edited)

        with open(path, encoding="utf-8") as fh:
            layout = read_layout(fh.read())
        m = self.parse()
        apply_layout(m, layout)
        sync_source(os.path.join(self.dir, "adc.h"), m, "adc.h")

        self.assertIn("dir=out", self.read("adc.h"))


if __name__ == "__main__":
    unittest.main()
