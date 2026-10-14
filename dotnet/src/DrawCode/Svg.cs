/**
 * IR -> SVG 预览。对等 Python `svg.py` 与 TypeScript `svg.ts`。
 *
 * **这是一份"简化视图"，不是 .drawio 的等价重绘**：
 *   - 节点**复用** drawio 的布局（AssignDefaultPositions / ContainerBox），所以位置一致；
 *   - 边**不复用** Route()，而是从节点中心直连。因此线会穿过节点框，没有锚点、没有折线、
 *     没有障碍规避 —— 这是刻意的，见 `docs/conformance.md` 的
 *     "Known divergence — SVG edge routing is simplified"。
 *
 * 推论：**SVG 的一致性测试不得断言边几何**，否则会把简化行为误当成契约锁死。
 * 也别把这里的边路由"修好"去接 Route() —— 那会让 SVG 与 .drawio 分叉，是另一种破坏。
 * 另外这里**不画方向端口**（端口是 .drawio 专属的视觉元素）。
 */

using System.Text;

namespace DrawCode;

/// <summary>
/// IR → SVG 预览。与 .drawio **共享** <see cref="Drawio.AssignDefaultPositions"/> 与
/// <see cref="Drawio.ContainerBox"/>，所以两者不会各自漂移；但边路由是简化的（见文件头）。
/// </summary>
internal static class Svg
{
    private const string SignalFill = "#d5e8d4";
    private const string SignalStroke = "#82b366";
    private const string FuncFill = "#ffe6cc";
    private const string FuncStroke = "#d79b00";
    private const string ExtFill = "#f5f5f5";
    private const string ExtStroke = "#666666";
    private const string ContFill = "#dae8fc";
    private const string ContStroke = "#6c8ebf";
    private const string EdgeColor = "#666666";
    private const string Font = "Helvetica,Arial,'Microsoft YaHei',sans-serif";

    private static string TextEl(double cx, double cy, IReadOnlyList<string> lines, double size = 12, string anchor = "middle", string fill = "#222222", string? weight = null)
    {
        var n = lines.Count;
        var first = cy - ((n - 1) * size * 0.6);
        var attrs = "text-anchor=\"" + anchor + "\" font-size=\"" + Text.Num(size) + "\" fill=\"" + fill + "\"";
        if (weight is not null)
        {
            attrs += " font-weight=\"" + weight + "\"";
        }

        var head = "<text x=\"" + Text.Num(cx) + "\" y=\"" + Text.Num(first + (size * 0.35)) + "\" " + attrs + ">";
        if (n == 1)
        {
            return head + Text.HtmlEscape(lines[0]) + "</text>";
        }

        var sb = new StringBuilder(head);
        for (var i = 0; i < n; i++)
        {
            var dy = i == 0 ? 0 : size * 1.2;
            sb.Append("<tspan x=\"").Append(Text.Num(cx)).Append("\" dy=\"").Append(Text.Num(dy)).Append("\">")
              .Append(Text.HtmlEscape(lines[i])).Append("</tspan>");
        }

        sb.Append("</text>");
        return sb.ToString();
    }

    private static List<string> NodeLines(string kind, INode e)
    {
        if (kind == "signal")
        {
            var s = (Signal)e;
            var meta = string.Join(" / ", new[] { s.CType, s.Dir, s.Unit }.Where(b => b.Length > 0));
            return meta.Length > 0 ? [s.Name, meta] : [s.Name];
        }

        var f = (Func)e;
        return [(f.Alias.Length > 0 ? f.Alias : f.Name) + "()", f.Ret + " " + f.Name + "()"];
    }

    private static List<(double X, double Y)> EdgePoints(Model model, Edge e)
    {
        INode? src = model.SignalOrNull(e.Src) ?? (INode?)model.FuncOrNull(e.Src);
        INode? dst = model.SignalOrNull(e.Dst) ?? (INode?)model.FuncOrNull(e.Dst);
        if (src is null || dst is null)
        {
            return [];
        }

        var pts = new List<(double X, double Y)> { (src.X + (src.W / 2.0), src.Y + (src.H / 2.0)) };
        pts.AddRange(e.Waypoints);
        pts.Add((dst.X + (dst.W / 2.0), dst.Y + (dst.H / 2.0)));
        if (pts.Count == 2)
        {
            var (x1, y1) = pts[0];
            var (x2, y2) = pts[1];
            var mx = (x1 + x2) / 2.0;
            pts = [(x1, y1), (mx, y1), (mx, y2), (x2, y2)];
        }

        return pts;
    }

