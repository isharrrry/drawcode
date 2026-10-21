using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

namespace Drawcode.Metadata;

/// <summary>
/// 把一个带 CLI 元数据的 PE 产物翻成 <see cref="ArtifactModelDto"/>。
///
/// 三个阶段，顺序不能换：
/// 1. 类型表：先给每个类型分配稳定 id，后面的字段与方法都靠它派生 id；
/// 2. 成员表：字段/属性 -> 类型字段与信号，同时记下「字段句柄 -> 信号 id」；
/// 3. 方法表：读 IL，把 ldsfld/stsfld 的 token 翻回信号 id。
///    字段阶段没跑完时，读边会指向不存在的信号。
/// </summary>
internal sealed class ModelBuilder
{
    private const string DrawcodeAttributeName = "DrawcodeAttribute";
    private const string DeviceAttributeName = "DeviceAttribute";
    private const string DirectionEnumName = "Direction";

    private readonly MetadataReader _reader;
    private readonly PEReader _pe;
    private readonly TypeNameProvider _typeNames = new();
    private readonly AttributeTypeProvider _attributeTypes;
    private readonly ArtifactModelDto _model;

    /// <summary>程序集名，作为稳定 id 的前缀。没有 Assembly 表（netmodule）时退化为文件名。</summary>
    private readonly string _stem;

    private readonly DiagnosticBag _diagnostics = new();
    private readonly Dictionary<TypeDefinitionHandle, string> _typeIdByHandle = new();
    /// <summary>反向表：稳定 id → 类型定义句柄，算结构体布局时按 id 找回定义。</summary>
    private readonly Dictionary<string, TypeDefinitionHandle> _handleByTypeId = new(StringComparer.Ordinal);
    /// <summary>已经算完布局的结构体 id；避免嵌套结构体重复计算。</summary>
    private readonly HashSet<string> _layoutDone = new(StringComparer.Ordinal);
    /// <summary>正在计算的结构体 id，用来阻断非法的值类型自包含。</summary>
    private readonly HashSet<string> _layoutBusy = new(StringComparer.Ordinal);
    /// <summary>类型全名 → 稳定 id；信号签名只带名字时用它找回枚举类型。</summary>
    private readonly Dictionary<string, string> _typeIdByQualified = new(StringComparer.Ordinal);
    /// <summary>枚举类型 id → 默认（值为 0）成员名，用于给枚举信号补初值。</summary>
    private readonly Dictionary<string, string> _enumDefaultByTypeId = new(StringComparer.Ordinal);
    private readonly Dictionary<FieldDefinitionHandle, string> _signalIdByField = new();
    private readonly Dictionary<MethodDefinitionHandle, string> _funcIdByHandle = new();
    private readonly Dictionary<string, (int Signals, int Funcs)> _countsByOwner = new();
    private readonly Dictionary<int, string> _directionNames = new();
    private readonly HashSet<string> _rootModuleIds = new();
    private readonly HashSet<string> _externalSignals = new();

    /// <summary>
    /// 整个程序集都没有 [Drawcode]/[Device] 时，把静态字段当作方向未知的信号。
    /// 这是“浏览普通程序集”的回退，不参与已接入模板的产物。
    /// </summary>
    private bool _signalFallback;

    /// <summary>是否在产物里找到过任意一个 <c>[Drawcode]</c>；没有就是「普通 .NET 程序集」。</summary>
    public bool FoundDrawcodeMetadata { get; private set; }

    public ModelBuilder(MetadataReader reader, PEReader pe, ArtifactModelDto seed, string stem)
    {
        _reader = reader;
        _pe = pe;
        _model = seed;
        _stem = stem;
        _attributeTypes = new AttributeTypeProvider(reader);
    }

    public ArtifactModelDto Build()
    {
        // 先扫一遍全程序集的特性，决定走“元数据模型”还是“普通程序集回退”。
        // 不能只看类型：示例里的 [Drawcode] 大量挂在字段和方法上，类型本身不标注。
        FoundDrawcodeMetadata = HasAnyDrawcodeMetadata();
        _signalFallback = !FoundDrawcodeMetadata;
        if (_signalFallback)
        {
            _diagnostics.Warn(
                "no-metadata",
                "没有找到 [Drawcode]/[Device] 元数据：按普通 .NET 程序集解析类型、方法与静态字段；信号方向未知",
                _model.Info.Path
            );
        }

        ReadDirectionEnum();
        ScanTypes();
        ScanMembers();
        // 布局必须在成员表之后：Fields 已经过滤掉静态字段与编译器生成字段，
        // 这里只负责给留下的字段补 offset/size，不能凭字段表顺序重排。
        ComputeLayouts();
        ScanMethods();
        BuildModules();

        _model.Types.Sort((a, b) => string.CompareOrdinal(a.Id, b.Id));
        _model.Signals.Sort((a, b) => string.CompareOrdinal(a.Id, b.Id));
        _model.Funcs.Sort((a, b) => string.CompareOrdinal(a.Id, b.Id));
        _model.Edges.Sort(
            (a, b) =>
            {
                var bySrc = string.CompareOrdinal(a.Src, b.Src);
                return bySrc != 0 ? bySrc : string.CompareOrdinal(a.Dst, b.Dst);
            }
        );
        _model.Diagnostics = _diagnostics.Items;
        return _model;
    }

    // ── 1. 类型表 ────────────────────────────────────────────────────

    private void ScanTypes()
    {
        foreach (var handle in _reader.TypeDefinitions)
        {
            if (IsCompilerGenerated(handle)) continue;

            var definition = _reader.GetTypeDefinition(handle);
            var qualified = TypeName.OfDefinition(_reader, handle);
            var id = $"{_stem}::{qualified}";
            var traits = ReadDrawcode(definition.GetCustomAttributes());

            var type = new ArtifactTypeDto
            {
                Id = id,
                Name = _reader.GetString(definition.Name),
                Kind = ClassifyType(definition),
                Path = qualified.Replace('.', '/'),
                // 类型上的 Alias/Note 过去只留在特性里，查看器看不到；
                // 分组与 ER 视图需要它们作为标题旁的短说明。
                Alias = NullIfEmpty(traits?.Alias),
                Note = NullIfEmpty(traits?.Note),
                // tags 同时承载业务标签（Drawcode.Tags）与特性值（Device.Model 等）。
                // 为什么合并：查看器只有一个筛选数据源；分成两个数组会让过滤逻辑
                // 与切片协议各多一条分支，而它们对用户是同一件事——可筛选的短文本。
                Tags = ReadAttributeTags(definition.GetCustomAttributes(), traits),
                Store = traits?.Store ?? false,
                Exclude = traits?.Exclude ?? false,
            };

            if (!string.IsNullOrEmpty(traits?.Root)) _rootModuleIds.Add(id);

            _typeIdByHandle[handle] = id;
            _handleByTypeId[id] = handle;
            _typeIdByQualified[qualified] = id;
            _model.Types.Add(type);
            _countsByOwner[id] = (0, 0);

            // 枚举的“字段”不是内存布局，而是成员表；在这里一次读完，
            // ScanMembers 就不再走普通字段分支（否则会把 value__ 当成子字段）。
            if (type.Kind == "enum") ScanEnumMembers(definition, type);
        }
    }

