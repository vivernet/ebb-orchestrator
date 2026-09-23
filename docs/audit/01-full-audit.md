---
id: audit-01
status: completed
kind: audit
title: Full Project Audit, Repair, Verification and Commit Plan
date: 2026-09-23
---


# Ebb Orchestrator — Full Project Audit, Repair, Verification and Commit Plan

> **Target executor:** GPT-5.4-nano or another weak/low-cost coding model.
>
> **Execution style:** deterministic, checklist-driven, mandatory subagents.
>
> **Current project state:** stages 1–8 are already complete. Do not restart or reimplement them.
>
> **Goal:** audit the entire current Ebb Orchestrator checkout, verify architecture and behavior, fix every confirmed defect, run all available tests and startup checks until green, write a durable project-state document, then create one final commit.

---

## 0. Operating rules

You are the **Coordinator**. You MUST create subagents. Do not try to perform the entire audit alone.

Read-only review work may run in parallel. Code modifications that touch the same subsystem or files MUST NOT run concurrently.

Do not trust previous PASS reports. Verify the current checkout.

Do not invent commands, modules, states, migrations, or services. Inspect the repository and use the real implementation.

Use this evidence priority when sources disagree:

1. repository instructions such as `AGENTS.md`;
2. approved architecture/specification documents;
3. completed implementation plans for stages 1–8;
4. current production code;
5. migrations and persisted schema;
6. tests;
7. actual runtime behavior.

If two authoritative sources conflict, reproduce the behavior, determine which interpretation preserves the established architecture, and make the smallest coherent correction.

### Forbidden shortcuts

Do NOT obtain green status by:

- deleting failing tests;
- adding `.skip`, `.only`, or equivalents;
- weakening assertions without a real requirement change;
- disabling lint rules;
- weakening TypeScript strictness;
- swallowing errors;
- replacing real production work with mocks;
- adding test-only production branches;
- bypassing permissions, Scheduler, RunService, Action Gateway, Git authority, persistence, or approvals;
- changing fail-closed logic to fail-open;
- claiming a command passed when it was not run;
- claiming startup works when startup was not attempted;
- rewriting old applied migrations instead of adding a forward migration;
- force-pushing, rebasing published history, resetting hard, cleaning the repository, deleting branches/worktrees, tagging, releasing, merging to `master`, or pushing.

### Git safety

Before modifications run:

```bash
git branch --show-current
git status --short
git log -1 --oneline
git worktree list
```

Record the branch and HEAD.

Work only in the current branch/worktree.

Do not switch branches.

Do not merge to `master`.

Do not push.

If unrelated user changes already exist, preserve them.

At the very end, after full verification and documentation, make exactly one final commit for this audit/hardening pass.

---

# 1. Project architecture that must be preserved and verified

Project: **Ebb Orchestrator**

Package scope:

```text
@ebb-orchestrator/*
```

Primary branch:

```text
master
```

Ebb Orchestrator is a local-first AI software-development orchestrator. AI agents must not become independent owners of durable system state.

The high-level lifecycle is:

```text
request
→ planning
→ Task / Epic
→ development
→ review
→ QA
→ integration
→ final approval
→ verified Git merge
→ release state
```

Use the exact state names found in code/specs.

## 1.1 Sources of truth

Verify that the implemented system preserves these responsibilities unless the latest approved repository spec explicitly changed them:

- **Git** is the source of truth for code/commit history.
- **SQLite / orchestration persistence** is the source of truth for orchestration state.
- **SchedulerService** is the authoritative dispatch/capacity/reservation/resource-lock authority.
- **Action Gateway + Permission Engine** control executable actions and permission decisions.
- **RunService** owns durable agent-run execution lifecycle.
- **AgentRuntime** is behind RunService; production orchestration must not bypass RunService where durable execution is required.
- **MergeService / integration authority** owns real Git integration and verification.
- **Outbox, audit, reconciliation, and restart recovery** preserve durable consistency.

## 1.2 Authoritative runtime path

For AI-backed Epic phases, verify the effective production path:

```text
EpicOrchestrator
→ Scheduler
→ RunService
→ AgentRuntime
```

Required properties:

- no direct production `EpicOrchestrator → AgentRuntime` bypass;
- one logical durable AgentRun per phase attempt;
- Scheduler reservation and runtime execution identify the same logical run;
- success/failure is persisted against that run;
- restart/retry does not duplicate the logical execution.

