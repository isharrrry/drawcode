#include "adc.h"
#include "dsp.h"

int16_t adc_read(void)
{
    int16_t v = 0;
    v = g_raw;
    fir_apply();
    g_filtered = v;
    return v;
}
