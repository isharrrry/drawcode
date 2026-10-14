import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
_REPO = os.path.dirname(ROOT)

from drawcode import adopt
from drawcode.cparse import parse_project
from drawcode.drawio import read_layout, to_drawio

EX = os.path.join(_REPO, "examples", "small", "c")
FILES = ["adc.h", "adc.c", "dsp.h", "dsp.c"]


def model(root=EX, names=FILES):
    return parse_project([os.path.join(root, n) for n in names], root=root)


def cell(cid, label, style, parent, x=40.0, y=200.0):
    return (
        '        <mxCell id="%s" value="%s" style="%s" vertex="1" parent="%s">\n'
        '          <mxGeometry x="%s" y="%s" width="160" height="60" as="geometry" />\n'
        "        </mxCell>\n" % (cid, label, style, parent, x, y)
    )


def diagram_with(*cells):
    """画一张我们自己的图，再往里塞若干用户手画的元素。"""
    xml = to_drawio(model())
    inject = "".join(cells)
    return xml.replace("</mxGraphModel>", inject + "      </mxGraphModel>", 1)


class TestClassify(unittest.TestCase):
    """形状决定它是变量还是函数 —— 用户照着现有节点画就能被认出来。"""

    def test_pentagon_and_ellipse_are_signals(self):
        self.assertEqual("signal", adopt.classify("shape=path;path=45,0 160,0;"))
        self.assertEqual("signal", adopt.classify("shape=ellipse;"))

    def test_bare_ellipse_is_a_signal_too(self):
        """draw.io 自己的椭圆 style 是**裸词** `ellipse;`，不是 `shape=ellipse`。

        只有 drawcode 生成时才会写成 `shape=ellipse`。只认后者的话，用户在工具栏上
        随手画的椭圆会被判成函数、悄悄写进 .c —— 元素去了一个谁也想不到的地方。
        """
        self.assertEqual("signal", adopt.classify("ellipse;whiteSpace=wrap;html=1;"))
        self.assertEqual("signal", adopt.classify("shape=ellipse;whiteSpace=wrap;html=1;"))

    def test_anything_else_is_a_func(self):
        self.assertEqual("func", adopt.classify("rounded=1;whiteSpace=wrap;"))
        self.assertEqual("func", adopt.classify(""))

    def test_direction_comes_from_the_pentagon_orientation(self):
        self.assertEqual("in", adopt.direction("shape=path;direction=east;"))
        self.assertEqual("out", adopt.direction("shape=path;direction=west;"))
        self.assertEqual("", adopt.direction("shape=path;"))


class TestParseLabel(unittest.TestCase):
    def test_typed_signal(self):
        self.assertEqual(("int16_t", "g_alarm", None), adopt.parse_label("int16_t g_alarm"))

    def test_untyped_signal_leaves_ctype_empty(self):
        self.assertEqual(("", "g_unknown", None), adopt.parse_label("g_unknown"))

    def test_function_signature(self):
        ctype, name, params = adopt.parse_label("void dsp_reset(void)")
        self.assertEqual(("void", "dsp_reset", "void"), (ctype, name, params))

    def test_function_with_params(self):
        ctype, name, params = adopt.parse_label("int fir(int a, int b)")
        self.assertEqual(("int", "fir", "int a, int b"), (ctype, name, params))


