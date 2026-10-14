namespace Drawcode
{
    public static class AdcModule
    {
        [Drawcode(Direction.In, Unit = "LSB", Alias = "原始采样值", Note = "上电后需校准")]
        public static short g_raw;

        [Drawcode(Direction.Out, Unit = "LSB", Alias = "滤波输出")]
        public static short g_filtered;

        [Drawcode(Alias = "ADC 采样", Tooltip = "上电后需先校准")]
        [Device(Vendor = "TI", Model = "ADS1115", Spec = "16bit/860SPS", Size = "2.0x3.0mm", Asset = "assets/ads1115.svg")]
        public static short AdcRead()
        {
            short v = g_raw;
            DspModule.FirApply();
            g_filtered = v;
            return v;
        }
    }
}
