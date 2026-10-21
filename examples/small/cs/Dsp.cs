// 与 Adc.cs 配对：这里覆盖 enum、record（含主构造参数的属性元数据）、
// 数组信号与更多函数，让读取器常见的 .NET 元素类型都有样本。
using System;

namespace Drawcode
{
    /// <summary>窗函数。默认成员 Rectangular 的值为 0，读取器会据此推出信号初值。</summary>
    public enum DspWindow
    {
        Rectangular = 0,
        Hann = 1,
        Blackman = 2,
    }

    /// <summary>
    /// 滤波配置。record 在 IL 里没有专门标记，读取器靠 <c>&lt;Clone&gt;$</c> 与
    /// <c>PrintMembers</c> 判定；Store=true 让它作为持久化数据出现。
    /// 主构造参数上的 <c>[property: Drawcode(...)]</c> 是属性级元数据的样本。
    /// </summary>
    [Drawcode(Store = true, Alias = "滤波配置", Note = "带主构造参数的 record")]
    public sealed record DspConfig(
        [property: Drawcode(Unit = "coeff", Alias = "FIR 系数", Initial = "0")] float[] Coefficients,
        [property: Drawcode(Unit = "x", Alias = "增益", Initial = "1")] double Gain,
        [property: Drawcode(Alias = "窗长", Initial = "32")] int Length);

    public static class DspModule
    {
        [Drawcode(Direction.In, Unit = "coeff", Alias = "滤波系数", Path = "dsp/滤波")]
        public static float[] g_coeff = new float[32];

        // record 信号：查看器会为它生成 groupbox，字段里的数组（Coefficients）
        // 必须显示成 `float[]`，不能退化成元素类型。
        [Drawcode(Direction.In, Alias = "滤波配置", Note = "record 结构信号")]
        public static DspConfig g_config = new DspConfig(new float[32], 1.0, 32);

        // 枚举信号：不写 Initial，读取器应自动填默认成员 Rectangular。
        [Drawcode(Direction.In, Alias = "窗函数", Note = "枚举信号，默认 Rectangular")]
        public static DspWindow g_window;

        [Drawcode(Direction.In, Unit = "x", Alias = "增益", Initial = "1")]
        public static double g_gain = 1.0;

        [Drawcode(Direction.Out, Alias = "饱和标志", Initial = "false", Tags = "telemetry")]
        public static bool g_saturated;

        [Drawcode(Direction.Out, Unit = "count", Alias = "处理次数", Initial = "0")]
        public static uint g_frames;

        [Drawcode(Alias = "FIR 滤波", Path = "dsp/滤波", Tags = "io")]
        public static void FirApply()
        {
            double acc = 0;
            for (int i = 0; i < g_coeff.Length; i++)
            {
                acc += g_coeff[i] * AdcModule.g_raw;
            }

            acc *= g_gain;
            g_saturated = acc > short.MaxValue || acc < short.MinValue;
            g_frames++;
            AdcModule.g_filtered = (short)Math.Clamp(acc, short.MinValue, short.MaxValue);
        }

        [Drawcode(Alias = "设置增益", Path = "dsp/配置")]
        public static void SetGain(double gain)
        {
            g_gain = gain;
        }

        [Drawcode(Alias = "配置窗函数", Path = "dsp/配置")]
        public static void ConfigureWindow(DspWindow window)
        {
            g_window = window;
            ApplyWindow();
        }

        [Drawcode(Alias = "应用窗函数")]
        public static void ApplyWindow()
        {
            float k = g_window switch
            {
                DspWindow.Hann => 0.5f,
                DspWindow.Blackman => 0.42f,
                _ => 1.0f,
            };

            for (int i = 0; i < g_coeff.Length; i++)
            {
                g_coeff[i] *= k;
            }
        }

        // Exclude=true：默认树里不显示；打开「显示排除项」后可见。
        [Drawcode(Alias = "复位统计", Exclude = true)]
        public static void ResetCounters()
        {
            g_frames = 0;
            g_saturated = false;
        }
    }
}
