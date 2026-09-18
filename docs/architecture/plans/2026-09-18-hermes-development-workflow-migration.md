# Hermes Development Workflow Migration Implementation Plan

> **For agentic workers:** execute this plan task-by-task. Do not merely summarize it.
>
> **Goal:** completely replace OpenCode as the external development executor used to develop Ebb Orchestrator, while preserving the existing repository plans, Git/worktree discipline, review gates, Russian JSDoc policy, and a hard limit of two concurrent subagents.
>
> **Architecture:** Ebb Orchestrator production runtime is NOT being migrated here. The product already uses `AgentRuntime` / `HermesRuntimeAdapter`. This plan changes only the developer workflow used by maintainers to execute `docs/superpowers/plans/*.md`. Repository-owned Hermes instructions live in `.hermes.md`; repository-owned skill sources live under `tools/hermes/skills/`; `scripts/hermes-dev.mjs` synchronizes those skills into the active Hermes profile and provides setup/check/execute commands.
>
> **Tech Stack:** Node.js 24+, pnpm, Git, Hermes Agent CLI/Desktop, Markdown `SKILL.md`, existing TypeScript/React/Vitest project.
>
> **Spec:** `docs/superpowers/specs/2026-09-16-ebb-orchestrator-design.md`
>
> **Important distinction:** this plan does not modify the production `HermesRuntimeAdapter` unless a test reveals a pre-existing defect. It replaces the *external coding workflow* `OpenCode → /execute-plan` with `Hermes → Ebb development skills`.
>
> **Primary branch:** `master`.

## Global Constraints

- Never run more than **2 subagents concurrently**.
- Nested delegation is forbidden for this project-development workflow.
- Do not let Hermes create nested worktrees. The human/coordinator opens the intended worktree before execution.
- All new or modified production-code comments are in Russian.
- Public/contractual production APIs use Russian JSDoc according to the repository JSDoc guide.
- Do not weaken lint, typecheck, tests, JSDoc rules, security checks, approvals, or Git safeguards.
- Do not merge into `master`, push, tag, release, `reset --hard`, or `git clean`.
- Existing `docs/superpowers/plans/*.md` remain the canonical implementation-plan format.
- Do not remove `.opencode` until Hermes parity verification has passed.
- Do not change provider/model credentials in this migration.
- Do not modify the Ebb Orchestrator production runtime architecture merely to make the development workflow easier.
- Preserve unrelated pre-existing working-tree changes.

---

# Desired end state

After this plan the repository must have the following development-tooling shape:

```text
repo/
├── .hermes.md
├── package.json
├── scripts/
│   └── hermes-dev.mjs
├── tools/
│   └── hermes/
│       ├── README.md
│       ├── skills/
│       │   ├── ebb-execute-plan/
│       │   │   └── SKILL.md
│       │   ├── ebb-implement-task/
│       │   │   └── SKILL.md
│       │   ├── ebb-review-task/
│       │   │   └── SKILL.md
│       │   └── ebb-final-review/
│       │       └── SKILL.md
│       └── fixtures/
│           └── parity-plan.md
└── docs/
    └── development/
        └── hermes.md
```

The user-facing workflow must become:

```text
create/switch to intended worktree
→ pnpm hermes:setup
→ pnpm hermes:check
→ pnpm hermes:execute -- docs/superpowers/plans/<plan>.md
→ Hermes executes plan
→ max 2 subagents
→ implementation/review/tests/final review
→ commits only in current feature branch
```

The migration is incomplete until a real Hermes parity run succeeds.

---

# Task 1 — Establish baseline and inventory every OpenCode dependency

**Files:**
- Read: `.opencode/**` if present
- Read: `package.json`
- Read: `README.md`
- Read: `.gitignore`
- Read: `AGENTS.md` if present
- Read: `.hermes.md` / `HERMES.md` if already present
- Read: `docs/superpowers/plans/**`
- Create: `docs/audit/opencode-to-hermes-inventory.md`

**Purpose:** determine what OpenCode currently contributes to repository development so no behavior is accidentally lost.

- [ ] **Step 1: Record Git baseline**

Run:

```bash
git branch --show-current
git status --short
git log -1 --oneline
git worktree list
```

Write the current branch, HEAD, and pre-existing changes into the inventory.

- [ ] **Step 2: Find active OpenCode references**

Search repository-wide for:

```text
.opencode
opencode
/execute-plan
sdd-orchestrator
implementer
reviewer
final-reviewer
```

