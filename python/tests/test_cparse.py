import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
_REPO = os.path.dirname(ROOT)

from drawcode.cparse import parse_project

EX = os.path.join(_REPO, "examples", "small", "c")
FILES = [os.path.join(EX, f) for f in ("adc.h", "adc.c", "dsp.h", "dsp.c")]


class TestSignals(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = parse_project(FILES, root=EX)

    def test_signal_set_and_dirs(self):
        self.assertEqual(
            sorted(self.m.signals),
            ["adc.h::g_filtered", "adc.h::g_raw", "dsp.h::g_coeff"],
        )
        self.assertEqual(self.m.signals["adc.h::g_raw"].dir, "in")
        self.assertEqual(self.m.signals["adc.h::g_filtered"].dir, "out")
        self.assertEqual(self.m.signals["dsp.h::g_coeff"].dir, "in")

    def test_signal_types(self):
        self.assertEqual(self.m.signals["adc.h::g_raw"].ctype, "int16_t")
        self.assertEqual(self.m.signals["dsp.h::g_coeff"].ctype, "float[32]")

    def test_signal_annotations(self):
        s = self.m.signals["adc.h::g_raw"]
        self.assertEqual(s.unit, "LSB")
        self.assertEqual(s.alias, "原始采样值")
        self.assertEqual(s.note, "上电后需校准")
        self.assertEqual(s.file, "adc.h")
        self.assertEqual(s.line, 7)
        self.assertEqual(s.group, "adc")


class TestFuncs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = parse_project(FILES, root=EX)

    def test_func_set(self):
        self.assertEqual(
            sorted(self.m.funcs),
            ["adc.h::adc_read", "dsp.h::dsp_set_gain", "dsp.h::fir_apply"],
        )

    def test_func_signature_and_annotation(self):
        f = self.m.funcs["adc.h::adc_read"]
        self.assertEqual(f.ret, "int16_t")
        self.assertEqual(f.alias, "ADC 采样")
        self.assertEqual(f.tooltip, "上电后需先校准")
        self.assertEqual((f.x, f.y, f.w, f.h), (420.0, 160.0, 180.0, 72.0))
        self.assertEqual(f.line, 14)
        self.assertEqual(f.group, "adc")

    def test_params_are_ports_not_nodes(self):
        f = self.m.funcs["dsp.h::dsp_set_gain"]
        self.assertEqual([p.name for p in f.params], ["gain"])
        self.assertEqual(f.params[0].ctype, "uint8_t")
        self.assertEqual(f.params[0].dir, "in")

    def test_def_use_from_body(self):
        f = self.m.funcs["adc.h::adc_read"]
        self.assertEqual(sorted(f.reads), ["adc.h::g_raw"])
        self.assertEqual(sorted(f.writes), ["adc.h::g_filtered"])
        self.assertEqual(f.calls, ["dsp.h::fir_apply"])

    def test_def_use_with_expression_and_array(self):
        f = self.m.funcs["dsp.h::fir_apply"]
        self.assertEqual(sorted(f.reads), ["adc.h::g_raw", "dsp.h::g_coeff"])
        self.assertEqual(sorted(f.writes), ["adc.h::g_filtered"])

    def test_def_use_on_array_element_write(self):
        f = self.m.funcs["dsp.h::dsp_set_gain"]
        self.assertEqual(f.writes, ["dsp.h::g_coeff"])
        self.assertEqual(f.reads, [])

    def test_locals_not_in_graph(self):
        names = set()
        for f in self.m.funcs.values():
            names.update(f.reads)
            names.update(f.writes)
        self.assertNotIn("adc.c::v", names)
        self.assertNotIn("dsp.c::i", names)


class TestDevices(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = parse_project(FILES, root=EX)

    def test_device_attached_to_func(self):
        d = self.m.devices["adc.h::adc_read"]
        self.assertEqual(d.vendor, "TI")
        self.assertEqual(d.model, "ADS1115")
        self.assertEqual(d.spec, "16bit/860SPS")
        self.assertEqual(d.size, "2.0x3.0mm")
        self.assertEqual(d.asset, "assets/ads1115.svg")


class TestEdges(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = parse_project(FILES, root=EX)

    def test_edges(self):
        got = sorted((e.src, e.dst, e.rw) for e in self.m.edges)
        self.assertIn(("adc.h::g_raw", "adc.h::adc_read", "read"), got)
        self.assertIn(("adc.h::adc_read", "adc.h::g_filtered", "write"), got)
        self.assertIn(("dsp.h::g_coeff", "dsp.h::fir_apply", "read"), got)
        self.assertIn(("dsp.h::fir_apply", "adc.h::g_filtered", "write"), got)
        self.assertEqual(len(got), 6)


if __name__ == "__main__":
    unittest.main()
