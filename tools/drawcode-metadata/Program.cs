using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Drawcode.Metadata;

/// <summary>
/// CLI 入口：读一个 PE 产物，输出 ArtifactModel JSON。
///
/// 退出码是 TS 侧区分「没装工具」「文件读不了」「解析器崩了」的唯一依据，
/// 因此不能把所有失败都压成 1：
///   0 = 已输出模型（模型里可能带诊断，那是产物的问题，不是工具的问题）
///   2 = 参数错误
///   3 = 输入文件读不了
///   4 = 工具内部异常
///
/// 本程序**只读字节**：PEReader 不加载程序集，不执行目标代码。打开 .dll 不等于运行它。
/// </summary>
internal static class Program
{
    private const int ExitOk = 0;
    private const int ExitUsage = 2;
    private const int ExitRead = 3;
    private const int ExitInternal = 4;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,

        // 产物里的类型名、别名、注释大量是中文。默认编码器会把它们转成 \uXXXX，
        // 人眼不可读、diff 也不可比；这里放宽转义，输出真正的 UTF-8 中文。
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static int Main(string[] args)
    {
        // Windows 上 Console.Out 默认按控制台代码页（本机是 GBK）编码。
        // 被 Node 以 UTF-8 读走时中文会变成乱码（U+FFFD），且没有任何报错 ——
        // 这是最隐蔽的一类错误：数字对、名字全错。所以输出一律显式写 UTF-8 字节。
        if (args.Length == 0)
        {
            WriteError("用法: drawcode-metadata <artifact> [--out FILE]");
            return ExitUsage;
        }

        var file = args[0];
        string? outputPath = null;
        for (var i = 1; i < args.Length; i++)
        {
            if (args[i] == "--out" && i + 1 < args.Length)
            {
                outputPath = args[++i];
            }
            else
            {
                WriteError($"未知参数: {args[i]}");
                return ExitUsage;
            }
        }

        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(file);
        }
        catch (Exception ex)
        {
            WriteError($"无法读取 {file}: {ex.Message}");
            return ExitRead;
        }

        ArtifactModelDto model;
        try
        {
            model = Analyze(file, bytes);
        }
        catch (Exception ex)
        {
            WriteError($"解析失败: {ex.Message}");
            return ExitInternal;
        }