Classify each result:

```text
ACTIVE_CONFIG
ACTIVE_DOCUMENTATION
HISTORICAL_DOCUMENTATION
TEST_FIXTURE
UNRELATED
```

Do not delete historical audit/plan text simply because it mentions OpenCode.

- [ ] **Step 3: Read all active OpenCode agents/commands**

For every active `.opencode` file, record:

```text
file
purpose
inputs
allowed actions
Git rules
subagent rules
review rules
test gates
commit rules
special project knowledge
```

- [ ] **Step 4: Write inventory**

Create `docs/audit/opencode-to-hermes-inventory.md` with:

```markdown
# OpenCode → Hermes Development Workflow Inventory

## Baseline
## Active OpenCode Files
## Behaviors To Preserve
## Behaviors To Drop
## Repository Instructions To Move To .hermes.md
## Behaviors To Move To Hermes Skills
## Package/Script References
## Documentation References
## Removal Preconditions
```

- [ ] **Step 5: Verify no changes outside inventory**

Run:

```bash
git diff --check
git status --short
```

Do not commit yet.

---

# Task 2 — Add authoritative Hermes project context

**Files:**
- Create or replace: `.hermes.md`
- Read: `docs/superpowers/specs/2026-09-16-ebb-orchestrator-design.md`
- Read: repository JSDoc guide

**Produces:** project instructions automatically loaded by Hermes from the repository root.

- [ ] **Step 1: Create `.hermes.md`**

Use this content, adjusting only paths that are proven different in the repository:

```markdown
# Ebb Orchestrator — Hermes Development Instructions

## Scope

These instructions govern development OF Ebb Orchestrator by Hermes.
They do not replace the product's internal AgentRuntime/HermesRuntimeAdapter architecture.

## Git

- Primary branch is `master`.
- Work only in the worktree/branch supplied by the user.
- Never merge to `master` without explicit human approval.
- Never push, force-push, tag, release, `reset --hard`, or `git clean` unless explicitly requested.
- Preserve unrelated pre-existing changes.
- Before edits run `git branch --show-current`, `git status --short`, and `git log -1 --oneline`.

## Plans

- Canonical implementation plans live in `docs/superpowers/plans/`.
- When executing a plan, read the whole plan before editing.
- Execute tasks in dependency order.
- Do not silently reinterpret requirements.
- If current code disproves an assumption in the plan, record the evidence and choose the smallest correction that preserves the approved architecture.

## Subagents

- HARD LIMIT: at most 2 subagents may run concurrently.
- If 2 are active, all others wait.
- Do not use nested subagents.
- Do not bypass the limit through child orchestrators.
- If tasks overlap in files or subsystem ownership, execute them sequentially.
- Review agents are read-only unless explicitly assigned an implementation task.

## Development discipline

Use:

inspect → prove → test → fix → focused verify → full verify → review.

For defects:
1. reproduce or prove;
2. add a failing regression test when practical;
3. implement the smallest root-cause fix;
4. run focused tests;
5. run related tests;
6. run repository gates.

Do not weaken tests or rules to obtain green status.

## Architecture invariants

Preserve the approved Ebb Orchestrator architecture:
- deterministic-first;
- modular monolith + Ports & Adapters;
- Git is source of truth for code;
- SQLite is source of truth for orchestration state;
- Workflow Engine owns state transitions;
- Scheduler is authoritative for dispatch/capacity/reservations;
- durable runtime path goes through RunService before AgentRuntime;
- permissions/action execution go through the approved ActionGateway/PermissionEngine boundary;
- final merge is a real verified Git operation after required approval;
- recovery must reconcile before new AI work;
- historical migrations are forward-only/append-only.

Do not introduce post-v1 scope without an approved plan.

## Comments and JSDoc

- All newly created or modified production-code comments must be written in correct Russian.
- Technical identifiers are not translated.
- Exported/public/contractual production APIs require useful Russian JSDoc.
- Describe purpose, invariants, trust boundaries, side effects, preconditions, transaction/idempotency semantics, and meaningful errors where applicable.
- Do not add fake `@returns`, `@throws`, or `@example` tags.
- Do not weaken JSDoc ESLint rules.

## Verification

Discover real scripts from `package.json`; do not invent them.

Minimum final gates when defined:

```text
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

Also run canonical build/integration/e2e/security/migration/smoke gates affected by the work.

