# Documentation

**English** | [中文](index.zh-CN.md) | [Español](index.es.md)

> Documentation for [drawcode](../README.md) — a bidirectional code ↔ dataflow-diagram tool where source code is the single source of truth.

The English version is written first and in full. Chinese translations are maintained alongside it;
Spanish pages that predate the 2026-10 consolidation are marked *outdated* and point to the English
version.

## Topics

| Topic | Language versions | What it covers |
| :--- | :--- | :--- |
| **Architecture** | [English](architecture.md) · [中文](architecture.zh-CN.md) · [Español](architecture.es.md) | The layering, what each module owns, the two data flows (build and sync), and the reasoning behind refusing to persist an intermediate representation |
| **Annotations** | [English](annotations.md) · [中文](annotations.zh-CN.md) · [Español](annotations.es.md) | Field-level reference for every annotation key: `@drawcode` and `@device` comments (C), `[Drawcode]`, `[Device]` and `[Callout]` attributes (C#) — with types, defaults and examples |
| **`.drawio` format** | [English](drawio-format.md) · [中文](drawio-format.zh-CN.md) · [Español](drawio-format.es.md) | Element mapping, coordinate semantics, anchor and routing rules, and draw.io's compressed storage form |
| **Implementation** | [English](implementations.md) · [中文](implementations.zh-CN.md) · [Español](implementations.es.md) | How to build, test and invoke the TypeScript implementation, and what the golden cases pin |
| **Artifact format** | [English](artifact-format.md) *(no translation yet)* | The `ArtifactModel` emitted by `inspect`: supported binaries, stable ids, diagnostics, canonical JSON, and why this path is separate from the source IR |
| **Examples** | [English](examples.md) *(no translation yet)* | The `small/`, `medium/` and `plain/` sample projects, the committed draw.io export used as a rejection fixture, and how to run each |
| **Templates** | [中文](templates.md) *(no English yet)* | The minimum addition that makes a compiled artifact readable: `DrawcodeMeta.h/.c` for C (ELF) and `DrawcodeAttributes.cs` for C# |
| **VS Code extension** | [中文](vscode-extension.md) *(no English yet)* | Drawcode Artifact Viewer: browsing assemblies read-only, the three views, the artifact tree, export, and settings |
| **Versioning** | [English](versioning.md) · [中文](versioning.zh-CN.md) | The single version number shared by the core and the extension, the files that carry it, and the `npm run bump` script |
| **Contributing** | [English](contributing.md) · [中文](contributing.zh-CN.md) · [Español](contributing.es.md) | Environment, running tests, adding golden cases, adding a source language, and what is deliberately unverified |

## Where to start

| You want to… | Go to |
| :--- | :--- |
| Understand why the design is shaped this way | [Architecture](architecture.md) |
| Annotate your own code for the first time | [Annotations](annotations.md) → then [Quick start](../README.md#quick-start) |
| Add a new source language (Rust, Go, …) | [Architecture](architecture.md#module-layering) → [Contributing](contributing.md) |
| Implement the whole capability yourself | [`typescript/SKILL.md`](../typescript/SKILL.md) |
| Know what the conformance suite compares | [`conformance.md`](conformance.md) |
| See the measured test and verification figures | [`verification.md`](verification.md) |
| Make a compiled artifact readable | [Templates](templates.md) *(中文)* |
| Have an agent build a twin assembly from an idea | [Agent prompts](agent-prompts.md) *(中文)* |
| Browse an assembly in VS Code | [VS Code extension](vscode-extension.md) *(中文)* |
| Run the committed sample projects | [Examples](examples.md) |
| Diagnose a diagram that lost its layout | [`.drawio` format](drawio-format.md#compressed-storage) |
| Render a `.drawio` to an image without draw.io installed | [Contributing § Offline rendering](contributing.md#offline-rendering) |

## About these documents

1. **Every number comes from a command that was actually run.** Nothing is estimated. Where a
   figure has not been measured, the document says so and points to
   [Known limitations](../README.md#known-limitations-listed-honestly) rather than filling the gap.
2. **Changing behaviour means updating the English document and the Chinese translation in the same
   change.** A documented behaviour that exists only in one language version is a bug, not a
   translation lag. Spanish pages that have not been revised are marked *outdated* and point to the
   English version.
3. **Unverified and known-broken behaviour is stated explicitly.** Two examples worth calling out:
   the SVG preview does not share the `.drawio` edge routing, and the offline renderer cannot draw
   `jumpStyle` line jumps. Both are written down where a reader will hit them, not buried.
