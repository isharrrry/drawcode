"""CLI 的模块拆分、模糊简称，以及 `path` 决定的容器层级。

这三条是一条线上的设定：**一个模块一张图**，模块由同名文件确定，容器层级由源码里的
`@drawcode path="a/b"` 决定 —— 而不是「一个源文件一个容器」。
"""

import os
import shutil
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
_REPO = os.path.dirname(ROOT)

from drawcode import cli
from drawcode.cparse import parse_project
from drawcode.drawio import to_drawio

EX = os.path.join(_REPO, "examples", "small", "c")
ADCS = ("adc.h", "adc.c")
DSPS = ("dsp.h", "dsp.c")


class CLICase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        for f in ADCS + DSPS:
            shutil.copy(os.path.join(EX, f), self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def path(self, name):
        return os.path.join(self.tmp, name)

    def outputs(self):
        return sorted(f for f in os.listdir(self.tmp) if f.endswith(".drawio"))

    def run_build(self, *args, **kw):
        """注意别叫 `run` —— 那是 `unittest.TestCase` 的框架方法，覆盖了它整个用例都跑不起来。

        `--root` / `--out` 的值原样透传（它们是目录或已算好的绝对路径），
        只有裸文件名才按模块目录展开。
        """
        argv = ["build"]
        takes_value = {"--root", "--out", "--layout-from", "--svg"}
        skip_next = False
        for a in args:
            if skip_next:
                argv.append(a)
                skip_next = False
            elif a in takes_value:
                argv.append(a)
                skip_next = True
            elif a.startswith("--"):
                argv.append(a)
            else:
                argv.append(self.path(a))
        return cli.main(argv)


class TestModuleSplit(CLICase):
    """默认一个模块一张图，不是把所有模块塞进一张。"""

    def test_one_module_gives_one_named_diagram(self):
        self.run_build("adc.h", "adc.c", "--root", self.tmp)
        self.assertEqual(["adc.drawio"], self.outputs())

    def test_two_modules_give_two_diagrams(self):
        self.run_build("adc.h", "adc.c", "dsp.h", "dsp.c", "--root", self.tmp)
        self.assertEqual(["adc.drawio", "dsp.drawio"], self.outputs())

    def test_each_diagram_holds_only_its_own_module(self):
        self.run_build("adc.h", "adc.c", "dsp.h", "dsp.c", "--root", self.tmp)
        with open(self.path("dsp.drawio"), encoding="utf-8") as fh:
            xml = fh.read()
        self.assertIn("dsp.h::g_coeff", xml)
        self.assertNotIn("adc.h::", xml)

    def test_out_is_refused_for_several_modules(self):
        """--out 只能指一个文件；多模块时静默只写第一个才是最坏的做法。"""
        with self.assertRaises(SystemExit) as caught:
            self.run_build("adc.h", "adc.c", "dsp.h", "dsp.c", "--root", self.tmp, "--out", self.path("both.drawio"))
        message = str(caught.exception)
        self.assertIn("--merge", message)
        self.assertEqual([], self.outputs())

    def test_merge_puts_everything_in_one_diagram(self):
        self.run_build("adc.h", "adc.c", "dsp.h", "dsp.c", "--root", self.tmp, "--merge", "--out", self.path("all.drawio"))
        self.assertEqual(["all.drawio"], self.outputs())
        with open(self.path("all.drawio"), encoding="utf-8") as fh:
            xml = fh.read()
        self.assertIn("adc.h::g_raw", xml)
        self.assertIn("dsp.h::g_coeff", xml)


class TestFuzzyModuleName(CLICase):
    """`dsp.h` 和 `dsp.c` 都指「dsp 这个模块」。"""

    def test_header_alone_pulls_in_the_sibling(self):
        self.run_build("dsp.h", "--root", self.tmp)
        self.assertEqual(["dsp.drawio"], self.outputs())
        m = parse_project([self.path("dsp.h"), self.path("dsp.c")], root=self.tmp)
        with open(self.path("dsp.drawio"), encoding="utf-8") as fh:
            xml = fh.read()
        # 只给 .h 也要拿到 .c 里扫出来的边 —— 否则图会缺一半
        self.assertEqual(len(m.edges), len([e for e in ET.fromstring(xml).iter("mxCell") if e.get("edge") == "1"]))

    def test_source_alone_gives_the_same_diagram(self):
        self.run_build("dsp.h", "--root", self.tmp)
        with open(self.path("dsp.drawio"), encoding="utf-8") as fh:
            from_header = fh.read()
        os.remove(self.path("dsp.drawio"))
        self.run_build("dsp.c", "--root", self.tmp)
        with open(self.path("dsp.drawio"), encoding="utf-8") as fh:
            from_source = fh.read()
        self.assertEqual(from_header, from_source)


PATH_HEADER = """/// @drawcode path="adc/采样前端" dir=in unit="LSB"
int16_t g_raw;

/// @drawcode path="adc/滤波" dir=in unit="coeff"
float g_coeff[32];

/// @drawcode dir=in unit="plain"
int16_t g_plain;
"""


class TestContainerPath(unittest.TestCase):
    """容器层级来自 `path`，不再等于「一个源文件一个容器」。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        with open(os.path.join(self.tmp, "x.h"), "w", encoding="utf-8", newline="") as fh:
            fh.write(PATH_HEADER)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def model(self):
        return parse_project([os.path.join(self.tmp, "x.h")], root=self.tmp)

    def test_path_is_stored_and_group_is_its_first_segment(self):
        m = self.model()
        got = {s.name: (s.group, s.path) for s in m.signals.values()}
        self.assertEqual(("adc", "adc/采样前端"), got["g_raw"])
        self.assertEqual(("adc", "adc/滤波"), got["g_coeff"])

    def test_without_path_it_falls_back_to_the_module_name(self):
        """旧源码一个字不改也照常工作：没标 path 就用文件名。"""
        m = self.model()
        self.assertEqual(("x", "x"), (m.signals["x.h::g_plain"].group, m.signals["x.h::g_plain"].path))

    def test_nested_containers_are_emitted_with_a_parent_chain(self):
        root = ET.fromstring(to_drawio(self.model()))
        containers = {}
        for cell in root.iter("mxCell"):
            if cell.get("style", "").startswith("swimlane"):
                containers[cell.get("value")] = cell
        self.assertIn("adc", containers)
        self.assertIn("采样前端", containers)
        self.assertIn("滤波", containers)
        # 子容器的 parent 必须是父容器的 cell id，不是根
        adc_id = containers["adc"].get("id")
        self.assertEqual("1", containers["adc"].get("parent"))
        self.assertEqual(adc_id, containers["采样前端"].get("parent"))
        self.assertEqual(adc_id, containers["滤波"].get("parent"))

    def test_nodes_sit_in_their_own_leaf_container(self):
        root = ET.fromstring(to_drawio(self.model()))
        by_symbol = {}
        for obj in root.iter("object"):
            inner = obj.find("mxCell")
            by_symbol[obj.get("symbolId")] = inner.get("parent")
        ids = {c.get("value"): c.get("id") for c in root.iter("mxCell") if c.get("style", "").startswith("swimlane")}
        self.assertEqual(ids["采样前端"], by_symbol["x.h::g_raw"])
        self.assertEqual(ids["滤波"], by_symbol["x.h::g_coeff"])
        # 没标 path 的落在自己的模块容器 `x` 里，不会被塞进 adc
        self.assertEqual(ids["x"], by_symbol["x.h::g_plain"])


NESTED_HEADER = """/// @drawcode path="adc/滤波组/系数" dir=in
int16_t g_coef;

/// @drawcode path="adc/采样前端" dir=in
int16_t g_raw;

/// @drawcode path="adc/采样前端" dir=out
int16_t g_raw2;

/// @drawcode path=""
int16_t g_toplevel;
"""


class TestNestedContainers(unittest.TestCase):
    """`path` 可以多一层，而中间那层自己可能没有直属成员。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        with open(os.path.join(self.tmp, "x.h"), "w", encoding="utf-8", newline="") as fh:
            fh.write(NESTED_HEADER)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def lanes(self):
        """容器 id -> (名字, 父 id)。"""
        m = parse_project([os.path.join(self.tmp, "x.h")], root=self.tmp)
        root = ET.fromstring(to_drawio(m))
        return {
            c.get("id"): (c.get("value"), c.get("parent"))
            for c in root.iter("mxCell")
            if "swimlane" in (c.get("style") or "")
        }

    def absolute_boxes(self):
        """容器名 -> 绝对 (x, y, w, h)。

        容器坐标是**相对父容器**的，所以要把祖先链上的偏移一路加起来。

        两个坑，都在这里踩过：
          * 信号节点的 `mxCell` 故意没有 `id`（它靠外层 `<object symbolId=…>` 标识），
            所以必须把无 id 的排除掉；
          * 走到根以后 `parent` 是 `None`，而 `cells.get(None)` 会**假命中**上面那个
            无 id 的 cell，它的 parent 又指回容器 —— 父链因此成环、遍历永不终止，
            整个测试进程就挂在那里。`seen` 是双保险。
        """
        m = parse_project([os.path.join(self.tmp, "x.h")], root=self.tmp)
        root = ET.fromstring(to_drawio(m))
        cells = {c.get("id"): c for c in root.iter("mxCell") if c.get("id")}
        out = {}
        for cid, cell in cells.items():
            if "swimlane" not in (cell.get("style") or ""):
                continue
            x = y = 0.0
            seen = set()
            cur = cell
            while cur is not None and cur.get("id") not in seen:
                seen.add(cur.get("id"))
                geom = cur.find("mxGeometry")
                if geom is not None:
                    x += float(geom.get("x") or 0)
                    y += float(geom.get("y") or 0)
                parent = cur.get("parent")
                cur = cells.get(parent) if parent is not None else None
            geom = cell.find("mxGeometry")
            out[cell.get("value")] = (x, y, float(geom.get("width")), float(geom.get("height")))
        return out

    def test_nested_path_builds_a_three_level_chain(self):
        """`a/b/c` 要生成三层容器，中间那层不能被丢掉。

        中间层（`滤波组`）自己没有直属成员。早先布局时拿空成员列表去算包围盒，
        `min()` 直接抛 ValueError —— 整个 build 崩掉，而不是画错。
        """
        lanes = self.lanes()
        by_name = {name: cid for cid, (name, _) in lanes.items()}
        for name in ("adc", "滤波组", "系数", "采样前端"):
            self.assertIn(name, by_name, "缺容器 %s" % name)
        self.assertEqual("滤波组", lanes[lanes[by_name["系数"]][1]][0])
        self.assertEqual("adc", lanes[lanes[by_name["滤波组"]][1]][0])
        self.assertEqual("adc", lanes[lanes[by_name["采样前端"]][1]][0])

    def absolute_node_boxes(self):
        """信号 id -> 绝对 (x, y)。

        节点坐标相对**自己容器**的原点，所以同样要把祖先链的偏移加上。
        """
        m = parse_project([os.path.join(self.tmp, "x.h")], root=self.tmp)
        root = ET.fromstring(to_drawio(m))
        cells = {c.get("id"): c for c in root.iter("mxCell") if c.get("id")}
        out = {}
        for obj in root.iter("object"):
            inner = obj.find("mxCell")
            geom = inner.find("mxGeometry")
            x, y = float(geom.get("x") or 0), float(geom.get("y") or 0)
            parent = inner.get("parent")
            cur = cells.get(parent) if parent is not None else None
            seen = set()
            while cur is not None and cur.get("id") not in seen:
                seen.add(cur.get("id"))
                g = cur.find("mxGeometry")
                if g is not None:
                    x += float(g.get("x") or 0)
                    y += float(g.get("y") or 0)
                p = cur.get("parent")
                cur = cells.get(p) if p is not None else None
            out[obj.get("symbolId")] = (x, y)
        return out

    def test_members_of_one_container_share_a_column(self):
        """同一容器内的成员必须落在同一列。

        这条才是布局的判据。递归排子容器时成员会被先落一次坐标；回到父容器后如果
        整棵子树没有一起平移，`e.x == 0 and e.y == 0` 这个守卫就只对块里第一个成员
        成立，其余成员的 x 会与它不一致 —— 同容器内水平错开。
        只断言容器 box 是看不出来的：容器几何由节点树算出，不经过布局函数。
        """
        boxes = self.absolute_node_boxes()
        first, second = boxes["x.h::g_raw"], boxes["x.h::g_raw2"]
        self.assertEqual(first[0], second[0], "同容器的两个成员被摆在了不同列")
        self.assertNotEqual(first[1], second[1], "同容器的两个成员纵向应错开")

    def test_subtree_members_stay_inside_their_container(self):
        """子容器整体平移后成员要跟着走 —— 否则会落到自己容器的框外面。"""
        nodes = self.absolute_node_boxes()
        boxes = self.absolute_boxes()
        sampling = boxes["采样前端"]
        for key in ("x.h::g_raw", "x.h::g_raw2"):
            x, y = nodes[key]
            self.assertGreaterEqual(x, sampling[0] - 1e-6, "%s 跑到容器左边界之外" % key)
            self.assertLessEqual(x, sampling[0] + sampling[2], "%s 跑到容器右边界之外" % key)
            self.assertGreaterEqual(y, sampling[1] - 1e-6, "%s 跑到容器上边界之外" % key)
            self.assertLessEqual(y, sampling[1] + sampling[3], "%s 跑到容器下边界之外" % key)

    def test_sibling_subtrees_do_not_share_a_column(self):
        """兄弟子树必须各占一列，不能叠在一起。

        这条才是布局的判据：只断言「容器 cell 存在」是不够的 —— 容器 cell 由节点树
        生成，布局整棵子树被跳过时它们照样在。中间容器算不出宽度时游标不前进，
        两棵子树会得到同一个 x，那才是真正的坏结果。
        """
        boxes = self.absolute_boxes()
        grouped = boxes["滤波组"]          # adc/滤波组 —— 中间容器，无直属成员
        sampling = boxes["采样前端"]        # adc/采样前端 —— 它的兄弟
        self.assertNotEqual(grouped[0], sampling[0], "兄弟子树被摆在了同一列")
        # 真正的相邻判定：两个盒子在横向上不得交叠
        overlap = grouped[0] < sampling[0] + sampling[2] and sampling[0] < grouped[0] + grouped[2]
        self.assertFalse(overlap, "滤波组 与 采样前端 的横向范围重叠")

    def test_middle_container_encloses_its_grandchild(self):
        """中间容器的盒子必须包住孙容器 —— 否则它是空壳，层级是假的。"""
        boxes = self.absolute_boxes()
        grouped, coef = boxes["滤波组"], boxes["系数"]
        self.assertLessEqual(grouped[0], coef[0])
        self.assertLessEqual(grouped[1], coef[1])
        self.assertGreaterEqual(grouped[0] + grouped[2], coef[0] + coef[2])
        self.assertGreaterEqual(grouped[1] + grouped[3], coef[1] + coef[3])

    def test_empty_path_is_the_same_as_no_path(self):
        """`path=""` 与「没标 path」同义 —— 下游拿到的 path 永远非空。"""
        m = parse_project([os.path.join(self.tmp, "x.h")], root=self.tmp)
        sig = m.signals["x.h::g_toplevel"]
        self.assertEqual(("x", "x"), (sig.group, sig.path))


class DumpIrCase(unittest.TestCase):
    """`dump-ir` 是 L1 一致性比较的公开入口，产物必须与金标准逐字节一致。"""

    def test_dump_ir_matches_the_golden(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        out = os.path.join(tmp, "ir.json")
        files = [os.path.join(EX, f) for f in ADCS + DSPS]
        self.assertEqual(0, cli.main(["dump-ir", *files, "--root", EX, "--out", out]))
        with open(out, encoding="utf-8", newline="") as fh:
            got = fh.read()
        with open(
            os.path.join(_REPO, "tests", "golden", "small-c", "expected.ir.json"),
            encoding="utf-8",
            newline="",
        ) as fh:
            self.assertEqual(got, fh.read())


if __name__ == "__main__":
    unittest.main()
