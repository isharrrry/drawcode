import os
import sys
import unittest
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
_REPO = os.path.dirname(ROOT)

from drawcode.cparse import parse_project
from drawcode.drawio import apply_layout, read_layout, to_drawio

EX = os.path.join(_REPO, "examples", "small", "c")
FILES = [os.path.join(EX, f) for f in ("adc.h", "adc.c", "dsp.h", "dsp.c")]


def model():
    return parse_project(FILES, root=EX)


class TestEmit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.xml = to_drawio(model())

    def test_well_formed_and_no_comments(self):
        ET.fromstring(self.xml)
        self.assertNotIn("<!--", self.xml)

    def test_every_symbol_is_an_object_with_symbol_id(self):
        root = ET.fromstring(self.xml)
        ids = {o.get("symbolId") for o in root.iter("object")}
        for sid in (
            "adc.h::g_raw",
            "adc.h::g_filtered",
            "dsp.h::g_coeff",
            "adc.h::adc_read",
            "dsp.h::fir_apply",
            "dsp.h::dsp_set_gain",
        ):
            self.assertIn(sid, ids)

    def test_cell_ids_are_safe(self):
        root = ET.fromstring(self.xml)
        for o in root.iter("object"):
            self.assertNotIn("::", o.get("id"))
            self.assertNotIn("/", o.get("id"))

    def test_signal_attrs(self):
        root = ET.fromstring(self.xml)
        obj = [o for o in root.iter("object") if o.get("symbolId") == "adc.h::g_raw"][0]
        self.assertEqual(obj.get("kind"), "signal")
        self.assertEqual(obj.get("dir"), "in")
        self.assertEqual(obj.get("ctype"), "int16_t")
        self.assertEqual(obj.get("unit"), "LSB")
        self.assertEqual(obj.get("alias"), "原始采样值")

    def test_direction_shapes_encode_flow(self):
        """输入是右尖五边形、输出是左尖五边形——流向由形状本身表达。

        这条需要独立守卫，因为 conformance 只比较结构，形状差异全在 style 里，
        把形状改回椭圆不会有任何测试变红。

        另一半同样重要：尖角必须精确落在左右边缘中点上。ANCHOR_SETS 的首选锚点
        是 (1.0,0.5)/(0.0,0.5)，只有尖角与它重合，连线才会咬在尖角上；一旦
        路径坐标改动而锚点没跟着改，线就会悬在平边上。
        """
        root = ET.fromstring(self.xml)
        sigs = {o.get("symbolId"): o for o in root.iter("object") if o.get("kind") == "signal"}

        def shape_of(symbol_id):
            st = sigs[symbol_id].find("mxCell").get("style")
            return st, [s[len("path="):] for s in st.split(";") if s.startswith("path=")][0]

        def points(path):
            return [tuple(float(v) for v in p.split(",")) for p in path.split()]

        # dir=in -> 右边尖
        in_style, in_path = shape_of("adc.h::g_raw")
        self.assertIn("shape=path", in_style)
        pts = points(in_path)
        self.assertEqual((160.0, 30.0), max(pts, key=lambda p: p[0]), "in 的尖角在右边缘中点")

        # dir=out -> 左边尖
        out_style, out_path = shape_of("adc.h::g_filtered")
        self.assertIn("shape=path", out_style)
        pts = points(out_path)
        self.assertEqual((0.0, 30.0), min(pts, key=lambda p: p[0]), "out 的尖角在左边缘中点")

        # 示例里三个信号都有方向（in/out/in），所以没有"无方向 -> 椭圆"的用例可测；
        # 那个分支由 SIGNAL_DIR_STYLE.get(…, SIGNAL_STYLE) 的默认值兜底。

    def test_signal_nodes_still_carry_symbol_id(self):
        """形状换了，但节点必须仍是带 symbolId 的 <object>，否则回读会认不出它。"""
        root = ET.fromstring(self.xml)
        self.assertEqual(3, len([o for o in root.iter("object") if o.get("kind") == "signal"]))
        for o in root.iter("object"):
            if o.get("kind") == "signal":
                self.assertTrue(o.get("symbolId"))

    def test_func_attrs_include_device(self):
        root = ET.fromstring(self.xml)
        obj = [o for o in root.iter("object") if o.get("symbolId") == "adc.h::adc_read"][0]
        self.assertEqual(obj.get("kind"), "func")
        self.assertEqual(obj.get("vendor"), "TI")
        self.assertEqual(obj.get("model"), "ADS1115")
        self.assertEqual(obj.get("spec"), "16bit/860SPS")
        self.assertEqual(obj.get("size"), "2.0x3.0mm")
        self.assertEqual(obj.get("asset"), "assets/ads1115.svg")
        self.assertEqual(obj.get("tooltip"), "上电后需先校准")

    def test_label_is_html_br_not_entity_newline(self):
        root = ET.fromstring(self.xml)
        obj = [o for o in root.iter("object") if o.get("symbolId") == "adc.h::g_raw"][0]
        self.assertIn("<br>", obj.get("label"))
        self.assertNotIn("\n", obj.get("label"))

    def test_group_containers_and_relative_children(self):
        root = ET.fromstring(self.xml)
        containers = [c for c in root.iter("mxCell") if "swimlane" in (c.get("style") or "")]
        self.assertEqual(len(containers), 2)
        cid = {c.get("id") for c in containers}
        parents = {
            o.find("mxCell").get("parent")
            for o in root.iter("object")
            if o.find("mxCell").get("vertex") == "1"
        }
        self.assertTrue(parents.issubset(cid))

    def test_edge_parent_is_common_container(self):
        root = ET.fromstring(self.xml)
        by_id = {c.get("id"): c for c in root.iter("mxCell")}
        obj_parent = {}
        for o in root.iter("object"):
            cell = o.find("mxCell")
            obj_parent[o.get("id")] = cell.get("parent")
        for o in root.iter("object"):
            cell = o.find("mxCell")
            if cell.get("edge") != "1":
                continue
            p = obj_parent.get(cell.get("source"))
            q = obj_parent.get(cell.get("target"))
            expect = p if p == q else "1"
            self.assertEqual(cell.get("parent"), expect, "edge parent wrong for " + str(o.get("id")))

    def test_edges_carry_semantics(self):
        root = ET.fromstring(self.xml)
        rels = sorted(
            (o.get("src"), o.get("dst"), o.get("rw"))
            for o in root.iter("object")
            if o.get("rel")
        )
        self.assertIn(("adc.h::g_raw", "adc.h::adc_read", "read"), rels)
        self.assertIn(("adc.h::adc_read", "adc.h::g_filtered", "write"), rels)
        self.assertEqual(len(rels), 6)


