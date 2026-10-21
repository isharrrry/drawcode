/*
 * drawcode C 模板示例：元数据紧挨着它描述的对象。
 *
 * 读取器只看 `dc_meta_entries` 段，所以宏的位置由“人怎么读代码”决定，
 * 而不是由编译器决定。这里把每条记录放在对应声明/定义的正上方，
 * 改一个变量时能立刻看到它有没有登记、标签写全没有。
 *
 * 覆盖的元素：
 *   - 类型：enum（含成员）、struct（含字段偏移/大小）；
 *   - 信号：标量、枚举、结构体，带方向/单位/初值/别名/分组；
 *   - 函数：返回类型、参数、别名、备注，以及 READ/WRITE/CALL 关系。
 *
 * 覆盖的属性：
 *   - direction（in/out/inout）、store、exclude、path、alias、unit、init、note；
 *   - kind/size 仅类型记录使用；裸词（telemetry/rmem/config）作为业务标签。
 *
 * 对照 C# 示例：C# 的 [Drawcode(...)] 能直接写 Direction/Path/Store，
 * C 模板把这些压进 tag 字符串（见 DrawcodeMeta.h 的 tag 约定），
 * 读取器解析后得到同一套模型字段。
 *
 * 注意 tag 只有 47 字节（UTF-8，中文一个字 3 字节）：属性写不下时优先保
 * direction/unit/init 这类调试要用的，别把 alias 写成一整句话。
 *
 * 宏只产生数据，不引用任何符号地址，因此 .o 里没有需要解析的重定位。
 */

#define DC_META_MODULE "demo"

#include <stdbool.h>
#include <stdint.h>

#include "DrawcodeMeta.h"

/* ------------------------------------------------------------------ */
/* 类型层                                                              */
/* ------------------------------------------------------------------ */

typedef enum DcMode
{
    DC_MODE_IDLE = 0,
    DC_MODE_RUN = 1,
    DC_MODE_FAULT = 2,
} DcMode;

/* 类型记录紧跟定义：kind 让读取器知道这是枚举，而不是猜成 struct。 */
DC_TYPE(DcMode, "kind=enum,size=4,alias=Mode");
/* 枚举成员单独登记，视图的「初值」列就是成员值。 */
DC_ENUM_MEMBER(DcMode, DC_MODE_IDLE, "alias=空闲");
DC_ENUM_MEMBER(DcMode, DC_MODE_RUN, "alias=运行");
DC_ENUM_MEMBER(DcMode, DC_MODE_FAULT, "alias=故障");

typedef struct DcState
{
    double voltage;   /* 母线电压，V */
    int32_t count;    /* 采样计数 */
    float gain;       /* 增益，无量纲 */
    DcMode mode;      /* 当前运行模式 */
    uint32_t flags;   /* 位标志 */
} DcState;

/* store：该类型参与持久化（ER 视图会把它展开成表）。 */
DC_TYPE(DcState, "store,kind=struct,alias=State");
/* 字段记录紧跟在结构体定义之后：offsetof/sizeof 在这里是常量。 */
DC_FIELD(DcState, voltage, "rmem,unit=V,init=0,alias=电压");
DC_FIELD(DcState, count, "rmem,init=0,alias=计数");
DC_FIELD(DcState, gain, "rmem,unit=1,init=1,alias=增益");
DC_FIELD_AS(DcState, mode, "DcMode", "rmem,init=0,alias=模式");
DC_FIELD(DcState, flags, "rmem,init=0,alias=标志");

/* 第二个持久化类型：演示嵌套自定义类型字段。 */
typedef struct DcConfig
{
    double threshold; /* 保护阈值，V */
    uint32_t window;  /* 滑动窗长度 */
    DcMode fallback;  /* 故障回退模式 */
} DcConfig;

