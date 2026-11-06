# Changelog

## 0.4.1 — 2026-11-06

### Fixed

- Marketplace metadata: the packaged VSIX now declares `Tags`, `Categories`, a `License`
  asset and the repository/support links. Without them the gallery page showed empty
  category and tag sections, and the License link pointed nowhere.

## 0.4.0 — 2026-11-06

First public release.

### Artifact browsing

- Open `.dll`, `.so`, `.out`, `.a` and `.o` files and read their modules, cross-module calls,
  signal data and persistence declarations.
- Organise artifacts into one or more named trees with groups and aliases; each tree is stored
  with the workspace.
- PE/CLI artifacts are read through a bundled .NET sidecar; ELF, `ar` and source inputs are read
  in-process.

### Source ⇄ diagram

- Annotated C/C# source to `.drawio`, and `sync` back into the source without rewriting function
  bodies.
- Metadata templates for annotating existing headers and attribute files.

### Command line

- `drawcode build`, `drawcode sync` and `drawcode inspect` (canonical JSON `ArtifactModel`).

### Requirements

- VS Code 1.90 or newer.
- Node 22.18 or newer for the CLI.
- .NET 10 runtime for reading PE/CLI artifacts.