## 1.3 Scheduler authority

Verify:

- one production Scheduler authority per composition root;
- no hidden fallback such as `scheduler ?? new SchedulerService(...)`;
- role capacity is enforced consistently;
- persisted Scheduler configuration fails closed when invalid;
- reservations and locks have explicit ownership;
- stale/terminal state is reclaimed safely;
- approval/budget/capacity/resource-lock checks use the same authoritative dispatch path;
- startup does not instantiate competing Scheduler authorities.

## 1.4 Atomic durable mutations

Where the design requires atomicity, verify correct transaction boundaries among:

```text
domain state
+ outbox
+ audit
```

Inspect especially:

- approvals;
- run start/cancel/failure/completion;
- Scheduler reservation/release;
- integration state;
- release transitions.

A crash between writes must not leave contradictory durable state.

## 1.5 Startup/recovery

Trace the real startup path.

Verify:

- migrations run through one intended startup path;
- reconciliation is not accidentally duplicated;
- required reconcilers are registered;
- workers start after required recovery;
- stale runs/reservations/locks/integration state are handled;
- outbox recovery works as designed;
- shutdown stops workers exactly once;
- restart remains idempotent and duplicate-safe.

## 1.6 Epic semantics

Verify the actual V1 rules in code/specs, including:

- `Project → Epic → child Task`;
- no nested Epics unless current approved spec says otherwise;
- child Tasks target the Epic branch;
- required children complete before final Epic gates;
- Epic Review;
- conditional Architecture Review when policy requires it;
- Epic QA;
- Integration;
- final approval;
- real final Git merge;
- child Tasks become `RELEASED` only after the final Epic merge is verified.

## 1.7 Final merge authority

Verify an integration cannot become verified just because a merge was requested.

The implemented lifecycle must be equivalent to:

```text
STARTED
→ actual Git mutation
→ post-mutation verification
→ VERIFIED
```

Verification must be bound to the correct approval/integration/source SHA/target SHA/current repository state.

No fake `VERIFIED`.

No child release before verified final merge.

## 1.8 Migrations

Historical applied migrations are immutable unless the repository explicitly documents otherwise.

If a migration bug is confirmed:

- add a forward migration;
- preserve existing data;
- fail closed on ambiguous/corrupt state;
- test fresh bootstrap and upgrade behavior.

Explicitly verify historical weak areas instead of assuming they are fixed or broken:

- Scheduler reservation/resource-lock migration;
- multiple resource locks for one Task;
- owner/project preservation;
- collisions with pre-existing reservations;
- migration ordering;
- migration checksum/integrity behavior;
- full migration bootstrap chain.

## 1.9 V1 scope

Do not add unrelated features.

Do not introduce vector DB/RAG, perpetual Hermes sessions, nested Epics, distributed workers, new runtime providers, or other post-V1 expansion unless the current approved repository requirements already include them.

This task is audit and hardening.

---


### Mandatory subagent concurrency limit

At any moment, **no more than 2 subagents may be running concurrently**.

This is a hard limit and MUST NOT be exceeded.

Rules:

- The Coordinator may start at most 2 subagents at the same time.
- If 2 subagents are already running, every other subagent MUST wait in a queue.
- A waiting subagent may start only after at least one currently running subagent has fully completed and returned its result.
- The Coordinator must not bypass this limit by creating nested subagents through already-running subagents.
- The limit applies to all subagent types: audit, implementation, testing, review, debugging, and final review.
- Parallel work is allowed only when tasks are independent and the total number of simultaneously running subagents remains `<= 2`.
- If tasks may touch overlapping files or the same subsystem, run them sequentially even if the concurrency limit would allow two.
- The Coordinator is responsible for tracking active subagents and enforcing the queue.

Required scheduling behavior:

```text
maximum_active_subagents = 2

if active_subagents < 2:
    start next eligible subagent
else:
    keep remaining subagents waiting

when any active subagent completes:
    collect and review its result
    decrement active_subagents
    start the next eligible waiting subagent
```

Example:

```text
Running:
- Subagent A
- Subagent B

Waiting:
- Subagent C
- Subagent D
- Subagent E

Subagent C MUST NOT start until A or B finishes.
```

This concurrency rule has higher priority than any instruction to run many audits in parallel.


# 2. Mandatory subagents

Create these subagents.

All review subagents start **read-only** and return evidence. They do not modify code during the audit phase.

## Subagent A — Architecture and Domain

