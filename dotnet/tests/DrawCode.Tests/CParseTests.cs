namespace DrawCode.Tests;

public class CParseTests
{
    private static readonly Model M = Fixture.SmallC();

    [Fact]
    public void SignalSetAndDirections()
    {
        Assert.Equal(
            ["adc.h::g_filtered", "adc.h::g_raw", "dsp.h::g_coeff"],
            M.Signals.Keys.OrderBy(k => k, StringComparer.Ordinal));
        Assert.Equal("in", M.Signals["adc.h::g_raw"].Dir);
        Assert.Equal("out", M.Signals["adc.h::g_filtered"].Dir);
        Assert.Equal("in", M.Signals["dsp.h::g_coeff"].Dir);
    }

    [Fact]
    public void SignalTypes()
    {
        Assert.Equal("int16_t", M.Signals["adc.h::g_raw"].CType);
        Assert.Equal("float[32]", M.Signals["dsp.h::g_coeff"].CType);
    }

    [Fact]
    public void SignalAnnotations()
    {
        var s = M.Signals["adc.h::g_raw"];
        Assert.Equal("LSB", s.Unit);
        Assert.Equal("原始采样值", s.Alias);
        Assert.Equal("上电后需校准", s.Note);
        Assert.Equal("adc.h", s.File);
        Assert.Equal(7, s.Line);
        Assert.Equal("adc", s.Group);
    }

    [Fact]
    public void FuncSet()
    {
        Assert.Equal(
            ["adc.h::adc_read", "dsp.h::dsp_set_gain", "dsp.h::fir_apply"],
            M.Funcs.Keys.OrderBy(k => k, StringComparer.Ordinal));
    }

    [Fact]
    public void FuncSignatureAndAnnotation()
    {
        var f = M.Funcs["adc.h::adc_read"];
        Assert.Equal("int16_t", f.Ret);
        Assert.Equal("ADC 采样", f.Alias);
        Assert.Equal("上电后需先校准", f.Tooltip);
        Assert.Equal((420.0, 160.0, 180.0, 72.0), (f.X, f.Y, f.W, f.H));
        Assert.Equal(14, f.Line);
        Assert.Equal("adc", f.Group);
    }

    [Fact]
    public void ParamsArePortsNotNodes()
    {
        var f = M.Funcs["dsp.h::dsp_set_gain"];
        Assert.Equal(["gain"], f.Params.Select(p => p.Name));
        Assert.Equal("uint8_t", f.Params[0].CType);
        Assert.Equal("in", f.Params[0].Dir);
    }

    [Fact]
    public void DefUseFromBody()
    {
        var f = M.Funcs["adc.h::adc_read"];
        Assert.Equal(["adc.h::g_raw"], f.Reads);
        Assert.Equal(["adc.h::g_filtered"], f.Writes);
        Assert.Equal(["dsp.h::fir_apply"], f.Calls);
    }

    [Fact]
    public void DefUseWithExpressionAndArray()
    {
        var f = M.Funcs["dsp.h::fir_apply"];
        Assert.Equal(["adc.h::g_raw", "dsp.h::g_coeff"], f.Reads);
        Assert.Equal(["adc.h::g_filtered"], f.Writes);
    }

    [Fact]
    public void DefUseOnArrayElementWrite()
    {
        var f = M.Funcs["dsp.h::dsp_set_gain"];
        Assert.Equal(["dsp.h::g_coeff"], f.Writes);
        Assert.Empty(f.Reads);
    }

    [Fact]
    public void LocalsNeverEnterTheGraph()
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var f in M.Funcs.Values)
        {
            names.UnionWith(f.Reads);
            names.UnionWith(f.Writes);
        }

        Assert.DoesNotContain("adc.c::v", names);
        Assert.DoesNotContain("dsp.c::i", names);
    }

    [Fact]
    public void DeviceAttachedToFunc()
    {
        var d = M.Devices["adc.h::adc_read"];
        Assert.Equal("TI", d.Vendor);
        Assert.Equal("ADS1115", d.Model);
        Assert.Equal("16bit/860SPS", d.Spec);
        Assert.Equal("2.0x3.0mm", d.Size);
        Assert.Equal("assets/ads1115.svg", d.Asset);
        Assert.Equal("assets/ads1115.svg", M.Funcs["adc.h::adc_read"].Asset);
    }

    [Fact]
    public void EdgesDerivedFromDefUse()
    {
        var got = M.Edges.Select(e => (e.Src, e.Dst, e.Rw)).OrderBy(t => t, Comparer<(string, string, string)>.Default).ToList();
        Assert.Contains(("adc.h::g_raw", "adc.h::adc_read", "read"), got);
        Assert.Contains(("adc.h::adc_read", "adc.h::g_filtered", "write"), got);
        Assert.Contains(("dsp.h::g_coeff", "dsp.h::fir_apply", "read"), got);
        Assert.Contains(("dsp.h::fir_apply", "adc.h::g_filtered", "write"), got);
        Assert.Equal(6, got.Count);
    }

    [Fact]
    public void UnsupportedExtensionIsRejected()
    {
        var bogus = Path.Combine(Fixture.ScratchRoot, Guid.NewGuid().ToString("N") + ".rs");
        Directory.CreateDirectory(Path.GetDirectoryName(bogus)!);
        File.WriteAllText(bogus, "fn main() {}");
        try
        {
            var exc = Assert.Throws<InvalidOperationException>(() => ParseDispatch.ParseAny([bogus], Path.GetDirectoryName(bogus)!));
            Assert.Contains("不支持的文件类型", exc.Message);
        }
        finally
        {
            File.Delete(bogus);
        }
    }
}
