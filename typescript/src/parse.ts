import { parseProject } from "./cparse.ts";
import { parseCsProject } from "./csparse.ts";
import { abspath, dirname } from "./fsutil.ts";
import { Model } from "./model.ts";

const CS_EXT = ".cs";
const C_EXT = [".c", ".h", ".cpp", ".hpp", ".cc", ".hh"];

/** 按扩展名分派到语言绑定，多个语言的结果合并进同一个 IR。 */
export function parseAny(paths: string[], root?: string): Model {
  const resolvedRoot = root ?? dirname(abspath(paths[0] as string));

  const cs = paths.filter((p) => p.toLowerCase().endsWith(CS_EXT));
  const c = paths.filter((p) => C_EXT.some((ext) => p.toLowerCase().endsWith(ext)));
  const unknown = paths.filter((p) => !cs.includes(p) && !c.includes(p));
  if (unknown.length > 0) {
    throw new Error(`不支持的文件类型: ${unknown.join(", ")}`);
  }

  const parts: Model[] = [];
  if (c.length > 0) parts.push(parseProject(c, resolvedRoot));
  if (cs.length > 0) parts.push(parseCsProject(cs, resolvedRoot));
  if (parts.length === 1) return parts[0] as Model;

  const merged = new Model([]);
  for (const sub of parts) {
    for (const [k, v] of sub.signals) merged.signals.set(k, v);
    for (const [k, v] of sub.funcs) merged.funcs.set(k, v);
    for (const [k, v] of sub.devices) merged.devices.set(k, v);
    merged.files.push(...sub.files);
  }
  merged.rebuildEdges();
  return merged;
}
