using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Xml.Linq;

namespace DrawCode;

/// <summary>
/// IR ↔ .drawio。这里是布局与路由的**参考规格**：三个实现必须在几何上精确一致，
/// 所以此处的每个常量与每个平局判据（锚点顺序、候选顺序、长度比较用严格的 <c>&lt;</c>）
/// 都是**契约**，不是随手取的数。
/// </summary>
internal static class Drawio
{
    internal const double Pad = 30;
    internal const double Header = 30;
    internal const double GapY = 40;
    internal const double Detour = 15;
    internal const double Slack = 2;
    internal const double Shrink = 3;

    internal const string SignalStyle = "shape=ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;";
    internal const string FuncStyle = "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;";
    internal const string FuncExtStyle = "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f5f5f5;strokeColor=#666666;";
    internal static readonly string ContStyle =
        "swimlane;startSize=" + Text.Num(Header) + ";collapsible=0;recursiveResize=0;fillColor=#dae8fc;strokeColor=#6c8ebf;html=1;";
    internal const string EdgeStyle = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;jumpStyle=arc;jumpSize=6;";

    // 方向五边形：形状本身就表达数据流向，不再往节点上贴额外的记号。
    //
    //   输入 = 左边平、右边尖   —— 数据从右侧尖角流进来
    //   输出 = 右边平、左边尖   —— 数据从左侧尖角流出去
    //
    // 路径坐标按 160x60 的**设计尺寸**书写（正是 NodeW x NodeH），尖角精确落在
    // 左右边缘中点上 —— 与 AnchorSets 第一条的 (1.0,0.5)/(0.0,0.5) 重合，所以
    // 连线的起止点天然咬在尖角上，不需要额外补偿。
    //
    // 为什么用 `shape=path` 而不是现成的五边形：mxGraph 核心只注册了
    // box/customShape/sample 三个形状，`mxgraph.basic.pentagon` 之类是 draw.io 的
    // 扩展形状，离线渲染器画不出来（会退化成矩形），也就无法验证。`shape=path`
    // 是 draw.io 的标准功能，渲染器侧由 tools/render/render_drawio.js 注册实现，
    // 两边都能得到同一个五边形。
    //
    // 无方向的信号仍旧用椭圆（没有任何流向可表达）。
    internal const string PentaInPath = "0,0 115,0 160,30 115,60 0,60";
    internal const string PentaOutPath = "45,0 160,0 160,60 45,60 0,30";
    internal static readonly string SignalInStyle =
        "shape=path;path=" + PentaInPath + ";whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;";
    internal static readonly string SignalOutStyle =
        "shape=path;path=" + PentaOutPath + ";whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;";

    /// <summary>先试对向锚点，再试同侧锚点（同侧配侧向绕行用）。顺序即优先级，不要重排。</summary>
    internal static readonly (double, double, double, double)[] AnchorSets =
    [
        (1.0, 0.5, 0.0, 0.5),
        (0.0, 0.5, 1.0, 0.5),
        (0.5, 1.0, 0.5, 0.0),
        (0.5, 0.0, 0.5, 1.0),
        (1.0, 0.5, 1.0, 0.5),
        (0.0, 0.5, 0.0, 0.5),
        (0.5, 0.0, 0.5, 0.0),
        (0.5, 1.0, 0.5, 1.0),
    ];

    internal static string Attrs(IEnumerable<(string Key, string? Val)> pairs)
    {
        var parts = new List<string>();
        foreach (var (k, v) in pairs)
        {
            if (string.IsNullOrEmpty(v))
            {
                continue;
            }

            parts.Add(k + "=\"" + Text.HtmlEscape(v) + "\"");
        }

        return string.Join(" ", parts);
    }

    internal static (string Kind, INode Node)[] Entities(Model model)
    {
        var output = new List<(string, INode)>();
        foreach (var s in model.Signals.Values)
        {
            output.Add(("signal", s));
        }

        foreach (var f in model.Funcs.Values)
        {
            output.Add(("func", f));
        }

        return [.. output];
    }

    internal static string EdgeKey(Edge e) => e.Src + "->" + e.Dst + ":" + e.Rw;

    internal static (double X, double Y, double W, double H) Rect(Model model, string sid)
    {
        INode? n = model.SignalOrNull(sid) ?? (INode?)model.FuncOrNull(sid);
        if (n is null)
        {
            throw new InvalidOperationException("unknown symbol: " + sid);
        }

        return (n.X, n.Y, n.W, n.H);
    }

