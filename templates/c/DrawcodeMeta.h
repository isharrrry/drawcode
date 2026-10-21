/*
 * drawcode 元数据模板（C）。
 *
 * 用法、tag 表、段保留（--gc-sections / LTO）与定长限制见 docs/templates.md 的
 * 「C template (ELF)」一节；本文件只保留接口本身。
 *
 * 原理：把声明写成**定长、无指针的 POD 结构体**，用
 * `__attribute__((used, section("dc_meta_entries")))` 放进独立段。
 * 读取器只要按固定 200 字节切片就能读出名字、类型、偏移与读写关系，
 * 不需要解析符号表、不需要解重定位、更不会执行任何代码。
 *
 * 为什么必须是 POD 且定长：
 *   - 指针在 .o 里只是待重定位的 0，读取器无法把它变成字符串；
 *   - 变长记录需要额外解析长度字段，任何一处偏移算错，后面全错；
 *   - 定长数组 + `__start_/__stop_` 是链接器直接支持的契约，`strip` 也不影响。
 *
 * 编译期自检：下面的 `_Static_assert` 会在结构体尺寸变化时直接报错，
 * 避免「模板改了、读取器没改」这种最难发现的版本漂移。
 *
 * 支持 GCC / Clang（Linux、MinGW）。MSVC 没有 `section` 与 `__start_` 语义，第一版不支持。
 */

#ifndef DRAWCODE_META_H
#define DRAWCODE_META_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 读取器与模板共享的版本号；格式有变时必须同时升级两处。 */
#define DC_META_VERSION 1

/* 单条记录的固定大小。读取器按这个值切片，改动会让旧读取器立即报错。 */
#define DC_META_ENTRY_SIZE 200

/* 各字段容量。超长字符串在编译期报错，而不是运行期截断。 */
#define DC_META_NAME_MAX 48
#define DC_META_TAG_MAX 48
#define DC_META_KIND_MAX 16
#define DC_META_OWNER_MAX 32
#define DC_META_TYPE_MAX 40

typedef struct dc_meta_entry
{
    char name[DC_META_NAME_MAX];   /* 变量 / 函数 / 参数 / 枚举成员 / 类型成员 / 被调函数名 */
    char tag[DC_META_TAG_MAX];     /* 逗号分隔标签；保留值 root、exclude、store，见下方约定 */
    char kind[DC_META_KIND_MAX];   /* anchor/module/type/signal/field/function/param/enum_member/read/write/call */
    char owner[DC_META_OWNER_MAX]; /* 所属模块、类型、函数或调用者 */
    char type[DC_META_TYPE_MAX];   /* C 类型字符串；函数记录上为返回类型；无类型时为空 */
    uint32_t size;                 /* 字段大小；未知为 0 */
    uint32_t offset;               /* 字段偏移 / 参数序号 / 枚举值；未知为 0 */
    uint64_t order;                /* 声明序号，见下方说明 */
} dc_meta_entry;

/*
 * 为什么需要 order：GCC/Clang 会**逆序**往自定义段里追加静态对象，
 * 段内顺序不是源码顺序。没有序号时，字段表会倒着显示（gain、count、voltage），
 * 看起来像解析错误。`__COUNTER__` 在每个翻译单元内从 0 递增，是编译期常量，
 * 不产生重定位；读取器按它稳定排序即可恢复声明顺序。
 *
 * 旧产物（全部为 0）排序后仍是原段序，不会更糟。
 */
#define DC_META_ORDER ((uint64_t)__COUNTER__)

/* 布局契约：字段顺序、对齐、总大小。任何一条不成立都在编译期失败。 */
_Static_assert(sizeof(dc_meta_entry) == DC_META_ENTRY_SIZE,
               "dc_meta_entry must stay 200 bytes; reader slices by this size");
_Static_assert(offsetof(dc_meta_entry, size) == 184, "unexpected layout");
_Static_assert(offsetof(dc_meta_entry, offset) == 188, "unexpected layout");
_Static_assert(offsetof(dc_meta_entry, order) == 192, "unexpected layout");

/*
 * 模块名由构建系统注入：`-DDC_META_MODULE='"app"'`。
 * 不用 `__FILE__`：它会带上构建机路径，既泄露路径，又让 id 随构建目录变化。
 */
#ifndef DC_META_MODULE
#define DC_META_MODULE "unknown"
#endif

/*
 * 段保留：`used` 只阻止**编译器**删掉静态变量，不阻止**链接器**的 --gc-sections。
 * GCC 11 / Clang 13 起支持 `retain`（ELF 的 SHF_GNU_RETAIN），逐条打上即可整段保留。
 * 旧工具链没有该属性，必须在链接脚本写 `KEEP(*(dc_meta_entries))`，见 README。
 */