    /// <summary>
    /// 把枚举成员收进 <see cref="ArtifactTypeDto.Fields"/>，让查看器能像展开结构体
    /// 一样展开枚举定义。`value__` 是编译器生成的底层存储字段，对用户没有意义，
    /// 只用来确定底层类型与字节宽度。
    /// </summary>
    private void ScanEnumMembers(TypeDefinition definition, ArtifactTypeDto type)
    {
        var underlying = "int";
        var size = 4;
        string? zeroName = null;

        foreach (var fieldHandle in definition.GetFields())
        {
            var field = _reader.GetFieldDefinition(fieldHandle);
            var name = _reader.GetString(field.Name);

            if (name == "value__")
            {
                var valueType = field.DecodeSignature(_typeNames, null);
                underlying = valueType.Name;
                size = PrimitiveSize(underlying);
                type.Size = size;
                continue;
            }

            // 只有字面量才是枚举成员；实例字段在合法的枚举里不应存在。
            if ((field.Attributes & FieldAttributes.Literal) == 0) continue;

            var value = ReadConstantValue(field.GetDefaultValue());
            type.Fields.Add(
                new TypeFieldDto
                {
                    Name = name,
                    Ctype = underlying,
                    // 枚举成员没有“结构体偏移”；offset 留 0，避免显示成伪内存布局。
                    Offset = 0,
                    Size = size,
                    Initial = value?.ToString(),
                    Tags = new List<string>(),
                }
            );

            if (value == 0 && zeroName is null) zeroName = name;
        }

        if (type.Size == 0) type.Size = size;
        // C# 枚举的默认值恒为 0；没有显式 0 成员时保留数字，而不是编一个名字。
        _enumDefaultByTypeId[type.Id] = zeroName ?? "0";
    }

    private static int PrimitiveSize(string name) =>
        name switch
        {
            "byte" or "sbyte" or "bool" => 1,
            "short" or "ushort" or "char" => 2,
            "int" or "uint" or "float" => 4,
            "long" or "ulong" or "double" => 8,
            _ => 4,
        };

    /// <summary>
    /// 读枚举成员的常量值。元数据里的 Constant blob 按 TypeCode 定长存放，
    /// 不能统一按 int 读——例如 `enum : byte` 只有 1 字节。
    /// </summary>
    private long? ReadConstantValue(ConstantHandle handle)
    {
        if (handle.IsNil) return null;
        var constant = _reader.GetConstant(handle);
        var blob = _reader.GetBlobReader(constant.Value);
        return constant.TypeCode switch
        {
            ConstantTypeCode.Boolean => blob.ReadBoolean() ? 1 : 0,
            ConstantTypeCode.Char => blob.ReadChar(),
            ConstantTypeCode.SByte => blob.ReadSByte(),
            ConstantTypeCode.Byte => blob.ReadByte(),
            ConstantTypeCode.Int16 => blob.ReadInt16(),
            ConstantTypeCode.UInt16 => blob.ReadUInt16(),
            ConstantTypeCode.Int32 => blob.ReadInt32(),
            ConstantTypeCode.UInt32 => blob.ReadUInt32(),
            ConstantTypeCode.Int64 => blob.ReadInt64(),
            ConstantTypeCode.UInt64 => unchecked((long)blob.ReadUInt64()),
            _ => null,
        };
    }

    /// <summary>
    /// 类型分类。record 在 IL 里没有专门标记，只能看编译器为 record 合成的成员：
    /// `<Clone>$` 是 record class 特有的「克隆」方法，`PrintMembers` 是 record 编译器生成。
    /// 这两者同时出现才判定，避免把普通 class 里同名手写方法误判。
    /// </summary>
    private string ClassifyType(TypeDefinition definition)
    {
        if ((definition.Attributes & TypeAttributes.Interface) != 0) return "interface";

        var baseName = TypeName.ShortOf(_reader, definition.BaseType);
        if (baseName == "Enum") return "enum";
        if (baseName == "ValueType") return "struct";

        var hasClone = false;
        var hasPrintMembers = false;
        foreach (var methodHandle in definition.GetMethods())
        {
            var name = _reader.GetString(_reader.GetMethodDefinition(methodHandle).Name);
            if (name == "<Clone>$") hasClone = true;
            else if (name == "PrintMembers") hasPrintMembers = true;
        }
        return hasClone && hasPrintMembers ? "record" : "class";
    }

    // ── 2. 成员表 ────────────────────────────────────────────────────

