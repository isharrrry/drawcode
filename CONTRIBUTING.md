# Contributing to drawcode

**English** | [中文](docs/contributing.zh-CN.md) | [Español](docs/contributing.es.md)

This is the entry point GitHub shows for the repository. The full guide lives in
[`docs/contributing.md`](docs/contributing.md): environment, repository map, the test suite, golden
cases, adding a source language, offline rendering, and what is deliberately not verified.

## Quick start

```bash
npm install   # installs both packages: typescript/ and editors/vscode/
npm test      # runs the core suite, then builds and tests the VS Code extension
```

Node 22.18 or newer is required. A .NET 10 SDK/runtime is only needed to read PE/CLI `.dll`
artifacts; ELF/ar reading and the source pipeline run in-process without it.

## What lives where

| Path | Contains |
| :--- | :--- |
| [`typescript/`](typescript/) | the core implementation and CLI (`node --test` from here) |
| [`editors/vscode/`](editors/vscode/) | the Drawcode Artifact Viewer extension (`npm run package` produces the VSIX) |
| [`docs/`](docs/) | user and contributor documentation; start at [`docs/index.md`](docs/index.md) |
| [`tools/`](tools/) | repo assets — golden cases, the .NET metadata sidecar, the offline renderer |
| [`templates/`](templates/), [`examples/`](examples/) | metadata templates and sample projects |

## Releases

The core and the extension share one version number. Do not edit a `version` field by hand:
[`docs/versioning.md`](docs/versioning.md) lists the files that carry the version and the
`npm run bump -- <version>` script that updates them together.

## Before you commit

- Run `npm test` from the repository root.
- A change to the IR or geometry moves the golden files; review that diff and name the level in the
  commit message (see [the full guide](docs/contributing.md#adding-a-golden-case)).
- Use a real git identity. A placeholder such as `user <1@1.1>` is rejected in review.
