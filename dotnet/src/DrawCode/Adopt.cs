/**
 * 把「用户在 draw.io 里新加的元素」接回 IR。对等 Python `adopt.py` 与 TypeScript `adopt.ts`。
 *
 * `sync` 的方向本来是 **源码 -> 图**，所以图里多出来的东西会被三层静默丢掉：
 *
 *   1. `ReadLayout` 只收带 `symbolId` 的 `<object>`；
 *   2. `ApplyLayout` 对不认识的 id 直接跳过；
 *   3. `sync` 遍历的是**源码文件列表**，不是图里的节点。
 *
 * 于是「我在 draw.io 里加了个方块」不会报错、也不会生成任何代码 —— 元素凭空消失。
 *
 * 本模块补上反向那一步：把图里多出来的顶点变成新的 `Signal` / `Func`，
 * 剩下的交给 `CodeGen` 既有的 missing 分支写回源码。要决的东西（哪一类、叫什么）
 * 按下面的规则定，定不下来的**一律回报**，绝不猜。
 */

using System.Text.RegularExpressions;

namespace DrawCode;

internal static class Adopt
{
    /// <summary><c>int16_t g_new</c> / <c>void fir_apply(void)</c> / <c>g_plain</c></summary>
    private static readonly Regex DeclRe = new(
        @"^\s*(?:(?<ctype>[A-Za-z_][\w\s\*]*?)\s+)?(?<name>[A-Za-z_]\w*)\s*(?:\((?<params>[^)]*)\))?\s*$",
        RegexOptions.Compiled);

    /// <summary>
    /// 我们生成的信号用的是五边形（<c>shape=path</c>）或椭圆；函数用默认矩形。
    /// 用户照着现有节点画，就能被认出来。
    ///
    /// 注意 <c>ellipse</c> 必须写成**裸词**：draw.io 自己的椭圆 style 就是
    /// <c>ellipse;</c>，只有 drawcode 生成时才会写成 <c>shape=ellipse</c>。
    /// 只认后者的话，用户在工具栏上随手画的椭圆会被判成函数、写进 .c —— 而且不报错。
    /// </summary>
    private static readonly string[] SignalMarkers = ["shape=path", "shape=ellipse", "ellipse"];

    /// <summary>按形状判断新元素是变量还是函数。</summary>
    internal static string Classify(string style)
    {
        foreach (var marker in SignalMarkers)
        {
            if (style.Contains(marker, StringComparison.Ordinal))
            {
                return "signal";
            }
        }

        return "func";
    }

    /// <summary>从五边形的朝向推断方向；认不出返回空串，交给调用方决定。</summary>
    internal static string Direction(string style)
    {
        if (style.Contains("direction=east", StringComparison.Ordinal))
        {
            return "in";
        }

        if (style.Contains("direction=west", StringComparison.Ordinal))
        {
            return "out";
        }

        return "";
    }

    /// <summary>
    /// 把节点文字当成一行声明来解析。
    ///
    /// 返回 <c>(CType, Name, Params)</c>：<c>Params is null</c> 表示这不是函数写法。
    /// <code>
    /// int16_t g_new     -> ("int16_t", "g_new", null)
    /// void fir(void)    -> ("void", "fir", "")
    /// g_plain           -> ("", "g_plain", null)
    /// </code>
    /// </summary>
    internal static (string CType, string Name, string? Params) ParseLabel(string label)
    {
        var m = DeclRe.Match(label ?? "");
        if (!m.Success || m.Index != 0)
        {
            return ("", "", null);
        }

        var ctype = m.Groups["ctype"].Success ? m.Groups["ctype"].Value.Trim() : "";
        var name = m.Groups["name"].Value;
        var parameters = m.Groups["params"].Success ? m.Groups["params"].Value : null;
        return (ctype, name, parameters);
    }

    /// <summary>
    /// group 名 -> 该组的源文件集合。
    ///
    /// 一个组通常横跨两个文件（<c>adc.h</c> 声明 + <c>adc.c</c> 实现），所以这里是**集合**
    /// 而不是单值：信号属于 <c>.h</c>、函数实现属于 <c>.c</c>，落点按类型再挑一次。
    /// 早先写成单值映射时，先命中的是函数、把整组都指到 <c>.c</c>，
    /// 结果新信号被写进头文件之外的地方 —— 那是错的。
    /// </summary>
    private static Dictionary<string, HashSet<string>> GroupFiles(Model model)
    {
        var output = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);

        void Push(string group, string file)
        {
            if (group.Length == 0 || file.Length == 0)
            {
                return;
            }

            if (!output.TryGetValue(group, out var set))
            {
                set = new HashSet<string>(StringComparer.Ordinal);
                output[group] = set;
            }

            set.Add(file);
        }

        foreach (var e in model.Signals.Values)
        {
            Push(e.Group, e.File);
        }

        foreach (var e in model.Funcs.Values)
        {
            Push(e.Group, e.File);
        }