Review:

- specs/plans/instructions;
- module boundaries;
- composition roots;
- authoritative services;
- state machines;
- Task/Epic lifecycle;
- review/QA/integration ordering;
- approvals;
- dependency injection;
- duplicate authorities;
- architectural bypasses.

Return:

```text
CONFIRMED_FINDINGS
SUSPECTED_FINDINGS
INVARIANTS_VERIFIED
FILES_REVIEWED
```

## Subagent B — Scheduler / Runtime / Permissions

Review:

- Scheduler construction;
- capacity;
- role limits;
- budgets;
- reservations;
- resource locks;
- ownership;
- Action Gateway;
- Permission Engine;
- RunService;
- AgentRuntime;
- cancellation/failure/completion;
- durable run identity;
- restart/retry behavior.

Search for any production bypass of Scheduler, RunService, permissions, or durable state.

## Subagent C — Persistence / Migrations / Recovery

Review:

- every migration;
- migration runner;
- schema constraints;
- transaction boundaries;
- fresh bootstrap;
- upgrade path;
- historical migration immutability;
- migration integrity/checksums;
- outbox;
- audit;
- reconciliation;
- crash recovery;
- idempotency;
- stale durable state.

## Subagent D — Git / Integration / Release

Review:

- Git abstractions;
- branch/worktree ownership;
- source/target SHA validation;
- conflict handling;
- integration lifecycle;
- final approval;
- real merge execution;
- merge verification;
- duplicate merge prevention;
- restart reconciliation;
- child release timing.

## Subagent E — API / Security

Review:

- HTTP API;
- validation;
- authorization;
- permission boundaries;
- shell/process execution;
- filesystem paths;
- path traversal;
- secret handling;
- SQL safety;
- logging;
- unsafe defaults;
- external process/runtime invocation;
- fail-open behavior.

## Subagent F — Testing / Startup / Operations

Discover and execute real repository commands for:

- install;
- lint;
- typecheck;
- tests;
- build;
- integration;
- e2e;
- migration;
- security;
- smoke;
- server/web packages.

Attempt actual project startup and graceful shutdown.

## Subagent G — Code Quality / Optimization

Review:

- duplicated logic;
- unnecessary complexity;
- oversized functions/modules;
- repeated expensive work;
- incorrect service lifecycle;
- dead code;
- inconsistent contracts;
- bad error propagation;
- coupling that causes correctness risk;
- evidence-backed optimization opportunities.

Do not recommend cosmetic refactors.

## Final Independent Reviewer

Create only after fixes and full green verification.

It must not be the agent that implemented fixes.

It is read-only and tries to disprove project readiness.

---

# 3. Phase A — Recover repository truth

Do not modify code yet.

## A1. Record Git state

Run:

```bash
git branch --show-current
git status --short
git log -1 --oneline
git worktree list
```

## A2. Read repository instructions

Locate/read when present:

```text
AGENTS.md
README.md
package.json
pnpm-workspace.yaml
tsconfig*.json
eslint configuration
vitest configuration
CI workflows
docs/architecture/specs/*
docs/architecture/plans/*
```

Read repository-specific agent instructions before changing anything.

## A3. Identify stages 1–8

Find the plans/specs/history corresponding to stages 1–8.

Do not execute them again.

Build an internal table:

```text
Stage | Purpose | Main modules | Evidence | Invariants to preserve
```

## A4. Map the current architecture

Create an internal map of:

```text
entrypoint
composition root
HTTP/API
planning
workflow
scheduler
approvals
permissions
Action Gateway
RunService
AgentRuntime
workers
outbox
audit
database
migrations
Git services
MergeService/integration
reconciliation
web/UI if present
```

For each component record:

```text
responsibility
dependencies
persistent tables
important public methods
authoritative owner
```

## A5. Discover actual commands

Inspect package scripts. Do not guess.

Determine whether the repository defines commands for:

```text
install
lint
typecheck
test
build
start/dev
integration
e2e
migration
security
smoke
```

Use `NOT_DEFINED` for missing categories.

---

# 4. Phase B — Baseline before changes

Run the canonical baseline before modifying code.