#if defined(__ELF__)
#  if defined(__has_attribute)
#    if __has_attribute(retain)
#      define DC_META_RETAIN __attribute__((retain))
#    else
#      define DC_META_RETAIN
#    endif
#  else
#    define DC_META_RETAIN
#  endif
#else
/* PE/COFF 目标（MinGW/Cygwin）不认识 retain，打上只会得到 -Wattributes 警告。 */
#  define DC_META_RETAIN
#endif

/* 把宏参数变成字符串；两层是为了让 `DC_META_VERSION` 先展开成 1 再字符串化。 */
#define DC_META_STR_(x) #x
#define DC_META_STR(x) DC_META_STR_(x)
#define DC_META_VERSION_TAG DC_META_STR(DC_META_VERSION)

/* 生成不冲突的静态变量名：同一翻译单元里同一函数对同一变量的读写各只有一条记录。 */
#define DC_JOIN2_(a, b) a##b
#define DC_JOIN2(a, b) DC_JOIN2_(a, b)
#define DC_JOIN3_(a, b, c) a##b##c
#define DC_JOIN3(a, b, c) DC_JOIN3_(a, b, c)

/*
 * 记录定义。`static const` 让每条记录只在本翻译单元可见；
 * `used` 防止 -O2 把「没人引用」的变量删掉。
 */
#define DC_META_ENTRY(sym, kind_, name_, tag_, owner_, type_, size_, offset_) \
    DC_META_RETAIN __attribute__((used, section("dc_meta_entries"), aligned(8))) \
    static const dc_meta_entry sym = {                                       \
        .name = (name_),                                                     \
        .tag = (tag_),                                                       \
        .kind = (kind_),                                                     \
        .owner = (owner_),                                                   \
        .type = (type_),                                                     \
        .size = (uint32_t)(size_),                                           \
        .offset = (uint32_t)(offset_),                                       \
        .order = DC_META_ORDER,                                              \
    }

/*
 * `_Generic` 把表达式类型映射成字符串。C 语言无法对类型名做字符串化，
 * 所以只覆盖基本类型；自定义类型请用 `DC_FIELD_AS` 显式传类型串。
 */
#define DC_TYPE_NAME(expr)                                                    \
    _Generic((expr),                                                          \
             _Bool: "bool",                                                   \
             char: "char",                                                    \
             signed char: "int8",                                             \
             unsigned char: "uint8",                                          \
             short: "int16",                                                  \
             unsigned short: "uint16",                                        \
             int: "int32",                                                    \
             unsigned int: "uint32",                                          \
             long: "long",                                                    \
             unsigned long: "unsigned long",                                  \
             long long: "int64",                                              \
             unsigned long long: "uint64",                                    \
             float: "float",                                                  \
             double: "double",                                                \
             long double: "long double",                                      \
             default: "unknown")

/*
 * tag 约定（逗号分隔，整体不超过 47 字节）：
 *   - 裸词：业务标签，如 telemetry、rmem，查看器原样展示并可用于筛选；
 *   - root / exclude / store：保留语义。root 标记模块根，exclude 默认隐藏，
 *     store 标记该类型需要持久化（字段上的 store 等价于所在类型 store）；
 *   - alias=名称、unit=单位、note=备注、init=初值：结构化展示属性；
 *   - direction=in|out|inout：信号方向，与 C# 的 Direction 属性对齐；
 *     不写就是「方向未知」，读取器不会替你猜；
 *   - path=模块/子路径：显示分组，与 C# 的 Path 属性对齐；
 *   - kind=class|struct|record|enum|interface、size=字节数：仅 DC_TYPE 使用。
 *
 * 示例：DC_SIGNAL(g_voltage, "telemetry,rmem,unit=V,init=0,alias=母线电压", "double")
 */
#define DC_TAG_ALIAS(x) "alias=" x
#define DC_TAG_UNIT(x) "unit=" x
#define DC_TAG_NOTE(x) "note=" x
#define DC_TAG_INIT(x) "init=" x
#define DC_TAG_DIRECTION(x) "direction=" x
#define DC_TAG_PATH(x) "path=" x

/*
 * 类型：显式声明一个类型，用于没有字段记录的枚举、外部结构体或接口。
 *   DC_TYPE(DcState, "store,kind=struct,size=24,alias=控制状态")
 * 若同一类型已有 DC_FIELD，两处记录会按名字合并；字段记录足以推出大小时可省略 size。
 */
