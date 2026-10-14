using System.Globalization;

namespace DrawCode;

/// <summary>
/// 命令行：<c>build</c>（源码 → .drawio）、<c>sync</c>（.drawio → 源码声明层）、<c>dump-ir</c>。
/// 与 Python 的 <c>cli.py</c>、TypeScript 的 <c>cli.ts</c> 接受同一组参数。
///
/// 两个"宁可大声失败"的地方：<c>--layout-from</c> 指向的文件不存在、或**不含 drawcode 节点**时
/// 直接报错退出。手画的 draw.io 文档是裸 <c>&lt;mxCell&gt;</c>、没有 symbolId，拿它当布局源会
/// **静默把所有节点丢到 0,0**；而用户显式传了这个参数，说明他期望复用布局，此时"什么都不做"是错的。
/// </summary>
internal static class Cli
{
    private const string Usage = """
        usage: drawcode <command> [options]

          build <file>... [--root DIR] [--out FILE] [--merge] [--layout-from FILE] [--svg FILE]
              source code -> .drawio (one diagram per module unless --merge)

          sync <file.drawio> <file>... [--root DIR] [--write]
              .drawio -> source code, declaration layer only (dry run without --write)

          dump-ir <file>... [--root DIR] [--out FILE]
              parsed IR as canonical JSON, for L1 conformance comparison
        """;

    internal static int Run(string[] args)
    {
        if (args.Length == 0 || args[0] is "-h" or "--help")
        {
            Console.Out.WriteLine(Usage);
            return args.Length == 0 ? 2 : 0;
        }

        var command = args[0];
        var positional = new List<string>();
        var options = new Dictionary<string, string?>(StringComparer.Ordinal);
        for (var i = 1; i < args.Length; i++)
        {
            var a = args[i];
            if (a.StartsWith("--", StringComparison.Ordinal))
            {
                var eq = a.IndexOf('=', StringComparison.Ordinal);
                if (eq >= 0)
                {
                    options[a[..eq]] = a[(eq + 1)..];
                }
                else if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
                {
                    options[a] = args[++i];
                }
                else
                {
                    options[a] = null;
                }
            }
            else
            {
                positional.Add(a);
            }
        }

        return command switch
        {
            "build" => Build(positional, options),
            "sync" => Sync(positional, options),
            "dump-ir" => DumpIr(positional, options),
            _ => Fail("unknown command: " + command),
        };
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine(message);
        return 2;
    }

    private static string ResolveRoot(IReadOnlyList<string> files, Dictionary<string, string?> options) =>
        options.TryGetValue("--root", out var r) && !string.IsNullOrEmpty(r)
            ? r
            : Path.GetDirectoryName(Path.GetFullPath(files[0])) ?? ".";

    private static string? Opt(Dictionary<string, string?> options, string key) =>
        options.TryGetValue(key, out var v) && !string.IsNullOrEmpty(v) ? v : null;

