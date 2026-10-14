using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace DrawCode.Tests;

public class DrawioEmitTests
{
    private static readonly string Xml = Drawio.ToDrawio(Fixture.SmallC());

    [Fact]
    public void WellFormedAndCommentFree()
    {
        _ = XDocument.Parse(Xml);
        Assert.DoesNotContain("<!--", Xml);
    }

    [Fact]
    public void EverySymbolIsAnObjectWithSymbolId()
    {
        var ids = XDocument.Parse(Xml).Descendants()
            .Where(e => e.Name.LocalName == "object")
            .Select(o => o.Attribute("symbolId")?.Value)
            .ToHashSet(StringComparer.Ordinal);
        foreach (var sid in new[]
        {
            "adc.h::g_raw", "adc.h::g_filtered", "dsp.h::g_coeff",
            "adc.h::adc_read", "dsp.h::fir_apply", "dsp.h::dsp_set_gain",
        })
        {
            Assert.Contains(sid, ids);
        }
    }

    [Fact]
    public void CellIdsAreSafe()
    {
        foreach (var o in XDocument.Parse(Xml).Descendants().Where(e => e.Name.LocalName == "object"))
        {
            var id = o.Attribute("id")!.Value;
            Assert.DoesNotContain("::", id);
            Assert.DoesNotContain("/", id);
        }
    }

    [Fact]
    public void SignalAttributes()
    {
        var obj = Object("adc.h::g_raw");
        Assert.Equal("signal", obj.Attribute("kind")?.Value);
        Assert.Equal("in", obj.Attribute("dir")?.Value);
        Assert.Equal("int16_t", obj.Attribute("ctype")?.Value);
        Assert.Equal("LSB", obj.Attribute("unit")?.Value);
        Assert.Equal("原始采样值", obj.Attribute("alias")?.Value);
    }

    [Fact]
    public void DirectionShapesEncodeFlowAndTipsSitOnEdgeMidpoints()
    {
        // 这条需要独立守卫：conformance 只比较结构，形状差异全在 style 里，把形状
        // 改回椭圆不会有任何测试变红。
        //
        // 另一半同样重要：尖角必须精确落在左右边缘中点上。AnchorSets 的首选锚点是
        // (1.0,0.5)/(0.0,0.5)，只有尖角与它重合，连线才会咬在尖角上；一旦路径坐标
        // 改动而锚点没跟着改，线就会悬在平边上。
        var inStyle = StyleOf("adc.h::g_raw");
        Assert.Contains("shape=path", inStyle, StringComparison.Ordinal);
        var inTip = TipOf(inStyle, rightmost: true);
        Assert.Equal(160.0, inTip.X);
        Assert.Equal(30.0, inTip.Y);

        var outStyle = StyleOf("adc.h::g_filtered");
        Assert.Contains("shape=path", outStyle, StringComparison.Ordinal);
        var outTip = TipOf(outStyle, rightmost: false);
        Assert.Equal(0.0, outTip.X);
        Assert.Equal(30.0, outTip.Y);

        // 示例里三个信号都有方向（in/out/in），没有"无方向 -> 椭圆"的用例可测；
        // 那个分支由 ToDrawio 里查不到方向时的默认值兜底。
    }

    [Fact]
    public void SignalNodesStillCarrySymbolIdAfterTheShapeChange()
    {
        var signals = XDocument.Parse(Xml).Descendants()
            .Where(e => e.Name.LocalName == "object" && e.Attribute("kind")?.Value == "signal")
            .ToList();
        Assert.Equal(3, signals.Count);
        Assert.All(signals, o => Assert.False(string.IsNullOrEmpty(o.Attribute("symbolId")?.Value)));
    }

    [Fact]
    public void DirectionConstrainedEdgesNeverLandOnTopOrBottomSides()
    {
        // 五边形的尖角在左右边缘的中点，所以受方向约束的边只允许 y=0.5 的锚点。
        // 这条钉住的是"锚点不许自由选上/下边"这个契约本身。
        var edges = XDocument.Parse(Xml).Descendants()
            .Where(e => e.Name.LocalName == "mxCell")
            .Select(c => c.Attribute("style")?.Value ?? "")
            .Where(s => s.Contains("exitY=", StringComparison.Ordinal))
            .ToList();
        Assert.NotEmpty(edges);
        foreach (var style in edges)
        {
            var m = Regex.Match(style, @"exitY=([\d.]+);.*entryY=([\d.]+);");
            Assert.True(m.Success, style);
            Assert.Equal("0.5", m.Groups[1].Value);
            Assert.Equal("0.5", m.Groups[2].Value);
        }
    }

