/**
 * 打开对话框的程序集过滤器。
 *
 * 单独放一个文件，是为了让「打开程序集」和「把程序集加入程序集树」共用
 * 同一份扩展名清单；两边各写一份迟早会漂移（例如新增 .dylib 时漏改一处）。
 */
export const ARTIFACT_FILTERS: Record<string, string[]> = {
  程序集: ["dll", "so", "out", "a", "o"],
  所有文件: ["*"],
};
