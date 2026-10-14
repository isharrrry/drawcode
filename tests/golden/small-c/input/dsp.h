#ifndef DSP_H
#define DSP_H

#include <stdint.h>

/// @drawcode dir=in unit="coeff" alias="滤波系数"
float g_coeff[32];

/// @drawcode alias="FIR 滤波"
void fir_apply(void);

/// @drawcode alias="设置增益"
void dsp_set_gain(uint8_t gain);

#endif
