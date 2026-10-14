/**
 * C 源 -> IR。对等 Python `cparse.py` 与 TypeScript `cparse.ts`。
 *
 * 注解语法（**已经没有宏、没有头文件了**）：
 *
 *     /// @drawcode dir=in unit="LSB" alias="原始采样值"
 *     int16_t g_raw;
 *
 * 两条容易踩的规则：
 *   1. **`dir` 是裸词，其余属性带引号**（`dir=in` vs `unit="LSB"`）。正则必须同时接受两种写法，
 *      只认带引号的版本会让**信号全部静默丢失**（signals 变空、不报任何错）。
 *   2. 连续的 `///` 累积进缓冲，遇到非注释非空行才交给下一个声明；**空行清空缓冲**。
 *
 * 边的来源是**函数体的 def/use 扫描**，不是注释。
 */

using System.Text.RegularExpressions;

namespace DrawCode;

/// <summary>
/// C → IR。方向来自 <c>/// @drawcode</c> 块里的 <c>dir=</c> 键，注解挂在一条普通声明上。
/// struct 类型保持单个节点；形参变成端口；局部变量不入图。
/// </summary>
internal static partial class CParse
{
    internal static readonly Dictionary<string, string> DirByKey = new(StringComparer.Ordinal)
    {
        ["in"] = "in",
        ["out"] = "out",
        ["io"] = "inout",
        ["inout"] = "inout",
    };

    private static readonly HashSet<string> Control = new(StringComparer.Ordinal)
    {
        "if", "for", "while", "switch", "return", "sizeof", "do", "else", "case",
        "defined", "static_assert", "catch", "typeof",
    };

    /// <summary>
    /// 信号 = 一条**顶层声明** + 它上方的 <c>/// @drawcode</c> 块。
    /// 数组后缀会并进 ctype，所以 <c>float g_coeff[32];</c> 记成 ctype <c>float[32]</c>、名字 <c>g_coeff</c>。
    /// </summary>
    internal static readonly Regex SignalRe = new(
        @"^(?<type>(?:[A-Za-z_]\w*[\s\*]+)+?)(?<name>[A-Za-z_]\w*)\s*(?<arr>\[[^\]]*\])?\s*;$",
        RegexOptions.Compiled);

    internal static readonly Regex FuncRe = new(
        @"^(?<ret>(?:[A-Za-z_]\w*[\s\*]+)+)(?<name>[A-Za-z_]\w*)\s*\((?<params>[^)]*)\)\s*(?<tail>[;{]?)\s*$",
        RegexOptions.Compiled);

    private static readonly Regex AssignRe = new(@"(?<![=!<>+\-*/%&|^])=(?!=)", RegexOptions.Compiled);
    private static readonly Regex CompoundRe = new(@"(?:\+|-|\*|/|%|&|\||\^|<<|>>)=", RegexOptions.Compiled);
    internal static readonly Regex IdentRe = new(@"[A-Za-z_]\w*", RegexOptions.Compiled);
    private static readonly Regex CallRe = new(@"([A-Za-z_]\w*)\s*\(", RegexOptions.Compiled);
    /// <summary>
    /// <c>key="value"</c> 与裸 <c>key=value</c> **两种都会出现**：元数据带引号，而
    /// <c>dir=in</c> 不带。两种都必须认。
    /// </summary>
    internal static readonly Regex KvRe = new(@"(\w+)\s*=\s*(?:""([^""]*)""|([^\s""]+))", RegexOptions.Compiled);
    private static readonly Regex BlockCommentRe = new(@"/\*.*?\*/", RegexOptions.Compiled | RegexOptions.Singleline);
    private static readonly Regex LineCommentRe = new(@"//[^\n]*", RegexOptions.Compiled);
    private static readonly Regex AnnotationTagRe = new(@"@(\w+)\s*(.*)$", RegexOptions.Compiled);
    private static readonly Regex ParamRe = new(@"^(?<ctype>.+?)\s*(?<name>[A-Za-z_]\w*)$", RegexOptions.Compiled);