    [Fact]
    public void FuncAttributesIncludeDevice()
    {
        var obj = Object("adc.h::adc_read");
        Assert.Equal("func", obj.Attribute("kind")?.Value);
        Assert.Equal("TI", obj.Attribute("vendor")?.Value);
        Assert.Equal("ADS1115", obj.Attribute("model")?.Value);
        Assert.Equal("16bit/860SPS", obj.Attribute("spec")?.Value);
        Assert.Equal("2.0x3.0mm", obj.Attribute("size")?.Value);
        Assert.Equal("assets/ads1115.svg", obj.Attribute("asset")?.Value);
        Assert.Equal("上电后需先校准", obj.Attribute("tooltip")?.Value);
    }

    [Fact]
    public void LabelUsesHtmlBrNotRawNewline()
    {
        var label = Object("adc.h::g_raw").Attribute("label")!.Value;
        Assert.Contains("<br>", label);
        Assert.DoesNotContain("\n", label);
    }

    [Fact]
    public void ContainerTitlesAreHtmlEscaped()
    {
        var model = Fixture.SmallC();
        model.Signals["adc.h::g_raw"].Group = "a<b&c";
        var xml = Drawio.ToDrawio(model);
        Assert.Contains("value=\"a&lt;b&amp;c\"", xml);
        Assert.DoesNotContain("value=\"a<b&c\"", xml);
    }

    [Fact]
    public void GroupContainersAndRelativeChildren()
    {
        var root = XDocument.Parse(Xml);
        var containers = root.Descendants()
            .Where(c => c.Name.LocalName == "mxCell" && (c.Attribute("style")?.Value ?? "").Contains("swimlane", StringComparison.Ordinal))
            .ToList();
        Assert.Equal(2, containers.Count);

        var ids = containers.Select(c => c.Attribute("id")!.Value).ToHashSet(StringComparer.Ordinal);
        foreach (var o in root.Descendants().Where(e => e.Name.LocalName == "object"))
        {
            var cell = o.Elements().First(e => e.Name.LocalName == "mxCell");
            if (cell.Attribute("vertex")?.Value == "1")
            {
                Assert.Contains(cell.Attribute("parent")!.Value, ids);
            }
        }
    }

    [Fact]
    public void EdgeParentIsTheInnermostCommonContainer()
    {
        var root = XDocument.Parse(Xml);
        var objParent = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var o in root.Descendants().Where(e => e.Name.LocalName == "object"))
        {
            var cell = o.Elements().First(e => e.Name.LocalName == "mxCell");
            objParent[o.Attribute("id")!.Value] = cell.Attribute("parent")!.Value;
        }

        foreach (var o in root.Descendants().Where(e => e.Name.LocalName == "object"))
        {
            var cell = o.Elements().First(e => e.Name.LocalName == "mxCell");
            if (cell.Attribute("edge")?.Value != "1")
            {
                continue;
            }

            var p = objParent[cell.Attribute("source")!.Value];
            var q = objParent[cell.Attribute("target")!.Value];
            Assert.Equal(p == q ? p : "1", cell.Attribute("parent")!.Value);
        }
    }

    [Fact]
    public void EdgesCarrySemantics()
    {
        var rels = XDocument.Parse(Xml).Descendants()
            .Where(e => e.Name.LocalName == "object" && e.Attribute("rel") is not null)
            .Select(o => (o.Attribute("src")!.Value, o.Attribute("dst")!.Value, o.Attribute("rw")!.Value))
            .ToList();
        Assert.Contains(("adc.h::g_raw", "adc.h::adc_read", "read"), rels);
        Assert.Contains(("adc.h::adc_read", "adc.h::g_filtered", "write"), rels);
        Assert.Equal(6, rels.Count);
    }

    [Fact]
    public void NoXmlDeclarationIsEmitted()
    {
        Assert.StartsWith("<mxfile", Xml, StringComparison.Ordinal);
        Assert.DoesNotContain("<?xml", Xml);
    }

    [Fact]
    public void IntegralCoordinatesPrintWithoutADecimalPoint()
    {
        // Every coordinate here is a whole number, so none may be printed as "420.0".
        // Asserted over the whole document rather than one hard-coded cell, so that a
        // layout change does not quietly turn this into a test of nothing.
        var values = Regex.Matches(Xml, "(?:x|y|width|height)=\"([^\"]*)\"")
            .Select(m => m.Groups[1].Value)
            .ToList();
        Assert.NotEmpty(values);
        Assert.All(values, v => Assert.DoesNotContain(".0", v, StringComparison.Ordinal));
        Assert.Contains("160", values);
    }

    private static XElement Object(string symbolId) =>
        XDocument.Parse(Xml).Descendants()
            .First(e => e.Name.LocalName == "object" && e.Attribute("symbolId")?.Value == symbolId);

    private static string StyleOf(string symbolId) =>
        Object(symbolId).Elements().First(e => e.Name.LocalName == "mxCell").Attribute("style")!.Value;

    /// <summary>从 style 的 path= 里取出最靠某一侧的顶点（即五边形的尖角）。</summary>
    private static (double X, double Y) TipOf(string style, bool rightmost)
    {
        var seg = style.Split(';').First(s => s.StartsWith("path=", StringComparison.Ordinal));
        var pts = seg["path=".Length..].Split(' ')
            .Select(p => p.Split(','))
            .Select(v => (
                X: double.Parse(v[0], CultureInfo.InvariantCulture),
                Y: double.Parse(v[1], CultureInfo.InvariantCulture)))
            .ToList();
        return rightmost ? pts.OrderByDescending(p => p.X).First() : pts.OrderBy(p => p.X).First();
    }
}

