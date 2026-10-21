import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
_REPO = os.path.dirname(ROOT)

from drawcode.codegen import render_cs_drawcode, sync_cs_source, sync_source
from drawcode.csparse import parse_cs_project
from drawcode.model import Signal

EX = os.path.join(_REPO, "examples", "small", "cs")
NAMES = ("Adc.cs", "Dsp.cs")


class TestCsCodegen(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        for f in NAMES:
            shutil.copy(os.path.join(EX, f), os.path.join(self.dir, f))
        self.paths = [os.path.join(self.dir, f) for f in NAMES]
        self.model = parse_cs_project(self.paths, root=self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def read(self, name):
        with open(os.path.join(self.dir, name), encoding="utf-8") as fh:
            return fh.read()

    def test_render_cs_annotation(self):
        s = Signal(id="x::g", name="g", ctype="short", dir="in", alias="A", unit="LSB", note="N")
        self.assertEqual(
            render_cs_drawcode(s),
            ['[Drawcode(Direction.In, Unit = "LSB", Alias = "A", Note = "N")]'],
        )

    def test_render_cs_annotation_empty(self):
        self.assertEqual(
            render_cs_drawcode(Signal(id="x::g", name="g", ctype="short", dir="")), []
        )

    def test_sync_is_idempotent(self):
        before = {n: self.read(n) for n in NAMES}
        for p in self.paths:
            sync_cs_source(p, self.model, os.path.basename(p))
        self.assertEqual(before, {n: self.read(n) for n in NAMES})

    def test_alias_update_in_place(self):
        self.model.signals["Adc.cs::g_raw"].alias = "原始值"
        sync_cs_source(self.paths[0], self.model, "Adc.cs")
        text = self.read("Adc.cs")
        self.assertIn('Alias = "原始值"', text)
        self.assertNotIn('Alias = "原始采样值"', text)
        self.assertIn("public static short g_raw;", text)
        self.assertIn("[Drawcode(Direction.In,", text)

    def test_return_signal_is_not_mistaken_for_field(self):
        """`return g_raw;` 在字段正则眼里是 `type=return, name=g_raw`。

        解析侧靠「必须有方向」天然挡住，回写侧只按名字匹配 —— 没有防护时会在方法体里
        插一条 [Drawcode]，把源码写坏。三语言共用同一条回归。
        """
        source = "\n".join([
            "public static class M",
            "{",
            '    [Drawcode(Direction.In, Alias = "原始")]',
            "    public static short g_raw;",
            "",
            '    [Drawcode(Alias = "读原始")]',
            "    public static short ReadRaw()",
            "    {",
            "        return g_raw;",
            "    }",
            "}",
            "",
        ])
        path = os.path.join(self.dir, "Ret.cs")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(source)
        m = parse_cs_project([path], root=self.dir)
        self.assertIn("Ret.cs::g_raw", m.signals)
        self.assertFalse(sync_cs_source(path, m, "Ret.cs"))
        with open(path, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), source)

    def test_direction_flip_rewrites_attribute(self):
        self.model.signals["Adc.cs::g_filtered"].dir = "inout"
        sync_cs_source(self.paths[0], self.model, "Adc.cs")
        self.assertIn("[Drawcode(Direction.Io,", self.read("Adc.cs"))

    def test_sync_source_never_applies_c_macros_to_cs(self):
        for p in self.paths:
            out = sync_source(p, self.model, os.path.basename(p))
            self.assertFalse(out, "原样回写不应有改动: " + p)
        for n in NAMES:
            self.assertNotIn("SIGNAL_", self.read(n))

    def test_new_signal_is_appended_and_reparses(self):
        self.model.add_signal(
            Signal(
                id="Adc.cs::g_alarm",
                name="g_alarm",
                ctype="short",
                dir="out",
                file="Adc.cs",
                alias="报警输出",
            )
        )
        sync_cs_source(self.paths[0], self.model, "Adc.cs")
        text = self.read("Adc.cs")
        self.assertIn("public static short g_alarm;", text)
        self.assertIn("[Drawcode(Direction.Out,", text)
        self.assertIn('Alias = "报警输出"', text)

        again = parse_cs_project(self.paths, root=self.dir)
        self.assertIn("Adc.cs::g_alarm", again.signals)
        self.assertEqual(again.signals["Adc.cs::g_alarm"].dir, "out")

    def test_appended_signal_is_idempotent(self):
        self.model.add_signal(
            Signal(id="Dsp.cs::g_gain", name="g_gain", ctype="float", dir="in", file="Dsp.cs")
        )
        sync_cs_source(self.paths[1], self.model, "Dsp.cs")
        once = self.read("Dsp.cs")
        self.assertFalse(sync_cs_source(self.paths[1], self.model, "Dsp.cs"))
        self.assertEqual(self.read("Dsp.cs"), once)


if __name__ == "__main__":
    unittest.main()
