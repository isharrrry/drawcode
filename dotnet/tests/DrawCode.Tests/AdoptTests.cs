using System.Globalization;

namespace DrawCode.Tests;

/// <summary>
/// 「用户在 draw.io 里新加的元素」接回 IR。对等 Python <c>tests/test_adopt.py</c>
/// 与 TypeScript <c>test/adopt.test.ts</c>，逐条对应。
/// </summary>
public class AdoptTests
{
    private static readonly string[] Names = ["adc.h", "adc.c", "dsp.h", "dsp.c"];

    private static string Cell(string cid, string label, string style, string parent,
        double x = 40, double y = 200) =>
        "        <mxCell id=\"" + cid + "\" value=\"" + label + "\" style=\"" + style + "\" vertex=\"1\" parent=\"" + parent + "\">\n" +
        "          <mxGeometry x=\"" + x.ToString(CultureInfo.InvariantCulture) + "\" y=\"" + y.ToString(CultureInfo.InvariantCulture) + "\" width=\"160\" height=\"60\" as=\"geometry\" />\n" +
        "        </mxCell>\n";

    /// <summary>画一张我们自己的图，再往里塞若干用户手画的元素。</summary>
    private static string DiagramWith(params string[] cells)
    {
        var xml = Drawio.ToDrawio(Fixture.SmallC());
        return xml.Replace("</mxGraphModel>", string.Concat(cells) + "      </mxGraphModel>", StringComparison.Ordinal);
    }

    private static Model Model() => Fixture.SmallC();

    // ------------------------------------------------------------------ 分类

    [Fact]
    public void PentagonAndEllipseAreSignals()
    {
        Assert.Equal("signal", Adopt.Classify("shape=path;path=45,0 160,0;"));
        Assert.Equal("signal", Adopt.Classify("shape=ellipse;"));
    }

    [Fact]
    public void AnythingElseIsAFunc()
    {
        Assert.Equal("func", Adopt.Classify("rounded=1;whiteSpace=wrap;"));
        Assert.Equal("func", Adopt.Classify(""));
    }

    /// <summary>
    /// draw.io 自己的椭圆 style 是**裸词** <c>ellipse;</c>，只有 drawcode 生成时才写
    /// <c>shape=ellipse</c>。只认后者的话，用户在工具栏上随手画的椭圆会被判成函数、
    /// 写进 .c —— 而且不报错。这条钉的就是那个裸词。
    /// </summary>
    [Fact]
    public void ABareEllipseWordFromTheDrawioToolbarIsASignal()
    {
        Assert.Equal("signal", Adopt.Classify("ellipse;whiteSpace=wrap;html=1;"));
    }

    [Fact]
    public void DirectionComesFromThePentagonOrientation()
    {
        Assert.Equal("in", Adopt.Direction("shape=path;direction=east;"));
        Assert.Equal("out", Adopt.Direction("shape=path;direction=west;"));
        Assert.Equal("", Adopt.Direction("shape=path;"));
    }

    // -------------------------------------------------------------- 文字解析

    [Fact]
    public void ATypedLabelYieldsCTypeAndName()
    {
        Assert.Equal(("int16_t", "g_alarm", (string?)null), Adopt.ParseLabel("int16_t g_alarm"));
    }

    [Fact]
    public void AnUntypedLabelLeavesCTypeEmpty()
    {
        Assert.Equal(("", "g_unknown", (string?)null), Adopt.ParseLabel("g_unknown"));
    }

    [Fact]
    public void AFunctionSignatureYieldsItsParams()
    {
        Assert.Equal(("void", "dsp_reset", "void"), Adopt.ParseLabel("void dsp_reset(void)"));
    }

    [Fact]
    public void AFunctionWithParameters()
    {
        Assert.Equal(("int", "fir", "int a, int b"), Adopt.ParseLabel("int fir(int a, int b)"));
    }

    // ---------------------------------------------------------- 外来元素识别

    [Fact]
    public void ContainersAreNotMistakenForUserElements()
    {
        var layout = Drawio.ReadLayout(Drawio.ToDrawio(Model()), includeForeign: true);
        Assert.Empty(layout.Foreign);
    }

