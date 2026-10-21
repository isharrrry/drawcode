namespace PlainDemo;

/// <summary>
/// 普通静态类，没有任何 drawcode 特性。
///
/// 回退规则：静态字段当作方向未知的信号，方法当作函数；方法体里对字段的
/// ldsfld/stsfld 由 IL 扫描补成推断边。
/// </summary>
public static class Sensor
{
    /// <summary>传感器原始读数。</summary>
    public static float Raw;

    /// <summary>最近一次读数是否就绪；这里用 float 保持字段类型简单。</summary>
    public static float Ready;

    /// <summary>读一次传感器，写入 Raw 与 Ready。</summary>
    public static void Read()
    {
        Raw = ReadAdc();
        Ready = 1.0f;
    }

    /// <summary>按偏差校准 Raw。</summary>
    public static void Calibrate(float bias)
    {
        Raw += bias;
    }

    private static float ReadAdc()
    {
        return 0.5f;
    }
}
