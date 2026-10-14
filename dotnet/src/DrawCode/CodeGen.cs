/**
 * IR -> 源码（反向回写）。对等 Python `codegen.py` 与 TypeScript `codegen.ts`。
 *
 * **只碰声明层**：`/// @drawcode` 注解行、声明本身、以及 `[Drawcode]`/`[Device]` 特性，
 * 都是就地重写。**函数体永不触碰** —— 这是硬承诺，否则 `sync` 就成了会改坏用户代码的危险工具。
 *
 * 三处必须讲清楚的实现细节：
 *   1. **C 与 C# 的追加分支必须对称**：`SyncHeader`（C）与 `SyncCsSource`（C#）都要能处理
 *      "IR 里有、源码里还没有"的新信号。C# 侧历史上漏了这一支，症状是一个测试失败、
 *      另一个测试**空转通过**（幂等断言恒真，验证不到自己声称的性质）。
 *   2. **数组写法不同**：C 是 `T name[N]`，C# 是 `T[] name`。类型串若带着 C 的 `float[32]`
 *      直接写进 C# 会生成非法代码，所以要做 `[N] -> []`。
 *   3. **合并而非覆盖**：`MergeAnnotation` 保留本工具不管理的键（手写的 `xy`/`size`）与其原有顺序。
 */

using System.Text.RegularExpressions;

namespace DrawCode;

/// <summary>
/// IR → 源码。只动声明层：<c>/// @drawcode</c> 注解、声明本身、以及
/// <c>[Drawcode]</c>/<c>[Device]</c> 特性都是就地重写。函数体永不触碰。
/// </summary>
internal static class CodeGen
{
    private static readonly Regex SignalLineRe = new(
        @"^(?:(?:[A-Za-z_]\w*[\s\*]+)+?)(?<name>[A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;$",
        RegexOptions.Compiled);

    private static readonly Regex CTypeRe = new(@"^(?<base>.+?)(?<arr>\[[^\]]*\])?$", RegexOptions.Compiled);

    /// <summary>IR 的方向 → 写进 C 源码的**裸** <c>dir=</c> 值（不带引号）。</summary>
    private static readonly Dictionary<string, string> DirKey = new(StringComparer.Ordinal)
    {
        ["in"] = "in",
        ["out"] = "out",
        ["inout"] = "io",
    };

    private static readonly Dictionary<string, string> CsDir = new(StringComparer.Ordinal)
    {
        ["in"] = "In",
        ["out"] = "Out",
        ["inout"] = "Io",
    };

    private static readonly Regex CsAttrRe = new(@"^\s*\[\s*Drawcode\s*\(", RegexOptions.Compiled);

    private static readonly Regex CsFieldLineRe = new(
        @"^\s*(?:(?:public|private|internal|protected|static|readonly|const|volatile)\s+)*" +
        @"(?<ctype>[A-Za-z_][\w\.<>,\[\]\?]*)\s+(?<name>[A-Za-z_]\w*)\s*(?<init>=[^;]*)?;\s*$",
        RegexOptions.Compiled);

    private static readonly Regex CsArraySizeRe = new(@"\[\s*\d+\s*\]", RegexOptions.Compiled);

    /// <summary>
    /// 从图里接回来的信号可能没有类型（用户在节点上只写了个名字）。
    /// 这时落一个占位类型而不是留空 —— 留空会写出一条不是声明的 <c>g_unknown;</c>，
    /// 解析器读不回来，下一次 sync 就会把它当成新元素再追加一遍（不幂等）。
    /// </summary>
    private const string PlaceholderCType = "int";

    /// <summary>TODO 提示，<c>%s</c> 填占位类型名。</summary>
    private const string PlaceholderTodo = "/* drawcode: 未能从图里认出类型，暂用 %s —— 请改成实际类型 */";

    internal static (string Base, string Arr) SplitCType(string ctype)
    {
        var m = CTypeRe.Match(ctype.Trim());
        if (!m.Success)
        {
            return (ctype.Trim(), "");
        }

        return (m.Groups["base"].Value.Trim(), m.Groups["arr"].Success ? m.Groups["arr"].Value : "");
    }

