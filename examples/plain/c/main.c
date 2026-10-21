#include <stdio.h>

#include "sensor.h"

/*
 * 可执行文件的入口。它同样没有元数据，读取器会把它当成普通函数，
 * 并把对两个全局对象的访问补成推断边。
 */
int main(void)
{
    g_sensor_raw = 1.0f;
    sensor_read();
    sensor_calibrate(0.5f);
    printf("sensor=%.2f ready=%.2f\n", g_sensor_raw, g_sensor_ready);
    return 0;
}