public class DrawioReadBackTests
{
    [Fact]
    public void LayoutRoundtrip()
    {
        var m = Fixture.SmallC();
        m.Funcs["adc.h::adc_read"].X = 1234;
        m.Funcs["adc.h::adc_read"].Y = 567;
        m.Signals["adc.h::g_raw"].X = 11;
        m.Signals["adc.h::g_raw"].Y = 22;
        var xml = Drawio.ToDrawio(m);

        var m2 = Fixture.SmallC();
        Drawio.ApplyLayout(m2, Drawio.ReadLayout(xml));
        Assert.Equal((1234.0, 567.0), (m2.Funcs["adc.h::adc_read"].X, m2.Funcs["adc.h::adc_read"].Y));
        Assert.Equal((11.0, 22.0), (m2.Signals["adc.h::g_raw"].X, m2.Signals["adc.h::g_raw"].Y));
    }

    [Fact]
    public void WaypointsRoundtrip()
    {
        var m = Fixture.SmallC();
        m.Edges[0].Waypoints = [(100.0, 200.0), (300.0, 400.0)];
        var layout = Drawio.ReadLayout(Drawio.ToDrawio(m));
        var key = Drawio.EdgeKey(m.Edges[0]);
        Assert.Equal([(100.0, 200.0), (300.0, 400.0)], layout.Edges[key]);
    }

    [Fact]
    public void ReadingAHandEditedFile()
    {
        var m = Fixture.SmallC();
        var edited = Drawio.ToDrawio(m).Replace("width=\"160\" height=\"60\"", "width=\"260\" height=\"90\"", StringComparison.Ordinal);
        Drawio.ApplyLayout(m, Drawio.ReadLayout(edited));
        var s = m.Signals["adc.h::g_raw"];
        Assert.Equal((260.0, 90.0), (s.W, s.H));
    }

    [Fact]
    public void AutoWaypointsAreRecomputableRatherThanFrozen()
    {
        var m = Fixture.SmallC();
        var xml = Drawio.ToDrawio(m);
        var m2 = Fixture.SmallC();
        Drawio.ApplyLayout(m2, Drawio.ReadLayout(xml));
        foreach (var e in m2.Edges)
        {
            Assert.Empty(e.Waypoints);
        }
    }

    [Fact]
    public void HandDraggedWaypointsSurvive()
    {
        var m = Fixture.SmallC();
        var original = Drawio.ToDrawio(m);

        // Take whichever auto waypoint the router produced rather than hard-coding one: a
        // hard-coded coordinate stops matching as soon as the layout changes, and Replace then
        // edits nothing, leaving the test asserting a no-op.
        var first = Regex.Match(original, "<mxPoint x=\"[^\"]*\" y=\"([^\"]*)\" />");
        Assert.True(first.Success, "the generated diagram must contain at least one auto waypoint");

        var xml = original.Replace(first.Value, "<mxPoint x=\"999\" y=\"" + first.Groups[1].Value + "\" />", StringComparison.Ordinal);
        Assert.NotEqual(original, xml);

        // mxPoint is parent-relative in the file; read-back normalises it to canvas coordinates,
        // so the absolute value depends on the container origin. Assert the contract instead of a
        // number: the dragged edge must still carry explicit waypoints that differ from the ones
        // the router computes on its own — i.e. the drag was preserved rather than recomputed away.
        var before = Drawio.ReadLayout(original);
        var after = Drawio.ReadLayout(xml);
        var key = after.Edges.First(kv => kv.Value.Count > 0).Key;
        Assert.NotEmpty(before.Edges[key]);
        Assert.NotEqual(before.Edges[key], after.Edges[key]);
    }
}

