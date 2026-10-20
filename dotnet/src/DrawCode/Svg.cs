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
using System.Text.RegularExpressions;

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

    private static readonly Regex BrRe = new(@"<br\s*/?>", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex StrokeRe = new(@"strokeColor=(#[0-9a-fA-F]{3,8})", RegexOptions.Compiled);

    /// <summary>文字块按 <c>&lt;br&gt;</c> 断行 —— 与 .drawio 侧 html=1 的换行语义是同一件事。</summary>
    private static List<string> CalloutLines(Callout c) => [.. BrRe.Split(c.Text)];

    /// <summary>
    /// 画一个文字块。band 铺在容器之上、节点之下；box/text 画在节点之后压在上面。
    /// 先后次序由调用点决定，这里只负责画 —— 与 <see cref="Drawio.ToDrawio"/> 的
    /// EmitCallouts 对齐。
    /// </summary>
    private static string CalloutSvg(Callout c)
    {
        var size = c.FontSize > 0 ? c.FontSize : Drawio.CalloutFont.GetValueOrDefault(c.Shape, 12);
        var sb = new StringBuilder();
        if (c.Shape != "text")
        {
            var dash = c.Shape == "band" ? " stroke-dasharray=\"6 4\"" : "";
            sb.Append("<rect x=\"").Append(Text.Num(c.X)).Append("\" y=\"").Append(Text.Num(c.Y))
              .Append("\" width=\"").Append(Text.Num(c.W)).Append("\" height=\"").Append(Text.Num(c.H))
              .Append("\" rx=\"4\" fill=\"").Append(Drawio.CalloutFill.GetValueOrDefault(c.Shape, "none"))
              .Append("\" stroke=\"").Append(Drawio.CalloutStroke.GetValueOrDefault(c.Shape, "none"))
              .Append('"').Append(dash).Append(" data-kind=\"callout\"/>");
        }

        // verticalAlign=top / spacingTop=6 / spacingLeft=8，与 drawio 的 CalloutStyle 间距对齐
        sb.Append(TextEl(
            c.X + 8,
            c.Y + 6 + (size * 0.75),
            CalloutLines(c),
            size,
            "start",
            "#222222",
            c.Shape == "band" ? "bold" : null));
        return sb.ToString();
    }

    /// <summary>
    /// 边上显示的文字：内联边用被折叠信号的 unit（退回 name），其余仍是 rw。
    ///
    /// <paramref name="rwLabels"/> 为 false 时去掉 read/write —— 与
    /// <see cref="Drawio.InlineEdgeLabel"/> 同一套口径；注意<b>不剥</b>内联边的语义标签：
    /// 那是信号名，不是冗余的方向说明。
    /// </summary>
    private static string EdgeLabel(Model model, Edge e, bool rwLabels)
    {
        if (e.Rw == "inline" && !string.IsNullOrEmpty(e.Sig))
        {
            var sig = model.SignalOrNull(e.Sig);
            if (sig is not null)
            {
                return sig.Unit.Length > 0 ? sig.Unit : sig.Name;
            }
        }

        return rwLabels ? e.Rw : "";
    }

    /// <summary>内联边沿用被折叠信号的 <c>Style</c> 片段里的线色；取不到就用默认色。</summary>
    private static string EdgeColorOf(Model model, Edge e)
    {
        if (e.Rw != "inline" || string.IsNullOrEmpty(e.Sig))
        {
            return EdgeColor;
        }

        var sig = model.SignalOrNull(e.Sig);
        var m = StrokeRe.Match(sig?.Style ?? "");
        return m.Success ? m.Groups[1].Value : EdgeColor;
    }

    /// <summary>
    /// 边的折线点。<b>这里就是与 drawio 分道扬镳的地方</b>（见模块头）。
    ///
    /// 两端取节点中心；没有人工拐点时补一个中点直角折弯，让线看起来像正交路由。
    /// 不做任何障碍检测。直线模式直接连两点，不补肘点；人工拐点同样保留。
    /// </summary>
    private static List<(double X, double Y)> EdgePoints(Model model, Edge e, bool straightEdges = false)
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
        if (straightEdges)
        {
            return pts;
        }

        if (pts.Count == 2)
        {
            var (x1, y1) = pts[0];
            var (x2, y2) = pts[1];
            var mx = (x1 + x2) / 2.0;
            pts = [(x1, y1), (mx, y1), (mx, y2), (x2, y2)];
        }

        return pts;
    }

    public static string ToSvg(Model model, double padding = 24, bool cards = false, bool rwLabels = true, bool straightEdges = false)
    {
        Drawio.AssignDefaultPositions(model);
        // Drawio.Entities 已经跳过被 inline 折叠的信号：否则图上剩一堆没有边的空椭圆
        var entities = Drawio.Entities(model);
        var ents = entities.Select(t => t.Node).ToList();

        // 预览图只画**顶层**容器，与 Python `svg.py` / TypeScript `svg.ts` 一致：
        // 它们也是按 Group（path 的第一段）分组的。嵌套层级只在 .drawio 里体现，
        // 改这里会让三语言的 SVG 分叉。
        var groups = new Dictionary<string, List<INode>>(StringComparer.Ordinal);
        foreach (var (_, e) in entities)
        {
            var key = e.Group.Length > 0 ? e.Group : "misc";
            if (!groups.TryGetValue(key, out var list))
            {
                list = [];
                groups[key] = list;
            }

            list.Add(e);
        }

        var boxes = groups.ToDictionary(g => g.Key, g => Drawio.ContainerBox(g.Value), StringComparer.Ordinal);

        if (ents.Count == 0)
        {
            return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\" viewBox=\"0 0 1 1\"></svg>";
        }

        // 文字块也计入画布范围：否则一张主要靠文字说明的图会被裁得只剩卡片
        var calloutXs = model.Callouts.SelectMany(c => new[] { c.X, c.X + c.W }).ToList();
        var calloutYs = model.Callouts.SelectMany(c => new[] { c.Y, c.Y + c.H }).ToList();

        var xs = ents.Select(e => e.X).Concat(boxes.Values.Select(b => b.X)).Concat(calloutXs).ToList();
        var ys = ents.Select(e => e.Y).Concat(boxes.Values.Select(b => b.Y)).Concat(calloutYs).ToList();
        var x2 = ents.Select(e => e.X + e.W).Concat(boxes.Values.Select(b => b.X + b.W)).Concat(calloutXs).ToList();
        var y2 = ents.Select(e => e.Y + e.H).Concat(boxes.Values.Select(b => b.Y + b.H)).Concat(calloutYs).ToList();

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

        // 先画容器，再画 band，再画节点，最后画说明与边——SVG 无 z-index，顺序即层级
        foreach (var g in boxes.Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            var (ox, oy, ow, oh) = boxes[g];
            sb.Append("<rect x=\"").Append(Text.Num(ox)).Append("\" y=\"").Append(Text.Num(oy))
              .Append("\" width=\"").Append(Text.Num(ow)).Append("\" height=\"").Append(Text.Num(oh))
              .Append("\" rx=\"6\" fill=\"").Append(ContFill).Append("\" stroke=\"").Append(ContStroke)
              .Append("\" data-kind=\"container\"/>");
            sb.Append(TextEl(ox + 12, oy + (Drawio.Header / 2.0), [g], 13, "start", "#222222", "bold"));
        }

        foreach (var c in model.Callouts.Where(c => c.Shape == "band"))
        {
            sb.Append(CalloutSvg(c));
        }

        foreach (var (kind, e) in entities.OrderBy(t => t.Node.Id, StringComparer.Ordinal))
        {
            var cx = e.X + (e.W / 2.0);
            var cy = e.Y + (e.H / 2.0);
            var isCard = kind == "func" && cards && ((Func)e).Asset.Length > 0;
            if (kind == "signal")
            {
                sb.Append("<ellipse cx=\"").Append(Text.Num(cx)).Append("\" cy=\"").Append(Text.Num(cy))
                  .Append("\" rx=\"").Append(Text.Num(e.W / 2.0)).Append("\" ry=\"").Append(Text.Num(e.H / 2.0))
                  .Append("\" fill=\"").Append(SignalFill).Append("\" stroke=\"").Append(SignalStroke)
                  .Append("\" data-kind=\"signal\"/>");
            }
            else if (isCard)
            {
                // 设备卡片：图片占满节点框。preserveAspectRatio="none" 与 imageAspect=0
                // 同义：跟着框变形，不留等比白边。
                var asset = ((Func)e).Asset;
                sb.Append("<image x=\"").Append(Text.Num(e.X)).Append("\" y=\"").Append(Text.Num(e.Y))
                  .Append("\" width=\"").Append(Text.Num(e.W)).Append("\" height=\"").Append(Text.Num(e.H))
                  .Append("\" preserveAspectRatio=\"none\" href=\"").Append(Text.HtmlEscape(asset))
                  .Append("\" data-kind=\"image\"/>");
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

            if (isCard)
            {
                // 卡片标签只有一行（对应 drawio 的 verticalLabelPosition=bottom）
                var f = (Func)e;
                sb.Append(TextEl(cx, e.Y + e.H + 16, [f.Alias.Length > 0 ? f.Alias : f.Name], 13, weight: "bold"));
            }
            else
            {
                sb.Append(TextEl(cx, cy, NodeLines(kind, e)));
            }
        }

        // 说明文字后画，压在卡片上面
        foreach (var c in model.Callouts.Where(c => c.Shape != "band"))
        {
            sb.Append(CalloutSvg(c));
        }

        foreach (var e in model.Edges)
        {
            var pts = EdgePoints(model, e, straightEdges);
            if (pts.Count == 0)
            {
                continue;
            }

            sb.Append("<path d=\"M ").Append(string.Join(" L ", pts.Select(p => Text.Num(p.X) + " " + Text.Num(p.Y))))
              .Append("\" fill=\"none\" stroke=\"").Append(EdgeColorOf(model, e))
              .Append("\" stroke-width=\"1.4\" marker-end=\"url(#arrow)\" data-edge=\"1\"/>");

            // 标签可能被 --no-rw-labels 关掉；空标签不落文字，免得留下一堆空 <text>
            var label = EdgeLabel(model, e, rwLabels);
            if (label.Length > 0)
            {
                var (mx, my) = pts[pts.Count / 2];
                // 这里**不做**平行边的标签去叠印（.drawio 侧做了，见 SeparateLabels）。
                // 原因：SVG 的一致性测试不得断言边几何，标签位置同理；只改一侧会制造
                // 预览与 .drawio 的差异。要动就得三份一起动，那是另一件事。
                sb.Append(TextEl(mx, my - 8, [label], 10, "middle", "#444444"));
            }
        }

        sb.Append("</svg>");
        return sb.ToString();
    }
}
