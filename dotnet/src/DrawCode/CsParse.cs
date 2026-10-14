/**
 * C# 源 -> IR。对等 Python `csparse.py` 与 TypeScript `csparse.ts`。
 *
 * 注解语法是**真特性**（不是注释）：
 *
 *     [Drawcode(Direction.In, Unit = "LSB", Alias = "原始采样值")]
 *     [Device(Vendor = "TI", Model = "ADS1115", Spec = "16bit/860SPS")]
 *     public static short g_raw;
 *
 * 与 C 侧的差异，以及它们**为什么是刻意的**：
 *   - 方向是**位置参数**（`Direction.In`）而不是 `dir=` 键 —— 位置参数能让编辑器补全 `Direction.`。
 *   - `Direction.None` 或缺省参数**不构成信号**（当作函数或纯文档）；而 C 侧无 `dir` 键时
 *     IR 的 `dir` 是**空串**。这个不对称必须原样保留，三版都如此。
 *   - **没有节点几何键**：`xy` 与节点 `size` 都只有 C 侧支持。别与 `[Device]` 上的 `size`
 *     混淆 —— 那是器件物理封装尺寸，是两侧都读的**另一个同名键**。
 */

using System.Text.RegularExpressions;

namespace DrawCode;

/// <summary>
/// C# → IR。与 C 侧同一个 IR，只是表层语法不同：
/// <c>[Drawcode(Direction.X, Unit = "…")]</c> 与 <c>[Device(Vendor = "…")]</c> 特性。
/// </summary>
internal static class CsParse
{
    private static readonly Dictionary<string, string> Dirs = new(StringComparer.Ordinal)
    {
        ["In"] = "in",
        ["Out"] = "out",
        ["Io"] = "inout",
        ["InOut"] = "inout",
    };

    private const string Modifiers =
        "public|private|internal|protected|static|readonly|const|volatile|" +
        "virtual|override|abstract|sealed|async|extern|unsafe|new|partial";

    /// <summary>特性名 → 注解键，<c>[Drawcode]</c> 与 <c>[Device]</c> 共用。</summary>
    private static readonly Dictionary<string, string> AttrKey = new(StringComparer.Ordinal)
    {
        ["Unit"] = "unit",
        ["Alias"] = "alias",
        ["Note"] = "note",
        ["Tooltip"] = "tooltip",
        ["External"] = "external",
        ["Asset"] = "asset",
        ["Vendor"] = "vendor",
        ["Model"] = "model",
        ["Spec"] = "spec",
        ["Size"] = "size",
    };

    internal static readonly Regex DrawcodeAttrRe = new(@"\[\s*Drawcode\s*\(([^)]*)\)\s*\]", RegexOptions.Compiled);
    internal static readonly Regex DeviceAttrRe = new(@"\[\s*Device\s*\(([^)]*)\)\s*\]", RegexOptions.Compiled);
    private static readonly Regex DirectionArgRe = new(@"Direction\s*\.\s*(\w+)", RegexOptions.Compiled);
    private static readonly Regex NamedArgRe = new(@"(\w+)\s*=\s*(?:""([^""]*)""|(true|false))", RegexOptions.Compiled);

    internal static readonly Regex FieldRe = new(
        @"^\s*(?:(?:" + Modifiers + @")\s+)*(?<ctype>[A-Za-z_][\w\.<>,\[\]\?]*)\s+" +
        @"(?<name>[A-Za-z_]\w*)\s*(?:=[^;]*)?;\s*$",
        RegexOptions.Compiled);

    internal static readonly Regex CsFuncRe = new(
        @"^\s*(?:(?:" + Modifiers + @")\s+)*(?<ret>[A-Za-z_][\w\.<>,\[\]\?]*)\s+" +
        @"(?<name>[A-Za-z_]\w*)\s*\((?<params>[^)]*)\)\s*\{?\s*$",
        RegexOptions.Compiled);

    private static readonly string[] SkipPrefix = ["using ", "namespace ", "#"];

