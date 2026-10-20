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
        // Path 是共享特性：Python 的解析器保留全部命名参数，所以一直支持；
        // TS/.NET 早先漏了这条白名单，导致同一份源码在两者里静默回退到文件 stem。
        ["Path"] = "path",
        ["Vendor"] = "vendor",
        ["Model"] = "model",
        ["Spec"] = "spec",
        ["Size"] = "size",
    };

    internal static readonly Regex DrawcodeAttrRe = new(@"\[\s*Drawcode\s*\(([^)]*)\)\s*\]", RegexOptions.Compiled);
    internal static readonly Regex DeviceAttrRe = new(@"\[\s*Device\s*\(([^)]*)\)\s*\]", RegexOptions.Compiled);
    private static readonly Regex DirectionArgRe = new(@"Direction\s*\.\s*(\w+)", RegexOptions.Compiled);
    private static readonly Regex NamedArgRe = new(@"(\w+)\s*=\s*(?:""([^""]*)""|(true|false))", RegexOptions.Compiled);

    /// <summary>
    /// C# 类型片段与名字的字符集：首字符是任意 Unicode 字母或下划线，后续是字母、数字、
    /// 下划线与类型语法里常见的 <c>. &lt; &gt; , [ ] ?</c>。
    ///
    /// 为什么不能用 <c>[A-Za-z_]</c>：本项目的部分关系字段类型是中文结构体
    /// （<c>数据包</c>），ASCII 正则会让整条声明**静默地**不被当成信号 ——
    /// 图上少一个节点，而且不报任何错。名字位置与类型位置必须是同一字符集：
    /// C# 编译器接受中文标识符，解析器没有理由只认 ASCII。
    ///
    /// 放宽名字后，原本靠「ASCII 看不见」挡在图外的两类声明必须显式处理：
    /// <list type="bullet">
    /// <item><c>record</c> 类型声明与记录体里的方法 → 由 <see cref="RecordDeclRe"/> 整段跳过；</item>
    /// <item>泛型桩方法（<c>产出&lt;T&gt;()</c>）→ 名字后跟 <c>&lt;</c> 而不是 <c>(</c>，天然不匹配。</item>
    /// </list>
    /// </summary>
    private const string Ident = @"[\p{L}_][\p{L}\p{N}_]*";
    private const string TypePattern = @"[\p{L}_][\p{L}\p{N}_\.<>,\[\]\?]*";

    internal static readonly Regex FieldRe = new(
        @"^\s*(?:(?:" + Modifiers + @")\s+)*(?<ctype>" + TypePattern + @")\s+" +
        @"(?<name>" + Ident + @")\s*(?:=[^;]*)?;\s*$",
        RegexOptions.Compiled);

    internal static readonly Regex CsFuncRe = new(
        @"^\s*(?:(?:" + Modifiers + @")\s+)*(?<ret>" + TypePattern + @")\s+" +
        @"(?<name>" + Ident + @")\s*\((?<params>[^)]*)\)\s*\{?\s*$",
        RegexOptions.Compiled);

    /// <summary>
    /// <c>record</c> 声明的开头。解析时必须**整段跳过**（与 TS/Python 同义）。
    ///
    /// 名字位置放开到 Unicode 之后，<c>public sealed record 采样帧(...)</c> 与普通
    /// 方法签名完全同形；记录体里的 <c>public 帧头 下一帧()</c> 也会变成组件函数。
    /// 数据类型文件（<c>示例数据结构.cs</c>）不是被测模型，整段跳过记录声明是唯一
    /// 不误伤设备类里真实方法的办法 —— 设备类用 <c>class</c>，不在这个正则里。
    ///
    /// 只跳过 <c>record</c>，不跳过 <c>class</c>：模型源文件本身就是
    /// <c>public static class 设备名</c>，连类一起跳会把整张图清空。
    /// </summary>
    private static readonly Regex RecordDeclRe = new(
        @"^\s*(?:(?:public|private|internal|protected|static|sealed|abstract|readonly|partial|unsafe|new)\s+)*record\b",
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

                // 数据类型文件里的记录声明不是组件：连同记录体里的方法一起跳过。
                // 一行到底（`...);` 或 `... { }`）直接跳过；带多行记录体的按花括号配平。
                //
                // depth 的起点取自**记录声明这一行**：`record 数据帧(帧头 头)` 本身
                // 没有花括号，于是先向后找到第一个含 `{` 的行（记录体的开括号），再从
                // 那里开始配平。for 循环继续时会 idx++，等价于 TS/Python 的 index=j+1。
                if (RecordDeclRe.IsMatch(s))
                {
                    buf.Clear();
                    var j = idx;
                    var depth = CParse.CountChar(raw, '{') - CParse.CountChar(raw, '}');
                    if (!raw.Contains('{') && !s.EndsWith(';'))
                    {
                        var k = j + 1;
                        while (k < lines.Length && !lines[k].Contains('{'))
                        {
                            k++;
                        }

                        if (k < lines.Length)
                        {
                            j = k;
                            depth = CParse.CountChar(lines[k], '{') - CParse.CountChar(lines[k], '}');
                        }
                    }

                    if (depth > 0)
                    {
                        var k = j + 1;
                        while (k < lines.Length && depth > 0)
                        {
                            depth += CParse.CountChar(lines[k], '{') - CParse.CountChar(lines[k], '}');
                            k++;
                        }

                        j = k - 1;
                    }

                    idx = j;
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