public class DrawioCompressedTests
{
    [Fact]
    public void CompressedDiagramMatchesPlain()
    {
        var plain = Drawio.ReadLayout(Drawio.ToDrawio(Fixture.SmallC()));
        var packed = Drawio.ReadLayout(Pack(Drawio.ToDrawio(Fixture.SmallC())));

        Assert.NotEmpty(packed.Nodes);
        Assert.Equal(
            plain.Nodes.OrderBy(k => k.Key, StringComparer.Ordinal),
            packed.Nodes.OrderBy(k => k.Key, StringComparer.Ordinal));
        Assert.Equal(
            plain.Edges.OrderBy(k => k.Key, StringComparer.Ordinal),
            packed.Edges.OrderBy(k => k.Key, StringComparer.Ordinal));
        Assert.Equal(
            plain.Attrs.OrderBy(k => k.Key, StringComparer.Ordinal),
            packed.Attrs.OrderBy(k => k.Key, StringComparer.Ordinal));
    }

    [Fact]
    public void CompressedLayoutIsNotSilentlyDropped()
    {
        var m = Fixture.SmallC();
        m.Signals["adc.h::g_raw"].X = 11;
        m.Signals["adc.h::g_raw"].Y = 22;
        m.Funcs["adc.h::adc_read"].X = 1234;
        m.Funcs["adc.h::adc_read"].Y = 567;

        var m2 = Fixture.SmallC();
        Drawio.ApplyLayout(m2, Drawio.ReadLayout(Pack(Drawio.ToDrawio(m))));
        Assert.Equal((1234.0, 567.0), (m2.Funcs["adc.h::adc_read"].X, m2.Funcs["adc.h::adc_read"].Y));
        Assert.Equal((11.0, 22.0), (m2.Signals["adc.h::g_raw"].X, m2.Signals["adc.h::g_raw"].Y));
    }

    [Fact]
    public void CompressedWaypointsRoundtrip()
    {
        var m = Fixture.SmallC();
        m.Edges[0].Waypoints = [(100.0, 200.0), (300.0, 400.0)];
        var layout = Drawio.ReadLayout(Pack(Drawio.ToDrawio(m)));
        Assert.Equal([(100.0, 200.0), (300.0, 400.0)], layout.Edges[Drawio.EdgeKey(m.Edges[0])]);
    }

    [Fact]
    public void UnreadableDiagramRaisesInsteadOfReturningEmpty()
    {
        const string Bad = "<mxfile><diagram id=\"d\" name=\"p\">not-a-compressed-payload</diagram></mxfile>";
        _ = Assert.Throws<InvalidOperationException>(() => Drawio.ReadLayout(Bad));
    }

    [Fact]
    public void PercentDecodeMirrorsUrllibUnquote()
    {
        Assert.Equal("a b", Drawio.PercentDecode("a%20b"));
        Assert.Equal("中文", Drawio.PercentDecode("%E4%B8%AD%E6%96%87"));
        Assert.Equal("100%", Drawio.PercentDecode("100%"));
        Assert.Equal("%zz", Drawio.PercentDecode("%zz"));
    }

    /// <summary>Reproduces draw.io's save format: base64(raw deflate(percent-encode(xml))).</summary>
    private static string Pack(string xml)
    {
        var doc = XDocument.Parse(xml, LoadOptions.PreserveWhitespace);
        foreach (var d in doc.Descendants().Where(e => e.Name.LocalName == "diagram").ToList())
        {
            var inner = d.Elements().FirstOrDefault(e => e.Name.LocalName == "mxGraphModel");
            if (inner is null)
            {
                continue;
            }

            var text = inner.ToString(SaveOptions.DisableFormatting);
            using var ms = new MemoryStream();
            using (var deflate = new DeflateStream(ms, CompressionLevel.Optimal, leaveOpen: true))
            {
                deflate.Write(Encoding.UTF8.GetBytes(PercentEncode(text)));
            }

            d.ReplaceNodes(new XText(Convert.ToBase64String(ms.ToArray())));
        }

        return doc.ToString(SaveOptions.DisableFormatting);
    }

    private static string PercentEncode(string s)
    {
        var sb = new StringBuilder();
        foreach (var b in Encoding.UTF8.GetBytes(s))
        {
            var c = (char)b;
            if (char.IsAsciiLetterOrDigit(c) || "_.-~()*!'".Contains(c, StringComparison.Ordinal))
            {
                sb.Append(c);
            }
            else
            {
                sb.Append('%').Append(b.ToString("X2", CultureInfo.InvariantCulture));
            }
        }

        return sb.ToString();
    }
}