class TestReadBack(unittest.TestCase):
    def test_layout_roundtrip(self):
        m = model()
        m.funcs["adc.h::adc_read"].x, m.funcs["adc.h::adc_read"].y = 1234.0, 567.0
        m.signals["adc.h::g_raw"].x, m.signals["adc.h::g_raw"].y = 11.0, 22.0
        xml = to_drawio(m)

        m2 = model()
        apply_layout(m2, read_layout(xml))
        self.assertEqual((m2.funcs["adc.h::adc_read"].x, m2.funcs["adc.h::adc_read"].y), (1234.0, 567.0))
        self.assertEqual((m2.signals["adc.h::g_raw"].x, m2.signals["adc.h::g_raw"].y), (11.0, 22.0))

    def test_waypoints_roundtrip(self):
        m = model()
        m.edges[0].waypoints = [(100.0, 200.0), (300.0, 400.0)]
        xml = to_drawio(m)
        lay = read_layout(xml)
        key = "%s->%s:%s" % (m.edges[0].src, m.edges[0].dst, m.edges[0].rw)
        self.assertEqual(lay["edges"][key], [(100.0, 200.0), (300.0, 400.0)])

    def test_reading_a_hand_edited_file(self):
        m = model()
        xml = to_drawio(m)
        edited = xml.replace('width="160" height="60"', 'width="260" height="90"')
        apply_layout(m, read_layout(edited))
        s = m.signals["adc.h::g_raw"]
        self.assertEqual((s.w, s.h), (260.0, 90.0))


