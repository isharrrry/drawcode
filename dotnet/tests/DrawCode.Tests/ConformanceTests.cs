using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using System.Xml.Schema;

namespace DrawCode.Tests;

/// <summary>
/// L1–L4 conformance against <c>tests/golden</c>. Comparison is structural, never byte-wise —
/// see <c>../../../docs/conformance.md</c>. A missing golden file throws rather than skipping: a
/// skipped conformance test makes an unverified implementation look verified.
/// </summary>
public class ConformanceTests
{
    private static string[] InputsFor(string caseName) => caseName switch
    {
        "small-c" => TestPaths.Inputs(caseName, "adc.h", "adc.c", "dsp.h", "dsp.c"),
        "small-cs" => TestPaths.Inputs(caseName, "Adc.cs", "Dsp.cs"),
        _ => throw new ArgumentOutOfRangeException(nameof(caseName), caseName, "unknown case"),
    };

    private static string RootFor(string caseName) => Path.Combine(TestPaths.Case(caseName), "input");

    private static Model ModelFor(string caseName)
    {
        var root = RootFor(caseName);
        return ParseDispatch.ParseAny(InputsFor(caseName), root);
    }

    [Theory]
    [InlineData("small-c")]
    [InlineData("small-cs")]
    public void L1_Parse_MatchesGoldenIr(string caseName)
    {
        var actual = JsonNode.Parse(IrJson.ToJson(ModelFor(caseName)));
        var expected = JsonNode.Parse(File.ReadAllText(TestPaths.Golden(caseName, "expected.ir.json")));
        AssertJsonEqual(expected, actual, "$");
    }

    [Theory]
    [InlineData("small-c")]
    [InlineData("small-cs")]
    public void L2_GraphStructure_MatchesGolden(string caseName)
    {
        var actual = DrawioGraph.Load(Drawio.ToDrawio(ModelFor(caseName)));
        var expected = DrawioGraph.Load(File.ReadAllText(TestPaths.Golden(caseName, "expected.drawio")));

        Assert.Equal(
            expected.Containers.Keys.OrderBy(k => k, StringComparer.Ordinal),
            actual.Containers.Keys.OrderBy(k => k, StringComparer.Ordinal));
        Assert.Equal(
            expected.Nodes.Keys.OrderBy(k => k, StringComparer.Ordinal),
            actual.Nodes.Keys.OrderBy(k => k, StringComparer.Ordinal));
        Assert.Equal(
            expected.Edges.Keys.OrderBy(k => k, StringComparer.Ordinal),
            actual.Edges.Keys.OrderBy(k => k, StringComparer.Ordinal));

        foreach (var (sid, node) in expected.Nodes)
        {
            Assert.Equal(node.Container, actual.Nodes[sid].Container);
        }

        foreach (var (key, edge) in expected.Edges)
        {
            Assert.Equal(edge.Container, actual.Edges[key].Container);
        }
    }

    [Theory]
    [InlineData("small-c")]
    [InlineData("small-cs")]
    public void L3_Geometry_MatchesGolden(string caseName)
    {
        var actual = DrawioGraph.Load(Drawio.ToDrawio(ModelFor(caseName)));
        var expected = DrawioGraph.Load(File.ReadAllText(TestPaths.Golden(caseName, "expected.drawio")));

        foreach (var (name, box) in expected.Containers)
        {
            Assert.Equal(box, actual.Containers[name]);
        }

        foreach (var (sid, node) in expected.Nodes)
        {
            Assert.Equal(node, actual.Nodes[sid]);
        }

        foreach (var (key, edge) in expected.Edges)
        {
            Assert.Equal(edge.Anchors, actual.Edges[key].Anchors);
            Assert.Equal(edge.Points, actual.Edges[key].Points);
        }
    }

    [Theory]
    [InlineData("small-c")]
    [InlineData("small-cs")]
    public void L4_GeneratedDiagramValidatesAgainstOfficialSchema(string caseName)
    {
        ValidateAgainstSchema(Drawio.ToDrawio(ModelFor(caseName)));
    }

    [Fact]
    public void L4_DiagramWithWaypointsValidates()
    {
        var model = ModelFor("small-c");
        model.Edges[0].Waypoints = [(10.0, 20.0), (30.0, 40.0)];
        ValidateAgainstSchema(Drawio.ToDrawio(model));
    }

    private static void ValidateAgainstSchema(string xml)
    {
        var schemas = new XmlSchemaSet();
        schemas.Add(null, TestPaths.XsdPath);

        var errors = new List<string>();
        XDocument.Parse(xml).Validate(schemas, (_, e) => errors.Add(e.Message));
        Assert.Empty(errors);
    }

    /// <summary>Structural JSON equality; numbers compare by value, key order is irrelevant.</summary>
    private static void AssertJsonEqual(JsonNode? expected, JsonNode? actual, string path)
    {
        if (expected is null || actual is null)
        {
            Assert.True(expected is null && actual is null, $"{path}: null mismatch");
            return;
        }

        if (expected is JsonObject eo)
        {
            var ao = actual as JsonObject;
            Assert.True(ao is not null, $"{path}: expected an object");
            Assert.Equal(
                eo.Select(kv => kv.Key).OrderBy(k => k, StringComparer.Ordinal),
                ao!.Select(kv => kv.Key).OrderBy(k => k, StringComparer.Ordinal));
            foreach (var (key, value) in eo)
            {
                AssertJsonEqual(value, ao[key], path + "." + key);
            }

            return;
        }

        if (expected is JsonArray ea)
        {
            var aa = actual as JsonArray;
            Assert.True(aa is not null, $"{path}: expected an array");
            Assert.Equal(ea.Count, aa!.Count);
            for (var i = 0; i < ea.Count; i++)
            {
                AssertJsonEqual(ea[i], aa[i], $"{path}[{i}]");
            }

            return;
        }

        var ev = expected.GetValue<JsonElement>();
        var av = actual.GetValue<JsonElement>();
        if (ev.ValueKind == JsonValueKind.Number && av.ValueKind == JsonValueKind.Number)
        {
            Assert.Equal(ev.GetDouble(), av.GetDouble(), 9);
            return;
        }

        Assert.Equal(ev.GetRawText(), av.GetRawText());
    }
}
