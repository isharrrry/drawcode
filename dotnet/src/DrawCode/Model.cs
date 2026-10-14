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
    public double X { get; set; }
    public double Y { get; set; }
    public double W { get; set; } = 160;
    public double H { get; set; } = 60;
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

    public void AddSignal(Signal s) => Signals[s.Id] = s;

    public void AddFunc(Func f) => Funcs[f.Id] = f;

    /// <summary>边由 <c>reads</c>/<c>writes</c> 推导而来，从不手工编写。</summary>
    public List<Edge> RebuildEdges()
    {
        var output = new List<Edge>();
        foreach (var f in Funcs.Values)
        {
            foreach (var sid in f.Reads)
            {
                output.Add(new Edge { Src = sid, Dst = f.Id, Rw = "read" });
            }

            foreach (var sid in f.Writes)
            {
                output.Add(new Edge { Src = f.Id, Dst = sid, Rw = "write" });
            }
        }

        Edges = output;
        return output;
    }

    /// <summary>按 symbolId 在信号与函数里查找节点。</summary>
    public Signal? SignalOrNull(string id) => Signals.TryGetValue(id, out var s) ? s : null;

    public Func? FuncOrNull(string id) => Funcs.TryGetValue(id, out var f) ? f : null;
}
