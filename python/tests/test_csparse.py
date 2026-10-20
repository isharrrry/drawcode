import os
import shutil
import sys
import tempfile
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


class TestCsUnicodeAndRecord(unittest.TestCase):
    """回归：类型**与名字**都必须是 Unicode；record 声明整段不进图。

    镜像 TS `parse.test.ts` 的同名用例与 .NET `CsParseTests` —— 三语言必须给出
    同一张图，任何一版只认 ASCII 都会让中文模型静默少节点。
    """

    def test_unicode_names_and_record_skip(self):
        src = "\n".join(
            [
                "using Drawcode;",
                "namespace 验证平台;",
                "public static class 设备",
                "{",
                '    [Drawcode(Direction.Out, Unit = "目标代码与模型文件")]',
                "    public static 数据包 a1_数据包;",
                "    public static 数据包 产出()",
                "    {",
                "        return default!;",
                "    }",
                "    public static T 泛型产出<T>(T 关系) { return 关系; }",
                "    public static coder输出 coder(coder输入 input)",
                "    {",
                "        测试桩.处理(input);",
                "        a1_数据包 = 产出();",
                "        return default!;",
                "    }",
                "}",
                "public sealed record 数据帧(帧头 头, int 数量)",
                "{",
                "    public const int 全构型架数 = 100;",
                "    public 帧头 下一帧() { return default!; }",
                "}",
            ]
        )
        tmp = tempfile.mkdtemp(prefix="drawcode-parse-")
        self.addCleanup(shutil.rmtree, tmp, True)
        path = os.path.join(tmp, "中文类型.cs")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(src)
        m = parse_cs_project([path], root=tmp)

        sig = m.signals["中文类型.cs::a1_数据包"]
        self.assertEqual(sig.ctype, "数据包")
        self.assertEqual(sig.dir, "out")

        f = m.funcs["中文类型.cs::coder"]
        self.assertEqual(f.ret, "coder输出")
        self.assertEqual([(p.ctype, p.name) for p in f.params], [("coder输入", "input")])
        self.assertIn("中文类型.cs::产出", m.funcs, "中文方法名应成为节点")
        self.assertNotIn("中文类型.cs::泛型产出", m.funcs, "泛型方法不得成为节点")
        self.assertNotIn("中文类型.cs::数据帧", m.funcs, "record 声明不得成为节点")
        self.assertNotIn("中文类型.cs::下一帧", m.funcs, "记录体里的方法不得成为节点")
        self.assertEqual(f.writes, ["中文类型.cs::a1_数据包"])
        # def/use 的中文调用名同样要能扫到：这一条同时守住 CALL_RE 的 Unicode 字符集。
        self.assertEqual(f.calls, ["中文类型.cs::产出"])


class TestCsPathAttribute(unittest.TestCase):
    """`Path` 是共享特性：三语言都必须读它，否则同一份源码只有 Python 有嵌套容器。"""

    def test_path_sets_container(self):
        src = "\n".join(
            [
                "public static class 设备",
                "{",
                '    [Drawcode(Direction.Out, Path = "adc/采样前端")]',
                "    public static short g_raw;",
                '    [Drawcode(Path = "adc/滤波")]',
                "    public static short Filter()",
                "    {",
                "        return 0;",
                "    }",
                "}",
            ]
        )
        tmp = tempfile.mkdtemp(prefix="drawcode-path-")
        self.addCleanup(shutil.rmtree, tmp, True)
        path = os.path.join(tmp, "x.cs")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(src)
        m = parse_cs_project([path], root=tmp)

        sig = m.signals["x.cs::g_raw"]
        self.assertEqual(sig.path, "adc/采样前端")
        self.assertEqual(sig.group, "adc")
        f = m.funcs["x.cs::Filter"]
        self.assertEqual(f.path, "adc/滤波")
        self.assertEqual(f.group, "adc")


if __name__ == "__main__":
    unittest.main()