## Completion

Before reporting completion:
- inspect full diff;
- confirm no secrets or unrelated changes;
- confirm required tests actually ran;
- run an independent final review for substantial changes;
- report limitations explicitly.

A green test suite alone is not proof of architectural correctness.
```

- [ ] **Step 2: Do not create duplicate context files**

If an existing `.hermes.md` already contains unrelated valid rules, merge carefully rather than discarding them. Do not also create `HERMES.md` with duplicated policy.

---

# Task 3 — Add repository-owned Hermes skills

**Files:**
- Create: `tools/hermes/skills/ebb-execute-plan/SKILL.md`
- Create: `tools/hermes/skills/ebb-implement-task/SKILL.md`
- Create: `tools/hermes/skills/ebb-review-task/SKILL.md`
- Create: `tools/hermes/skills/ebb-final-review/SKILL.md`

**Interfaces:**
- `ebb-execute-plan` orchestrates a whole plan.
- `ebb-implement-task` performs exactly one task/finding cluster.
- `ebb-review-task` reviews one completed task read-only.
- `ebb-final-review` reviews the complete current diff read-only.

## Step 1: Create `ebb-execute-plan/SKILL.md`

Use:

```markdown
---
name: ebb-execute-plan
description: Execute an Ebb Orchestrator implementation plan safely.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, development, implementation-plan]
---

# Ebb Execute Plan

Use this skill only while developing Ebb Orchestrator.

## Input

A repository-relative implementation-plan path, normally under `docs/superpowers/plans/`.

## Hard rules

- Read `.hermes.md` first.
- Read the complete plan before editing.
- Work only in the current worktree/branch.
- Never run more than 2 subagents concurrently.
- Never create nested subagents.
- Never enable automatic child worktree isolation for this workflow.
- Preserve unrelated changes.
- Never merge/push/tag/release unless the human explicitly requests it.
- All changed/new production comments are Russian and use JSDoc where required.

## Procedure

1. Record branch, HEAD and working-tree status.
2. Read the plan completely.
3. Read files/specs referenced by the plan.
4. Build a task ledger: WAITING / READY / RUNNING / REVIEW / DONE / BLOCKED.
5. Determine dependencies and overlapping file ownership.
6. Dispatch no more than two independent tasks at once.
7. For each implementation task:
   - use the `ebb-implement-task` procedure;
   - collect result;
   - inspect diff;
   - run focused verification;
   - invoke `ebb-review-task` on the completed task before accepting it.
8. Do not let two agents edit overlapping files concurrently.
9. After all tasks, run plan gates, repository gates, and inspect the whole diff.
10. Invoke `ebb-final-review` with the current diff and plan.
11. If final review finds a confirmed blocker: reproduce, fix root cause, rerun focused/full gates, repeat final review with a fresh reviewer.
12. Commit only when the plan requires a commit and all applicable gates pass.
13. Return branch, HEAD/commit, tasks completed, tests/builds, reviewer verdict, limitations and working-tree state.

## Forbidden shortcuts

Do not skip failing tests, weaken assertions, disable lint/type/JSDoc/security rules, hide errors, invent PASS results, rewrite historical migrations, or broaden scope beyond the plan.
```

## Step 2: Create `ebb-implement-task/SKILL.md`

Use:

```markdown
---
name: ebb-implement-task
description: Implement one isolated Ebb Orchestrator plan task.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, implementation, tdd]
---

# Ebb Implement Task

Implement exactly one assigned plan task or one confirmed finding cluster.

## Before editing

1. Read `.hermes.md`.
2. Read the assigned task.
3. Read referenced spec/code/tests.
4. Confirm the allowed file set.
5. Run focused baseline tests when available.

## Implementation loop

For each behavior change:
1. prove/reproduce;
2. write/update a regression test;
3. run it and confirm expected failure when practical;
4. implement the smallest correct change;
5. update Russian JSDoc when a public contract/invariant changed;
6. run the focused test;
7. run neighboring tests;
8. run `git diff --check`;
9. inspect your diff.

## Boundaries

- Do not change unrelated files.
- Do not change another task's owned files without escalation.
- Do not merge/push/tag/release.
- Do not start subagents.
- Do not claim completion without test evidence.

Return files changed, tests run, result and remaining risks.
```

## Step 3: Create `ebb-review-task/SKILL.md`

Use:

```markdown
---
name: ebb-review-task
description: Independently review one Ebb Orchestrator task diff.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, review]
---