        return output;
    }

    /// <summary>
    /// 挑落点：优先 <paramref name="prefer"/> 后缀。
    ///
    /// C 侧的组通常只在 IR 里登记了头文件（函数节点归属到它声明所在的 <c>.h</c>），
    /// 所以函数实现要找**同名** <c>.c</c>：<c>dsp.h</c> -> <c>dsp.c</c>。找不到才退回 <c>.h</c>，
    /// 否则函数体会被写进头文件里。
    /// </summary>
    private static string PickFile(HashSet<string> candidates, string prefer, string? root)
    {
        var sorted = candidates.OrderBy(f => f, StringComparer.Ordinal).ToList();

        foreach (var f in sorted)
        {
            if (f.EndsWith(prefer, StringComparison.Ordinal))
            {
                return f;
            }
        }

        if (prefer == ".c")
        {
            foreach (var f in sorted)
            {
                if (f.EndsWith(".h", StringComparison.Ordinal))
                {
                    var sibling = f[..^2] + ".c";
                    if (root is null || File.Exists(Path.Combine(root, sibling)))
                    {
                        return sibling;
                    }
                }
            }
        }

        foreach (var f in sorted)
        {
            if (f.EndsWith(".h", StringComparison.Ordinal) || f.EndsWith(".cs", StringComparison.Ordinal))
            {
                return f;
            }
        }

        return sorted[0];
    }

    /// <summary>
    /// 把 <c>layout.Foreign</c> 里的元素接进 model。
    ///
    /// <paramref name="root"/> 是源码根目录，用来判断 <c>xxx.h</c> 的同名 <c>xxx.c</c> 是否存在
    /// （函数实现该落到那里）。省略时只按 IR 里登记的文件落点。
    ///
    /// 返回 <c>(Added, Problems)</c>：
    /// <list type="bullet">
    /// <item><c>Added</c> —— 接进来的新 id 列表，供调用方报告；</item>
    /// <item><c>Problems</c> —— 没能自动决定的，每条是一句话。<b>这些不会被猜</b>，
    /// 也不会被写进源码，只是如实告诉用户。</item>
    /// </list>
    /// </summary>
    internal static (List<string> Added, List<string> Problems) AdoptForeign(
        Model model, Drawio.Layout layout, string? root = null)
    {
        var added = new List<string>();
        var problems = new List<string>();
        var groupFile = GroupFiles(model);
        var seq = new Dictionary<string, int>(StringComparer.Ordinal) { ["signal"] = 0, ["func"] = 0 };

        foreach (var cell in layout.Foreign)
        {
            var kind = Classify(cell.Style);
            var label = cell.Label;
            var (ctype, name0, parameters) = ParseLabel(label);
            var isFunc = parameters is not null || kind == "func";
            kind = isFunc ? "func" : "signal";

            var where = label.Length > 0 ? $"{cell.CellId} ({label})" : cell.CellId;

            var group = cell.Container;
            if (group.Length == 0)
            {
                problems.Add(
                    $"{where}: 不在任何容器里，无法判断该写进哪个源文件 —— 把它拖进某个模块容器后重试");
                continue;
            }

            if (!groupFile.TryGetValue(group, out var targetFiles) || targetFiles.Count == 0)
            {
                problems.Add($"{where}: 容器 '{group}' 不对应任何已知源文件，无法落盘");
                continue;
            }

            var target = isFunc ? PickFile(targetFiles, ".c", root) : PickFile(targetFiles, ".h", root);

            var name = name0;
            if (name.Length == 0)
            {
                seq[kind]++;
                name = (kind == "func" ? "new_func" : "new_signal") + "_" + seq[kind];
                problems.Add($"{where}: 节点没有文字，按序号命名为 {name}");
            }

            var newId = target + "::" + name;
            if (model.Signals.ContainsKey(newId) || model.Funcs.ContainsKey(newId))
            {
                problems.Add($"{where}: {newId} 已存在，跳过");
                continue;
            }

            var dir = Direction(cell.Style);
            if (kind == "signal")
            {
                if (ctype.Length == 0)
                {
                    problems.Add($"{where}: 认不出类型，先按空类型生成 —— 请在源码里补上（例如 int16_t）");
                }
                else if (dir.Length == 0)
                {
                    problems.Add($"{where}: 认不出方向（节点形状没有朝向），先按 in 生成");
                }

                model.AddSignal(new Signal
                {
                    Id = newId,
                    Name = name,
                    CType = ctype,
                    Dir = dir.Length == 0 ? "in" : dir,
                    File = target,
                    Group = group,
                    X = cell.X,
                    Y = cell.Y,
                    W = cell.W,
                    H = cell.H,
                });
            }
            else
            {
                var plist = new List<Param>();
                foreach (var raw0 in (parameters ?? "").Split(','))
                {
                    var raw = raw0.Trim();
                    if (raw.Length == 0 || raw == "void")
                    {
                        continue;
                    }

                    var (ptype, pname, _) = ParseLabel(raw);
                    if (pname.Length > 0)
                    {
                        plist.Add(new Param { Name = pname, CType = ptype });
                    }
                }

                model.AddFunc(new Func
                {
                    Id = newId,
                    Name = name,
                    Ret = ctype.Length == 0 ? "void" : ctype,
                    Params = plist,
                    File = target,
                    Group = group,
                });
            }

            added.Add(newId);
        }

        return (added, problems);
    }
}
