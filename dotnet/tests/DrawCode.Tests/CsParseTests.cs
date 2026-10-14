namespace DrawCode.Tests;

public class CsParseTests
{
    private static readonly Model M = Fixture.SmallCs();

    [Fact]
    public void SignalSetAndDirections()
    {
        Assert.Equal(
            ["Adc.cs::g_filtered", "Adc.cs::g_raw", "Dsp.cs::g_coeff"],
            M.Signals.Keys.OrderBy(k => k, StringComparer.Ordinal));
        Assert.Equal("in", M.Signals["Adc.cs::g_raw"].Dir);
        Assert.Equal("out", M.Signals["Adc.cs::g_filtered"].Dir);
        Assert.Equal("in", M.Signals["Dsp.cs::g_coeff"].Dir);
    }

    [Fact]
    public void SignalAnnotations()
    {
        var s = M.Signals["Adc.cs::g_raw"];
        Assert.Equal("原始采样值", s.Alias);
        Assert.Equal("LSB", s.Unit);
        Assert.Equal("上电后需校准", s.Note);
        Assert.Equal("Adc.cs", s.File);
        Assert.Equal(6, s.Line);
    }

    [Fact]
    public void ArrayFieldKeepsItsBracketForm()
    {
        Assert.Equal("float[]", M.Signals["Dsp.cs::g_coeff"].CType);
    }

    [Fact]
    public void FuncSet()
    {
        Assert.Equal(
            ["Adc.cs::AdcRead", "Dsp.cs::FirApply", "Dsp.cs::SetGain"],
            M.Funcs.Keys.OrderBy(k => k, StringComparer.Ordinal));
    }

    [Fact]
    public void FuncAnnotationAndDevice()
    {
        var f = M.Funcs["Adc.cs::AdcRead"];
        Assert.Equal("short", f.Ret);
        Assert.Equal("ADC 采样", f.Alias);
        Assert.Equal("上电后需先校准", f.Tooltip);
        var d = M.Devices["Adc.cs::AdcRead"];
        Assert.Equal("TI", d.Vendor);
        Assert.Equal("ADS1115", d.Model);
        Assert.Equal("16bit/860SPS", d.Spec);
    }

    [Fact]
    public void ParamsArePorts()
    {
        var f = M.Funcs["Dsp.cs::SetGain"];
        Assert.Equal(["gain"], f.Params.Select(p => p.Name));
        Assert.Equal("byte", f.Params[0].CType);
    }

    [Fact]
    public void DefUse()
    {
        var f = M.Funcs["Adc.cs::AdcRead"];
        Assert.Equal(["Adc.cs::g_raw"], f.Reads);
        Assert.Equal(["Adc.cs::g_filtered"], f.Writes);
        Assert.Equal(["Dsp.cs::FirApply"], f.Calls);
    }

    [Fact]
    public void DefUseArrayElement()
    {
        var f = M.Funcs["Dsp.cs::SetGain"];
        Assert.Equal(["Dsp.cs::g_coeff"], f.Writes);
        Assert.Empty(f.Reads);
    }

    [Fact]
    public void Edges()
    {
        var got = M.Edges.Select(e => (e.Src, e.Dst, e.Rw)).ToList();
        Assert.Contains(("Adc.cs::g_raw", "Adc.cs::AdcRead", "read"), got);
        Assert.Contains(("Adc.cs::AdcRead", "Adc.cs::g_filtered", "write"), got);
        Assert.Equal(6, got.Count);
    }
}
