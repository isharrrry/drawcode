"""TS 独有特性移植到 Python 后的对等测试。

覆盖五组行为（与 ``docs/conformance.md`` 的特性清单一一对应）：

  1. 几何读取：``xy`` / ``size`` / ``style`` 在两个前端、两类实体上都读；畸形值静默
     变 NaN（模拟 JS ``Number()``），绝不抛异常；
  2. ``[Callout]``：独立注释层，可挂多块、坐标是画布绝对坐标、认不出的种类退回 text；
  3. 边标签去叠印：平行边的标签被推开时写成 ``_label`` 子单元格 + ``offset``；
  4. sync 几何回写：只有 ``pinned`` 里有的实体才生成/替换 ``xy``/``size``，且是
     **参数级合并** —— 手写 ``style``、紧凑写法 ``Unit="LSB"``、``[Device]`` 行都存活；
  5. 渲染开关：``inline`` / ``cards`` / ``rw_labels`` / ``straight_edges``。

为什么这些用例要单独一个文件：它们钉的是「三实现行为一致」这件事本身，而不是某个
模块的内部结构。改动任何一个前端或渲染器时，先看这里的断言还成不成立。
"""

import math
import os
import re
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

from drawcode.codegen import sync_cs_methods, sync_cs_source, sync_header  # noqa: E402
from drawcode.cparse import parse_project  # noqa: E402
from drawcode.csparse import parse_cs_project  # noqa: E402
from drawcode.drawio import to_drawio  # noqa: E402
from drawcode.model import Callout, Func, Model, PinnedGeom, Signal, collapse_signals  # noqa: E402
from drawcode.parse import parse_any  # noqa: E402
from drawcode.svg import to_svg  # noqa: E402


def _write(directory, name, text):
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    return path


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


class _TempDir(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, name, text):
        return _write(self.dir, name, text)


class TestGeometryParsing(_TempDir):
    def test_c_signal_reads_xy_size_and_style(self):
        self.write("adc.c", (
            '/// @drawcode dir=in xy="10,20" size="100x40" style="fillColor=#ff0000;"\n'
            "int16_t g_a;\n"
        ))
        m = parse_project([os.path.join(self.dir, "adc.c")], root=self.dir)
        s = m.signals["adc.c::g_a"]
        self.assertEqual((s.x, s.y, s.w, s.h), (10.0, 20.0, 100.0, 40.0))
        self.assertEqual(s.style, "fillColor=#ff0000;")

    def test_malformed_geometry_is_nan_not_an_exception(self):
        """JS 的 Number() 对畸形输入返回 NaN；Python 若抛异常，同一份源码三版行为分叉。"""
        self.write("adc.c", (
            '/// @drawcode dir=in xy="0x10,infinity" size="1_0x2"\n'
            "int16_t g_a;\n"
        ))
        m = parse_project([os.path.join(self.dir, "adc.c")], root=self.dir)
        s = m.signals["adc.c::g_a"]
        # 0x10 是 16（Number 认十六进制）；infinity 小写不是 JS 的 Infinity
        self.assertEqual(s.x, 16.0)
        self.assertTrue(math.isnan(s.y))
        # Python 的 float("1_0") 会得到 10，JS 的 Number("1_0") 是 NaN
        self.assertTrue(math.isnan(s.w))
        self.assertEqual(s.h, 2.0)

    def test_cs_func_and_signal_geometry_and_style(self):
        self.write("Adc.cs", (
            "public static class Adc\n"
            "{\n"
            '    [Drawcode(Direction.In, Xy = "5,6", Size = "70x80", Style = "rounded=0;")]\n'
            "    public static short g_x;\n"
            "\n"
            '    [Drawcode(Alias = "采样", Xy = "11,12", Size = "90x50", Style = "fillColor=#fff;")]\n'
            "    public static void Read()\n"
            "    {\n"
            "    }\n"
            "}\n"
        ))
        m = parse_cs_project([os.path.join(self.dir, "Adc.cs")], root=self.dir)
        s = m.signals["Adc.cs::g_x"]
        self.assertEqual((s.x, s.y, s.w, s.h), (5.0, 6.0, 70.0, 80.0))
        self.assertEqual(s.style, "rounded=0;")
        f = m.funcs["Adc.cs::Read"]
        self.assertEqual((f.x, f.y, f.w, f.h), (11.0, 12.0, 90.0, 50.0))
        self.assertEqual(f.style, "fillColor=#fff;")


