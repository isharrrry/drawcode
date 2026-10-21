// 中等样例的 ADC 模块：除信号流外，补上枚举与持久化结构体，
// 让「类型种类 / Store / 字段初值」在中等规模下也有样本。
namespace Drawcode.Medium
{
    /// <summary>可编程增益档位。默认档位 Gain1 的值为 0。</summary>
    [Drawcode(Alias = "增益档位")]
    public enum AdcRange
    {
        Gain1 = 0,
        Gain2 = 1,
        Gain4 = 2,
        Gain8 = 3,
    }

    /// <summary>两点校准参数，掉电保持。</summary>
    [Drawcode(Store = true, Alias = "采样校准")]
    public struct AdcCalibration
    {
        [Drawcode(Unit = "LSB", Alias = "零点", Initial = "0")]
        public short Zero;

        [Drawcode(Unit = "LSB", Alias = "满量程", Initial = "32767")]
        public short FullScale;
    }

    public static class AdcModule
    {
        [Drawcode(Direction.Out, Unit = "LSB", Alias = "原始采样",
            Note = "上电后需校准，见数据手册第 8 节", Path = "adc/采样")]
        public static short g_raw;

        [Drawcode(Direction.In, Unit = "code", Alias = "可编程增益",
            Note = "0..7，对应 1x..128x", Tags = "config")]
        public static byte g_gain;

        [Drawcode(Direction.In, Unit = "Hz", Alias = "采样率", Initial = "1000")]
        public static uint g_sample_rate;

        // 枚举信号：不写 Initial，读取器应自动填默认成员 Gain1。
        [Drawcode(Direction.In, Alias = "增益档位")]
        public static AdcRange g_range;

        [Drawcode(Direction.In, Alias = "采样校准", Tags = "store")]
        public static AdcCalibration g_calibration;

        [Drawcode(Direction.Out, Unit = "bool", Alias = "数据就绪")]
        [Device(Vendor = "TI", Model = "ADS1115", Spec = "16bit/860SPS",
            Size = "2.0x3.0mm", Asset = "assets/ads1115.svg")]
        public static int AdcSample()
        {
            g_raw = (short)(g_gain * 16 + g_calibration.Zero);
            return g_raw != 0 ? 1 : 0;
        }

        [Drawcode(Alias = "配置增益", Path = "adc/配置", Tags = "control")]
        public static void AdcSetGain(byte gain)
        {
            g_gain = gain;
            g_range = (AdcRange)(gain & 0x03);
        }

        [Drawcode(Alias = "设置采样率", Path = "adc/配置")]
        public static void AdcSetRate(uint hz)
        {
            g_sample_rate = hz;
        }

        // 默认隐藏：偏产线流程，不属于运行时数据流。
        [Drawcode(Alias = "写入满量程", Exclude = true)]
        public static void AdcCalibrateFullScale(short value)
        {
            g_calibration.FullScale = value;
        }
    }
}
