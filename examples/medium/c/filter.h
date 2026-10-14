#ifndef MEDIUM_FILTER_H
#define MEDIUM_FILTER_H

#include <stdint.h>

/// @drawcode dir=out unit="LSB" alias="滤波输出"
int16_t g_filtered;

/// @drawcode dir=in unit="coeff" alias="FIR 系数" size="240x72"
float g_coeff[16];

/// @drawcode alias="执行一次 FIR"
void filter_apply(void);

/// @drawcode alias="重置历史"
void filter_reset(void);

#endif
