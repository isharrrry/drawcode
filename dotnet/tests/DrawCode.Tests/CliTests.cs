namespace DrawCode.Tests;

/// <summary>
/// CLI 的模块拆分、模糊简称，以及 <c>path</c> 决定的容器层级。
///
/// 这三条是一条线上的设定：**一个模块一张图**，模块由同名文件确定，容器层级由源码里的
/// <c>@drawcode path="a/b"</c> 决定 —— 而不是「一个源文件一个容器」。对等 Python
/// <c>test_cli.py</c> 与 TypeScript <c>cli.test.ts</c>。
/// </summary>
public sealed class CliTests
{
    private static (string Dir, string[] Paths) Setup(params string[] names) =>
        Fixture.CopyCase("small-c", names);

    private static List<string> Outputs(string dir) =>
        Directory.GetFiles(dir, "*.drawio").Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal).ToList()!;

    private static int Run(params string[] args) => Cli.Run(args);

    [Fact]
    public void OneModuleGivesOneNamedDiagram()
    {
        var (dir, paths) = Setup("adc.h", "adc.c");
        try
        {
            var args = new List<string> { "build" };
            args.AddRange(paths);
            args.AddRange(["--root", dir]);
            Assert.Equal(0, Run([.. args]));
            Assert.Equal(["adc.drawio"], Outputs(dir));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void TwoModulesGiveTwoDiagrams()
    {
        var (dir, paths) = Setup("adc.h", "adc.c", "dsp.h", "dsp.c");
        try
        {
            var args = new List<string> { "build" };
            args.AddRange(paths);
            args.AddRange(["--root", dir]);
            Assert.Equal(0, Run([.. args]));
            Assert.Equal(["adc.drawio", "dsp.drawio"], Outputs(dir));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void EachDiagramHoldsOnlyItsOwnModule()
    {
        var (dir, paths) = Setup("adc.h", "adc.c", "dsp.h", "dsp.c");
        try
        {
            var args = new List<string> { "build" };
            args.AddRange(paths);
            args.AddRange(["--root", dir]);
            Run([.. args]);

            var xml = Fixture.Read(Path.Combine(dir, "dsp.drawio"));
            Assert.Contains("dsp.h::g_coeff", xml, StringComparison.Ordinal);
            Assert.DoesNotContain("adc.h::", xml, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void OutIsRefusedForSeveralModules()
    {
        // --out 只能指一个文件；多模块时静默只写第一个才是最坏的做法。
        var (dir, paths) = Setup("adc.h", "adc.c", "dsp.h", "dsp.c");
        try
        {
            var args = new List<string> { "build" };
            args.AddRange(paths);
            args.AddRange(["--root", dir, "--out", Path.Combine(dir, "both.drawio")]);
            Assert.Equal(2, Run([.. args]));
            Assert.Empty(Outputs(dir));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void MergePutsEverythingInOneDiagram()
    {
        var (dir, paths) = Setup("adc.h", "adc.c", "dsp.h", "dsp.c");
        try
        {
            var args = new List<string> { "build" };
            args.AddRange(paths);
            args.AddRange(["--root", dir, "--merge", "--out", Path.Combine(dir, "all.drawio")]);
            Assert.Equal(0, Run([.. args]));
            Assert.Equal(["all.drawio"], Outputs(dir));

            var xml = Fixture.Read(Path.Combine(dir, "all.drawio"));
            Assert.Contains("adc.h::g_raw", xml, StringComparison.Ordinal);
            Assert.Contains("dsp.h::g_coeff", xml, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void HeaderAlonePullsInTheSiblingSource()
    {
        // 只给 .h 也要拿到 .c 里扫出来的边 —— 否则图会缺一半
        var (dir, paths) = Setup("dsp.h", "dsp.c");
        try
        {
            Run("build", paths[0], "--root", dir);
            Assert.Equal(["dsp.drawio"], Outputs(dir));

            var model = ParseDispatch.ParseAny([paths[0], paths[1]], dir);
            var xml = Fixture.Read(Path.Combine(dir, "dsp.drawio"));
            // 产物里的边数要对上重解析出来的模型
            Assert.Equal(model.Edges.Count, DrawioGraph.Load(xml).Edges.Count);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void SourceAloneGivesTheSameDiagramAsHeaderAlone()
    {
        var (dir, paths) = Setup("dsp.h", "dsp.c");
        try
        {
            Run("build", paths[0], "--root", dir);
            var fromHeader = Fixture.Read(Path.Combine(dir, "dsp.drawio"));
            File.Delete(Path.Combine(dir, "dsp.drawio"));

            Run("build", paths[1], "--root", dir);
            var fromSource = Fixture.Read(Path.Combine(dir, "dsp.drawio"));
            Assert.Equal(fromHeader, fromSource);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}

/// <summary>容器层级来自 <c>path</c>，不再等于「一个源文件一个容器」。</summary>
public sealed class ContainerPathTests
{
    private const string PathHeader = """
        /// @drawcode path="adc/采样前端" dir=in unit="LSB"
        int16_t g_raw;

        /// @drawcode path="adc/滤波" dir=in unit="coeff"
        float g_coeff[32];

        /// @drawcode dir=in unit="plain"
        int16_t g_plain;
        """;

    private static (string Dir, string File, Model Model) Setup()
    {
        var dir = Path.Combine(Fixture.ScratchRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var file = Path.Combine(dir, "x.h");
        File.WriteAllText(file, PathHeader);
        return (dir, file, ParseDispatch.ParseAny([file], dir));
    }

    [Fact]
    public void PathIsStoredAndGroupIsItsFirstSegment()
    {
        var (dir, _, model) = Setup();
        try
        {
            Assert.Equal("adc/采样前端", model.Signals["x.h::g_raw"].Path);
            Assert.Equal("adc", model.Signals["x.h::g_raw"].Group);
            Assert.Equal("adc/滤波", model.Signals["x.h::g_coeff"].Path);
            Assert.Equal("adc", model.Signals["x.h::g_coeff"].Group);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void WithoutPathItFallsBackToTheModuleName()
    {
        // 旧源码一个字不改也照常工作：没标 path 就用文件名。
        var (dir, _, model) = Setup();
        try
        {
            Assert.Equal("x", model.Signals["x.h::g_plain"].Path);
            Assert.Equal("x", model.Signals["x.h::g_plain"].Group);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void NestedContainersAreEmittedWithAParentChain()
    {
        var (dir, _, model) = Setup();
        try
        {
            var xml = Drawio.ToDrawio(model);
            var graph = DrawioGraph.Load(xml);

            // 容器都建出来了（中间层级 `adc` 即使没有直属成员也必须存在）
            Assert.Contains("adc", graph.Containers.Keys);
            Assert.Contains("采样前端", graph.Containers.Keys);
            Assert.Contains("滤波", graph.Containers.Keys);

            // 子容器的 parent 必须一路指回父容器，而不是根
            var parents = ContainerParents(xml);
            Assert.Equal("", parents["adc"]);
            Assert.Equal("adc", parents["采样前端"]);
            Assert.Equal("adc", parents["滤波"]);

            // 节点落在自己那一层叶容器里；没标 path 的留在自己的模块容器 `x`
            Assert.Equal("采样前端", graph.Nodes["x.h::g_raw"].Container);
            Assert.Equal("滤波", graph.Nodes["x.h::g_coeff"].Container);
            Assert.Equal("x", graph.Nodes["x.h::g_plain"].Container);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    /// <summary>容器显示名 → 父容器显示名（顶层为空串）。容器显示名取 path 最后一段。</summary>
    private static Dictionary<string, string> ContainerParents(string xml)
    {
        var doc = System.Xml.Linq.XDocument.Parse(xml);
        var name = new Dictionary<string, string>(StringComparer.Ordinal);
        var parent = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var cell in doc.Descendants().Where(e => e.Name.LocalName == "mxCell"))
        {
            var style = cell.Attribute("style")?.Value ?? "";
            if (!style.Contains("swimlane", StringComparison.Ordinal))
            {
                continue;
            }

            var id = cell.Attribute("id")?.Value ?? "";
            name[id] = cell.Attribute("value")?.Value ?? "";
            parent[id] = cell.Attribute("parent")?.Value ?? "";
        }

        return name.ToDictionary(
            kv => kv.Value,
            kv => parent.TryGetValue(kv.Key, out var p) && name.TryGetValue(p, out var pn) ? pn : "",
            StringComparer.Ordinal);
    }
}
