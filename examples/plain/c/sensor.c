#include "sensor.h"

/*
 * 两个全局对象在符号表里是 STT_OBJECT。读取器会把它们当作“方向未知的信号”，
 * 名称、地址保留，方向和单位留空——不猜一个看起来合理但可能误导的值。
 */
float g_sensor_raw;
float g_sensor_ready;

/*
 * 函数在符号表里是 STT_FUNC。函数体对全局变量的访问由重定位表推断：
 * 读取器只能确定“这个函数碰过这个信号”，因此统一记成 read，并标记 inferred。
 */
void sensor_read(void)
{
    g_sensor_ready = g_sensor_raw * 2.0f;
}

void sensor_calibrate(float bias)
{
    g_sensor_raw = g_sensor_raw + bias;
}
