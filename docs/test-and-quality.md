# Test and quality constraints

**English** | [中文](test-and-quality.zh-CN.md)

> How this repository decides that a change is good enough: the objectives that are not negotiable,
> what each test level can and cannot see, what counts as evidence, when a change may merge, how
> numbers are recorded, and where the residual risk sits.

## Status of this document

This file is the quality half of the contract. [`requirements.md`](requirements.md) states what must
be true; this file states how that truth is proven, what counts as passing, and which kinds of
evidence are rejected. A behaviour that is green here but contradicts `requirements.md` is still a
defect — the requirement wins.

## 1. Scope and division of labour

Four documents, one fact each. Duplicating a fact across them is how documents start disagreeing.

| Document | Answers |
| :--- | :--- |
| [`requirements.md`](requirements.md) | What the product must do, and what is explicitly not promised |
| [`conformance.md`](conformance.md) | What is compared, at which level, and with what tolerance |
| [`verification.md`](verification.md) | Which numbers were measured, and by which command |
| **this file** | How the work is proven, when it may merge, and how evidence is recorded |

Rules of thumb: comparison rules belong in `conformance.md`; the arithmetic belongs in
`verification.md`; the gate and the judgement belong here. When the numbers below change, update the
two documents in the same change.

## 2. Quality objectives and hard constraints

These are objectives, not aspirations. Each one has a place where it is enforced, and the
enforcement column names that place rather than restating the rule.

| # | Objective | Enforced by |
| :--- | :--- | :--- |
| **QO-1** | Determinism: the same input produces byte-identical output on every run and every machine | Canonical JSON output, golden comparison at L1 with exact bytes, and the id-stability tests |
| **QO-2** | No silent degradation: an input that cannot be handled produces a diagnostic or an error, never an empty result | The reader's diagnostics contract, and the explicit rejection tests for unreadable layouts and malformed documents |
| **QO-3** | Read-only safety: inspecting an artifact never modifies it and never executes it | The read-only assertions in the artifact tests |
| **QO-4** | No third-party runtime dependency in the core | The dependency table in `implementations.md`, checked by a clean install |
| **QO-5** | Reproducible verification: every published number can be recomputed from a documented command | The records discipline in §9 |
| **QO-6** | Honest coverage: what is not verified is written down as unverified | The residual-issue list in §10, and the "behaviours the goldens cannot see" list in `conformance.md` |

A change that trades any of these for convenience is rejected regardless of how green the suite is.

## 3. Test levels and what each one can see

The levels are listed from cheapest to most expensive. A level is only useful if its blind spot is
known, so the last column matters as much as the second.

| Level | Exercises | Can prove | Cannot see |
| :--- | :--- | :--- | :--- |
| **T1 — Core unit** | The core library through plain assertions, no editor involved | Parse rules, model derivation, routing decisions, canonical output | Anything about the extension host, the webview, or a real draw.io client |
| **T2 — Extension unit** | The extension's own logic in isolation | Tree and model operations, alias handling, path and URI handling | Rendering, `vscode` API behaviour, webview messaging |
| **T3 — Golden contract** | Committed cases compared at L1–L4 (see `conformance.md`) | The parser contract, the container contract, the geometry contract, schema validity | Behaviours listed under "the goldens cannot see"; anything not present in the two golden cases |
| **T4 — CLI behaviour** | The command line end to end | Flag behaviour, exit codes, file placement, idempotence of build→sync→build | Interactive or visual behaviour |
| **T5 — Mutation and rejection** | Deliberately broken inputs (schema mutations, unreadable payloads, container records in a corrupt archive) | That the validators reject rather than wave through | Whether a *valid* input is handled correctly |
| **T6 — CI** | A clean checkout on one runner | That the gate is reproducible from scratch | Platform-specific behaviour on runners that are not used |

The highest level that exists today is **T6 on a single runner**. There is no automated level that
looks at a real draw.io window, and no level that runs on Windows or macOS. Both absences are
recorded in §11 rather than glossed over.

## 4. What counts as evidence

