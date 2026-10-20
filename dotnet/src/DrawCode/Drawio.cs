using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
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

    /// <summary>
    /// <c>--straight-edges</c> 用的边样式：draw.io 的「直线」连接。
    ///
    /// <c>edgeStyle=none</c> 是 draw.io 里 Straight 的写法 —— 不跑布线，直接用直线连
    /// exit 点到 entry 点。三件事必须同时去掉：<c>edgeStyle=orthogonalEdgeStyle</c>
    /// （不清掉它，draw.io 会自己再算一遍正交走线，线照样是弯的）、<c>rounded=1</c>
    /// （没有拐角）、<c>jumpStyle/jumpSize</c>（直线不产生跨线）。exit*/entry* 锚点保留：
    /// 它们决定线从节点的哪条边出发，与怎么走无关。
    /// </summary>
    internal const string StraightEdgeStyle = "edgeStyle=none;html=1;";

    /// <summary>
    /// 被推开的边标签用的**子单元格**样式。<c>points=[]</c> 是 draw.io 拖动标签时连带
    /// 写下的一对空控制点，别删 —— 删了 draw.io 打开时会自己补回来，文件每次打开都变脏。
    /// </summary>
    internal const string EdgeLabelStyle = "edgeLabel;html=1;align=center;verticalAlign=middle;resizable=0;points=[];";

    /// <summary><c>[Callout]</c> 的三种视觉：无边框文字 / 带底色说明框 / 大片分区带。</summary>
    internal static readonly Dictionary<string, string> CalloutFill = new(StringComparer.Ordinal)
    {
        ["text"] = "none",
        ["box"] = "#fff2cc",
        ["band"] = "#f5f5f5",
    };

    internal static readonly Dictionary<string, string> CalloutStroke = new(StringComparer.Ordinal)
    {
        ["text"] = "none",
        ["box"] = "#d6b656",
        ["band"] = "#b3b3b3",
    };

    internal static readonly Dictionary<string, double> CalloutFont = new(StringComparer.Ordinal)
    {
        ["text"] = 12,
        ["box"] = 12,
        ["band"] = 15,
    };

    internal const double LabelLane = 17;
    internal const double LabelFont = 12;

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
            // 被 --inline 折叠成直连边的信号**不出现**：它已经变成那根线上的标签，
            // 再画一个空椭圆就是个既没有入边也没有出边的悬空节点。布局与容器包围盒
            // 都基于本函数，所以跳过之后折叠信号也不再占位置。
            if (model.Inlined.Contains(s.Id))
            {
                continue;
            }

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

    /// <summary>
    /// 节点上显示的两行 HTML：主标题 + 元信息行。
    ///
    /// <paramref name="cards"/> 为 true 时设备卡片只显示一行标题：图片已经占满
    /// 节点框，第二行会压到图上。
    /// </summary>
    internal static string NodeLabel(string kind, INode e, bool cards = false)
    {
        if (kind == "signal")
        {
            var s = (Signal)e;
            var bits = new[] { s.CType, s.Dir, s.Unit }.Where(b => b.Length > 0);
            return Text.HtmlEscape(s.Name) + "<br>" + Text.HtmlEscape(string.Join(" / ", bits));
        }

        var f = (Func)e;
        if (cards && f.Asset.Length > 0)
        {
            return Text.HtmlEscape(f.Alias.Length > 0 ? f.Alias : f.Name);
        }

        var title = Text.HtmlEscape(f.Alias.Length > 0 ? f.Alias : f.Name) + "()";
        return title + "<br>" + Text.HtmlEscape(f.Ret + " " + f.Name + "()");
    }

    /// <summary>
    /// 设备卡片：节点本身就是一张图，名字作为标签贴在图的下方。
    ///
    /// 用 <c>shape=image</c> 而不是「矩形 + image=…」：后者那套键只有 draw.io 自己的
    /// 渲染路径认，核心 mxGraph 的矩形形状完全不看它 —— 离线渲染器一张图都不出。
    /// 代价是图片占满节点框，文字只能落到框外，想在图里写说明请用 Callout。
    /// </summary>
    private static string FuncImageStyle(string asset) =>
        "shape=image;imageAspect=0;image=" + asset +
        ";verticalLabelPosition=bottom;verticalAlign=top;html=1;fontSize=13;fontStyle=1;";

    /// <summary>
    /// 文字块的样式串。
    ///
    /// <c>text;</c> 是 draw.io 的命名样式（无边框纯文本），离线渲染器认不出这个裸段、
    /// 会静默丢掉它，所以同时把 strokeColor/fillColor 显式写成 none —— 两条渲染
    /// 路径的结果都是一个无边框文本框。刻意不用 <c>shape=note</c>：它不在
    /// mxCellRenderer 的默认形状表里，离线渲染会退回矩形。
    /// </summary>
    private static string CalloutStyle(Callout c)
    {
        var fill = CalloutFill.GetValueOrDefault(c.Shape, "none");
        var stroke = CalloutStroke.GetValueOrDefault(c.Shape, "none");
        var size = c.FontSize > 0 ? c.FontSize : CalloutFont.GetValueOrDefault(c.Shape, 12);
        var baseStyle = c.Shape == "text" ? "text;" : "rounded=1;";
        var dashed = c.Shape == "band" ? "dashed=1;" : "";
        return baseStyle + "whiteSpace=wrap;html=1;strokeColor=" + stroke + ";fillColor=" + fill + ";" + dashed +
               "align=left;verticalAlign=top;fontSize=" + Text.Num(size) + ";spacingLeft=8;spacingTop=6;";
    }

    /// <summary>
    /// 一个文字块的 <c>&lt;object&gt;</c> 属性表。
    ///
    /// label 原样交给 <see cref="Attrs"/>（只转义一遍）：<c>&lt;br&gt;</c> 在文件里成为
    /// <c>&amp;lt;br&amp;gt;</c>，XML 读回即 <c>&lt;br&gt;</c>，draw.io 按 html=1 换行。
    /// 若先 escape 一遍，文件里会变成 <c>&amp;amp;lt;br&amp;amp;gt;</c>，读回来是
    /// **字面量** <c>&amp;lt;br&amp;gt;</c>，图上显示成七个字符。
    /// </summary>
    private static List<(string Key, string? Val)> CalloutAttrs(Callout c, int i) =>
    [
        ("id", "co" + (i + 1).ToString(CultureInfo.InvariantCulture)),
        ("label", c.Text),
        ("symbolId", c.Id),
        ("kind", "callout"),
        ("owner", c.Owner),
    ];

    /// <summary>
    /// 直连边上的可见文本。
    ///
    /// 用信号的 <c>Unit</c>（中文语义名）而不是 <c>Alias</c>：后者带 <c>a5</c> 这类编号，
    /// 挂在线上会把线挤满。另一端是真节点（信号没被折掉）时，线上写 read/write —— 它和
    /// 箭头方向完全同义（箭头指着谁，谁的视角就是 read），纯冗余。设备总览那种几十条边
    /// 的图上会把图面糊死，所以 <c>--no-rw-labels</c> 把这一类标签去掉。
    /// </summary>
    private static string InlineEdgeLabel(Model model, Edge e, bool rwLabels)
    {
        if (string.IsNullOrEmpty(e.Sig))
        {
            return rwLabels ? e.Rw : "";
        }

        var signal = model.SignalOrNull(e.Sig);
        if (signal is null)
        {
            return rwLabels ? e.Rw : "";
        }

        return Text.HtmlEscape(signal.Unit.Length > 0 ? signal.Unit : signal.Name);
    }

    private static readonly Regex AnchorRe = new(
        @"exitX=([\d.-]+);exitY=([\d.-]+);exitDx=[\d.-]+;exitDy=[\d.-]+;entryX=([\d.-]+);entryY=([\d.-]+);",
        RegexOptions.Compiled);

    // 中日韩/全角字符占一个字宽，拉丁字母约 0.58 个字宽。范围与 TS 的 textWidth 相同：
    // U+2E80–U+9FFF、U+3000–U+303F、U+FF00–U+FFEF。
    private static readonly Regex CjkRe = new("[⺀-鿿　-〿＀-￯]", RegexOptions.Compiled);

    /// <summary>
    /// 从样式串里取回 exit*/entry* 锚点；没有则 null。
    ///
    /// 走 <c>--layout-from</c> 拿到人工拐点的边不会重新路由，没有本次路由的锚点可依，
    /// 于是退到样式串里记着的那个，再退到默认左右中点 —— 去叠印只需要一个够用的近似。
    /// </summary>
    private static (double, double, double, double)? StyleAnchor(string style)
    {
        var m = AnchorRe.Match(style);
        if (!m.Success)
        {
            return null;
        }

        static double Parse(string s) => double.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture);
        return (Parse(m.Groups[1].Value), Parse(m.Groups[2].Value),
                Parse(m.Groups[3].Value), Parse(m.Groups[4].Value));
    }

    /// <summary>一行文字大概占多宽：中日韩/全角一个字一格，拉丁字母半个多格。</summary>
    private static double TextWidth(string label, double font)
    {
        var total = 0.0;
        foreach (var ch in label)
        {
            total += CjkRe.IsMatch(ch.ToString()) ? font : font * 0.58;
        }

        return total;
    }

    /// <summary>
    /// 折线的**弧长中点**，以及中点处的单位法线。
    ///
    /// 为什么是弧长中点：draw.io 把边的文字放在那儿（从渲染结果反推的）。用欧氏
    /// 长度，不能用曼哈顿长度 —— 折了弯以后两者差半个身位。法线只在去叠印时用。
    /// </summary>
    private static ((double X, double Y) Anchor, (double X, double Y) Normal) MidAndNormal(
        List<(double X, double Y)> pts)
    {
        if (pts.Count == 0)
        {
            return ((0.0, 0.0), (0.0, -1.0));
        }

        var segs = new List<double>();
        var total = 0.0;
        for (var i = 0; i < pts.Count - 1; i++)
        {
            var d = Math.Sqrt(Math.Pow(pts[i + 1].X - pts[i].X, 2) + Math.Pow(pts[i + 1].Y - pts[i].Y, 2));
            segs.Add(d);
            total += d;
        }

        if (total == 0)
        {
            return (pts[0], (0.0, -1.0));
        }

        var acc = 0.0;
        for (var i = 0; i < segs.Count; i++)
        {
            var seg = segs[i];
            if (acc + seg >= total / 2.0)
            {
                var p = pts[i];
                var q = pts[i + 1];
                var t = seg == 0 ? 0.0 : ((total / 2.0) - acc) / seg;
                var dx = q.X - p.X;
                var dy = q.Y - p.Y;
                var length = Math.Sqrt((dx * dx) + (dy * dy));
                if (length == 0)
                {
                    length = 1.0;
                }

                return ((p.X + (dx * t), p.Y + (dy * t)), (-dy / length, dx / length));
            }

            acc += seg;
        }

        return (pts[^1], (0.0, -1.0));
    }

    /// <summary>
    /// 标签文字的估算占位盒，**以落点为中心**。
    ///
    /// 渲染件里标签是 text-anchor="middle"，落点是文字中心而不是左边缘。宽度按字数估：
    /// 中日韩一个字一格、拉丁字母 0.58 格（略宽于实测，宁可多判一处）。
    /// </summary>
    private static (double X, double Y, double W, double H) LabelBox((double X, double Y) anchor, string label)
    {
        var w = TextWidth(label, LabelFont);
        var h = LabelFont * 1.4;
        return (anchor.X - (w / 2.0), anchor.Y - (h / 2.0), w, h);
    }

    /// <summary>两个占位盒是否真的压在一起（留 2 像素容差，贴边不算撞）。</summary>
    private static bool BoxesClash(
        (double X, double Y, double W, double H) a, (double X, double Y, double W, double H) b) =>
        a.X < b.X + b.W - 2 && b.X < a.X + a.W - 2 && a.Y < b.Y + b.H && b.Y < a.Y + a.H;

    /// <summary>两个盒子在竖直方向是否还有重叠（横向不参与 —— 只用来判「错开」）。</summary>
    private static bool OverlapsY(
        (double X, double Y, double W, double H) a, (double X, double Y, double W, double H) b) =>
        a.Y < b.Y + b.H && b.Y < a.Y + a.H;

    /// <summary>
    /// 格号 -&gt; 竖直方向的格数。0 格不动，其余按 +1、-1、+2… 交替（下、上、下下…），
    /// 免得几条标签一起往同一边推、推出画布。
    /// </summary>
    private static double LaneShift(int lane)
    {
        if (lane == 0)
        {
            return 0;
        }

        return (lane % 2 == 1 ? 1 : -1) * Math.Ceiling(lane / 2.0);
    }

    /// <summary>
    /// 把**压在一起**的标签推开，返回每条在 **y 方向**上的位移。
    ///
    /// 没撞的都是 0；**正数向下、负数向上**，调用方直接写进 <c>as="offset"</c> 的 y。
    /// 为什么必须处理：<c>--inline</c> 把一写一读的信号折成直连边后，同一对节点之间的
    /// 几条边会走到同一条折线上（锚点都取边中点），标签叠印在同一点。
    ///
    /// 算法三步：
    ///   1. 占位盒相交就把两条连起来，取**连通分量** —— 甲撞乙、乙撞丙而甲丙不撞时，
    ///      三条仍得各占一个位置；
    ///   2. 团内按传入次序编号，第 1 条不动（没有叠印的图产物逐字节不变），其余按
    ///      +1、-1、+2… 交替试格；
    ///   3. 试格判据不是「格号够不够」而是「与已落位的每一条都错开」—— 两条标签本来
    ///      就可能差 6 像素，固定推 17 像素会过冲，落到另一侧仍叠着。
    /// </summary>
    internal static double[] SeparateLabels(
        IReadOnlyList<(double X, double Y, double W, double H)?> boxes, double lane)
    {
        var n = boxes.Count;
        var output = new double[n];
        var parent = new int[n];
        for (var i = 0; i < n; i++)
        {
            parent[i] = i;
        }

        int Find(int x)
        {
            var r = x;
            while (parent[r] != r)
            {
                r = parent[r];
            }

            var c = x;
            while (parent[c] != r)
            {
                var next = parent[c];
                parent[c] = r;
                c = next;
            }

            return r;
        }

        for (var i = 0; i < n; i++)
        {
            if (boxes[i] is not { } a)
            {
                continue;
            }

            for (var j = 0; j < i; j++)
            {
                if (boxes[j] is not { } b || !BoxesClash(a, b))
                {
                    continue;
                }

                parent[Find(i)] = Find(j);
            }
        }

        // 用 List 而不是 Dictionary 分组：Python 的 dict 按首次出现保序，而这里按
        // 索引升序产出，组间顺序不影响结果（每组独立落位），但保持确定性更好调试。
        var order = new List<int>();
        var groups = new Dictionary<int, List<int>>();
        for (var i = 0; i < n; i++)
        {
            if (boxes[i] is null)
            {
                continue;
            }

            var root = Find(i);
            if (!groups.TryGetValue(root, out var members))
            {
                members = [];
                groups[root] = members;
                order.Add(root);
            }

            members.Add(i);
        }

        foreach (var root in order)
        {
            var members = groups[root];
            if (members.Count < 2)
            {
                continue;
            }

            var placed = new List<(double X, double Y, double W, double H)>();
            for (var k = 0; k < members.Count; k++)
            {
                var idx = members[k];
                var box = boxes[idx]!.Value;
                if (k == 0)
                {
                    placed.Add(box);
                    continue;
                }

                var step = 1;
                while (true)
                {
                    var shift = LaneShift(step) * lane;
                    var moved = (box.X, box.Y + shift, box.W, box.H);
                    var clear = true;
                    foreach (var p in placed)
                    {
                        if (OverlapsY(moved, p))
                        {
                            clear = false;
                            break;
                        }
                    }

                    if (clear)
                    {
                        output[idx] = shift;
                        placed.Add(moved);
                        break;
                    }

                    step++;
                }
            }
        }

        return output;
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

    /// <summary>边两趟发射的中间结果：第一趟只算走法、标签与几何，第二趟才写 XML。</summary>
    private sealed class LaidEdge
    {
        public int Index { get; init; }
        public required Edge Edge { get; init; }
        public string Style { get; init; } = "";
        public string Parent { get; init; } = "";
        public string Geom { get; init; } = "";
        public string Label { get; init; } = "";
        public (double X, double Y) Anchor { get; init; }
        public (double X, double Y) Normal { get; init; }
    }

    /// <summary>
    /// 渲染整张图为 .drawio 文本。会**就地修改** model 的坐标。
    ///
    /// 发射顺序：分区带 -&gt; 容器 -&gt; 节点 -&gt; 说明文字 -&gt; 边（边另带被推开的标签）。
    /// 顺序不是随意的：
    /// <list type="bullet">
    /// <item>band 必须写在容器<b>之前</b>。draw.io 按文档顺序叠放，容器连同整棵子树一起
    /// 画；band 是根的直接子节点，排在容器后面就会落在整棵子树上面、把卡片全盖住。</item>
    /// <item>box / text 写在节点之后 —— 它们本来就该压在卡片上面。</item>
    /// <item>边分两趟：先算走法与标签落点，再写 XML。第二趟才写是去叠印逼出来的：
    /// 落点和<b>所有</b>边比过之后，才知道哪几条标签叠在一起。</item>
    /// </list>
    ///
    /// 三个开关都带默认值，所以不传新参数时产物与旧版逐字节相同。
    /// </summary>
    public static string ToDrawio(Model model, bool cards = false, bool rwLabels = true, bool straightEdges = false)
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

        // 文字块挂在根 parent="1" 下、用画布绝对坐标。它们不属于任何容器（见 Callout），
        // 所以不做容器偏移，也不参与 ContainerBox。band 在容器前发，其余在节点后发。
        void EmitCallouts(bool wantBand)
        {
            for (var i = 0; i < model.Callouts.Count; i++)
            {
                var c = model.Callouts[i];
                if ((c.Shape == "band") != wantBand)
                {
                    continue;
                }

                sb.Append("        <object ").Append(Attrs(CalloutAttrs(c, i))).Append(">\n")
                  .Append("          <mxCell style=\"").Append(CalloutStyle(c))
                  .Append("\" vertex=\"1\" parent=\"1\">\n")
                  .Append("            <mxGeometry x=\"").Append(Text.Num(c.X))
                  .Append("\" y=\"").Append(Text.Num(c.Y))
                  .Append("\" width=\"").Append(Text.Num(c.W))
                  .Append("\" height=\"").Append(Text.Num(c.H))
                  .Append("\" as=\"geometry\" />\n")
                  .Append("          </mxCell>\n")
                  .Append("        </object>\n");
            }
        }

        EmitCallouts(true);

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
            // `Style` 原样追加在样式串末尾（角色分色这类装饰）。空串等于没追加，
            // 所以不写 Style 的源码产物逐字节不变。
            string style;
            if (kind == "signal")
            {
                var s = (Signal)e;
                style = (s.Dir switch
                {
                    "in" => SignalInStyle,
                    "out" => SignalOutStyle,
                    _ => SignalStyle,
                }) + s.Style;
            }
            else
            {
                var f = (Func)e;
                style = cards && f.Asset.Length > 0
                    ? FuncImageStyle(f.Asset) + f.Style
                    : (e.External ? FuncExtStyle : FuncStyle) + f.Style;
            }

            var pairs = new List<(string, string?)>
            {
                ("id", cellId[e.Id]),
                ("label", NodeLabel(kind, e, cards)),
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

        EmitCallouts(false);

        // 第一趟：算走法、标签落点与几何。
        var edges = model.Edges.OrderBy(EdgeKey, StringComparer.Ordinal).ToList();
        var laid = new List<LaidEdge>();
        for (var n = 0; n < edges.Count; n++)
        {
            var e = edges[n];
            var srcPath = EntityPath(Node(model, e.Src));
            var dstPath = EntityPath(Node(model, e.Dst));
            // 同容器内的边挂在该容器下（坐标相对容器），跨容器的边挂在根下（坐标绝对）
            var parent = srcPath == dstPath ? gid[srcPath] : "1";
            var (ox, oy) = parent != "1" ? (boxes[srcPath].X, boxes[srcPath].Y) : (0.0, 0.0);
            var style = straightEdges ? StraightEdgeStyle : EdgeStyle;

            // 内联边的颜色跟着它折叠掉的那个信号走：信号上的 Style 片段本来是给节点
            // 用的，节点没了，这个片段就落到线上 —— 否则「按关系性质分色」就没有落点。
            if (e.Rw == "inline" && !string.IsNullOrEmpty(e.Sig))
            {
                var signal = model.SignalOrNull(e.Sig);
                if (signal is not null)
                {
                    style += signal.Style;
                }
            }

            (double A, double B, double C, double D)? anchors = null;
            var waypoints = new List<(double X, double Y)>(e.Waypoints);
            if (waypoints.Count == 0)
            {
                var avoid = Entities(model).Select(t => (t.Node.X, t.Node.Y, t.Node.W, t.Node.H)).ToList();
                var gap = parent == "1" ? CrossGap(boxes[srcPath], boxes[dstPath]) : null;
                // 直线模式**只丢自动拐点**：--layout-from 里人工画上的拐点照样保留 ——
                // 那是人明确放上去的东西，不该被一个样式开关悄悄吞掉。
                // 拐点可以丢，锚点不能丢：它决定线贴着哪条边走，丢了 draw.io 会自己
                // 就近挑边，「左右相连」可能变成从上下出线。
                var routed = RouteEdge(model, e, avoid, gap);
                anchors = routed.Anchors;
                waypoints = straightEdges ? [] : routed.Waypoints;
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

            // 折线 = 出锚点 -> 拐点 -> 入锚点。走 --layout-from 拿到人工拐点的边没有
            // 锚点可依，退到样式串里记着的锚点，再退到默认左右中点（draw.io 自己的
            // 默认是「就近贴边框」，这里只是给去叠印一个够用的近似）。
            var anchorSet = anchors ?? StyleAnchor(style) ?? (1.0, 0.5, 0.0, 0.5);
            var (sp, dp) = Endpoints(Rect(model, e.Src), Rect(model, e.Dst), anchorSet);
            var polyline = new List<(double X, double Y)>(waypoints.Count + 2) { sp };
            polyline.AddRange(waypoints);
            polyline.Add(dp);
            var (anchor, normal) = MidAndNormal(polyline);
            laid.Add(new LaidEdge
            {
                Index = n,
                Edge = e,
                Style = style,
                Parent = parent,
                Geom = geom,
                Label = InlineEdgeLabel(model, e, rwLabels),
                Anchor = anchor,
                Normal = normal,
            });
        }

        var labelBoxes = laid
            .Select(x => x.Label.Length == 0
                ? ((double X, double Y, double W, double H)?)null
                : LabelBox(x.Anchor, x.Label))
            .ToList();
        var shifts = SeparateLabels(labelBoxes, LabelLane);

        foreach (var le in laid)
        {
            var eid = "e" + (le.Index + 1).ToString(CultureInfo.InvariantCulture);
            var shift = shifts[le.Index];
            var moved = shift != 0;
            var edgePairs = new List<(string, string?)>
            {
                ("id", eid),
                // 被推开的标签不再留在边上：draw.io 自己拖标签时就是把文字挪进子单元格，
                // 两处都留着会画两遍。
                ("label", moved ? "" : le.Label),
                ("rel", "def-use"),
                ("src", le.Edge.Src),
                ("dst", le.Edge.Dst),
                ("rw", le.Edge.Rw),
            };
            // 折叠掉的信号 id 留在边上：回读与校验时才能把这根线还原回 a5 那样的编号
            if (!string.IsNullOrEmpty(le.Edge.Sig))
            {
                edgePairs.Add(("sig", le.Edge.Sig));
            }

            sb.Append("        <object ").Append(Attrs(edgePairs)).Append(">\n")
              .Append("          <mxCell style=\"").Append(le.Style)
              .Append("\" edge=\"1\" parent=\"").Append(le.Parent)
              .Append("\" source=\"").Append(cellId[le.Edge.Src])
              .Append("\" target=\"").Append(cellId[le.Edge.Dst]).Append("\">\n")
              .Append("            ").Append(le.Geom).Append("\n")
              .Append("          </mxCell>\n")
              .Append("        </object>\n");

            if (!moved)
            {
                continue;
            }

            // 位移写进 `<mxPoint as="offset">`，**不要**写进 mxGeometry 的 x/y。
            // mxGraphView.getPoint 里两条路的语义完全不同：
            //   - geometry.y 沿矢量 (dy/L, -dx/L) 位移 —— 永远垂直于那条边，方向随边的
            //     走向转：横边上是上下、竖边上就成了左右；
            //   - geometry.offset 直接加到点上 —— 全局坐标轴，与边走法无关。
            // 按下都推开了却横着散开（该叠的还是叠着），就是踩了第一条。
            // geometry.x=0 是沿边的相对位置（0 = 弧长中点），保持不动。
            sb.Append("        <mxCell id=\"").Append(eid).Append("_label\" value=\"")
              .Append(Text.HtmlEscape(le.Label))
              .Append("\" style=\"").Append(EdgeLabelStyle)
              .Append("\" vertex=\"1\" connectable=\"0\" parent=\"").Append(eid).Append("\">\n")
              .Append("          <mxGeometry x=\"0\" y=\"0\" relative=\"1\" as=\"geometry\">")
              .Append("<mxPoint x=\"0\" y=\"").Append(Text.Num(shift)).Append("\" as=\"offset\" /></mxGeometry>\n")
              .Append("        </mxCell>\n");
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

            // **挂在边下面的单元格是标签，不是节点**：去叠印写出的子标签就长这样
            // （parent 指向那条边）。漏掉这一条，sync 会把每条被推开的标签都当成
            // 「用户在图上新加的节点」，往源码里写一个名叫「经局域网读取数据集」的函数。
            if (info.Parent is not null && cells.TryGetValue(info.Parent, out var parentInfo) && parentInfo.IsEdge)
            {
                continue;
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

    /// <summary>
    /// 每个实体此刻的 <c>(x, y, w, h)</c>。必须在跑过默认布局之后取。
    ///
    /// 两个 map 都收：<see cref="Entities"/> 会跳过被 inline 折叠的信号，而覆盖循环靠
    /// <c>SignalOrNull ?? FuncOrNull</c> 命中实体 —— 两者的集合必须对齐，
    /// 否则折叠过的信号在图上被拖了也记不进 pinned。
    /// </summary>
    private static Dictionary<string, (double X, double Y, double W, double H)> GeometrySnapshot(Model model)
    {
        var snap = new Dictionary<string, (double X, double Y, double W, double H)>(StringComparer.Ordinal);
        foreach (var s in model.Signals.Values)
        {
            snap[s.Id] = (s.X, s.Y, s.W, s.H);
        }

        foreach (var f in model.Funcs.Values)
        {
            snap[f.Id] = (f.X, f.Y, f.W, f.H);
        }

        return snap;
    }

    /// <summary>
    /// 把快照写回实体 —— 让「取基线」变成**非破坏性**的（见 <see cref="ApplyLayout"/>）。
    /// 遍历实体侧而不是快照侧：快照是实体的子集，遍历实体能保证一个都不漏。
    /// </summary>
    private static void RestoreGeometry(
        Model model, IReadOnlyDictionary<string, (double X, double Y, double W, double H)> snap)
    {
        foreach (var s in model.Signals.Values)
        {
            if (snap.TryGetValue(s.Id, out var r))
            {
                (s.X, s.Y, s.W, s.H) = r;
            }
        }

        foreach (var f in model.Funcs.Values)
        {
            if (snap.TryGetValue(f.Id, out var r))
            {
                (f.X, f.Y, f.W, f.H) = r;
            }
        }
    }

    /// <summary>
    /// 「读回值与基线不一致」→ 记进 <see cref="Model.Pinned"/>（要回写源码的人工排版意图）。
    ///
    /// 用**精确不等**，不设浮点容差：坐标本来就是整数，容差只会把「只拖动了一两个
    /// 像素」这种真实排版吞掉。xy 存的是**读回值**（绝对画布坐标）。
    /// </summary>
    private static void RecordPinned(
        Model model,
        string sid,
        (double X, double Y, double W, double H)? baseGeom,
        (double X, double Y, double W, double H) read)
    {
        if (baseGeom is not { } b)
        {
            return;
        }

        var geom = new PinnedGeom();
        if (read.X != b.X || read.Y != b.Y)
        {
            geom.Xy = [read.X, read.Y];
        }

        if (read.W != b.W || read.H != b.H)
        {
            geom.Size = [read.W, read.H];
        }

        if (geom.Xy is not null || geom.Size is not null)
        {
            model.Pinned[sid] = geom;
        }
    }

    /// <summary>
    /// 把读出来的排版套回 IR。
    ///
    /// 这里有两处**必须理解**的处理：
    /// <list type="number">
    /// <item><b>基线</b>：先跑 <see cref="AssignDefaultPositions"/> 摆好默认布局，再快照
    /// 每个实体的 (x,y,w,h) —— 这就是「build 本来会写进 .drawio 的几何」（源码声明的
    /// xy/size 优先，没声明则是默认布局值）。读出值偏离基线（精确不等）的实体记进
    /// <see cref="Model.Pinned"/>，供回写侧写进源码注解。判据为什么不是「与默认布局比」：
    /// 一个节点在源码里<b>已经有</b> xy 时，坐标本来就与默认布局不同 —— 拿默认布局当
    /// 基准，每次 sync 都会重写这个键，而 sync 的验收标准是「没人动过就零 diff」。
    ///
    /// 取基线时多调了一次 AssignDefaultPositions，但<b>跑完立刻把模型恢复原状</b>
    /// （live 快照 -&gt; AssignDefaultPositions -&gt; base 快照 -&gt; RestoreGeometry）。
    /// 这么绕是为了绕开实测出来的一个坑：AssignDefaultPositions <b>不是固定点</b> ——
    /// 单层容器成立，多层容器（path 含 <c>/</c>）不成立，每调一次非最深层的实体整体
    /// 右移 PAD(30)，且不收敛。不恢复的话，没人拖过的节点也会被判定成「人拖过」
    /// 而进 pinned，sync 写出源码里本没有的 xy，幂等性直接崩掉。这是先于本特性
    /// 就存在的缺陷（修它会动金标准），故只绕开、不修改。</item>
    /// <item><b>覆盖</b>节点几何（x/y/w/h），用户拖过的位置才算数。</item>
    /// </list>
    ///
    /// 末尾那个 <c>waypoints == auto</c> 判断：回读时无法区分「人工拖出来的拐点」
    /// 和「上次自动算出来的拐点」—— 两者在文件里长得一模一样。先按当前坐标把所有边
    /// 自动算一遍，凡是与自动值相等的，就认定它只是上次生成的产物，<b>丢弃不算人工
    /// 编辑</b>，让本轮重新路由。否则只要用户挪动过一次节点，上一轮的拐点就会被当成
    /// 「用户的选择」永久锁死，线再也绕不回来。
    ///
    /// 已知边界：若用户在 build 之后、sync 之前改过源码（插入节点导致默认布局整体
    /// 位移），那些被挪动但没人碰过的节点会被误判成「人拖过」而钉进源码。这与既有
    /// AutoWaypoints 对边的处理是同一类脆弱性，属已知取舍。
    /// </summary>
    public static Model ApplyLayout(Model model, Layout layout)
    {
        model.Pinned.Clear();
        var live = GeometrySnapshot(model);
        AssignDefaultPositions(model);
        var baseSnap = GeometrySnapshot(model);
        RestoreGeometry(model, live);

        foreach (var (sid, (x, y, w, h)) in layout.Nodes)
        {
            INode? ent = model.SignalOrNull(sid) ?? (INode?)model.FuncOrNull(sid);
            // 容器 cell、callout（两者都以 symbolId 形态出现在 layout.Nodes 里）与
            // 图上未知的 id 都在这里挡掉：它们不是实体，没有「人工改过的几何」可回写。
            if (ent is null)
            {
                continue;
            }

            RecordPinned(
                model,
                sid,
                baseSnap.TryGetValue(sid, out var b) ? b : null,
                (x, y, w, h));
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