class TestCalloutParsing(_TempDir):
    def test_callout_attached_to_signal_and_func(self):
        self.write("Adc.cs", (
            "public static class Adc\n"
            "{\n"
            '    [Drawcode(Direction.In)]\n'
            '    [Callout("说明框", Xy = "40,40", Size = "260x60", Style = box, Font = 14)]\n'
            "    public static short g_x;\n"
            "\n"
            '    [Drawcode(Alias = "采样")]\n'
            '    [Device(Vendor = "TI")]\n'
            '    [Callout("图例")]\n'
            "    public static void Read()\n"
            "    {\n"
            "    }\n"
            "}\n"
        ))
        m = parse_cs_project([os.path.join(self.dir, "Adc.cs")], root=self.dir)
        self.assertEqual(len(m.callouts), 2)
        box = m.callouts[0]
        self.assertEqual(box.id, "Adc.cs::g_x#callout1")
        self.assertEqual(box.owner, "Adc.cs::g_x")
        self.assertEqual(box.text, "说明框")
        self.assertEqual(box.shape, "box")
        self.assertEqual((box.x, box.y, box.w, box.h, box.font_size),
                         (40.0, 40.0, 260.0, 60.0, 14.0))
        plain = m.callouts[1]
        self.assertEqual(plain.owner, "Adc.cs::Read")
        # 省略几何时用解析器的默认值：0,0,240x40，字号 0 = 用种类默认
        self.assertEqual((plain.x, plain.y, plain.w, plain.h, plain.font_size),
                         (0.0, 0.0, 240.0, 40.0, 0.0))

    def test_unknown_shape_falls_back_to_text(self):
        self.write("Adc.cs", (
            "[Drawcode(Direction.In)]\n"
            '[Callout("随便", Style = "出格")]\n'
            "public static short g_x;\n"
        ))
        m = parse_cs_project([os.path.join(self.dir, "Adc.cs")], root=self.dir)
        self.assertEqual(m.callouts[0].shape, "text")

    def test_mixed_language_merge_keeps_callouts(self):
        """回归：callouts 是列表而非 Map，混合语言合并时漏了 extend 会静默全丢。"""
        c = self.write("adc.c", (
            '/// @drawcode dir=in\n'
            "int16_t g_a;\n"
        ))
        cs = self.write("Adc.cs", (
            "[Drawcode(Direction.Out)]\n"
            '[Callout("混合图例", Xy = "1,2")]\n'
            "public static short g_b;\n"
        ))
        m = parse_any([c, cs], root=self.dir)
        self.assertEqual([x.text for x in m.callouts], ["混合图例"])


def _inline_model():
    """两个「一写一读」信号 + 一对函数。折叠后应当得到两条 writer -> reader 的直连边。"""
    m = Model()
    m.add_signal(Signal(id="a.c::s1", name="s1", ctype="int16_t", dir="out", unit="u1"))
    m.add_signal(Signal(id="a.c::s2", name="s2", ctype="int16_t", dir="out", unit="u2"))
    m.add_func(Func(
        id="a.c::writer", name="writer", ret="void",
        writes=["a.c::s1", "a.c::s2"], group="a", path="a",
    ))
    m.add_func(Func(
        id="b.c::reader", name="reader", ret="void",
        reads=["a.c::s1", "a.c::s2"], group="b", path="b",
    ))
    m.rebuild_edges()
    return m


