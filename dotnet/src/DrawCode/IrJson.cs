using System.Globalization;
using System.Text;

namespace DrawCode;

/// <summary>
/// IR → 规范化 JSON，L1 比对用的产物。对等 <c>../../../tools/dump_ir.py</c>：
/// 键有序、两空格缩进、非 ASCII 原样保留，并且刻意**不含**布局坐标 ——
/// 把布局混进来会让路由 bug 看起来像解析 bug。
/// </summary>
internal static class IrJson
{
    public static string ToJson(Model model)
    {
        var signals = new List<object?>();
        foreach (var s in model.Signals.Values.OrderBy(s => s.Id, StringComparer.Ordinal))
        {
            signals.Add(Map(
                ("id", s.Id),
                ("name", s.Name),
                ("ctype", s.CType),
                ("dir", s.Dir),
                ("file", s.File),
                ("line", s.Line),
                ("unit", s.Unit),
                ("alias", s.Alias),
                ("note", s.Note),
                ("external", s.External),
                ("group", s.Group)));
        }

        var funcs = new List<object?>();
        foreach (var f in model.Funcs.Values.OrderBy(f => f.Id, StringComparer.Ordinal))
        {
            var pars = new List<object?>();
            foreach (var p in f.Params)
            {
                pars.Add(Map(("name", p.Name), ("ctype", p.CType), ("dir", p.Dir)));
            }

            funcs.Add(Map(
                ("id", f.Id),
                ("name", f.Name),
                ("ret", f.Ret),
                ("params", pars),
                ("file", f.File),
                ("line", f.Line),
                ("alias", f.Alias),
                ("note", f.Note),
                ("tooltip", f.Tooltip),
                ("asset", f.Asset),
                ("external", f.External),
                ("group", f.Group),
                ("reads", Strings(f.Reads)),
                ("writes", Strings(f.Writes)),
                ("calls", Strings(f.Calls))));
        }

        var edges = model.Edges
            .OrderBy(e => e.Src, StringComparer.Ordinal)
            .ThenBy(e => e.Dst, StringComparer.Ordinal)
            .ThenBy(e => e.Rw, StringComparer.Ordinal)
            .Select(e => (object?)Map(("src", e.Src), ("dst", e.Dst), ("rw", e.Rw)))
            .ToList();

        var devices = new List<object?>();
        foreach (var (id, d) in model.Devices.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            devices.Add(Map(
                ("id", id),
                ("vendor", d.Vendor),
                ("model", d.Model),
                ("spec", d.Spec),
                ("size", d.Size),
                ("asset", d.Asset)));
        }

        var root = Map(
            ("signals", signals),
            ("funcs", funcs),
            ("edges", edges),
            ("devices", devices),
            ("files", Strings(model.Files, sort: true)));

        var sb = new StringBuilder();
        Write(sb, root, 0);
        sb.Append('\n');
        return sb.ToString();
    }

    private static SortedDictionary<string, object?> Map(params (string Key, object? Val)[] pairs)
    {
        var map = new SortedDictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (k, v) in pairs)
        {
            map[k] = v;
        }

        return map;
    }

    private static List<object?> Strings(IEnumerable<string> values, bool sort = false)
    {
        var list = new List<string>(values);
        if (sort)
        {
            list.Sort(StringComparer.Ordinal);
        }

        return [.. list.Select(v => (object?)v)];
    }

    private static void Write(StringBuilder sb, object? value, int indent)
    {
        switch (value)
        {
            case null:
                sb.Append("null");
                break;
            case bool b:
                sb.Append(b ? "true" : "false");
                break;
            case int i:
                sb.Append(i.ToString(CultureInfo.InvariantCulture));
                break;
            case string s:
                WriteString(sb, s);
                break;
            case SortedDictionary<string, object?> map:
                WriteMap(sb, map, indent);
                break;
            case List<object?> list:
                WriteList(sb, list, indent);
                break;
            default:
                throw new InvalidOperationException("unsupported JSON node: " + value.GetType());
        }
    }

    private static void WriteMap(StringBuilder sb, SortedDictionary<string, object?> map, int indent)
    {
        if (map.Count == 0)
        {
            sb.Append("{}");
            return;
        }

        sb.Append("{\n");
        var first = true;
        foreach (var (k, v) in map)
        {
            if (!first)
            {
                sb.Append(",\n");
            }

            first = false;
            sb.Append(' ', indent + 2);
            WriteString(sb, k);
            sb.Append(": ");
            Write(sb, v, indent + 2);
        }

        sb.Append('\n');
        sb.Append(' ', indent);
        sb.Append('}');
    }

    private static void WriteList(StringBuilder sb, List<object?> list, int indent)
    {
        if (list.Count == 0)
        {
            sb.Append("[]");
            return;
        }

        sb.Append("[\n");
        for (var i = 0; i < list.Count; i++)
        {
            if (i > 0)
            {
                sb.Append(",\n");
            }

            sb.Append(' ', indent + 2);
            Write(sb, list[i], indent + 2);
        }

        sb.Append('\n');
        sb.Append(' ', indent);
        sb.Append(']');
    }

    /// <summary>转义行为与 Python 的 <c>json</c> 在 <c>ensure_ascii=False</c> 下完全一致。</summary>
    private static void WriteString(StringBuilder sb, string s)
    {
        sb.Append('"');
        foreach (var c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20)
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }

                    break;
            }
        }

        sb.Append('"');
    }
}