    private void ScanMembers()
    {
        foreach (var (handle, typeId) in _typeIdByHandle)
        {
            var definition = _reader.GetTypeDefinition(handle);
            var type = _model.Types.Find(t => t.Id == typeId)!;

            // 枚举成员已在 ScanTypes 里按成员表读取，不再走属性/字段扫描。
            if (type.Kind == "enum") continue;

            // record 的合成属性 EqualityContract、以及手写的计算属性（如统计记录的
            // ErrorUs）也出现在属性表里，但它们不占内存布局——ER 表会把它们当成真实列。
            // 自动属性与 record 主构造参数都带 <Name>k__BackingField；没有它就不算存储字段。
            var backingFields = definition
                .GetFields()
                .Select(h => _reader.GetString(_reader.GetFieldDefinition(h).Name))
                .ToHashSet(StringComparer.Ordinal);

            // 属性先扫：record 的主构造参数会同时生成属性与 <X>k__BackingField 字段，
            // 展示应取属性名，避免把编译器命名漏给用户。
            foreach (var propertyHandle in definition.GetProperties())
            {
                var property = _reader.GetPropertyDefinition(propertyHandle);
                var name = _reader.GetString(property.Name);
                var signature = property.DecodeSignature(_typeNames, null);
                var traits = ReadDrawcode(property.GetCustomAttributes());
                // 标签必须同时包含 Drawcode.Tags 与 [Device]/[Drawcode] 的短特性值：
                // 属性筛选与分组都是按这些标签做的，只取 Tags 会让 [Device(Model=…)]
                // 在界面上凭空消失。
                var propertyTags = ReadAttributeTags(property.GetCustomAttributes(), traits);

                if (backingFields.Contains($"<{name}>k__BackingField"))
                {
                    type.Fields.Add(MakeField(name, signature.ReturnType, propertyTags, traits?.Initial));
                }

                // 属性没有可直接映射的字段句柄（值落在被跳过的 backing field 上），
                // 所以只建信号，不参与 IL 读写解析。
                ConsiderSignal(name, typeId, type.Path, signature.ReturnType, traits, null, propertyTags);
            }

            foreach (var fieldHandle in definition.GetFields())
            {
                var field = _reader.GetFieldDefinition(fieldHandle);
                var name = _reader.GetString(field.Name);
                var attributes = field.Attributes;

                if ((attributes & FieldAttributes.Literal) != 0) continue; // 常量与枚举成员
                if (name.Contains("k__BackingField", StringComparison.Ordinal)) continue; // 由属性代表

                var fieldType = field.DecodeSignature(_typeNames, null);
                var traits = ReadDrawcode(field.GetCustomAttributes());
                var fieldTags = ReadAttributeTags(field.GetCustomAttributes(), traits);
                var isStatic = (attributes & FieldAttributes.Static) != 0;

                if (!isStatic && !name.StartsWith('<'))
                {
                    type.Fields.Add(MakeField(name, fieldType, fieldTags, traits?.Initial));
                }

                // 静态字段即便是信号也不进 Fields：Fields 描述的是「类型的内存布局」。
                ConsiderSignal(name, typeId, type.Path, fieldType, traits, fieldHandle, fieldTags);
            }
        }
    }

    // ── 2.5 布局：字段偏移与大小 ─────────────────────────────────────

    /// <summary>结构体类型 id → 对齐字节数（已算完布局的）。</summary>
    private readonly Dictionary<string, int> _structAlignById = new(StringComparer.Ordinal);

    /// <summary>
    /// 给字段补 offset/size。
    ///
    /// 为什么分开处理：
    ///   - struct（值类型）的 Sequential/Explicit 布局与目标机字节布局一致，调试时
    ///     可以直接按 offset 看内存，值得算；
    ///   - class/record 是托管引用类型，对象头、GC 压缩与字段重排让「偏移」没有
    ///     调试意义，强行算出来只会误导。因此它们只填字段大小，偏移保持 -1。
    /// 元数据没有 FieldLayout 时，按自然对齐累加；遇到大小未知的类型就停算，
    /// 后续字段保持 -1，宁可不显示也不给错位的偏移。
    /// </summary>
    private void ComputeLayouts()
    {
        foreach (var type in _model.Types)
        {
            if (type.Kind == "struct")
            {
                EnsureStructLayout(type);
                continue;
            }
            foreach (var field in type.Fields)
            {
                var handle = FindFieldHandle(type.Id, field.Name);
                field.Size = handle is { } h
                    ? Math.Max(0, LayoutOf(_reader.GetFieldDefinition(h).DecodeSignature(_typeNames, null)).Size)
                    : 0;
            }
        }
    }

    private void EnsureStructLayout(ArtifactTypeDto type)
    {
        if (_layoutDone.Contains(type.Id) || _layoutBusy.Contains(type.Id)) return;
        _layoutBusy.Add(type.Id);

        var definition = _reader.GetTypeDefinition(_handleByTypeId[type.Id]);
        var layout = definition.GetLayout();
        var pack = layout.PackingSize == 0 ? 8 : layout.PackingSize;
        long cursor = 0;
        long maxAlign = 1;
        var reliable = true;

        foreach (var field in type.Fields)
        {
            var handle = FindFieldHandle(type.Id, field.Name);
            if (handle is not { } h)
            {
                field.Offset = -1;
                continue;
            }
            var fieldDefinition = _reader.GetFieldDefinition(h);
            var (size, align) = LayoutOf(fieldDefinition.DecodeSignature(_typeNames, null));
            field.Size = size;

            var explicitOffset = fieldDefinition.GetOffset();
            if (explicitOffset >= 0)
            {
                // Explicit 布局：偏移就是元数据里写的值，字段可以重叠（union）。
                field.Offset = explicitOffset;
                cursor = Math.Max(cursor, explicitOffset + Math.Max(0, size));
                continue;
            }
            if (layout.Size > 0)
            {
                // 有 ClassSize 却没写 FieldLayout：显式布局信息不完整，不能瞎猜。
                field.Offset = -1;
                continue;
            }
            if (!reliable || size < 0)
            {
                reliable = false;
                field.Offset = -1;
                continue;
            }
            var fieldAlign = Math.Min(align <= 0 ? 1 : align, pack);
            cursor = AlignUp(cursor, fieldAlign);
            field.Offset = cursor;
            cursor += size;
            maxAlign = Math.Max(maxAlign, fieldAlign);
        }

        type.Size = layout.Size > 0
            ? layout.Size
            : reliable
                ? AlignUp(Math.Max(cursor, type.Fields.Count == 0 ? 1 : 0), Math.Min((int)maxAlign, pack))
                : 0;
        _structAlignById[type.Id] = (int)Math.Min(maxAlign, pack);

        _layoutBusy.Remove(type.Id);
        _layoutDone.Add(type.Id);
    }