Evidence is evidence only if a failure mode would turn it red. The following are accepted and
rejected on that basis:

| Accepted | Why |
| :--- | :--- |
| An assertion on the value produced after an operation | It fails when the behaviour is wrong |
| A byte comparison against a committed case | It fails on any drift, including "looks the same" drift |
| A command whose exact output line is quoted in a record | Someone else can rerun it and get the same line |
| A rejection test for a malformed input | It fails if the validator starts accepting |

| Rejected | Why |
| :--- | :--- |
| "The rule exists" / "the file was written" assertions | They stay green while the behaviour is broken |
| A skipped case counted as passing | A skipped conformance case makes unverified behaviour look verified |
| A screenshot standing in for an assertion | Not repeatable, and not diffable |
| "The command exited 0" without the counted line | Exit codes do not carry the number that matters |
| A number copied from an earlier document | It is a memory, not a measurement |

The skip rule deserves its own line: **five tests are skipped by design and that is not a pass**.
They are skipped because they need something outside the repository (a sample artifact, or a
compiled template example). Their reason is printed. A future change that turns a golden comparison
into a skip is a regression, not a convenience.

## 5. Sufficiency

The suite is sufficient when all of the following hold:

1. Every requirement in `requirements.md` is covered by at least one level in §3, and the coverage is
   named in the traceability table in §7.
2. Every capability in the "required capabilities" table of `conformance.md` is exercised. A
   regression there is a failure even when no golden case would notice.
3. Every behaviour listed under "behaviours the goldens cannot see" has its own test at T1 or T2, or
   is registered in §10 as unverified. There is no third state.
4. Every validator has a mutation set proving it rejects. A validator with only positive cases is
   treated as absent.
5. The counted number of executed tests equals the number the runner reports as designed tests minus
   the explicitly skipped ones. No silent subtraction.

Coverage percentage is deliberately not a sufficiency criterion. Line coverage cannot distinguish a
test that asserts the result from a test that merely executes the line, and this repository has been
bitten by exactly that distinction.

## 6. Environment

| Item | Requirement | Notes |
| :--- | :--- | :--- |
| OS for the gate | Ubuntu, on the CI runner | The library and CLI are cross-platform; the gate runs on one runner only |
| Node.js for the gate | **22.18**, pinned in CI | The declared floor in every `package.json` is `>=22.18`; the CLI depends on default type stripping |
| Node.js on the development machine | Not pinned | Measured at **v24.16.0** when the numbers in §9 were taken |
| .NET runtime | **10** or newer, PE/CLI artifacts only | Needed by the bundled sidecar; not needed for ELF, ar, or the source pipeline |
| CI structure | Three jobs: `quality` runs the version check and both type checks, `core` runs the core tests, `extension` installs, builds and runs the extension tests | The jobs are independent so one failure does not mask another |

The environment is also a limit: the gate never runs on Windows or macOS. Path handling, file
permissions and line endings therefore have no automated cross-platform evidence. This is recorded
as a risk, not as a claim.

## 7. Traceability

Every domain maps to a requirement group, a set of test levels, and one place where the evidence is
written down. Requirement identifiers live in `requirements.md`; the domain names below are the same
ones used there, so the mapping is by name rather than by copying numbers into a second document.

| Domain | Requirement group | Levels | Evidence recorded in |
| :--- | :--- | :--- | :--- |
| Source → diagram | `SRC` | T1, T3, T5 | `conformance.md`, §9 of this file |
| Diagram → source | `SYNC` | T1, T4 | `conformance.md`, §9 of this file |
| Intermediate representation and layout | `IR` | T1, T2, T3, T5 | `conformance.md`, §9 of this file |
| `.drawio` format contract | `DRAWIO` | T1, T3, T5 | `conformance.md`, §9 of this file |
| Annotation semantics | `ANN` | T1, T3, T5 | `conformance.md`, §9 of this file |
| Metadata templates | `TPL` | T1, T5 | `verification.md`, §9 of this file |
| Artifact reading | `ARTIFACT` | T1, T4, T5 | `artifact-format.md`, §9 of this file |
| VS Code extension | `EXT` | T2, T4 | §9 of this file |
| Platform and runtime dependency | `PLATFORM` | T6 | §6 and §11 of this file |
| Verification itself | `VERIFY` | all levels | this file, §4 and §5 |

