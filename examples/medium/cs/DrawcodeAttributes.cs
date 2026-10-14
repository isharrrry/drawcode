namespace Drawcode;

/// <summary>Signal direction, as consumed by <see cref="DrawcodeAttribute"/>.</summary>
public enum Direction
{
    /// <summary>Not a signal — the annotated member is only documented.</summary>
    None,

    /// <summary>Produced by the module (a source of data).</summary>
    In,

    /// <summary>Consumed by the module (a sink of data).</summary>
    Out,

    /// <summary>Bidirectional.</summary>
    Io,
}

/// <summary>
/// Marks a field, property or method as part of the generated diagram, and carries the
/// metadata that used to live in a <c>/// &lt;drawcode ... /&gt;</c> comment.
/// </summary>
/// <remarks>
/// Copy this file into your project once. It is plain source with no dependency on the
/// drawcode toolchain, so the attributes compile into your assembly like any other type.
/// The declaration layer is written back by <c>drawcode sync</c>; everything below the
/// declarations is never touched.
/// </remarks>
[AttributeUsage(AttributeTargets.Field | AttributeTargets.Property | AttributeTargets.Method)]
public sealed class DrawcodeAttribute : Attribute
{
    public DrawcodeAttribute(Direction direction = Direction.None) => Direction = direction;

    /// <summary>Signal direction. Positional so an editor completes <c>Direction.</c> for you.</summary>
    public Direction Direction { get; }

    /// <summary>Physical unit, shown on the node.</summary>
    public string? Unit { get; set; }

    /// <summary>Human-readable name, shown instead of the identifier.</summary>
    public string? Alias { get; set; }

    /// <summary>Longer prose attached to the node.</summary>
    public string? Note { get; set; }

    /// <summary>Hover text in draw.io.</summary>
    public string? Tooltip { get; set; }

    /// <summary>Render the node in the dashed "external" style.</summary>
    public bool External { get; set; }

    /// <summary>Image path recorded on the node. The path is recorded, never resolved.</summary>
    public string? Asset { get; set; }

    /// <summary>
    /// Container hierarchy, e.g. <c>"adc/采样前端"</c>. Slash-separated; each segment becomes a
    /// nested box and the last one is the node's own box title. Omit it and the container falls
    /// back to the module name (<c>Adc.cs</c> -&gt; <c>Adc</c>), so existing sources need no change.
    /// </summary>
    public string? Path { get; set; }
}

/// <summary>Marks the accessor of an external device, e.g. <c>AdcRead()</c>.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class DeviceAttribute : Attribute
{
    /// <summary>Device manufacturer.</summary>
    public string? Vendor { get; set; }

    /// <summary>Part number.</summary>
    public string? Model { get; set; }

    /// <summary>Free-form specification string, e.g. <c>16bit/860SPS</c>.</summary>
    public string? Spec { get; set; }

    /// <summary>Package size, e.g. <c>2.0x3.0mm</c>.</summary>
    public string? Size { get; set; }

    /// <summary>Image path recorded on the node.</summary>
    public string? Asset { get; set; }
}