class TestInlineAndRenderFlags(unittest.TestCase):
    def test_collapse_only_single_writer_single_reader(self):
        m = _inline_model()
        self.assertEqual(collapse_signals(m), 2)
        self.assertEqual(m.inlined, {"a.c::s1", "a.c::s2"})
        self.assertEqual([(e.src, e.dst, e.rw, e.sig) for e in m.edges], [
            ("a.c::writer", "b.c::reader", "inline", "a.c::s1"),
            ("a.c::writer", "b.c::reader", "inline", "a.c::s2"),
        ])

        # 多一个读者就不折：信号是真正的汇合点
        m2 = _inline_model()
        m2.add_func(Func(id="b.c::reader2", name="reader2", ret="void", reads=["a.c::s1"]))
        m2.rebuild_edges()
        self.assertEqual(collapse_signals(m2), 1)
        self.assertNotIn("a.c::s1", m2.inlined)

        # 自环也不折
        m3 = Model()
        m3.add_signal(Signal(id="x.c::s", name="s", ctype="int"))
        m3.add_func(Func(id="x.c::f", name="f", writes=["x.c::s"], reads=["x.c::s"]))
        m3.rebuild_edges()
        self.assertEqual(collapse_signals(m3), 0)

    def test_inline_edge_replaces_signal_node_and_uses_unit_label(self):
        m = _inline_model()
        collapse_signals(m)
        xml = to_drawio(m)
        # 信号节点不再出现（边上的 sig="…" 属性仍然保留，用于找回语义）
        self.assertNotIn('symbolId="a.c::s1"', xml)
        self.assertIn('rw="inline"', xml)
        self.assertIn('label="u1"', xml)

    def test_cards_render_asset_as_image(self):
        m = Model()
        m.add_func(Func(id="a.c::dev", name="dev", ret="void", asset="assets/dev.svg"))
        self.assertNotIn("shape=image", to_drawio(m))
        cards = to_drawio(m, cards=True)
        self.assertIn("shape=image", cards)
        self.assertIn("image=assets/dev.svg", cards)

    def test_rw_labels_can_be_dropped(self):
        m = Model()
        m.add_signal(Signal(id="a.c::s", name="s", ctype="int"))
        m.add_func(Func(id="a.c::f", name="f", reads=["a.c::s"]))
        m.rebuild_edges()
        self.assertIn('label="read"', to_drawio(m))
        self.assertNotIn('label="read"', to_drawio(m, rw_labels=False))

    def test_straight_edges_drop_auto_bends_but_keep_manual_ones(self):
        m = Model()
        m.add_signal(Signal(id="a.c::s", name="s", ctype="int", group="a", path="a"))
        m.add_func(Func(id="b.c::f", name="f", ret="void", reads=["a.c::s"], group="b", path="b"))
        m.rebuild_edges()
        normal = to_drawio(m)
        self.assertIn("edgeStyle=orthogonalEdgeStyle", normal)
        straight = to_drawio(m, straight_edges=True)
        self.assertIn("edgeStyle=none;html=1;", straight)

        # 人工拐点必须保留：那是人明确放上去的，不被一个样式开关吞掉
        m.edges[0].waypoints = [(100.0, 100.0)]
        self.assertIn('<mxPoint x="100" y="100" />', to_drawio(m, straight_edges=True))

    def test_parallel_labels_are_separated_into_child_cells(self):
        m = _inline_model()
        collapse_signals(m)
        xml = to_drawio(m)
        # 第二条边的标签被推开：写成 _label 子单元格，位移在 offset 上
        self.assertRegex(xml, r'<mxCell id="e\d+_label" value="u\d"')
        self.assertIn('as="offset"', xml)
        self.assertRegex(xml, r'<mxPoint x="0" y="-?\d+(?:\.\d+)?" as="offset" />')


