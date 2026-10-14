/**
 * 数字 → 字符串，对等 Python `drawio.py::_num`：
 *
 *     v = float(v)
 *     return str(int(v)) if v == int(v) else repr(v)
 *
 * 三个必须对齐的点（全在 SKILL.md 里展开）：
 *   1. 整数值打整数形态 —— `420`，不是 `420.0`；
 *   2. 非整数用**最短往返**表示，`0.5` 打 `0.5`；
 *   3. 指数记法的切换阈值与 JS 不同：Python 在 exp < -4 或 exp >= 16 时用 `1e-05`
 *      这种两位指数，而 JS 的 `String()` 要到 1e-6 / 1e21 才切指数，且指数不补零。
 */

/** 对等 Python `repr(float)` 的浮点部分（整数已在 num() 里分流走）。 */
export function reprFloat(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";

  const fixed = String(value);
  const exponent = parseInt(Math.abs(value).toExponential().split("e")[1] as string, 10);

  // Python 的 repr 在 [-4, 16) 之外改用指数记法。
  if (exponent >= -4 && exponent < 16) return fixed;

  const exponential = value.toExponential();
  const at = exponential.indexOf("e");
  const mantissa = exponential.slice(0, at);
  const tail = exponential.slice(at + 1);
  const sign = tail.startsWith("-") ? "-" : "+";
  const magnitude = tail.replace(/^[+-]/, "").padStart(2, "0");
  return `${mantissa}e${sign}${magnitude}`;
}

export function num(value: number): string {
  const v = Number(value);
  if (Number.isInteger(v)) {
    // `String(1e21)` 是 "1e+21"，而 Python 的 str(int(...)) 是完整数字串。
    if (Math.abs(v) < 1e21) return String(v);
    return BigInt(v).toString();
  }
  return reprFloat(v);
}
