namespace DrawCode.Tests;

public class CsParseTests
{
    private static readonly Model M = Fixture.SmallCs();

    [Fact]
    public void SignalSetAndDirections()
    {
        Assert.Equal(
            ["Adc.cs::g_filtered", "Adc.cs::g_raw", "Dsp.cs::g_coeff"],
            M.Signals.Keys.OrderBy(k => k, StringComparer.Ordinal));
        Assert.Equal("in", M.Signals["Adc.cs::g_raw"].Dir);
        Assert.Equal("out", M.Signals["Adc.cs::g_filtered"].Dir);
        Assert.Equal("in", M.Signals["Dsp.cs::g_coeff"].Dir);
    }

    [Fact]
    public void SignalAnnotations()
    {
        var s = M.Signals["Adc.cs::g_raw"];
        Assert.Equal("原始采样值", s.Alias);
        Assert.Equal("LSB", s.Unit);
        Assert.Equal("上电后需校准", s.Note);
        Assert.Equal("Adc.cs", s.File);
        Assert.Equal(6, s.Line);
    }

    [Fact]
    public void ArrayFieldKeepsItsBracketForm()
    {
        Assert.Equal("float[]", M.Signals["Dsp.cs::g_coeff"].CType);
    }

    [Fact]
    public void FuncSet()
    {
        Assert.Equal(
            ["Adc.cs::AdcRead", "Dsp.cs::FirApply", "Dsp.cs::SetGain"],
            M.Funcs.Keys.OrderBy(k => k, StringComparer.Ordinal));
    }

    [Fact]
    public void FuncAnnotationAndDevice()
    {
        var f = M.Funcs["Adc.cs::AdcRead"];
        Assert.Equal("short", f.Ret);
        Assert.Equal("ADC 采样", f.Alias);
        Assert.Equal("上电后需先校准", f.Tooltip);
        var d = M.Devices["Adc.cs::AdcRead"];
        Assert.Equal("TI", d.Vendor);
        Assert.Equal("ADS1115", d.Model);
        Assert.Equal("16bit/860SPS", d.Spec);
    }

    [Fact]
    public void ParamsArePorts()
    {
        var f = M.Funcs["Dsp.cs::SetGain"];
        Assert.Equal(["gain"], f.Params.Select(p => p.Name));
        Assert.Equal("byte", f.Params[0].CType);
    }

    [Fact]
    public void DefUse()
    {
        var f = M.Funcs["Adc.cs::AdcRead"];
        Assert.Equal(["Adc.cs::g_raw"], f.Reads);
        Assert.Equal(["Adc.cs::g_filtered"], f.Writes);
        Assert.Equal(["Dsp.cs::FirApply"], f.Calls);
    }

    [Fact]
    public void DefUseArrayElement()
    {
        var f = M.Funcs["Dsp.cs::SetGain"];
        Assert.Equal(["Dsp.cs::g_coeff"], f.Writes);
        Assert.Empty(f.Reads);
    }

    [Fact]
    public void Edges()
    {
        var got = M.Edges.Select(e => (e.Src, e.Dst, e.Rw)).ToList();
        Assert.Contains(("Adc.cs::g_raw", "Adc.cs::AdcRead", "read"), got);
        Assert.Contains(("Adc.cs::AdcRead", "Adc.cs::g_filtered", "write"), got);
        Assert.Equal(6, got.Count);
    }