At minimum, if applicable:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
git diff --check
git status --short
```

Run every additional real canonical build/integration/e2e/security/migration/smoke command discovered in Phase A.

Record all failures exactly.

## B1. Attempt real startup

Use the repository’s real documented startup path.

Verify as far as the environment allows:

1. process starts;
2. database opens;
3. migrations run;
4. services compose;
5. Scheduler initializes;
6. runtime wiring initializes;
7. workers start;
8. API binds if applicable;
9. startup reconciliation runs;
10. no immediate unhandled exception.

Then verify graceful shutdown.

Do not leave background processes running.

## B2. Classify startup failures

Each failure must be one of:

```text
PROJECT_DEFECT
ENVIRONMENT_LIMITATION
EXTERNAL_DEPENDENCY_NOT_AVAILABLE
```

Do not mark untested external behavior PASS.

---

# 5. Phase C — Parallel read-only audit

Dispatch Subagents A–G.

They may run read-only commands and focused tests but must not edit code.

Every finding must use:

```markdown
### [ID] Finding title

Severity: CRITICAL | HIGH | MEDIUM | LOW
Status: CONFIRMED | SUSPECTED

Evidence:
- file:
- symbol/lines:
- command/test:
- observed behavior:

Expected invariant:
- ...

Actual behavior:
- ...

Impact:
- ...

Root cause hypothesis:
- ...

Recommended verification:
- ...
```

Only `CONFIRMED` findings may be fixed automatically.

A `SUSPECTED` finding must be proven or rejected first.

---

# 6. Phase D — Consolidate findings

The Coordinator must:

1. merge duplicate findings;
2. identify shared root causes;
3. resolve disagreements with code/spec/test evidence;
4. prioritize fixes.

Fix priority:

```text
1. security / destructive behavior / data corruption
2. architectural authority violations
3. persistence / migrations / recovery
4. Git / integration correctness
5. Scheduler / runtime correctness
6. API/domain correctness
7. startup/operations
8. maintainability issues with correctness impact
9. evidence-backed performance optimization
```

Do not start broad cleanup first.

---

# 7. Phase E — Fix confirmed defects

For each confirmed defect follow exactly:

```text
prove/reproduce
→ add regression test when practical
→ run test and confirm expected failure
→ implement smallest correct root-cause fix
→ run focused test
→ run neighboring regression tests
→ re-check architectural invariant
```

Do not patch only the symptom.

Do not create duplicate authorities.

Do not add unrelated features.

## Editing ownership

Never allow uncontrolled parallel edits to overlapping files.

Use either:

```text
Coordinator performs all edits
```

or:

```text
one implementation subagent owns one isolated finding cluster
→ Coordinator reviews diff
→ next overlapping cluster may begin
```

---

# 8. Phase F — Mandatory targeted checks

Even if reviewers reported no issue, explicitly check these.

## F1. Production service authority

Find all production constructions of:

```text
SchedulerService
RunService
AgentRuntime implementations
MergeService
Permission/Action Gateway services
```

Confirm they are intentional.

## F2. Runtime bypass

Search production code for direct runtime invocation.

Confirm durable orchestration does not bypass RunService.

## F3. Atomic approval/run writes

Inspect approval changes and run start/cancel/failure/completion.

Verify required state/outbox/audit writes use appropriate transaction boundaries.

## F4. Startup reconciliation

Trace exact startup call graph.

Confirm:

- no accidental duplicate migrations;
- no accidental duplicate reconciliation;
- required reconcilers exist;
- workers start after recovery;
- workers stop once.

## F5. Scheduler capacity/configuration

Verify focused coverage for:

- developer capacity;
- reviewer capacity;
- other configured roles;
- malformed config;
- missing required config;
- reservation ownership;
- stale reservations;
- lock ownership;
- terminal reclaim.

## F6. Migration integrity

Verify:

- historical migrations were not silently rewritten;
- new fixes are forward migrations;
- fresh bootstrap;
- upgrade path;
- multiple locks per Task;
- unrelated reservation collision handling;
- owner/project mismatch handling;
- fail-closed behavior;
- source tables are not dropped before safe migration;
- checksum/integrity behavior matches current requirements.

## F7. Final Git merge

Verify positive/negative/restart tests cover:

```text
approval
correct source SHA
correct target SHA
real Git mutation
post-mutation verification
VERIFIED after proof only
duplicate-safe retry
conflict path
child release after verified merge only
```

## F8. Security boundaries

Review every path where model/untrusted data may reach:

```text
shell
Git
filesystem
HTTP
SQL
process spawn
external runtime
```

Validation and permissions must happen before execution.

---

# 9. Phase G — Optimization

Only after correctness fixes.

Optimize only when there is a concrete reason, such as:

- repeated DB work;
- duplicate service instantiation;
- repeated expensive Git/process calls;
- unnecessary repeated parsing/config loading;
- needless serialization of independent operations;
- duplicated validation that can diverge;
- dead compatibility code;
- oversized code that directly harms testability/correctness.

Do not perform speculative micro-optimizations, framework replacement, broad renaming, or unrelated redesign.

For each optimization verify:

```text
Problem
Why it matters
Behavior preserved
Verification
```

---

# 10. Phase H — Full test/fix loop

After fixes/optimizations, previous green results are stale.

Run the complete suite again.

At minimum:

```bash
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