# Ebb Review Task

Review only. Do not edit files unless the coordinator explicitly reassigns you as implementer.

Check task/spec compliance, architecture invariants, correctness, error handling, persistence/restart semantics, security boundaries, tests/negative cases, Russian JSDoc policy, scope creep and accidental migration-history edits.

Classify findings: BLOCKER / IMPORTANT / MINOR / FALSE_POSITIVE.

Every non-trivial finding needs file/symbol, evidence, expected behavior, actual behavior and concrete impact.

Return `PASS` only when no blocker/important correctness issue remains.
```

## Step 4: Create `ebb-final-review/SKILL.md`

Use:

```markdown
---
name: ebb-final-review
description: Perform an independent final Ebb Orchestrator review.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, final-review]
---

# Ebb Final Review

You are an independent, read-only final reviewer.

Read `.hermes.md`, implementation plan, relevant approved spec, complete current diff, and test/build results.

Try to disprove readiness.

Inspect especially architecture authority boundaries, state transitions, Scheduler/RunService/runtime path, permissions, persistence/migrations/recovery, Git/worktree safety, integration/merge verification, security, startup/shutdown, tests, Russian JSDoc policy and documentation consistency.

Do not perform cosmetic review churn.

Verdict: `PASS` or `CHANGES_REQUESTED`.
For `CHANGES_REQUESTED`, provide only evidence-backed load-bearing findings.
```

- [ ] **Step 5: Validate skill files structurally**

Check YAML frontmatter, unique `name`, no placeholders, no instruction permitting >2 subagents, and no child delegation from implementer/reviewer.

Run:

```bash
git diff --check
```

---

# Task 4 — Add a reproducible Hermes development setup/runner

**Files:**
- Create: `scripts/hermes-dev.mjs`
- Modify: `package.json`

**Produces:**
- `pnpm hermes:setup`
- `pnpm hermes:check`
- `pnpm hermes:execute -- <plan>`

## Step 1: Implement `scripts/hermes-dev.mjs`

Use only Node built-ins:

```text
node:child_process
node:crypto
node:fs
node:os
node:path
```

Implement commands:

```text
setup
check
execute <plan>
```

Required `setup` behavior:

```text
1. Determine current Git worktree root with `git rev-parse --show-toplevel`.
2. Resolve HERMES_HOME:
   - process.env.HERMES_HOME if set;
   - otherwise path.join(os.homedir(), ".hermes").
3. Source skills = <repo>/tools/hermes/skills/.
4. Target root = <HERMES_HOME>/skills/ebb-orchestrator/.
5. Remove/recreate ONLY that target root.
6. Copy all repository Ebb skill directories recursively.
7. Run:
   hermes config set delegation.max_concurrent_children 2
   hermes config set delegation.max_spawn_depth 1
   hermes config set delegation.orchestrator_enabled false
   hermes config set delegation.worktree_isolation false
8. Never touch provider, model, API keys or unrelated Hermes config.
```

Required `check` behavior:

```text
1. `hermes --version` must succeed.
2. `.hermes.md` must exist in repo root.
3. Four source skill files must exist.
4. Four installed skill files must exist in HERMES_HOME.
5. SHA-256 of source and installed SKILL.md files must match.
6. Read/verify:
   delegation.max_concurrent_children == 2
   delegation.max_spawn_depth == 1
   delegation.orchestrator_enabled == false
   delegation.worktree_isolation == false
7. Print a per-check PASS/FAIL table.
8. Exit non-zero if any required check fails.
```

Required `execute <plan>` behavior:

```text
1. Require exactly one plan path argument.
2. Resolve current Git worktree root.
3. Resolve plan path relative to worktree unless absolute.
4. Reject a plan path escaping current worktree.
5. Reject missing/non-file plan.
6. Create a temporary UTF-8 prompt file in OS temp directory.
7. Prompt content:
   - state that this is trusted Ebb Orchestrator development work;
   - tell Hermes to read `.hermes.md`;
   - tell Hermes to use `ebb-execute-plan`;
   - provide the repository-relative plan path;
   - explicitly say EXECUTE, do not only summarize;
   - remind max 2 concurrent subagents and no nested delegation.
8. Spawn with inherited stdio:
   hermes --in <worktree-root> chat --query-file <temp-prompt>
