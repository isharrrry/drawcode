namespace DrawCode.Tests;

/// <summary>Write-back tests always operate on a throwaway copy: <c>tests/golden/</c> is read-only.</summary>
public class CodeGenTests
{
    private const string CNamesList = "adc.h,adc.c,dsp.h,dsp.c";

    private static string[] Names(string csv) => csv.Split(',');

    [Fact]
    public void CodeToGraphToCodeIsStable()
    {
        var (dir, paths) = Fixture.CopyCase("small-c", Names(CNamesList));
        try
        {
            var m1 = ParseDispatch.ParseAny(paths, dir);
            var xml = Drawio.ToDrawio(m1);

            var m2 = ParseDispatch.ParseAny(paths, dir);
            Drawio.ApplyLayout(m2, Drawio.ReadLayout(xml));
            foreach (var p in paths)
            {
                CodeGen.SyncHeader(p, m2, Path.GetFileName(p));
            }

            var first = paths.ToDictionary(p => Path.GetFileName(p)!, p => Fixture.Read(p), StringComparer.Ordinal);

            var m3 = ParseDispatch.ParseAny(paths, dir);
            foreach (var p in paths)
            {
                CodeGen.SyncHeader(p, m3, Path.GetFileName(p));
            }

            var second = paths.ToDictionary(p => Path.GetFileName(p)!, p => Fixture.Read(p), StringComparer.Ordinal);
            Assert.Equal(first, second);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void HumanLayoutSurvivesAndWritesNothingBackToCode()
    {
        var (dir, paths) = Fixture.CopyCase("small-c", Names(CNamesList));
        try
        {
            var m1 = ParseDispatch.ParseAny(paths, dir);
            var xml = Drawio.ToDrawio(m1);

            var m2 = ParseDispatch.ParseAny(paths, dir);
            var layout = Drawio.ReadLayout(xml);
            layout.Nodes["adc.h::adc_read"] = (900.0, 700.0, 200.0, 80.0);
            Drawio.ApplyLayout(m2, layout);

            var m3 = ParseDispatch.ParseAny(paths, dir);
            Drawio.ApplyLayout(m3, Drawio.ReadLayout(Drawio.ToDrawio(m2)));
            Assert.Equal((900.0, 700.0), (m3.Funcs["adc.h::adc_read"].X, m3.Funcs["adc.h::adc_read"].Y));
            Assert.Equal((200.0, 80.0), (m3.Funcs["adc.h::adc_read"].W, m3.Funcs["adc.h::adc_read"].H));

            var before = Fixture.Read(Path.Combine(dir, "adc.h"));
            foreach (var p in paths)
            {
                CodeGen.SyncHeader(p, m3, Path.GetFileName(p));
            }

            Assert.Equal(before, Fixture.Read(Path.Combine(dir, "adc.h")));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void NewNodeInGraphLandsInHeader()
    {
        var (dir, paths) = Fixture.CopyCase("small-c", Names(CNamesList));
        try
        {
            var m = ParseDispatch.ParseAny(paths, dir);
            m.AddSignal(new Signal
            {
                Id = "adc.h::g_alarm",
                Name = "g_alarm",
                CType = "uint8_t",
                Dir = "out",
                File = "adc.h",
                Alias = "报警输出",
                Group = "adc",
            });
            Assert.True(CodeGen.SyncHeader(Path.Combine(dir, "adc.h"), m, "adc.h"));

            var m2 = ParseDispatch.ParseAny(paths, dir);
            Assert.Contains("adc.h::g_alarm", m2.Signals.Keys);
            Assert.Equal("out", m2.Signals["adc.h::g_alarm"].Dir);
            Assert.Equal("报警输出", m2.Signals["adc.h::g_alarm"].Alias);
            Assert.Contains("adc.h::g_alarm", Drawio.ToDrawio(m2));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void HandWrittenKeysLikeSizeAndXySurvive()
    {
        var (dir, paths) = Fixture.CopyCase("small-c", Names(CNamesList));
        try
        {
            var m = ParseDispatch.ParseAny(paths, dir);
            m.Funcs["adc.h::adc_read"].Alias = "采集入口";
            foreach (var p in paths)
            {
                CodeGen.SyncSource(p, m, Path.GetFileName(p));
            }

            var header = Fixture.Read(Path.Combine(dir, "adc.h"));
            Assert.Contains("alias=\"采集入口\"", header);
            Assert.Contains("xy=\"420,160\"", header);
            Assert.Contains("size=\"180x72\"", header);

            var m2 = ParseDispatch.ParseAny(paths, dir);
            Assert.Equal("采集入口", m2.Funcs["adc.h::adc_read"].Alias);
            Assert.Equal((420.0, 160.0, 180.0, 72.0),
                (m2.Funcs["adc.h::adc_read"].X, m2.Funcs["adc.h::adc_read"].Y, m2.Funcs["adc.h::adc_read"].W, m2.Funcs["adc.h::adc_read"].H));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void SignalAnnotationsRoundTrip()
    {
        var (dir, paths) = Fixture.CopyCase("small-c", Names(CNamesList));
        try
        {
            var m = ParseDispatch.ParseAny(paths, dir);
            m.Signals["adc.h::g_raw"].Unit = "mV";
            m.Signals["adc.h::g_raw"].Note = "改过的备注";
            foreach (var p in paths)
            {
                CodeGen.SyncSource(p, m, Path.GetFileName(p));
            }

            var m2 = ParseDispatch.ParseAny(paths, dir);
            Assert.Equal("mV", m2.Signals["adc.h::g_raw"].Unit);
            Assert.Equal("改过的备注", m2.Signals["adc.h::g_raw"].Note);
            Assert.Equal("原始采样值", m2.Signals["adc.h::g_raw"].Alias);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void DirectionChangeRewritesTheAnnotation()
    {
        var (dir, paths) = Fixture.CopyCase("small-c", Names(CNamesList));
        try
        {
            var m = ParseDispatch.ParseAny(paths, dir);
            m.Signals["adc.h::g_raw"].Dir = "out";
            foreach (var p in paths)
            {
                CodeGen.SyncSource(p, m, Path.GetFileName(p));
            }

            var header = Fixture.Read(Path.Combine(dir, "adc.h"));
            Assert.Contains("dir=out", header);
            Assert.DoesNotContain("dir=in", header);
            Assert.Contains("int16_t g_raw;", header);
            Assert.Contains("#include <stdint.h>", header);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void SyncIsIdempotent()
    {
        var (dir, paths) = Fixture.CopyCase("small-c", Names(CNamesList));
        try
        {
            var m = ParseDispatch.ParseAny(paths, dir);
            foreach (var p in paths)
            {
                CodeGen.SyncSource(p, m, Path.GetFileName(p));
            }

            var after = paths.ToDictionary(p => Path.GetFileName(p)!, p => Fixture.Read(p), StringComparer.Ordinal);
            var changed = paths.Where(p => CodeGen.SyncSource(p, m, Path.GetFileName(p))).ToList();
            Assert.Empty(changed);
            Assert.Equal(after, paths.ToDictionary(p => Path.GetFileName(p)!, p => Fixture.Read(p), StringComparer.Ordinal));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void CsAnnotationAndAttributeRoundTrip()
    {
        var (dir, paths) = Fixture.CopyCase("small-cs", "Adc.cs", "Dsp.cs");
        try
        {
            var m = ParseDispatch.ParseAny(paths, dir);
            m.Signals["Adc.cs::g_raw"].Dir = "out";
            m.Signals["Adc.cs::g_raw"].Unit = "mV";
            foreach (var p in paths)
            {
                CodeGen.SyncSource(p, m, Path.GetFileName(p));
            }

            var source = Fixture.Read(Path.Combine(dir, "Adc.cs"));
            Assert.Contains("[Drawcode(Direction.Out", source);
            Assert.Contains("Unit = \"mV\"", source);
            Assert.Contains("public static short g_raw;", source);

            var m2 = ParseDispatch.ParseAny(paths, dir);
            Assert.Equal("out", m2.Signals["Adc.cs::g_raw"].Dir);
            Assert.Equal("mV", m2.Signals["Adc.cs::g_raw"].Unit);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void NewCsSignalGetsAttributeAndField()
    {
        var (dir, paths) = Fixture.CopyCase("small-cs", "Adc.cs", "Dsp.cs");
        try
        {
            var m = ParseDispatch.ParseAny(paths, dir);
            m.AddSignal(new Signal
            {
                Id = "Adc.cs::g_alarm",
                Name = "g_alarm",
                CType = "byte[]",
                Dir = "out",
                File = "Adc.cs",
                Alias = "报警输出",
                Group = "Adc",
            });
            Assert.True(CodeGen.SyncSource(Path.Combine(dir, "Adc.cs"), m, "Adc.cs"));

            var source = Fixture.Read(Path.Combine(dir, "Adc.cs"));
            Assert.Contains("[Drawcode(Direction.Out", source);
            Assert.Contains("public static byte[] g_alarm;", source);

            var m2 = ParseDispatch.ParseAny(paths, dir);
            Assert.Contains("Adc.cs::g_alarm", m2.Signals.Keys);
            Assert.Equal("byte[]", m2.Signals["Adc.cs::g_alarm"].CType);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void FunctionBodiesAreNeverRewritten()
    {
        var (dir, paths) = Fixture.CopyCase("small-c", Names(CNamesList));
        try
        {
            var before = Fixture.Read(Path.Combine(dir, "adc.c"));
            var m = ParseDispatch.ParseAny(paths, dir);
            m.Funcs["adc.h::adc_read"].Alias = "改名了";
            CodeGen.SyncSource(Path.Combine(dir, "adc.c"), m, "adc.c");
            Assert.Equal(before, Fixture.Read(Path.Combine(dir, "adc.c")));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