Reverse traceability is the same table read upwards: a test that cannot name the domain it protects
is a test that does not belong in the suite.

## 8. Entry and exit criteria

**Entry.** The gate may be started only when dependencies are installed and generated outputs are
current. A stale build is not a test result: the extension tests run against built output, so a
forgotten rebuild silently tests yesterday's code.

**Exit.** Every step runs, in this order, with no short-circuit:

| Step | Command | Passes when |
| :--- | :--- | :--- |
| 1 | `npm run version:check` | One version number is reported in every place that carries it |
| 2 | `npm run typecheck` | Both packages report no error |
| 3 | `npm test` | Zero failures across both packages, and the counted totals match §9 |

The order is not cosmetic. The version check is first because a mismatch invalidates every later
number — the artifact tested would not be the artifact released. Type checking comes before testing
so that a type error is never reported as a test failure.

**No conditional passing.** A gate that fails is reported as failed, with the failing step and the
counted line. There is no "flaky, rerun until green" step, and a known-flaky test is a defect in §10
rather than a retry rule.

## 9. Records

Recording rules:

1. A number in any document must be reproducible from a documented command on a documented
   environment. If either is missing, the number is deleted rather than qualified.
2. A record carries the date, the runtime version and the counted output line, because a bare number
   cannot be rechecked.
3. When a number changes, the document that owns it changes in the same commit. A stale number is
   treated as a defect of the same severity as a failing test.

Recorded **2026-11-06** on Node **v24.16.0**, repository version **0.4.0**:

| Measurement | Command | Result |
| :--- | :--- | :--- |
| Version consistency | `npm run version:check` | `0.4.0 in 9 places` |
| Type safety | `npm run typecheck` | No error in either package |
| Core tests | `npm run test:core` | **229 tests: 224 passed, 5 skipped, 0 failed** (14 test files) |
| Extension tests | `npm run test:extension` | **93 tests: 93 passed, 0 skipped, 0 failed** (3 test files) |
| Golden cases | Not a command — the committed cases themselves | **2 cases** (`small-c`, `small-cs`), pinned at L1–L3 plus byte equality for `small-c` |
| VSIX contents | `npm run package` | **49 files, 802,641 bytes** (`drawcode-artifact-viewer-0.4.0.vsix`) |

**A discrepancy this record originally found, now resolved.** `verification.md` and
`implementations.md` carried **211 core tests / 79 extension tests**, measured before the artifact
reader and its tests were added. Both were brought to the counts above in the same change that added
this file.

Five core tests are skipped. Their reasons are printed at run time: they depend on artifacts or
generated files that the repository does not commit. They are not failures and they are not passes.

## 10. Defects and residual issues

Severity is assigned by consequence, not by inconvenience:

| Severity | Definition | Example of the class |
| :--- | :--- | :--- |
| **Critical** | Silent wrong output, or a promise in `requirements.md` broken without any signal | A layout reader returning an empty result for a compressed document |
| **Serious** | Output is wrong but observable, or a gate step does not enforce what it claims | A passing test that asserts only that a file was written |
| **General** | Behaviour is correct, but the record, the document or the diagnosis is wrong or missing | A stale number in a document |

Open residual issues carried into this record:

| # | Issue | Severity | Status |
| :--- | :--- | :--- | :--- |
| R-1 | `verification.md` and `implementations.md` carried outdated test counts (211 / 79) | General | Closed — brought to the numbers in §9 in the same change |
| R-2 | No automated level exercises a real draw.io client, so `jumpStyle` line jumps and container-title placement have no automated evidence | Serious | Accepted — documented in the known limitations |
| R-3 | The SVG preview does not share the `.drawio` edge router, so SVG edge geometry must not be asserted | Serious | Accepted — stated as a divergence, not a bug to be silently fixed |
| R-4 | The gate runs on one runner only; Windows and macOS behaviour is unverified by CI | Serious | Accepted — recorded as a risk in §11 |
| R-5 | Three behaviours of the artifact reader (truncated inputs, version mismatch, missing metadata) are covered by synthesized fixtures rather than real-world artifacts | General | Accepted |
| R-6 | The end-to-end suite cannot run without a built `app.o`, so no automated level exercises a real extension host | Serious | Accepted — it needs a C toolchain the gate does not have |

