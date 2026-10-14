import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
_REPO = os.path.dirname(ROOT)

from drawcode.codegen import sync_header
from drawcode.cparse import parse_project
from drawcode.drawio import apply_layout, read_layout, to_drawio
from drawcode.model import Signal

EX = os.path.join(_REPO, "examples", "small", "c")
NAMES = ("adc.h", "adc.c", "dsp.h", "dsp.c")


class TestRoundtrip(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        for f in NAMES:
            shutil.copy(os.path.join(EX, f), os.path.join(self.dir, f))
        self.paths = [os.path.join(self.dir, f) for f in NAMES]

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def parse(self):
        return parse_project(self.paths, root=self.dir)

    def read(self, name):
        with open(os.path.join(self.dir, name), encoding="utf-8") as fh:
            return fh.read()

    def test_code_to_graph_to_code_is_stable(self):
        m1 = self.parse()
        xml = to_drawio(m1)
        m2 = self.parse()
        apply_layout(m2, read_layout(xml))

        for path in self.paths:
            rel = os.path.basename(path)
            sync_header(path, m2, rel)
        first = {n: self.read(n) for n in NAMES}

        m3 = self.parse()
        for path in self.paths:
            rel = os.path.basename(path)
            sync_header(path, m3, rel)
        second = {n: self.read(n) for n in NAMES}

        self.assertEqual(first, second)

    def test_human_layout_survives_and_writes_back_nothing_to_code(self):
        m1 = self.parse()
        xml = to_drawio(m1)

        m2 = self.parse()
        layout = read_layout(xml)
        layout["nodes"]["adc.h::adc_read"] = (900.0, 700.0, 200.0, 80.0)
        apply_layout(m2, layout)

        xml2 = to_drawio(m2)
        m3 = self.parse()
        apply_layout(m3, read_layout(xml2))
        self.assertEqual((m3.funcs["adc.h::adc_read"].x, m3.funcs["adc.h::adc_read"].y), (900.0, 700.0))
        self.assertEqual((m3.funcs["adc.h::adc_read"].w, m3.funcs["adc.h::adc_read"].h), (200.0, 80.0))

        before = self.read("adc.h")
        for path in self.paths:
            sync_header(path, m3, os.path.basename(path))
        self.assertEqual(self.read("adc.h"), before)

    def test_new_node_in_graph_lands_in_header(self):
        m = self.parse()
        m.add_signal(
            Signal(
                id="adc.h::g_alarm",
                name="g_alarm",
                ctype="uint8_t",
                dir="out",
                file="adc.h",
                unit="",
                alias="报警输出",
                group="adc",
            )
        )
        sync_header(os.path.join(self.dir, "adc.h"), m, "adc.h")

        m2 = self.parse()
        self.assertIn("adc.h::g_alarm", m2.signals)
        self.assertEqual(m2.signals["adc.h::g_alarm"].dir, "out")
        self.assertEqual(m2.signals["adc.h::g_alarm"].alias, "报警输出")

        xml = to_drawio(m2)
        root_has = "adc.h::g_alarm" in xml
        self.assertTrue(root_has)

    def test_annotations_survive_code_graph_code(self):
        m = self.parse()
        m.funcs["adc.h::adc_read"].alias = "采集入口"
        m.signals["adc.h::g_raw"].unit = "mV"
        for path in self.paths:
            sync_header(path, m, os.path.basename(path))

        m2 = self.parse()
        self.assertEqual(m2.funcs["adc.h::adc_read"].alias, "ADC 采样")
        self.assertEqual(m2.signals["adc.h::g_raw"].unit, "mV")


if __name__ == "__main__":
    unittest.main()
