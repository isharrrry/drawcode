---
type: Reference
title: Artifact format
description: The ArtifactModel produced by drawcode inspect — supported binaries, stable ids, diagnostics, canonical JSON, and why this path is separate from the source IR
tags: [artifact, binary, pe, elf, inspection]
status: draft
---

# Artifact format

[← Documentation index](index.md)

`drawcode inspect` reads a **compiled artifact** and returns a read-only model of its
modules, signals, types, functions and edges. This is a second input path, parallel to the
source parser.

The source path (`build` / `sync` / `dump-ir`) is unchanged: source is still the single
source of truth, the IR still lives only in memory, and the output still matches the golden
`.drawio` files byte-for-byte. The artifact path deliberately does **not** feed
into `.drawio` generation, so it cannot drift the golden files.

## What can be read

| Input | Format | Status |
| :--- | :--- | :--- |
| `.dll` with CLI metadata | `pe-cli` | Implemented (via the .NET sidecar) |
| Native PE / NativeAOT | `pe-native` | Header only; `unsupported-native-pe` diagnostic |
| `.so`, `.out`, `.o` | `elf` | Implemented in-process (ELF32 / ELF64 little-endian) |
| `.a` | `ar` | Implemented in-process (GNU long names; members read as ELF) |
| Anything else | `unknown` | Empty model + `unknown-format` diagnostic |

The format is decided by **magic bytes**, never by extension: an ELF named `.dll` is read
as ELF, and a `.so` full of random bytes is reported as unknown.

Open a PE artifact **without loading it**: the parser uses `System.Reflection.Metadata`
(`PEReader`) inside `tools/drawcode-metadata`. It never calls `Assembly.Load`, never
resolves dependencies, and never executes target code. Opening an artifact is not running it.

ELF and ar are read directly from bytes, with no external tool and no symbol-table parsing.
The C template writes fixed 200-byte records into a `dc_meta_entries` section; the reader
slices that section by the same fixed size. The record holds inline `char[]` strings, not
pointers, so an unlinked `.o` is readable without relocations, and `strip` does not affect it.

| Offset | Field | Meaning |
| ---: | :--- | :--- |
| 0 | `name[48]` | Signal, function, parameter, enum member, field or callee name |
| 48 | `tag[48]` | Comma-separated tags; `root` / `exclude` / `store` and `key=value` attributes are reserved |
| 96 | `kind[16]` | `anchor` / `module` / `signal` / `field` / `function` / `param` / `enum_member` / `read` / `write` / `call` |
| 112 | `owner[32]` | Module, owning type, function, or caller |
| 144 | `type[40]` | C type string; on a `function` record it is the return type |
| 184 | `size` | Field size; `0` when unknown |
| 188 | `offset` | Field offset in its struct; parameter index for `param`; enumerator value for `enum_member`; `0` when unknown |
| 192 | `order` | Declaration counter (`__COUNTER__`), used to restore source order |

GCC and Clang append section entries in reverse declaration order, so the reader sorts by
`order`. Records with `order = 0` (older artifacts) keep their section order.

The `tag` column carries both business labels and structured attributes, so the 200-byte
layout did not have to change when they were added. The reader consumes
`alias` / `unit` / `note` / `init` / `direction` / `path` and `kind` / `size`; `direction`
accepts `in` / `out` / `inout` (also `input` / `output` / `io`) and maps to
`Signal.dir` / `Param.dir`, while `path` maps to `Signal.path` / `Func.path`. Anything the
reader does not recognise stays in `tags` and is displayed verbatim.

`param` records attach to the function named in `owner`; their `offset` is the zero-based
position in the signature, so parameters come out in source order regardless of macro
placement. Their `direction` maps to `ArtifactParam.dir`, and `alias` / `unit` are carried
into `ArtifactParam.alias` / `.unit` (the keys stay absent when the tag does not set them).
`enum_member` records attach to the type named in `owner`, with the enumerator
value encoded in `offset` (unsigned) and surfaced as `TypeField.initial`. Unknown kinds are
skipped, which keeps older readers working when a template adds a new record type.

ELF32 and ELF64 little-endian are both supported (a 32-bit ARM `.out` reads the same
`dc_meta_entries` records as a 64-bit `.so`). Big-endian and unknown `e_machine` values
produce `unsupported-arch` rather than a best-effort guess. In an archive, members without
the metadata section are normal (third-party objects); they are skipped, and the archive
reports `no-metadata` only when no member carries it.

## Model

`ArtifactModel` is a snapshot. Consumers read it; nothing writes back.

```ts
interface ArtifactModel {
  info: ArtifactInfo;
  modules: ArtifactModule[];
  types: ArtifactType[];
  signals: ArtifactSignal[];
  funcs: ArtifactFunc[];
  edges: ArtifactEdge[];
  diagnostics: Diagnostic[];
}
```

### `info`

| Field | Meaning |
| :--- | :--- |
| `path` | Basename only. Never an absolute path — canonical JSON must compare across machines. |
| `format` | `pe-cli` / `pe-native` / `elf` / `ar` / `unknown` |
| `arch` | `x64` / `x86` / `arm` / `arm64` / `mips` / `ppc` / `ppc64` / `riscv64`; empty when unknown |
| `kind` | `dll` / `so` / `exe` / `object` / `archive` / `unknown` |
| `hasMetadata` | Whether drawcode metadata was found |
| `metadataVersion` | Template version (`0` when absent) |
| `entryPoint` | Managed entry point name, when the image has one |

