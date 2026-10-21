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
 *
 * **几何与样式**：`Xy`（`"x,y"`）、`Size`（`"宽x高"`）、`Style`（原样追加到节点样式串
 * 末尾）在 C 与 C# 两个前端、信号与函数两类实体上都读 —— 与 TS 实现一致。容差见
 * <see cref="CParse.ApplyGeometry"/>：缺键不动默认值、畸形得 NaN、不报错。别把这里的
 * `Size` 和 `[Device]` 上的 `Size` 搞混：后者是器件物理封装尺寸，同名但毫无关系。
 *
 * `[Callout("文本", Xy="…", Size="…", Style="text|box|band", Font=12)]` 是**独立的
 * 注释层**：一个声明可以挂多块说明文字，它们不参与连线、不进容器包围盒。
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
        // None 显式映射成空串而不是「查不到」：同一段特性里若先写 Direction.In、
        // 再写 Direction.None，Python 侧后写覆盖成 ""（不构成信号）；若这里查不到，
        // 就会把上一次的 in 留下来，两条声明在三种实现里判定不一致。
        ["None"] = "",
    };

    /// <summary>
    /// <c>[Drawcode]</c> 认的键（小写）。与 C 侧的「全收」不同：C# 是真 attribute，
    /// 键名由 DrawcodeAttributes.cs 定义。<c>Xy</c> / <c>Size</c> / <c>Style</c> 与 C 侧同名。
    /// </summary>
    private static readonly HashSet<string> MetaKey = new(StringComparer.Ordinal)
    {
        "unit", "alias", "note", "tooltip", "external", "asset", "path",
        "xy", "size", "style",
    };

    /// <summary>
    /// <c>[Callout]</c> 的键**刻意与 <see cref="MetaKey"/> 分开**：<c>Style</c> 在
    /// <c>[Drawcode]</c> 上是「追加到节点样式」，在 <c>[Callout]</c> 上是「文字块种类」，
    /// 同名不同义。
    /// </summary>
    private static readonly HashSet<string> CalloutKey = new(StringComparer.Ordinal)
    {
        "xy", "size", "style", "font",
    };

    private static readonly HashSet<string> CalloutShapes = new(StringComparer.Ordinal)
    {
        "text", "box", "band",
    };

    /// <summary>文本必须是第一个位置参数、用双引号括起（内部不能有双引号）。</summary>
    private static readonly Regex CalloutTextRe = new(
        @"^""([^""]*)""\s*(?:,\s*(.*))?$", RegexOptions.Compiled | RegexOptions.Singleline);

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

    /// <summary>
    /// 三种特性共用一个正则，与 TS 的 <c>ATTR_RE</c> 同形：贪婪的 <c>(.*)</c>、不跨行。
    /// 跨行属性在旧版里被容忍，但 TS/.NET 都按行解析；三版对同一输入的判定必须一致，
    /// 所以这里保持逐行语义。<c>[^)]*</c> 的旧写法既认不出 <c>[Callout("…")]</c>
    /// 里带括号的文本，也读不到裸词参数，必须换成贪婪版本。
    /// </summary>
    internal static readonly Regex AttrRe = new(
        @"\[\s*(Drawcode|Device|Callout)\s*\((.*)\)\s*\]", RegexOptions.Compiled);

    private static readonly Regex DirectionArgRe = new(@"Direction\s*\.\s*(\w+)", RegexOptions.Compiled);

    /// <summary>
    /// 命名参数：带引号值与裸词都认（<c>Style = "box"</c> 与 <c>External = true</c>、
    /// <c>Style = box</c> 三种写法）。旧版只认引号与 true/false，裸词会被静默丢弃。
    /// </summary>
    private static readonly Regex ArgRe = new(@"(\w+)\s*=\s*(?:""([^""]*)""|(\w+))", RegexOptions.Compiled);

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
    /// 每个具名参数按 <see cref="AttrKey"/> / <see cref="MetaKey"/> 映射回注解键。
    ///
    /// <c>[Callout]</c> 用**列表**而不是塞进 meta：一个声明挂两块文字是正常需求，
    /// 塞进字典会被后一条静默覆盖。
    /// </summary>
    internal static (Dictionary<string, string> Meta, Dictionary<string, string> Device,
        List<RawCallout> Callouts, string Dir) ReadMeta(IReadOnlyList<string> buf)
    {
        var meta = new Dictionary<string, string>(StringComparer.Ordinal);
        var dev = new Dictionary<string, string>(StringComparer.Ordinal);
        var callouts = new List<RawCallout>();
        var dir = "";
        foreach (var raw in buf)
        {
            var m = AttrRe.Match(raw);
            if (!m.Success)
            {
                continue;
            }

            var kind = m.Groups[1].Value;
            var body = m.Groups[2].Value;
            if (kind == "Callout")
            {
                callouts.Add(ParseCallout(body));
                continue;
            }

            if (kind == "Device")
            {
                foreach (var (key, val) in ParseArgs(body))
                {
                    if (AttrKey.TryGetValue(key, out var mapped))
                    {
                        dev[mapped] = val;
                    }
                }

                continue;
            }

            var d = DirectionArgRe.Match(body);
            if (d.Success)
            {
                // 查不到的 Direction 值（含拼错的枚举名）落空串 = 不构成信号，
                // 与 Python 的 DIRS.get(name, "") 一致。
                dir = Dirs.GetValueOrDefault(d.Groups[1].Value, "");
            }

            foreach (var (key, val) in ParseArgs(body))
            {
                // 属性名统一转小写，和 C 侧的 IR 键（unit/alias/note/…）对齐。
                var lower = key.ToLowerInvariant();
                if (MetaKey.Contains(lower))
                {
                    meta[lower] = val;
                }
            }
        }

        return (meta, dev, callouts, dir);
    }

    /// <summary>
    /// <c>Key = "value"</c> / <c>Key = bare</c> → <c>(原始键, 值)</c>，按出现顺序。
    /// 带引号时可含空格与逗号（<c>Xy = "40,40"</c> 不会再被切开，因为这里不切逗号，
    /// 只逐段找键值对）；裸词只收 <c>\w+</c>，与 TS 的 <c>ARG_RE</c> 同形。
    /// </summary>
    private static IEnumerable<(string Key, string Value)> ParseArgs(string body)
    {
        foreach (Match m in ArgRe.Matches(body))
        {
            yield return (m.Groups[1].Value, m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value);
        }
    }

    /// <summary>
    /// <c>[Callout("文本", ...)]</c> → 原始形态（还没挂到宿主实体上）。
    ///
    /// 默认值与 TS 的 <c>parseCallout</c> 逐字相同：<c>240x40</c> 的文字块、无边框、
    /// 字号 0（= 用种类默认值）。认不出的 <c>Style</c> 退回 <c>text</c>，而不是把原始串
    /// 当样式用 —— 后者会静默产出非法样式。<c>Font</c> 走 <c>Number(v) || 0</c>：
    /// 畸形与 0 都归 0。
    /// </summary>
    private static RawCallout ParseCallout(string body)
    {
        var result = new RawCallout();
        var text = body.Trim();
        var tm = CalloutTextRe.Match(text);
        var rest = text;
        if (tm.Success)
        {
            result.Text = tm.Groups[1].Value;
            rest = tm.Groups[2].Success ? tm.Groups[2].Value : "";
        }

        foreach (var (rawKey, val) in ParseArgs(rest))
        {
            var key = rawKey.ToLowerInvariant();
            if (!CalloutKey.Contains(key))
            {
                continue;
            }

            if (key == "style")
            {
                result.Shape = CalloutShapes.Contains(val) ? val : "text";
            }
            else if (key == "font")
            {
                var n = CParse.JsNumber(val);
                // JS 的 `Number(v) || 0`：NaN 与 0 都落 0，Infinity 保留。
                result.FontSize = double.IsNaN(n) ? 0.0 : n;
            }
            else if (key == "xy")
            {
                var parts = CParse.SplitNumbers(val, ',');
                result.X = parts.Length > 0 ? parts[0] : double.NaN;
                result.Y = parts.Length > 1 ? parts[1] : double.NaN;
            }
            else
            {
                // 走与节点几何同一套容差：size 用逗号会切不出一段而整串变 NaN，
                // 这是契约的一部分，不额外校验。
                var parts = CParse.SplitNumbers(val.ToLowerInvariant(), 'x');
                result.W = parts.Length > 0 ? parts[0] : double.NaN;
                result.H = parts.Length > 1 ? parts[1] : double.NaN;
            }
        }

        return result;
    }

    /// <summary>
    /// 把一条声明上的文字块挂进模型。
    ///
    /// 坐标是**画布绝对坐标** —— 文字块不属于任何容器（见 <see cref="Callout"/>），
    /// 所以这里不做任何容器偏移。id 形如 <c>owner#callout1</c>，从 1 开始。
    /// </summary>
    private static void AttachCallouts(Model model, string owner, IReadOnlyList<RawCallout> raws)
    {
        for (var i = 0; i < raws.Count; i++)
        {
            var raw = raws[i];
            model.AddCallout(new Callout
            {
                Id = owner + "#callout" + (i + 1),
                Text = raw.Text,
                Owner = owner,
                Shape = raw.Shape,
                FontSize = raw.FontSize,
                X = raw.X,
                Y = raw.Y,
                W = raw.W,
                H = raw.H,
            });
        }
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

    /// <summary>
    /// 方括号配平差值（引号内的 <c>[</c>/<c>]</c> 不计，<c>\\"</c> 跳过）。
    ///
    /// 与 TS 的 <c>bracketDelta</c>、Python 的 <c>_bracket_delta</c> 必须给出同一结果：
    /// 解析靠它判断「这一行是不是一条跨行特性的开头」。三条实现各写一份，
    /// 任何一份漏掉引号感知，就会在 <c>Tooltip = "a]b"</c> 上提前收尾。
    /// </summary>
    internal static int BracketDelta(string text)
    {
        var depth = 0;
        var inString = false;
        for (var i = 0; i < text.Length; i++)
        {
            var ch = text[i];
            if (inString)
            {
                if (ch == '\\')
                {
                    i++;
                }
                else if (ch == '"')
                {
                    inString = false;
                }
            }
            else if (ch == '"')
            {
                inString = true;
            }
            else if (ch == '[')
            {
                depth++;
            }
            else if (ch == ']')
            {
                depth--;
            }
        }

        return depth;
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
        var rawSignals = new List<(string Rel, int Line, string Dir, string CType, string Name,
            Dictionary<string, string> Meta, List<RawCallout> Callouts)>();
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

                if (s.StartsWith('['))
                {
                    // 跨行特性：括号未配平就把后续行拼成一条（与 TS 的 pendingAttr、
                    // Python 的同名分支同构）。参数一多，IDE 与作者都会换行：
                    //     [Drawcode(Direction.In, Unit = "LSB",
                    //         Note = "上电后需校准")]
                    // 只收「行首是 `[`」的那一行，第二行会被当声明行，特性认不出
                    // ⇒ 信号静默消失（C# 侧没有方向就不算信号）。
                    var attr = s;
                    while (BracketDelta(attr) > 0 && idx + 1 < lines.Length)
                    {
                        idx++;
                        attr += " " + lines[idx].Trim();
                    }

                    buf.Add(attr);
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
                //
                // 先确定记录声明在**哪一行结束**，再决定有没有记录体。不能一上来就找
                // `{`：主构造参数表会跨行，
                //     public sealed record DspConfig(
                //         [property: Drawcode(...)] float[] Coefficients,
                //         ...);
                // 这种「以 `);` 收尾、没有记录体」的声明后面紧邻的就是 class 的 `{`，
                // 按「找第一个 `{` 再配平」会把整个 DspModule 当成记录体吞掉 ——
                // 该文件所有信号与函数静默消失。
                if (RecordDeclRe.IsMatch(s))
                {
                    buf.Clear();
                    var j = idx;
                    var paren = 0;
                    var hasBody = false;
                    var ended = false;
                    for (; j < lines.Length && !ended && !hasBody; j++)
                    {
                        var line = lines[j];
                        var inString = false;
                        for (var k = 0; k < line.Length; k++)
                        {
                            var ch = line[k];
                            if (inString)
                            {
                                if (ch == '\\')
                                {
                                    k++;
                                }
                                else if (ch == '"')
                                {
                                    inString = false;
                                }
                            }
                            else if (ch == '"')
                            {
                                inString = true;
                            }
                            else if (ch == '(')
                            {
                                paren++;
                            }
                            else if (ch == ')')
                            {
                                paren--;
                            }
                            else if (paren == 0 && ch == ';')
                            {
                                ended = true;
                                break;
                            }
                            else if (paren == 0 && ch == '{')
                            {
                                hasBody = true;
                                break;
                            }
                        }
                    }

                    j--; // 回到终止行（for 的步进先加了 1）
                    if (hasBody)
                    {
                        var depth = CParse.CountChar(lines[j], '{') - CParse.CountChar(lines[j], '}');
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

                var (meta, dev, callouts, dir) = ReadMeta(buf);
                buf.Clear();

                var mf = FieldRe.Match(s);
                // 与 C 侧不同：这里要求**有方向**才算信号。只写 [Drawcode(Alias="…")]
                // 的纯文档性标注不会产出信号节点。空串 = 没写或写了 None。
                if (mf.Success && dir.Length > 0)
                {
                    rawSignals.Add((rel, lineno, dir, mf.Groups["ctype"].Value,
                        mf.Groups["name"].Value, meta, callouts));
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
                        Callouts = callouts,
                    };
                }
            }
        }

        foreach (var (rel, lineno, direction, ctype, name, meta, callouts) in rawSignals)
        {
            var cpath = CParse.ContainerPath(meta, rel);
            var sid = rel + "::" + name;
            var sig = new Signal
            {
                Id = sid,
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
                Style = meta.GetValueOrDefault("style", ""),
            };
            // Xy / Size：与 C 侧、TS 侧共用同一套容差（缺键不动默认值、畸形得 NaN）。
            CParse.ApplyGeometry(sig, meta);
            model.AddSignal(sig);
            AttachCallouts(model, sid, callouts);
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
                Style = meta.GetValueOrDefault("style", ""),
            });

            // 节点几何：Xy / Size（与信号共用 ApplyGeometry）。
            // 下面的 dev["size"] 是器件封装尺寸，同名但无关，别合并。
            CParse.ApplyGeometry(model.Funcs[fid], meta);
            AttachCallouts(model, fid, info.Callouts);
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
        public List<RawCallout> Callouts { get; init; } = [];
    }

    /// <summary>
    /// 还没挂到宿主实体上的文字块。默认值与 <see cref="Model"/> 的 <see cref="Callout"/>
    /// 不同是**故意的**：解析侧缺省 240x40（与 TS 的 parseCallout 一致），模型侧是
    /// 200x40（手动构造 IR 时的默认）。
    /// </summary>
    internal sealed class RawCallout
    {
        public string Text { get; set; } = "";
        public string Shape { get; set; } = "text";
        public double FontSize { get; set; }
        public double X { get; set; }
        public double Y { get; set; }
        public double W { get; set; } = 240;
        public double H { get; set; } = 40;
    }
}