    /// <summary><c>dir=in</c> 是**裸**枚举值，其余键都写成带引号的字符串。</summary>
    private static string KvText(IEnumerable<(string Key, string Value)> pairs) =>
        string.Join(" ", pairs.Select(p => p.Key == "dir"
            ? p.Key + "=" + p.Value
            : p.Key + "=\"" + p.Value + "\""));

    private static string RenderAnnotation(Signal sig)
    {
        var kv = new List<(string, string)>();
        if (sig.Dir.Length > 0)
        {
            kv.Add(("dir", DirKey.GetValueOrDefault(sig.Dir, sig.Dir)));
        }

        if (sig.Unit.Length > 0)
        {
            kv.Add(("unit", sig.Unit));
        }

        if (sig.Alias.Length > 0)
        {
            kv.Add(("alias", sig.Alias));
        }

        if (sig.Note.Length > 0)
        {
            kv.Add(("note", sig.Note));
        }

        if (sig.External)
        {
            kv.Add(("external", "true"));
        }

        return kv.Count == 0 ? "" : "/// @drawcode " + KvText(kv);
    }

    /// <summary>
    /// 渲染「注解行 + 声明行」。无注解时只输出声明行（不留空注释）。
    ///
    /// 类型可能为空（元素是从图里接回来的，label 只写了名字）。这时**必须**落一个
    /// 真实类型名，不能只写标识符本身：
    ///
    ///   1. 文件作用域的 <c>g_unknown;</c> 不是声明，不是合法 C；
    ///   2. 解析器要求 <c>&lt;type&gt; &lt;name&gt;;</c>，只写名字就读不回来 —— 下一次 sync 会把
    ///      它当成「图里新加的元素」再追加一遍，于是 sync 不幂等。
    ///
    /// TODO 放在**单独一行**（不是行尾），否则 SignalRe 的 <c>;$</c> 就匹配不上。
    /// </summary>
    internal static string RenderSignal(Signal sig)
    {
        var (baseRaw, arr) = SplitCType(sig.CType);
        var untyped = baseRaw.Length == 0;
        var baseType = untyped ? PlaceholderCType : baseRaw;
        var line = (baseType + " " + sig.Name + arr).Trim() + ";";
        var ann = RenderAnnotation(sig);
        var body = ann.Length > 0 ? ann + "\n" + line : line;
        return untyped ? PlaceholderTodo.Replace("%s", baseType) + "\n" + body : body;
    }

    /// <summary>
    /// 为一个只有图形、没有源码的函数生成「签名 + 空实现」。
    ///
    /// 带空实现是刻意的：只给声明的话 C 侧能编译、链接时才报未定义符号，
    /// 错误暴露得太晚；空实现让产物立刻可编译，缺口以注释形式留在原地。
    /// </summary>
    internal static string RenderFuncSkeleton(Func f)
    {
        var ret = f.Ret.Length == 0 ? "void" : f.Ret;
        var parameters = f.Params.Count > 0
            ? string.Join(", ", f.Params.Select(p => p.CType.Length == 0 ? p.Name : p.CType + " " + p.Name))
            : "void";
        return ret + " " + f.Name + "(" + parameters + ")\n{\n    /* TODO: drawcode 从图里新建，尚未实现 */\n}";
    }

    private static List<(string, string)> RenderFuncKv(Func func)
    {
        var kv = new List<(string, string)>();
        if (func.Alias.Length > 0)
        {
            kv.Add(("alias", func.Alias));
        }

        if (func.Tooltip.Length > 0)
        {
            kv.Add(("tooltip", func.Tooltip));
        }

        if (func.Note.Length > 0)
        {
            kv.Add(("note", func.Note));
        }

        if (func.External)
        {
            kv.Add(("external", "true"));
        }

        return kv;
    }

    private static List<(string, string)> RenderDeviceKv(Device? dev)
    {
        if (dev is null)
        {
            return [];
        }

        var pairs = new List<(string, string)>
        {
            ("vendor", dev.Vendor),
            ("model", dev.Model),
            ("spec", dev.Spec),
            ("size", dev.Size),
            ("asset", dev.Asset),
        };
        return pairs.Where(p => p.Item2.Length > 0).ToList();
    }

