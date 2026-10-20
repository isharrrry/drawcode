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
    // 标识符字符集必须是 Unicode：C# 编译器接受中文名字，`a5_采样值 = …` 与
    // `测试桩.处理(…)` 里的中文名都要能被 def/use 扫到，否则信号名中文化后所有边会
    // 静默消失。C 侧只用到其中的 ASCII 子集，行为不变。与 TS/Python 同义。
    internal static readonly Regex IdentRe = new(@"[\p{L}_][\p{L}\p{N}_]*", RegexOptions.Compiled);
    private static readonly Regex CallRe = new(@"([\p{L}_][\p{L}\p{N}_]*)\s*\(", RegexOptions.Compiled);
    /// <summary>
    /// <c>key="value"</c> 与裸 <c>key=value</c> **两种都会出现**：元数据带引号，而
    /// <c>dir=in</c> 不带。两种都必须认。
    /// </summary>
    internal static readonly Regex KvRe = new(@"(\w+)\s*=\s*(?:""([^""]*)""|([^\s""]+))", RegexOptions.Compiled);
    private static readonly Regex BlockCommentRe = new(@"/\*.*?\*/", RegexOptions.Compiled | RegexOptions.Singleline);
    private static readonly Regex LineCommentRe = new(@"//[^\n]*", RegexOptions.Compiled);
    private static readonly Regex AnnotationTagRe = new(@"@(\w+)\s*(.*)$", RegexOptions.Compiled);
    // 形参名同样要 Unicode：中文形参在 C# 侧完全合法，名字若只认 ASCII，
    // 整个形参会从端口表里消失（TS 的 PARAM_RE 早已是 Unicode）。
    private static readonly Regex ParamRe = new(@"^(?<ctype>.+?)\s*(?<name>[\p{L}_][\p{L}\p{N}_]*)$", RegexOptions.Compiled);
    private static readonly Regex HexNumberRe = new(@"^0[xX][0-9a-fA-F]+$", RegexOptions.Compiled);
    private static readonly Regex OctalNumberRe = new(@"^0[oO][0-7]+$", RegexOptions.Compiled);
    private static readonly Regex BinaryNumberRe = new(@"^0[bB][01]+$", RegexOptions.Compiled);
    // JS 的十进制字面量：允许 `1.` / `.5` / 指数；Infinity 区分大小写且可带符号。
    private static readonly Regex DecimalNumberRe = new(
        @"^[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$", RegexOptions.Compiled);

    /// <summary>
    /// 模拟 JavaScript 的 <c>Number()</c> —— 几何键的容差契约以它为准。
    ///
    /// 为什么不能直接用 <c>double.Parse</c>：三个实现在这几个病态输入上会得出不同
    /// 结果，而坐标一旦分叉，同一份源码在三种语言里就会排出三种图：
    ///
    ///   * <c>Number("1_0")</c> 是 NaN（JS 不认数字分隔符），而 .NET/Python 的
    ///     数字解析会忽略下划线或抛异常；
    ///   * <c>Number("infinity")</c> 是 NaN（只认大小写精确的 <c>Infinity</c>）；
    ///   * <c>Number("0x10")</c> 是 16，而 <c>double.Parse</c> 会抛异常。
    ///
    /// 畸形与缺失一律得到 NaN，**不抛异常**：TS 的 <c>applyGeometry</c> 从不校验，
    /// 下游自己承担。这里若抛异常，一份写错坐标的源码会让 .NET 版直接崩掉，而另外
    /// 两个版本照常出图 —— 那才是最难查的跨语言差异。
    /// </summary>
    internal static double JsNumber(string text)
    {
        var t = text.Trim();
        if (t.Length == 0)
        {
            return 0.0; // Number("") === 0，与 Number(" ") 相同
        }

        if (HexNumberRe.IsMatch(t))
        {
            return RadixToDouble(t[2..], 16);
        }

        if (OctalNumberRe.IsMatch(t))
        {
            return RadixToDouble(t[2..], 8);
        }

        if (BinaryNumberRe.IsMatch(t))
        {
            return RadixToDouble(t[2..], 2);
        }

        if (DecimalNumberRe.IsMatch(t))
        {
            // .NET Core 3.0+ 与 Python 的 float() 一样把超范围小数转成 ±Infinity，
            // 不抛异常 —— 与 Python 侧逐字一致。
            return double.Parse(t, System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture);
        }

        return double.NaN;
    }

    /// <summary>任意进制整数串转 double。超范围折回 NaN，与 Python 的
    /// <c>float(int(...))</c> 抛 OverflowError 后被吞掉的结果一致。</summary>
    private static double RadixToDouble(string digits, int radix)
    {
        var value = System.Numerics.BigInteger.Zero;
        foreach (var ch in digits)
        {
            var d = ch switch
            {
                >= '0' and <= '9' => ch - '0',
                >= 'a' and <= 'f' => ch - 'a' + 10,
                _ => ch - 'A' + 10,
            };
            value = value * radix + d;
        }

        try
        {
            var result = (double)value;
            return double.IsInfinity(result) ? double.NaN : result;
        }
        catch (OverflowException)
        {
            return double.NaN;
        }
    }

    /// <summary>
    /// 按分隔符切分并逐段转数字；**缺段补 NaN**，与 TS 的 <c>parts[1]</c> 一致。
    /// 例如 <c>"40"</c> 的 xy 在 TS 里得到 <c>x=40, y=undefined</c> —— 后续算术变 NaN。
    /// </summary>
    internal static double[] SplitNumbers(string value, char sep) =>
        value.Split(sep).Select(JsNumber).ToArray();

    /// <summary>
    /// 把 <c>xy</c> / <c>size</c> 套到实体上。**两个前端、两类实体共用这一个入口。**
    ///
    /// 容差与 TS 的 <c>applyGeometry</c> 逐字对齐：缺键或空串不动默认值；分隔符写错
    /// 不报错，只得到 NaN。<c>xy</c> 用逗号、<c>size</c> 用小写 <c>x</c> —— 写混会
    /// 静默得到 NaN 尺寸，这是契约的一部分（回写侧 codegen 按同样的切法生成字符串）。
    /// </summary>
    internal static void ApplyGeometry(INode ent, IReadOnlyDictionary<string, string> meta)
    {
        if (meta.TryGetValue("xy", out var xy) && xy.Length > 0)
        {
            var parts = SplitNumbers(xy, ',');
            ent.X = parts.Length > 0 ? parts[0] : double.NaN;
            ent.Y = parts.Length > 1 ? parts[1] : double.NaN;
        }

        if (meta.TryGetValue("size", out var size) && size.Length > 0)
        {
            var parts = SplitNumbers(size.ToLowerInvariant(), 'x');
            ent.W = parts.Length > 0 ? parts[0] : double.NaN;
            ent.H = parts.Length > 1 ? parts[1] : double.NaN;
        }
    }

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

    /// <summary>
    /// 容器的斜杠路径，例如 <c>adc/采样前端</c>。
    ///
    /// 标了 <c>path="adc/采样前端"</c> 就用它；没标则退回模块名（<c>adc.h</c> -&gt; <c>adc</c>）。
    /// 这样旧源码一个字不改也照常工作，而且下游拿到的 path <b>永远非空</b> ——
    /// 「没标」和「标成空」是同一种情况，不需要在别处再判一次。
    /// </summary>
    internal static string ContainerPath(Dictionary<string, string> meta, string rel)
    {
        var raw = meta.TryGetValue("path", out var v) ? v.Trim() : "";
        return raw.Trim('/') is { Length: > 0 } trimmed ? trimmed : Stem(rel);
    }

    /// <summary>path 的第一段，即最外层容器名。</summary>
    internal static string TopGroup(string path)
    {
        var i = path.IndexOf('/');
        return i < 0 ? path : path[..i];
    }

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
            var cpath = ContainerPath(meta, rel);
            var sig = new Signal
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
                Group = TopGroup(cpath),
                Path = cpath,
                Style = meta.GetValueOrDefault("style", ""),
            };
            // 与 TS 一致：信号的 xy/size 也读（旧版只对函数读，信号上的坐标被静默丢弃）
            ApplyGeometry(sig, meta);
            model.AddSignal(sig);
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
            var fpath = ContainerPath(meta, info.Rel);
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
                Group = TopGroup(fpath),
                Path = fpath,
                Style = meta.GetValueOrDefault("style", ""),
            });

            // 下面两个 size 是**同名但无关的两个键**，别合并：
            //   meta["size"] —— 节点几何尺寸 "180x72"（与信号共用 ApplyGeometry）
            //   dev["size"]  —— @device 的器件物理封装尺寸 "2.0x3.0mm"
            ApplyGeometry(model.Funcs[fid], meta);

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
