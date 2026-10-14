import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
_REPO = os.path.dirname(ROOT)

from drawcode.codegen import render_signal, sync_functions, sync_header
from drawcode.cparse import parse_project
from drawcode.model import Signal

EX = os.path.join(_REPO, "examples", "small", "c")
FILES = [os.path.join(EX, f) for f in ("adc.h", "adc.c", "dsp.h", "dsp.c")]


class TestRender(unittest.TestCase):
    def test_render_signal_with_array_and_annotation(self):
        s = Signal(id="x.h::g_new", name="g_new", ctype="float[8]", dir="out", unit="V", alias="新信号")
        text = render_signal(s)
        self.assertEqual(
            text,
            '/// @drawcode dir=out unit="V" alias="新信号"\nfloat g_new[8];',
        )

    def test_render_signal_minimal(self):
        s = Signal(id="x.h::g_a", name="g_a", ctype="uint8_t", dir="in")
        self.assertEqual(render_signal(s), '/// @drawcode dir=in\nuint8_t g_a;')


class SyncBase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        for f in ("adc.h", "adc.c", "dsp.h", "dsp.c"):
            shutil.copy(os.path.join(EX, f), os.path.join(self.dir, f))
        self.path = os.path.join(self.dir, "adc.h")
        self.model = parse_project(
            [os.path.join(self.dir, f) for f in ("adc.h", "adc.c", "dsp.h", "dsp.c")],
            root=self.dir,
        )

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def read(self):
        with open(self.path, encoding="utf-8") as fh:
            return fh.read()


class TestSyncHeader(SyncBase):
    def test_sync_is_idempotent(self):
        before = self.read()
        sync_header(self.path, self.model, "adc.h")
        self.assertEqual(self.read(), before)

    def test_sync_updates_alias_in_place(self):
        self.model.signals["adc.h::g_raw"].alias = "改名后的采样值"
        sync_header(self.path, self.model, "adc.h")
        text = self.read()
        self.assertIn('alias="改名后的采样值"', text)
        self.assertNotIn('alias="原始采样值"', text)
        self.assertIn("int16_t g_raw;", text)

    def test_sync_appends_new_signal_before_endif(self):
        self.model.add_signal(
            Signal(id="adc.h::g_new", name="g_new", ctype="uint8_t", dir="out", file="adc.h", alias="新增")
        )
        sync_header(self.path, self.model, "adc.h")
        text = self.read()
        self.assertIn("uint8_t g_new;", text)
        self.assertLess(text.index("g_new"), text.index("#endif"))

    def test_sync_leaves_other_code_untouched(self):
        self.model.signals["adc.h::g_raw"].note = ""
        sync_header(self.path, self.model, "adc.h")
        text = self.read()
        self.assertIn("#include <stdint.h>", text)
        self.assertNotIn("drawcode_signals.h", text)
        self.assertIn("int16_t adc_read(void);", text)
        self.assertIn("#ifndef ADC_H", text)


class TestSyncFunctions(SyncBase):
    def test_untouched_file_is_unchanged(self):
        before = self.read()
        sync_functions(self.path, self.model, "adc.h")
        self.assertEqual(self.read(), before)

    def test_alias_update_keeps_handwritten_layout_attrs(self):
        self.model.funcs["adc.h::adc_read"].alias = "采集入口"
        sync_functions(self.path, self.model, "adc.h")
        text = self.read()
        self.assertIn('alias="采集入口"', text)
        self.assertNotIn('alias="ADC 采样"', text)
        self.assertIn('xy="420,160"', text)
        self.assertIn('size="180x72"', text)
        self.assertIn("int16_t adc_read(void);", text)
        self.assertIn('vendor="TI"', text)
        self.assertIn('asset="assets/ads1115.svg"', text)

    def test_device_annotation_rewritten(self):
        self.model.devices["adc.h::adc_read"].spec = "16bit/2kSPS"
        sync_functions(self.path, self.model, "adc.h")
        self.assertIn('spec="16bit/2kSPS"', self.read())

    def test_sync_functions_is_idempotent_after_edit(self):
        self.model.funcs["adc.h::adc_read"].note = "待确认中断上下文"
        sync_functions(self.path, self.model, "adc.h")
        once = self.read()
        sync_functions(self.path, self.model, "adc.h")
        self.assertEqual(self.read(), once)


if __name__ == "__main__":
    unittest.main()
