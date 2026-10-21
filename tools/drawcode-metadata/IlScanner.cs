using System.Reflection.Metadata;

namespace Drawcode.Metadata;

/// <summary>
/// CIL 方法体扫描：找出静态字段读写与方法调用。
///
/// 为什么不用第三方反编译器：我们只需要三类指令，完整的反编译语义（栈、类型流）
/// 反而会引入不需要的复杂度。这里的操作数长度表覆盖 ECMA-335 III.2 的全部操作码；
/// 遇到未知字节立即失败，而不是把它当成无操作数继续 —— 后者会让整段 IL 错位，
/// 产出随机假边，是最难排查的一类错误。
/// </summary>
internal static class IlScanner
{
    public sealed class Result
    {
        public List<int> Reads { get; } = new();
        public List<int> Writes { get; } = new();
        public List<int> Calls { get; } = new();
        public int IndirectCalls { get; set; }
    }

    private enum OperandKind
    {
        None,
        ShortI,
        I,
        I8,
        ShortR,
        R,
        ShortBr,
        Br,
        Method,
        Field,
        Type,
        String,
        Sig,
        ShortVar,
        Var,
        Tok,
        Switch,
    }

    private static readonly Dictionary<byte, OperandKind> Single = new()
    {
        [0x0e] = OperandKind.ShortVar, // ldarg.s
        [0x0f] = OperandKind.ShortVar, // ldarga.s
        [0x10] = OperandKind.ShortVar, // starg.s
        [0x11] = OperandKind.ShortVar, // ldloc.s
        [0x12] = OperandKind.ShortVar, // ldloca.s
        [0x13] = OperandKind.ShortVar, // stloc.s
        [0x1f] = OperandKind.ShortI, // ldc.i4.s
        [0x20] = OperandKind.I, // ldc.i4
        [0x21] = OperandKind.I8, // ldc.i8
        [0x22] = OperandKind.ShortR, // ldc.r4
        [0x23] = OperandKind.R, // ldc.r8
        [0x27] = OperandKind.Method, // jmp
        [0x28] = OperandKind.Method, // call
        [0x29] = OperandKind.Sig, // calli
        [0x2b] = OperandKind.ShortBr, // br.s
        [0x2c] = OperandKind.ShortBr, // brfalse.s
        [0x2d] = OperandKind.ShortBr, // brtrue.s
        [0x2e] = OperandKind.ShortBr, // beq.s
        [0x2f] = OperandKind.ShortBr, // bge.s
        [0x30] = OperandKind.ShortBr, // bgt.s
        [0x31] = OperandKind.ShortBr, // ble.s
        [0x32] = OperandKind.ShortBr, // blt.s
        [0x33] = OperandKind.ShortBr, // bne.un.s
        [0x34] = OperandKind.ShortBr, // bge.un.s
        [0x35] = OperandKind.ShortBr, // bgt.un.s
        [0x36] = OperandKind.ShortBr, // ble.un.s
        [0x37] = OperandKind.ShortBr, // blt.un.s
        [0x38] = OperandKind.Br, // br
        [0x39] = OperandKind.Br, // brfalse
        [0x3a] = OperandKind.Br, // brtrue
        [0x3b] = OperandKind.Br, // beq
        [0x3c] = OperandKind.Br, // bge
        [0x3d] = OperandKind.Br, // bgt
        [0x3e] = OperandKind.Br, // ble
        [0x3f] = OperandKind.Br, // blt
        [0x40] = OperandKind.Br, // bne.un
        [0x41] = OperandKind.Br, // bge.un
        [0x42] = OperandKind.Br, // bgt.un
        [0x43] = OperandKind.Br, // ble.un
        [0x44] = OperandKind.Br, // blt.un
        [0x45] = OperandKind.Switch,
        [0x6f] = OperandKind.Method, // callvirt
        [0x70] = OperandKind.Type, // cpobj
        [0x71] = OperandKind.Type, // ldobj
        [0x72] = OperandKind.String, // ldstr
        [0x73] = OperandKind.Method, // newobj
        [0x74] = OperandKind.Type, // castclass
        [0x75] = OperandKind.Type, // isinst
        [0x79] = OperandKind.Type, // unbox
        [0x7b] = OperandKind.Field, // ldfld
        [0x7c] = OperandKind.Field, // ldflda
        [0x7d] = OperandKind.Field, // stfld
        [0x7e] = OperandKind.Field, // ldsfld
        [0x7f] = OperandKind.Field, // ldsflda
        [0x80] = OperandKind.Field, // stsfld
        [0x81] = OperandKind.Type, // stobj
        [0x8c] = OperandKind.Type, // box
        [0x8d] = OperandKind.Type, // newarr
        [0x8f] = OperandKind.Type, // ldelema
        [0xa3] = OperandKind.Type, // ldelem.any
        [0xa4] = OperandKind.Type, // stelem.any
        [0xa5] = OperandKind.Type, // unbox.any
        [0xc2] = OperandKind.Type, // refanyval
        [0xc6] = OperandKind.Type, // mkrefany
        [0xd0] = OperandKind.Tok, // ldtoken
        [0xdd] = OperandKind.Br, // leave
        [0xde] = OperandKind.ShortBr, // leave.s
    };