    /// <summary>相对项目根的路径，一律用正斜杠。</summary>
    internal static string Rel(string path, string root) =>
        Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(path)).Replace('\\', '/');

    /// <summary>取出注解体里的 <c>key=value</c> 对，带引号与裸值都支持。</summary>
    internal static IEnumerable<(string Key, string Value)> KvPairs(string text)
    {
        foreach (Match m in KvRe.Matches(text))
        {
            yield return (m.Groups[1].Value, m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value);
        }
    }

    /// <summary>去掉目录与扩展名的文件名；容器的默认名字。</summary>
    internal static string Stem(string rel) => Path.GetFileNameWithoutExtension(rel);

    /// <summary>从声明上方的注解块里收集键值对（带引号与裸值都要认）。</summary>
    internal static (Dictionary<string, string> Meta, Dictionary<string, string> Device) ReadAnnotations(IReadOnlyList<string> buf)
    {
        var meta = new Dictionary<string, string>(StringComparer.Ordinal);
        var dev = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var raw in buf)
        {
            var trimmed = raw.TrimStart();
            var body = (trimmed.Length >= 3 ? trimmed[3..] : "").Trim();
            var m = AnnotationTagRe.Match(body);
            if (!m.Success)
            {
                continue;
            }

            var tag = m.Groups[1].Value;
            var rest = m.Groups[2].Value;
            var kv = KvPairs(rest).ToList();

            if (tag == "drawcode")
            {
                foreach (var (k, v) in kv)
                {
                    meta[k] = v;
                }
            }
            else if (tag == "device")
            {
                foreach (var (k, v) in kv)
                {
                    dev[k] = v;
                }
            }
        }

        return (meta, dev);
    }

    internal static List<Param> ParseParams(string text)
    {
        text = text.Trim();
        if (text.Length == 0 || text == "void")
        {
            return [];
        }

        var output = new List<Param>();
        foreach (var rawPart in text.Split(','))
        {
            var part = rawPart.Trim();
            var m = ParamRe.Match(part);
            if (m.Success)
            {
                output.Add(new Param
                {
                    Name = m.Groups["name"].Value,
                    CType = m.Groups["ctype"].Value.Trim(),
                });
            }
        }

        return output;
    }

    internal static string StripComments(string text)
    {
        text = BlockCommentRe.Replace(text, " ");
        return LineCommentRe.Replace(text, " ");
    }

    /// <summary>从 .c 风格的行列表里抽出 <c>函数名 → 函数体文本</c>。</summary>
    internal static Dictionary<string, string> Bodies(IReadOnlyList<string> lines)
    {
        var bodies = new Dictionary<string, string>(StringComparer.Ordinal);
        var i = 0;
        while (i < lines.Count)
        {
            var m = FuncRe.Match(lines[i].Trim());
            if (m.Success && !Control.Contains(m.Groups["name"].Value))
            {
                var j = i;
                while (j < lines.Count && !lines[j].Contains('{') && j - i <= 2)
                {
                    j++;
                }

                if (j < lines.Count && lines[j].Contains('{'))
                {
                    var depth = 0;
                    var chunk = new List<string>();
                    var k = j;
                    while (k < lines.Count)
                    {
                        depth += CountChar(lines[k], '{') - CountChar(lines[k], '}');
                        chunk.Add(lines[k]);
                        if (depth == 0)
                        {
                            break;
                        }

                        k++;
                    }

                    bodies[m.Groups["name"].Value] = string.Join("\n", chunk);
                    i = k + 1;
                    continue;
                }
            }

            i++;
        }

        return bodies;
    }

    /// <summary>语句级 def/use 扫描。**产出边的是它，不是注释。**</summary>
    internal static (List<string> Reads, List<string> Writes, List<string> Calls) DefUse(
        string body,
        IReadOnlyDictionary<string, string> signalsByName,
        IReadOnlyDictionary<string, string> funcsByName)
    {
        body = StripComments(body);
        var reads = new HashSet<string>(StringComparer.Ordinal);
        var writes = new HashSet<string>(StringComparer.Ordinal);
        var calls = new HashSet<string>(StringComparer.Ordinal);

        foreach (var rawStmt in Regex.Split(body, "[;{}]"))
        {
            var stmt = rawStmt.Trim();
            if (stmt.Length == 0)
            {
                continue;
            }

            foreach (Match call in CallRe.Matches(stmt))
            {
                var name = call.Groups[1].Value;
                if (Control.Contains(name))
                {
                    continue;
                }

                if (funcsByName.TryGetValue(name, out var fid))
                {
                    calls.Add(fid);
                }
            }

            var comp = CompoundRe.Match(stmt);
            var simple = AssignRe.Match(stmt);
            if (comp.Success)
            {
                AddIdents(reads, stmt[..comp.Index]);
                AddIdents(writes, stmt[..comp.Index]);
                AddIdents(reads, stmt[(comp.Index + comp.Length)..]);
            }
            else if (simple.Success)
            {
                AddIdents(writes, stmt[..simple.Index]);
                AddIdents(reads, stmt[(simple.Index + simple.Length)..]);
            }
            else
            {
                AddIdents(reads, stmt);
            }
        }

        var rd = new List<string>();
        foreach (var n in reads)
        {
            if (signalsByName.TryGetValue(n, out var sid))
            {
                rd.Add(sid);
            }
        }

        var wr = new List<string>();
        foreach (var n in writes)
        {
            if (signalsByName.TryGetValue(n, out var sid))
            {
                wr.Add(sid);
            }
        }

        rd.Sort(StringComparer.Ordinal);
        wr.Sort(StringComparer.Ordinal);
        var cl = new List<string>(calls);
        cl.Sort(StringComparer.Ordinal);
        return (rd, wr, cl);
    }

    public static Model ParseProject(IReadOnlyList<string> paths, string? root = null)
    {
        root ??= Path.GetDirectoryName(Path.GetFullPath(paths[0])) ?? ".";
        var loaded = new List<(string Rel, string[] Lines)>();
        foreach (var p in paths)
        {
            var rel = Rel(p, root);
            loaded.Add((rel, Text.SplitLines(Text.ReadSource(p))));
        }

        var model = new Model { Files = [.. loaded.Select(l => l.Rel)] };

        var rawSignals = new List<(string Rel, int Line, string Dir, string CType, string Name, Dictionary<string, string> Meta)>();
        var rawFuncs = new Dictionary<string, FuncInfo>(StringComparer.Ordinal);

        foreach (var (rel, lines) in loaded)
        {
            var buf = new List<string>();
            for (var idx = 0; idx < lines.Length; idx++)
            {
                var lineno = idx + 1;
                var raw = lines[idx];
                var s = raw.Trim();
                if (s.StartsWith("///", StringComparison.Ordinal))
                {
                    buf.Add(raw);
                    continue;
                }

                if (s.Length == 0)
                {
                    buf.Clear();
                    continue;
                }

                var (meta, dev) = ReadAnnotations(buf);
                buf.Clear();

                var ms = SignalRe.Match(s);
                if (ms.Success && meta.Count > 0)
                {
                    var dir = DirByKey.GetValueOrDefault(meta.GetValueOrDefault("dir", ""), "");
                    var ctype = ms.Groups["type"].Value.Trim() +
                                (ms.Groups["arr"].Success ? ms.Groups["arr"].Value : "");
                    rawSignals.Add((rel, lineno, dir, ctype, ms.Groups["name"].Value, meta));
                    continue;
                }

                var mf = FuncRe.Match(s);
                if (mf.Success && !Control.Contains(mf.Groups["name"].Value))
                {
                    var name = mf.Groups["name"].Value;
                    if (!rawFuncs.TryGetValue(name, out var info))
                    {
                        info = new FuncInfo();
                        rawFuncs[name] = info;
                    }

                    var isHeader = rel.EndsWith(".h", StringComparison.Ordinal);
                    var entries = new (string Key, object? Val)[]
                    {
                        ("rel", rel),
                        ("line", lineno),
                        ("ret", mf.Groups["ret"].Value.Trim()),
                        ("params", ParseParams(mf.Groups["params"].Value)),
                        ("meta", meta),
                        ("device", dev),
                    };
                    foreach (var (key, val) in entries)
                    {
                        if (key == "params" && info.Params.Count > 0)
                        {
                            continue;
                        }

                        if (IsEmptyValue(val) && info.Has(key))
                        {
                            continue;
                        }

                        if (!info.Has(key) || isHeader)
                        {
                            info.Set(key, val);
                        }
                    }
                }
            }
        }

        foreach (var (rel, lineno, direction, ctype, name, meta) in rawSignals)
        {
            model.AddSignal(new Signal
            {
                Id = rel + "::" + name,
                Name = name,
                CType = ctype,
                Dir = direction,
                File = rel,
                Line = lineno,
                Unit = meta.GetValueOrDefault("unit", ""),
                Alias = meta.GetValueOrDefault("alias", ""),
                Note = meta.GetValueOrDefault("note", ""),
                External = meta.GetValueOrDefault("external", "") == "true",
                Group = Stem(rel),
            });
        }

        var signalsByName = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var s in model.Signals.Values)
        {
            signalsByName[s.Name] = s.Id;
        }

        var funcsByName = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (name, info) in rawFuncs)
        {
            var fid = info.Rel + "::" + name;
            funcsByName[name] = fid;
            var meta = info.Meta;
            model.AddFunc(new Func
            {
                Id = fid,
                Name = name,
                Ret = info.Ret,
                Params = info.Params,
                File = info.Rel,
                Line = info.Line,
                Alias = meta.GetValueOrDefault("alias", ""),
                Note = meta.GetValueOrDefault("note", ""),
                Tooltip = meta.GetValueOrDefault("tooltip", ""),
                Asset = meta.GetValueOrDefault("asset", ""),
                External = meta.GetValueOrDefault("external", "") == "true",
                Group = Stem(info.Rel),
            });

            var xy = meta.GetValueOrDefault("xy");
            if (xy is not null)
            {
                var parts = xy.Split(',').Select(v => double.Parse(v, System.Globalization.CultureInfo.InvariantCulture)).ToArray();
                model.Funcs[fid].X = parts[0];
                model.Funcs[fid].Y = parts[1];
            }

            var size = meta.GetValueOrDefault("size");
            if (size is not null)
            {
                var parts = size.ToLowerInvariant().Split('x').Select(v => double.Parse(v, System.Globalization.CultureInfo.InvariantCulture)).ToArray();
                model.Funcs[fid].W = parts[0];
                model.Funcs[fid].H = parts[1];
            }

            var dev = info.Device;
            if (dev.Count > 0)
            {
                model.Devices[fid] = new Device
                {
                    Vendor = dev.GetValueOrDefault("vendor", ""),
                    Model = dev.GetValueOrDefault("model", ""),
                    Spec = dev.GetValueOrDefault("spec", ""),
                    Size = dev.GetValueOrDefault("size", ""),
                    Asset = dev.GetValueOrDefault("asset", ""),
                };
                if (model.Funcs[fid].Asset.Length == 0)
                {
                    model.Funcs[fid].Asset = dev.GetValueOrDefault("asset", "");
                }
            }
        }

        foreach (var (rel, lines) in loaded)
        {
            if (!rel.EndsWith(".c", StringComparison.Ordinal) && !rel.EndsWith(".cpp", StringComparison.Ordinal))
            {
                continue;
            }

            foreach (var (name, body) in Bodies(lines))
            {
                if (!funcsByName.TryGetValue(name, out var fid))
                {
                    continue;
                }

                var (rd, wr, cl) = DefUse(body, signalsByName, funcsByName);
                var f = model.Funcs[fid];
                f.Reads = rd;
                f.Writes = wr;
                f.Calls = cl;
            }
        }

        model.RebuildEdges();
        return model;
    }

    private static void AddIdents(HashSet<string> into, string text)
    {
        foreach (Match m in IdentRe.Matches(text))
        {
            into.Add(m.Value);
        }
    }

    internal static int CountChar(string s, char c)
    {
        var n = 0;
        foreach (var ch in s)
        {
            if (ch == c)
            {
                n++;
            }
        }

        return n;
    }

    /// <summary>对等 Python 的 <c>val in ("", None, {}, [])</c>，用于 .h/.c 的声明合并。</summary>
    internal static bool IsEmptyValue(object? v) => v switch
    {
        null => true,
        string s => s.Length == 0,
        System.Collections.ICollection c => c.Count == 0,
        _ => false,
    };

    /// <summary>记录出现过的键 —— 合并规则看的是"键在不在"，而不是"值空不空"。</summary>
    private sealed class FuncInfo
    {
        private readonly HashSet<string> _seen = new(StringComparer.Ordinal) { "params" };

        public string Rel { get; private set; } = "";
        public int Line { get; private set; }
        public string Ret { get; private set; } = "void";
        public List<Param> Params { get; private set; } = [];
        public Dictionary<string, string> Meta { get; private set; } = new(StringComparer.Ordinal);
        public Dictionary<string, string> Device { get; private set; } = new(StringComparer.Ordinal);

        public bool Has(string key) => _seen.Contains(key);

        public void Set(string key, object? val)
        {
            _seen.Add(key);
            switch (key)
            {
                case "rel": Rel = (string)val!; break;
                case "line": Line = (int)val!; break;
                case "ret": Ret = (string)val!; break;
                case "params": Params = (List<Param>)val!; break;
                case "meta": Meta = (Dictionary<string, string>)val!; break;
                case "device": Device = (Dictionary<string, string>)val!; break;
                default: throw new ArgumentOutOfRangeException(nameof(key), key, "unknown func key");
            }
        }
    }
}
