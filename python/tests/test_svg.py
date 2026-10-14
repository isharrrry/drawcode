import os
import sys
import unittest
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
_REPO = os.path.dirname(ROOT)

from drawcode.cparse import parse_project
from drawcode.svg import to_svg

EX = os.path.join(_REPO, "examples", "small", "c")
FILES = [os.path.join(EX, f) for f in ("adc.h", "adc.c", "dsp.h", "dsp.c")]
SVG_NS = "{http://www.w3.org/2000/svg}"


def model():
    return parse_project(FILES, root=EX)


class TestSvg(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = model()
        cls.svg = to_svg(cls.m)
        cls.root = ET.fromstring(cls.svg)

    def test_well_formed_with_viewbox(self):
        self.assertEqual(self.root.tag, SVG_NS + "svg")
        vb = self.root.get("viewBox")
        self.assertIsNotNone(vb)
        self.assertEqual(len(vb.split()), 4)

    def test_every_symbol_has_a_label(self):
        text = "".join(t.text or "" for t in self.root.iter(SVG_NS + "tspan"))
        for token in ("g_raw", "g_filtered", "g_coeff", "adc_read", "fir_apply", "dsp_set_gain"):
            self.assertIn(token, text)

    def test_container_titles_present(self):
        text = "".join(t.text or "" for t in self.root.iter(SVG_NS + "text"))
        self.assertIn("adc", text)
        self.assertIn("dsp", text)

    def test_one_shape_per_node_and_one_path_per_edge(self):
        shapes = list(self.root.iter(SVG_NS + "ellipse")) + [
            e for e in self.root.iter(SVG_NS + "rect") if e.get("data-kind") == "func"
        ]
        self.assertEqual(len(shapes), 6)
        paths = [p for p in self.root.iter(SVG_NS + "path") if p.get("data-edge")]
        self.assertEqual(len(paths), 6)

    def test_waypoints_reach_the_path(self):
        m = model()
        m.edges[0].waypoints = [(700.0, 500.0)]
        svg = to_svg(m)
        self.assertIn("700", svg)
        self.assertIn("500", svg)

    def test_external_func_is_dashed(self):
        m = model()
        m.funcs["dsp.h::fir_apply"].external = True
        svg = to_svg(m)
        self.assertIn("stroke-dasharray", svg)


if __name__ == "__main__":
    unittest.main()