Items R-2 through R-4 also appear in the known limitations of the repository README. The two lists
must not contradict each other; when they do, the stricter statement wins until one is corrected.

## 11. Risks

| Risk | Impact | Current mitigation | Not mitigated |
| :--- | :--- | :--- | :--- |
| A golden changes during an unrelated refactor | Hand-made layouts stop matching, and reviewers approve the diff as noise | Golden diffs are reviewed as behaviour changes; a golden that moves without a behaviour change is treated as a bug | Nothing structural — the review is manual |
| A behaviour exists only where a golden happens to look | Regressions elsewhere stay green | The explicit list of behaviours the goldens cannot see, each with its own test | A new behaviour added without a test is invisible until someone writes one |
| Platform differences (paths, permissions, line endings) | Windows or macOS users hit failures the gate cannot see | Cross-platform code paths, no absolute paths in output | No CI coverage on those platforms |
| The sidecar's external runtime is missing | PE/CLI artifacts cannot be read at all | An actionable install prompt rather than a silent failure | The runtime cannot be bundled, so this is permanent |
| Geometry is frozen by contract | Any layout improvement breaks every golden | The rule that a faster algorithm may change *how fast*, never *what* | Deliberate; relaxing it would unpin hand-made layouts |
| Numbers drift away from reality | Readers trust outdated figures | This section's recording rules | Depends on the change discipline being followed; R-1 shows it can slip |

## 12. Change protocol

| If you change… | You must also update… | Because… |
| :--- | :--- | :--- |
| Any behaviour covered by a requirement | The matching entry in `requirements.md` | The requirement is the authority; this file only proves it |
| Any test, any gate step, any command | §3, §8 and §9 of this file | The gate is a contract, and a contract that drifts is not one |
| Any measured number | §9 of this file **and** `verification.md` | Two places hold numbers; they must move together |
| A comparison rule or a tolerance | `conformance.md` | Comparison semantics are defined there, not here |
| What is verified and what is not | §10 of this file, `docs/limitations.md`, README known limitations | Three lists describe the same residual risk |
| An artifact fixture or a golden case | §9 of this file and the comparison notes in `conformance.md` | The case inventory is part of the record |
| Any document in this repository | The Chinese version of it, in the same change | A single-language document is a defect |

## Appendix — Referenced structure and what was dropped

The section skeleton of this document is adapted from a GJB quality-record package (STP / STD / STR,
type testing, metrology calibration, electrical safety, and a 9001C design-record set). The sections
below were dropped as a whole, because they describe hardware deliverables that have no observable
object for a VS Code extension:

| Dropped section | Why it does not apply |
| :--- | :--- |
| Hardware environment (temperature, humidity, power, rack) | The deliverable is a VSIX; the runtime is the user's own VS Code installation |
| Type testing, environmental stress screening, EMC emission and susceptibility | No physical entity, and no electromagnetic emission |
| Metrology calibration, traceability chain, measurement uncertainty | No measuring instrument; accuracy is guaranteed by assertions, not by instruments |
| Electrical safety, earthing, insulation withstand | Same reason |
| Design review, verification, validation and change records (9001C 8.3) | Single-maintainer repository with no independent reviewer; that role is carried by the gate in §8 and the change protocol in §12 |
| Schedule and staffing (STP §5.2 / 5.3) | No schedule and no role allocation exist to record |

The sections that were kept and rewritten for a software context are: scope, test levels and types,
test environment, test-item inventory (§7 traceability), entry and exit criteria, requirement
traceability, test records, defect and failure handling, and risk.

This note exists so that a deliberate omission is not mistaken for a missing chapter.
