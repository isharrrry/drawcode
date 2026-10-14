#include "dsp.h"

void fir_apply(void)
{
    int i;
    for (i = 0; i < 32; i++)
    {
        g_filtered = (int16_t)(g_coeff[i] + g_raw);
    }
}

void dsp_set_gain(uint8_t gain)
{
    g_coeff[0] = (float)gain;
}
