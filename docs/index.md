# Documentation

**English** | [中文](index.zh-CN.md) | [Español](index.es.md)

> Documentation for [drawcode](../README.md) — a bidirectional code ↔ dataflow-diagram tool where source code is the single source of truth.

Every topic below exists in all three languages. The English version is written first and in full;
the other two are faithful translations, not summaries. All three are updated in the same change.

## Topics

| Topic | Language versions | What it covers |
| :--- | :--- | :--- |
| **Architecture** | [English](architecture.md) · [中文](architecture.zh-CN.md) · [Español](architecture.es.md) | The layering, what each module owns, the two data flows (build and sync), and the reasoning behind refusing to persist an intermediate representation |
| **Annotations** | [English](annotations.md) · [中文](annotations.zh-CN.md) · [Español](annotations.es.md) | Field-level reference for every annotation key: `@drawcode` and `@device` comments (C), `[Drawcode]` and `[Device]` attributes (C#) — with types, defaults and examples |
| **`.drawio` format** | [English](drawio-format.md) · [中文](drawio-format.zh-CN.md) · [Español](drawio-format.es.md) | Element mapping, coordinate semantics, anchor and routing rules, and draw.io's compressed storage form |
| **Benchmark** | [English](benchmark.md) · [中文](benchmark.zh-CN.md) · [Español](benchmark.es.md) | Measured performance across the three implementations, with the raw numbers and where the time actually goes |
| **Implementations** | [English](implementations.md) · [中文](implementations.zh-CN.md) · [Español](implementations.es.md) | How to build, test and invoke each of the Python, TypeScript and .NET versions |
| **Contributing** | [English](contributing.md) · [中文](contributing.zh-CN.md) · [Español](contributing.es.md) | Environment, running tests, adding golden cases, adding a source language, and what is deliberately unverified |

## Where to start

| You want to… | Go to |
| :--- | :--- |
| Understand why the design is shaped this way | [Architecture](architecture.md) |
| Annotate your own code for the first time | [Annotations](annotations.md) → then [Quick start](../README.md#quick-start) |
| Add a new source language (Rust, Go, …) | [Architecture](architecture.md#module-layering) → [Contributing](contributing.md) |
| Implement the whole capability yourself | [`python/SKILL.md`](../python/SKILL.md), [`typescript/SKILL.md`](../typescript/SKILL.md), [`dotnet/SKILL.md`](../dotnet/SKILL.md) |
| Know how the three versions are kept identical | [`conformance.md`](conformance.md) |
| See the measured numbers | [Benchmark](benchmark.md) |
| Diagnose a diagram that lost its layout | [`.drawio` format](drawio-format.md#compressed-storage) |
| Render a `.drawio` to an image without draw.io installed | [`tools/render/`](../tools/render/README.md) |

## About these documents

1. **Every number comes from a command that was actually run.** Nothing is estimated. Where a
   figure has not been measured, the document says so and points to
   [Known limitations](../README.md#known-limitations-listed-honestly) rather than filling the gap.
2. **Changing code means changing all three languages of these docs in the same commit.** A
   documented behaviour that only exists in one language version is a bug, not a translation lag.
3. **Unverified and known-broken behaviour is stated explicitly.** Two examples worth calling out:
   the SVG preview does not share the `.drawio` edge routing, and the offline renderer cannot draw
   `jumpStyle` line jumps. Both are written down where a reader will hit them, not buried.