    /// <summary>
    /// 字段的字节大小与自然对齐。
    ///
    /// 返回值 Size = -1 表示类型大小未知（跨程序集的非基本值类型）；
    /// 调用方必须停止累加偏移，而不是把 -1 当成 0。
    /// </summary>
    private (long Size, int Align) LayoutOf(TypeRef type)
    {
        if (type.Handle.Kind == HandleKind.TypeDefinition
            && _typeIdByHandle.TryGetValue((TypeDefinitionHandle)type.Handle, out var id))
        {
            var dto = _model.Types.Find(t => t.Id == id);
            if (dto is not null)
            {
                if (dto.Kind == "enum")
                {
                    var size = dto.Size > 0 ? dto.Size : 4;
                    return (size, (int)Math.Clamp(size, 1, 8));
                }
                if (dto.Kind == "struct")
                {
                    EnsureStructLayout(dto);
                    if (_layoutDone.Contains(dto.Id) && dto.Size > 0)
                    {
                        return (dto.Size, _structAlignById.TryGetValue(dto.Id, out var a) ? a : 1);
                    }
                    return (-1, 1);
                }
                // class / record / interface：字段槽是一个对象引用。
                return (IntPtr.Size, IntPtr.Size);
            }
        }

        var name = type.Name;
        // 数组、泛型、指针、byref、string 在字段里都只占一个指针槽。
        if (name.EndsWith("[]", StringComparison.Ordinal)
            || name.Contains('<')
            || name is "string" or "object" or "fnptr"
            || name.EndsWith("*", StringComparison.Ordinal)
            || name.EndsWith("&", StringComparison.Ordinal))
        {
            return (IntPtr.Size, IntPtr.Size);
        }

        return name switch
        {
            "bool" or "byte" or "sbyte" => (1, 1),
            "short" or "ushort" or "char" => (2, 2),
            "int" or "uint" or "float" => (4, 4),
            "long" or "ulong" or "double" => (8, 8),
            "decimal" => (16, 8),
            "IntPtr" or "UIntPtr" or "nint" or "nuint" => (IntPtr.Size, IntPtr.Size),
            _ => (-1, 1),
        };
    }

    /// <summary>
    /// 字段 DTO 对应的元数据字段句柄。
    ///
    /// record 主构造参数以属性名展示，实际存储在同名的 backing field 上；
    /// 布局必须读 backing field，否则这些字段会永远没有偏移。
    /// </summary>
    private FieldDefinitionHandle? FindFieldHandle(string typeId, string fieldName)
    {
        if (!_handleByTypeId.TryGetValue(typeId, out var typeHandle)) return null;
        var backing = $"<{fieldName}>k__BackingField";
        foreach (var handle in _reader.GetTypeDefinition(typeHandle).GetFields())
        {
            var name = _reader.GetString(_reader.GetFieldDefinition(handle).Name);
            if (name == fieldName || name == backing) return handle;
        }
        return null;
    }

    private static long AlignUp(long value, long align) =>
        align <= 1 ? value : (value + align - 1) / align * align;

    private void ConsiderSignal(
        string name,
        string ownerTypeId,
        string path,
        TypeRef memberType,
        DrawcodeTraits? traits,
        FieldDefinitionHandle? fieldHandle,
        List<string> tags
    )
    {
        if (traits is not { } t)
        {
            ConsiderFallbackSignal(name, ownerTypeId, path, memberType, fieldHandle);
            return;
        }

        var direction = NormalizeDirection(t.Direction);
        if (direction.Length == 0) return; // Direction.None：只标注，不是信号

        AddSignal(
            new ArtifactSignalDto
            {
                Id = SignalId(ownerTypeId, name),
                Name = name,
                Ctype = memberType.Name,
                Dir = direction,
                Unit = t.Unit ?? "",
                Alias = t.Alias ?? "",
                Note = t.Note ?? "",
                Tags = tags,
                Path = path,
                OwnerType = ownerTypeId,
                // 显式 Initial 优先；枚举信号没写时用值为 0 的成员名，
                // 比空着或显示“0”更接近调试时看到的默认状态。
                Initial = NullIfEmpty(t.Initial) ?? DefaultEnumInitial(memberType),
                Exclude = t.Exclude,
                External = t.External,
            },
            ownerTypeId,
            fieldHandle
        );
    }

    /// <summary>
    /// 普通 .NET 程序集的回退：静态字段就是最接近“信号”的东西。
    ///
    /// 不把实例字段算进来：IL 扫描只看 ldsfld/stsfld，实例字段没有边可连，
    /// 放进树里只会得到一堆孤立的端口。方向留空，由视图按实际读写函数补端口。
    /// </summary>
    private void ConsiderFallbackSignal(
        string name,
        string ownerTypeId,
        string path,
        TypeRef memberType,
        FieldDefinitionHandle? fieldHandle
    )
    {
        if (!_signalFallback || fieldHandle is not { } handle) return;
        if (name.StartsWith('<')) return; // 编译器生成字段

        var field = _reader.GetFieldDefinition(handle);
        if ((field.Attributes & FieldAttributes.Static) == 0) return;

        AddSignal(
            new ArtifactSignalDto
            {
                Id = SignalId(ownerTypeId, name),
                Name = name,
                Ctype = memberType.Name,
                Dir = "",
                Path = path,
                OwnerType = ownerTypeId,
                Initial = DefaultEnumInitial(memberType),
                Inferred = true,
            },
            ownerTypeId,
            handle
        );
    }

    /// <summary>
    /// 若成员类型是程序集内枚举，返回其默认（值为 0）成员名。
    /// 句柄优先、全名兜底：签名里的句柄能精确命中同命名空间下的同名类型。
    /// </summary>
    private string? DefaultEnumInitial(TypeRef type)
    {
        string? typeId = null;
        if (!type.Handle.IsNil && type.Handle.Kind == HandleKind.TypeDefinition)
        {
            _typeIdByHandle.TryGetValue((TypeDefinitionHandle)type.Handle, out typeId);
        }
        if (typeId is null) _typeIdByQualified.TryGetValue(type.Name, out typeId);

        return typeId is not null && _enumDefaultByTypeId.TryGetValue(typeId, out var member)
            ? member
            : null;
    }

    private static string SignalId(string ownerTypeId, string name) => $"{ownerTypeId}#{name}";

    private void AddSignal(
        ArtifactSignalDto signal,
        string ownerTypeId,
        FieldDefinitionHandle? fieldHandle
    )
    {
        if (fieldHandle is { } handle)
        {
            _signalIdByField[handle] = signal.Id;
        }
        _model.Signals.Add(signal);

        var counts = _countsByOwner[ownerTypeId];
        _countsByOwner[ownerTypeId] = (counts.Signals + 1, counts.Funcs);
    }

