/*
 * drawcode 元数据模板（C）—— 段锚点与边界访问。
 *
 * 把这个文件一起编译/链接，会做两件事：
 *   1) 往 dc_meta_entries 段写一条 anchor 记录（携带模板版本与模块名）；
 *   2) 引用 `__start_/__stop_`，让链接器知道这个段是「被用到的」，
 *      从而在 --gc-sections 下也不会把它当垃圾回收掉。
 *
 * 如果你的工程不方便链接本文件，至少要在链接脚本里写：
 *   KEEP(*(dc_meta_entries))
 * 否则 -Wl,--gc-sections 可能让整段消失（读取器会报 no-metadata）。
 *
 * 注意：本文件用 `static` 变量名 `dc_meta_anchor`；如果工程里多个文件都链接了
 * 这份实现会重复定义。正确做法是**整个工程只编译一次** DrawcodeMeta.c。
 */

#include "DrawcodeMeta.h"

/*
 * anchor 记录：
 *   kind  = "anchor"
 *   tag   = 版本号字符串（读取器据此判断兼容性）
 *   owner = 模块名
 *   type  = 模板结构名，方便人工排查
 */
DC_META_RETAIN __attribute__((used, section("dc_meta_entries"), aligned(8)))
const dc_meta_entry dc_meta_anchor = {
    .name = "anchor",
    .tag = DC_META_VERSION_TAG,
    .kind = "anchor",
    .owner = DC_META_MODULE,
    .type = "dc_meta_entry",
    .size = (uint32_t)sizeof(dc_meta_entry),
    .offset = 0,
    .order = DC_META_ORDER,
};

/*
 * GNU ld 在链接期为每个自定义段生成 `__start_<name>` / `__stop_<name>`。
 * 声明为 weak：如果整个工程一条元数据都没有，这两个符号不存在，
 * 访问器返回 NULL，而不是链接失败。
 */
extern const dc_meta_entry __start_dc_meta_entries[] __attribute__((weak));
extern const dc_meta_entry __stop_dc_meta_entries[] __attribute__((weak));

const dc_meta_entry *dc_meta_begin(void)
{
    return __start_dc_meta_entries;
}

const dc_meta_entry *dc_meta_end(void)
{
    return __stop_dc_meta_entries;
}
