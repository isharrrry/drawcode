#ifndef ADC_H
#define ADC_H

#include <stdint.h>

/// @drawcode dir=in unit="LSB" alias="原始采样值" note="上电后需校准"
int16_t g_raw;

/// @drawcode dir=out unit="LSB" alias="滤波输出"
int16_t g_filtered;

/// @drawcode alias="ADC 采样" xy="420,160" size="180x72" tooltip="上电后需先校准"
/// @device vendor="TI" model="ADS1115" spec="16bit/860SPS" size="2.0x3.0mm" asset="assets/ads1115.svg"
int16_t adc_read(void);

#endif