    private TypeFieldDto MakeField(string name, TypeRef type, List<string> tags, string? initial) =>
        new()
        {
            Name = name,
            Ctype = type.Name,
            TypeId = TypeIdOf(type.Handle),
            // -1 = 没有可靠的布局信息；引用类型（class/record）的偏移取决于
            // GC 与对象头，元数据里没有，展示层显示为「—」而不是假的 0。
            Offset = -1,
            Initial = NullIfEmpty(initial),
            Tags = tags,
        };

    private string? TypeIdOf(EntityHandle handle) =>
        handle.Kind == HandleKind.TypeDefinition
        && _typeIdByHandle.TryGetValue((TypeDefinitionHandle)handle, out var id)
            ? id
            : null;

    // ── 3. 方法表与 IL 边 ───────────────────────────────────────────

    private void ScanMethods()
    {
        // 先统计重载：id 只有在同名方法超过一个时才追加参数串，
        // 这样非重载方法的 id 保持 design 规定的最短形式。
        var overloads = new Dictionary<(string TypeId, string Name), int>();
        var candidates = new List<(TypeDefinitionHandle Type, MethodDefinitionHandle Method, string TypeId, string Name)>();

        foreach (var (typeHandle, typeId) in _typeIdByHandle)
        {
            var definition = _reader.GetTypeDefinition(typeHandle);
            foreach (var methodHandle in definition.GetMethods())
            {
                var method = _reader.GetMethodDefinition(methodHandle);
                var name = _reader.GetString(method.Name);

                // 构造函数不是数据流节点；编译器合成的 <...> 方法不是用户写的；
                // 泛型方法在源码解析器里也不成为函数（见测试桩源码的注释），
                // 两侧保持一致，验收数字才对得上。
                if (name is ".ctor" or ".cctor") continue;
                if (name.StartsWith('<')) continue;
                if (method.GetGenericParameters().Count > 0) continue;

                // record 的 ToString/Equals/GetHashCode/Deconstruct 等合成方法名字正常，
                // 只能靠 [CompilerGenerated] 认出来。它们不是用户写的数据流节点。
                if (IsCompilerGeneratedMethod(method)) continue;

                candidates.Add((typeHandle, methodHandle, typeId, name));
                var key = (typeId, name);
                overloads[key] = overloads.GetValueOrDefault(key) + 1;
            }
        }

        foreach (var candidate in candidates)
        {
            var method = _reader.GetMethodDefinition(candidate.Method);
            var signature = method.DecodeSignature(_typeNames, null);
            var id = $"{candidate.TypeId}.{candidate.Name}";
            if (overloads[(candidate.TypeId, candidate.Name)] > 1)
            {
                id += "(" + string.Join(",", signature.ParameterTypes.Select(p => p.Name)) + ")";
            }

            var traits = ReadDrawcode(method.GetCustomAttributes());
            var type = _model.Types.Find(t => t.Id == candidate.TypeId);
            var func = new ArtifactFuncDto
            {
                Id = id,
                Name = candidate.Name,
                Ret = signature.ReturnType.Name,
                Path = type?.Path ?? "",
                Alias = NullIfEmpty(traits?.Alias),
                Note = NullIfEmpty(traits?.Note),
                // 方法与类型走同一套标签采集：业务标签 + Drawcode 短标记 + [Device]
                // 的短特性值。旧实现只取 Drawcode.Tags，导致样例里方法上的
                // [Device(Model = "ADS1115")] 在按属性分组/筛选时完全不可见。
                Tags = ReadAttributeTags(method.GetCustomAttributes(), traits),
                Exclude = traits?.Exclude ?? false,
            };

            var parameterNames = ParameterNames(method, signature.ParameterTypes.Length);
            for (var i = 0; i < signature.ParameterTypes.Length; i++)
            {
                func.Params.Add(
                    new ArtifactParamDto
                    {
                        Name = parameterNames[i] ?? "",
                        Ctype = signature.ParameterTypes[i].Name,
                        Dir = "",
                    }
                );
            }

            _funcIdByHandle[candidate.Method] = id;
            _model.Funcs.Add(func);
            var counts = _countsByOwner[candidate.TypeId];
            _countsByOwner[candidate.TypeId] = (counts.Signals, counts.Funcs + 1);

            ScanBody(method, func);
        }
    }

    /// <summary>
    /// 参数名不在方法签名里，而在 Param 表里，用序号对齐。
    /// 序号 0 是返回值，必须跳过；序号从 1 开始对应第一个参数。
    /// </summary>
    private string?[] ParameterNames(MethodDefinition method, int count)
    {
        var names = new string?[count];
        foreach (var handle in method.GetParameters())
        {
            var parameter = _reader.GetParameter(handle);
            var index = parameter.SequenceNumber - 1;
            if (index >= 0 && index < count) names[index] = _reader.GetString(parameter.Name);
        }
        return names;
    }

    private void ScanBody(MethodDefinition method, ArtifactFuncDto func)
    {
        if (method.RelativeVirtualAddress == 0) return;

        IlScanner.Result scan;
        try
        {
            // 方法体不在元数据表里，而在 PE 的代码段；必须经 PEReader 按 RVA 取。
            var body = _pe.GetMethodBody(method.RelativeVirtualAddress);
            scan = IlScanner.Scan(body.GetILReader());
        }
        catch (BadImageFormatException ex)
        {
            _diagnostics.Warn("truncated-section", $"方法 {func.Id} 的方法体无法解析：{ex.Message}", func.Id);
            return;
        }

        foreach (var token in scan.Reads.Distinct())
        {
            var signal = ResolveField(token);
            if (signal is null || func.Reads.Contains(signal)) continue;
            func.Reads.Add(signal);
            _model.Edges.Add(
                new ArtifactEdgeDto
                {
                    Src = func.Id,
                    Dst = signal,
                    Kind = "read",
                    // 无元数据时这些边完全来自 IL 扫描，不是源码里的 DC_READ 声明。
                    Inferred = _signalFallback,
                }
            );
        }

        foreach (var token in scan.Writes.Distinct())
        {
            var signal = ResolveField(token);
            if (signal is null || func.Writes.Contains(signal)) continue;
            func.Writes.Add(signal);
            _model.Edges.Add(
                new ArtifactEdgeDto
                {
                    Src = func.Id,
                    Dst = signal,
                    Kind = "write",
                    Inferred = _signalFallback,
                }
            );
        }

        foreach (var token in scan.Calls.Distinct())
        {
            var target = ResolveMethod(token);
            if (target is null || func.Calls.Contains(target)) continue;
            func.Calls.Add(target);
            _model.Edges.Add(
                new ArtifactEdgeDto
                {
                    Src = func.Id,
                    Dst = target,
                    Kind = "call",
                    Inferred = _signalFallback,
                }
            );
        }
    }