#define DC_TYPE(type_name, tag_) \
    DC_META_ENTRY(DC_JOIN2(dc_meta_type_, type_name), "type", #type_name, tag_, DC_META_MODULE, "", 0, 0)

/*
 * 信号：一个具名全局量。
 *   DC_SIGNAL(g_voltage, "telemetry,rmem", "double")
 * tag 为空串表示没有标签；保留值 exclude 会让查看器默认隐藏它。
 */
#define DC_SIGNAL(var, tag_, type_) \
    DC_META_ENTRY(DC_JOIN2(dc_meta_signal_, var), "signal", #var, tag_, DC_META_MODULE, type_, 0, 0)

/*
 * 结构体字段：偏移与大小由编译器算好，读取器直接使用，不需要调试信息。
 *   DC_FIELD(DcState, voltage, "rmem")
 */
#define DC_FIELD(owner_type, member, tag_)                                              \
    DC_META_ENTRY(DC_JOIN3(dc_meta_field_, owner_type, DC_JOIN2(_, member)),            \
                  "field", #member, tag_, #owner_type,                                  \
                  DC_TYPE_NAME(((owner_type *)0)->member),                              \
                  sizeof(((owner_type *)0)->member), offsetof(owner_type, member))

/* 显式类型串版本：用于成员是自定义结构体、`_Generic` 认不出来的情况。 */
#define DC_FIELD_AS(owner_type, member, type_str, tag_)                                 \
    DC_META_ENTRY(DC_JOIN3(dc_meta_field_, owner_type, DC_JOIN2(_, member)),            \
                  "field", #member, tag_, #owner_type, type_str,                        \
                  sizeof(((owner_type *)0)->member), offsetof(owner_type, member))

/* 函数：树里的一个节点。 */
#define DC_FUNCTION(fn, tag_) \
    DC_META_ENTRY(DC_JOIN2(dc_meta_func_, fn), "function", #fn, tag_, DC_META_MODULE, "", 0, 0)

/*
 * 带返回类型的函数记录。`type` 列在函数记录上原本空着，这里让它承载返回值，
 * 读取器据此填 `Func.ret`，与 C# 的 `short AdcRead(...)` 显示一致。
 * 同一个函数用 DC_FUNCTION 或 DC_FUNCTION_AS 二选一，不能两条都写（符号会重名）。
 *
 *   DC_FUNCTION_AS(compute_gain, "float", "alias=ComputeGain,note=计算增益")
 */
#define DC_FUNCTION_AS(fn, ret_type, tag_) \
    DC_META_ENTRY(DC_JOIN2(dc_meta_func_, fn), "function", #fn, tag_, DC_META_MODULE, ret_type, 0, 0)

/*
 * 函数参数：`owner` 是所属函数，`offset` 是 0 起的参数序号。
 * 读取器按序号排序后填 `Func.params`，参数因此能在视图里作为端口出现，
 * 而不是只有一个光秃秃的函数名。
 *
 *   DC_PARAM(compute_gain, 0, base, "float", "direction=in,unit=dB,alias=基准增益");
 *   DC_PARAM(compute_gain, 1, step, "int32", "direction=in");
 */
#define DC_PARAM(fn, index_, param, type_, tag_) \
    DC_META_ENTRY(DC_JOIN3(dc_meta_param_, fn, DC_JOIN2(_, param)), "param", #param, tag_, #fn, type_, 0, (uint32_t)(index_))

/*
 * 枚举成员：`owner` 是枚举类型，`offset` 存成员的整数值（按 uint32 记录，示例取非负值）。
 * 读取器把它并进类型的字段表，初值列显示成员值 —— 与 C# 枚举成员的展示保持一致。
 * 宏必须写在枚举定义之后：它要引用成员常量本身。
 *
 *   DC_ENUM_MEMBER(DcMode, DC_MODE_RUN, "alias=运行");
 */
#define DC_ENUM_MEMBER(type_name, member, tag_) \
    DC_META_ENTRY(DC_JOIN3(dc_meta_enum_, type_name, DC_JOIN2(_, member)), "enum_member", #member, tag_, #type_name, #type_name, 0, (uint32_t)(member))

/*
 * 读写边：显式声明「哪个函数碰了哪个信号」。
 * 为什么不让读取器从机器码猜：优化会把读写重排/合并，反汇编推断既不可靠又需要架构支持。
 * 显式宏在 -O0/-O2 下都是同一份元数据，这是「稳定」的来源。
 */
#define DC_READ(fn, var) \
    DC_META_ENTRY(DC_JOIN3(dc_meta_read_, fn, DC_JOIN2(_, var)), "read", #var, "", #fn, "", 0, 0)

#define DC_WRITE(fn, var) \
    DC_META_ENTRY(DC_JOIN3(dc_meta_write_, fn, DC_JOIN2(_, var)), "write", #var, "", #fn, "", 0, 0)

/* 调用边（可选）：owner 是调用者，name 是被调者。 */
#define DC_CALL(fn, callee) \
    DC_META_ENTRY(DC_JOIN3(dc_meta_call_, fn, DC_JOIN2(_, callee)), "call", #callee, "", #fn, "", 0, 0)

/* 模块根：存在根时查看器默认只列根模块。每个模块最多用一次。 */
#define DC_MODULE_ROOT() \
    DC_META_ENTRY(dc_meta_module_root, "module", "", "root", DC_META_MODULE, "", 0, 0)

/* 段边界访问器（实现在 DrawcodeMeta.c）。没有元数据段时返回 NULL。 */
const dc_meta_entry *dc_meta_begin(void);
const dc_meta_entry *dc_meta_end(void);

#ifdef __cplusplus
}
#endif

#endif /* DRAWCODE_META_H */