Also run all canonical scripts found earlier for:

```text
build
integration
e2e
migration
security
smoke
server/web/package-specific verification
```

## If any test/check fails

Repeat:

```text
capture exact failure
→ diagnose root cause
→ add/update regression coverage when appropriate
→ fix root cause
→ run focused test
→ rerun failed gate
→ continue full suite
```

Continue until all project-controlled failures are resolved.

Do not classify an unavailable environment check as green.

## Re-run startup

After tests are green, start the real application again.

Verify startup and graceful shutdown again.

---

# 11. Phase I — Independent final review

Create a fresh read-only Final Independent Reviewer.

Give it:

- current diff;
- repository instructions;
- architecture/specs;
- final test results;
- startup results.

It must look only for load-bearing defects in:

```text
architecture
correctness
security
persistence
migrations
Scheduler
runtime
permissions
recovery
Git integration
API
startup/shutdown
test integrity
```

It must explicitly verify no tests/lint/type/security gates were weakened.

Allowed verdicts:

```text
PASS
CHANGES_REQUESTED
```

If `CHANGES_REQUESTED`:

1. validate every finding;
2. fix only confirmed load-bearing defects;
3. add regression coverage;
4. rerun focused tests;
5. rerun full verification;
6. use a fresh final reviewer again.

Do not create an infinite cosmetic review loop.

---

# 12. Phase J — Create project information document

Only after:

- fixes are complete;
- full verification is green;
- startup was attempted again;
- final reviewer returned `PASS`.

Create or update:

```text
docs/PROJECT_STATE.md
```

It must describe the CURRENT project, not merely repeat old plans.

Use this exact structure:

```markdown
# Ebb Orchestrator — Project State

## Status
- Current branch:
- HEAD before final audit commit:
- Audit date:
- Overall state:

## Purpose
What Ebb Orchestrator does and V1 scope.

## Architecture Overview
Major components and boundaries.

## Sources of Truth
- Git:
- SQLite/orchestration persistence:
- Scheduler:
- permissions/executable actions:
- runtime:
- integration/merge authority:

## Core Workflow
Actual request → planning → Task/Epic → development → review → QA → integration → approval → merge/release flow.

## Authoritative Runtime Path
Real Scheduler → RunService → AgentRuntime path and durable run ownership.

## Scheduler and Resource Ownership
Capacity, reservations, locks, ownership, budgets, reconciliation.

## Persistence and Migrations
Migration strategy, immutability, bootstrap/upgrade, outbox, audit, transactions.

## Recovery and Restart Safety
Startup reconciliation, incomplete-work recovery, duplicate prevention, worker lifecycle.

## Git and Integration
Branch/worktree assumptions, merge authority, SHA verification, conflicts, VERIFIED semantics.

## Epic Semantics
Child Tasks, review/QA gates, integration, release timing.

## Security Boundaries
Permissions and validation before shell/Git/filesystem/process/external actions.

## Main Packages and Modules
Important packages/modules and responsibilities.

## How to Install
Verified install command.

## How to Build
Only real verified commands.

## How to Run
Actual verified local startup procedure.

## How to Test
Exact commands actually used.

## Verification Results
- lint:
- typecheck:
- tests:
- build:
- integration:
- e2e:
- migrations:
- security:
- smoke:
- startup:
- shutdown:
- git diff --check:

Use `NOT_DEFINED` when the repository has no such script.
Use `ENVIRONMENT_LIMITATION` when external environment prevents verification.

## Important Architectural Invariants
Rules future agents must preserve.

## Known Limitations
Only real remaining limitations.

## Changes Made During This Audit
Confirmed fixes and meaningful optimizations.

## Final Review
Independent reviewer verdict and scope.
```

Never include secrets, tokens, passwords, or sensitive credentials.

