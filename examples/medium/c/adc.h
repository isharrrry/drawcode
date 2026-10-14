#ifndef MEDIUM_ADC_H
#define MEDIUM_ADC_H

#include <stdint.h>

/// @drawcode dir=out unit="LSB" alias="原始采样" note="上电后需校准，见数据手册第 8 节"
int16_t g_raw;

/// @drawcode dir=in unit="code" alias="可编程增益" note="0..7，对应 1x..128x"
uint8_t g_gain;

/// @drawcode dir=in unit="Hz" alias="采样率" xy="60,60" size="180x72"
uint32_t g_sample_rate;

/// @drawcode dir=out unit="bool" alias="数据就绪"
/// @device vendor="TI" model="ADS1115" spec="16bit/860SPS" size="2.0x3.0mm" asset="assets/ads1115.svg"
int adc_sample(void);

/// @drawcode alias="配置增益"
void adc_set_gain(uint8_t gain);

#endif
