namespace Drawcode.Metadata;

/// <summary>
/// 与 TypeScript 侧 <c>typescript/src/artifact/model.ts</c> 一一对应的传输对象。
///
/// 这里刻意不引用 drawcode 的源码 IR：产物模型是另一条输入链路，
/// 字段形状由 <c>openspec/changes/add-binary-artifact-viewer/design.md</c> §4 固定。
/// 可选字段用可空类型，序列化时省略 null，避免 TS 侧多一层 null/undefined 判断。
/// </summary>
public sealed class ArtifactModelDto
{
    public ArtifactInfoDto Info { get; set; } = new();
    public List<ArtifactModuleDto> Modules { get; set; } = new();
    public List<ArtifactTypeDto> Types { get; set; } = new();
    public List<ArtifactSignalDto> Signals { get; set; } = new();
    public List<ArtifactFuncDto> Funcs { get; set; } = new();
    public List<ArtifactEdgeDto> Edges { get; set; } = new();
    public List<DiagnosticDto> Diagnostics { get; set; } = new();
}

public sealed class ArtifactInfoDto
{
    public string Path { get; set; } = "";
    public string Format { get; set; } = "pe-cli";
    public string Arch { get; set; } = "";
    public string Kind { get; set; } = "dll";
    public bool HasMetadata { get; set; }
    public int MetadataVersion { get; set; }
    public string? EntryPoint { get; set; }
    public string? Version { get; set; }
    public string? FileVersion { get; set; }
    public string? ProductVersion { get; set; }
    public string? Culture { get; set; }
    public string? TargetFramework { get; set; }
    public long? FileSize { get; set; }
}

public sealed class ArtifactModuleDto
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Path { get; set; } = "";
    public string Kind { get; set; } = "assembly";
    public List<string> Children { get; set; } = new();
    public bool Root { get; set; }
    public bool Exclude { get; set; }
    public ModuleCountsDto Counts { get; set; } = new();
}

public sealed class ModuleCountsDto
{
    public int Signals { get; set; }
    public int Funcs { get; set; }
    public int Types { get; set; }
}

public sealed class ArtifactTypeDto
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "class";
    public string Path { get; set; } = "";
    public string? Alias { get; set; }
    public string? Note { get; set; }
    public List<string> Tags { get; set; } = new();
    public bool Store { get; set; }
    public bool Exclude { get; set; }
    public List<TypeFieldDto> Fields { get; set; } = new();
    public long Size { get; set; }
}

public sealed class TypeFieldDto
{
    public string Name { get; set; } = "";
    public string Ctype { get; set; } = "";
    public string? TypeId { get; set; }
    public long Offset { get; set; }
    public long Size { get; set; }
    public string? Initial { get; set; }
    public List<string> Tags { get; set; } = new();
}

public sealed class ArtifactSignalDto
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Ctype { get; set; } = "";
    public string Dir { get; set; } = "";
    public string Unit { get; set; } = "";
    public string Alias { get; set; } = "";
    public string Note { get; set; } = "";
    public List<string> Tags { get; set; } = new();
    public string Path { get; set; } = "";
    public string? OwnerType { get; set; }
    public long? FieldOffset { get; set; }
    public string? Initial { get; set; }
    public bool Exclude { get; set; }
    public bool External { get; set; }
    public bool Inferred { get; set; }
    public string? Address { get; set; }
}

public sealed class ArtifactFuncDto
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Ret { get; set; } = "";
    public List<ArtifactParamDto> Params { get; set; } = new();
    public string Path { get; set; } = "";
    public string? Alias { get; set; }
    public string? Note { get; set; }
    public List<string> Tags { get; set; } = new();
    public List<string> Reads { get; set; } = new();
    public List<string> Writes { get; set; } = new();
    public List<string> Calls { get; set; } = new();
    public bool Exclude { get; set; }
    public bool External { get; set; }
    public string? Address { get; set; }
}

public sealed class ArtifactParamDto
{
    public string Name { get; set; } = "";
    public string Ctype { get; set; } = "";
    public string Dir { get; set; } = "";
}

public sealed class ArtifactEdgeDto
{
    public string Src { get; set; } = "";
    public string Dst { get; set; } = "";
    public string Kind { get; set; } = "";
    public bool Inferred { get; set; }
}

public sealed class DiagnosticDto
{
    public string Severity { get; set; } = "warning";
    public string Code { get; set; } = "";
    public string Message { get; set; } = "";
    public string? Subject { get; set; }
}
