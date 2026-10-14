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

    /// <summary>
    /// 实体的容器路径。
    ///
    /// <c>Path</c> 是完整层级（<c>adc/采样</c>），<c>Group</c> 是它的第一段。老实体只填了
    /// group，所以这里退回 group；两者都空才落到 <c>misc</c>。解析器保证 path 非空，
    /// 这个兜底是给手工构造的 model 用的。
    /// </summary>
    internal static string EntityPath(INode e) =>
        e.Path.Length > 0 ? e.Path : (e.Group.Length > 0 ? e.Group : "misc");

    internal sealed class TreeNode
    {
        public List<INode> Members { get; } = [];
        public List<string> Children { get; } = [];
    }

    /// <summary>
    /// 从所有实体的 path 推出容器树。
    ///
    /// 中间层级即使没有直属成员也会被建出来 —— <c>path="adc/采样"</c> 里那个 <c>adc</c>
    /// 必须存在，否则子容器会没有父框可挂。
    /// </summary>
    internal static Dictionary<string, TreeNode> ContainerTree(Model model)
    {
        var nodes = new Dictionary<string, TreeNode>(StringComparer.Ordinal);
        foreach (var (_, e) in Entities(model))
        {
            var parts = EntityPath(e).Split('/');
            for (var i = 1; i <= parts.Length; i++)
            {
                var key = string.Join("/", parts.Take(i));
                if (!nodes.ContainsKey(key))
                {
                    nodes[key] = new TreeNode();
                }
            }

            nodes[string.Join("/", parts)].Members.Add(e);
        }

        foreach (var p in nodes.Keys.ToList())
        {
            var slash = p.LastIndexOf('/');
            if (slash < 0)
            {
                continue;
            }

            var parent = p[..slash];
            var kids = nodes[parent].Children;
            if (!kids.Contains(p, StringComparer.Ordinal))
            {
                kids.Add(p);
            }
        }

        return nodes;
    }

    /// <summary>一个容器及其所有子孙的成员，展开成一维列表。</summary>
    internal static List<INode> AllMembers(Dictionary<string, TreeNode> nodes, string path)
    {
        var output = new List<INode>(nodes[path].Members);
        foreach (var child in nodes[path].Children)
        {
            output.AddRange(AllMembers(nodes, child));
        }

        return output;
    }

    /// <summary>按当前坐标算出的拐点；用来区分"生成器写的"和"人工拖过的"。</summary>
    internal static Dictionary<string, List<(double X, double Y)>> AutoWaypoints(Model model)
    {
        var nodes = ContainerTree(model);
        var boxes = nodes.Keys.ToDictionary(
            p => p,
            p => ContainerBox(AllMembers(nodes, p)),
            StringComparer.Ordinal);

        var auto = new Dictionary<string, List<(double X, double Y)>>(StringComparer.Ordinal);
        foreach (var e in model.Edges)
        {
            var sg = EntityPath(Node(model, e.Src));
            var dg = EntityPath(Node(model, e.Dst));
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

    private static int ByRankThenId(INode a, INode b)
    {
        var r = DirRank(a).CompareTo(DirRank(b));
        return r != 0 ? r : string.CompareOrdinal(a.Id, b.Id);
    }

    /// <summary>
    /// 把一组实体在给定左上角垂直堆叠，返回它们的包围盒。
    ///
    /// <c>e.X == 0 &amp;&amp; e.Y == 0</c> 是「这个节点还没有坐标」的约定 —— 带着人工坐标
    /// （<c>@drawcode xy="…"</c>）的节点不受影响。
    ///
    /// 只对<b>直属成员</b>调用（<c>LayoutTree</c> 里 <c>members == own</c> 那一支）——
    /// 它们从没被递归设过坐标，所以守卫对块里每个成员都成立。
    /// </summary>
    private static (double X, double Y, double W, double H) Stack(List<INode> members, double xLeft, double yTop)
    {
        var y = yTop;
        foreach (var e in members)
        {
            if (e.X == 0 && e.Y == 0)
            {
                e.X = xLeft;
                e.Y = y;
            }

            y += e.H + GapY;
        }

        return ContainerBox(members);
    }

    /// <summary>
    /// 递归排布一个容器：子容器各成一块，直属成员另成一块，横向依次摆开。
    ///
    /// 单层容器（没有子容器）时，这就退化成「成员垂直堆叠」—— 与老行为完全一致，
    /// 所以没有任何 <c>path=</c> 的源码产物逐字节不变。
    /// </summary>
    private static (double X, double Y, double W, double H)? LayoutTree(
        Dictionary<string, TreeNode> nodes, string path, double xLeft, double yTop)
    {
        var node = nodes[path];
        var own = node.Members.OrderBy(e => e, Comparer<INode>.Create(ByRankThenId)).ToList();

        // 块宽必须按**整棵子树**算。中间容器（`a/b/c` 里的 `b`）自己没有直属成员，
        // 若只看它的 Members，宽度是 0 → 游标不前进 → 几棵子树叠在一起。
        var blocks = new List<List<INode>>();
        foreach (var child in node.Children.OrderBy(c => c, StringComparer.Ordinal))
        {
            LayoutTree(nodes, child, 0, 0);
            var members = AllMembers(nodes, child);
            if (members.Count > 0)
            {
                blocks.Add(members);
            }
        }

        if (own.Count > 0)
        {
            blocks.Add(own);
        }

        if (blocks.Count == 0)
        {
            return null;
        }

        // 游标走的是**块左边界**（和 ContainerBox 同一基准），不是成员坐标 ——
        // 早先把成员坐标 xLeft 和包围盒左边界 box.X 拿来比较，两者差一个 PAD，
        // 于是永远判定"需要平移"，把整块又推了 30。
        var cursor = xLeft;
        foreach (var members in blocks)
        {
            if (ReferenceEquals(members, own))
            {
                Stack(members, cursor, yTop);
            }
            else
            {
                // 子容器已经在局部坐标系里排好了，整体平移到游标即可 ——
                // 它的子容器也在这份 members 里，所以会跟着一起走。
                var sub = ContainerBox(members);
                var dx = cursor - sub.X;
                foreach (var e in members)
                {
                    e.X += dx;
                }
            }

            var box = ContainerBox(members);
            cursor = box.X + box.W + (2 * Pad) + Pad;
        }

        return ContainerBox(blocks.SelectMany(b => b).ToList());
    }

    /// <summary>初始排布：容器内纵向堆叠，顶层容器之间做水平避让，保证互不压住。</summary>
    internal static void AssignDefaultPositions(Model model)
    {
        var nodes = ContainerTree(model);
        var tops = nodes.Keys.Where(p => !p.Contains('/')).OrderBy(k => k, StringComparer.Ordinal).ToList();

        double? rightEdge = null;
        foreach (var gname in tops)
        {
            LayoutTree(nodes, gname, Pad, Pad + Header + Pad);
            var members = AllMembers(nodes, gname);

            // 若这一棵树比已排好的往左，就整棵右移，避免两个顶层容器水平重叠
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

    internal static (double X, double Y, double W, double H) ContainerBox(IReadOnlyList<INode> members)
    {
        if (members.Count == 0)
        {
            // 中间容器（`a/b/c` 里的 `b`）只有子容器、没有直属成员，会走到这里。
            // 少了这一条，minX/maxX 保持 MaxValue/MinValue，会返回天文数字量级的负宽度。
            return (0, 0, 0, 0);
        }

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
        var nodes = ContainerTree(model);
        var paths = nodes.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();

        var gid = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var n = 0; n < paths.Count; n++)
        {
            gid[paths[n]] = "grp" + (n + 1).ToString(CultureInfo.InvariantCulture);
        }

        // 容器 id 与原点：节点坐标在 XML 里是**相对父容器**的，所以处处要减去父的原点。
        // 顶层容器没有父，原点就是根 (0,0) —— 单层源码因此与老版本逐位相同。
        var boxes = new Dictionary<string, (double X, double Y, double W, double H)>(StringComparer.Ordinal);
        foreach (var p in paths)
        {
            boxes[p] = ContainerBox(AllMembers(nodes, p));
        }

        static string? ParentPath(string p)
        {
            var slash = p.LastIndexOf('/');
            return slash < 0 ? null : p[..slash];
        }

        // 容器自己的原点 —— 它的几何是相对**父容器**写的。
        (double X, double Y) OriginOf(string p)
        {
            var pp = ParentPath(p);
            return pp is null ? (0.0, 0.0) : (boxes[pp].X, boxes[pp].Y);
        }

        var ordered = Entities(model).OrderBy(t => t.Node.Id, StringComparer.Ordinal).ToList();
        var cellId = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var n = 0; n < ordered.Count; n++)
        {
            cellId[ordered[n].Node.Id] = "n" + (n + 1).ToString(CultureInfo.InvariantCulture);
        }

        var sb = new StringBuilder();

        foreach (var p in paths)
        {
            var (ox, oy, ow, oh) = boxes[p];
            var (pox, poy) = OriginOf(p);
            var pp = ParentPath(p);
            // 容器显示名用 path 最后一段
            var label = p[(p.LastIndexOf('/') + 1)..];
            sb.Append("        <mxCell id=\"").Append(gid[p])
              .Append("\" value=\"").Append(Text.HtmlEscape(label))
              .Append("\" style=\"").Append(ContStyle)
              .Append("\" vertex=\"1\" parent=\"").Append(pp is null ? "1" : gid[pp]).Append("\">\n")
              .Append("          <mxGeometry x=\"").Append(Text.Num(ox - pox))
              .Append("\" y=\"").Append(Text.Num(oy - poy))
              .Append("\" width=\"").Append(Text.Num(ow))
              .Append("\" height=\"").Append(Text.Num(oh))
              .Append("\" as=\"geometry\" />\n")
              .Append("        </mxCell>\n");
        }

        foreach (var (kind, e) in ordered)
        {
            var epath = EntityPath(e);
            // 节点相对**自己的容器**，不是父容器 —— 这和容器的相对基准不同，别合并
            var (ox, oy) = (boxes[epath].X, boxes[epath].Y);
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
              .Append("\" vertex=\"1\" parent=\"").Append(gid[epath]).Append("\">\n")
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
            var srcPath = EntityPath(Node(model, e.Src));
            var dstPath = EntityPath(Node(model, e.Dst));
            // 同容器内的边挂在该容器下（坐标相对容器），跨容器的边挂在根下（坐标绝对）
            var parent = srcPath == dstPath ? gid[srcPath] : "1";
            var (ox, oy) = parent != "1" ? (boxes[srcPath].X, boxes[srcPath].Y) : (0.0, 0.0);
            var style = EdgeStyle;
            var waypoints = new List<(double X, double Y)>(e.Waypoints);
            if (waypoints.Count == 0)
            {
                var avoid = Entities(model).Select(t => (t.Node.X, t.Node.Y, t.Node.W, t.Node.H)).ToList();
                var gap = parent == "1" ? CrossGap(boxes[srcPath], boxes[dstPath]) : null;
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

    /// <summary>图里「能看见、但不是 drawcode 节点」的顶点，供 <see cref="Adopt"/> 接回 IR。</summary>
    public sealed class ForeignCell
    {
        public string CellId { get; init; } = "";
        public string Label { get; init; } = "";
        public string Style { get; init; } = "";
        public string? Parent { get; init; }
        public string Container { get; init; } = "";
        public double X { get; init; }
        public double Y { get; init; }
        public double W { get; init; }
        public double H { get; init; }
    }

    public sealed class Layout
    {
        public Dictionary<string, (double X, double Y, double W, double H)> Nodes { get; } = new(StringComparer.Ordinal);

        public Dictionary<string, List<(double X, double Y)>> Edges { get; } = new(StringComparer.Ordinal);

        public Dictionary<string, Dictionary<string, string>> Attrs { get; } = new(StringComparer.Ordinal);

        /// <summary>容器 cell id -> 容器名（= group 名 = 源文件名）。仅 <c>includeForeign</c> 时填充。</summary>
        public Dictionary<string, string> Containers { get; } = new(StringComparer.Ordinal);

        /// <summary>图里多出来的顶点。仅 <c>includeForeign</c> 时填充。</summary>
        public List<ForeignCell> Foreign { get; } = new();
    }

    /// <param name="includeForeign">
    /// true 时另外填充 <c>Containers</c> 与 <c>Foreign</c>，供 <see cref="Adopt"/> 把
    /// 「用户在 draw.io 里新加的元素」接回 IR。默认 false，因为绝大多数调用方
    /// （尤其 <c>--layout-from</c>）只关心既有节点。
    /// </param>
    public static Layout ReadLayout(string xml, bool includeForeign = false)
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

        if (includeForeign)
        {
            ContainersOf(cells, layout.Containers);
            ForeignCells(cells, layout.Containers, layout.Foreign);
        }

        return layout;
    }

    /// <summary>
    /// 容器 cell id -> 容器名。容器名就是 group 名，也是它对应的源文件名（不含扩展名）。
    /// 判定用 <c>swimlane</c>：容器是泳道，天生没有 <c>symbolId</c>。
    /// </summary>
    private static void ContainersOf(Dictionary<string, Cell> cells, Dictionary<string, string> into)
    {
        foreach (var (cid, info) in cells)
        {
            if (info.CellElement.Attribute("vertex")?.Value == "1" &&
                (info.CellElement.Attribute("style")?.Value ?? "").Contains("swimlane", StringComparison.Ordinal))
            {
                into[cid] = (info.Element.Attribute("value")?.Value ?? "").Trim();
            }
        }
    }

    /// <summary>
    /// 图里「能看见、但不是 drawcode 节点」的顶点。
    ///
    /// 用户手工加元素有两种常见做法，两种都会落到这里：
    /// <list type="bullet">
    /// <item>直接拖一个形状出来 —— 裸 <c>mxCell</c>，没有 <c>symbolId</c>；</item>
    /// <item>复制一个已有节点 —— 副本带着<b>同一个 <c>symbolId</c></b>，于是被
    /// <see cref="LoadCells"/> 折叠到原节点上，表现为「图里多了一个但读回来没多」。</item>
    /// </list>
    /// 这里按 cell id 收集，所以上面第二种情况仍然能被发现：副本的 cell id 是新的。
    /// </summary>
    private static void ForeignCells(
        Dictionary<string, Cell> cells,
        Dictionary<string, string> containers,
        List<ForeignCell> into)
    {
        foreach (var (cid, info) in cells)
        {
            if (info.IsEdge || info.SymbolId is not null)
            {
                continue;
            }

            if (containers.ContainsKey(cid))
            {
                continue; // 容器本身就是 swimlane，不是用户新加的元素
            }

            var geom = info.CellElement.Elements().FirstOrDefault(g => g.Name.LocalName == "mxGeometry");
            if (geom is null)
            {
                continue;
            }

            var label = info.Element.Attribute("label")?.Value ?? info.Element.Attribute("value")?.Value ?? "";
            into.Add(new ForeignCell
            {
                CellId = cid,
                Label = label.Trim(),
                Style = info.CellElement.Attribute("style")?.Value ?? "",
                Parent = info.Parent,
                Container = info.Parent is not null && containers.TryGetValue(info.Parent, out var cname) ? cname : "",
                X = AttrNum(geom, "x"),
                Y = AttrNum(geom, "y"),
                W = AttrNum(geom, "width"),
                H = AttrNum(geom, "height"),
            });
        }
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