        var json = JsonSerializer.Serialize(model, JsonOptions);
        if (outputPath is null)
        {
            WriteUtf8(Console.OpenStandardOutput(), json);
        }
        else
        {
            File.WriteAllText(outputPath, json);
        }
        return ExitOk;
    }

    /// <summary>不经 Console 的编码器，直接按 UTF-8 写出。</summary>
    private static void WriteUtf8(Stream stream, string text)
    {
        using var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        writer.Write(text);
    }

    private static void WriteError(string message) =>
        WriteUtf8(Console.OpenStandardError(), message + Environment.NewLine);

    private static ArtifactModelDto Analyze(string file, byte[] bytes)
    {
        var fileName = Path.GetFileName(file);

        using var stream = new MemoryStream(bytes, writable: false);
        using var pe = new PEReader(stream);

        var model = new ArtifactModelDto
        {
            Info = new ArtifactInfoDto
            {
                Path = fileName,
                Format = "pe-cli",
                Arch = ArchName(pe.PEHeaders.CoffHeader.Machine),
                Kind = pe.PEHeaders.IsDll ? "dll" : "exe",
            },
        };

        // 没有 CLI 头 = 原生 PE（C/C++ 编译的 DLL、驱动等）。不是错误，只是本变更不解析；
        // 给出明确诊断，插件据此回退到默认编辑器而不是显示一棵空树。
        if (!pe.HasMetadata)
        {
            model.Info.Format = "pe-native";
            var bag = new DiagnosticBag();
            bag.Error(
                "unsupported-native-pe",
                "这是原生 PE 文件，没有 .NET 元数据；当前版本不解析原生 DLL 的符号",
                fileName
            );
            model.Diagnostics = bag.Items;
            return model;
        }

        var reader = pe.GetMetadataReader();
        var stem = Stem(reader, fileName);

        ReadAssemblyInfo(reader, bytes.Length, model.Info);

        var builder = new ModelBuilder(reader, pe, model, stem);
        builder.Build();

        // hasMetadata 问的是「有没有 drawcode 元数据」，不是「能不能读出类型」：
        // 任何 .NET DLL 都有类型表，只有找到 [Drawcode] 才说明它接入了这套工具。
        model.Info.HasMetadata = builder.FoundDrawcodeMetadata;
        model.Info.MetadataVersion = builder.FoundDrawcodeMetadata ? 1 : 0;
        model.Info.EntryPoint = EntryPointName(reader);

        return model;
    }

    /// <summary>
    /// 收集“打开文件就能看到”的展示信息。
    ///
    /// 这些都是 PE/CLI 规范里直接可读的字段，不需要加载程序集：
    /// - 程序集版本来自 Assembly 表（`1.2.3.4`）；
    /// - 文件/产品版本来自两个字符串特性，解码方式是自定义特性 blob 的第一个定长参数；
    /// - 目标框架来自 `TargetFrameworkAttribute`，值形如 `.NETCoreApp,Version=v8.0`。
    ///
    /// 解码失败只跳过该项：版本号是辅助信息，不能让它把整个产物读失败。
    /// </summary>
    private static void ReadAssemblyInfo(MetadataReader reader, int fileSize, ArtifactInfoDto info)
    {
        info.FileSize = fileSize;
        if (!reader.IsAssembly) return;

        var assembly = reader.GetAssemblyDefinition();
        info.Version = assembly.Version?.ToString();
        var culture = reader.GetString(assembly.Culture);
        if (!string.IsNullOrWhiteSpace(culture)) info.Culture = culture;

        foreach (var handle in assembly.GetCustomAttributes())
        {
            var attribute = reader.GetCustomAttribute(handle);
            var name = AttributeTypeName(reader, attribute);
            if (name is null) continue;

            string? value;
            try
            {
                value = ReadFirstStringArgument(reader, attribute);
            }
            catch (BadImageFormatException)
            {
                continue;
            }
            if (string.IsNullOrWhiteSpace(value)) continue;

            switch (name)
            {
                case "AssemblyFileVersionAttribute":
                    info.FileVersion = value;
                    break;
                case "AssemblyInformationalVersionAttribute":
                    info.ProductVersion = value;
                    break;
                case "TargetFrameworkAttribute":
                    info.TargetFramework = value;
                    break;
            }
        }
    }

    /// <summary>自定义特性的构造函数所属类型短名；跨程序集引用也能解析。</summary>
    private static string? AttributeTypeName(MetadataReader reader, CustomAttribute attribute)
    {
        var parent = attribute.Constructor.Kind switch
        {
            HandleKind.MethodDefinition => reader
                .GetMethodDefinition((MethodDefinitionHandle)attribute.Constructor)
                .GetDeclaringType(),
            HandleKind.MemberReference => reader
                .GetMemberReference((MemberReferenceHandle)attribute.Constructor)
                .Parent,
            _ => default,
        };
        return parent.Kind switch
        {
            HandleKind.TypeDefinition => reader.GetString(reader.GetTypeDefinition((TypeDefinitionHandle)parent).Name),
            HandleKind.TypeReference => reader.GetString(reader.GetTypeReference((TypeReferenceHandle)parent).Name),
            _ => null,
        };
    }

    /// <summary>
    /// 读自定义特性 blob 里的第一个 string 定长参数。
    ///
    /// blob 结构：`u16 prolog(0x0001)` + 按构造函数签名顺序排列的参数。
    /// 三个版本特性都只有一个 string 参数，`ReadSerializedString` 还会正确处理
    /// “null 用 0xFF 表示”的编码；不需要为此引入完整的特性解码器。
    /// </summary>
    private static string? ReadFirstStringArgument(MetadataReader reader, CustomAttribute attribute)
    {
        var blob = reader.GetBlobReader(attribute.Value);
        if (blob.Length < 2 || blob.ReadUInt16() != 1) return null;
        return blob.ReadSerializedString();
    }

    /// <summary>
    /// 稳定 id 的前缀。
    ///
    /// 优先用程序集名而不是文件名：同一个库改个文件名（`xxx.dll` -> `xxx.1.dll`）时，
    /// 图里的 id 不应该全部变一遍。netmodule 没有 Assembly 表，才退回文件名去扩展名。
    /// </summary>
    private static string Stem(MetadataReader reader, string fileName) =>
        reader.IsAssembly ? reader.GetString(reader.GetAssemblyDefinition().Name) : Path.GetFileNameWithoutExtension(fileName);

    private static string? EntryPointName(MetadataReader reader)
    {
        var debug = reader.DebugMetadataHeader;
        if (debug is null || debug.EntryPoint.IsNil) return null;

        var method = reader.GetMethodDefinition(debug.EntryPoint);
        return reader.GetString(method.Name);
    }

    private static string ArchName(Machine machine) =>
        machine switch
        {
            Machine.Amd64 => "x64",
            Machine.I386 => "x86",
            Machine.Arm64 => "arm64",
            Machine.Arm => "arm",
            Machine.IA64 => "ia64",
            _ => machine.ToString().ToLowerInvariant(),
        };
}