    private static readonly Dictionary<byte, OperandKind> Prefixed = new()
    {
        [0x06] = OperandKind.Method, // ldftn
        [0x07] = OperandKind.Method, // ldvirtftn
        [0x09] = OperandKind.Var, // ldarg
        [0x0a] = OperandKind.Var, // ldarga
        [0x0b] = OperandKind.Var, // starg
        [0x0c] = OperandKind.Var, // ldloc
        [0x0d] = OperandKind.Var, // ldloca
        [0x0e] = OperandKind.Var, // stloc
        [0x12] = OperandKind.ShortI, // unaligned.
        [0x15] = OperandKind.Type, // initobj
        [0x16] = OperandKind.Type, // constrained.
        [0x19] = OperandKind.ShortI, // no.
        [0x1c] = OperandKind.Type, // sizeof
    };

    public static Result Scan(BlobReader reader)
    {
        var result = new Result();
        while (reader.RemainingBytes > 0)
        {
            var opcode = reader.ReadByte();

            if (opcode == 0xfe)
            {
                if (reader.RemainingBytes == 0) throw new BadImageFormatException("IL 以 0xFE 结尾");
                var second = reader.ReadByte();
                var kind = Prefixed.GetValueOrDefault(second, OperandKind.None);

                if (second == 0x06 || second == 0x07) result.Calls.Add(reader.ReadInt32());

                Skip(ref reader, kind);
                continue;
            }

            var singleKind = Single.GetValueOrDefault(opcode, OperandKind.None);
            var before = reader.Offset;

            if (opcode == 0x7e || opcode == 0x7f)
            {
                result.Reads.Add(reader.ReadInt32());
            }
            else if (opcode == 0x80)
            {
                result.Writes.Add(reader.ReadInt32());
            }
            else if (opcode == 0x28 || opcode == 0x6f || opcode == 0x73)
            {
                result.Calls.Add(reader.ReadInt32());
            }
            else if (opcode == 0x29)
            {
                result.IndirectCalls += 1;
            }

            // 上面已经消费了 token（4 字节）；其余操作数在这里跳过。
            Skip(ref reader, singleKind, reader.Offset - before);
        }

        return result;
    }

    private static void Skip(ref BlobReader reader, OperandKind kind, int alreadyConsumed = 0)
    {
        switch (kind)
        {
            case OperandKind.None:
                break;
            case OperandKind.ShortI:
            case OperandKind.ShortBr:
            case OperandKind.ShortVar:
                reader.Offset += 1;
                break;
            case OperandKind.I:
            case OperandKind.ShortR:
            case OperandKind.Br:
            case OperandKind.Method:
            case OperandKind.Field:
            case OperandKind.Type:
            case OperandKind.String:
            case OperandKind.Sig:
            case OperandKind.Tok:
                reader.Offset += 4 - alreadyConsumed;
                break;
            case OperandKind.I8:
            case OperandKind.R:
                reader.Offset += 8;
                break;
            case OperandKind.Var:
                reader.Offset += 2;
                break;
            case OperandKind.Switch:
            {
                var count = reader.ReadInt32();
                reader.Offset += 4 * count;
                break;
            }
            default:
                throw new BadImageFormatException($"未知操作数类型 {kind}");
        }

        if (reader.Offset > reader.Length)
        {
            throw new BadImageFormatException("IL 操作数越过方法体边界");
        }
    }
}
