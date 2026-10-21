// 小样例的 C# 版本：刻意把「程序集元素类型」铺开——
// enum / struct / class 各一个，字段、属性、方法、类型上都挂元数据，
// 让产物视图里的类型种类、字段初值、Store/Root/Path/Tags/Exclude 都有样本可看。
namespace Drawcode
{
    /// <summary>ADC 工作状态。默认值由读取器从「值为 0 的成员」推出，不需要手写。</summary>
    [Drawcode(Alias = "ADC 状态", Note = "调试状态机")]
    public enum AdcState
    {
        Idle = 0,
        Sampling = 1,
        Fault = 2,
    }

    /// <summary>
    /// 校准参数。Store=true 让它在 ER/类型视图里作为持久化数据出现；
    /// 字段上的 Initial 是调试时最常对照的初值。
    /// </summary>
    [Drawcode(Store = true, Alias = "校准参数", Note = "掉电保持")]
    public struct AdcCalibration
    {
        [Drawcode(Unit = "mV", Alias = "零点偏置", Initial = "0")]
        public double Offset;

        [Drawcode(Unit = "LSB/mV", Alias = "增益系数", Initial = "1")]
        public double Gain;

        [Drawcode(Alias = "有效标志", Initial = "false")]
        public bool Valid;
    }

    /// <summary>
    /// ADC 模块。Root 让模块树默认只列根节点；
    /// Path 把信号/函数挂到两级模块下，用来演示带层级路径的导出。
    /// </summary>
    [Drawcode(Root = "adc", Alias = "ADC 模块", Note = "采样与前端校准")]
    public static class AdcModule
    {
        [Drawcode(Direction.In, Unit = "LSB", Alias = "原始采样值",
            Note = "上电后需校准", Path = "adc/采样前端", Tags = "telemetry,rmem")]
        public static short g_raw;

        [Drawcode(Direction.Out, Unit = "LSB", Alias = "滤波输出", Tags = "telemetry")]
        public static short g_filtered;

        // 枚举信号：不写 Initial，读取器应自动填默认成员 Idle。
        [Drawcode(Direction.In, Alias = "工作状态", Note = "枚举信号，默认 Idle")]
        public static AdcState g_state;

        [Drawcode(Direction.In, Alias = "校准参数", Note = "掉电保持", Tags = "store")]
        public static AdcCalibration g_calibration;

        [Drawcode(Direction.In, Alias = "采样计数", Initial = "0", Tags = "telemetry")]
        public static uint g_sample_count;

        // 字节数组信号：树上必须显示成 `[byte[]]`，而不是 `[byte]`。
        [Drawcode(Direction.In, Alias = "原始缓冲区", Note = "数组类型样本", Tags = "telemetry")]
        public static byte[] g_buffer = new byte[64];

        [Drawcode(Alias = "ADC 采样", Tooltip = "上电后需先校准",
            Path = "adc/采样前端", Tags = "io")]
        [Device(Vendor = "TI", Model = "ADS1115", Spec = "16bit/860SPS",
            Size = "2.0x3.0mm", Asset = "assets/ads1115.svg")]
        public static short AdcRead()
        {
            short v = (short)(g_raw + g_buffer[0] + g_calibration.Offset / g_calibration.Gain);
            g_sample_count++;
            DspModule.FirApply();
            g_filtered = v;
            g_state = AdcState.Sampling;
            return v;
        }

        [Drawcode(Alias = "配置增益", Path = "adc/配置", Tags = "control")]
        public static void AdcConfigure(byte gain)
        {
            g_calibration.Gain = gain;
            g_state = AdcState.Idle;
        }

        // Exclude=true：默认树里不显示，打开「显示排除项」后才出现。
        // 它仍然参与 IL 扫描，g_calibration 的写边不会丢。
        [Drawcode(Alias = "执行校准", Exclude = true)]
        public static void AdcCalibrate()
        {
            g_calibration.Offset = 0;
            g_calibration.Valid = true;
        }

        [Drawcode(Alias = "故障复位", Path = "adc/配置")]
        public static void AdcFaultReset()
        {
            if (g_state == AdcState.Fault)
            {
                g_state = AdcState.Idle;
            }

            g_filtered = 0;
        }
    }
}
