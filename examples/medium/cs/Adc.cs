namespace Drawcode.Medium
{
    public static class AdcModule
    {
        [Drawcode(Direction.Out, Unit = "LSB", Alias = "原始采样", Note = "上电后需校准，见数据手册第 8 节")]
        public static short g_raw;

        [Drawcode(Direction.In, Unit = "code", Alias = "可编程增益", Note = "0..7，对应 1x..128x")]
        public static byte g_gain;

        [Drawcode(Direction.In, Unit = "Hz", Alias = "采样率")]
        public static uint g_sample_rate;

        [Drawcode(Direction.Out, Unit = "bool", Alias = "数据就绪")]
        [Device(Vendor = "TI", Model = "ADS1115", Spec = "16bit/860SPS", Size = "2.0x3.0mm", Asset = "assets/ads1115.svg")]
        public static int AdcSample()
        {
            g_raw = (short)(g_gain * 16);
            return g_raw != 0 ? 1 : 0;
        }

        [Drawcode(Alias = "配置增益")]
        public static void AdcSetGain(byte gain)
        {
            g_gain = gain;
        }
    }
}
