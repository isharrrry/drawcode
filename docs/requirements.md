# Requirements and acceptance criteria

**English** | [中文](requirements.zh-CN.md)

> The requirement contract for **drawcode**: what the product promises, how each promise is judged
> from the outside, and what every other document must be updated when a promise changes.

## Status of this document

This document is the authoritative source for requirements and acceptance. The other documents —
the architecture, annotations, `.drawio` format, artifact format, templates and extension guides —
explain *how* those requirements are met and are written for people implementing or operating the
product. Where this document and any of them disagree, **this document wins**; the other one is
wrong and must be corrected.

A behaviour that is not written here is **not a promise**. Features may exist, be documented
elsewhere and be tested without appearing in this file; that makes them incidental, not contractual.
Anything deliberately not promised is listed in [§6](#6-deferred-and-excluded) rather than left
ambiguous.

## Reading conventions

| Term | Meaning |
| :--- | :--- |
| **SHALL** / **MUST** | Mandatory. A deviation is a defect, not a preference. |
| **MUST NOT** | Forbidden. The prohibition is part of the contract, not advice. |
| **MAY** | Permitted but optional. Absence of the behaviour is not a defect. |
| **SHOULD** | Recommended. A deviation is allowed only when the reason is written down at the point of deviation. |
| **REQ-\<DOMAIN\>-NN** | One requirement. **NN** is two digits, starts at `01` and is contiguous within its domain. Domains are listed in [§3](#3-requirements). |
| **AC-\<DOMAIN\>-NN.M** | One acceptance criterion belonging to the requirement with the same `NN`. **M** starts at `1`. Every requirement has at least one. |
| **WHEN … THEN …** | The criterion is judged from outside the product: a user action, an input file, or an output that can be observed without inspecting internals. |

**How a criterion is judged to have failed.** A criterion fails when an observer who follows only
its **WHEN** clause can see the **THEN** clause not hold — using the product's public surface
(command-line invocation, an editor, a file that was written, a diagnostic that was printed). A
criterion fails *regardless of intent*: an implementation that produces the right answer for the
wrong reason has not met it, and an implementation whose internals look correct but whose observable
output differs has failed it.

A criterion is **not** weakened by an unmeasured implementation detail. If the observable behaviour
cannot be produced today, the correct response is to move the promise to
[§6](#6-deferred-and-excluded) — never to soften the wording here.

## 1. Product intent

1. **The implementation must carry the system summary.** An assembly built from annotated sources is
   simultaneously a runnable program and a structured statement of how its modules cross-link, how
   signals flow, which data is persistent and which modules are decomposition roots. The summary is
   not a separate artefact that a human maintains; it rides the build.
2. **There is exactly one source of truth.** The source text is that source of truth. No
   intermediate representation of the system is ever written to disk: it exists only in memory and is
   rebuilt on every run. A design document that must be kept in step with code is the failure this
   product exists to remove.
3. **The reverse direction is deliberately narrow.** Writing back to source is confined to the
   declaration layer — direction, metadata and layout coordinates pinned by a human. Function bodies
   are never rewritten, because a diagram is a low-fidelity view and any tool that reconstructs logic
   from a picture is guessing inside a source file.
4. **Layout is a human decision and belongs to the diagram.** Coordinates do not participate in
   compilation, and they are the one thing in the system that cannot be regenerated from code.
   Therefore they live in the diagram, are produced by dragging, and are read back on the next run.
5. **A shipped binary must be readable without being run.** A compiled artifact can be inspected for
   the same structure, statically, with no execution, no dynamic loading and no dependency
   resolution of the inspected program.

## 2. Scope and non-goals

### In scope

| Area | What is promised |
| :--- | :--- |
| **Source ingestion** | Parse annotated C and C# sources into an in-memory model of modules, signals, functions, parameters, devices and read/write edges. |
| **Diagram generation** | Emit a valid `.drawio` file that expresses that model with a deterministic default layout and an obstacle-avoiding orthogonal router. |
| **Layout round-trip** | Read layout and a small set of human-editable attributes back out of a `.drawio` file, including the compressed storage form draw.io writes by default. |
| **Declaration write-back** | Rewrite annotation blocks in source to match the diagram, touching nothing else. |
| **Annotation system** | Define the keys and attributes that supply direction, metadata, device data, free text and geometry overrides. |
| **Metadata templates** | Supply copyable C# attribute definitions and C macro records that survive common link, strip and trim options. |
| **Compiled-artifact reading** | Read PE/CLI, ELF and `ar` artifacts statically into a documented model, with stable identifiers and diagnostics, and emit canonical JSON. |
| **Editor integration** | A read-only VS Code editor for artifacts, an artifact tree, an export path, and source-to-diagram generation from the explorer. |
| **Portability** | One command-line toolchain with no third-party runtime dependencies, and one extension package that works on Windows and Linux. |
| **Verification discipline** | A frozen golden-case contract over the model and the geometry, plus a rule that every published number is measured. |

### Out of scope

| Not promised | Why |
| :--- | :--- |
| Decompilation, disassembly or source reconstruction from an artifact | The artifact path produces a structural summary; turning machine code or IL back into readable code is a different product with different guarantees. |
| Reverse translation of an artifact into source or a `.drawio` file | An artifact has no declaration layer to write into and no source to annotate; inventing one would manufacture unverifiable source. |
| State machines, sequence diagrams, timing diagrams and multi-page or layered diagrams | The interaction flow this product models is module cross-link and signal read/write paths; the others need a semantics layer it does not have. |
| Cross-assembly and cross-language symbol resolution | Linking names across languages or assemblies requires whole-program knowledge the inputs do not carry, and the noise from framework calls would drown the signal. |
| MSVC targets, link-time optimisation of instrumented units, `.dylib`, `.exe` and `.pdb` support | The metadata layout and section-retention guarantees are defined for GCC/Clang on ELF and for PE/CLI metadata; the others have different semantics and are not covered. |
| Requirements traceability, verification cases or parametric analysis | These belong to a modelling language with a semantic stack; this product models implementation structure, not requirements. |
| Persisting an intermediate model between runs | A second persisted representation of semantics is the drift this product is designed to eliminate. |

## 3. Requirements

### SRC — source ingestion

#### REQ-SRC-01  Parse C and C-family sources into the model

**Requirement.** The tool SHALL parse C and C-family source files — at minimum `.c`, `.h`, `.cpp`,
`.hpp`, `.cc` and `.hh` — and SHALL parse C# files (`.cs`). A single invocation MUST accept any
mixture of the supported languages and produce one model.

**Rationale.** Adopters already have source in these languages, and requiring a rewrite before
anything can be read is the adoption cost this product is trying to remove.

**Acceptance criteria.**

- **AC-SRC-01.1** — **WHEN** a set of C headers and implementation files is passed to the tool,
  **THEN** the emitted diagram contains a node for every annotated signal and every recognised
  function in those files.
- **AC-SRC-01.2** — **WHEN** a `.cs` file is passed alongside C files, **THEN** one diagram is
  produced containing entities from both, with no error about mixing languages.
- **AC-SRC-01.3** — **WHEN** a file with an unsupported extension is passed, **THEN** the tool
  reports the file as unsupported and does not fail the whole run because of it.

**Evidence.** Parse-level golden comparison (level L1); see *Conformance* and *Examples*.

#### REQ-SRC-02  Only an annotated top-level declaration is a signal

**Requirement.** The tool SHALL treat a top-level variable as a signal only when it carries a
drawcode annotation. An unannotated top-level variable MUST NOT become a signal, regardless of its
type, linkage or spelling. Array declarators SHALL be folded into the type string rather than
producing one entity per element.

**Rationale.** Signals are the vocabulary of the diagram. Inferring them from syntax alone would
flood a diagram with irrelevant globals and make the diagram unreadable; the annotation is the
author's explicit statement that the value crosses a module boundary.

**Acceptance criteria.**

- **AC-SRC-02.1** — **WHEN** a source file contains one annotated and one unannotated top-level
  variable, **THEN** exactly one of them appears as a signal.
- **AC-SRC-02.2** — **WHEN** a signal is declared as `float g_coeff[32];`, **THEN** one signal is
  produced whose type reads `float[32]`.
- **AC-SRC-02.3** — **WHEN** an annotation is attached to something that is not a top-level
  variable, **THEN** no signal is produced for it.

**Evidence.** The signal-key reference and its examples; see *Annotations*.

#### REQ-SRC-03  Functions are recognised by shape, not by annotation

**Requirement.** The tool SHALL recognise a function from its declaration form rather than requiring
an annotation. Control keywords and non-declaration lines MUST NOT be mistaken for functions. An
unannotated function SHALL still become a node; it simply carries no alias.

**Rationale.** Edges come from function bodies, so missing a function silently loses data flow. Shape
recognition keeps the model complete, while the annotation remains optional decoration.

**Acceptance criteria.**

- **AC-SRC-03.1** — **WHEN** a source file defines a function with no annotation above it, **THEN**
  the diagram contains a node labelled with the function's real name.
- **AC-SRC-03.2** — **WHEN** a source file contains control statements such as `if`, `for`, `while`,
  `switch` or `return`, **THEN** none of them becomes a function node.

**Evidence.** Level-L1 golden comparison of functions; see *Conformance*.

#### REQ-SRC-04  Read/write edges are derived from function bodies

**Requirement.** The tool SHALL derive `read` and `write` edges by scanning function bodies for
accesses to declared signals, after removing comments. A compound assignment SHALL count as both a
read and a write of its left operand. Identifiers that do not resolve to a declared signal MUST NOT
produce edges. The tool MUST NOT produce an edge from an annotation.

**Rationale.** The body is where the truth is. Deriving edges from text keeps the diagram from
becoming a hand-maintained parallel description, and it is the reason a comment can change a label
but never move a line.

**Acceptance criteria.**

- **AC-SRC-04.1** — **WHEN** a function body assigns to a declared signal, **THEN** a `write` edge
  runs from the function to that signal.
- **AC-SRC-04.2** — **WHEN** a function body reads a declared signal, **THEN** a `read` edge runs
  from that signal to the function.
- **AC-SRC-04.3** — **WHEN** a signal is annotated but no function body touches it, **THEN** no edge
  is produced for it.
- **AC-SRC-04.4** — **WHEN** a local variable or a parameter shares a name with no declared signal,
  **THEN** no edge is produced for it.

**Evidence.** Edge derivation assertions in the model-level golden cases; see *Annotations* and
*Conformance*.

#### REQ-SRC-05  Multiple inputs merge without symbol resolution

**Requirement.** The tool SHALL merge several input files into one model by concatenation of their
entities. When the same name appears in more than one declaration, the tool SHOULD prefer the header
declaration's annotations. Cross-language name resolution MUST NOT be attempted.

**Rationale.** Merging by concatenation is predictable and needs no notion of a whole program. Symbol
resolution across languages would require a type system spanning both, which the inputs do not
supply.

**Acceptance criteria.**

- **AC-SRC-05.1** — **WHEN** the same signal is declared in a header and defined in an implementation
  file, **THEN** the annotations from the header apply to the single merged signal.
- **AC-SRC-05.2** — **WHEN** a C file and a C# file each declare a signal with the same name,
  **THEN** both exist in the model and no edge is created between them by virtue of the name.

**Evidence.** Merge rules stated with the annotation reference; see *Annotations*.

### SYNC — declaration write-back

#### REQ-SYNC-01  Only the declaration layer is written back

**Requirement.** Writing from a diagram back to source SHALL modify only the annotation block that
belongs to an entity — its direction key, metadata keys, device keys and, where applicable, its
geometry keys. Function bodies MUST NOT be rewritten. Code outside an entity's annotation block MUST
remain byte-identical.

**Rationale.** A diagram knows that a function reads a signal; it does not know loop bounds, error
handling or arithmetic. Confining write-back to declarations makes the operation provably safe: it
can only touch lines whose entire content the diagram represents.

**Acceptance criteria.**

- **AC-SYNC-01.1** — **WHEN** an entity's alias is changed in the diagram and written back, **THEN**
  the annotation block reflects the new alias and the function body is unchanged byte-for-byte.
- **AC-SYNC-01.2** — **WHEN** a source file has statements, comments and formatting outside
  annotation blocks, **THEN** none of them changes as a result of write-back.

**Evidence.** The write-back rule and its "other code untouched" assertion; see *Annotations*.

#### REQ-SYNC-02  Write-back requires explicit authorisation

**Requirement.** A write-back run SHALL be a dry run by default: it reports what would change and
modifies no file. Files are written only when the caller explicitly asks for it.

**Rationale.** A tool that rewrites source by accident is unusable in a version-controlled
repository. Requiring an explicit flag keeps the default safe.

**Acceptance criteria.**

- **AC-SYNC-02.1** — **WHEN** write-back is invoked without the write authorisation, **THEN** the
  tool reports the intended changes and no file modification time changes.
- **AC-SYNC-02.2** — **WHEN** the same invocation is repeated with the write authorisation, **THEN**
  the reported changes are applied.

**Evidence.** Command-line behaviour documented with the command reference; see *Implementation*.

#### REQ-SYNC-03  Merging happens at key level, not line level

**Requirement.** When writing an annotation block, the tool SHALL preserve keys and attributes it
does not manage, including hand-written ones in their original order and spelling, and SHALL rewrite
only the keys whose values actually changed.

**Rationale.** Users customise annotation blocks by hand — an extra style fragment, a compactly
written unit, a device line above the attribute. Replacing the whole block would silently delete that
work.

**Acceptance criteria.**

- **AC-SYNC-03.1** — **WHEN** an annotation block contains a hand-written key the tool does not
  manage, **THEN** that key survives write-back unchanged.
- **AC-SYNC-03.2** — **WHEN** only one attribute of a multi-attribute entity changes, **THEN** the
  other attributes are not rewritten to a different spelling.

**Evidence.** The parameter-level merge rule; see *Annotations*.

#### REQ-SYNC-04  No discrepancy, no change

**Requirement.** The tool SHALL write geometry keys only for entities whose diagram geometry differs
from what a build would have produced. An entity whose source already pins its geometry MUST NOT be
rewritten to the same value in a different spelling. An untouched project SHALL produce
byte-identical source files after a write-back run.

**Rationale.** This is what makes the reverse direction idempotent and keeps an unrelated edit from
generating coordinate noise in a diff.

**Acceptance criteria.**

- **AC-SYNC-04.1** — **WHEN** build, write-back and build are run in sequence without any edit,
  **THEN** the source files are byte-identical to their original state.
- **AC-SYNC-04.2** — **WHEN** a node is dragged in the diagram and written back, **THEN** only that
  entity gains or updates a geometry key.

**Evidence.** The round-trip idempotence claim and its measurement; see *Verification*.

### IR — model and default layout

#### REQ-IR-01  The intermediate model is never persisted

**Requirement.** The model SHALL exist only in memory for the duration of a run. The tool MUST NOT
write it to disk as an interchange artefact, and MUST NOT require one to be present as input. Every
run SHALL rebuild the model from source text.

**Rationale.** Persisting semantics creates a second source of truth, which in turn forces hashes,
drift detection and three-way merges. The only durable carriers are the source and the diagram.

**Acceptance criteria.**

- **AC-IR-01.1** — **WHEN** a build run completes, **THEN** the only files it created are the ones
  the user asked for; no model or interchange file appears beside them.
- **AC-IR-01.2** — **WHEN** a source file is edited between two runs, **THEN** the second run
  reflects the edit without any migration or cache invalidation step.

**Evidence.** The layering decision and the persisted-layer table; see *Architecture*.

#### REQ-IR-02  Edges have exactly one producer

**Requirement.** All `read` and `write` edges SHALL be produced by one derivation over function
bodies. No other subsystem MAY add, remove or reclassify an edge.

**Rationale.** A single producer is what makes "the diagram cannot drift from the code" true rather
than aspirational. Two producers would need a conflict rule, and the rule would need a merge.

**Acceptance criteria.**

- **AC-IR-02.1** — **WHEN** a signal's annotation direction is changed, **THEN** the set of edges
  incident to that signal is unchanged.
- **AC-IR-02.2** — **WHEN** a statement that reads or writes a signal is deleted from a function
  body, **THEN** the corresponding edge disappears.

**Evidence.** The "annotations do not control edges" rule; see *Annotations*.

#### REQ-IR-03  Default layout is deterministic

**Requirement.** When no prior layout exists, the tool SHALL compute positions and sizes by a fixed
default. The same input SHALL produce the same geometry on every run and on every machine, with no
dependence on file-system iteration order, hash ordering or wall-clock time.

**Rationale.** Determinism is what allows geometry to be compared byte-for-byte, which in turn is
what makes a layout regression reviewable instead of invisible.

**Acceptance criteria.**

- **AC-IR-03.1** — **WHEN** the same inputs are built twice, **THEN** the produced diagram files are
  byte-identical.
- **AC-IR-03.2** — **WHEN** the inputs are copied to a different directory and built, **THEN** node
  geometry is identical.

**Evidence.** Byte-equality of the committed geometry golden; see *Conformance*.

### DRAWIO — the diagram file contract

#### REQ-DRAWIO-01  Generated files satisfy the draw.io document skeleton

**Requirement.** The tool SHALL emit a `.drawio` document containing the graph container, a default
layer and the mandatory root cells that the schema requires. Generated files SHALL validate against
the draw.io file schema distributed with the tool.

**Rationale.** A file that draw.io refuses to open is worse than no file, and schema validity is the
cheapest guard against a subtly malformed document reaching a user.

**Acceptance criteria.**

- **AC-DRAWIO-01.1** — **WHEN** a generated file is validated against the schema, **THEN** validation
  passes.
- **AC-DRAWIO-01.2** — **WHEN** a generated file is opened in draw.io, **THEN** the diagram renders
  with containers, nodes and edges.

**Evidence.** Schema-level comparison (level L4); see *Conformance*.

#### REQ-DRAWIO-02  Nodes carry their semantic payload as attributes

**Requirement.** Every node and edge SHALL be emitted in a form that carries custom attributes, and
SHALL include at least a stable identifier joining it to its model entity, plus the display label and
the entity kind. Signal direction, type, unit and the human-facing annotation values SHALL be
mirrored as attributes where present.

**Rationale.** The join key is what makes layout reusable across rebuilds. Without it, a diagram is a
picture with no way back to the thing it describes.

**Acceptance criteria.**

- **AC-DRAWIO-02.1** — **WHEN** a generated file is inspected, **THEN** every node carries an
  identifier resolvable to a model entity.
- **AC-DRAWIO-02.2** — **WHEN** an entity has an alias, unit or note in source, **THEN** those values
  appear as attributes on the corresponding element.

**Evidence.** Element mapping and the attribute table; see *The `.drawio` format*.

#### REQ-DRAWIO-03  Shape encodes direction

**Requirement.** The node shape SHALL distinguish input, output and non-directional signals, and SHALL
distinguish a function from a signal. External entities SHALL be visually distinguishable from local
ones. The direction MUST be readable from the shape alone, without a marker drawn on top of it.

**Rationale.** The most frequent question about a dataflow diagram is "which way does this go"; a
repeated marker would compete with the label, while the silhouette answers it pre-attentively.

**Acceptance criteria.**

- **AC-DRAWIO-03.1** — **WHEN** a signal is annotated as input, **THEN** its shape differs from the
  shape of a signal annotated as output.
- **AC-DRAWIO-03.2** — **WHEN** an entity is marked external, **THEN** its rendering differs from the
  local form of the same kind.

**Evidence.** The node-style table; see *The `.drawio` format*.

#### REQ-DRAWIO-04  Coordinates are parent-relative and convertible both ways

**Requirement.** Node coordinates SHALL be stored relative to the containing cell, as the format
requires. The tool MUST provide exactly one conversion to and from absolute canvas coordinates, and
the two directions MUST be exact inverses.

**Rationale.** Two conversion sites would drift a little on every round-trip, and the drift would be
attributed to the user's dragging rather than to the tool.

**Acceptance criteria.**

- **AC-DRAWIO-04.1** — **WHEN** a build is followed by a rebuild that reuses the produced layout,
  **THEN** every node's absolute position is unchanged.
- **AC-DRAWIO-04.2** — **WHEN** nesting depth differs between two diagrams that describe the same
  absolute positions, **THEN** comparison after conversion reports no difference.

**Evidence.** The coordinate-semantics section and the normalisation rules; see *The `.drawio`
format* and *Conformance*.

#### REQ-DRAWIO-05  Edges are routed around obstacles

**Requirement.** The tool SHALL route each edge by trying a fixed set of anchor combinations and
candidate orthogonal paths, discarding any candidate that intersects a node box, and selecting the
shortest surviving path. When no candidate is free of collisions, the edge MUST be emitted without
anchor attributes so that the viewer routes it, rather than emitting an anchored edge that crosses a
node.

**Rationale.** A diagram whose lines pass through unrelated boxes is unreadable, and an anchored edge
that crosses a node is worse than an unanchored one because it misrepresents which endpoints the
author chose.

**Acceptance criteria.**

- **AC-DRAWIO-05.1** — **WHEN** two entities in different containers are connected, **THEN** the
  emitted edge has no segment crossing an unrelated node's box.
- **AC-DRAWIO-05.2** — **WHEN** several edges share a vertical span, **THEN** their bends occur at
  different positions so the lines are individually traceable.

**Evidence.** Routing rules and the anchor-combination table; see *The `.drawio` format*.

#### REQ-DRAWIO-06  Both storage forms are readable

**Requirement.** The tool SHALL read both the plain and the compressed form that draw.io produces
when saving. A payload in compressed form MUST be expanded transparently, and the resulting model
SHALL be identical to the model produced from the plain form of the same diagram.

**Rationale.** draw.io compresses by default. A reader that handles only plain XML silently returns an
empty layout the first time a user saves their arrangement, which is exactly the failure that loses
work.

**Acceptance criteria.**

- **AC-DRAWIO-06.1** — **WHEN** a diagram saved by draw.io in compressed form is read, **THEN** the
  node count, edge count and readable attribute count match the plain form of the same content.
- **AC-DRAWIO-06.2** — **WHEN** a diagram is saved by draw.io and re-read, **THEN** the layout
  reflects the arrangement the user made, not the default one.

**Evidence.** The compressed-storage capability and its measured read-back figures; see *Conformance*
and *Verification*.

#### REQ-DRAWIO-07  An unreadable payload fails loudly

**Requirement.** When a diagram's payload cannot be expanded, the tool MUST fail with a diagnostic and
MUST NOT return an empty layout. An empty layout is reserved for a diagram that genuinely contains no
layout.

**Rationale.** Silently returning empty is indistinguishable from a diagram that has no layout, so
the caller would overwrite hand-made work with defaults and report success. Raising makes the
corruption visible at the point of failure.

**Acceptance criteria.**

- **AC-DRAWIO-07.1** — **WHEN** a diagram element contains text that is not a valid payload, **THEN**
  the tool reports an error and no output diagram is written.
- **AC-DRAWIO-07.2** — **WHEN** a diagram element is empty, **THEN** the tool skips it without
  treating the file as corrupt.

**Evidence.** Read-behaviour table and the rejection fixture; see *The `.drawio` format* and
*Examples*.

#### REQ-DRAWIO-08  Round-trip distinguishes automatic from human waypoints

**Requirement.** On reading a diagram produced by an earlier run, the tool SHALL recompute what its
own router would emit for the current node positions and SHALL discard waypoints equal to that
recomputation, keeping only those that differ. Consequently a build with no intervening edit MUST
produce an identical file, and a human-pulled edge SHALL keep its path across later builds.

**Rationale.** The generator writes waypoints into the same file a human edits, so it cannot rely on
a marker or a separate store. Comparison against a recomputation is the only way to give both
properties at once.

**Acceptance criteria.**

- **AC-DRAWIO-08.1** — **WHEN** a diagram is built twice with no edit, **THEN** the second file is
  byte-identical to the first.
- **AC-DRAWIO-08.2** — **WHEN** one edge's line is moved by hand and the diagram is rebuilt, **THEN**
  that edge keeps its moved path while the other edges are routed from their node positions.

**Evidence.** The round-trip table and the idempotence measurement; see *The `.drawio` format* and
*Verification*.

### ANN — the annotation system

#### REQ-ANN-01  C annotations are key/value comment blocks

**Requirement.** In C, an annotation SHALL be a run of consecutive `///` lines directly above a
declaration, carrying `key="value"` pairs after a tag. Keys SHALL be bare words, values double-quoted,
and a value MUST NOT contain a double quote. A blank line SHALL terminate the block. Unknown keys MUST
be ignored rather than rejected.

**Rationale.** Proximity plus a line-oriented syntax keeps the annotation readable as a comment and
requires no preprocessor, include file or build step.

**Acceptance criteria.**

- **AC-ANN-01.1** — **WHEN** a declaration is preceded by an annotation block with a direction key,
  **THEN** the entity carries that direction.
- **AC-ANN-01.2** — **WHEN** a blank line separates the block from the declaration, **THEN** the
  annotation does not apply.
- **AC-ANN-01.3** — **WHEN** the block contains a key the tool does not recognise, **THEN** the run
  succeeds and the key is ignored.

**Evidence.** The annotation-syntax section with its recognition constraints; see *Annotations*.

#### REQ-ANN-02  C# annotations are attributes that bind forward

**Requirement.** In C#, an annotation SHALL be an attribute applied to the declaration it documents.
The tool SHALL bind an attribute to the next field, property or method declaration, skipping blank
lines, using directives, namespace declarations, preprocessor lines and bare braces. The direction
argument MAY be omitted, in which case the entity is documented without a direction.

**Rationale.** Attributes are the language's own mechanism, so a misspelt property name fails at
compile time instead of being silently ignored — a stronger guarantee than a comment can give.

**Acceptance criteria.**

- **AC-ANN-02.1** — **WHEN** an attribute is separated from its target by blank lines or a using
  directive, **THEN** it still binds to that target.
- **AC-ANN-02.2** — **WHEN** an attribute is applied with metadata only and no direction, **THEN**
  the entity appears with an empty direction.

**Evidence.** The attribute-binding rule; see *Annotations*.

#### REQ-ANN-03  Direction is mapped verbatim, never corrected

**Requirement.** The tool SHALL map the declared direction to the model without reinterpretation.
Where the template defines the enumeration, `None` SHALL map to no direction, `In` to input, `Out` to
output and `Io` to bidirectional, and the tool MUST NOT swap them to match a different intuition.

**Rationale.** The template's comments define direction relative to the module. "Correcting" this at
read time flips every arrow in the view relative to the source diagram, and the resulting two
contradictory pictures are worse than a counter-intuitive definition.

**Acceptance criteria.**

- **AC-ANN-03.1** — **WHEN** a signal is declared with the input direction, **THEN** the model records
  input and the view renders it as an input port.
- **AC-ANN-03.2** — **WHEN** an artifact and its source are read through their respective paths,
  **THEN** a signal's direction agrees between them.

**Evidence.** The direction-mapping tables for both languages; see *Annotations* and *Artifact
format*.

#### REQ-ANN-04  No annotation influences the edge set

**Requirement.** Adding, changing or removing an annotation MUST NOT add, remove, reclassify or
redirect an edge. Only a change to a function body MAY do so.

**Rationale.** This is the observable form of "the body is the truth". Without it, a comment becomes
a way to manufacture structure, and the diagram stops being derived.

**Acceptance criteria.**

- **AC-ANN-04.1** — **WHEN** a signal is annotated from input to output, **THEN** the incident edges
  are unchanged in set, direction and count.
- **AC-ANN-04.2** — **WHEN** an annotation is deleted entirely, **THEN** the incident edges remain and
  only the label changes.

**Evidence.** The "why annotations do not control edges" section; see *Annotations*.

#### REQ-ANN-05  Unknown keys are ignored for forward compatibility

**Requirement.** A key or attribute the tool does not recognise MUST be ignored, not rejected, in
both languages. A malformed value for a recognised geometry key MUST NOT abort the run.

**Rationale.** An older reader must still consume a newer annotation, otherwise every addition to the
vocabulary would break existing toolchains. Ignoring is also what allows one source to be read by
several versions of the tool.

**Acceptance criteria.**

- **AC-ANN-05.1** — **WHEN** a source is annotated with a key introduced by a newer vocabulary,
  **THEN** the run succeeds and all recognised keys take effect.
- **AC-ANN-05.2** — **WHEN** a geometry key holds a value that cannot be interpreted as a number,
  **THEN** the run completes without aborting.

**Evidence.** The forward-compatibility statement and the geometry-key rules; see *Annotations* and
*Conformance*.

#### REQ-ANN-06  Geometry keys override the default layout per entity

**Requirement.** A signal and a function SHALL both accept keys that pin the entity's absolute
position, its initial size and a style fragment appended verbatim to the entity's rendering style. An
absent or empty value MUST leave the default untouched. Such a fragment MUST survive write-back
because the tool does not manage it.

**Rationale.** Some nodes carry meaning through position — a legend area, a stack that mirrors a
physical rack. Letting the author pin those keeps the default layout useful for everything else.

**Acceptance criteria.**

- **AC-ANN-06.1** — **WHEN** an entity carries a position key, **THEN** the generated diagram places
  it at that position instead of the default stack position.
- **AC-ANN-06.2** — **WHEN** an entity carries an empty value for a geometry key, **THEN** the output
  is byte-identical to the output without that key.
- **AC-ANN-06.3** — **WHEN** an entity carries a style fragment, **THEN** write-back preserves it.

**Evidence.** The geometry-key reference and the write-back table; see *Annotations*.

#### REQ-ANN-07  Free-text blocks are independent of their host declaration

**Requirement.** The tool SHALL support free-text blocks that carry a caption, absolute coordinates,
a size and a visual kind (borderless text, tinted box, or wide band). A block's position SHALL come
from its own coordinates and MUST NOT depend on the entity it is written above. Several blocks MAY
attach to one declaration.

**Rationale.** Annotation keys decorate entities that already exist; they cannot add a heading, a
legend, or a note stating what the diagram deliberately omits. A separate construct is needed, and
tying its position to an unrelated host would make it unusable for layout.

**Acceptance criteria.**

- **AC-ANN-07.1** — **WHEN** a text block carries coordinates, **THEN** it appears at those
  coordinates regardless of where its host entity is placed.
- **AC-ANN-07.2** — **WHEN** several blocks hang off one declaration, **THEN** all of them appear.
- **AC-ANN-07.3** — **WHEN** a block specifies an unrecognised visual kind, **THEN** it renders as
  plain text rather than being dropped.

**Evidence.** The free-text block reference; see *Annotations*.

### TPL — metadata templates

#### REQ-TPL-01  A template is a self-contained folder

**Requirement.** Each template SHALL be usable by copying files into a project, with no package
manager step, no code generator and no build-script change. The C template SHALL compile under a
conforming C compiler with its layout assertion preserved; the C# template SHALL compile with no
additional package reference.

**Rationale.** The adoption cost of the whole product is one copied file plus a few annotations. A
template that requires tooling would reintroduce the integration project this product exists to avoid.

**Acceptance criteria.**

- **AC-TPL-01.1** — **WHEN** the C# template is copied into an otherwise empty project and built,
  **THEN** the build succeeds with no additional package reference.
- **AC-TPL-01.2** — **WHEN** the C template is copied into a project and compiled, **THEN** the
  compile-time size assertion passes.

**Evidence.** The integration and verification section of the template guide; see *Templates*.

#### REQ-TPL-02  The C# attribute keeps source compatibility

**Requirement.** The C# template SHALL preserve the existing positional parameter order and meaning of
its attribute, and MAY add optional named parameters for tags, persistence and tree rooting. Source
written against an earlier version MUST continue to compile and produce the same metadata.

**Rationale.** An annotation vocabulary that breaks when extended forces every adopter to re-audit
their sources for a change that adds nothing they asked for.

**Acceptance criteria.**

- **AC-TPL-02.1** — **WHEN** pre-existing source using only the original positional parameters is
  compiled against the current template, **THEN** it compiles and produces the same direction, unit
  and alias as before.
- **AC-TPL-02.2** — **WHEN** a member is annotated with the optional tag parameter, **THEN** the tags
  are readable from the artifact.

**Evidence.** The attribute-parameter table; see *Templates*.

#### REQ-TPL-03  Tree rooting and exclusion are expressible in both languages

**Requirement.** The vocabulary SHALL let an author mark an entity as a decomposition root and let an
author hide an entity by default. Both SHALL be readable from the artifact. The C side SHALL express
the same semantics with reserved tags.

**Rationale.** A large system has more modules than fit a readable default view. Rooting and exclusion
let the author decide what the diagram shows without deleting anything from the model.

**Acceptance criteria.**

- **AC-TPL-03.1** — **WHEN** an entity is marked as a root, **THEN** the viewer's default view lists
  it and the corresponding marker is present in the model.
- **AC-TPL-03.2** — **WHEN** an entity is marked as excluded, **THEN** it is hidden by default and
  becomes visible when the exclusion switch is turned on.
- **AC-TPL-03.3** — **WHEN** the equivalent reserved tag is used in C, **THEN** the same markers
  appear in the model.

**Evidence.** The rooting and exclusion rows of the parameter table; see *Templates*.

#### REQ-TPL-04  The C record is fixed-length and pointer-free

**Requirement.** The C metadata record SHALL be a fixed-size structure of plain data with no pointer
members, and string fields SHALL be fixed-length inline arrays. A change in the record's size MUST
fail at compile time rather than silently reinterpreting existing artifacts.

**Rationale.** Inline strings are what make an unlinked object file readable without relocations and
what makes stripping harmless. A pointer would require the reader to resolve an address that no longer
means anything.

**Acceptance criteria.**

- **AC-TPL-04.1** — **WHEN** a record's field layout is altered so its size differs from the declared
  value, **THEN** compilation fails.
- **AC-TPL-04.2** — **WHEN** an unlinked object file is inspected, **THEN** the string fields are
  readable without applying relocations.

**Evidence.** The record layout and its constraint; see *Artifact format* and *Templates*.

#### REQ-TPL-05  The metadata section survives trimming and stripping

**Requirement.** The template SHALL emit its records such that they survive the linker's section
garbage collection and stripping. The template documentation SHALL describe the retention technique
and the fallback for toolchains that do not support it.

**Rationale.** Metadata that disappears under a common optimisation flag turns a working setup into an
empty view with no error, and the failure appears far from its cause.

**Acceptance criteria.**

- **AC-TPL-05.1** — **WHEN** a binary is linked with section garbage collection enabled, **THEN** all
  metadata records remain readable.
- **AC-TPL-05.2** — **WHEN** a binary is stripped of all symbols, **THEN** the record count and
  contents are unchanged.

**Evidence.** The section-retention section; see *Templates*.

#### REQ-TPL-06  The metadata carries a version the reader can judge

**Requirement.** The template SHALL write a version identifier into the artifact, and the reader SHALL
compare it against the versions it supports. An unsupported version MUST produce a diagnostic and stop
decoding rather than being interpreted with the wrong layout.

**Rationale.** The record layout will change eventually. A version stamp is what lets an old reader
say "this was written by something newer" instead of producing plausible nonsense.

**Acceptance criteria.**

- **AC-TPL-06.1** — **WHEN** an artifact produced by the template is read, **THEN** the reported
  metadata version matches the template's declared version.
- **AC-TPL-06.2** — **WHEN** an artifact declares a version the reader does not support, **THEN** an
  error diagnostic is reported and no entities are decoded from that section.

**Evidence.** The version requirement of the artifact IR and its scenarios; see *Artifact format*.

### ARTIFACT — compiled-artifact reading

#### REQ-ARTIFACT-01  The format is decided by content, not by extension

**Requirement.** The reader SHALL identify the format from the leading bytes of the file. Recognition
SHALL cover `ar` archives, PE images and ELF images. A file whose bytes match none of them MUST be
reported as an unknown format with an error diagnostic, and MUST NOT be read as any of them.

**Rationale.** A `.dll` may hold native code, an ELF may be named `.so` or `.out`, and an `ar` archive
contains members of yet another format. Trusting the extension would misparse correct inputs and, worse,
would accept wrong ones.

**Acceptance criteria.**

- **AC-ARTIFACT-01.1** — **WHEN** a file named with a PE extension contains ELF bytes, **THEN** it is
  parsed as ELF and no format error is reported.
- **AC-ARTIFACT-01.2** — **WHEN** a file with a plausible extension contains unrecognisable bytes,
  **THEN** the result reports an unknown format with an error diagnostic and no uncaught failure.

**Evidence.** The supported-input table and the dispatch scenarios; see *Artifact format*.

#### REQ-ARTIFACT-02  PE/CLI artifacts are read statically

**Requirement.** From an artifact carrying CLI metadata, the reader SHALL produce modules, types,
signals, functions and read/write edges, including positional record fields and parameter data. It
MUST NOT load the target assembly, resolve its dependencies, or execute any of its code, including
static constructors and module initialisers.

**Rationale.** Inspecting an artifact must be as safe as looking at it. Any code path that loads the
image would run initialisers, and a binary received from a supplier would then execute on the
reviewer's machine simply because it was opened.

**Acceptance criteria.**

- **AC-ARTIFACT-02.1** — **WHEN** an artifact whose annotated field is read and written by a method is
  inspected, **THEN** the signal carries its declared direction, unit and alias, and the function
  carries both a read and a write edge.
- **AC-ARTIFACT-02.2** — **WHEN** an artifact declares a static constructor or module initialiser,
  **THEN** inspecting it produces a model and causes no side effect.
- **AC-ARTIFACT-02.3** — **WHEN** a method calls into a framework or third-party assembly, **THEN** no
  function node or edge is created for that call.

**Evidence.** The PE/CLI requirements and their scenarios; see *Artifact format*.

#### REQ-ARTIFACT-03  ELF artifacts are read through the metadata section

**Requirement.** For an ELF image the reader SHALL locate the metadata section, slice it by the fixed
record size and decode the records. A record-size mismatch MUST be reported as an error rather than
read past the end of the section. An image without the section MUST yield an empty model plus a
diagnostic, not a failure.

**Rationale.** Fixed-size slicing is what allows an unlinked object file and a stripped shared library
to be read identically; a wrong size would read adjacent data as if it were metadata.

**Acceptance criteria.**

- **AC-ARTIFACT-03.1** — **WHEN** an object file built from the template is read, **THEN** every record
  is decoded with its name, tag, kind, owner, type, size and offset intact.
- **AC-ARTIFACT-03.2** — **WHEN** an ELF without the metadata section is read, **THEN** an empty model
  is returned with a "no metadata" diagnostic.
- **AC-ARTIFACT-03.3** — **WHEN** the records declare a version the reader does not support, **THEN**
  an error diagnostic is reported and decoding stops.

**Evidence.** The ELF requirements and their scenarios; see *Artifact format*.

#### REQ-ARTIFACT-04  Archives are expanded member by member

**Requirement.** For an archive the reader SHALL enumerate its members, parse each recognised member
with the rules of its own format, and represent the archive as a module whose children are the members.
Members that carry no metadata MUST be skipped without being reported as corrupt. Two members with the
same name MUST both survive with distinct identifiers.

**Rationale.** A real static library mixes instrumented objects with third-party ones. Treating an
uninstrumented member as an error would make the archive unreadable in the normal case.

**Acceptance criteria.**

- **AC-ARTIFACT-04.1** — **WHEN** an archive of several objects is read, **THEN** one archive module is
  produced whose children cover each member.
- **AC-ARTIFACT-04.2** — **WHEN** an archive contains two members with the same name, **THEN** both
  have distinct identifiers.

**Evidence.** The archive requirement and its scenarios; see *Artifact format*.

#### REQ-ARTIFACT-05  Identifiers are stable across runs and machines

**Requirement.** Every identifier in the model SHALL be reproducible: parsing the same artifact twice,
or parsing copies of it in different directories, MUST produce identical identifier sets. An
identifier MUST NOT contain an absolute path, a load address or a random value.

**Rationale.** Stable identifiers are the precondition for comparing two inspections at all — for a
regression test, for a diff of two builds, or for a viewer that remembers what the user expanded.

**Acceptance criteria.**

- **AC-ARTIFACT-05.1** — **WHEN** the same artifact is inspected twice, **THEN** the signal, function
  and type identifier sets are equal.
- **AC-ARTIFACT-05.2** — **WHEN** the same artifact is copied to another directory and inspected,
  **THEN** the identifier sets are equal.

**Evidence.** The identifier rules and their scenarios; see *Artifact format*.

#### REQ-ARTIFACT-06  Missing halves of a data chain become diagnostics

**Requirement.** When a signal is written but never read, or read without a declaration, the reader
SHALL keep the signal or create a clearly marked external placeholder and MUST report a diagnostic.
It MUST NOT silently discard the entity or the edge.

**Rationale.** A dangling write usually means a module was not instrumented. Dropping it silently
would make the artifact look complete when it is only partially described.

**Acceptance criteria.**

- **AC-ARTIFACT-06.1** — **WHEN** a signal is written and never read, **THEN** it remains in the model
  and a dangling-write diagnostic is reported.
- **AC-ARTIFACT-06.2** — **WHEN** a body reads a field declared outside the inspected set, **THEN** an
  external placeholder is created and a dangling-read diagnostic is reported.

**Evidence.** The dangling-data requirement and the diagnostic table; see *Artifact format*.

#### REQ-ARTIFACT-07  Canonical JSON is byte-stable

**Requirement.** The artifact model emitted as JSON SHALL be canonical: object keys ordered
deterministically, collection-valued arrays sorted by a semantic key, order-preserving arrays left in
their natural order, and no runtime addresses. Two runs over the same input MUST produce byte-identical
output.

**Rationale.** Byte stability is what makes the JSON usable as a diff target and as a test oracle. If
key order varied, every comparison would need a normaliser, and a normaliser is a place for real
differences to hide.

**Acceptance criteria.**

- **AC-ARTIFACT-07.1** — **WHEN** the same artifact is inspected twice to two files, **THEN** the two
  files are byte-identical.
- **AC-ARTIFACT-07.2** — **WHEN** an artifact without metadata is inspected, **THEN** the run reports
  success with an informational payload and diagnostics rather than failing.

**Evidence.** The canonical-JSON rules and their scenarios; see *Artifact format*.

#### REQ-ARTIFACT-08  Every offset is bounded

**Requirement.** The reader SHALL bounds-check every offset, length and table count it reads, and
SHALL honour a caller-supplied size limit. Any malformed input MUST be surfaced as a diagnostic or an
error, and MUST NOT cause an out-of-range read, an unbounded allocation or a non-terminating loop.

**Rationale.** The inputs are binaries from anywhere, including truncated downloads and hostile
suppliers. A parser that trusts a length field is a parser that will read adjacent memory.

**Acceptance criteria.**

- **AC-ARTIFACT-08.1** — **WHEN** an ELF truncated inside its headers is read, **THEN** a
  truncation-related diagnostic is reported and the process does not crash.
- **AC-ARTIFACT-08.2** — **WHEN** an artifact exceeds the configured size limit, **THEN** it is
  rejected with an explanatory message before the content is loaded.

**Evidence.** The input-boundary requirement and the size-limit scenarios; see *Artifact format*.

### EXT — editor integration

#### REQ-EXT-01  Artifacts open in a read-only editor

**Requirement.** The extension SHALL provide a read-only editor for compiled artifacts. The editor
MUST NOT offer any means to save, undo a change to the underlying file, or otherwise write into the
artifact.

**Rationale.** The underlying file is a build output owned by a compiler. An editor that could write
it would be an editor that corrupts a build.

**Acceptance criteria.**

- **AC-EXT-01.1** — **WHEN** an artifact is opened in the extension's editor, **THEN** the view renders
  and no save affordance for that file is offered.
- **AC-EXT-01.2** — **WHEN** an edit of the opened document is requested programmatically, **THEN** it
  is refused with a read-only outcome.

**Evidence.** The read-only editor requirement and its scenarios; see *VS Code extension*.

#### REQ-EXT-02  Non-artifacts are not captured

**Requirement.** When a file's leading bytes match none of the recognised formats, the extension MUST
NOT take over the file; it SHALL fall back to the editor the user would otherwise have had. When the
format is recognised but the structure is damaged, the extension SHALL open and display diagnostics
instead of failing or blocking.

**Rationale.** Registering a binary viewer means being offered files the viewer cannot handle. Taking
them over would leave the user with a blank tab where an image used to be.

**Acceptance criteria.**

- **AC-EXT-02.1** — **WHEN** a non-artifact binary is opened with the extension selected, **THEN** the
  extension's view does not appear and the default handling applies.
- **AC-EXT-02.2** — **WHEN** a recognised but damaged artifact is opened, **THEN** the view appears
  with a diagnostic listing, and the editor remains usable.

**Evidence.** The fallback requirement and its scenarios; see *VS Code extension*.

#### REQ-EXT-03  Three views over one model

**Requirement.** The editor SHALL present at least an overview, a module cross-link view and a
persistent-data view, switchable within one editor instance, all reading the same model. The overview
SHALL report format, architecture, entity counts, metadata version and diagnostics. The
persistent-data view SHALL present types marked as persistent as tables whose fields can be followed
into nested types.

**Rationale.** The three questions a reader has about an unfamiliar binary are what it is, how its
parts talk to each other, and what state survives. Answering only one of them leaves the reader to
open a disassembler for the others.

**Acceptance criteria.**

- **AC-EXT-03.1** — **WHEN** an artifact is opened, **THEN** the overview reports at least format,
  architecture, module count, signal count, function count and the diagnostic list.
- **AC-EXT-03.2** — **WHEN** the persistent-data view is selected, **THEN** the types marked persistent
  appear as tables with their fields, and a field whose type is defined locally can be followed into
  that type.

**Evidence.** The three-view requirement and its scenarios; see *VS Code extension*.

#### REQ-EXT-04  The cross-link view follows the documented interaction

**Requirement.** The cross-link view SHALL divide the editor into a flow canvas and a hierarchical
listing that expands on demand. The canvas SHALL show nothing until the user selects an entity in the
listing. Selecting a signal SHALL draw its flow from the writing row to the reading row. Selecting a
signal SHALL additionally mark the places that reference it, and selecting empty space SHALL clear
those marks without clearing the selection state. A filter SHALL restrict the listing to entities whose
name, alias or tags match, and SHALL expand the path to each match.

**Rationale.** Drawing everything at once produces an unreadable mesh. Driving the canvas from an
explicit selection makes the diagram answer a question the user asked rather than a question about the
whole program.

**Acceptance criteria.**

- **AC-EXT-04.1** — **WHEN** an artifact is opened and nothing is selected, **THEN** the canvas is
  empty.
- **AC-EXT-04.2** — **WHEN** a signal is selected, **THEN** a line is drawn from the row of its writer
  to the row of its reader.
- **AC-EXT-04.3** — **WHEN** a filter term is entered, **THEN** only matching entities remain and their
  paths are expanded.
- **AC-EXT-04.4** — **WHEN** the user clicks empty canvas space, **THEN** reference marks are removed
  and the selection is preserved.

**Evidence.** The cross-link requirement and its scenarios; see *VS Code extension*.

#### REQ-EXT-05  Large artifacts remain usable

**Requirement.** The listing SHALL be virtualised so that only rows near the viewport exist at once.
Model parsing SHALL run off the extension's main thread so that the interface stays responsive during
parsing. An artifact exceeding the configured size limit MUST NOT be parsed; the user SHALL be told
which limit was hit and that it can be raised.

**Rationale.** A ten-thousand-node model rendered eagerly freezes the editor, and a frozen editor is
indistinguishable from a hung product even when the parser is fine.

**Acceptance criteria.**

- **AC-EXT-05.1** — **WHEN** a model of ten thousand nodes is scrolled, **THEN** the interface remains
  interactive and the number of rendered rows stays bounded.
- **AC-EXT-05.2** — **WHEN** a large artifact is opened, **THEN** the interface responds before
  parsing completes.
- **AC-EXT-05.3** — **WHEN** an artifact exceeds the configured limit, **THEN** no parse is attempted
  and a message names the limit.

**Evidence.** The large-data requirement and its scenarios; see *VS Code extension*.

#### REQ-EXT-06  The webview content is locked down

**Requirement.** The view content SHALL run under a restrictive content security policy that allows
only local script and style sources, and MUST NOT load remote resources, evaluate dynamic code, or
insert unsanitised markup. A symbol name originating in the inspected artifact MUST be displayed as
text.

**Rationale.** Symbol names come from a binary the user may not have built. A name is data, and data
that reaches the document as markup is a scripting hole reachable by naming a field.

**Acceptance criteria.**

- **AC-EXT-06.1** — **WHEN** any view is opened, **THEN** no cross-origin request is issued.
- **AC-EXT-06.2** — **WHEN** an artifact contains a symbol whose name looks like markup, **THEN** it is
  displayed literally and no script runs.

**Evidence.** The webview-security requirement and its scenarios; see *VS Code extension*.

#### REQ-EXT-07  The artifact view is strictly read-only

**Requirement.** The extension MUST NOT modify the artifact, MUST NOT generate source or diagram files
from it, and MUST NOT run it or any external command against it. The only allowed deviation is invoking
the bundled helper whose sole purpose is to read the artifact's bytes.

**Rationale.** The artifact path is an observation path. Any product that turns observation into
generation needs a fidelity argument it does not have.

**Acceptance criteria.**

- **AC-EXT-07.1** — **WHEN** an artifact is opened, its views switched, filtered and refreshed,
  **THEN** the artifact's modification time and content hash are unchanged.
- **AC-EXT-07.2** — **WHEN** an executable artifact is opened, **THEN** it is not started.

**Evidence.** The read-only requirement and its scenarios; see *VS Code extension*.

#### REQ-EXT-08  Artifacts can be organised into a persistent tree

**Requirement.** The extension SHALL provide a workspace-scoped tree in which the user can create
several roots, nest groups, attach artifacts at any level, and give an artifact a display alias. The
tree SHALL persist per workspace without writing into the repository. Selecting an artifact in the
tree SHALL open it in the editor. A path that no longer resolves MUST be reported in the tree and MUST
NOT be removed automatically.

**Rationale.** A real delivery arrives as dozens of related binaries. Reopening each one by path does
not scale, and silently pruning a missing entry would destroy the user's organisation on a temporary
network problem.

**Acceptance criteria.**

- **AC-EXT-08.1** — **WHEN** trees, groups and artifacts are created and the window is reloaded,
  **THEN** the organisation is preserved.
- **AC-EXT-08.2** — **WHEN** an artifact node is selected, **THEN** that artifact opens in the
  extension's editor.
- **AC-EXT-08.3** — **WHEN** an artifact's file no longer exists, **THEN** the node reports the problem
  and remains in the tree.

**Evidence.** The artifact-tree requirement; see *VS Code extension*.

#### REQ-EXT-09  Cross-links can be exported

**Requirement.** The extension SHALL export the selected cross-links as a `.drawio` file, as a Mermaid
document and as a Markdown document. An export with only one end selected SHALL either complete the
other end automatically or, when the user allows dangling flows, represent the missing end explicitly
in a form each target format can express.

**Rationale.** The reading is done inside the editor, but the audience is often elsewhere — a design
review, a document, another team's tool. An export is the only way the observation leaves the editor.

**Acceptance criteria.**

- **AC-EXT-09.1** — **WHEN** cross-links are exported to a diagram file, **THEN** the file opens in a
  diagram editor with one shape per selected module side and one edge per selected flow.
- **AC-EXT-09.2** — **WHEN** dangling flows are not allowed and only one end is selected, **THEN** the
  opposite end is included in the export.
- **AC-EXT-09.3** — **WHEN** dangling flows are allowed, **THEN** the export contains only the selected
  side and marks the missing end in a way the chosen format supports.

**Evidence.** The selection-and-export section; see *VS Code extension*.

#### REQ-EXT-10  Grouping is configurable and survives reopening

**Requirement.** The extension SHALL let the user group the listing by one or more entity attributes,
produce one bucket per attribute value at each level, name a grouping, and mark a grouping as the
default. Groupings SHALL persist beside the artifact. When a configured attribute no longer exists in
the artifact, or the stored configuration cannot be read, the view SHALL degrade with a notice and
MUST remain usable.

**Rationale.** The useful grouping depends on how the author tagged the system — by area, by bus, by
device. That is knowledge the tool cannot infer, and it must survive the next launch to be worth
entering.

**Acceptance criteria.**

- **AC-EXT-10.1** — **WHEN** a grouping is configured and the artifact is reopened, **THEN** the
  grouping and its name are restored.
- **AC-EXT-10.2** — **WHEN** a configured attribute is absent from the artifact, **THEN** a notice is
  shown and the remaining listing renders.
- **AC-EXT-10.3** — **WHEN** the stored configuration is unreadable, **THEN** a notice is shown and the
  default listing renders.

**Evidence.** The grouping and configuration section; see *VS Code extension*.

### PLATFORM — portability and runtime dependencies

#### REQ-PLATFORM-01  The command-line toolchain has no third-party runtime dependencies

**Requirement.** The tool SHALL run on Node.js using only the standard library: installing the tool
MUST NOT require downloading a third-party runtime dependency for the source-to-diagram path. The one
documented exception is reading artifacts whose metadata requires an external helper, and that
dependency SHALL be reported as a diagnostic rather than a crash when absent.

**Rationale.** An offline build machine or an air-gapped review workstation cannot fetch a package
tree. A tool whose only dependency is the platform runtime runs where the code is built.

**Acceptance criteria.**

- **AC-PLATFORM-01.1** — **WHEN** the tool is invoked in a directory with no installed packages,
  **THEN** source-to-diagram operations succeed.
- **AC-PLATFORM-01.2** — **WHEN** the external helper required for one artifact class is missing,
  **THEN** a diagnostic names the missing runtime and the process does not crash.

**Evidence.** The dependency statement and the diagnostic table; see *Implementation* and *Artifact
format*.

#### REQ-PLATFORM-02  One extension package serves Windows and Linux

**Requirement.** The extension package SHALL be platform-neutral: the same file MUST be installable on
Windows and on Linux, and MUST NOT embed a platform-specific runtime. When a required runtime is absent
on the target machine, the extension SHALL display an actionable installation prompt rather than an
empty view or an indefinite progress state.

**Rationale.** Shipping per-platform packages multiplies the release matrix for a product whose users
are often on the opposite platform from the publisher.

**Acceptance criteria.**

- **AC-PLATFORM-02.1** — **WHEN** the same package is installed on Windows and on Linux, **THEN** both
  installations open artifacts successfully.
- **AC-PLATFORM-02.2** — **WHEN** the runtime needed for one artifact class is not installed,
  **THEN** the editor shows a prompt naming the runtime and offering an installation path.

**Evidence.** The prerequisites and missing-runtime sections; see *VS Code extension* and *Artifact
format*.

#### REQ-PLATFORM-03  One version identifies the whole product

**Requirement.** All package manifests in the product SHALL carry the same version at all times, and a
check SHALL fail when they do not. A version change SHALL be applied to every carrier in one step, and
the produced package filename SHALL follow that version.

**Rationale.** The library and the extension ship together in one package. A partial bump produces a
package whose manifest, lockfile and filename disagree, and the disagreement is invisible until a user
reports the wrong version installed.

**Acceptance criteria.**

- **AC-PLATFORM-03.1** — **WHEN** the version carriers are compared, **THEN** they all report the same
  version.
- **AC-PLATFORM-03.2** — **WHEN** one carrier is edited to a different version, **THEN** the check
  fails and names the disagreement.

**Evidence.** The version-carrier table; see *Versioning*.

### VERIFY — verification and contract regression

#### REQ-VERIFY-01  Four comparison levels separate parse, structure, geometry and schema

**Requirement.** The conformance suite SHALL compare, as separate levels, the parsed model, the graph
structure, the geometry and the schema validity of the produced diagram. A failure SHALL name the level
that failed.

**Rationale.** "Output differs" is not a bug report. Separating the levels is what tells a reviewer
whether a diff is a parser regression or a router change — the two have entirely different blast radii.

**Acceptance criteria.**

- **AC-VERIFY-01.1** — **WHEN** a parser defect is introduced, **THEN** the model-level comparison
  fails and the failing level is reported.
- **AC-VERIFY-01.2** — **WHEN** a routing defect is introduced, **THEN** the geometry-level comparison
  fails while the model-level comparison passes.

**Evidence.** The comparison-level table; see *Conformance*.

#### REQ-VERIFY-02  Every published number is measured

**Requirement.** Any figure published in the product's documentation SHALL come from a command that was
actually run, and SHALL name what was measured. A figure that has not been measured MUST be labelled as
not measured rather than estimated.

**Rationale.** A test count or a performance number that nobody ran is a claim about a state that may
never have existed, and it is the first thing a reader relies on when deciding whether to trust the
rest.

**Acceptance criteria.**

- **AC-VERIFY-02.1** — **WHEN** a figure is published, **THEN** the document states how it was measured.
- **AC-VERIFY-02.2** — **WHEN** a measurement is not available, **THEN** the document says so and
  points to the limitations rather than supplying a number.

**Evidence.** The measurement claims and their commands; see *Verification*.

#### REQ-VERIFY-03  A skipped conformance case is treated as a failure

**Requirement.** The conformance runner SHALL fail when a golden case is missing rather than skipping
it. A case that depends on material outside the repository MAY be skipped, but the skip MUST print its
reason.

**Rationale.** A skipped test makes unverified behaviour look verified, which is strictly worse than a
failing test, because nobody investigates it.

**Acceptance criteria.**

- **AC-VERIFY-03.1** — **WHEN** a golden case file is absent, **THEN** the run fails and names the case.
- **AC-VERIFY-03.2** — **WHEN** a case is skipped for a stated external reason, **THEN** the reason is
  printed with the skip.

**Evidence.** The runner requirement; see *Conformance* and *Verification*.

#### REQ-VERIFY-04  The schema validator must be able to reject

**Requirement.** The schema validation used by the conformance suite SHALL be demonstrated to reject
malformed documents, not merely to accept well-formed ones. The suite SHALL include deliberately broken
inputs and SHALL assert that each is rejected.

**Rationale.** A validator that passes everything is indistinguishable from no validator, and it would
convert the schema level into reassurance rather than a check.

**Acceptance criteria.**

- **AC-VERIFY-04.1** — **WHEN** a document violating a fixed value, an undeclared attribute, an
  out-of-range enumeration or a malformed numeric literal is validated, **THEN** validation fails.

**Evidence.** The mutation set and its recorded verdicts; see *Conformance*.

## 4. Cross-cutting constraints

**Performance and scale.**

- **CC-PERF-1** — Default layout SHALL be quadratic in node count in the worst case, and this cost SHALL
  be published as a characteristic rather than presented as an optimisation opportunity.
- **CC-PERF-2** — Parsing SHALL be linear in input size.
- **CC-PERF-3** — A large model SHALL be delivered to the editor in slices on demand rather than in one
  payload, so that opening a large artifact does not serialise the whole model into the view.

**Boundary and malformed input.**

- **CC-BOUND-1** — Every parsed length, offset and count SHALL be validated against the actual input
  size before use.
- **CC-BOUND-2** — A malformed input SHALL produce a diagnostic or an error; it MUST NOT produce a
  plausible-looking partial result that is indistinguishable from a complete one.
- **CC-BOUND-3** — A corrupt diagram payload MUST fail loudly, because an empty layout is
  indistinguishable from a diagram that has none.

**Safety and read-only operation.**

- **CC-SAFE-1** — No inspected artifact SHALL be loaded, executed, or made to resolve a dependency.
- **CC-SAFE-2** — No artifact SHALL be modified by any operation, and no source or diagram SHALL be
  generated from one.
- **CC-SAFE-3** — Content originating in an inspected artifact SHALL be treated as data, never as
  markup or code.

**Determinism and reproducibility.**

- **CC-DET-1** — Identical inputs SHALL produce byte-identical outputs, with no dependence on iteration
  order, address, locale or clock.
- **CC-DET-2** — A committed expected output SHALL change only as a deliberate act accompanied by a
  behavioural change; a golden that changes on its own is a defect.

**Portability.**

- **CC-PORT-1** — The source-to-diagram path SHALL run with no third-party runtime dependency.
- **CC-PORT-2** — One extension package SHALL serve all supported platforms.
- **CC-PORT-3** — An absent runtime SHALL produce an actionable diagnostic naming a remedy, never a
  silent empty state.

**Observability.**

- **CC-OBS-1** — A failure SHALL name what failed: the comparison level for a golden diff, the
  diagnostic code for an unreadable artifact, the offending file and reason for an unsupported input.
- **CC-OBS-2** — A diagnostic SHALL be part of the result, not a side effect on a log, so that a
  consumer can present it.

## 5. Verification map

| Domain | Requirement range | Primary evidence type | Measured figures recorded in |
| :--- | :--- | :--- | :--- |
| SRC | REQ-SRC-01 … REQ-SRC-05 | Model-level golden comparison, parse assertions | *Conformance*, *Verification* |
| SYNC | REQ-SYNC-01 … REQ-SYNC-04 | Round-trip idempotence, byte-comparison of untouched sources | *Verification*, *Annotations* |
| IR | REQ-IR-01 … REQ-IR-03 | Byte-equality of repeated runs, persisted-file inventory | *Architecture*, *Conformance* |
| DRAWIO | REQ-DRAWIO-01 … REQ-DRAWIO-08 | Geometry golden, schema validation, compressed-form read-back, rejection fixture | *Conformance*, *Verification*, *The `.drawio` format* |
| ANN | REQ-ANN-01 … REQ-ANN-07 | Parse assertions per key, write-back survival | *Annotations*, *Conformance* |
| TPL | REQ-TPL-01 … REQ-TPL-06 | Compile-and-read of the bundled examples, option-matrix runs | *Templates*, *Artifact format* |
| ARTIFACT | REQ-ARTIFACT-01 … REQ-ARTIFACT-08 | Artifact test suite, synthesized fixtures, canonical-JSON byte comparison | *Artifact format*, *Verification* |
| EXT | REQ-EXT-01 … REQ-EXT-10 | Extension logic tests, installed-extension verification, headless view checks | *VS Code extension*, *Verification* |
| PLATFORM | REQ-PLATFORM-01 … REQ-PLATFORM-03 | Dependency inventory, version check, cross-platform install | *Implementation*, *Versioning* |
| VERIFY | REQ-VERIFY-01 … REQ-VERIFY-04 | Mutation of the validator, runner behaviour under a missing case | *Conformance* |

## 6. Deferred and excluded

These are real limitations. They are listed here so that a reader does not mistake an aspiration for a
promise. Each entry names the floor beneath it: what would have to be true to move the entry into §3.

| Item | Current state | Why it is not promised | What would have to exist first |
| :--- | :--- | :--- | :--- |
| Layout cost | Quadratic in node count; large projects are slow | No spatial index exists, and introducing one changes only speed — which is allowed — but the cost curve is measured, not avoided | A spatial index whose output is identical, plus a measurement showing the curve improved |
| Line jumps in the offline renderer | Generated files request them; the bundled renderer cannot draw them | The jump style is a viewer extension absent from the open-source core the renderer uses | A renderer that implements the extension, or a documented alternative marker |
| Swimlane title placement in the offline renderer | Centred rather than top-left | A renderer limitation, not a generator behaviour | Renderer parity with the desktop client |
| Text measurement in the offline renderer | Approximate for non-Latin glyphs | The renderer has no layout engine and reports zero glyph widths | A layout engine, or a font-metric table |
| SVG preview edge routing | Edges drawn centre-to-centre, so they cross shapes the diagram routes around | Sharing the router requires exposing edge geometry as a function both paths call | A refactor that makes the router reusable without changing its output |
| Function body write-back | Never performed | Deliberate: a diagram cannot represent logic, so reconstructing it would be guessing | Nothing — this is a design constraint, not a gap |
| Cross-language symbol resolution | Not attempted | Inputs carry no shared type system | A whole-program model spanning both languages |
| Multi-page diagrams, layers, tag filtering in the command line | Not wired | The command-line surface models one diagram per output | A page and layer model in the intermediate representation |
| State machines, sequence diagrams, timing diagrams | Not supported | The model has no notion of state or ordering | A semantics layer above read/write flow |
| Geometry stability | Frozen to the committed expected outputs | Any geometric change invalidates every recorded layout and hand-made arrangement | A migration path that moves existing layouts, not just the algorithm |
| Native PE and non-CLI images | Header-level treatment only, with a diagnostic | The metadata vocabulary is defined for CLI metadata and for the C template | A native-code metadata convention |
| `.exe`, `.dylib`, `.pdb` inputs | Not supported | Outside the inspected format matrix | Format support plus a metadata convention for each |
| Metadata under trimming or single-file publishing | Silently removed by the toolchain | The .NET trimmer and single-file bundler discard unreferenced metadata | Metadata retention guarantees from those tools |
| Metadata under link-time optimisation | Not supported | LTO reorders and merges sections | A retention mechanism compatible with LTO |
| MSVC targets | Not supported | Section and boundary-symbol semantics differ from the ELF toolchain | An equivalent record-placement and retention mechanism |
| Very long annotation values | Rejected at compile time | The C record uses fixed-length inline strings | A length-prefixed or side-table representation |
| Assay of an untagged third-party binary | Format and symbol summary at best | Without the declaration layer there is no direction or persistence information | An inference mechanism that does not manufacture false edges |

## 7. Change protocol

Every change to a requirement, to a behaviour a requirement names, or to a document that carries a
measured figure has a defined follow-up. The table is the contract; a change that skips its row is
incomplete regardless of whether the tests pass.

| If you change… | You must also update… | Because… |
| :--- | :--- | :--- |
| Any user-visible behaviour | The matching REQ and AC here, in both language versions | This document is the authority; a behaviour changed without a requirement change is either an undocumented promise or an accidental one |
| Source ingestion, annotation semantics, or edge derivation | The architecture document, the annotation reference, the `.drawio` format document, and the model-level expected outputs | The parser, the vocabulary and the geometry are one contract; changing one without the others produces a green suite and a lying document |
| Default layout, routing, or any emitted geometry | The `.drawio` format document and the geometry expected outputs | Recorded layouts and hand-made arrangements are pinned to that geometry; a silent change breaks every user's diagram |
| The diagram's read behaviour, including the compressed form | The `.drawio` format document and the rejection fixtures | Losing layout is the worst failure this product has, and it has no alarm unless the fixture covers it |
| Any artifact-reading decision or emitted field | The artifact format document and the artifact test expectations | The JSON is a public contract consumed by the editor and by users' own tooling |
| Any annotation key or its semantics | The annotation reference and the template documentation, in both language versions | A key is defined once and read by two consumers; a divergence between them is a silent data loss |
| Any test or measured figure | The verification document | A figure that is not restated where it is published becomes a stale claim the next reader trusts |
| Any document | The corresponding document in the other language version | A behaviour documented in one language only is a defect, not a translation lag |
| The topic table in the project overview or the documentation index | Both of those tables, and this document's status section if the authority changes | The index is how a reader finds the contract; an index that omits it hides it |