    private static string WriteTo(string path, string content)
    {
        var full = Path.GetFullPath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(full) ?? ".");
        Text.WriteText(full, content);
        return full;
    }

    /// <summary>同名不同扩展名 = 同一个模块（dsp.h 与 dsp.c 是一个模块的两个面）。</summary>
    private static readonly string[] SiblingExts = [".h", ".c", ".hpp", ".cpp", ".cc", ".cs"];

    /// <summary>模块名：文件名去掉扩展名。</summary>
    private static string ModuleStem(string path) => Path.GetFileNameWithoutExtension(path);

    /// <summary>
    /// 给一个文件，就把它同名的兄弟文件一起带上。
    ///
    /// <c>build dsp.h</c> 和 <c>build dsp.c</c> 都应当指「dsp 这个模块」——用户不该为了
    /// 画一张图而把同一个模块的两个扩展名都写出来。找不到兄弟文件时原样保留。
    /// </summary>
    private static List<string> ExpandModules(IReadOnlyList<string> files)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var output = new List<string>();
        foreach (var f in files)
        {
            var full = Path.GetFullPath(f);
            var dir = Path.GetDirectoryName(full) ?? ".";
            var name = ModuleStem(full);
            var sibs = SiblingExts
                .Select(ext => Path.Combine(dir, name + ext))
                .Where(File.Exists)
                .ToList();
            foreach (var p in sibs.Count > 0 ? sibs : [full])
            {
                if (seen.Add(p))
                {
                    output.Add(p);
                }
            }
        }

        return output;
    }

    /// <summary>模块旁的 <c>&lt;模块名&gt;.drawio</c>。</summary>
    private static string DefaultOut(string path) =>
        Path.ChangeExtension(Path.GetFullPath(path), ".drawio");

    private sealed record Plan(List<string> Files, string Out);

    /// <summary>
    /// 决定产出几张图、各自包含哪些文件、写到哪里。
    ///
    /// 默认**一个模块一张图**：把不相干的模块硬塞进一张图，读的人得先在一堆框里
    /// 找自己要的那块。只有 <c>--merge</c> 才合成一张总览图。
    /// </summary>
    private static List<Plan> PlanBuild(List<string> files, string? outPath, bool merge, out string? error)
    {
        error = null;
        if (merge)
        {
            return [new Plan(files, Path.GetFullPath(outPath ?? "flow.drawio"))];
        }

        var modules = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var f in files)
        {
            var name = ModuleStem(f);
            if (!modules.TryGetValue(name, out var list))
            {
                list = [];
                modules[name] = list;
            }

            list.Add(f);
        }

        if (modules.Count == 1)
        {
            var members = modules.Values.First();
            return [new Plan(members, Path.GetFullPath(outPath ?? DefaultOut(members[0])))];
        }

        if (outPath is not null)
        {
            error =
                "--out names a single file, but " + modules.Count.ToString(CultureInfo.InvariantCulture) +
                " modules were given: " + string.Join(", ", modules.Keys.OrderBy(k => k, StringComparer.Ordinal)) + "\n" +
                "Leave --out off to get one .drawio per module (next to each module),\n" +
                "or pass --merge to put them all in one file.";
            return [];
        }

        return modules
            .OrderBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv => new Plan(kv.Value, DefaultOut(kv.Value[0])))
            .ToList();
    }

    private static int Build(List<string> given, Dictionary<string, string?> options)
    {
        if (given.Count == 0)
        {
            return Fail("build: no input files");
        }

        var root = ResolveRoot(given, options);
        var files = ExpandModules(given);
        var plans = PlanBuild(files, Opt(options, "--out"), options.ContainsKey("--merge"), out var planError);
        if (planError is not null)
        {
            return Fail(planError);
        }

        var layoutFrom = Opt(options, "--layout-from");
        var svgPath = Opt(options, "--svg");

        if (plans.Count > 1 && (layoutFrom is not null || svgPath is not null))
        {
            // 这两个选项都是「针对一张图」的：布局只有一个，SVG 也只有一个文件名。
            // 多模块时静默只作用于第一张图才是最坏的做法。
            return Fail(
                plans.Count.ToString(CultureInfo.InvariantCulture) + " modules given, so " +
                plans.Count.ToString(CultureInfo.InvariantCulture) + " diagrams would be written; " +
                "--layout-from and --svg\nonly make sense for a single diagram. " +
                "Narrow the file list, or pass --merge.");
        }

        foreach (var plan in plans)
        {
            var model = ParseDispatch.ParseAny(plan.Files, root);

            if (layoutFrom is not null)
            {
                if (!File.Exists(layoutFrom))
                {
                    return Fail("--layout-from: no such file: " + layoutFrom);
                }

                var layout = Drawio.ReadLayout(Text.ReadSource(layoutFrom));
                if (layout.Nodes.Count == 0)
                {
                    return Fail(
                        "--layout-from: " + layoutFrom + " holds no drawcode nodes, so there is no layout to reuse.\n" +
                        "Only a .drawio written by drawcode (or edited from one) carries the symbolId on each node.\n" +
                        "A diagram drawn by hand in draw.io cannot be used here.");
                }

                Drawio.ApplyLayout(model, layout);
            }

            var outPath = WriteTo(plan.Out, Drawio.ToDrawio(model));

            var svgNote = "";
            if (svgPath is not null)
            {
                svgNote = " + " + WriteTo(svgPath, Svg.ToSvg(model));
            }

            Console.Out.WriteLine(string.Format(
                CultureInfo.InvariantCulture,
                "signals={0} funcs={1} edges={2} -> {3}{4}",
                model.Signals.Count,
                model.Funcs.Count,
                model.Edges.Count,
                outPath,
                svgNote));
        }

        return 0;
    }

    private static int DumpIr(List<string> files, Dictionary<string, string?> options)
    {
        if (files.Count == 0)
        {
            return Fail("dump-ir: no input files");
        }

        var model = ParseDispatch.ParseAny(files, ResolveRoot(files, options));
        var json = IrJson.ToJson(model);
        var outPath = Opt(options, "--out");
        if (outPath is null)
        {
            Console.Out.Write(json);
            return 0;
        }

        Console.Out.WriteLine(string.Format(
            CultureInfo.InvariantCulture,
            "signals={0} funcs={1} edges={2} devices={3} -> {4}",
            model.Signals.Count,
            model.Funcs.Count,
            model.Edges.Count,
            model.Devices.Count,
            WriteTo(outPath, json)));
        return 0;
    }

    private static int Sync(List<string> files, Dictionary<string, string?> options)
    {
        if (files.Count < 2)
        {
            return Fail("sync: needs a .drawio and at least one source file");
        }

        var drawioPath = files[0];
        var sources = files.Skip(1).ToList();
        var root = ResolveRoot(sources, options);

        var layout = Drawio.ReadLayout(Text.ReadSource(drawioPath), includeForeign: true);
        if (layout.Nodes.Count == 0 && layout.Edges.Count == 0)
        {
            // 手工图没有 symbolId，没有任何可回写的东西，必须说清楚而不是假装成功
            return Fail(
                drawioPath + " holds no drawcode cells, so there is nothing to write back.\n" +
                "Only a .drawio written by drawcode (or edited from one) carries the symbolId\n" +
                "that identifies each node.");
        }

        var model = ParseDispatch.ParseAny(sources, root);
        Drawio.ApplyLayout(model, layout);

        // 图里有、源码里没有的元素（用户在 draw.io 里新加的）接回 IR，
        // 这样 codegen 的 missing 分支才能把它们写进源码。定不下来的只报告、不猜。
        var (adopted, problems) = Adopt.AdoptForeign(model, layout, root);
        foreach (var note in problems)
        {
            Console.Out.WriteLine("note: " + note);
        }

        if (adopted.Count > 0)
        {
            Console.Out.WriteLine(
                "adopted " + adopted.Count + " element(s) added in the diagram: " + string.Join(", ", adopted));
        }

        if (!options.ContainsKey("--write"))
        {
            Console.Out.WriteLine(string.Format(
                CultureInfo.InvariantCulture,
                "dry-run: {0} nodes / {1} edges read back; pass --write to apply",
                layout.Nodes.Count,
                layout.Edges.Count));
            return 0;
        }

        var changed = new List<string>();
        foreach (var path in sources)
        {
            if (CodeGen.SyncSource(path, model, CParse.Rel(path, root)))
            {
                changed.Add(CParse.Rel(path, root));
            }
        }

        Console.Out.WriteLine("updated: " + (changed.Count > 0 ? string.Join(", ", changed) : "(no change)"));
        return 0;
    }
}