def pack(xml):
    """复刻 draw.io 保存时的形态：<diagram> 内容 = base64(raw deflate(urlquote(model)))"""
    import base64
    import urllib.parse
    import zlib

    root = ET.fromstring(xml)
    for d in root.findall("diagram"):
        inner = d.find("mxGraphModel")
        if inner is None:
            continue
        text = ET.tostring(inner, encoding="unicode")
        for child in list(d):
            d.remove(child)
        raw = zlib.compressobj(9, zlib.DEFLATED, -15)
        blob = raw.compress(urllib.parse.quote(text, safe="~()*!.'").encode("utf-8")) + raw.flush()
        d.text = base64.b64encode(blob).decode("ascii")
    return ET.tostring(root, encoding="unicode")


class TestCompressedDiagram(unittest.TestCase):
    """draw.io 默认压缩保存；读不回来就会静默丢掉人工排版。"""

    def test_compressed_matches_plain(self):
        plain = read_layout(to_drawio(model()))
        packed = read_layout(pack(to_drawio(model())))
        self.assertEqual(packed["nodes"], plain["nodes"])
        self.assertEqual(packed["edges"], plain["edges"])
        self.assertEqual(packed["attrs"], plain["attrs"])
        self.assertNotEqual(packed["nodes"], {})

    def test_compressed_layout_is_not_silently_dropped(self):
        m = model()
        m.signals["adc.h::g_raw"].x, m.signals["adc.h::g_raw"].y = 11.0, 22.0
        m.funcs["adc.h::adc_read"].x, m.funcs["adc.h::adc_read"].y = 1234.0, 567.0
        packed = pack(to_drawio(m))

        m2 = model()
        apply_layout(m2, read_layout(packed))
        self.assertEqual((m2.funcs["adc.h::adc_read"].x, m2.funcs["adc.h::adc_read"].y), (1234.0, 567.0))
        self.assertEqual((m2.signals["adc.h::g_raw"].x, m2.signals["adc.h::g_raw"].y), (11.0, 22.0))

    def test_compressed_waypoints_roundtrip(self):
        m = model()
        m.edges[0].waypoints = [(100.0, 200.0), (300.0, 400.0)]
        lay = read_layout(pack(to_drawio(m)))
        key = "%s->%s:%s" % (m.edges[0].src, m.edges[0].dst, m.edges[0].rw)
        self.assertEqual(lay["edges"][key], [(100.0, 200.0), (300.0, 400.0)])

    def test_unreadable_diagram_raises_instead_of_empty(self):
        bad = '<mxfile><diagram id="d" name="p">not-a-compressed-payload</diagram></mxfile>'
        with self.assertRaises(ValueError):
            read_layout(bad)


HAND_DRAWN = os.path.join(_REPO, "examples", "drawio", "rack-example.drawio")


class TestHandDrawnDiagram(unittest.TestCase):
    """A real draw.io export: multi-page, compressed, and full of bare <mxCell>.

    It is kept as a fixture precisely because it is *not* drawcode output. Reusing
    its layout must fail loudly rather than silently placing every node at 0,0.
    """

    def test_reads_as_no_drawcode_nodes(self):
        with open(HAND_DRAWN, encoding="utf-8") as fh:
            layout = read_layout(fh.read())
        self.assertEqual({}, layout["nodes"])
        self.assertEqual({}, layout["edges"])

    def test_generated_diagram_does_carry_nodes(self):
        layout = read_layout(to_drawio(model()))
        self.assertEqual(6, len(layout["nodes"]))

    def test_layout_from_rejects_a_hand_drawn_file(self):
        import tempfile

        from drawcode import cli

        out = os.path.join(tempfile.mkdtemp(), "o.drawio")
        with self.assertRaises(SystemExit) as caught:
            cli.main(["build"] + FILES + ["--out", out, "--layout-from", HAND_DRAWN])
        self.assertIn("no drawcode nodes", str(caught.exception))
        self.assertFalse(os.path.exists(out))

    def test_layout_from_rejects_a_missing_file(self):
        import tempfile

        from drawcode import cli

        out = os.path.join(tempfile.mkdtemp(), "o.drawio")
        with self.assertRaises(SystemExit) as caught:
            cli.main(["build"] + FILES + ["--out", out, "--layout-from", os.path.join(out, "nope.drawio")])
        self.assertIn("no such file", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
