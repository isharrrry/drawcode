#include "link.h"
#include "adc.h"
#include "filter.h"

int link_ready(void)
{
    return g_sample_rate > 0;
}

void link_send(void)
{
    int i;
    for (i = 0; i < 8; i++)
    {
        g_tx_frame[i] = (uint8_t)(g_filtered >> (i * 2));
    }
}

void control_step(void)
{
    if (!link_ready())
    {
        return;
    }
    adc_sample();
    filter_apply();
    link_send();
    adc_set_gain(g_gain + 1);
}
