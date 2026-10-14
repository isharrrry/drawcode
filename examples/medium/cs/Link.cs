namespace Drawcode.Medium
{
    public static class LinkModule
    {
        [Drawcode(Direction.Out, Unit = "frame", Alias = "待发帧")]
        public static byte[] g_tx_frame = new byte[8];

        [Drawcode(Direction.In, Alias = "链路使能")]
        [Device(Vendor = "FTDI", Model = "FT232H", Spec = "USB2.0/12Mbaud", Asset = "assets/ft232h.svg")]
        public static int LinkReady()
        {
            return AdcModule.g_sample_rate > 0 ? 1 : 0;
        }

        [Drawcode(Alias = "发送一帧")]
        public static void LinkSend()
        {
            for (int i = 0; i < 8; i++)
            {
                g_tx_frame[i] = (byte)(FilterModule.g_filtered >> (i * 2));
            }
        }

        [Drawcode(Alias = "控制步进", Note = "读滤波结果、发帧、调增益")]
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
    }
}
