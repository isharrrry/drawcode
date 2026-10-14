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

    internal static string RenderSignal(Signal sig)
    {
        var (baseType, arr) = SplitCType(sig.CType);
        var line = baseType + " " + sig.Name + arr + ";";
        var ann = RenderAnnotation(sig);
        return ann.Length > 0 ? ann + "\n" + line : line;
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
