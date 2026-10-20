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

    /// <summary>
    /// 合并既有 C 注解时扫键值对：同时认带引号（<c>k="v"</c>）与裸值（<c>dir=in</c>）。
    /// 与 TS 的 <c>/(\w+)\s*=\s*("[^"]*"|[A-Za-z_]\w*)/g</c> 逐字一致 —— 旧实现复用
    /// <see cref="CParse.KvPairs"/>，它允许裸值里出现空格以外的一切字符，会把
    /// <c>style=rounded=1;</c> 这类写法切得面目全非。
    /// </summary>
    private static readonly Regex MergeKvRe = new(@"(\w+)\s*=\s*(""[^""]*""|[A-Za-z_]\w*)", RegexOptions.Compiled);

    /// <summary><c>Key = "value"</c> / <c>Key = bareword</c> 的命名实参（裸值不含逗号；含逗号的只可能是引号值）。</summary>
    private static readonly Regex CsNamedArgRe = new(
        @"^\s*(?<key>\w+)\s*=\s*(?:""(?<quoted>[^""]*)""|(?<bare>\w+))\s*$", RegexOptions.Compiled);

    /// <summary>位置参数：<c>Direction.Out</c>。方向在 C# 侧是位置参数，让编辑器能补全。</summary>
    private static readonly Regex CsDirArgRe = new(@"^\s*Direction\s*\.\s*(?<member>\w+)\s*$", RegexOptions.Compiled);

    /// <summary>
    /// 类型与名字都必须与 <see cref="CsParse"/> 的字段识别用<b>同一字符集</b>：
    /// sync 回写时要能认出「中文类型 + 中文字段名」的声明
    /// （<c>public static 数据包 a1_数据包;</c>），否则中文名信号在回写时会被
    /// 静默漏掉。Python 的 <c>[^\W\d]</c> 等价于 TS 的 <c>[\p{L}_]</c>
    /// （Unicode 字母或下划线）。
    /// </summary>
    private static readonly Regex CsFieldLineRe = new(
        @"^\s*(?:(?:public|private|internal|protected|static|readonly|const|volatile)\s+)*" +
        @"(?<ctype>[\p{L}_][\w\.<>,\[\]\?]*)\s+(?<name>[\p{L}_]\w*)\s*(?<init>=[^;]*)?;\s*$",
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

    /// <summary>
    /// 「人拖过的几何」→ 注解键值对；没有 pinned 项时返回空列表（一个键都不写）。
    ///
    /// 两个键名因语言而不同（C 是 <c>xy</c>/<c>size</c>，C# 是 <c>Xy</c>/<c>Size</c>），
    /// 分隔符却必须两个前端一致：<c>xy</c> 用<b>逗号</b>、<c>size</c> 用<b>小写 x</b> ——
    /// 两边解析器就是那么切的。写错分隔符不会报错，只会静默得到 NaN 尺寸。
    ///
    /// 数字一律走 <see cref="Text.Num"/>：与 drawio 写 XML 几何是同一个格式化函数，
    /// 保证 <c>120</c> 不会写成 <c>120.0</c>。否则同一份几何在 .drawio 与源码里
    /// 两个写法，回读比对永远对不上。
    /// </summary>
    private static List<(string, string)> GeomKv(string xyKey, string sizeKey, PinnedGeom? pinned)
    {
        if (pinned is null)
        {
            return [];
        }

        var output = new List<(string, string)>();
        if (pinned.Xy is { Count: 2 } xy)
        {
            output.Add((xyKey, Text.Num(xy[0]) + "," + Text.Num(xy[1])));
        }

        if (pinned.Size is { Count: 2 } size)
        {
            output.Add((sizeKey, Text.Num(size[0]) + "x" + Text.Num(size[1])));
        }

        return output;
    }

    /// <summary>一个信号注解的受管键值对（C 侧，含 <c>dir</c>）。</summary>
    private static List<(string, string)> SignalKv(Signal sig, PinnedGeom? pinned = null)
    {
        var kv = new List<(string, string)>();
        if (sig.Dir.Length > 0)
        {
            // IR 用 inout，写回 C 时用更短的 io
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

        kv.AddRange(GeomKv("xy", "size", pinned));
        return kv;
    }

    /// <summary>
    /// 渲染一个信号的 <c>/// @drawcode</c> 行。
    ///
    /// <b>键全空时也必须落一个键</b>：解析侧把「注解里至少有一个键」当作信号的判据，
    /// 光写 <c>/// @drawcode</c> 的声明读不回 IR，下一次 sync 会把它当成新元素再追加
    /// 一遍。<c>dir=""</c> 表示「没有方向」—— 它是 IR 里的合法值，解析侧两种识别规则
    /// 都认它。注意这只影响<b>渲染新行</b>；合并既有行时 <see cref="SignalKv"/> 在方向
    /// 为空时不含 <c>dir</c>，免得给一条本来就没写方向的注解硬塞一个 <c>dir=""</c>，
    /// 破坏「没人动过 ⇒ 逐字节不变」。
    /// </summary>
    private static string RenderAnnotation(Signal sig, PinnedGeom? pinned = null)
    {
        var kv = SignalKv(sig, pinned);
        return "/// @drawcode " + (kv.Count > 0 ? KvText(kv) : "dir=\"\"");
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
    internal static string RenderSignal(Signal sig, PinnedGeom? pinned = null)
    {
        var (baseRaw, arr) = SplitCType(sig.CType);
        var untyped = baseRaw.Length == 0;
        var baseType = untyped ? PlaceholderCType : baseRaw;
        var line = (baseType + " " + sig.Name + arr).Trim() + ";";
        var body = RenderAnnotation(sig, pinned) + "\n" + line;
        // TODO 必须排在注解行**之前**：TODO 是块注释，夹在注解与声明之间会把注解从
        // 缓冲里截断（解析侧遇到非 /// 行就清缓冲），那条注解就丢了，信号下次又会被
        // 当成新元素。
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

    private static List<(string, string)> RenderFuncKv(Func func, PinnedGeom? pinned = null)
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

        kv.AddRange(GeomKv("xy", "size", pinned));
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

    /// <summary>
    /// 把 <paramref name="kvNew"/> 合并进一行既有的 C 注解，返回整行。
    /// <b>逐段原地改，不整行重建。</b>
    ///
    /// 保留 drawcode 不管理的属性（手写的 <c>xy</c>/<c>size</c>/<c>style</c>）并维持原有顺序。
    /// 与「整行重建」的差别（都是为了「没人动过 ⇒ 逐字节不变」这条硬标准）：
    /// <list type="bullet">
    /// <item>行前缀（<c>/// @drawcode</c> 与任何缩进）、键与键之间的空白、行尾原样保留；</item>
    /// <item><b>值没变的键连写法都不动</b>：<c>dir = in</c>（多余空格、裸值）不会因为一次
    /// 无关的合并被规范化成 <c>dir=in</c>，否则每次 sync 都会产生无意义的 diff；</item>
    /// <item>值确实要改的键沿用<b>原键的引号风格</b>：<c>dir=in → dir=out</c>（裸值）、
    /// <c>alias="旧" → alias="新"</c>；</item>
    /// <item>追加的新键用规范写法。</item>
    /// </list>
    /// </summary>
    private static string MergeAnnotation(string origLine, List<(string, string)> kvNew)
    {
        var want = kvNew.ToDictionary(p => p.Item1, p => p.Item2, StringComparer.Ordinal);
        var used = new HashSet<string>(StringComparer.Ordinal);
        var sb = new System.Text.StringBuilder();
        var cursor = 0;
        foreach (Match m in MergeKvRe.Matches(origLine))
        {
            sb.Append(origLine, cursor, m.Index - cursor);
            cursor = m.Index + m.Length;
            var key = m.Groups[1].Value;
            var raw = m.Groups[2].Value;
            var value = raw.StartsWith('"') ? raw[1..^1] : raw;
            if (!want.TryGetValue(key, out var nv))
            {
                // 不受管的键（手写 xy/size/style 等）：原样保留
                sb.Append(m.Value);
                continue;
            }

            // 只要 kvNew 里也有这个键，无论值是否相同都算「已消费」——否则收尾的
            // 「追加缺失键」循环会把值相同的键再追加一遍，注解里出现重复键。
            used.Add(key);
            if (nv == value)
            {
                sb.Append(m.Value);
            }
            else if (raw.StartsWith('"'))
            {
                sb.Append(key).Append("=\"").Append(nv).Append('"');
            }
            else
            {
                sb.Append(key).Append('=').Append(nv);
            }
        }

        sb.Append(origLine, cursor, origLine.Length - cursor);
        var text = sb.ToString();
        foreach (var (k, v) in kvNew)
        {
            if (used.Contains(k))
            {
                continue;
            }

            text += (text.EndsWith(' ') ? "" : " ") + KvText([(k, v)]);
        }

        return text;
    }

    /// <summary>
    /// 一个既有信号块的合并渲染：注解行<b>就地合并</b>，其余行不动。
    ///
    /// 为什么注解行绝不能整行重建（旧实现的做法）：重建只能输出受管键
    /// （dir/unit/alias/note/external/几何），源码上手写的 <c>style</c> 会被静默抹掉 ——
    /// 这是个既存缺陷。合并后：没人拖动 ⇒ 手写键原样存活；人拖过 ⇒ 就地替换。
    ///
    /// 未定类型的 TODO 注释行必须留在注解行<b>之前</b>（原因见 <see cref="RenderSignal"/>）。
    /// </summary>
    private static List<string> MergeSignalBlock(Signal sig, IReadOnlyList<string> orig, PinnedGeom? pinned)
    {
        var rendered = Text.SplitLines(RenderSignal(sig, pinned)).ToList();
        var renderedAnn = rendered.FindIndex(l => l.TrimStart().StartsWith("/// @drawcode", StringComparison.Ordinal));
        var origAnn = -1;
        for (var i = 0; i < orig.Count; i++)
        {
            if (orig[i].TrimStart().StartsWith("/// @drawcode", StringComparison.Ordinal))
            {
                origAnn = i;
                break;
            }
        }

        var kv = SignalKv(sig, pinned);
        var annotation = origAnn >= 0 ? MergeAnnotation(orig[origAnn], kv) : rendered[renderedAnn];
        var head = rendered.Take(renderedAnn).ToList();
        var body = new List<string>();
        for (var i = 0; i < orig.Count; i++)
        {
            if (i != origAnn)
            {
                body.Add(orig[i]);
            }
        }

        if (origAnn < 0)
        {
            // 块里没有 @drawcode 行：把注解插在声明行正上方，其余 `///` 行保持原序
            var output = new List<string>(head);
            output.AddRange(body.Take(body.Count - 1));
            output.Add(annotation);
            output.Add(body[^1]);
            return output;
        }

        // 去掉原注解行后，下标 origAnn 正好是它原来的位置（后面整体前移一位）
        var merged = new List<string>(head);
        merged.AddRange(body.Take(origAnn));
        merged.Add(annotation);
        merged.AddRange(body.Skip(origAnn));
        return merged;
    }

    private static List<string> FuncBlock(Func func, Device? dev, IReadOnlyList<string> orig, PinnedGeom? pinned = null)
    {
        var kv = RenderFuncKv(func, pinned);
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
            var rendered = FuncBlock(f, model.Devices.GetValueOrDefault(f.Id), block, model.Pinned.GetValueOrDefault(f.Id));
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
                var kv = RenderFuncKv(f, model.Pinned.GetValueOrDefault(f.Id));
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
            // C# 信号与方法分两趟：定位规则不同（字段声明 vs 方法签名 + 连读的 `[...]` 属性行）。
            // 两趟都必须跑、不能用 `||` 短路 —— 信号没变不等于方法没变。
            var signals = SyncCsSource(path, model, rel);
            var methods = SyncCsMethods(path, model, rel);
            return signals || methods;
        }

        var touched = SyncHeader(path, model, rel);
        return SyncFunctions(path, model, rel) || touched;
    }

    /// <summary>
    /// C# 注解实参的规范文本。<c>"Direction"</c> 是 <see cref="CsSignalArgs"/> 里的伪键：
    /// 它是位置参数，规范形态是 <c>Direction.In</c>，不是 <c>Direction = "In"</c>。
    /// 走这里兜底，任何追加路径都不会写出错误形态。
    /// </summary>
    private static string CsArgs(IEnumerable<(string Key, string Value)> pairs) =>
        string.Join(", ", pairs.Select(p => p.Key == "Direction"
            ? "Direction." + p.Value
            : p.Key + " = \"" + p.Value + "\""));

    /// <summary>
    /// C# 信号注解的受管实参（渲染与合并共用同一份，防止两处集合/顺序漂移）。
    ///
    /// <c>Direction</c> 在源码里是<b>位置参数</b>（<c>Direction.In</c>，不写
    /// <c>Key = "value"</c>）。这里用伪键 <c>"Direction"</c> 表示它：渲染时落回位置形态，
    /// 合并时与既有的位置参数对齐替换。方向为空串（IR 合法值）时不产出该参数，
    /// 既不写出 <c>Direction.None</c>，也让合并跳过它。
    /// </summary>
    private static List<(string, string)> CsSignalArgs(Signal sig, PinnedGeom? pinned = null)
    {
        var args = new List<(string, string)>();
        if (sig.Dir.Length > 0)
        {
            args.Add(("Direction", CsDir.GetValueOrDefault(sig.Dir, "None")));
        }

        if (sig.Unit.Length > 0)
        {
            args.Add(("Unit", sig.Unit));
        }

        if (sig.Alias.Length > 0)
        {
            args.Add(("Alias", sig.Alias));
        }

        if (sig.Note.Length > 0)
        {
            args.Add(("Note", sig.Note));
        }

        if (sig.External)
        {
            args.Add(("External", "true"));
        }

        args.AddRange(GeomKv("Xy", "Size", pinned));
        return args;
    }

    /// <summary>
    /// 一行 <c>[Drawcode(...)]</c>：方向是位置参数、其余是命名属性。属性名用 PascalCase，
    /// 与 <c>DrawcodeAttributes.cs</c> 里定义的属性一一对应。
    ///
    /// 与 TS 的 <c>renderCsAnnotation</c> 有一处<b>刻意的差异</b>：方向为空串而其余键也
    /// 全空时，这里返回 <c>[]</c>（不落注解行），TS 会写出 <c>Direction.undefined</c>。
    /// C# 前端要求有 <c>Direction</c> 才算信号，解析产物不可能带空方向，所以这条路径
    /// 只在手工构造 Model 时可达；不把「undefined」写进用户代码。
    /// </summary>
    private static List<string> RenderCsAnnotation(Signal sig, PinnedGeom? pinned = null)
    {
        var args = CsSignalArgs(sig, pinned);
        return args.Count == 0 ? [] : ["[Drawcode(" + CsArgs(args) + ")]"];
    }

    /// <summary>
    /// 引号感知的顶层逗号切分。
    ///
    /// <c>Xy = "360,130"</c> 的逗号在引号里，直接 <c>body.Split(',')</c> 会把它当一个
    /// 实参切成两半，合并后写出 <c>Xy = "360</c> + 半个 <c>130"</c> 这种会编译失败的
    /// 垃圾。引号内不做转义处理 —— 与 <see cref="CsParse"/> 的 <c>ArgRe</c>
    /// （<c>[^"]*</c>）保持同一套假设，两处对「什么算引号值」的判断必须一致。
    /// </summary>
    private static List<string> SplitTopLevelCommas(string body)
    {
        var output = new List<string>();
        var start = 0;
        var inQuote = false;
        for (var i = 0; i < body.Length; i++)
        {
            var ch = body[i];
            if (ch == '"')
            {
                inQuote = !inQuote;
            }
            else if (ch == ',' && !inQuote)
            {
                output.Add(body[start..i]);
                start = i + 1;
            }
        }

        output.Add(body[start..]);
        return output;
    }

    /// <summary>
    /// <c>[Drawcode(...)]</c> 的实参体 → 合并后的实参体。<b>参数级</b> merge，不是整行重建：
    /// <list type="bullet">
    /// <item>位置参数（<c>Direction.Out</c>）与认不出的实参一律原样保留（逐字节，连空白都不动）；</item>
    /// <item>命名参数只有受管值确实不同才重写（重写为 <c>Key = "value"</c> 规范形态）；
    /// 值相同 ⇒ 原样，这正是「无人拖动 ⇒ 逐字节不变」的实现方式，也让
    /// <c>Unit="LSB"</c> 这种紧凑写法不会被顺手规范化；</item>
    /// <item>缺失的受管参数追加到末尾；</item>
    /// <item>键名按大小写不敏感匹配（解析侧 <c>ArgRe</c> 也把键名小写化后再查表），
    /// 但重写时沿用原键写法。</item>
    /// </list>
    /// </summary>
    private static string MergeCsArgs(string body, List<(string Key, string Value)> updates)
    {
        if (updates.Count == 0)
        {
            return body;
        }

        // 伪键 "Direction" 在匹配时按小写 "direction" 参与；其余键同样小写化。
        var want = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (k, v) in updates)
        {
            want[k.ToLowerInvariant()] = v;
        }

        var used = new HashSet<string>(StringComparer.Ordinal);
        var output = new List<string>();
        foreach (var seg in SplitTopLevelCommas(body))
        {
            var named = CsNamedArgRe.Match(seg);
            if (named.Success)
            {
                var key = named.Groups["key"].Value;
                var value = named.Groups["quoted"].Success
                    ? named.Groups["quoted"].Value
                    : named.Groups["bare"].Value;
                if (!want.TryGetValue(key.ToLowerInvariant(), out var w))
                {
                    output.Add(seg); // 不受管的实参（手写 Style 等）：原样保留
                    continue;
                }

                // 与 C 侧同理：值相同也要算「已消费」，否则会被当成缺失键追加成重复实参
                // —— `Direction` 伪键尤其致命，那会写出 `Direction.Out, Direction = "Out"`。
                used.Add(key.ToLowerInvariant());
                if (w == value)
                {
                    output.Add(seg);
                    continue;
                }

                var lead = seg[..(seg.Length - seg.TrimStart().Length)];
                output.Add(lead + key + " = \"" + w + "\"");
                continue;
            }

            var dirArg = CsDirArgRe.Match(seg);
            if (dirArg.Success)
            {
                if (!want.TryGetValue("direction", out var w))
                {
                    output.Add(seg);
                    continue;
                }

                used.Add("direction");
                if (w == dirArg.Groups["member"].Value)
                {
                    output.Add(seg);
                    continue;
                }

                var lead = seg[..(seg.Length - seg.TrimStart().Length)];
                output.Add(lead + "Direction." + w);
                continue;
            }

            output.Add(seg);
        }

        var missing = updates.Where(u => !used.Contains(u.Key.ToLowerInvariant())).ToList();
        if (missing.Count == 0)
        {
            return string.Join(",", output);
        }

        var add = CsArgs(missing);
        var last = output[^1];
        if (last.Trim().Length == 0)
        {
            // 体是空的（`[Drawcode()]`）或尾随逗号：没有实参可依附，直接落规范写法
            output[^1] = output.Count == 1 && last.Length == 0 ? add : " " + add;
        }
        else
        {
            output.Add(" " + add);
        }

        return string.Join(",", output);
    }

    /// <summary>
    /// 在一行 <c>[Drawcode(...)]</c> 上找到实参体（引号感知地配对 <c>)</c>），
    /// 对它做参数级合并。
    ///
    /// 认不出（没有 <c>[Drawcode(</c>、括号不闭合）时<b>原样返回整行</b> —— 回写工具
    /// 对看不懂的东西必须闭嘴：把一行没改动的注解改写坏掉，比不写回更糟。
    /// </summary>
    private static string MergeCsAnnotationLine(string line, List<(string Key, string Value)> updates)
    {
        var m = CsAttrRe.Match(line);
        if (!m.Success)
        {
            return line;
        }

        var bodyStart = m.Index + m.Length;
        var inQuote = false;
        var depth = 0;
        for (var i = bodyStart; i < line.Length; i++)
        {
            var ch = line[i];
            if (ch == '"')
            {
                inQuote = !inQuote;
                continue;
            }

            if (inQuote)
            {
                continue;
            }

            if (ch == '(')
            {
                depth++;
                continue;
            }

            if (ch != ')')
            {
                continue;
            }

            if (depth > 0)
            {
                depth--;
                continue;
            }

            var body = line[bodyStart..i];
            var merged = MergeCsArgs(body, updates);
            // 行尾（`)]` 之后，可能有注释）原样保留：只换实参体这一段
            return merged == body ? line : line[..bodyStart] + merged + line[i..];
        }

        return line;
    }

    /// <summary>
    /// 从第 <paramref name="frm"/> 行向上扫过连续的 <c>[...]</c> 属性行，返回最近一行
    /// <c>[Drawcode(</c> 的行号，找不到返回 null。
    ///
    /// 为什么不能只看「上一行」：设备卡片的真实形状是
    /// <code>
    /// [Drawcode(...)]            ← 要合并的目标
    /// [Device(Model = "…")]      ← 它的「下一行」，也就是签名的「上一行」
    /// public static Hardware dev_xxx()
    /// </code>
    /// <c>[Device]</c> 卡在中间，「签名的上一行」这个定位法直接失效：会把方法误判成
    /// 「没有注解」，然后（若照旧逻辑）在上面插一行重复的 <c>[Drawcode]</c>。所以必须
    /// 扫过<b>连续</b>的属性行。停扫条件与解析侧一致：两处用同一条边界才能在「解析认得出」
    /// 的行上写回。多个 <c>[Drawcode]</c> 时取<b>最近</b>的一行：解析侧同类键是后写覆盖
    /// 前写，即离声明最近者胜。
    /// </summary>
    private static int? FindCsDrawcodeAbove(IReadOnlyList<string> lines, int frm)
    {
        for (var j = frm - 1; j >= 0 && lines[j].TrimStart().StartsWith('['); j--)
        {
            if (CsAttrRe.IsMatch(lines[j]))
            {
                return j;
            }
        }

        return null;
    }

    /// <summary>
    /// 回写 C# 声明层：每个声明上方一行 <c>[Drawcode(...)]</c>。
    ///
    /// 既有注解行走<b>参数级合并</b>（<see cref="MergeCsAnnotationLine"/>）：手写的
    /// <c>Style</c>、<c>Xy</c>/<c>Size</c> 和其他不认识的参数全部原样存活，只有受管参数里
    /// 值确实变了的才被就地替换。旧实现是整行重建，手写参数会被静默抹掉 —— 与 C 侧的
    /// <see cref="SyncHeader"/> 是同一个缺陷，这次一并修掉。
    /// </summary>
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

        // 定位每个已有字段：DcIdx = 上方最近的 [Drawcode( 行（没有则 null），FieldIdx = 字段行
        var spans = new List<(int? DcIdx, int FieldIdx, string Name)>();
        for (var i = 0; i < lines.Length; i++)
        {
            var m = CsFieldLineRe.Match(lines[i]);
            if (!m.Success || !wanted.ContainsKey(m.Groups["name"].Value))
            {
                continue;
            }

            spans.Add((FindCsDrawcodeAbove(lines, i), i, m.Groups["name"].Value));
        }

        var newLines = new List<string>(lines);
        // 从后往前替换，这样前面的区间下标不会被改动而失效
        for (var s = spans.Count - 1; s >= 0; s--)
        {
            var span = spans[s];
            var sig = wanted[span.Name];
            var pinned = model.Pinned.GetValueOrDefault(sig.Id);
            if (span.DcIdx is { } dcIdx)
            {
                var merged = MergeCsAnnotationLine(newLines[dcIdx], CsSignalArgs(sig, pinned));
                if (merged != newLines[dcIdx])
                {
                    newLines[dcIdx] = merged;
                }

                continue;
            }

            // 字段上方没有 Drawcode 注解行：插一行新的，字段行本身一格不动
            var fieldLine = lines[span.FieldIdx];
            var indent = fieldLine[..(fieldLine.Length - fieldLine.TrimStart().Length)];
            var rendered = RenderCsAnnotation(sig, pinned).Select(l => indent + l).ToList();
            rendered.Add(fieldLine);
            newLines.RemoveRange(span.FieldIdx, 1);
            newLines.InsertRange(span.FieldIdx, rendered);
        }

        // 追加分支：模型里有、但文件里还没写的信号。
        // 缺了这一段，sync 就只能改已有字段、无法新增 —— 与 C 侧 SyncHeader 对称。
        var known = new HashSet<string>(spans.Select(s => s.Name), StringComparer.Ordinal);
        var extra = wanted.Values.Where(s => !known.Contains(s.Name)).Select(s => s.Name).ToList();
        if (extra.Count > 0)
        {
            // 插到最后一个字段行之后；找不到字段就插到类体收尾 `}` 之前
            int? anchor = null;
            for (var i = 0; i < newLines.Count; i++)
            {
                if (CsFieldLineRe.IsMatch(newLines[i]))
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

            // 按名字排序，保证同样输入永远得到同样的插入顺序（幂等 + 可复现）
            extra.Sort(StringComparer.Ordinal);
            var add = new List<string>();
            foreach (var name in extra)
            {
                var sig = wanted[name];
                add.AddRange(RenderCsAnnotation(sig, model.Pinned.GetValueOrDefault(sig.Id)).Select(l => indent + l));
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

    /// <summary>
    /// C# 方法注解的<b>几何</b>回写：把 pinned 里的 <c>Xy</c>/<c>Size</c> 合并进方法上方
    /// <c>[Drawcode(...)]</c> 行；<c>[Device(...)]</c> 行与签名一个字都不动。
    ///
    /// 为什么只碰几何、不碰 Alias/Note/Asset：
    /// <list type="bullet">
    /// <item>本轮契约只要求几何；</item>
    /// <item><c>Asset</c> 在解析侧有一个隐蔽来源：<c>Func.Asset</c> 在 <c>[Drawcode]</c>
    /// 没有 Asset 时会从 <c>[Device(Asset=…)]</c> 回填。若把 Asset 也纳入合并，就会把
    /// Device 行上的 Asset 悄悄复制一份进 Drawcode 行 —— 凭空多出一个键；</item>
    /// <item>写回范围越小，破坏面越小。其余键的回写是后续工作，不是这里顺手做的事。</item>
    /// </list>
    ///
    /// 定位方法签名复用 <see cref="CsParse.CsFuncRe"/>（方法签名的单一事实源），绝不另写
    /// 一套正则 —— 两套写法迟早漂移，届时「解析认得出、回写找不到」会静默丢失改动。
    ///
    /// 已知限制（本轮不做）：图里有、源码里没有的<b>新方法</b>不会自动插入骨架；
    /// 找不到 <c>[Drawcode(...)]</c> 的既有方法也一行都不碰。
    /// </summary>
    private static bool SyncCsMethods(string path, Model model, string rel)
    {
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

        var text = Text.ReadSource(path);
        var lines = Text.SplitLines(text);
        var newLines = new List<string>(lines);
        for (var i = 0; i < lines.Length; i++)
        {
            var m = CsParse.CsFuncRe.Match(lines[i].Trim());
            if (!m.Success || !funcs.TryGetValue(m.Groups["name"].Value, out var f))
            {
                continue;
            }

            var dcIdx = FindCsDrawcodeAbove(lines, i);
            if (dcIdx is null)
            {
                continue;
            }

            var updates = GeomKv("Xy", "Size", model.Pinned.GetValueOrDefault(f.Id));
            if (updates.Count == 0)
            {
                continue;
            }

            var merged = MergeCsAnnotationLine(newLines[dcIdx.Value], updates);
            if (merged != newLines[dcIdx.Value])
            {
                newLines[dcIdx.Value] = merged;
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

    /// <summary>
    /// 找出文件里所有「信号声明块」的位置：块 = 声明行本身 + 它上方连续的 <c>///</c> 行。
    ///
    /// 与解析侧的规则一致：注解块必须紧贴声明，中间不能有空行。回写时按 start..end
    /// 整块替换，所以块的边界画错会吃掉相邻代码。
    ///
    /// 这里<b>不要求</b>块里已经有 <c>@drawcode</c>：模型里有的名字才走到合并，
    /// 没注解的行会由 <see cref="MergeSignalBlock"/> 把注解插到声明行正上方。旧实现
    /// 要求有注解，结果一条注解被人删掉的信号会被当成「源码里没有」再追加一遍，
    /// 声明重复出现。
    /// </summary>
    private static List<(int Start, int End, string Name)> Blocks(IReadOnlyList<string> lines)
    {
        var output = new List<(int, int, string)>();
        for (var i = 0; i < lines.Count; i++)
        {
            // 与 Python 的 `SIGNAL_RE.match(line.strip())` 对齐：声明行可能带缩进。
            var m = SignalLineRe.Match(lines[i].Trim());
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

            // 注解行**就地合并**，其余行不动；整块重建会抹掉手写的 style。
            var current = newLines.GetRange(start, end - start + 1);
            var rendered = MergeSignalBlock(sig, current, model.Pinned.GetValueOrDefault(sig.Id));
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
