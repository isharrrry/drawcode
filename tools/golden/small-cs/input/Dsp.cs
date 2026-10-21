namespace Drawcode
{
    public static class DspModule
    {
        [Drawcode(Direction.In, Unit = "coeff", Alias = "滤波系数")]
        public static float[] g_coeff = new float[32];

        [Drawcode(Alias = "FIR 滤波")]
        public static void FirApply()
        {
            for (int i = 0; i < 32; i++)
            {
                g_filtered = (short)(g_coeff[i] + g_raw);
            }
        }

        [Drawcode(Alias = "设置增益")]
        public static void SetGain(byte gain)
        {
            g_coeff[0] = (float)gain;
        }
    }
}