    private string? ResolveField(int token)
    {
        var handle = MetadataTokens.EntityHandle(token);
        switch (handle.Kind)
        {
            case HandleKind.FieldDefinition:
                return _signalIdByField.GetValueOrDefault((FieldDefinitionHandle)handle);

            case HandleKind.MemberReference:
            {
                var reference = _reader.GetMemberReference((MemberReferenceHandle)handle);
                if (reference.GetKind() != MemberReferenceKind.Field) return null;
                return AddExternalSignal(reference);
            }

            default:
                return null; // 普通字段或局部变量，不是模型关心的边
        }
    }

    private string? ResolveMethod(int token)
    {
        var handle = MetadataTokens.EntityHandle(token);
        switch (handle.Kind)
        {
            case HandleKind.MethodDefinition:
                return _funcIdByHandle.GetValueOrDefault((MethodDefinitionHandle)handle);

            case HandleKind.MethodSpecification:
            {
                // 泛型方法的调用（产出<T>/消费<T>）。目标方法本身被上面的泛型过滤排除，
                // 因此这里通常解析为 null —— 与源码解析器「泛型名不是函数」的口径一致。
                var specification = _reader.GetMethodSpecification((MethodSpecificationHandle)handle);
                return ResolveMethod(MetadataTokens.GetToken(specification.Method));
            }

            // 跨程序集调用（BCL、第三方库）不建节点：一个普通组件方法就会拖出上千条
            // Add/ContainsKey/.ctor 调用，既不是组件间的关系，也会淹没真正的数据流。
            // 需要时由视图层按需开启，读取器不在默认路径上生成。
            default:
                return null;
        }
    }

    /// <summary>外部字段：程序集之外的静态字段被读写时，建一个只展示、不展开的信号。</summary>
    private string AddExternalSignal(MemberReference reference)
    {
        var assembly = ParentAssembly(reference.Parent);
        var owner = ParentTypeName(reference.Parent);
        var name = _reader.GetString(reference.Name);
        var id = $"external:{assembly}::{owner}#{name}";

        if (_externalSignals.Add(id))
        {
            _model.Signals.Add(
                new ArtifactSignalDto
                {
                    Id = id,
                    Name = name,
                    Ctype = "",
                    Dir = "",
                    Path = owner.Replace('.', '/'),
                    External = true,
                    Inferred = true,
                }
            );
        }
        return id;
    }

    /// <summary>
    /// 外部方法的父程序集。Parent 可能是 TypeReference（普通引用），也可能是
    /// TypeSpecification（泛型实例，如 <c>List&lt;int&gt;</c>）—— 后者要先把签名解回真实类型句柄。
    /// </summary>
    private string ParentAssembly(EntityHandle parent) =>
        parent.Kind == HandleKind.TypeSpecification
            ? ParentAssembly(
                _reader.GetTypeSpecification((TypeSpecificationHandle)parent).DecodeSignature(_typeNames, null).Handle
            )
            : ParentAssemblyCore(parent);

    private string ParentAssemblyCore(EntityHandle parent) =>
        parent.Kind == HandleKind.TypeReference
        && _reader.GetTypeReference((TypeReferenceHandle)parent).ResolutionScope is { Kind: HandleKind.AssemblyReference } scope
            ? _reader.GetString(_reader.GetAssemblyReference((AssemblyReferenceHandle)scope).Name)
            : "<module>";

    private string ParentTypeName(EntityHandle parent) =>
        parent.Kind switch
        {
            HandleKind.TypeReference => TypeName.OfReference(_reader, (TypeReferenceHandle)parent),
            HandleKind.TypeDefinition => TypeName.OfDefinition(_reader, (TypeDefinitionHandle)parent),
            HandleKind.TypeSpecification => _reader
                .GetTypeSpecification((TypeSpecificationHandle)parent)
                .DecodeSignature(_typeNames, null)
                .Name,
            _ => "?",
        };

    /// <summary>
    /// 方法是否由编译器合成。record 的 ToString/Equals/GetHashCode/Deconstruct/PrintMembers
    /// 名字和用户方法一样，只有 <c>[CompilerGenerated]</c> 能区分。
    /// </summary>
    private bool IsCompilerGeneratedMethod(MethodDefinition method)
    {
        foreach (var handle in method.GetCustomAttributes())
        {
            var attribute = _reader.GetCustomAttribute(handle);
            if (TypeName.ShortOf(_reader, ConstructorParent(attribute.Constructor)) == "CompilerGeneratedAttribute")
            {
                return true;
            }
        }
        return false;
    }

    private EntityHandle ConstructorParent(EntityHandle constructor) =>
        constructor.Kind switch
        {
            HandleKind.MethodDefinition => _reader
                .GetMethodDefinition((MethodDefinitionHandle)constructor)
                .GetDeclaringType(),
            HandleKind.MemberReference => _reader.GetMemberReference((MemberReferenceHandle)constructor).Parent,
            _ => default,
        };

    // ── 4. 模块树 ───────────────────────────────────────────────────

    /// <summary>
    /// 模块树是 assembly → namespace → type。命名空间按段拆开（A.B.C 生成 A、A.B、A.B.C 三层），
    /// 这样左侧树才能像文件系统一样逐级展开，而不是一屏几十个平铺的完整命名空间。
    /// counts 是**子树**计数：折叠的节点也要能显示「这下面有多少东西」。
    /// </summary>
    private void BuildModules()
    {
        var modules = new Dictionary<string, ArtifactModuleDto>(StringComparer.Ordinal);
        var assemblyId = $"mod::{_stem}";
        modules[assemblyId] = new ArtifactModuleDto
        {
            Id = assemblyId,
            Name = _stem,
            Path = "",
            Kind = "assembly",
        };

        foreach (var type in _model.Types)
        {
            var lastSlash = type.Path.LastIndexOf('/');
            var namespacePath = lastSlash < 0 ? "" : type.Path[..lastSlash].Replace('/', '.');
            var parentId = EnsureNamespace(namespacePath, modules, assemblyId);

            modules[type.Id] = new ArtifactModuleDto
            {
                Id = type.Id,
                Name = type.Name,
                Path = type.Path,
                Kind = "type",
                Root = _rootModuleIds.Contains(type.Id),
            };
            modules[parentId].Children.Add(type.Id);
        }

        foreach (var module in modules.Values)
        {
            module.Children.Sort(StringComparer.Ordinal);
        }

        CountModules(assemblyId, modules, new Dictionary<string, (int, int, int)>(StringComparer.Ordinal));

        _model.Modules.AddRange(modules.Values.OrderBy(m => m.Id, StringComparer.Ordinal));
    }