    /// <summary>
    /// 回归：类型**与名字**都必须是 Unicode；record 声明整段不进图。
    /// 镜像 TS `parse.test.ts` 与 Python `test_csparse.py` 的同名用例 ——
    /// 三语言必须给出同一张图，任何一版只认 ASCII 都会让中文模型静默少节点。
    /// </summary>
    [Fact]
    public void UnicodeNamesParseAndRecordDeclarationsStayOutsideTheGraph()
    {
        var source = string.Join(
            "\n",
            "using Drawcode;",
            "namespace 验证平台;",
            "public static class 设备",
            "{",
            "    [Drawcode(Direction.Out, Unit = \"目标代码与模型文件\")]",
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
            "}");
        var m = Fixture.FromSource("中文类型.cs", source);

        var sig = m.Signals["中文类型.cs::a1_数据包"];
        Assert.Equal("数据包", sig.CType);
        Assert.Equal("out", sig.Dir);

        var f = m.Funcs["中文类型.cs::coder"];
        Assert.Equal("coder输出", f.Ret);
        Assert.Equal("coder输入", f.Params[0].CType);
        Assert.Equal("input", f.Params[0].Name);
        Assert.True(m.Funcs.ContainsKey("中文类型.cs::产出"), "中文方法名应成为节点");
        Assert.False(m.Funcs.ContainsKey("中文类型.cs::泛型产出"), "泛型方法不得成为节点");
        Assert.False(m.Funcs.ContainsKey("中文类型.cs::数据帧"), "record 声明不得成为节点");
        Assert.False(m.Funcs.ContainsKey("中文类型.cs::下一帧"), "记录体里的方法不得成为节点");
        Assert.Equal(["中文类型.cs::a1_数据包"], f.Writes);
        // def/use 的中文调用名同样要能扫到：这一条同时守住 IdentRe/CallRe 的 Unicode 字符集。
        Assert.Equal(["中文类型.cs::产出"], f.Calls);
    }

    /// <summary>
    /// 回归：跨行 <c>[Drawcode(...)]</c> 必须被当成**一整条**特性来解析与回写。
    ///
    /// 三处曾同时踩坑（TS/Python/.NET 各修一次）：只收「行首是 <c>[</c>」的行，
    /// 第二行以 <c>Note</c> 开头就被当成声明行 —— 解析侧信号消失（C# 没方向就不算信号），
    /// 回写侧判定「没有注解」后在字段上方再插一条，同一字段两条特性，源码编译不过。
    /// 记录声明的 <c>);</c> 也可能落在后续行，不能一上来就找 <c>{</c>，否则会把后面的
    /// class 整段当成记录体吞掉。
    /// </summary>
    [Fact]
    public void WrappedAttributeIsParsedAndSyncedInPlace()
    {
        var source = string.Join(
            "\n",
            "public sealed record 配置([property: Drawcode(Unit = \"x\")] double 增益);",
            "",
            "public static class 模块",
            "{",
            "    [Drawcode(Direction.In, Unit = \"LSB\",",
            "        Note = \"上电后需校准\")]",
            "    public static short g_raw;",
            "",
            "    [Drawcode(Alias = \"采样\")]",
            "    public static short 采样()",
            "    {",
            "        return g_raw;",
            "    }",
            "}",
            "");
        var dir = Path.Combine(Fixture.ScratchRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "Wrapped.cs");
        File.WriteAllText(path, source);
        try
        {
            var m = ParseDispatch.ParseAny([path], dir);
            Assert.True(m.Signals.ContainsKey("Wrapped.cs::g_raw"), "跨行特性里的信号必须被解析出来");
            Assert.Equal("上电后需校准", m.Signals["Wrapped.cs::g_raw"].Note);
            Assert.True(m.Funcs.ContainsKey("Wrapped.cs::采样"), "record 声明不得吞掉后面的 class");

            Assert.False(CodeGen.SyncSource(path, m, "Wrapped.cs"), "没人拖动时回写必须一字不动");
            Assert.Equal(source, File.ReadAllText(path));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    /// <summary>
    /// <c>Path</c> 是共享特性：三语言都必须读它，否则同一份源码只有 Python 有嵌套容器。
    /// </summary>
    [Fact]
    public void PathAttributeSetsContainer()
    {
        var source = string.Join(
            "\n",
            "public static class 设备",
            "{",
            "    [Drawcode(Direction.Out, Path = \"adc/采样前端\")]",
            "    public static short g_raw;",
            "    [Drawcode(Path = \"adc/滤波\")]",
            "    public static short Filter()",
            "    {",
            "        return 0;",
            "    }",
            "}");
        var m = Fixture.FromSource("x.cs", source);

        var sig = m.Signals["x.cs::g_raw"];
        Assert.Equal("adc/采样前端", sig.Path);
        Assert.Equal("adc", sig.Group);
        var f = m.Funcs["x.cs::Filter"];
        Assert.Equal("adc/滤波", f.Path);
        Assert.Equal("adc", f.Group);
    }
}
