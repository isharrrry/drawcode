/**
 * `ArtifactModel` 的规范化 JSON。
 *
 * 为什么不能直接 `JSON.stringify(model)`：
 *  - 模型的数组来自 sidecar 的遍历顺序（元数据表顺序），它能工作，但不是**契约**；
 *  - 将来 ELF/ar 读取器加入后，不同实现很容易在同一产物上产生不同的数组顺序；
 *  - 测试要拿输出做快照，插件要缓存，工程师要 `diff a.json b.json`。
 *
 * 规整规则（与 `dump.ts` 的 IR 规范化同风格，但不复用其类型）：
 *  1. 对象键按 code point 排序；
 *  2. 数组按语义稳定键排序：模块/类型/信号/函数按 id，边按 (src,dst,kind)，
 *     诊断按 (severity,code,subject,message)；
 *  3. 只有「顺序本身就是语义」的数组保持原序：函数参数、类型字段（布局顺序）；
 *  4. 集合型数组（tags、reads/writes/calls、children）排序后输出。
 *
 * 不剔除任何字段：`address` 是可选展示信息，读取器不给它填运行期地址，
 * 因而不会破坏「同一产物字节一致」。
 */

import type { ArtifactModel } from "./model.ts";
import { compareCodePoints } from "../order.ts";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort(compareCodePoints);
}

/**
 * 返回可逐字节比对的规范 JSON 文本（两空格缩进 + 末尾换行）。
 *
 * 先按语义排序，再递归排序对象键：两步不能合并，因为数组元素的键顺序
 * 不影响排序比较，但影响输出字节。
 */
export function canonicalArtifactJson(model: ArtifactModel): string {
  const modules = [...model.modules]
    .sort((a, b) => compareCodePoints(a.id, b.id))
    .map((m) => ({ ...m, children: sorted(m.children) }));

  const types = [...model.types]
    .sort((a, b) => compareCodePoints(a.id, b.id))
    .map((t) => ({
      ...t,
      tags: sorted(t.tags),
      // fields 保持声明/布局顺序：record 的 positional 参数顺序不能被打乱。
    }));

  const signals = [...model.signals]
    .sort((a, b) => compareCodePoints(a.id, b.id))
    .map((s) => ({ ...s, tags: sorted(s.tags) }));

  const funcs = [...model.funcs]
    .sort((a, b) => compareCodePoints(a.id, b.id))
    .map((f) => ({
      ...f,
      tags: sorted(f.tags),
      reads: sorted(f.reads),
      writes: sorted(f.writes),
      calls: sorted(f.calls),
      // params 保持签名顺序。
    }));

  const edges = [...model.edges].sort(
    (a, b) =>
      compareCodePoints(a.src, b.src) ||
      compareCodePoints(a.dst, b.dst) ||
      compareCodePoints(a.kind, b.kind),
  );

  const diagnostics = [...model.diagnostics].sort(
    (a, b) =>
      compareCodePoints(a.severity, b.severity) ||
      compareCodePoints(a.code, b.code) ||
      compareCodePoints(a.subject ?? "", b.subject ?? "") ||
      compareCodePoints(a.message, b.message),
  );

  const normalized: ArtifactModel = {
    info: model.info,
    modules,
    types,
    signals,
    funcs,
    edges,
    diagnostics,
  };

  return `${JSON.stringify(sortKeys(normalized), null, 2)}\n`;
}
