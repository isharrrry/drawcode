#ifndef MEDIUM_LINK_H
#define MEDIUM_LINK_H

#include <stdint.h>

/// @drawcode dir=out unit="frame" alias="待发帧"
uint8_t g_tx_frame[8];

/// @drawcode dir=in alias="链路使能"
/// @device vendor="FTDI" model="FT232H" spec="USB2.0/12Mbaud" asset="assets/ft232h.svg"
int link_ready(void);

/// @drawcode alias="发送一帧"
void link_send(void);

/// @drawcode alias="控制步进" note="读滤波结果、发帧、调增益"
void control_step(void);

#endif
