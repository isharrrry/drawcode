using System.Collections.Immutable;
using System.Reflection.Metadata;

namespace Drawcode.Metadata;

/// <summary>
/// 一个已解码的类型引用：可读名字 + 指向程序集内部的句柄。
///
/// 为什么要同时带 <see cref="Handle"/>：TypeScript 侧需要 <c>typeId</c> 才能让 ICD 视图
/// 从字段下钻到自定义类型。如果只解出名字，再拿名字反查类型表，遇到同名类型（不同命名空间）
/// 就会串台；而签名里本来就有精确句柄，一次解码两样都拿到。
/// </summary>
internal readonly struct TypeRef
{
    public TypeRef(string name, EntityHandle handle = default)
    {
        Name = name;
        Handle = handle;
    }

    public string Name { get; }

    public EntityHandle Handle { get; }
}

/// <summary>
/// 把签名 blob 解成可读类型名的提供者（ECMA-335 II.23.2.12）。
///
/// 与手写解析相比，这里的收益不是「代码短」，而是**泛型、数组、嵌套类型、类型规格**
/// 这些边角都由 BCL 的 SignatureDecoder 处理，我们只负责把返回的句柄翻成名字。
/// </summary>
internal sealed class TypeNameProvider : ISignatureTypeProvider<TypeRef, object?>
{
    public TypeRef GetPrimitiveType(PrimitiveTypeCode typeCode) => new(PrimitiveName(typeCode));

    public TypeRef GetTypeFromDefinition(
        MetadataReader reader,
        TypeDefinitionHandle handle,
        byte rawTypeKind
    ) => new(TypeName.OfDefinition(reader, handle), handle);

    public TypeRef GetTypeFromReference(
        MetadataReader reader,
        TypeReferenceHandle handle,
        byte rawTypeKind
    ) => new(TypeName.OfReference(reader, handle), handle);

    public TypeRef GetTypeFromSpecification(
        MetadataReader reader,
        object? genericContext,
        TypeSpecificationHandle handle,
        byte rawTypeKind
    ) => reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);

    public TypeRef GetSZArrayType(TypeRef elementType) => new(elementType.Name + "[]");

    public TypeRef GetArrayType(TypeRef elementType, ArrayShape shape) =>
        new(elementType.Name + "[" + new string(',', Math.Max(0, shape.Rank - 1)) + "]");

    public TypeRef GetGenericInstantiation(TypeRef genericType, ImmutableArray<TypeRef> typeArguments) =>
        new($"{genericType.Name}<{string.Join(", ", typeArguments.Select(a => a.Name))}>");

    public TypeRef GetByReferenceType(TypeRef elementType) => new(elementType.Name + "&");

    public TypeRef GetPointerType(TypeRef elementType) => new(elementType.Name + "*");

    public TypeRef GetModifiedType(TypeRef modifier, TypeRef unmodifiedType, bool isRequired) =>
        unmodifiedType;

    public TypeRef GetPinnedType(TypeRef elementType) => elementType;

    public TypeRef GetFunctionPointerType(MethodSignature<TypeRef> signature) => new("fnptr");

    public TypeRef GetGenericMethodParameter(object? genericContext, int index) => new("!!" + index);

    public TypeRef GetGenericTypeParameter(object? genericContext, int index) => new("!" + index);

    private static string PrimitiveName(PrimitiveTypeCode code) =>
        code switch
        {
            PrimitiveTypeCode.Boolean => "bool",
            PrimitiveTypeCode.Byte => "byte",
            PrimitiveTypeCode.SByte => "sbyte",
            PrimitiveTypeCode.Char => "char",
            PrimitiveTypeCode.Int16 => "short",
            PrimitiveTypeCode.UInt16 => "ushort",
            PrimitiveTypeCode.Int32 => "int",
            PrimitiveTypeCode.UInt32 => "uint",
            PrimitiveTypeCode.Int64 => "long",
            PrimitiveTypeCode.UInt64 => "ulong",
            PrimitiveTypeCode.Single => "float",
            PrimitiveTypeCode.Double => "double",
            PrimitiveTypeCode.String => "string",
            PrimitiveTypeCode.Object => "object",
            PrimitiveTypeCode.Void => "void",
            PrimitiveTypeCode.IntPtr => "nint",
            PrimitiveTypeCode.UIntPtr => "nuint",
            PrimitiveTypeCode.TypedReference => "typedref",
            _ => code.ToString(),
        };
}

/// <summary>类型全名（含命名空间与嵌套分隔符）。</summary>
internal static class TypeName
{
    public static string OfDefinition(MetadataReader reader, TypeDefinitionHandle handle)
    {
        var definition = reader.GetTypeDefinition(handle);
        var name = reader.GetString(definition.Name);

        // 嵌套类型的 Namespace 通常为空，命名空间在外层；直接递归拼。
        if (definition.IsNested)
        {
            return OfDefinition(reader, definition.GetDeclaringType()) + "/" + name;
        }

        var ns = reader.GetString(definition.Namespace);
        return ns.Length == 0 ? name : ns + "." + name;
    }

    public static string OfReference(MetadataReader reader, TypeReferenceHandle handle)
    {
        var reference = reader.GetTypeReference(handle);
        var name = reader.GetString(reference.Name);

        // 泛型实例的类型引用可以再嵌套（Outer/Inner），ResolutionScope 指向 TypeReference。
        if (reference.ResolutionScope.Kind == HandleKind.TypeReference)
        {
            return OfReference(reader, (TypeReferenceHandle)reference.ResolutionScope) + "/" + name;
        }

        var ns = reader.GetString(reference.Namespace);
        return ns.Length == 0 ? name : ns + "." + name;
    }

    public static string ShortOf(MetadataReader reader, EntityHandle handle) =>
        handle.Kind switch
        {
            HandleKind.TypeDefinition => reader.GetString(
                reader.GetTypeDefinition((TypeDefinitionHandle)handle).Name
            ),
            HandleKind.TypeReference => reader.GetString(
                reader.GetTypeReference((TypeReferenceHandle)handle).Name
            ),
            _ => "",
        };
}
