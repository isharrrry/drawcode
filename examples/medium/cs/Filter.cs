// 中等样例的滤波模块：record 描述配置，enum 描述窗函数，
// 用来覆盖与 ADC 模块不同的元素类型。
namespace Drawcode.Medium
{
    /// <summary>FIR 窗函数。默认矩形窗的值为 0。</summary>
    public enum FilterWindow
    {
        Rectangular = 0,
        Hann = 1,
        Blackman = 2,
    }

    /// <summary>滤波配置。Store=true 让它在持久化数据视图里出现。</summary>
    [Drawcode(Store = true, Alias = "滤波配置")]
    public sealed record FilterConfig(
        [property: Drawcode(Unit = "coeff", Alias = "系数", Initial = "0")] float[] Coefficients,
        [property: Drawcode(Alias = "抽头数", Initial = "16")] int Taps,
        [property: Drawcode(Alias = "窗函数")] FilterWindow Window);

    public static class FilterModule
    {
        [Drawcode(Direction.Out, Unit = "LSB", Alias = "滤波输出", Tags = "telemetry")]
        public static short g_filtered;

        [Drawcode(Direction.In, Unit = "coeff", Alias = "FIR 系数", Path = "filter/系数")]
        public static float[] g_coeff = new float[16];

        // 枚举信号：不写 Initial，读取器应自动填默认成员 Rectangular。
        [Drawcode(Direction.In, Alias = "窗函数")]
        public static FilterWindow g_window;

        [Drawcode(Direction.Out, Alias = "饱和计数", Initial = "0", Tags = "telemetry")]
        public static uint g_saturation_count;

        [Drawcode(Alias = "执行一次 FIR", Path = "filter/运算", Tags = "io")]
        public static void FilterApply()
        {
            int acc = 0;
            for (int i = 0; i < 16; i++)
            {
                acc += (int)(g_coeff[i] * AdcModule.g_raw);
            }

            acc >>= 8;
            if (acc > short.MaxValue || acc < short.MinValue)
            {
                g_saturation_count++;
            }

            g_filtered = (short)acc;
        }

        [Drawcode(Alias = "重置历史", Path = "filter/运算")]
        public static void FilterReset()
        {
            g_filtered = 0;
            g_saturation_count = 0;
        }

        [Drawcode(Alias = "配置窗函数", Path = "filter/配置")]
        public static void FilterConfigure(FilterWindow window)
        {
            g_window = window;
            float k = window switch
            {
                FilterWindow.Hann => 0.5f,
                FilterWindow.Blackman => 0.42f,
                _ => 1.0f,
            };

            for (int i = 0; i < g_coeff.Length; i++)
            {
                g_coeff[i] *= k;
            }
        }
    }
}