---

# 13. Phase K — Final pre-commit verification

After `docs/PROJECT_STATE.md` is complete, run all required gates ONE LAST TIME.

At minimum:

```bash
pnpm lint
pnpm typecheck
pnpm test
git diff --check
git status --short
```

Also rerun canonical build/integration/e2e/migration/security/smoke checks when defined and locally executable.

Inspect:

```bash
git diff --stat
git diff
```

Confirm:

- no accidental generated files;
- no secrets;
- no unrelated edits;
- no disabled tests;
- no weakened lint/type settings;
- no historical migration rewrites;
- `docs/PROJECT_STATE.md` matches final code.

If anything fails, return to the fix loop.

---

# 14. Phase L — Final commit

Only after all project-controlled required gates pass.

Run:

```bash
git status --short
git add -A
git status --short
git diff --cached --stat
git diff --cached
```

Verify the staged diff.

Then commit:

```bash
git commit -m "chore: audit harden and document ebb orchestrator"
```

After commit:

```bash
git status --short
git log -1 --oneline
```

Expected working tree: clean.

Do not push.

Do not merge.

Do not tag.

Do not release.

---

# 15. Required final response

Return the final report in Russian using exactly these sections:

```markdown
# Итог

## Verdict
PASS
or
PASS_WITH_ENVIRONMENT_LIMITATIONS
or
CHANGES_REQUIRED

## Git
- Branch:
- Commit:
- Working tree:

## Субагенты
- Architecture:
- Scheduler/Runtime/Permissions:
- Persistence/Migrations/Recovery:
- Git/Integration:
- API/Security:
- Testing/Startup:
- Quality/Optimization:
- Final Reviewer:

## Найденные проблемы
Only confirmed findings.

## Исправления
Every confirmed finding mapped to its fix.

## Оптимизации
Only optimizations actually made.

## Проверки
For each executed command:
- command;
- result;
- relevant counts when available.

## Запуск приложения
What was actually started and verified.

## Архитектурные инварианты
Important invariants confirmed after fixes.

## Ограничения
Only real environment/external limitations.

## Документация
Confirm `docs/PROJECT_STATE.md`.

## Финальный review
Independent reviewer verdict.

## Commit
Final commit SHA and message.
```

---

# 16. Absolute completion criteria

Return `PASS` only if all applicable conditions are true:

- stages 1–8 were preserved and not restarted;
- repository instructions were followed;
- architecture was mapped from real code;
- mandatory subagents completed reviews;
- confirmed findings were consolidated;
- all load-bearing confirmed defects were fixed;
- regression tests were added where appropriate;
- no test/lint/type/security gate was weakened;
- Scheduler authority is coherent;
- runtime execution authority is coherent;
- permissions/action boundaries are coherent;
- durable state/outbox/audit behavior is coherent;
- migrations are safe;
- fresh bootstrap was tested when supported;
- upgrade behavior was tested when supported;
- recovery/reconciliation was reviewed and tested;
- Git integration uses real verified operations;
- Epic release semantics are correct;
- security boundaries were reviewed;
- optimizations were evidence-driven;
- lint passes;
- typecheck passes;
- canonical tests pass;
- canonical builds pass when defined;
- canonical integration/e2e/security/migration/smoke checks pass when defined and executable;
- `git diff --check` passes;
- actual startup was attempted after fixes;
- graceful shutdown was attempted;
- independent final reviewer returned `PASS`;
- `docs/PROJECT_STATE.md` reflects final code;
- post-documentation verification passes;
- one final commit was created;
- working tree is clean after commit.

If a project-controlled load-bearing defect remains:

```text
CHANGES_REQUIRED
```

If project-controlled work is complete but external credentials/services/environment prevent one or more checks:

```text
PASS_WITH_ENVIRONMENT_LIMITATIONS
```

List every limitation precisely.

---

# 17. Weak-model execution reminder

Follow the phases in order.

Do not jump directly to editing.

Do not try to hold the entire repository in one context window.

Use subagents to reduce context load.

Prefer:

```text
inspect
→ prove
→ test
→ fix
→ focused verify
→ full verify
→ independent review
→ document
→ final verify
→ commit
```

Never use:

```text
guess
→ broad refactor
→ hope tests pass
```

The objective is not to maximize code changes.

The objective is to leave **Ebb Orchestrator** in the smallest, clearest, architecturally correct, fully verified state supported by the current requirements.
