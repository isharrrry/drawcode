---
type: Guide
title: Versioning
description: One version for the whole repository — which files carry it and how to bump it
tags: [versioning, release, contributing]
status: stable
---

# Versioning

**English** | [中文](versioning.zh-CN.md)

[← Documentation index](index.md)

drawcode keeps **one version number for the whole repository**. The core library and the VS Code
extension are released together: the extension compiles `typescript/src` into `dist/core/` and ships
it inside the same VSIX, so a separately versioned core would describe a state that no package ever
has on its own.

This is policy **B** (unified version). The alternative — core and extension versioned
independently — was rejected because there is no release in which only one of them moves.

## Files that carry the version

| File | Field |
| :--- | :--- |
| [`package.json`](../package.json) | root orchestration package |
| [`typescript/package.json`](../typescript/package.json) | core library |
| [`editors/vscode/package.json`](../editors/vscode/package.json) | `drawcode-artifact-viewer`; the version shown on the Marketplace page |
| [`editors/vscode/package-lock.json`](../editors/vscode/package-lock.json) | lockfile, top level and `packages[""]` |
| [`package-lock.json`](../package-lock.json) | root lockfile, top level and `packages[""]` |

They must always agree. `npm run version:check` fails when they do not.

## Bumping

```bash
npm run bump -- 0.5.0     # rewrites every file above
npm test                  # verify the tree before committing
```

The script accepts only a plain `MAJOR.MINOR.PATCH` version and does not touch git: commit the
version files in the same change. Tag the commit only when a release is actually published.

## Rules

- **One bump, one release.** A change that ships in the VSIX moves the extension version; because
  the core is compiled into that VSIX, the core version moves with it.
- **The VSIX filename follows the extension version** —
  `out/drawcode-artifact-viewer-<version>.vsix`.
- **Never hand-edit a single `version` field.** A partial bump produces a package whose manifest,
  lockfile and VSIX disagree, which is exactly what `npm run version:check` exists to prevent.
- **Breaking changes still bump the minor while the project is pre-1.0.** There is no stable public
  API yet; the changelog and the conformance suite, not the version digit, are what tell a reader
  how large a change is.