class TestGeometryWriteback(_TempDir):
    def test_c_pinned_geometry_merges_and_keeps_handwritten_style(self):
        header = self.write("adc.h", (
            "#ifndef ADC_H\n#define ADC_H\n\n"
            '/// @drawcode dir=in unit="LSB" style="strokeColor=#123456;"\n'
            "int16_t g_a;\n\n"
            "#endif\n"
        ))
        m = parse_project([header], root=self.dir)
        m.pinned["adc.h::g_a"] = PinnedGeom(xy=[30.0, 302.0], size=[160.0, 60.0])
        self.assertTrue(sync_header(header, m, "adc.h"))
        text = _read(header)
        self.assertIn('xy="30,302" size="160x60"', text)
        self.assertIn('style="strokeColor=#123456;"', text)
        self.assertIn('unit="LSB"', text)
        # 第二次必须零改动 —— 否则每次 sync 都多一个无意义 diff
        self.assertFalse(sync_header(header, m, "adc.h"))

    def test_c_without_pinned_writes_no_geometry(self):
        header = self.write("adc.h", (
            "#ifndef ADC_H\n#define ADC_H\n\n"
            '/// @drawcode dir=in unit="LSB"\n'
            "int16_t g_a;\n\n"
            "#endif\n"
        ))
        m = parse_project([header], root=self.dir)
        self.assertFalse(sync_header(header, m, "adc.h"))
        self.assertNotIn("xy=", _read(header))

    def test_cs_signal_merge_is_argument_level(self):
        src = self.write("Adc.cs", (
            '[Drawcode(Direction.In, Unit="LSB", Style = "rounded=0;")]\n'
            "public static short g_a;\n"
        ))
        m = parse_cs_project([src], root=self.dir)
        m.pinned["Adc.cs::g_a"] = PinnedGeom(xy=[30.0, 302.0], size=[160.0, 60.0])
        self.assertTrue(sync_cs_source(src, m, "Adc.cs"))
        text = _read(src)
        # 紧凑写法 Unit="LSB" 值没变 ⇒ 连空白都不动
        self.assertIn('Unit="LSB"', text)
        self.assertIn('Style = "rounded=0;"', text)
        self.assertIn('Xy = "30,302", Size = "160x60"', text)
        self.assertFalse(sync_cs_source(src, m, "Adc.cs"))

    def test_cs_method_geometry_keeps_device_line_and_signature(self):
        src = self.write("Adc.cs", (
            '[Drawcode(Alias = "采样", Xy = "1,2")]\n'
            '[Device(Vendor = "TI")]\n'
            "public static void Read()\n"
            "{\n"
            "}\n"
        ))
        m = parse_cs_project([src], root=self.dir)
        m.pinned["Adc.cs::Read"] = PinnedGeom(xy=[30.0, 302.0], size=[180.0, 72.0])
        self.assertTrue(sync_cs_methods(src, m, "Adc.cs"))
        text = _read(src)
        self.assertIn('Xy = "30,302"', text)
        self.assertIn('Size = "180x72"', text)
        self.assertIn('Alias = "采样"', text)
        self.assertIn('[Device(Vendor = "TI")]', text)
        self.assertIn("public static void Read()", text)
        # style 永不回写：解析出来的节点样式不是注解层该管的东西
        self.assertNotIn("Style", text)
        self.assertFalse(sync_cs_methods(src, m, "Adc.cs"))

    def test_cs_unmanaged_args_survive_an_unrelated_change(self):
        src = self.write("Adc.cs", (
            '[Drawcode(Direction.In, Unit = "LSB", Note = "旧说明", Handmade = "keep")]\n'
            "public static short g_a;\n"
        ))
        m = parse_cs_project([src], root=self.dir)
        m.signals["Adc.cs::g_a"].alias = "新别名"
        self.assertTrue(sync_cs_source(src, m, "Adc.cs"))
        text = _read(src)
        self.assertIn('Alias = "新别名"', text)
        self.assertIn('Handmade = "keep"', text)
        self.assertIn('Unit = "LSB"', text)


class TestSvgParity(unittest.TestCase):
    def test_callouts_and_inline_labels_reach_the_svg(self):
        m = _inline_model()
        m.add_callout(Callout(
            id="co", text="第一行<br>第二行", owner="a.c::writer",
            shape="box", x=10, y=20, w=240, h=40, font_size=14,
        ))
        collapse_signals(m)
        svg = to_svg(m)
        self.assertIn('data-kind="callout"', svg)
        self.assertIn("第一行", svg)
        self.assertIn("第二行", svg)
        self.assertIn("u1", svg)
        # 被折叠的信号不再画椭圆
        self.assertEqual(svg.count('data-kind="signal"'), 0)

    def test_cards_and_band_callout_reach_the_svg(self):
        m = Model()
        m.add_func(Func(id="a.c::dev", name="dev", ret="void", asset="assets/dev.svg"))
        m.add_callout(Callout(id="band", text="分区", shape="band", x=0, y=0, w=400, h=100))
        svg = to_svg(m, cards=True)
        self.assertIn("<image", svg)
        self.assertIn('preserveAspectRatio="none"', svg)
        # band 是虚线的分区带
        self.assertIn("stroke-dasharray", svg)

    def test_straight_edges_use_two_points_in_svg(self):
        m = Model()
        m.add_signal(Signal(id="a.c::s", name="s", ctype="int", group="a", path="a"))
        m.add_func(Func(id="b.c::y", name="y", ret="void", reads=["a.c::s"], group="b", path="b"))
        m.rebuild_edges()
        auto = to_svg(m)
        straight = to_svg(m, straight_edges=True)
        # 只数边路径里的折点：SVG 的箭头 marker 定义里也有两个 " L "，
        # 直接数全文会把它算进去（3 段边 = 2+3 个 L，看起来像 5 段）。
        def _edge_d(svg):
            return re.search(r'<path d="([^"]*)"[^>]*data-edge="1"', svg).group(1)

        # 自动路由补一个直角折弯（3 段），直线模式只有两端（1 段）
        self.assertEqual(_edge_d(auto).count(" L "), 3)
        self.assertEqual(_edge_d(straight).count(" L "), 1)


if __name__ == "__main__":
    unittest.main()
