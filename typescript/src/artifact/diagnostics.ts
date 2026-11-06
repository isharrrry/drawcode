/**
 * 诊断收集器。
 *
 * 读取器的目标不是「解析失败就抛异常」：一个缺一半数据链的产物仍然是**有信息量**的，
 * 视图要能把它画出来并标出缺口。所以这里用「收集」而不是「短路」——
 * 能读多少读多少，读不了的地方留下一条带 code 的诊断。
 *
 * 收集器是显式累加器：同一个 bag 在读取过程中被追加，读取结束时 `items` 给出快照。
 * 这不是隐蔽的副作用（调用点都拿着同一个 bag），而是避免每层函数都把数组当返回值传。
 */

import type { Diagnostic, DiagnosticCode, DiagnosticSeverity } from "./model.ts";

/** 诊断码常量。写成对象是为了让读取器里 `DIAG.noMetadata` 比裸字符串更难拼错。 */
export const DIAG = {
  unknownFormat: "unknown-format",
  unsupportedNativePe: "unsupported-native-pe",
  noMetadata: "no-metadata",
  missingMetadataSection: "missing-metadata-section",
  versionMismatch: "version-mismatch",
  danglingRead: "dangling-read",
  danglingWrite: "dangling-write",
  truncatedSection: "truncated-section",
  unsupportedArch: "unsupported-arch",
  trimmedMetadata: "trimmed-metadata",
  gcSectionsRisk: "gc-sections-risk",
  inferredEdges: "inferred-edges",
  toolUnavailable: "tool-unavailable",
  dotnetMissing: "dotnet-missing",
  dotnetRuntimeMissing: "dotnet-runtime-missing",
} as const satisfies Record<string, DiagnosticCode>;

/** 构造一条诊断。`subject` 用稳定 id 或 `0x` 地址，方便在视图里定位。 */
export function makeDiagnostic(
  severity: DiagnosticSeverity,
  code: DiagnosticCode,
  message: string,
  subject?: string,
): Diagnostic {
  const d: Diagnostic = { severity, code, message };
  if (subject !== undefined) d.subject = subject;
  return d;
}

/** 读取过程中的诊断累加器。 */
export class DiagnosticBag {
  private readonly list: Diagnostic[] = [];

  add(d: Diagnostic): void {
    this.list.push(d);
  }

  error(code: DiagnosticCode, message: string, subject?: string): void {
    this.add(makeDiagnostic("error", code, message, subject));
  }

  warn(code: DiagnosticCode, message: string, subject?: string): void {
    this.add(makeDiagnostic("warning", code, message, subject));
  }

  info(code: DiagnosticCode, message: string, subject?: string): void {
    this.add(makeDiagnostic("info", code, message, subject));
  }

  /** 返回副本：调用方拿到后不会再被后续 `add` 改动。 */
  get items(): Diagnostic[] {
    return [...this.list];
  }

  get size(): number {
    return this.list.length;
  }
}
