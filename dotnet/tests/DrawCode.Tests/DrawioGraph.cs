using System.Globalization;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace DrawCode.Tests;

/// <summary>
/// Structural view of a <c>.drawio</c> document, per <c>../../../docs/conformance.md</c>: attribute
/// order is irrelevant, numbers compare by value, <c>&lt;mxPoint&gt;</c> values are converted
/// to absolute canvas coordinates, and cell ids are not part of the contract — only the
/// <c>symbolId</c> → geometry mapping is.
/// </summary>
internal sealed class DrawioGraph
{
    public Dictionary<string, (double X, double Y, double W, double H)> Containers { get; } = new(StringComparer.Ordinal);

    public Dictionary<string, (string Container, double X, double Y, double W, double H)> Nodes { get; } = new(StringComparer.Ordinal);

    public Dictionary<string, (string? Container, string Anchors, List<(double X, double Y)> Points)> Edges { get; } = new(StringComparer.Ordinal);

    private static readonly Regex AnchorRe = new(@"exitX=([^;]+);exitY=([^;]+);[^;]*;[^;]*;entryX=([^;]+);entryY=([^;]+);", RegexOptions.Compiled);

    private sealed class CellInfo
    {
        public string? Parent { get; init; }
        public string? SymbolId { get; init; }
        public string? Value { get; init; }
        public string? Style { get; init; }
        public bool IsEdge { get; init; }
        public string? Src { get; init; }
        public string? Dst { get; init; }
        public string? Rw { get; init; }
        public XElement? Geometry { get; init; }
    }

    public static DrawioGraph Load(string xml)
    {
        var doc = XDocument.Parse(xml);
        var root = doc.Root ?? throw new InvalidOperationException("empty document");

        var raw = new Dictionary<string, CellInfo>(StringComparer.Ordinal);
        foreach (var el in root.Descendants())
        {
            if (el.Name.LocalName == "object")
            {
                var cell = el.Elements().FirstOrDefault(c => c.Name.LocalName == "mxCell");
                var id = el.Attribute("id")?.Value;
                if (cell is null || id is null)
                {
                    continue;
                }

                raw[id] = new CellInfo
                {
                    Parent = cell.Attribute("parent")?.Value,
                    SymbolId = el.Attribute("symbolId")?.Value,
                    Value = el.Attribute("label")?.Value,
                    Style = cell.Attribute("style")?.Value,
                    IsEdge = cell.Attribute("edge")?.Value == "1",
                    Src = cell.Attribute("source")?.Value,
                    Dst = cell.Attribute("target")?.Value,
                    Rw = el.Attribute("rw")?.Value,
                    Geometry = cell.Elements().FirstOrDefault(g => g.Name.LocalName == "mxGeometry"),
                };
            }
            else if (el.Name.LocalName == "mxCell")
            {
                var id = el.Attribute("id")?.Value;
                if (id is null || id is "0" or "1")
                {
                    continue;
                }

                raw[id] = new CellInfo
                {
                    Parent = el.Attribute("parent")?.Value,
                    SymbolId = null,
                    Value = el.Attribute("value")?.Value,
                    Style = el.Attribute("style")?.Value,
                    IsEdge = el.Attribute("edge")?.Value == "1",
                    Src = el.Attribute("source")?.Value,
                    Dst = el.Attribute("target")?.Value,
                    Rw = null,
                    Geometry = el.Elements().FirstOrDefault(g => g.Name.LocalName == "mxGeometry"),
                };
            }
        }

        var graph = new DrawioGraph();

        foreach (var (id, info) in raw)
        {
            if (info.IsEdge || info.SymbolId is not null)
            {
                continue;
            }

            var geom = info.Geometry;
            if (geom is null)
            {
                continue;
            }

            var (ox, oy) = Origin(raw, info.Parent);
            graph.Containers[info.Value ?? id] = (Num(geom, "x") + ox, Num(geom, "y") + oy, Num(geom, "width"), Num(geom, "height"));
        }

        foreach (var (_, info) in raw)
        {
            if (info.IsEdge || info.SymbolId is null)
            {
                continue;
            }

            var geom = info.Geometry;
            if (geom is null)
            {
                continue;
            }

            var parentName = ContainerNameOf(raw, info.Parent);
            var (ox, oy) = Origin(raw, info.Parent);
            graph.Nodes[info.SymbolId] = (parentName, Num(geom, "x") + ox, Num(geom, "y") + oy, Num(geom, "width"), Num(geom, "height"));
        }

        foreach (var (_, info) in raw)
        {
            if (!info.IsEdge || info.Src is null || info.Dst is null)
            {
                continue;
            }

            var src = raw.TryGetValue(info.Src, out var sc) ? sc.SymbolId : null;
            var dst = raw.TryGetValue(info.Dst, out var dc) ? dc.SymbolId : null;
            if (src is null || dst is null)
            {
                continue;
            }

            var (ox, oy) = Origin(raw, info.Parent);
            var points = new List<(double X, double Y)>();
            var arr = info.Geometry?.Elements().FirstOrDefault(g => g.Name.LocalName == "Array");
            if (arr is not null)
            {
                foreach (var p in arr.Elements().Where(p => p.Name.LocalName == "mxPoint"))
                {
                    points.Add((Num(p, "x") + ox, Num(p, "y") + oy));
                }
            }

            var m = AnchorRe.Match(info.Style ?? "");
            var anchors = m.Success
                ? string.Join(",", new[] { m.Groups[1].Value, m.Groups[2].Value, m.Groups[3].Value, m.Groups[4].Value })
                : "";

            graph.Edges[src + "->" + dst + ":" + (info.Rw ?? "read")] =
                (ContainerNameOf(raw, info.Parent), anchors, points);
        }

        return graph;
    }

    private static string ContainerNameOf(Dictionary<string, CellInfo> raw, string? cid) =>
        cid is not null && raw.TryGetValue(cid, out var c) && c.Value is not null ? c.Value : "";

    private static (double X, double Y) Origin(Dictionary<string, CellInfo> raw, string? cid)
    {
        var x = 0.0;
        var y = 0.0;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        while (cid is not null && cid is not ("0" or "1") && raw.TryGetValue(cid, out var info) && seen.Add(cid))
        {
            if (info.Geometry is not null)
            {
                x += Num(info.Geometry, "x");
                y += Num(info.Geometry, "y");
            }

            cid = info.Parent;
        }

        return (x, y);
    }

    private static double Num(XElement el, string name)
    {
        var raw = el.Attribute(name)?.Value;
        return string.IsNullOrEmpty(raw) ? 0 : double.Parse(raw, NumberStyles.Float, CultureInfo.InvariantCulture);
    }
}
