namespace Drawcode.Medium
{
    public static class FilterModule
    {
        [Drawcode(Direction.Out, Unit = "LSB", Alias = "滤波输出")]
        public static short g_filtered;

        [Drawcode(Direction.In, Unit = "coeff", Alias = "FIR 系数")]
        public static float[] g_coeff = new float[16];

        [Drawcode(Alias = "执行一次 FIR")]
        public static void FilterApply()
        {
            int acc = 0;
            for (int i = 0; i < 16; i++)
            {
                acc += (int)(g_coeff[i] * AdcModule.g_raw);
            }

            g_filtered = (short)(acc >> 8);
        }

        [Drawcode(Alias = "重置历史")]
        public static void FilterReset()
        {
            g_filtered = 0;
        }
    }
}
