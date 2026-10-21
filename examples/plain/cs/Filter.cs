namespace PlainDemo;

/// <summary>
/// 第二个普通类型，用来验证回退时每个类型都会成为独立模块，
/// 并且跨类型的字段访问也能连成边。
/// </summary>
public static class Filter
{
    /// <summary>滤波增益。</summary>
    public static float Gain = 2.0f;

    /// <summary>滤波后的输出。</summary>
    public static float Output;

    /// <summary>读取 Sensor.Raw，乘增益后写入 Output。</summary>
    public static void Apply()
    {
        Output = Sensor.Raw * Gain;
    }
}