### `modules`

The tree is lazy by contract: `children` lists ids only, so a viewer can request one level
at a time. `counts` is the **subtree** count (including the module itself), used for the
overview and for module-level aggregation above 2,000 nodes. `root` marks a module that
the tree shows by default; `exclude` marks one hidden by default.

### `signals` and `types`

A signal is a field/global annotated with `DrawcodeAttribute` (or, for C, a metadata record).
`dir` is mapped **verbatim from the enum name**: `None -> ""`, `In -> "in"`, `Out -> "out"`,
`Io -> "inout"`. The template's comments define `In` as "produced by the module" and `Out`
as "consumed by the module"; the reader must not "correct" this, or every arrow in the
artifact view flips relative to the source diagram.

`TypeField.typeId` points at another `ArtifactType.id` when the field type is defined in the
same assembly, which is what lets the persistent-data view drill into nested types.
`offset` / `size` are `0` when the reader cannot establish layout from metadata alone.

### `funcs` and `edges`

`reads` / `writes` / `calls` on a function are id lists, mirrored by the flat `edges` array.
Both are derived from one scan; a consumer should not need to merge them.

Cross-assembly calls are **not** turned into edges. A single component method otherwise
drags in thousands of `Add` / `ContainsKey` / `.ctor` calls that are neither component
relationships nor data flow. Generic methods are skipped, and a call whose target has no
function node produces no edge — the model never contains a dangling edge.

## Stable ids

Ids contain no absolute path, load address or random value. Parsing the same artifact twice,
on two machines, yields the same id set.

| Entity | Rule |
| :--- | :--- |
| Assembly module | `<assembly-name>` |
| Namespace module | `<assembly-name>::<namespace>` |
| Type | `<assembly-name>::<namespace>.<type>` |
| Field signal | `...::<type>#<field>` |
| Function | `...::<type>.<method>`; overloads append the parameter type list |
| External field | `external:<assembly>::<full-name>` (display only, never expanded) |
| C symbol | `<file-stem>::<symbol>` |
| Archive member | `<archive-stem>/<member-stem>::<module>.<symbol>` |

Renaming the file does not change PE ids: the assembly name is the prefix. C ids use the
file stem because an object file has no assembly identity.

## Diagnostics

Diagnostics are part of the model, not exceptions. `inspect` exits `0` for a file that is
readable but carries no metadata; only usage errors and I/O failures exit `2`.

| Code | Severity | Meaning |
| :--- | :--- | :--- |
| `unknown-format` | error | Magic bytes match neither ar, PE nor ELF |
| `tool-unavailable` | warning | The sidecar is missing, `dotnet` is unavailable, or it timed out |
| `unsupported-native-pe` | warning | PE without CLI metadata (NativeAOT / ReadyToRun) |
| `no-metadata` | warning | Recognized container, but no drawcode metadata (ELF without `dc_meta_entries`, archive with no instrumented member) |
| `version-mismatch` | error | Template version is not supported by this reader |
| `dangling-read` | warning | Read of an undeclared/external signal; an `external: true` placeholder was created |
| `dangling-write` | warning | Signal written but never read |
| `truncated-section` | error / warning | Malformed structure stops parsing; a ragged record tail is only warned about |
| `unsupported-arch` | error | ELF machine/endianness not supported |
| `trimmed-metadata` | warning | `PublishTrimmed` removed the annotations |
| `gc-sections-risk` | warning | Metadata section may have been collected by the linker |

## Canonical JSON

`inspect --out` writes a canonical form:

1. object keys sorted by code point;
2. arrays sorted by semantic key — modules/types/signals/funcs by `id`, edges by
   `(src, dst, kind)`, diagnostics by `(severity, code, subject, message)`;
3. order-preserving arrays stay as-is: function parameters and type fields (layout order);
4. set-like arrays (`tags`, `reads`, `writes`, `calls`, `children`) are sorted.

Two runs over the same artifact are byte-identical. Without `--out`, the JSON goes to
stdout with no extra text, so it can be piped into `jq` or diffed directly.

## Dependency and packaging

The PE reader is a .NET 10 sidecar built from `tools/drawcode-metadata`; the TypeScript side
only locates it, runs it with `execFile`, and parses stdout. The sidecar writes UTF-8 bytes
explicitly — a Windows console using GBK would otherwise turn Chinese symbol names into
U+FFFD while every count still looked correct.

- Development: `node tools/publish-metadata-tool.mjs` (framework-dependent, needs .NET 10).
- Release: the bundled VSIX ships the same framework-dependent build, so the machine needs the
  .NET 10 runtime. `--self-contained --runtime <rid>` remains available for machines that cannot
  install .NET; it produces a larger per-platform package with the runtime included.

## Boundaries

- No decompilation, no disassembly, no source reconstruction.
- No reverse translation into source or `.drawio`; the artifact view is strictly read-only.
- Third-party binaries without drawcode metadata get a symbol/format summary at best, not data flow.
- P0 does not support `.exe`, `.dylib`, `.pdb`, or cross-assembly symbol resolution.
- The artifact model is **outside** the L1/L2/L3 conformance suite; `docs/conformance.md`
  is about the source → IR → `.drawio` chain.
