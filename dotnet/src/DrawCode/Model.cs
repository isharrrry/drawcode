/**
 * IR —— 内存态对象图，不落盘。对等 Python `model.py` 与 TypeScript `model.ts`。
 *
 * 语义的唯一事实源是源码；本结构由解析器每次重建，图（.drawio）只是派生产物 + 人工排版载体。
 * x/y/w/h 在 IR 里存在，但属于布局维度，`tools/dump_ir.py` 刻意不把它们写进 L1 金标准。
 */

namespace DrawCode;

/// <summary>
/// 布局与发射阶段对「图上的一个节点」的全部需求。
/// 信号与函数本来毫无关系，但排布器、路由器、SVG 发射器把它们一视同仁。
/// </summary>
internal interface INode
{
    string Id { get; }
    string Group { get; set; }

    /// <summary>
    /// 容器层级，<c>adc/采样前端</c> 这样的斜杠路径。空串表示「没标」，解析器会把它归一化成
    /// 模块名（<c>adc.h</c> -&gt; <c>adc</c>），所以下游拿到的 path 永远非空。
    /// <c>Group</c> 恒等于 path 的第一段，是给「只关心顶层容器」的旧代码用的。
    /// </summary>
    string Path { get; set; }

    double X { get; set; }
    double Y { get; set; }
    double W { get; set; }
    double H { get; set; }
    bool External { get; set; }
}

/// <summary>全局信号（变量），由方向注解声明。</summary>
public sealed class Signal : INode
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string CType { get; init; }
    public string Dir { get; set; } = "in";
    public string File { get; set; } = "";
    public int Line { get; set; }
    public string Unit { get; set; } = "";
    public string Alias { get; set; } = "";
    public string Note { get; set; } = "";
    public bool External { get; set; }
    public string Group { get; set; } = "";
    public string Path { get; set; } = "";

    /// <summary>
    /// 原样追加到节点样式串末尾的片段（<c>strokeColor=#4d7ea8;</c> 这类角色分色）。
    /// 空串等于没追加，所以不写 <c>style</c> 的源码产物逐字节不变。
    /// 来源：C 的 <c>style="…"</c> 与 C# 的 <c>Style = "…"</c>，两个前端都读。
    /// </summary>
    public string Style { get; set; } = "";
    public double X { get; set; }
    public double Y { get; set; }
    public double W { get; set; } = 160;
    public double H { get; set; } = 60;
}

/// <summary>
/// 一块不参与连线的说明文字（<c>[Callout]</c>）。
///
/// 为什么单独成一个列表而不是 Sig/Func 上的字段：一个声明可以挂**多个**文字块，
/// 塞进字段会被后一条静默覆盖。它们的坐标是**画布绝对坐标**，不属于任何容器 ——
/// 容器包围盒（<see cref="Drawio.ContainerBox"/>）也不把它们算进去，否则拖一块说明
/// 就会把容器撑大。
///
/// <c>Shape</c> 取 text（无边框文字）/ box（带底色说明框）/ band（大片分区带）。
/// <c>FontSize</c> 为 0 表示用该种类的默认字号。
/// </summary>
public sealed class Callout
{
    public required string Id { get; init; }
    public string Text { get; set; } = "";
    public string Owner { get; set; } = "";
    public string Shape { get; set; } = "text";
    public double FontSize { get; set; }
    public double X { get; set; }
    public double Y { get; set; }
    public double W { get; set; } = 200;
    public double H { get; set; } = 40;
}

/// <summary>
/// 「从图里读回、且与 build 本来会写出的值不同」的几何 —— 要回写进源码注解的部分。
///
/// 两个字段各自可选：只拖动不改尺寸时只有 <see cref="Xy"/>；只缩放时只有
/// <see cref="Size"/>。值是**绝对画布坐标**，与 <see cref="Signal.X"/> 同坐标系 ——
/// 节点在容器里时 XML 写的是相对坐标，换算由 Drawio 与 CodeGen 各自负责。
/// </summary>
public sealed class PinnedGeom
{
    public List<double>? Xy { get; set; }
    public List<double>? Size { get; set; }
}

/// <summary>函数形参。形参变成端口，永远不成为节点。</summary>
public sealed class Param
{
    public required string Name { get; init; }
    public required string CType { get; init; }
    public string Dir { get; set; } = "in";
}

/// <summary>参与数据流图的函数。</summary>
public sealed class Func : INode
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public string Ret { get; set; } = "void";
    public List<Param> Params { get; set; } = [];
    public string File { get; set; } = "";
    public int Line { get; set; }
    public string Alias { get; set; } = "";
    public string Note { get; set; } = "";
    public string Tooltip { get; set; } = "";
    public string Asset { get; set; } = "";
    public bool External { get; set; }
    public string Group { get; set; } = "";
    public string Path { get; set; } = "";

    /// <summary>见 <see cref="Signal.Style"/>：追加到样式串末尾的角色分色片段。</summary>
    public string Style { get; set; } = "";
    public List<string> Reads { get; set; } = [];
    public List<string> Writes { get; set; } = [];
    public List<string> Calls { get; set; } = [];
    public double X { get; set; }
    public double Y { get; set; }
    public double W { get; set; } = 180;
    public double H { get; set; } = 72;
}

/// <summary>由 def/use 推导出的边。</summary>
public sealed class Edge
{
    public required string Src { get; init; }
    public required string Dst { get; init; }
    public string Rw { get; set; } = "read";