class TestForeignDetection(unittest.TestCase):
    def test_containers_are_not_mistaken_for_user_elements(self):
        """容器是 swimlane，天生没有 symbolId —— 但它不是用户新加的元素。"""
        lay = read_layout(to_drawio(model()), include_foreign=True)
        self.assertEqual({}, {c["cell_id"]: c for c in lay["foreign"]})

    def test_a_hand_drawn_shape_is_detected(self):
        xml = diagram_with(cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1"))
        lay = read_layout(xml, include_foreign=True)
        self.assertEqual(1, len(lay["foreign"]))
        # label 是节点上原样的文字，类型解析留给 adopt
        self.assertEqual("int16_t g_alarm", lay["foreign"][0]["label"])
        self.assertEqual("adc", lay["foreign"][0]["container"])

    def test_foreign_cells_are_off_by_default(self):
        """默认不返回，--layout-from 那类调用方只关心既有节点。"""
        lay = read_layout(diagram_with(cell("u1", "x", "rounded=1;", "grp1")))
        self.assertNotIn("foreign", lay)


class TestAdopt(unittest.TestCase):
    def test_signal_goes_to_the_header_of_its_container(self):
        xml = diagram_with(cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1"))
        m = model()
        added, problems = adopt.adopt_foreign(m, read_layout(xml, include_foreign=True), EX)
        self.assertEqual(["adc.h::g_alarm"], added)
        self.assertEqual("adc.h", m.signals["adc.h::g_alarm"].file)
        self.assertEqual("in", m.signals["adc.h::g_alarm"].dir)
        self.assertEqual([], problems)

    def test_function_goes_to_the_sibling_c_file_not_the_header(self):
        """函数实现属于 .c；写进 .h 是错的。"""
        xml = diagram_with(cell("u3", "void dsp_reset(void)", "rounded=1;", "grp2"))
        m = model()
        added, _ = adopt.adopt_foreign(m, read_layout(xml, include_foreign=True), EX)
        self.assertEqual(["dsp.c::dsp_reset"], added)
        self.assertEqual("dsp.c", m.funcs["dsp.c::dsp_reset"].file)

    def test_untyped_signal_is_adopted_but_reported(self):
        xml = diagram_with(cell("u2", "g_unknown", "shape=ellipse;", "grp2"))
        m = model()
        added, problems = adopt.adopt_foreign(m, read_layout(xml, include_foreign=True), EX)
        self.assertEqual(["dsp.h::g_unknown"], added)
        self.assertEqual("", m.signals["dsp.h::g_unknown"].ctype)
        self.assertTrue(any("认不出类型" in p for p in problems))

    def test_element_outside_any_container_is_reported_not_guessed(self):
        xml = diagram_with(cell("u4", "floating", "rounded=1;", "1"))
        m = model()
        added, problems = adopt.adopt_foreign(m, read_layout(xml, include_foreign=True), EX)
        self.assertEqual([], added)
        self.assertTrue(any("不在任何容器里" in p for p in problems))

    def test_nameless_element_gets_an_ordinal_name_and_a_note(self):
        xml = diagram_with(cell("u5", "", "shape=ellipse;", "grp1"))
        m = model()
        added, problems = adopt.adopt_foreign(m, read_layout(xml, include_foreign=True), EX)
        self.assertEqual(["adc.h::new_signal_1"], added)
        self.assertTrue(any("按序号命名" in p for p in problems))


class TestSyncRoundTrip(unittest.TestCase):
    """整条链：图里多一个元素 -> sync --write -> 源码真的多出对应的声明/骨架。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        for n in FILES:
            shutil.copy(os.path.join(EX, n), self.tmp)
        self.files = [os.path.join(self.tmp, n) for n in FILES]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _sync(self, *cells):
        from drawcode import cli

        xml = diagram_with(*cells)
        p = os.path.join(self.tmp, "flow.drawio")
        with open(p, "w", encoding="utf-8", newline="") as fh:
            fh.write(xml)
        cli.main(["sync", p] + self.files + ["--root", self.tmp, "--write"])

    def _read(self, name):
        with open(os.path.join(self.tmp, name), encoding="utf-8") as fh:
            return fh.read()

    def test_new_signal_is_written_into_the_header(self):
        self._sync(cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1"))
        text = self._read("adc.h")
        self.assertIn("int16_t g_alarm;", text)
        self.assertIn("dir=in", text)

    def test_new_function_skeleton_is_written_into_the_c_file(self):
        self._sync(cell("u3", "void dsp_reset(void)", "rounded=1;", "grp2"))
        self.assertIn("void dsp_reset(void)", self._read("dsp.c"))
        self.assertNotIn("void dsp_reset(void)", self._read("dsp.h"))

    def test_rerunning_sync_is_idempotent(self):
        """第一轮把新元素写进源码，第二轮它已经在源码里了，不该再追加一次。"""
        self._sync(cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1"))
        first = self._read("adc.h")
        self._sync(cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1"))
        self.assertEqual(first, self._read("adc.h"))
        self.assertEqual(1, self._read("adc.h").count("g_alarm;"))

    def test_untouched_files_are_not_rewritten(self):
        before = self._read("dsp.c")
        self._sync(cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1"))
        self.assertEqual(before, self._read("dsp.c"))

    def test_untyped_signal_lands_in_the_header_not_the_c_file(self):
        """裸词 ellipse 必须被认成信号，否则会被当成函数写进 .c。"""
        self._sync(cell("u9", "g_unknown", "ellipse;whiteSpace=wrap;html=1;", "grp1"))
        self.assertIn("g_unknown", self._read("adc.h"))
        self.assertNotIn("g_unknown", self._read("adc.c"))

    def test_untyped_signal_is_idempotent(self):
        """无类型信号也必须能读回来，否则每轮 sync 都会再追加一次。

        所以合成一个占位类型而不是留空：文件作用域的 `g_unknown;` 不是合法 C，
        而且解析器要求 `<type> <name>;` —— 留空就读不回来，第二次 sync 会把它
        当成「图里新加的元素」。原来的幂等测试用的是**有类型**信号，正好绕开了这条。
        """
        untyped = cell("u9", "g_unknown", "ellipse;whiteSpace=wrap;html=1;", "grp1")
        self._sync(untyped)
        first = self._read("adc.h")
        self.assertIn("int g_unknown;", first)
        self.assertIn("请改成实际类型", first)
        self._sync(untyped)
        self.assertEqual(first, self._read("adc.h"))
        self.assertEqual(1, self._read("adc.h").count("g_unknown;"))


if __name__ == "__main__":
    unittest.main()