    public static string ToSvg(Model model, double padding = 24)
    {
        Drawio.AssignDefaultPositions(model);
        var ents = Drawio.Entities(model).Select(t => t.Node).ToList();

        var groups = Drawio.GroupEntities(model);
        var boxes = groups.ToDictionary(g => g.Key, g => Drawio.ContainerBox(g.Value), StringComparer.Ordinal);

        var xs = ents.Select(e => e.X).Concat(boxes.Values.Select(b => b.X)).ToList();
        var ys = ents.Select(e => e.Y).Concat(boxes.Values.Select(b => b.Y)).ToList();
        var x2 = ents.Select(e => e.X + e.W).Concat(boxes.Values.Select(b => b.X + b.W)).ToList();
        var y2 = ents.Select(e => e.Y + e.H).Concat(boxes.Values.Select(b => b.Y + b.H)).ToList();

        if (ents.Count == 0)
        {
            return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\" viewBox=\"0 0 1 1\"></svg>";
        }

        var minx = xs.Min() - padding;
        var miny = ys.Min() - padding;
        var width = (x2.Max() - minx) + padding;
        var height = (y2.Max() - miny) + padding;

        var sb = new StringBuilder();
        sb.Append("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"").Append(Text.Num(width))
          .Append("\" height=\"").Append(Text.Num(height))
          .Append("\" viewBox=\"").Append(Text.Num(minx)).Append(' ').Append(Text.Num(miny)).Append(' ')
          .Append(Text.Num(width)).Append(' ').Append(Text.Num(height))
          .Append("\" font-family=\"").Append(Font).Append("\">");
        sb.Append("<defs><marker id=\"arrow\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"7\" markerHeight=\"7\" ")
          .Append("orient=\"auto-start-reverse\"><path d=\"M 0 0 L 10 5 L 0 10 z\" fill=\"").Append(EdgeColor)
          .Append("\"/></marker></defs>");

        foreach (var g in boxes.Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            var (ox, oy, ow, oh) = boxes[g];
            sb.Append("<rect x=\"").Append(Text.Num(ox)).Append("\" y=\"").Append(Text.Num(oy))
              .Append("\" width=\"").Append(Text.Num(ow)).Append("\" height=\"").Append(Text.Num(oh))
              .Append("\" rx=\"6\" fill=\"").Append(ContFill).Append("\" stroke=\"").Append(ContStroke)
              .Append("\" data-kind=\"container\"/>");
            sb.Append(TextEl(ox + 12, oy + (Drawio.Header / 2.0), [g], 13, "start", "#222222", "bold"));
        }

        foreach (var (kind, e) in Drawio.Entities(model).OrderBy(t => t.Node.Id, StringComparer.Ordinal))
        {
            var cx = e.X + (e.W / 2.0);
            var cy = e.Y + (e.H / 2.0);
            if (kind == "signal")
            {
                sb.Append("<ellipse cx=\"").Append(Text.Num(cx)).Append("\" cy=\"").Append(Text.Num(cy))
                  .Append("\" rx=\"").Append(Text.Num(e.W / 2.0)).Append("\" ry=\"").Append(Text.Num(e.H / 2.0))
                  .Append("\" fill=\"").Append(SignalFill).Append("\" stroke=\"").Append(SignalStroke)
                  .Append("\" data-kind=\"signal\"/>");
            }
            else
            {
                var dash = e.External ? " stroke-dasharray=\"6 4\"" : "";
                sb.Append("<rect x=\"").Append(Text.Num(e.X)).Append("\" y=\"").Append(Text.Num(e.Y))
                  .Append("\" width=\"").Append(Text.Num(e.W)).Append("\" height=\"").Append(Text.Num(e.H))
                  .Append("\" rx=\"4\" fill=\"").Append(e.External ? ExtFill : FuncFill)
                  .Append("\" stroke=\"").Append(e.External ? ExtStroke : FuncStroke)
                  .Append('"').Append(dash).Append(" data-kind=\"func\"/>");
            }

            sb.Append(TextEl(cx, cy, NodeLines(kind, e)));
        }

        foreach (var e in model.Edges)
        {
            var pts = EdgePoints(model, e);
            if (pts.Count == 0)
            {
                continue;
            }

            sb.Append("<path d=\"M ").Append(string.Join(" L ", pts.Select(p => Text.Num(p.X) + " " + Text.Num(p.Y))))
              .Append("\" fill=\"none\" stroke=\"").Append(EdgeColor)
              .Append("\" stroke-width=\"1.4\" marker-end=\"url(#arrow)\" data-edge=\"1\"/>");
            var (mx, my) = pts[pts.Count / 2];
            sb.Append(TextEl(mx, my - 8, [e.Rw], 10, "middle", "#444444"));
        }

        sb.Append("</svg>");
        return sb.ToString();
    }
}