    private static string EnsureNamespace(
        string namespaceName,
        Dictionary<string, ArtifactModuleDto> modules,
        string assemblyId
    )
    {
        if (namespaceName.Length == 0) return assemblyId;

        var parentId = assemblyId;
        var prefix = "";
        foreach (var segment in namespaceName.Split('.'))
        {
            prefix = prefix.Length == 0 ? segment : prefix + "." + segment;
            var id = $"mod::ns:{prefix}";
            if (!modules.ContainsKey(id))
            {
                modules[id] = new ArtifactModuleDto
                {
                    Id = id,
                    Name = segment,
                    Path = prefix.Replace('.', '/'),
                    Kind = "namespace",
                };
                modules[parentId].Children.Add(id);
            }
            parentId = id;
        }
        return parentId;
    }

    private (int Signals, int Funcs, int Types) CountModules(
        string moduleId,
        Dictionary<string, ArtifactModuleDto> modules,
        Dictionary<string, (int, int, int)> memo
    )
    {
        if (memo.TryGetValue(moduleId, out var cached)) return cached;

        var module = modules[moduleId];
        var (ownSignals, ownFuncs) =
            module.Kind == "type" ? _countsByOwner.GetValueOrDefault(moduleId, (0, 0)) : (0, 0);
        var signals = ownSignals;
        var funcs = ownFuncs;
        var types = module.Kind == "type" ? 1 : 0;

        foreach (var child in module.Children)
        {
            var childCounts = CountModules(child, modules, memo);
            signals += childCounts.Signals;
            funcs += childCounts.Funcs;
            types += childCounts.Types;
        }

        module.Counts = new ModuleCountsDto { Signals = signals, Funcs = funcs, Types = types };
        var result = (signals, funcs, types);
        memo[moduleId] = result;
        return result;
    }

    // ── 特性读取 ────────────────────────────────────────────────────

    /// <summary>
    /// 扫描整个程序集是否使用了 Drawcode 的标注。
    ///
    /// 为什么不在 ScanTypes 里顺手判断：`[Drawcode]` 可以只挂在字段、属性或方法上，
    /// 类型本身不标注。回退开关必须在 ScanMembers / ScanMethods 之前定下来，
    /// 否则 IL 边会指向一批还没决定是否加入模型的信号 id。
    /// </summary>
    private bool HasAnyDrawcodeMetadata()
    {
        foreach (var typeHandle in _reader.TypeDefinitions)
        {
            var type = _reader.GetTypeDefinition(typeHandle);
            if (HasDrawcodeAttribute(type.GetCustomAttributes())) return true;
            foreach (var fieldHandle in type.GetFields())
            {
                if (HasDrawcodeAttribute(_reader.GetFieldDefinition(fieldHandle).GetCustomAttributes()))
                {
                    return true;
                }
            }
            foreach (var propertyHandle in type.GetProperties())
            {
                if (HasDrawcodeAttribute(_reader.GetPropertyDefinition(propertyHandle).GetCustomAttributes()))
                {
                    return true;
                }
            }
            foreach (var methodHandle in type.GetMethods())
            {
                if (HasDrawcodeAttribute(_reader.GetMethodDefinition(methodHandle).GetCustomAttributes()))
                {
                    return true;
                }
            }
        }
        return false;
    }