    /// <summary>两个容器之间那条空走廊；容器重叠时为空。</summary>
    internal static (string Kind, double Pos)? CrossGap(
        (double X, double Y, double W, double H) sbox,
        (double X, double Y, double W, double H) dbox)
    {
        if (sbox.X + sbox.W <= dbox.X)
        {
            return ("v", (sbox.X + sbox.W + dbox.X) / 2.0);
        }

        if (dbox.X + dbox.W <= sbox.X)
        {
            return ("v", (dbox.X + dbox.W + sbox.X) / 2.0);
        }

        if (sbox.Y + sbox.H <= dbox.Y)
        {
            return ("h", (sbox.Y + sbox.H + dbox.Y) / 2.0);
        }

        if (dbox.Y + dbox.H <= sbox.Y)
        {
            return ("h", (dbox.Y + dbox.H + sbox.Y) / 2.0);
        }

        return null;
    }

    internal static ((double X, double Y) Src, (double X, double Y) Dst) Endpoints(
        (double X, double Y, double W, double H) srect,
        (double X, double Y, double W, double H) drect,
        (double A, double B, double C, double D) a) =>
        ((srect.X + (srect.W * a.A), srect.Y + (srect.H * a.B)),
         (drect.X + (drect.W * a.C), drect.Y + (drect.H * a.D)));

    /// <summary>把一个点沿它锚点所在边的法线方向外移。</summary>
    internal static (double X, double Y) LanePt((double X, double Y) pt, double ax, double ay)
    {
        if (ax == 0.0)
        {
            return (pt.X - Detour, pt.Y);
        }

        if (ax == 1.0)
        {
            return (pt.X + Detour, pt.Y);
        }

        if (ay == 0.0)
        {
            return (pt.X, pt.Y - Detour);
        }

        if (ay == 1.0)
        {
            return (pt.X, pt.Y + Detour);
        }

        return pt;
    }

    internal static List<List<(double X, double Y)>> Candidates(
        (double X, double Y) sp,
        (double X, double Y) dp,
        (double A, double B, double C, double D) a,
        (double X, double Y, double W, double H) srect,
        (double X, double Y, double W, double H) drect,
        (string Kind, double Pos)? gap)
    {
        var output = new List<List<(double X, double Y)>>();
        if (gap is not null)
        {
            var (kind, pos) = gap.Value;
            output.Add(kind == "v"
                ? [sp, (pos, sp.Y), (pos, dp.Y), dp]
                : [sp, (sp.X, pos), (dp.X, pos), dp]);
        }

        output.Add([sp, (dp.X, sp.Y), dp]);
        output.Add([sp, (sp.X, dp.Y), dp]);
        if (a.A == a.C && (a.A == 0.0 || a.A == 1.0))
        {
            var lane = a.A == 0.0
                ? Math.Min(srect.X, drect.X) - Detour
                : Math.Max(srect.X + srect.W, drect.X + drect.W) + Detour;
            output.Add([sp, (lane, sp.Y), (lane, dp.Y), dp]);
        }

        if (a.B == a.D && (a.B == 0.0 || a.B == 1.0))
        {
            var lane = a.B == 0.0
                ? Math.Min(srect.Y, drect.Y) - Detour
                : Math.Max(srect.Y + srect.H, drect.Y + drect.H) + Detour;
            output.Add([sp, (sp.X, lane), (dp.X, lane), dp]);
        }

        var sp2 = LanePt(sp, a.A, a.B);
        var dp2 = LanePt(dp, a.C, a.D);
        if (sp2 != sp || dp2 != dp)
        {
            output.Add([sp, sp2, (dp2.X, sp2.Y), dp2, dp]);
            output.Add([sp, sp2, (sp2.X, dp2.Y), dp2, dp]);
        }

        return output;
    }

    /// <summary>线段是否穿过了节点框？两端都做了收缩，所以贴着边走不算命中。</summary>
    internal static bool Crosses((double X, double Y, double W, double H) box, (double X, double Y) p, (double X, double Y) q)
    {
        if (Math.Abs(p.Y - q.Y) < 0.5)
        {
            var lo = Math.Min(p.X, q.X) + Shrink;
            var hi = Math.Max(p.X, q.X) - Shrink;
            return hi > lo
                && (box.Y - Slack) < p.Y && p.Y < (box.Y + box.H + Slack)
                && hi > box.X && lo < box.X + box.W;
        }

        if (Math.Abs(p.X - q.X) < 0.5)
        {
            var lo = Math.Min(p.Y, q.Y) + Shrink;
            var hi = Math.Max(p.Y, q.Y) - Shrink;
            return hi > lo
                && (box.X - Slack) < p.X && p.X < (box.X + box.W + Slack)
                && hi > box.Y && lo < box.Y + box.H;
        }

        return false;
    }

