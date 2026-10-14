#include "adc.h"
#include "filter.h"

void filter_apply(void)
{
    int i;
    int32_t acc = 0;
    for (i = 0; i < 16; i++)
    {
        acc += (int32_t)(g_coeff[i] * g_raw);
    }
    g_filtered = (int16_t)(acc >> 8);
}

void filter_reset(void)
{
    g_filtered = 0;
}