    private bool HasDrawcodeAttribute(CustomAttributeHandleCollection attributes)
    {
        foreach (var handle in attributes)
        {
            var attribute = _reader.GetCustomAttribute(handle);
            if (
                IsDrawcodeConstructor(attribute.Constructor)
                || IsConstructorOf(attribute.Constructor, DeviceAttributeName)
            )
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// 读取 <c>[Drawcode(...)]</c> 的全部已知参数。不认识的命名参数静默忽略 ——
    /// 模板未来加参数时，旧读取器仍能工作，只是少了那一项信息。
    ///
    /// 固定参数（构造函数第一个参数）按枚举处理：值 -> 名字的映射来自元数据里的
    /// <c>Direction</c> 枚举常量，而不是写死 0/1/2/3。模板若调整枚举顺序，这里自动跟上。
    /// </summary>
    private DrawcodeTraits? ReadDrawcode(CustomAttributeHandleCollection attributes)
    {
        foreach (var handle in attributes)
        {
            var attribute = _reader.GetCustomAttribute(handle);
            if (!IsDrawcodeConstructor(attribute.Constructor)) continue;

            FoundDrawcodeMetadata = true;
            var traits = new DrawcodeTraits();
            try
            {
                var decoded = attribute.DecodeValue(_attributeTypes);

                if (decoded.FixedArguments.Length > 0 && decoded.FixedArguments[0].Value is { } raw)
                {
                    var value = Convert.ToInt32(raw);
                    traits = traits with
                    {
                        Direction = _directionNames.GetValueOrDefault(value, "None"),
                    };
                }

                foreach (var named in decoded.NamedArguments)
                {
                    traits = named.Name switch
                    {
                        "Unit" => traits with { Unit = named.Value as string },
                        "Alias" => traits with { Alias = named.Value as string },
                        "Note" => traits with { Note = named.Value as string },
                        "Initial" => traits with { Initial = named.Value as string },
                        "Tags" => traits with { Tags = named.Value as string },
                        "Store" => traits with { Store = named.Value is true },
                        "Root" => traits with { Root = named.Value as string },
                        "Exclude" => traits with { Exclude = named.Value is true },
                        "External" => traits with { External = named.Value is true },
                        _ => traits,
                    };
                }
            }
            catch (Exception ex)
            {
                // 特性值解不开不该让整个产物读失败：方向缺失只是少一条边，模型其余部分仍然有用。
                _diagnostics.Warn("trimmed-metadata", $"特性值解码失败：{ex.Message}");
            }

            return traits;
        }
        return null;
    }

    /// <summary>
    /// 收集可筛选的短特性值，写成 `特性名.成员=值`。
    ///
    /// 只收「短、离散、用户会拿来筛」的字段：Device 的厂商/型号/规格/尺寸，
    /// Drawcode 的布尔标记与 Root。Alias/Note/Tooltip 这类长文本不收——
    /// 它们会把筛选下拉框撑成一段文章，而且用户更可能按名字搜索。
    ///
    /// 特性解不开只记诊断，不影响类型本身；旧版程序集里没有 Device 特性时，
    /// 这里自然什么也不加。
    /// </summary>
    private List<string> ReadAttributeTags(
        CustomAttributeHandleCollection attributes,
        DrawcodeTraits? drawcode
    )
    {
        var tags = SplitTags(drawcode?.Tags);
        if (drawcode is not null)
        {
            if (drawcode.Store) tags.Add("Drawcode.Store=true");
            if (drawcode.External) tags.Add("Drawcode.External=true");
            if (drawcode.Exclude) tags.Add("Drawcode.Exclude=true");
            if (!string.IsNullOrWhiteSpace(drawcode.Root))
            {
                tags.Add("Drawcode.Root=" + drawcode.Root.Trim());
            }
        }

        foreach (var handle in attributes)
        {
            var attribute = _reader.GetCustomAttribute(handle);
            if (!IsConstructorOf(attribute.Constructor, DeviceAttributeName)) continue;
            try
            {
                var decoded = attribute.DecodeValue(_attributeTypes);
                foreach (var named in decoded.NamedArguments)
                {
                    if (named.Value is not string text || string.IsNullOrWhiteSpace(text)) continue;
                    tags.Add($"Device.{named.Name}={text.Trim()}");
                }
            }
            catch (Exception ex)
            {
                _diagnostics.Warn("trimmed-metadata", $"Device 特性值解码失败：{ex.Message}");
            }
        }
        return tags;
    }

    private bool IsDrawcodeConstructor(EntityHandle constructor) =>
        IsConstructorOf(constructor, DrawcodeAttributeName);

    private bool IsConstructorOf(EntityHandle constructor, string shortName) =>
        constructor.Kind switch
        {
            HandleKind.MethodDefinition => TypeName.ShortOf(
                _reader,
                _reader.GetMethodDefinition((MethodDefinitionHandle)constructor).GetDeclaringType()
            ) == shortName,
            HandleKind.MemberReference => TypeName.ShortOf(
                _reader,
                _reader.GetMemberReference((MemberReferenceHandle)constructor).Parent
            ) == shortName,
            _ => false,
        };

    private void ReadDirectionEnum()
    {
        foreach (var handle in _reader.TypeDefinitions)
        {
            var definition = _reader.GetTypeDefinition(handle);
            if (_reader.GetString(definition.Name) != DirectionEnumName) continue;

            foreach (var fieldHandle in definition.GetFields())
            {
                var field = _reader.GetFieldDefinition(fieldHandle);
                if ((field.Attributes & FieldAttributes.Literal) == 0) continue;

                var constantHandle = field.GetDefaultValue();
                if (constantHandle.IsNil) continue;

                var constant = _reader.GetConstant(constantHandle);
                var blob = _reader.GetBlobReader(constant.Value);
                int value = constant.TypeCode switch
                {
                    ConstantTypeCode.SByte => blob.ReadSByte(),
                    ConstantTypeCode.Byte => blob.ReadByte(),
                    ConstantTypeCode.Int16 => blob.ReadInt16(),
                    ConstantTypeCode.UInt16 => blob.ReadUInt16(),
                    ConstantTypeCode.Int32 => blob.ReadInt32(),
                    ConstantTypeCode.UInt32 => (int)blob.ReadUInt32(),
                    _ => 0,
                };
                _directionNames[value] = _reader.GetString(field.Name);
            }
            return;
        }
    }

    // ── 小工具 ──────────────────────────────────────────────────────

    /// <summary>
    /// 方向枚举名 -> 模型方向。**按枚举名原样映射，不做语义纠正**：
    /// 模板里 In 的注释是 "Produced by the module"，与直觉相反，但读取器一旦「纠正」
    /// 就会把整张图的箭头翻过来。
    /// </summary>
    private static string NormalizeDirection(string direction) =>
        direction switch
        {
            "In" => "in",
            "Out" => "out",
            "Io" => "inout",
            _ => "",
        };

    private static List<string> SplitTags(string? tags) =>
        string.IsNullOrWhiteSpace(tags)
            ? new List<string>()
            : tags.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToList();

    /// <summary>
    /// 空串与“没写”在查看器里应当表现一致：前者不该在表里留一个空白单元格。
    /// 只在 DTO 边界上归一，特性解码本身仍保留原值。
    /// </summary>
    private static string? NullIfEmpty(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private bool IsCompilerGenerated(TypeDefinitionHandle handle)
    {
        var definition = _reader.GetTypeDefinition(handle);
        var name = _reader.GetString(definition.Name);
        if (name == "<Module>" || name.StartsWith('<')) return true;
        return definition.IsNested && IsCompilerGenerated(definition.GetDeclaringType());
    }
}

/// <summary>
/// 从 <c>[Drawcode(...)]</c> 解出的字段。字符串保持原样（可为 null），
/// 由调用方决定是当空串还是当作缺省。
/// </summary>
internal sealed record DrawcodeTraits
{
    public string Direction { get; init; } = "None";
    public string? Unit { get; init; }
    public string? Alias { get; init; }
    public string? Note { get; init; }
    public string? Initial { get; init; }
    public string? Tags { get; init; }
    public bool Store { get; init; }
    public string? Root { get; init; }
    public bool Exclude { get; init; }
    public bool External { get; init; }
}

internal sealed class DiagnosticBag
{
    public List<DiagnosticDto> Items { get; } = new();

    public void Error(string code, string message, string? subject = null) =>
        Items.Add(new DiagnosticDto { Severity = "error", Code = code, Message = message, Subject = subject });

    public void Warn(string code, string message, string? subject = null) =>
        Items.Add(new DiagnosticDto { Severity = "warning", Code = code, Message = message, Subject = subject });
}