DC_TYPE(DcConfig, "store,kind=struct,alias=Config");
DC_FIELD(DcConfig, threshold, "rmem,unit=V,init=24,alias=阈值");
DC_FIELD(DcConfig, window, "rmem,init=8,alias=窗长");
DC_FIELD_AS(DcConfig, fallback, "DcMode", "rmem,init=0,alias=回退");

/* ------------------------------------------------------------------ */
/* 信号层：每条 DC_SIGNAL 就是它下面那个变量的登记表                    */
/* ------------------------------------------------------------------ */

/* store 在信号上保留为标签：全局量是否掉电保持，调试时同样要看。 */
DC_SIGNAL(g_state, "store,direction=inout,path=state,alias=状态", "DcState");
DcState g_state;

DC_SIGNAL(g_config, "store,direction=in,path=config,alias=配置", "DcConfig");
DcConfig g_config;

DC_SIGNAL(g_output_voltage, "telemetry,direction=out,unit=V,init=0", "double");
double g_output_voltage;

DC_SIGNAL(g_filtered_voltage, "telemetry,direction=out,unit=V,init=0", "double");
double g_filtered_voltage;

DC_SIGNAL(g_fault_code, "telemetry,direction=out,init=0,alias=故障码", "uint32");
uint32_t g_fault_code;

DC_SIGNAL(g_mode, "direction=inout,init=0,alias=模式", "DcMode");
DcMode g_mode;

DC_SIGNAL(g_heartbeat, "telemetry,direction=out,init=0", "bool");
bool g_heartbeat;

DC_SIGNAL(g_threshold, "config,direction=in,unit=V,init=24.0", "double");
double g_threshold;

DC_SIGNAL(g_sample_count, "telemetry,direction=inout,init=0", "uint32");
uint32_t g_sample_count;

/* exclude：内部量默认隐藏，但仍在模型里，取消过滤即可看到。 */
DC_SIGNAL(g_scratch, "exclude,direction=inout,init=0", "double");
double g_scratch;

/* ------------------------------------------------------------------ */
/* 函数层：函数记录 + 参数 + 读写/调用边，都放在实现正上方              */
/* ------------------------------------------------------------------ */

DC_FUNCTION_AS(reset_state, "void", "alias=Reset,note=复位");
DC_WRITE(reset_state, g_state);
DC_WRITE(reset_state, g_mode);
DC_WRITE(reset_state, g_fault_code);
DC_WRITE(reset_state, g_heartbeat);
void reset_state(void)
{
    g_state.mode = DC_MODE_IDLE;
    g_state.count = 0;
    g_mode = DC_MODE_IDLE;
    g_fault_code = 0;
    g_heartbeat = 0;
}

DC_FUNCTION_AS(producer, "void", "alias=Produce,note=产生遥测");
DC_READ(producer, g_threshold);
DC_WRITE(producer, g_state);
DC_WRITE(producer, g_output_voltage);
DC_WRITE(producer, g_heartbeat);
DC_WRITE(producer, g_sample_count);
void producer(void)
{
    g_state.voltage = g_threshold + (double)g_state.count * 0.01;
    g_state.count += 1;
    g_output_voltage = g_state.voltage;
    g_heartbeat = true;
    g_sample_count += 1;
}

DC_FUNCTION_AS(consumer, "void", "alias=Consume,note=消费遥测");
DC_READ(consumer, g_output_voltage);
DC_READ(consumer, g_filtered_voltage);
DC_READ(consumer, g_fault_code);
DC_WRITE(consumer, g_state);
DC_CALL(consumer, producer);
void consumer(void)
{
    producer();
    g_state.voltage = g_output_voltage;
    g_state.gain = (float)g_filtered_voltage;
    if (g_fault_code != 0)
    {
        g_state.mode = DC_MODE_FAULT;
    }
}

DC_FUNCTION_AS(calibrate, "void", "alias=Calibrate,note=零点校准");
DC_PARAM(calibrate, 0, zero, "double", "direction=in,unit=V,alias=零点");
DC_READ(calibrate, g_state);
DC_WRITE(calibrate, g_state);
void calibrate(double zero)
{
    g_state.voltage -= zero;
    g_state.count = 0;
}

