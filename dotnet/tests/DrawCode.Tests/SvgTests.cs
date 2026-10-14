using System.Xml.Linq;

namespace DrawCode.Tests;

public class SvgTests
{
    private static readonly Model M = Fixture.SmallC();
    private static readonly string SvgText = Svg.ToSvg(M);
    private static readonly XElement Root = XDocument.Parse(SvgText).Root!;

    private static IEnumerable<XElement> ByLocal(string name) =>
        Root.Descendants().Where(e => e.Name.LocalName == name);

    [Fact]
    public void WellFormedWithViewBox()
    {
        Assert.Equal("svg", Root.Name.LocalName);
        Assert.Equal("http://www.w3.org/2000/svg", Root.Name.NamespaceName);
        var vb = Root.Attribute("viewBox")?.Value;
        Assert.NotNull(vb);
        Assert.Equal(4, vb!.Split(' ').Length);
    }

    [Fact]
    public void EverySymbolHasALabel()
    {
        var text = string.Concat(ByLocal("tspan").Select(t => t.Value));
        foreach (var token in new[] { "g_raw", "g_filtered", "g_coeff", "adc_read", "fir_apply", "dsp_set_gain" })
        {
            Assert.Contains(token, text);
        }
    }

    [Fact]
    public void ContainerTitlesPresent()
    {
        var text = string.Concat(ByLocal("text").Select(t => t.Value));
        Assert.Contains("adc", text);
        Assert.Contains("dsp", text);
    }

    [Fact]
    public void OneShapePerNodeAndOnePathPerEdge()
    {
        var shapes = ByLocal("ellipse").Count()
            + ByLocal("rect").Count(e => e.Attribute("data-kind")?.Value == "func");
        Assert.Equal(6, shapes);
        Assert.Equal(6, ByLocal("path").Count(p => p.Attribute("data-edge") is not null));
    }

    [Fact]
    public void WaypointsReachThePath()
    {
        var m = Fixture.SmallC();
        m.Edges[0].Waypoints = [(700.0, 500.0)];
        var svg = Svg.ToSvg(m);
        Assert.Contains("700", svg);
        Assert.Contains("500", svg);
    }

    [Fact]
    public void ExternalFuncIsDashed()
    {
        var m = Fixture.SmallC();
        m.Funcs["dsp.h::fir_apply"].External = true;
        Assert.Contains("stroke-dasharray", Svg.ToSvg(m));
    }

    [Fact]
    public void EmptyModelProducesAValidOnePixelDocument()
    {
        var svg = Svg.ToSvg(new Model());
        Assert.Contains("width=\"1\" height=\"1\"", svg);
    }

    [Fact]
    public void PreviewSharesDrawioCoordinates()
    {
        var model = Fixture.SmallC();
        var svg = Svg.ToSvg(model);
        var drawio = Drawio.ToDrawio(model);

        var node = model.Signals["adc.h::g_raw"];
        // The SVG draws absolute coordinates; the .drawio stores each child relative to its
        // container origin. Read the diagram back and the origin cancels out, so the two must
        // agree exactly — that is the contract, and it holds without naming a single number.
        var back = Drawio.ReadLayout(drawio).Nodes[node.Id];
        Assert.Equal(node.X, back.X);
        Assert.Equal(node.Y, back.Y);
        Assert.Contains("cx=\"" + Text.Num(node.X + (node.W / 2.0)) + "\"", svg);
        Assert.Contains("cy=\"" + Text.Num(node.Y + (node.H / 2.0)) + "\"", svg);
    }

    /// <summary>
    /// ../../../docs/conformance.md records this as a known divergence: the preview shares node layout with
    /// the .drawio but not the edge router, so edges run centre-to-centre and may cross shapes.
    /// Asserted here so that "improving" the SVG by wiring in <c>Drawio.Route</c> fails loudly.
    /// </summary>
    [Fact]
    public void EdgeRoutingIsDeliberatelySimplified()
    {
        var model = Fixture.SmallC();
        var svg = Svg.ToSvg(model);
        var drawio = Drawio.ToDrawio(model);

        var src = model.Funcs["adc.h::adc_read"];
        var dst = model.Signals["adc.h::g_filtered"];
        var srcCentre = "M " + Text.Num(src.X + (src.W / 2.0)) + " " + Text.Num(src.Y + (src.H / 2.0));
        var dstCentre = "L " + Text.Num(dst.X + (dst.W / 2.0)) + " " + Text.Num(dst.Y + (dst.H / 2.0));

        Assert.Contains(srcCentre, svg);
        Assert.Contains(dstCentre, svg);

        // The .drawio side, by contrast, carries explicit anchors — that is the router's output.
        Assert.Contains("exitX=", drawio);
        Assert.DoesNotContain("exitX=", svg);
    }
}
