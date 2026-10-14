/**
 * 对等 Python `html.escape`。
 *
 * 存在的理由：`drawio.py` / `svg.py` 用它把 label 里的 `<br>` 变成 `&lt;br&gt;`，
 * 再交给属性序列化转义第二遍。两遍转义的顺序不能乱，否则 `&` 会被重复转义。
 */
export function escapeHtml(value: string, quote = true): string {
  let out = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (quote) {
    out = out.replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  }
  return out;
}
