import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
_REPO = os.path.dirname(ROOT)

from drawcode.csparse import parse_cs_project

EX = os.path.join(_REPO, "examples", "small", "cs")
FILES = [os.path.join(EX, f) for f in ("Adc.cs", "Dsp.cs")]


class TestCsSignals(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = parse_cs_project(FILES, root=EX)

    def test_signal_set_and_dirs(self):
        self.assertEqual(
            sorted(self.m.signals),
            ["Adc.cs::g_filtered", "Adc.cs::g_raw", "Dsp.cs::g_coeff"],
        )
        self.assertEqual(self.m.signals["Adc.cs::g_raw"].dir, "in")
        self.assertEqual(self.m.signals["Adc.cs::g_filtered"].dir, "out")
        self.assertEqual(self.m.signals["Dsp.cs::g_coeff"].dir, "in")

    def test_signal_annotations(self):
        s = self.m.signals["Adc.cs::g_raw"]
        self.assertEqual(s.alias, "原始采样值")
        self.assertEqual(s.unit, "LSB")
        self.assertEqual(s.note, "上电后需校准")
        self.assertEqual(s.file, "Adc.cs")


class TestCsFuncs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = parse_cs_project(FILES, root=EX)

    def test_func_set(self):
        self.assertEqual(sorted(self.m.funcs), ["Adc.cs::AdcRead", "Dsp.cs::FirApply", "Dsp.cs::SetGain"])

    def test_func_annotation_and_device(self):
        f = self.m.funcs["Adc.cs::AdcRead"]
        self.assertEqual(f.ret, "short")
        self.assertEqual(f.alias, "ADC 采样")
        self.assertEqual(f.tooltip, "上电后需先校准")
        d = self.m.devices["Adc.cs::AdcRead"]
        self.assertEqual(d.vendor, "TI")
        self.assertEqual(d.model, "ADS1115")
        self.assertEqual(d.spec, "16bit/860SPS")

    def test_params_are_ports(self):
        f = self.m.funcs["Dsp.cs::SetGain"]
        self.assertEqual([p.name for p in f.params], ["gain"])
        self.assertEqual(f.params[0].ctype, "byte")

    def test_def_use(self):
        f = self.m.funcs["Adc.cs::AdcRead"]
        self.assertEqual(sorted(f.reads), ["Adc.cs::g_raw"])
        self.assertEqual(sorted(f.writes), ["Adc.cs::g_filtered"])
        self.assertEqual(f.calls, ["Dsp.cs::FirApply"])

    def test_def_use_array_element(self):
        f = self.m.funcs["Dsp.cs::SetGain"]
        self.assertEqual(f.writes, ["Dsp.cs::g_coeff"])
        self.assertEqual(f.reads, [])

    def test_edges(self):
        got = sorted((e.src, e.dst, e.rw) for e in self.m.edges)
        self.assertIn(("Adc.cs::g_raw", "Adc.cs::AdcRead", "read"), got)
        self.assertIn(("Adc.cs::AdcRead", "Adc.cs::g_filtered", "write"), got)
        self.assertEqual(len(got), 6)


if __name__ == "__main__":
    unittest.main()