DC_FUNCTION_AS(filter_sample, "int32", "alias=Filter,note=滑动窗滤波");
DC_PARAM(filter_sample, 0, sample, "double", "direction=in,unit=V,alias=采样");
DC_PARAM(filter_sample, 1, out, "double *", "direction=out,unit=V,alias=结果");
DC_READ(filter_sample, g_config);
DC_READ(filter_sample, g_scratch);
DC_WRITE(filter_sample, g_scratch);
DC_WRITE(filter_sample, g_filtered_voltage);
DC_WRITE(filter_sample, g_sample_count);
int32_t filter_sample(double sample, double *out)
{
    double acc = sample;
    uint32_t i;
    for (i = 0; i < g_config.window; i++)
    {
        acc += g_scratch;
    }
    g_scratch = sample;
    *out = acc / (double)(g_config.window + 1u);
    g_filtered_voltage = *out;
    g_sample_count += 1;
    return 0;
}

DC_FUNCTION_AS(apply_config, "bool", "alias=ApplyConfig,note=应用配置");
DC_PARAM(apply_config, 0, cfg, "const DcConfig *", "direction=in,alias=配置");
DC_WRITE(apply_config, g_config);
DC_WRITE(apply_config, g_threshold);
bool apply_config(const DcConfig *cfg)
{
    if (cfg == 0)
    {
        return false;
    }
    g_config = *cfg;
    g_threshold = cfg->threshold;
    return true;
}

DC_FUNCTION_AS(compute_gain, "float", "alias=ComputeGain,note=计算增益");
DC_PARAM(compute_gain, 0, base, "float", "direction=in,unit=dB,alias=基准");
DC_PARAM(compute_gain, 1, step, "int32", "direction=in,alias=步进");
float compute_gain(float base, int32_t step)
{
    float gain = base + (float)step * 0.5f;
    if (gain < 0.0f)
    {
        gain = 0.0f;
    }
    return gain;
}

DC_FUNCTION_AS(watchdog, "DcMode", "alias=Watchdog,note=看门狗");
DC_PARAM(watchdog, 0, now_ms, "uint32", "direction=in,unit=ms,alias=毫秒");
DC_READ(watchdog, g_state);
DC_READ(watchdog, g_mode);
DC_READ(watchdog, g_heartbeat);
DC_WRITE(watchdog, g_fault_code);
DC_CALL(watchdog, reset_state);
DcMode watchdog(uint32_t now_ms)
{
    if (now_ms == 0u || !g_heartbeat || g_state.mode == DC_MODE_FAULT)
    {
        g_fault_code = 1;
        reset_state();
        return DC_MODE_FAULT;
    }
    return g_mode;
}

DC_FUNCTION_AS(dispatcher, "void", "alias=Dispatch,note=调度");
DC_READ(dispatcher, g_mode);
DC_WRITE(dispatcher, g_fault_code);
DC_CALL(dispatcher, consumer);
DC_CALL(dispatcher, calibrate);
DC_CALL(dispatcher, watchdog);
void dispatcher(void)
{
    switch (g_mode)
    {
    case DC_MODE_RUN:
        consumer();
        break;
    case DC_MODE_FAULT:
        g_fault_code = 1;
        (void)watchdog(0u);
        break;
    default:
        calibrate(0.0);
        break;
    }
}

DC_FUNCTION_AS(snapshot, "void", "alias=Snapshot,note=状态快照");
DC_PARAM(snapshot, 0, out, "DcState *", "direction=out,alias=快照");
DC_READ(snapshot, g_state);
DC_READ(snapshot, g_sample_count);
void snapshot(DcState *out)
{
    if (out != 0)
    {
        *out = g_state;
        out->count = (int32_t)g_sample_count;
    }
}

/* 本模块是 ICD 根：查看器默认只列根模块。 */
DC_MODULE_ROOT();
