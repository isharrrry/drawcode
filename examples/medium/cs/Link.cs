// 中等样例的链路模块：枚举状态机 + 持久化统计结构体，
// 让三层数据流（ADC → 滤波 → 链路）里每层都有不同的类型样本。
namespace Drawcode.Medium
{
    /// <summary>链路状态机。默认 Down 的值为 0。</summary>
    public enum LinkState
    {
        Down = 0,
        Idle = 1,
        Sending = 2,
        Error = 3,
    }

    /// <summary>链路统计，掉电保持。</summary>
    [Drawcode(Store = true, Alias = "链路统计")]
    public struct LinkStats
    {
        [Drawcode(Alias = "发送帧数", Initial = "0")]
        public uint Sent;

        [Drawcode(Alias = "接收帧数", Initial = "0")]
        public uint Received;

        [Drawcode(Alias = "错误计数", Initial = "0")]
        public uint Errors;
    }

    public static class LinkModule
    {
        [Drawcode(Direction.Out, Unit = "frame", Alias = "待发帧", Path = "link/发送")]
        public static byte[] g_tx_frame = new byte[8];

        [Drawcode(Direction.In, Alias = "链路使能", Tags = "config")]
        public static bool g_enabled;

        // 枚举信号：不写 Initial，读取器应自动填默认成员 Down。
        [Drawcode(Direction.In, Alias = "链路状态")]
        public static LinkState g_state;

        [Drawcode(Direction.In, Alias = "链路统计", Tags = "store")]
        public static LinkStats g_stats;

        [Drawcode(Direction.In, Alias = "链路使能")]
        [Device(Vendor = "FTDI", Model = "FT232H", Spec = "USB2.0/12Mbaud",
            Asset = "assets/ft232h.svg")]
        public static int LinkReady()
        {
            return g_enabled ? 1 : 0;
        }

        [Drawcode(Alias = "发送一帧", Path = "link/发送", Tags = "io")]
        public static void LinkSend()
        {
            for (int i = 0; i < 8; i++)
            {
                g_tx_frame[i] = (byte)(FilterModule.g_filtered >> (i * 2));
            }

            g_stats.Sent++;
            g_state = LinkState.Sending;
        }

        [Drawcode(Alias = "控制步进", Note = "读滤波结果、发帧、调增益", Path = "link/控制")]
        public static void ControlStep()
        {
            if (LinkReady() == 0)
            {
                return;
            }

            AdcModule.AdcSample();
            FilterModule.FilterApply();
            LinkSend();
            AdcModule.AdcSetGain((byte)(AdcModule.g_gain + 1));
        }

        [Drawcode(Alias = "链路复位", Path = "link/控制")]
        public static void LinkReset()
        {
            g_state = LinkState.Idle;
            g_stats.Errors++;
            g_enabled = false;
        }
    }
}