9. Always remove temp prompt in `finally`.
10. Propagate Hermes exit status.
```

Implementation safety:
- use `spawnSync`/`execFileSync`, not shell interpolation;
- pass argv arrays;
- never run with `shell: true`;
- quote handling belongs to argv, not concatenated command strings.

## Step 2: Add root package scripts

Merge these into the existing root `scripts` object:

```json
{
  "hermes:setup": "node scripts/hermes-dev.mjs setup",
  "hermes:check": "node scripts/hermes-dev.mjs check",
  "hermes:execute": "node scripts/hermes-dev.mjs execute"
}
```

Do not replace unrelated scripts.

## Step 3: Test runner validation

Run:

```bash
pnpm hermes:execute
```

Expected: non-zero usage error.

Run:

```bash
pnpm hermes:execute -- does-not-exist.md
```

Expected: non-zero missing-file error.

Run an escaping path check appropriate for the current OS; it must be rejected.

Do not launch a real plan yet.

---

# Task 5 — Add developer documentation

**Files:**
- Create: `tools/hermes/README.md`
- Create: `docs/development/hermes.md`
- Modify: `README.md` only to add a short link if appropriate

## Step 1: `tools/hermes/README.md`

Document:
- this directory is canonical repository source for Ebb development skills;
- installed HERMES_HOME copies are generated/synchronized copies;
- do not manually edit installed copies;
- run `pnpm hermes:setup` after changing skills;
- list the four skills and responsibilities.

## Step 2: `docs/development/hermes.md`

Required sections:

```markdown
# Разработка Ebb Orchestrator через Hermes

## Что именно заменяет Hermes
OpenCode only as the external development executor.

## Что НЕ меняется
Production AgentRuntime/HermesRuntimeAdapter architecture.

## Первоначальная настройка
pnpm hermes:setup
pnpm hermes:check

## Запуск implementation plan
pnpm hermes:execute -- docs/superpowers/plans/<file>.md

## Интерактивный запуск
hermes --in "<worktree>" --tui

## Ограничение субагентов
2 concurrent, depth 1, no nested delegation.

## Worktrees
Human/coordinator selects the worktree.
Hermes child worktree isolation stays disabled.

## Обновление skills
edit tools/hermes/skills
pnpm hermes:setup
pnpm hermes:check

## Русский JSDoc
## Git safety
## Troubleshooting
```

Do not present OpenCode as the current preferred development workflow.

---

# Task 6 — Run setup and verify Hermes configuration

- [ ] Run:

```bash
pnpm hermes:setup
pnpm hermes:check
```

Expected `hermes:check`: PASS.

- [ ] Verify manually:

```bash
hermes --version
hermes config get delegation.max_concurrent_children
hermes config get delegation.max_spawn_depth
hermes config get delegation.orchestrator_enabled
hermes config get delegation.worktree_isolation
hermes skills list
```

Expected semantic values:

```text
2
1
false
false
```

Confirm all four `ebb-*` skills are visible.

---

# Task 7 — Add a real parity plan

**Files:**
- Create: `tools/hermes/fixtures/parity-plan.md`

Use this content:

```markdown
# Hermes Development Workflow Parity Plan

## Goal

Prove that Hermes can execute an Ebb repository plan end-to-end without OpenCode.

## Hard rules

- Read `.hermes.md`.
- Use no more than two concurrent subagents.
- No nested delegation.
- Do not modify production code.
- Do not merge/push/tag/release.

## Task 1 — Independent context checks

Launch exactly two read-only subagents concurrently.

Subagent A verifies:
- `.hermes.md` is loaded/consistent;
- `master` is documented as primary branch;
- Russian JSDoc rule is present;
- no-more-than-two rule is present.

Subagent B verifies:
- `tools/hermes/skills/` has the expected four source skills;
- active Hermes config has concurrency=2, depth=1, orchestrator disabled, child worktree isolation disabled.

Both return evidence only.

## Task 2 — Repository verification

Run:
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `git diff --check`

Do not modify code to make failures disappear.
If a baseline project failure exists, report it precisely.

## Task 3 — Write parity report

Create/update `docs/audit/hermes-development-workflow-parity.md`.

Include date, branch, HEAD, context verification, subagent concurrency evidence, delegation config, commands/results, final verdict `PASS` or `FAIL`.

Do not commit unless all project-controlled gates pass.

## Task 4 — Commit

If and only if verdict is PASS:

`git add docs/audit/hermes-development-workflow-parity.md`

Inspect staged diff.