    /// <summary>
    /// 读取声明上方的特性块。方向来自 <c>[Drawcode(Direction.X)]</c> 的**位置参数**；
    /// 每个具名参数按 <see cref="AttrKey"/> 映射回注解键。
    /// </summary>
    internal static (Dictionary<string, string> Meta, Dictionary<string, string> Device, string? Dir) ReadMeta(
        IReadOnlyList<string> buf)
    {
        var meta = new Dictionary<string, string>(StringComparer.Ordinal);
        var dev = new Dictionary<string, string>(StringComparer.Ordinal);
        string? dir = null;
        foreach (var raw in buf)
        {
            var m = DrawcodeAttrRe.Match(raw);
            if (m.Success)
            {
                var body = m.Groups[1].Value;
                var d = DirectionArgRe.Match(body);
                if (d.Success && Dirs.TryGetValue(d.Groups[1].Value, out var dv))
                {
                    dir = dv;
                }

                foreach (Match arg in NamedArgRe.Matches(body))
                {
                    if (AttrKey.TryGetValue(arg.Groups[1].Value, out var key))
                    {
                        meta[key] = arg.Groups[2].Success ? arg.Groups[2].Value : arg.Groups[3].Value;
                    }
                }

                continue;
            }

            m = DeviceAttrRe.Match(raw);
            if (m.Success)
            {
                foreach (Match arg in NamedArgRe.Matches(m.Groups[1].Value))
                {
                    if (AttrKey.TryGetValue(arg.Groups[1].Value, out var key))
                    {
                        dev[key] = arg.Groups[2].Success ? arg.Groups[2].Value : arg.Groups[3].Value;
                    }
                }
            }
        }

        return (meta, dev, dir);
    }

    internal static Dictionary<string, string> Bodies(IReadOnlyList<string> lines)
    {
        var bodies = new Dictionary<string, string>(StringComparer.Ordinal);
        var i = 0;
        while (i < lines.Count)
        {
            var m = CsFuncRe.Match(lines[i].Trim());
            if (m.Success)
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
                        depth += CParse.CountChar(lines[k], '{') - CParse.CountChar(lines[k], '}');
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

    public static Model ParseCsProject(IReadOnlyList<string> paths, string? root = null)
    {
        root ??= Path.GetDirectoryName(Path.GetFullPath(paths[0])) ?? ".";
        var loaded = new List<(string Rel, string[] Lines)>();
        foreach (var p in paths)
        {
            var rel = CParse.Rel(p, root);
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
                if (s.StartsWith("///", StringComparison.Ordinal) || s.StartsWith('['))
                {
                    buf.Add(raw);
                    continue;
                }

                if (s.Length == 0)
                {
                    buf.Clear();
                    continue;
                }

                if (SkipPrefix.Any(p => s.StartsWith(p, StringComparison.Ordinal)) || s is "{" or "}" or "};")
                {
                    buf.Clear();
                    continue;
                }

                var (meta, dev, dir) = ReadMeta(buf);
                buf.Clear();

                var mf = FieldRe.Match(s);
                if (mf.Success && dir is not null)
                {
                    rawSignals.Add((rel, lineno, dir, mf.Groups["ctype"].Value, mf.Groups["name"].Value, meta));
                    continue;
                }

                var mfn = CsFuncRe.Match(s);
                if (mfn.Success)
                {
                    rawFuncs[mfn.Groups["name"].Value] = new FuncInfo
                    {
                        Rel = rel,
                        Line = lineno,
                        Ret = mfn.Groups["ret"].Value,
                        Params = CParse.ParseParams(mfn.Groups["params"].Value),
                        Meta = meta,
                        Device = dev,
                    };
                }
            }
        }

        foreach (var (rel, lineno, direction, ctype, name, meta) in rawSignals)
        {
            var cpath = CParse.ContainerPath(meta, rel);
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
                Group = CParse.TopGroup(cpath),
                Path = cpath,
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
            var fpath = CParse.ContainerPath(meta, info.Rel);
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
                Group = CParse.TopGroup(fpath),
                Path = fpath,
            });

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

        foreach (var (_, lines) in loaded)
        {
            foreach (var (name, body) in Bodies(lines))
            {
                if (!funcsByName.TryGetValue(name, out var fid))
                {
                    continue;
                }

                var (rd, wr, cl) = CParse.DefUse(body, signalsByName, funcsByName);
                var f = model.Funcs[fid];
                f.Reads = rd;
                f.Writes = wr;
                f.Calls = cl;
            }
        }

        model.RebuildEdges();
        return model;
    }

    private sealed class FuncInfo
    {
        public string Rel { get; init; } = "";
        public int Line { get; init; }
        public string Ret { get; init; } = "void";
        public List<Param> Params { get; init; } = [];
        public Dictionary<string, string> Meta { get; init; } = new(StringComparer.Ordinal);
        public Dictionary<string, string> Device { get; init; } = new(StringComparer.Ordinal);
    }
}
