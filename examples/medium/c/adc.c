#include "adc.h"

int adc_sample(void)
{
    g_raw = (int16_t)(g_gain * 16);
    return g_raw != 0;
}

void adc_set_gain(uint8_t gain)
{
    g_gain = gain;
}
