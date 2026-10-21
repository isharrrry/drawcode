#ifndef PLAIN_SENSOR_H
#define PLAIN_SENSOR_H

/*
 * 无元数据演示的头文件。
 *
 * 这里刻意不引用 DrawcodeMeta.h，也不写任何 @drawcode 注释：产物里没有
 * dc_meta_entries 段。读取器只能从 ELF 符号表里认出这些函数和全局对象。
 */

extern float g_sensor_raw;
extern float g_sensor_ready;

void sensor_read(void);
void sensor_calibrate(float bias);

#endif