    /// <summary>
    /// 被折叠掉的那个信号（<c>Rw == "inline"</c> 时非空）。
    ///
    /// 边上要写 <c>sig="a.c::s1"</c>：信号节点没了，但「这条线其实走的是哪个变量」
    /// 这个语义还在，回读布局时靠它认边。读写边为 null。
    /// </summary>
    public string? Sig { get; set; }
    public List<(double X, double Y)> Waypoints { get; set; } = [];
}

/// <summary>挂在函数上的器件元数据。</summary>
public sealed class Device
{
    public string Vendor { get; set; } = "";
    public string Model { get; set; } = "";
    public string Spec { get; set; } = "";
    public string Size { get; set; } = "";
    public string Asset { get; set; } = "";
}

/// <summary>内存态 IR。永不持久化：源码是唯一的事实源。</summary>
public sealed class Model
{
    public Dictionary<string, Signal> Signals { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, Func> Funcs { get; } = new(StringComparer.Ordinal);
    public List<Edge> Edges { get; set; } = [];
    public Dictionary<string, Device> Devices { get; } = new(StringComparer.Ordinal);
    public List<string> Files { get; set; } = [];

    /// <summary>不参与连线的说明文字，按源码声明顺序排列（顺序即绘制顺序）。</summary>
    public List<Callout> Callouts { get; set; } = [];

    /// <summary>
    /// 被 <see cref="CollapseSignals"/> 折叠成直连边的信号 id。渲染器必须跳过它们 ——
    /// 否则信号节点照画、两段边却没了，图上会剩一堆悬空的椭圆。
    /// </summary>
    public HashSet<string> Inlined { get; } = new(StringComparer.Ordinal);

    /// <summary>被折叠的信号 id -> (写者, 读者)，<see cref="RebuildEdges"/> 靠它发射直连边。</summary>
    public Dictionary<string, (string Writer, string Reader)> InlinePairs { get; } =
        new(StringComparer.Ordinal);

    /// <summary>「人拖过」的几何，由 <c>ApplyLayout</c> 填；纯 build 永远是空表。</summary>
    public Dictionary<string, PinnedGeom> Pinned { get; } = new(StringComparer.Ordinal);

    public void AddSignal(Signal s) => Signals[s.Id] = s;

    public void AddFunc(Func f) => Funcs[f.Id] = f;

    public void AddCallout(Callout c) => Callouts.Add(c);

    /// <summary>边由 <c>reads</c>/<c>writes</c> 推导而来，从不手工编写。</summary>
    public List<Edge> RebuildEdges()
    {
        var output = new List<Edge>();
        foreach (var f in Funcs.Values)
        {
            foreach (var sid in f.Reads)
            {
                // 折叠过的信号不产出两段边；直连边在最后统一追加。
                if (Inlined.Contains(sid))
                {
                    continue;
                }

                output.Add(new Edge { Src = sid, Dst = f.Id, Rw = "read" });
            }

            foreach (var sid in f.Writes)
            {
                if (Inlined.Contains(sid))
                {
                    continue;
                }

                output.Add(new Edge { Src = f.Id, Dst = sid, Rw = "write" });
            }
        }

        // 顺序必须与 Python dict / TS Map 的插入顺序一致：边序影响路由平局的选择。
        foreach (var (sid, pair) in InlinePairs)
        {
            output.Add(new Edge { Src = pair.Writer, Dst = pair.Reader, Rw = "inline", Sig = sid });
        }

        Edges = output;
        return output;
    }

    /// <summary>
    /// 把「恰好一写一读」的信号折叠成写者到读者的一条直连边，返回折叠条数。
    ///
    /// 为什么限定**恰好一写一读**：只有这时「信号」与「从 A 到 B 的这一根连线」才是
    /// 同一样东西，折掉它不丢任何信息。多写（多处驱动同一信号）或多读（一个信号广播
    /// 给多方）时，信号是真正的汇合点，折掉它就等于把汇合关系抹掉了。
    ///
    /// 自环（同一个函数既写又读）也跳过：折出来会是一根自己指向自己的线。
    ///
    /// 副作用：会重算 <see cref="Edges"/>。默认不调用，所以不传 <c>--inline</c> 时产物
    /// 逐字节不变。
    /// </summary>
    public int CollapseSignals()
    {
        var writers = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        var readers = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var f in Funcs.Values)
        {
            foreach (var sid in f.Writes)
            {
                if (!writers.TryGetValue(sid, out var list))
                {
                    list = [];
                    writers[sid] = list;
                }

                list.Add(f.Id);
            }

            foreach (var sid in f.Reads)
            {
                if (!readers.TryGetValue(sid, out var list))
                {
                    list = [];
                    readers[sid] = list;
                }

                list.Add(f.Id);
            }
        }

        var folded = 0;
        // 遍历 Signals 而不是 writers/readers：折叠结果必须按信号声明顺序稳定下来，
        // 否则同一份源码在三实现里会排出不同的边序，几何随之漂移。
        foreach (var sid in Signals.Keys)
        {
            var w = writers.TryGetValue(sid, out var wl) ? wl : [];
            var r = readers.TryGetValue(sid, out var rl) ? rl : [];
            if (w.Count != 1 || r.Count != 1)
            {
                continue;
            }

            if (w[0] == r[0])
            {
                continue;
            }

            Inlined.Add(sid);
            InlinePairs[sid] = (w[0], r[0]);
            folded++;
        }

        RebuildEdges();
        return folded;
    }

    /// <summary>按 symbolId 在信号与函数里查找节点。</summary>
    public Signal? SignalOrNull(string id) => Signals.TryGetValue(id, out var s) ? s : null;

    public Func? FuncOrNull(string id) => Funcs.TryGetValue(id, out var f) ? f : null;
}