    [Fact]
    public void AHandDrawnShapeIsDetected()
    {
        var xml = DiagramWith(Cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1"));
        var layout = Drawio.ReadLayout(xml, includeForeign: true);
        var foreign = Assert.Single(layout.Foreign);
        // label 是节点上原样的文字，类型解析留给 Adopt
        Assert.Equal("int16_t g_alarm", foreign.Label);
        Assert.Equal("adc", foreign.Container);
    }

    [Fact]
    public void ForeignCellsAreOffByDefault()
    {
        var layout = Drawio.ReadLayout(DiagramWith(Cell("u1", "x", "rounded=1;", "grp1")));
        Assert.Empty(layout.Foreign);
    }

    // ------------------------------------------------------------------ 接回

    [Fact]
    public void ASignalGoesToTheHeaderOfItsContainer()
    {
        var xml = DiagramWith(Cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1"));
        var model = Model();
        var layout = Drawio.ReadLayout(xml, includeForeign: true);
        var (added, problems) = Adopt.AdoptForeign(model, layout, Path.Combine(TestPaths.Case("small-c"), "input"));

        Assert.Equal(["adc.h::g_alarm"], added);
        Assert.Equal("adc.h", model.SignalOrNull("adc.h::g_alarm")!.File);
        Assert.Equal("in", model.SignalOrNull("adc.h::g_alarm")!.Dir);
        Assert.Empty(problems);
    }

    [Fact]
    public void AFunctionGoesToTheSiblingCFileNotTheHeader()
    {
        var xml = DiagramWith(Cell("u3", "void dsp_reset(void)", "rounded=1;", "grp2"));
        var model = Model();
        var layout = Drawio.ReadLayout(xml, includeForeign: true);
        var (added, _) = Adopt.AdoptForeign(model, layout, Path.Combine(TestPaths.Case("small-c"), "input"));

        Assert.Equal(["dsp.c::dsp_reset"], added);
        Assert.Equal("dsp.c", model.FuncOrNull("dsp.c::dsp_reset")!.File);
    }

    [Fact]
    public void AnUntypedSignalIsAdoptedButReported()
    {
        var xml = DiagramWith(Cell("u2", "g_unknown", "shape=ellipse;", "grp2"));
        var model = Model();
        var layout = Drawio.ReadLayout(xml, includeForeign: true);
        var (added, problems) = Adopt.AdoptForeign(model, layout, Path.Combine(TestPaths.Case("small-c"), "input"));

        Assert.Equal(["dsp.h::g_unknown"], added);
        Assert.Equal("", model.SignalOrNull("dsp.h::g_unknown")!.CType);
        Assert.Contains(problems, p => p.Contains("认不出类型", StringComparison.Ordinal));
    }

    [Fact]
    public void AnElementOutsideAnyContainerIsReportedNotGuessed()
    {
        var xml = DiagramWith(Cell("u4", "floating", "rounded=1;", "1"));
        var model = Model();
        var layout = Drawio.ReadLayout(xml, includeForeign: true);
        var (added, problems) = Adopt.AdoptForeign(model, layout, Path.Combine(TestPaths.Case("small-c"), "input"));

        Assert.Empty(added);
        Assert.Contains(problems, p => p.Contains("不在任何容器里", StringComparison.Ordinal));
    }

    [Fact]
    public void ANamelessElementGetsAnOrdinalNameAndANote()
    {
        var xml = DiagramWith(Cell("u5", "", "shape=ellipse;", "grp1"));
        var model = Model();
        var layout = Drawio.ReadLayout(xml, includeForeign: true);
        var (added, problems) = Adopt.AdoptForeign(model, layout, Path.Combine(TestPaths.Case("small-c"), "input"));

        Assert.Equal(["adc.h::new_signal_1"], added);
        Assert.Contains(problems, p => p.Contains("按序号命名", StringComparison.Ordinal));
    }

    // ------------------------------------------------------------ 端到端往返

    /// <summary>整条链：图里多一个元素 -> sync --write -> 源码真的多出对应的声明/骨架。</summary>
    private static void SyncOnce(string dir, params string[] cells)
    {
        var drawio = Path.Combine(dir, "flow.drawio");
        File.WriteAllText(drawio, DiagramWith(cells), new System.Text.UTF8Encoding(false));

        var args = new List<string> { "sync", drawio };
        foreach (var n in Names)
        {
            args.Add(Path.Combine(dir, n));
        }

        args.Add("--root");
        args.Add(dir);
        args.Add("--write");
        var exit = Cli.Run([.. args]);
        Assert.Equal(0, exit);
    }

    [Fact]
    public void ANewSignalIsWrittenIntoTheHeader()
    {
        var (dir, _) = Fixture.CopyCase("small-c", Names);
        SyncOnce(dir, Cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1"));

        var text = File.ReadAllText(Path.Combine(dir, "adc.h"));
        Assert.Contains("int16_t g_alarm;", text, StringComparison.Ordinal);
        Assert.Contains("dir=in", text, StringComparison.Ordinal);
    }

    [Fact]
    public void ANewFunctionSkeletonIsWrittenIntoTheCFile()
    {
        var (dir, _) = Fixture.CopyCase("small-c", Names);
        SyncOnce(dir, Cell("u3", "void dsp_reset(void)", "rounded=1;", "grp2"));

        Assert.Contains("void dsp_reset(void)", File.ReadAllText(Path.Combine(dir, "dsp.c")), StringComparison.Ordinal);
        Assert.DoesNotContain("void dsp_reset(void)", File.ReadAllText(Path.Combine(dir, "dsp.h")), StringComparison.Ordinal);
    }

    [Fact]
    public void RerunningSyncIsIdempotent()
    {
        var (dir, _) = Fixture.CopyCase("small-c", Names);
        var cell = Cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1");

        SyncOnce(dir, cell);
        var first = File.ReadAllText(Path.Combine(dir, "adc.h"));
        SyncOnce(dir, cell);

        var second = File.ReadAllText(Path.Combine(dir, "adc.h"));
        Assert.Equal(first, second);
        Assert.Equal(1, second.Split("g_alarm;").Length - 1);
    }

    [Fact]
    public void UntouchedFilesAreNotRewritten()
    {
        var (dir, _) = Fixture.CopyCase("small-c", Names);
        var before = File.ReadAllText(Path.Combine(dir, "dsp.c"));
        SyncOnce(dir, Cell("u1", "int16_t g_alarm", "shape=path;direction=east;", "grp1"));

        Assert.Equal(before, File.ReadAllText(Path.Combine(dir, "dsp.c")));
    }

    /// <summary>
    /// 裸词 ellipse + 只有名字，是「用户在 draw.io 里画了个椭圆写个名字」最常见的形态。
    /// 它必须落进 .h：判成函数会写进 .c，而 .c 里出现一个没有类型的信号是错的。
    /// </summary>
    [Fact]
    public void AnUntypedBareWordEllipseLandsInTheHeaderNotTheCFile()
    {
        var (dir, _) = Fixture.CopyCase("small-c", Names);
        SyncOnce(dir, Cell("u2", "g_unknown", "ellipse;whiteSpace=wrap;html=1;", "grp1"));

        Assert.Contains("g_unknown;", File.ReadAllText(Path.Combine(dir, "adc.h")), StringComparison.Ordinal);
        Assert.DoesNotContain("g_unknown", File.ReadAllText(Path.Combine(dir, "adc.c")), StringComparison.Ordinal);
    }

    /// <summary>
    /// 无类型信号必须落一个**占位类型**：只写 <c>g_unknown;</c> 不是合法 C，而且解析器
    /// 读不回来 -> 下一次 sync 把它当成新元素再追加一遍。这条同时钉住这两件事。
    /// </summary>
    [Fact]
    public void AnUntypedSignalIsIdempotentAndGetsAPlaceholderType()
    {
        var (dir, _) = Fixture.CopyCase("small-c", Names);
        var cell = Cell("u2", "g_unknown", "ellipse;whiteSpace=wrap;html=1;", "grp1");

        SyncOnce(dir, cell);
        var first = File.ReadAllText(Path.Combine(dir, "adc.h"));
        Assert.Contains("int g_unknown;", first, StringComparison.Ordinal);
        Assert.Contains("未能从图里认出类型", first, StringComparison.Ordinal);
        Assert.Equal(1, first.Split("g_unknown;").Length - 1);

        SyncOnce(dir, cell);
        var second = File.ReadAllText(Path.Combine(dir, "adc.h"));
        Assert.Equal(first, second);
        Assert.Equal(1, second.Split("g_unknown;").Length - 1);
    }
}