    internal static double Length(List<(double X, double Y)> pts)
    {
        var total = 0.0;
        for (var i = 0; i < pts.Count - 1; i++)
        {
            total += Math.Abs(pts[i + 1].X - pts[i].X) + Math.Abs(pts[i + 1].Y - pts[i].Y);
        }

        return total;
    }

    /// <summary>五边形尖角所在的一侧；只有 in/out 有尖角，其余为 null（不约束）。</summary>
    internal static string? ConnSide(Model model, string eid)
        => model.Signals.TryGetValue(eid, out var sig)
            ? sig.Dir switch { "in" => "right", "out" => "left", _ => null }
            : null;

    /// <summary>锚点是否满足两端的方向约束（中点锚点才算数，0.5 是对应的 y）。</summary>
    private static bool SideOk((double A, double B, double C, double D) a, string? srcSide, string? dstSide)
    {
        if (srcSide is not null)
        {
            var want = srcSide == "right" ? 1.0 : 0.0;
            if (a.A != want || a.B != 0.5)
            {
                return false;
            }
        }

        if (dstSide is not null)
        {
            var want = dstSide == "right" ? 1.0 : 0.0;
            if (a.C != want || a.D != 0.5)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// 在所有「锚点 × 候选走法」里挑最短且不撞节点的一组。一组都挑不出来时返回空锚点，
    /// 表示把路由交还给 draw.io 自己处理。
    ///
    /// <paramref name="srcSide"/>/<paramref name="dstSide"/> 是方向约束。**约束无解时
    /// 会放宽重试一次** —— 宁可偶尔让线不咬尖角，也不能让边凭空消失。
    /// </summary>
    internal static ((double A, double B, double C, double D)? Anchors, List<(double X, double Y)> Waypoints) Route(
        (double X, double Y, double W, double H) srect,
        (double X, double Y, double W, double H) drect,
        IReadOnlyList<(double X, double Y, double W, double H)> obstacles,
        (string Kind, double Pos)? gap,
        string? srcSide = null,
        string? dstSide = null)
    {
        ((double A, double B, double C, double D) Anchor, List<(double X, double Y)> Pts)? Search(bool withConstraints)
        {
            double? bestLen = null;
            (double A, double B, double C, double D) bestAnchor = default;
            List<(double X, double Y)> bestPts = [];

            foreach (var a in AnchorSets)
            {
                if (withConstraints && !SideOk(a, srcSide, dstSide))
                {
                    continue;
                }

                var (sp, dp) = Endpoints(srect, drect, a);
                foreach (var pts in Candidates(sp, dp, a, srect, drect, gap))
                {
                    var hit = false;
                    for (var i = 0; i < pts.Count - 1 && !hit; i++)
                    {
                        foreach (var box in obstacles)
                        {
                            if (Crosses(box, pts[i], pts[i + 1]))
                            {
                                hit = true;
                                break;
                            }
                        }
                    }

                    if (hit)
                    {
                        continue;
                    }

                    var n = Length(pts);
                    if (bestLen is null || n < bestLen)
                    {
                        bestLen = n;
                        bestAnchor = a;
                        bestPts = pts;
                    }
                }
            }

            return bestLen is null ? null : (bestAnchor, bestPts);
        }

        var best = Search(true);
        if (best is null && (srcSide is not null || dstSide is not null))
        {
            best = Search(false);
        }

        if (best is null)
        {
            return (null, []);
        }

        var chosen = best.Value;
        return (chosen.Anchor, chosen.Pts[1..^1]);
    }

    /// <summary>
    /// 按边的两端算出锚点与拐点。
    ///
    /// **两个调用点（<see cref="AutoWaypoints"/> 与 <see cref="ToDrawio"/>）必须走
    /// 这一个入口**：它们算出的拐点必须逐字相同，否则 ApplyLayout 会把自动产生的
    /// 拐点误认成人工拖动、锁死不再重算。
    /// </summary>
    internal static ((double A, double B, double C, double D)? Anchors, List<(double X, double Y)> Waypoints) RouteEdge(
        Model model,
        Edge e,
        IReadOnlyList<(double X, double Y, double W, double H)> obstacles,
        (string Kind, double Pos)? gap)
        => Route(
            Rect(model, e.Src),
            Rect(model, e.Dst),
            obstacles,
            gap,
            ConnSide(model, e.Src),
            ConnSide(model, e.Dst));

    /// <summary>按当前坐标算出的拐点；用来区分"生成器写的"和"人工拖过的"。</summary>
    internal static Dictionary<string, List<(double X, double Y)>> AutoWaypoints(Model model)
    {
        var groups = GroupEntities(model);
        var boxes = groups.ToDictionary(g => g.Key, g => ContainerBox(g.Value), StringComparer.Ordinal);

        var auto = new Dictionary<string, List<(double X, double Y)>>(StringComparer.Ordinal);
        foreach (var e in model.Edges)
        {
            var sg = Node(model, e.Src).Group is { Length: > 0 } g1 ? g1 : "misc";
            var dg = Node(model, e.Dst).Group is { Length: > 0 } g2 ? g2 : "misc";
            var avoid = Entities(model).Select(t => (t.Node.X, t.Node.Y, t.Node.W, t.Node.H)).ToList();
            var gap = sg != dg ? CrossGap(boxes[sg], boxes[dg]) : null;
            auto[EdgeKey(e)] = RouteEdge(model, e, avoid, gap).Waypoints;
        }

        return auto;
    }

    /// <summary>
    /// 输入信号排到容器顶部、输出信号排到底部，其余夹在中间 —— 整张图因此读起来是
    /// 「左上 -> 右下」，与方向五边形的尖角朝向一致。函数没有方向，落在中间。
    /// </summary>
    internal static int DirRank(INode e)
    {
        var d = e is Signal s ? s.Dir : "";
        if (d == "in")
        {
            return 0;
        }

        if (d == "out")
        {
            return 2;
        }

        return 1;
    }

    /// <summary>初始排布：容器内纵向堆叠，容器之间做水平避让，保证互不压住。</summary>
    internal static void AssignDefaultPositions(Model model)
    {
        var groups = GroupEntities(model);

        double? rightEdge = null;
        foreach (var gname in groups.Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            var members = groups[gname]
                .OrderBy(DirRank)
                .ThenBy(e => e.Id, StringComparer.Ordinal)
                .ToList();
            var y = Pad + Header + Pad;
            foreach (var e in members)
            {
                if (e.X == 0 && e.Y == 0)
                {
                    e.X = Pad;
                    e.Y = y;
                }

                y += e.H + GapY;
            }

            var box = ContainerBox(members);
            if (rightEdge is not null && box.X < rightEdge.Value)
            {
                var dx = rightEdge.Value - box.X;
                foreach (var e in members)
                {
                    e.X += dx;
                }

                box = ContainerBox(members);
            }

            rightEdge = box.X + box.W + (4 * Pad);
        }
    }

    internal static Dictionary<string, List<INode>> GroupEntities(Model model)
    {
        var groups = new Dictionary<string, List<INode>>(StringComparer.Ordinal);
        foreach (var (_, e) in Entities(model))
        {
            var key = e.Group.Length > 0 ? e.Group : "misc";
            if (!groups.TryGetValue(key, out var list))
            {
                list = [];
                groups[key] = list;
            }

            list.Add(e);
        }

        return groups;
    }

    internal static (double X, double Y, double W, double H) ContainerBox(IReadOnlyList<INode> members)
    {
        var minX = double.MaxValue;
        var minY = double.MaxValue;
        var maxX = double.MinValue;
        var maxY = double.MinValue;
        foreach (var e in members)
        {
            minX = Math.Min(minX, e.X);
            minY = Math.Min(minY, e.Y);
            maxX = Math.Max(maxX, e.X + e.W);
            maxY = Math.Max(maxY, e.Y + e.H);
        }

        return (minX - Pad, minY - Pad - Header, maxX - minX + (2 * Pad), maxY - minY + (2 * Pad) + Header);
    }

    internal static string NodeLabel(string kind, INode e)
    {
        if (kind == "signal")
        {
            var s = (Signal)e;
            var bits = new[] { s.CType, s.Dir, s.Unit }.Where(b => b.Length > 0);
            return Text.HtmlEscape(s.Name) + "<br>" + Text.HtmlEscape(string.Join(" / ", bits));
        }

        var f = (Func)e;
        var title = Text.HtmlEscape(f.Alias.Length > 0 ? f.Alias : f.Name) + "()";
        return title + "<br>" + Text.HtmlEscape(f.Ret + " " + f.Name + "()");
    }

    internal static INode Node(Model model, string id)
    {
        INode? n = model.SignalOrNull(id) ?? (INode?)model.FuncOrNull(id);
        if (n is null)
        {
            throw new InvalidOperationException("unknown symbol: " + id);
        }

        return n;
    }

    public static string ToDrawio(Model model)
    {
        AssignDefaultPositions(model);
        var groups = GroupEntities(model);

        var gid = new Dictionary<string, string>(StringComparer.Ordinal);
        var i = 0;
        foreach (var g in groups.Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            gid[g] = "grp" + (++i).ToString(CultureInfo.InvariantCulture);
        }

        var origin = new Dictionary<string, (double X, double Y)>(StringComparer.Ordinal);
        var boxes = new Dictionary<string, (double X, double Y, double W, double H)>(StringComparer.Ordinal);
        foreach (var g in groups.Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            var box = ContainerBox(groups[g]);
            boxes[g] = box;
            origin[g] = (box.X, box.Y);
        }

        var ordered = Entities(model).OrderBy(t => t.Node.Id, StringComparer.Ordinal).ToList();
        var cellId = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var n = 0; n < ordered.Count; n++)
        {
            cellId[ordered[n].Node.Id] = "n" + (n + 1).ToString(CultureInfo.InvariantCulture);
        }

        var sb = new StringBuilder();

        foreach (var g in groups.Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            var (ox, oy, ow, oh) = boxes[g];
            sb.Append("        <mxCell id=\"").Append(gid[g])
              .Append("\" value=\"").Append(Text.HtmlEscape(g))
              .Append("\" style=\"").Append(ContStyle)
              .Append("\" vertex=\"1\" parent=\"1\">\n")
              .Append("          <mxGeometry x=\"").Append(Text.Num(ox))
              .Append("\" y=\"").Append(Text.Num(oy))
              .Append("\" width=\"").Append(Text.Num(ow))
              .Append("\" height=\"").Append(Text.Num(oh))
              .Append("\" as=\"geometry\" />\n")
              .Append("        </mxCell>\n");
        }

        foreach (var (kind, e) in ordered)
        {
            var (ox, oy) = origin[e.Group.Length > 0 ? e.Group : "misc"];
            var style = kind == "signal"
                ? ((Signal)e).Dir switch
                {
                    "in" => SignalInStyle,
                    "out" => SignalOutStyle,
                    _ => SignalStyle,
                }
                : (e.External ? FuncExtStyle : FuncStyle);
            var pairs = new List<(string, string?)>
            {
                ("id", cellId[e.Id]),
                ("label", NodeLabel(kind, e)),
                ("symbolId", e.Id),
                ("kind", kind),
            };
            if (kind == "signal")
            {
                var s = (Signal)e;
                pairs.AddRange([("ctype", s.CType), ("dir", s.Dir), ("unit", s.Unit), ("alias", s.Alias), ("note", s.Note)]);
            }
            else
            {
                var f = (Func)e;
                pairs.AddRange([("ret", f.Ret), ("alias", f.Alias), ("note", f.Note), ("tooltip", f.Tooltip), ("asset", f.Asset)]);
                if (model.Devices.TryGetValue(e.Id, out var dev))
                {
                    pairs.AddRange([("vendor", dev.Vendor), ("model", dev.Model), ("spec", dev.Spec), ("size", dev.Size)]);
                }
            }

            sb.Append("        <object ").Append(Attrs(pairs)).Append(">\n")
              .Append("          <mxCell style=\"").Append(style)
              .Append("\" vertex=\"1\" parent=\"").Append(gid[e.Group.Length > 0 ? e.Group : "misc"]).Append("\">\n")
              .Append("            <mxGeometry x=\"").Append(Text.Num(e.X - ox))
              .Append("\" y=\"").Append(Text.Num(e.Y - oy))
              .Append("\" width=\"").Append(Text.Num(e.W))
              .Append("\" height=\"").Append(Text.Num(e.H))
              .Append("\" as=\"geometry\" />\n")
              .Append("          </mxCell>\n")
              .Append("        </object>\n");
        }

        var edges = model.Edges.OrderBy(EdgeKey, StringComparer.Ordinal).ToList();
        for (var n = 0; n < edges.Count; n++)
        {
            var e = edges[n];
            var srcGroup = Node(model, e.Src).Group;
            var dstGroup = Node(model, e.Dst).Group;
            var parent = srcGroup == dstGroup ? gid[srcGroup.Length > 0 ? srcGroup : "misc"] : "1";
            var (ox, oy) = parent != "1" ? origin[srcGroup.Length > 0 ? srcGroup : "misc"] : (0.0, 0.0);
            var style = EdgeStyle;
            var waypoints = new List<(double X, double Y)>(e.Waypoints);
            if (waypoints.Count == 0)
            {
                var avoid = Entities(model).Select(t => (t.Node.X, t.Node.Y, t.Node.W, t.Node.H)).ToList();
                var gap = parent == "1"
                    ? CrossGap(boxes[srcGroup.Length > 0 ? srcGroup : "misc"], boxes[dstGroup.Length > 0 ? dstGroup : "misc"])
                    : null;
                var (anchors, pts) = RouteEdge(model, e, avoid, gap);
                waypoints = pts;
                if (anchors is not null)
                {
                    var a = anchors.Value;
                    style += string.Format(
                        CultureInfo.InvariantCulture,
                        "exitX={0};exitY={1};exitDx=0;exitDy=0;entryX={2};entryY={3};entryDx=0;entryDy=0;",
                        Text.Num(a.A),
                        Text.Num(a.B),
                        Text.Num(a.C),
                        Text.Num(a.D));
                }
            }

            var edgePairs = new List<(string, string?)>
            {
                ("id", "e" + (n + 1).ToString(CultureInfo.InvariantCulture)),
                ("label", e.Rw),
                ("rel", "def-use"),
                ("src", e.Src),
                ("dst", e.Dst),
                ("rw", e.Rw),
            };

            string geom;
            if (waypoints.Count > 0)
            {
                var pts = new StringBuilder();
                foreach (var (px, py) in waypoints)
                {
                    pts.Append("\n              <mxPoint x=\"").Append(Text.Num(px - ox))
                       .Append("\" y=\"").Append(Text.Num(py - oy)).Append("\" />");
                }

                geom = "<mxGeometry relative=\"1\" as=\"geometry\">\n            "
                     + "<Array as=\"points\">" + pts + "\n            </Array>\n          </mxGeometry>";
            }
            else
            {
                geom = "<mxGeometry relative=\"1\" as=\"geometry\" />";
            }

            sb.Append("        <object ").Append(Attrs(edgePairs)).Append(">\n")
              .Append("          <mxCell style=\"").Append(style)
              .Append("\" edge=\"1\" parent=\"").Append(parent)
              .Append("\" source=\"").Append(cellId[e.Src])
              .Append("\" target=\"").Append(cellId[e.Dst]).Append("\">\n")
              .Append("            ").Append(geom).Append("\n")
              .Append("          </mxCell>\n")
              .Append("        </object>\n");
        }

        return "<mxfile host=\"app.diagrams.net\" agent=\"drawcode\" type=\"device\">\n"
             + "  <diagram id=\"drawcode\" name=\"dataflow\">\n"
             + "    <mxGraphModel adaptiveColors=\"auto\" dx=\"1200\" dy=\"800\" grid=\"1\" gridSize=\"10\" "
             + "guides=\"1\" tooltips=\"1\" connect=\"1\" arrows=\"1\" fold=\"1\" page=\"1\" pageScale=\"1\" "
             + "pageWidth=\"1169\" pageHeight=\"826\" math=\"0\" shadow=\"0\">\n"
             + "      <root>\n"
             + "        <mxCell id=\"0\" />\n"
             + "        <mxCell id=\"1\" parent=\"0\" />\n"
             + sb
             + "      </root>\n"
             + "    </mxGraphModel>\n"
             + "  </diagram>\n"
             + "</mxfile>\n";
    }

    /// <summary>
    /// 展开 draw.io 的压缩 &lt;diagram&gt; 载荷：base64(raw-deflate(百分号编码的 XML))。
    /// 注意是 **raw deflate** —— 用 <see cref="DeflateStream"/>，绝不能用 <c>ZLibStream</c>
    /// （后者会多写一个 zlib 头）。解码顺序也不能颠倒。
    /// </summary>
    internal static string Decompress(string data)
    {
        var bytes = Convert.FromBase64String(data);
        using var input = new MemoryStream(bytes);
        using var deflate = new DeflateStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        deflate.CopyTo(output);
        return PercentDecode(Encoding.UTF8.GetString(output.ToArray()));
    }

    /// <summary>对等 Python 的 <c>urllib.parse.unquote</c>：转义序列还原成字节，孤立的 '%' 原样保留。</summary>
    internal static string PercentDecode(string s)
    {
        var bytes = new List<byte>(s.Length);
        var i = 0;
        while (i < s.Length)
        {
            if (s[i] == '%' && i + 2 < s.Length && IsHex(s[i + 1]) && IsHex(s[i + 2]))
            {
                bytes.Add((byte)((HexVal(s[i + 1]) * 16) + HexVal(s[i + 2])));
                i += 3;
                continue;
            }

            bytes.AddRange(Encoding.UTF8.GetBytes(s[i].ToString()));
            i++;
        }

        return Encoding.UTF8.GetString([.. bytes]);
    }

    private static bool IsHex(char c) =>
        (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

    private static int HexVal(char c) => c switch
    {
        >= '0' and <= '9' => c - '0',
        >= 'a' and <= 'f' => c - 'a' + 10,
        _ => c - 'A' + 10,
    };

    /// <summary>
    /// 把未压缩与压缩两种 &lt;diagram&gt; 形态归一化，好让 <see cref="ReadLayout"/> 不必关心拿到的是哪种。
    /// 载荷读不懂时**抛异常**而不是返回空布局：静默返回空会让人工排版被无声丢弃，不留任何痕迹。
    /// </summary>
    internal static XElement Unpack(string xml)
    {
        var doc = XDocument.Parse(xml, LoadOptions.PreserveWhitespace);
        var root = doc.Root ?? throw new InvalidOperationException("empty XML document");

        foreach (var diagram in root.DescendantsAndSelf().Where(el => el.Name.LocalName == "diagram").ToList())
        {
            if (diagram.Elements().Any(el => el.Name.LocalName == "mxGraphModel"))
            {
                continue;
            }

            var text = diagram.Nodes().OfType<XText>().Select(t => t.Value).FirstOrDefault()?.Trim() ?? "";
            if (text.Length == 0)
            {
                continue;
            }

            XElement model;
            try
            {
                model = XDocument.Parse(Decompress(text), LoadOptions.PreserveWhitespace).Root
                    ?? throw new InvalidOperationException("decompressed payload has no root element");
            }
            catch (Exception exc)
            {
                throw new InvalidOperationException(
                    "<diagram> 既不是 <mxGraphModel> 子元素，也不是可识别的 draw.io 压缩串: " + exc.Message, exc);
            }

            diagram.ReplaceNodes(model);
        }

        return root;
    }

    private sealed class Cell
    {
        public XElement Element { get; init; } = null!;
        public XElement CellElement { get; init; } = null!;
        public string? Parent { get; init; }
        public string? SymbolId { get; init; }
        public string? SrcCell { get; init; }
        public string? DstCell { get; init; }
        public string? Rw { get; init; }
        public bool IsEdge { get; init; }
    }

    private static Dictionary<string, Cell> LoadCells(string xml)
    {
        var root = Unpack(xml);
        var cells = new Dictionary<string, Cell>(StringComparer.Ordinal);
        foreach (var el in root.DescendantsAndSelf())
        {
            var name = el.Name.LocalName;
            if (name == "object")
            {
                var inner = el.Elements().FirstOrDefault(c => c.Name.LocalName == "mxCell");
                var id = el.Attribute("id")?.Value;
                if (inner is null || id is null)
                {
                    continue;
                }

                cells[id] = new Cell
                {
                    Element = el,
                    CellElement = inner,
                    Parent = inner.Attribute("parent")?.Value,
                    SymbolId = el.Attribute("symbolId")?.Value,
                    SrcCell = inner.Attribute("source")?.Value,
                    DstCell = inner.Attribute("target")?.Value,
                    Rw = el.Attribute("rw")?.Value,
                    IsEdge = inner.Attribute("edge")?.Value == "1",
                };
            }
            else if (name == "mxCell")
            {
                var id = el.Attribute("id")?.Value;
                if (id is null || id is "0" or "1")
                {
                    continue;
                }

                cells[id] = new Cell
                {
                    Element = el,
                    CellElement = el,
                    Parent = el.Attribute("parent")?.Value,
                    SymbolId = null,
                    SrcCell = el.Attribute("source")?.Value,
                    DstCell = el.Attribute("target")?.Value,
                    Rw = null,
                    IsEdge = el.Attribute("edge")?.Value == "1",
                };
            }
        }

        return cells;
    }

    private static (double X, double Y) Origin(Dictionary<string, Cell> cells, string? cid)
    {
        var x = 0.0;
        var y = 0.0;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        while (!string.IsNullOrEmpty(cid) && cid is not ("0" or "1") && cells.ContainsKey(cid) && !seen.Contains(cid))
        {
            seen.Add(cid);
            var geom = cells[cid].CellElement.Elements().FirstOrDefault(g => g.Name.LocalName == "mxGeometry");
            if (geom is not null)
            {
                x += AttrNum(geom, "x");
                y += AttrNum(geom, "y");
            }

            cid = cells[cid].Parent;
        }

        return (x, y);
    }

    private static double AttrNum(XElement el, string name)
    {
        var raw = el.Attribute(name)?.Value;
        return string.IsNullOrEmpty(raw)
            ? 0.0
            : double.Parse(raw, NumberStyles.Float, CultureInfo.InvariantCulture);
    }

    public sealed class Layout
    {
        public Dictionary<string, (double X, double Y, double W, double H)> Nodes { get; } = new(StringComparer.Ordinal);

        public Dictionary<string, List<(double X, double Y)>> Edges { get; } = new(StringComparer.Ordinal);

        public Dictionary<string, Dictionary<string, string>> Attrs { get; } = new(StringComparer.Ordinal);
    }

    public static Layout ReadLayout(string xml)
    {
        var cells = LoadCells(xml);
        var layout = new Layout();

        foreach (var (_, info) in cells)
        {
            if (info.IsEdge || info.SymbolId is null)
            {
                continue;
            }

            var props = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var attr in info.Element.Attributes())
            {
                if (attr.Name.LocalName is "id" or "label" or "symbolId")
                {
                    continue;
                }

                props[attr.Name.LocalName] = attr.Value;
            }

            layout.Attrs[info.SymbolId] = props;
        }

        foreach (var (_, info) in cells)
        {
            if (info.IsEdge || info.SymbolId is null)
            {
                continue;
            }

            var geom = info.CellElement.Elements().FirstOrDefault(g => g.Name.LocalName == "mxGeometry");
            var (ox, oy) = Origin(cells, info.Parent);
            if (geom is not null)
            {
                layout.Nodes[info.SymbolId] = (
                    AttrNum(geom, "x") + ox,
                    AttrNum(geom, "y") + oy,
                    AttrNum(geom, "width"),
                    AttrNum(geom, "height"));
            }
        }

        foreach (var (_, info) in cells)
        {
            if (!info.IsEdge || info.SrcCell is null)
            {
                continue;
            }

            var src = cells.TryGetValue(info.SrcCell, out var sc) ? sc.SymbolId : null;
            var dst = info.DstCell is not null && cells.TryGetValue(info.DstCell, out var dc) ? dc.SymbolId : null;
            if (string.IsNullOrEmpty(src) || string.IsNullOrEmpty(dst))
            {
                continue;
            }

            var (ox, oy) = Origin(cells, info.Parent);
            var pts = new List<(double X, double Y)>();
            var geom = info.CellElement.Elements().FirstOrDefault(g => g.Name.LocalName == "mxGeometry");
            var arr = geom?.Elements().FirstOrDefault(g => g.Name.LocalName == "Array");
            if (arr is not null)
            {
                foreach (var p in arr.Elements().Where(p => p.Name.LocalName == "mxPoint"))
                {
                    pts.Add((AttrNum(p, "x") + ox, AttrNum(p, "y") + oy));
                }
            }

            layout.Edges[src + "->" + dst + ":" + (info.Rw ?? "read")] = pts;
        }

        return layout;
    }

    public static Model ApplyLayout(Model model, Layout layout)
    {
        foreach (var (sid, (x, y, w, h)) in layout.Nodes)
        {
            INode? ent = model.SignalOrNull(sid) ?? (INode?)model.FuncOrNull(sid);
            if (ent is null)
            {
                continue;
            }

            ent.X = x;
            ent.Y = y;
            ent.W = w;
            ent.H = h;
        }

        foreach (var (sid, props) in layout.Attrs)
        {
            INode? ent = model.SignalOrNull(sid) ?? (INode?)model.FuncOrNull(sid);
            if (ent is null)
            {
                continue;
            }

            if (ent is Signal sig)
            {
                if (props.TryGetValue("alias", out var a))
                {
                    sig.Alias = a;
                }

                if (props.TryGetValue("unit", out var u))
                {
                    sig.Unit = u;
                }

                if (props.TryGetValue("note", out var n))
                {
                    sig.Note = n;
                }

                if (props.TryGetValue("dir", out var d) && d is "in" or "out" or "inout")
                {
                    sig.Dir = d;
                }
            }
            else if (ent is Func fn)
            {
                if (props.TryGetValue("alias", out var a))
                {
                    fn.Alias = a;
                }

                if (props.TryGetValue("note", out var n))
                {
                    fn.Note = n;
                }

                if (props.TryGetValue("tooltip", out var t))
                {
                    fn.Tooltip = t;
                }
            }
        }

        var auto = AutoWaypoints(model);
        foreach (var e in model.Edges)
        {
            var key = EdgeKey(e);
            if (!layout.Edges.TryGetValue(key, out var pts))
            {
                continue;
            }

            e.Waypoints = [.. pts];
            if (auto.TryGetValue(key, out var autoPts) && e.Waypoints.SequenceEqual(autoPts))
            {
                e.Waypoints = [];
            }
        }

        return model;
    }
}
