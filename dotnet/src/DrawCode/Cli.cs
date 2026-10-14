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

          build <file>... [--root DIR] [--out FILE] [--layout-from FILE] [--svg FILE]
              source code -> .drawio (optionally reusing a hand-made layout, plus SVG preview)

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

    private static int Build(List<string> files, Dictionary<string, string?> options)
    {
        if (files.Count == 0)
        {
            return Fail("build: no input files");
        }

        var root = ResolveRoot(files, options);
        var model = ParseDispatch.ParseAny(files, root);

        var layoutFrom = Opt(options, "--layout-from");
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

        var outPath = WriteTo(Opt(options, "--out") ?? "flow.drawio", Drawio.ToDrawio(model));

        var svgNote = "";
        var svgPath = Opt(options, "--svg");
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

        var layout = Drawio.ReadLayout(Text.ReadSource(drawioPath));
        var model = ParseDispatch.ParseAny(sources, root);
        Drawio.ApplyLayout(model, layout);

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
