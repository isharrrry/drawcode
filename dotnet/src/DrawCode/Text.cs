using System.Globalization;

namespace DrawCode;

/// <summary>
/// 这些辅助函数必须**精确复刻 Python 语义**，不能只是"看起来对"。
/// 这里每个方法之所以存在，都是因为 .NET 里最显然的等价写法与 Python 不一致。
/// </summary>
internal static class Text
{
    /// <summary>
    /// 以 UTF-8 读源码，**不剥掉** BOM。
    /// Python 的 <c>open(p, encoding="utf-8")</c> 会把 U+FEFF 留在文本里，而
    /// <c>File.ReadAllText</c> 会悄悄吃掉它 —— 仅这一处差异就能让本该匹配的首行变得匹配不上。
    /// <c>newline: ""</c> 的语义靠"保留原换行符、到 <see cref="SplitLines"/> 里再切"来模拟。
    /// </summary>
    internal static string ReadSource(string path)
    {
        using var reader = new StreamReader(
            path,
            new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            detectEncodingFromByteOrderMarks: false);
        return reader.ReadToEnd();
    }

    /// <summary>写 UTF-8，无 BOM、不做换行翻译，对等 Python 的 <c>newline=""</c>。</summary>
    internal static void WriteText(string path, string text)
    {
        using var writer = new StreamWriter(
            path,
            append: false,
            new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        writer.Write(text);
    }

    /// <summary>
    /// 对等 Python 的 <c>str.splitlines()</c>：按**完整的 Unicode 换行符集合**切分，不只是 LF。
    /// 结尾的换行不会产生一个多余的空元素。
    /// </summary>
    internal static string[] SplitLines(string text)
    {
        var result = new List<string>();
        if (text.Length == 0)
        {
            return [];
        }

        var start = 0;
        var i = 0;
        while (i < text.Length)
        {
            var c = text[i];
            if (!IsLineBreak(c))
            {
                i++;
                continue;
            }

            result.Add(text[start..i]);
            if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n')
            {
                i++;
            }

            i++;
            start = i;
        }

        if (start < text.Length)
        {
            result.Add(text[start..]);
        }

        return [.. result];
    }

    private static bool IsLineBreak(char c) => c switch
    {
        '\n' or '\r' or '\v' or '\f' or '\u001c' or '\u001d' or '\u001e' or '\u0085' or '\u2028' or '\u2029' => true,
        _ => false,
    };

    /// <summary>
    /// 对等 Python 的 <c>html.escape(s, quote=True)</c>。注意**单引号**：
    /// Python 输出 <c>&amp;#x27;</c>，而 <c>WebUtility.HtmlEncode</c> 输出 <c>&amp;#39;</c>——
    /// 字面不同，产物就不是逐字节相同。
    /// </summary>
    internal static string HtmlEscape(string s)
    {
        var sb = new System.Text.StringBuilder(s.Length);
        foreach (var c in s)
        {
            switch (c)
            {
                case '&': sb.Append("&amp;"); break;
                case '<': sb.Append("&lt;"); break;
                case '>': sb.Append("&gt;"); break;
                case '"': sb.Append("&quot;"); break;
                case '\'': sb.Append("&#x27;"); break;
                default: sb.Append(c); break;
            }
        }

        return sb.ToString();
    }

    /// <summary>
    /// 对等 Python 的 <c>_num</c>：整数值不带小数点，其余用**最短往返**表示。
    /// 一律用 InvariantCulture，否则小数点会跟着系统区域设置变成逗号。
    /// </summary>
    internal static string Num(double v)
    {
        // NaN / ±Infinity 显式处理：几何键是**不校验**的（见 CParse.JsNumber），
        // 畸形坐标会一路流到这里。字面量必须与 Python `_num` / TS `reprFloat`
        // 逐字相同 —— 小写 nan/inf、带符号 -inf；.NET 默认会写 "NaN"/"Infinity"，
        // 三个版本的产物随即分叉。
        if (double.IsNaN(v))
        {
            return "nan";
        }

        if (double.IsPositiveInfinity(v))
        {
            return "inf";
        }

        if (double.IsNegativeInfinity(v))
        {
            return "-inf";
        }

        if (v == Math.Floor(v) && v >= long.MinValue && v <= long.MaxValue)
        {
            return ((long)v).ToString(CultureInfo.InvariantCulture);
        }

        return v.ToString("R", CultureInfo.InvariantCulture);
    }

    /// <summary>拼接时保留末尾换行，对等 Python 的 splitlines/join 往返语义。</summary>
    internal static string JoinLines(IEnumerable<string> lines) => string.Join("\n", lines);

    internal static List<string> Sorted(IEnumerable<string> values)
    {
        var list = new List<string>(values);
        list.Sort(StringComparer.Ordinal);
        return list;
    }
}
