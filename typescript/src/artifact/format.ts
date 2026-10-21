/**
 * 按 magic bytes 判断产物容器格式。
 *
 * 为什么不用扩展名：用户会把 `.so` 命名成 `.dll`，把 `.out` 命名为任意名字，
 * 而 `.a` 与 `.o` 在不同工具链下共用后缀。扩展名只是提示，字节才是事实。
 *
 * 判定顺序按 magic 长度从长到短，避免短前缀误判：
 *   ar  `!<arch>\n`（8 字节）
 *   ELF `\x7fELF`（4 字节）
 *   PE  `MZ`（2 字节）
 * 其中 PE 的 `MZ` 只是 DOS 头标记；是否真的带 CLI 头由 `pe.ts` 继续校验。
 */

import type { ArtifactFormat } from "./model.ts";

/** 粗粒度格式，只区分容器；`pe-cli` / `pe-native` 要解析完 PE 头才知道。 */
export type ContainerFormat = "ar" | "pe" | "elf" | "unknown";

const AR_MAGIC = [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a]; // "!<arch>\n"
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]; // "\x7fELF"
const PE_MAGIC = [0x4d, 0x5a]; // "MZ"

function startsWith(buf: Uint8Array, magic: readonly number[]): boolean {
  if (buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buf[i] !== magic[i]) return false;
  }
  return true;
}

/** 只读前 8 个字节即可判定容器格式；未知时返回 `"unknown"`。 */
export function detectFormat(buf: Uint8Array): ContainerFormat {
  if (startsWith(buf, AR_MAGIC)) return "ar";
  if (startsWith(buf, ELF_MAGIC)) return "elf";
  if (startsWith(buf, PE_MAGIC)) return "pe";
  return "unknown";
}

/**
 * 把粗粒度容器格式映射为模型里的 `ArtifactFormat`。
 * PE 的细分（cli / native）由调用方在解析后覆盖，这里先给出最保守的值。
 */
export function toArtifactFormat(container: Exclude<ContainerFormat, "unknown">): ArtifactFormat {
  if (container === "pe") return "pe-native";
  return container;
}