    /// <summary>保留本工具不管理的键（如手写的 <c>xy</c>/<c>size</c>）及其原有顺序。</summary>
    private static string MergeAnnotation(string? origLine, List<(string, string)> kvNew)
    {
        var newd = kvNew.ToDictionary(p => p.Item1, p => p.Item2, StringComparer.Ordinal);
        var output = new List<(string, string)>();
        var used = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (k, v) in CParse.KvPairs(origLine ?? ""))
        {
            if (newd.TryGetValue(k, out var nv))
            {
                output.Add((k, nv));
                used.Add(k);
            }
            else
            {
                output.Add((k, v));
            }
        }

        foreach (var (k, v) in kvNew)
        {
            if (!used.Contains(k))
            {
                output.Add((k, v));
            }
        }

        return "/// @drawcode " + KvText(output);
    }

    private static List<string> FuncBlock(Func func, Device? dev, IReadOnlyList<string> orig)
    {
        var kv = RenderFuncKv(func);
        var devKv = RenderDeviceKv(dev);
        var origAnnotation = orig.FirstOrDefault(l => l.TrimStart().StartsWith("/// @drawcode", StringComparison.Ordinal));
        var output = new List<string>();
        if (kv.Count > 0 || origAnnotation is not null)
        {
            output.Add(origAnnotation is not null
                ? MergeAnnotation(origAnnotation, kv)
                : "/// @drawcode " + KvText(kv));
        }

        if (devKv.Count > 0)
        {
            output.Add("/// @device " + KvText(devKv));
        }

        output.AddRange(orig.Where(l =>
            !l.TrimStart().StartsWith("/// @drawcode", StringComparison.Ordinal) &&
            !l.TrimStart().StartsWith("/// @device", StringComparison.Ordinal)));
        return output;
    }

    private static bool SyncFunctions(string path, Model model, string rel)
    {
        var text = Text.ReadSource(path);
        var lines = Text.SplitLines(text);
        var funcs = new Dictionary<string, Func>(StringComparer.Ordinal);
        foreach (var f in model.Funcs.Values)
        {
            if (f.File == rel)
            {
                funcs[f.Name] = f;
            }
        }

        if (funcs.Count == 0)
        {
            return false;
        }

        var spans = new List<(int Start, int End, string Name)>();
        for (var i = 0; i < lines.Length; i++)
        {
            var m = CParse.FuncRe.Match(lines[i].Trim());
            if (!m.Success || !funcs.ContainsKey(m.Groups["name"].Value))
            {
                continue;
            }

            var j = i - 1;
            while (j >= 0 && lines[j].Trim().StartsWith("///", StringComparison.Ordinal))
            {
                j--;
            }

            spans.Add((j + 1, i, m.Groups["name"].Value));
        }

        var newLines = new List<string>(lines);
        spans.Reverse();
        foreach (var (start, end, name) in spans)
        {
            var f = funcs[name];
            var block = newLines.GetRange(start, end - start);
            var rendered = FuncBlock(f, model.Devices.GetValueOrDefault(f.Id), block);
            if (!block.SequenceEqual(rendered, StringComparer.Ordinal))
            {
                newLines.RemoveRange(start, end - start);
                newLines.InsertRange(start, rendered);
            }
        }

        // 图里有、源码里还没有的函数 —— 这正是「用户在 draw.io 里新加了一个函数节点」
        // 的情形（见 Adopt.cs）。追加到文件末尾，并带上空实现骨架，使产物仍能编译过：
        // 只给声明的话，C 侧能编译但链接会报未定义符号。
        var known = new HashSet<string>(spans.Select(s => s.Name), StringComparer.Ordinal);
        var missing = funcs.Values
            .Where(f => !known.Contains(f.Name))
            .OrderBy(f => f.Name, StringComparer.Ordinal)
            .ToList();
        if (missing.Count > 0)
        {
            var add = new List<string>();
            foreach (var f in missing)
            {
                var kv = RenderFuncKv(f);
                if (kv.Count > 0)
                {
                    add.Add("/// @drawcode " + KvText(kv));
                }

                var devKv = RenderDeviceKv(model.Devices.GetValueOrDefault(f.Id));
                if (devKv.Count > 0)
                {
                    add.Add("/// @device " + string.Join(" ", devKv.Select(p => p.Item1 + "=\"" + p.Item2 + "\"")));
                }

                add.Add(RenderFuncSkeleton(f));
                add.Add("");
            }

            while (newLines.Count > 0 && newLines[^1].Trim().Length == 0)
            {
                newLines.RemoveAt(newLines.Count - 1);
            }

            newLines.Add("");
            newLines.AddRange(add);
        }

        if (newLines.SequenceEqual(lines, StringComparer.Ordinal))
        {
            return false;
        }

        var result = string.Join("\n", newLines);
        if (text.EndsWith('\n'))
        {
            result += "\n";
        }

        Text.WriteText(path, result);
        return true;
    }

    /// <summary>按语言分派回写；C 与 C# 的声明语法绝不能互相套用。</summary>
    public static bool SyncSource(string path, Model model, string rel)
    {
        if (path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
        {
            return SyncCsSource(path, model, rel);
        }

        var touched = SyncHeader(path, model, rel);
        return SyncFunctions(path, model, rel) || touched;
    }

    /// <summary>属性名用 PascalCase；方向是位置参数。</summary>
    private static readonly Dictionary<string, string> CsProp = new(StringComparer.Ordinal)
    {
        ["unit"] = "Unit",
        ["alias"] = "Alias",
        ["note"] = "Note",
        ["external"] = "External",
    };

    private static List<string> RenderCsAnnotation(Signal sig)
    {
        var parts = new List<string>();
        if (sig.Dir.Length > 0)
        {
            parts.Add("Direction." + CsDir.GetValueOrDefault(sig.Dir, "None"));
        }

        var kv = new List<(string, string)>();
        if (sig.Unit.Length > 0)
        {
            kv.Add(("unit", sig.Unit));
        }

        if (sig.Alias.Length > 0)
        {
            kv.Add(("alias", sig.Alias));
        }

        if (sig.Note.Length > 0)
        {
            kv.Add(("note", sig.Note));
        }

        if (sig.External)
        {
            kv.Add(("external", "true"));
        }

        parts.AddRange(kv.Select(p => CsProp[p.Item1] + " = \"" + p.Item2 + "\""));
        return parts.Count == 0 ? [] : ["[Drawcode(" + string.Join(", ", parts) + ")]"];
    }

    /// <summary>对等 Python 的负索引语义：<c>lines[-1]</c> 指最后一行。</summary>
    private static string AtLine(IReadOnlyList<string> lines, int idx) =>
        idx >= 0 ? lines[idx] : lines[lines.Count + idx];

    private static bool SyncCsSource(string path, Model model, string rel)
    {
        var text = Text.ReadSource(path);
        var lines = Text.SplitLines(text);
        var wanted = new Dictionary<string, Signal>(StringComparer.Ordinal);
        foreach (var s in model.Signals.Values)
        {
            if (s.File == rel)
            {
                wanted[s.Name] = s;
            }
        }

        var spans = new List<(int Start, int Head, int? AttrIdx, int FieldIdx, string Name)>();
        for (var i = 0; i < lines.Length; i++)
        {
            var m = CsFieldLineRe.Match(lines[i]);
            if (!m.Success || !wanted.ContainsKey(m.Groups["name"].Value))
            {
                continue;
            }

            int? attrIdx = CsAttrRe.IsMatch(AtLine(lines, i - 1)) ? i - 1 : null;
            var head = attrIdx ?? i;
            var j = head - 1;
            while (j >= 0 && lines[j].Trim().StartsWith("///", StringComparison.Ordinal))
            {
                j--;
            }

            spans.Add((j + 1, head, attrIdx, i, m.Groups["name"].Value));
        }

        var newLines = new List<string>(lines);
        spans.Reverse();
        foreach (var (start, head, attrIdx, fieldIdx, name) in spans)
        {
            var sig = wanted[name];
            var reference = start < head ? lines[start] : lines[fieldIdx];
            var indent = reference[..(reference.Length - reference.TrimStart().Length)];
            var rendered = RenderCsAnnotation(sig).Select(l => indent + l).ToList();

            // 新语法下特性行本身就是注解；不存在时插入一行。
            var end = attrIdx is not null ? head : head - 1;
            var count = end - start + 1;
            var block = count > 0 ? lines.Skip(start).Take(count).ToList() : [];
            if (!block.SequenceEqual(rendered, StringComparer.Ordinal))
            {
                if (count > 0)
                {
                    newLines.RemoveRange(start, count);
                }

                newLines.InsertRange(start, rendered);
            }
        }

        var known = new HashSet<string>(spans.Select(s => s.Name), StringComparer.Ordinal);
        var extra = wanted.Values.Where(s => !known.Contains(s.Name)).Select(s => s.Name).ToList();
        if (extra.Count > 0)
        {
            int? anchor = null;
            for (var i = 0; i < newLines.Count; i++)
            {
                if (CsFieldLineRe.IsMatch(newLines[i]) && i > 0 && CsAttrRe.IsMatch(newLines[i - 1]))
                {
                    anchor = i + 1;
                }
            }

            if (anchor is null)
            {
                for (var i = newLines.Count - 1; i >= 0; i--)
                {
                    if (newLines[i].Trim() == "}")
                    {
                        anchor = i;
                        break;
                    }
                }
            }

            anchor ??= newLines.Count;

            var indent = "        ";
            foreach (var line in newLines)
            {
                if (CsFieldLineRe.IsMatch(line))
                {
                    indent = line[..(line.Length - line.TrimStart().Length)];
                    break;
                }
            }

            extra.Sort(StringComparer.Ordinal);
            var add = new List<string>();
            foreach (var name in extra)
            {
                var sig = wanted[name];
                add.AddRange(RenderCsAnnotation(sig).Select(l => indent + l));
                add.Add(indent + "public static " + CsArraySizeRe.Replace(sig.CType, "[]") + " " + sig.Name + ";");
                add.Add("");
            }

            newLines.InsertRange(anchor.Value, add);
        }

        if (newLines.SequenceEqual(lines, StringComparer.Ordinal))
        {
            return false;
        }

        var result = string.Join("\n", newLines);
        if (text.EndsWith('\n'))
        {
            result += "\n";
        }

        Text.WriteText(path, result);
        return true;
    }

    private static List<(int Start, int End, string Name)> Blocks(IReadOnlyList<string> lines)
    {
        var output = new List<(int, int, string)>();
        for (var i = 0; i < lines.Count; i++)
        {
            var m = SignalLineRe.Match(lines[i]);
            if (!m.Success)
            {
                continue;
            }

            var j = i - 1;
            while (j >= 0 && lines[j].Trim().StartsWith("///", StringComparison.Ordinal))
            {
                j--;
            }

            output.Add((j + 1, i, m.Groups["name"].Value));
        }

        return output;
    }

    internal static bool SyncHeader(string path, Model model, string rel)
    {
        var text = Text.ReadSource(path);
        var lines = Text.SplitLines(text);
        var wanted = new Dictionary<string, Signal>(StringComparer.Ordinal);
        foreach (var s in model.Signals.Values)
        {
            if (s.File == rel)
            {
                wanted[s.Name] = s;
            }
        }

        var blocks = Blocks(lines);
        var newLines = new List<string>(lines);
        blocks.Reverse();
        foreach (var (start, end, name) in blocks)
        {
            if (!wanted.TryGetValue(name, out var sig))
            {
                continue;
            }

            var rendered = Text.SplitLines(RenderSignal(sig)).ToList();
            var current = newLines.GetRange(start, end - start + 1);
            if (!current.SequenceEqual(rendered, StringComparer.Ordinal))
            {
                newLines.RemoveRange(start, end - start + 1);
                newLines.InsertRange(start, rendered);
            }
        }

        var known = new HashSet<string>(blocks.Select(b => b.Name), StringComparer.Ordinal);
        var missing = wanted.Values.Where(s => !known.Contains(s.Name)).OrderBy(s => s.Name, StringComparer.Ordinal).ToList();
        if (missing.Count > 0)
        {
            var idx = newLines.Count;
            for (var i = newLines.Count - 1; i >= 0; i--)
            {
                if (newLines[i].Trim().StartsWith("#endif", StringComparison.Ordinal))
                {
                    idx = i;
                    break;
                }
            }

            var add = new List<string>();
            foreach (var s in missing)
            {
                add.AddRange(Text.SplitLines(RenderSignal(s)));
                add.Add("");
            }

            newLines.InsertRange(idx, add);
        }

        if (newLines.SequenceEqual(lines, StringComparer.Ordinal))
        {
            return false;
        }

        var result = string.Join("\n", newLines);
        if (text.EndsWith('\n'))
        {
            result += "\n";
        }

        Text.WriteText(path, result);
        return true;
    }
}
