using System.Collections.Immutable;
using System.Reflection.Metadata;

namespace Drawcode.Metadata;

/// <summary>
/// <see cref="CustomAttribute.DecodeValue{TType}"/> 需要的类型提供者。
///
/// 只实现到「能把 DrawcodeAttribute 的值解出来」为止：基本类型、枚举、字符串、
/// 一维数组。其余（泛型、函数指针、按值传递的自定义类型）返回默认值或忽略 ——
/// 自定义特性的参数类型本来就被 CLR 限制在很小的集合里。
///
/// 关键收益：枚举的底层类型由 <see cref="GetUnderlyingEnumType"/> 从字段签名读，
/// 而不是像手写解析那样一律假定 i32。将来模板若把 Direction 改成 byte 底层，
/// 这里不需要改。
/// </summary>
internal sealed class AttributeTypeProvider : ICustomAttributeTypeProvider<EntityHandle>
{
    private readonly MetadataReader _reader;

    public AttributeTypeProvider(MetadataReader reader)
    {
        _reader = reader;
    }

    public EntityHandle GetPrimitiveType(PrimitiveTypeCode typeCode) => default;

    public EntityHandle GetSystemType() => default;

    public EntityHandle GetSZArrayType(EntityHandle elementType) => default;

    public EntityHandle GetTypeFromDefinition(
        MetadataReader reader,
        TypeDefinitionHandle handle,
        byte rawTypeKind
    ) => handle;

    public EntityHandle GetTypeFromReference(
        MetadataReader reader,
        TypeReferenceHandle handle,
        byte rawTypeKind
    ) => handle;

    /// <summary>
    /// typeof(...) 参数里的序列化名。DrawcodeAttribute 不使用这种参数，
    /// 返回 default 会让 DecodeValue 抛错，由上层捕获并跳过该特性。
    /// </summary>
    public EntityHandle GetTypeFromSerializedName(string name) => default;

    public bool IsSystemType(EntityHandle type) => false;

    /// <summary>
    /// 读枚举的底层类型：找 <c>value__</c> 字段的签名首字节。
    /// 字段签名布局是 <c>0x06</c> + 元素类型，与 <see cref="PrimitiveTypeCode"/> 数值一致。
    /// </summary>
    public PrimitiveTypeCode GetUnderlyingEnumType(EntityHandle handle)
    {
        if (handle.Kind != HandleKind.TypeDefinition) return PrimitiveTypeCode.Int32;

        var definition = _reader.GetTypeDefinition((TypeDefinitionHandle)handle);
        foreach (var fieldHandle in definition.GetFields())
        {
            var field = _reader.GetFieldDefinition(fieldHandle);
            if (_reader.GetString(field.Name) != "value__") continue;

            var blob = _reader.GetBlobReader(field.Signature);
            if (blob.Length < 2) break;
            blob.ReadByte(); // FIELD 标记
            var element = blob.ReadByte();
            return (PrimitiveTypeCode)element;
        }
        return PrimitiveTypeCode.Int32;
    }

    // —— 以下为 ISignatureTypeProvider 的其余成员，特性解码不会走到 ——
    public EntityHandle GetArrayType(EntityHandle elementType, ArrayShape shape) => default;

    public EntityHandle GetByReferenceType(EntityHandle elementType) => default;

    public EntityHandle GetFunctionPointerType(MethodSignature<EntityHandle> signature) => default;

    public EntityHandle GetGenericInstantiation(
        EntityHandle genericType,
        ImmutableArray<EntityHandle> typeArguments
    ) => default;

    public EntityHandle GetGenericMethodParameter(object genericContext, int index) => default;

    public EntityHandle GetGenericTypeParameter(object genericContext, int index) => default;

    public EntityHandle GetModifiedType(
        EntityHandle modifier,
        EntityHandle unmodifiedType,
        bool isRequired
    ) => unmodifiedType;

    public EntityHandle GetPinnedType(EntityHandle elementType) => elementType;

    public EntityHandle GetPointerType(EntityHandle elementType) => default;
}