Commit:

`docs: verify Hermes development workflow parity`

Do not include unrelated files.
```

---

# Task 8 — Commit migration infrastructure before parity run

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
git diff --check
git status --short
git diff --stat
git diff
```

Confirm:
- no provider/model credentials;
- no secrets;
- no production runtime changes;
- no `.opencode` deletion yet.

Commit migration infrastructure:

```bash
git commit -m "build: add Hermes development workflow"
```

Stage only intended files before the commit.

---

# Task 9 — Execute the parity plan through Hermes itself

Run:

```bash
pnpm hermes:execute -- tools/hermes/fixtures/parity-plan.md
```

This is the acceptance test for the migration.

After Hermes returns:

```bash
git status --short
git log -3 --oneline
```

Read `docs/audit/hermes-development-workflow-parity.md`.

Acceptance criteria:
- verdict PASS;
- exactly two read-only subagents used in the parallel check;
- no evidence of >2 simultaneous children;
- no nested delegation;
- project gates passed;
- parity report committed separately;
- no production code changed.

If FAIL:
- do not delete `.opencode`;
- fix migration tooling;
- rerun `pnpm hermes:setup` and `pnpm hermes:check`;
- rerun parity plan.

---

# Task 10 — Remove active OpenCode development configuration only after parity PASS

**Files:**
- Delete: active `.opencode/**` development configuration identified in Task 1
- Modify: active development docs/scripts/package entries that still require OpenCode
- Preserve: historical audit/plan evidence unless it is falsely presented as current instructions

- [ ] Re-read `docs/audit/opencode-to-hermes-inventory.md`.
- [ ] Delete only `ACTIVE_CONFIG`.
- [ ] Remove an OpenCode-only dependency/script only if repository search proves it has no remaining current use.
- [ ] Update current docs to use:

```bash
pnpm hermes:setup
pnpm hermes:check
pnpm hermes:execute -- docs/superpowers/plans/<plan>.md
```

- [ ] Search again for `.opencode`, `opencode`, `/execute-plan`.
- [ ] Classify remaining references; no `ACTIVE_CONFIG` or current-development instruction may remain.

---

# Task 11 — Final verification and independent review

Run:

```bash
pnpm hermes:setup
pnpm hermes:check
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

Also run canonical build gates defined by current `package.json`.

Launch one fresh read-only `ebb-final-review` reviewer.

It must verify:
- OpenCode is no longer required for current development;
- `.hermes.md` is sufficient and correct;
- setup cannot overwrite unrelated Hermes skills;
- setup does not change provider/model credentials;
- execute rejects path escape;
- max concurrency is 2;
- nested delegation is disabled;
- child worktree isolation is disabled;
- Russian JSDoc rule is preserved;
- production HermesRuntimeAdapter is not coupled to developer tooling;
- docs describe the real workflow.

If `CHANGES_REQUESTED`, fix confirmed blockers, rerun gates, and use a fresh reviewer.

---

# Task 12 — Final migration commit

Inspect:

```bash
git status --short
git diff --stat
git diff
```

Stage only migration cleanup.

Commit:

```bash
git commit -m "chore: retire OpenCode development workflow"
```

Final checks:

```bash
git status --short
git log -3 --oneline
pnpm hermes:check
```

Do not merge, push, tag or release.

---

# User workflow after migration

From any dedicated Ebb Orchestrator worktree:

```powershell
pnpm hermes:setup
pnpm hermes:check
pnpm hermes:execute -- docs/superpowers/plans/2026-09-XX-example.md
```

For an interactive Hermes session:

```powershell
hermes --in "C:\path\to\worktree" --tui
```

The project rules come from `.hermes.md`; reusable execution procedures come from the installed `ebb-*` skills.

---

# Completion criteria

This plan is complete only when ALL are true:

- `.hermes.md` exists and is auto-loadable project context;
- source skills are versioned in the repository;
- skills synchronize reproducibly to active `HERMES_HOME`;
- provider/model/secrets are untouched;
- concurrency is exactly 2;
- nested delegation is disabled;
- child worktree isolation is disabled;
- `pnpm hermes:check` passes;
- a real plan was executed through `pnpm hermes:execute`;
- parity report is PASS;
- OpenCode active development configuration is removed only after parity;
- full project gates pass;
- independent final review passes;
- documentation describes Hermes as the current development executor;
- no production-runtime architecture was unnecessarily changed.
