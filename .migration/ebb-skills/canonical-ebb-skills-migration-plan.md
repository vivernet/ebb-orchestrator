# Canonical Ebb Skills Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use Superpowers `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Use `ebb-repository-maintenance` for the move/setup-script portions and `ebb-quality-gates` before completion.

**Goal:** Move Ebb Orchestrator to one canonical repository-local `.agents/skills` set used directly by Codex and Hermes, and remove runtime-copy synchronization as a source-of-truth mechanism.

**Architecture:** Git owns `.agents/skills`. Codex discovers it natively. Hermes uses the same project-local directory after repository trust; Hermes setup manages capabilities/trust, not provider installation/configuration or skill copies. Superpowers stays external and is composed from Ebb skills rather than vendored.

> **Approved scope clarification (2026-09-28):** provider-addition/configuration behavior was an obsolete feature and must be removed, not preserved. Setup/check acceptance covers supported capabilities and project trust/discovery only. Do not create provider setup commands, provider smoke harnesses, or provider profile configuration.

**Tech Stack:** Agent Skills (`SKILL.md`), Node.js/pnpm project tooling, Git, Codex CLI, Hermes Agent CLI.

**Spec:** `canonical-ebb-skills-design.md`

## Global Constraints

- Preserve all unrelated/pre-existing worktree changes.
- Do not push, merge, publish, or delete profile/runtime data as part of this migration.
- Do not keep two editable canonical Ebb skill directories after migration.
- Do not set Hermes `skills.create_dir` to repository `.agents/skills`.
- Project naming, plan lifecycle, branch/worktree and commit policy override generic Superpowers defaults.
- Skill files must remain compatible with the open Agent Skills format.

## Known repository-input limitation

The supplied `tools/hermes` archive includes `README.md`, `capabilities.yaml` and the current `skills/` tree, but not the repository `package.json` or the implementation/tests behind `pnpm hermes:setup`, `pnpm hermes:check`, and `pnpm hermes:test`. Therefore this plan contains an explicit **owner-resolution preflight** instead of inventing script paths. Task 1 must record the exact files before Task 3 edits anything.

## Review Focus

- A stale copy/hash check still makes `HERMES_HOME` a hidden second authority.
- Hermes project discovery is configured/trusted for interactive and non-interactive project sessions.
- Existing profile-local `ebb-*` copies do not shadow project skills; project precedence is verified.
- Codex/Hermes both expose the same 13 canonical skills from `.agents/skills`.
- Cleanup of `tools/hermes/skills` happens only after reference scans and runtime acceptance checks pass.

---

### Task 1: Resolve current Hermes tooling owners and baseline

**Files:**
- Read: root `package.json` and workspace manifests.
- Read: exact script/test files reached by `hermes:setup`, `hermes:check`, and `hermes:test`.
- Modify: none.

**Interfaces:**
- Produces: `SETUP_OWNER[]`, `CHECK_OWNER[]`, `TEST_OWNER[]`, current skill-copy/hash behavior, and every repository reference to `tools/hermes/skills`/`HERMES_HOME` skill copies.

- [ ] **Step 1: Record Git baseline**

Run: `git rev-parse --show-toplevel && git branch --show-current && git rev-parse HEAD && git status --short`

Expected: repository root/branch/HEAD plus an immutable list of pre-existing changes.

- [ ] **Step 2: Resolve package-script entrypoints**

Run from repo root:

```bash
node -e "const p=require('./package.json'); for (const k of ['hermes:setup','hermes:check','hermes:test']) console.log(k+'='+(p.scripts?.[k] ?? '<missing>'))"
```

Expected: exact command behind each script. Follow nested package commands until the final JS/TS/MJS/shell owner files are identified.

- [ ] **Step 3: Find skill-copy and path references**

Run an equivalent repository search for:

```text
tools/hermes/skills
HERMES_HOME + skills
.hermes/skills
ebb-* copy/sync/hash logic
hermes skills trust
skills.trusted_project_dirs
skills.project_discovery
```

Expected: exact `path:line` inventory, including tests and docs. Do not edit yet.

- [ ] **Step 4: Baseline existing Hermes tests**

Run: `pnpm hermes:test`

Expected: record exact exit code and existing failures before migration. Do not classify a pre-existing failure as caused by the migration.

---

### Task 2: Add the canonical `.agents/skills` tree

**Files:**
- Create: `.agents/skills/ebb-curate-skills/**`
- Create: `.agents/skills/ebb-debug-issue/**`
- Create: `.agents/skills/ebb-execute-plan/SKILL.md`
- Create: `.agents/skills/ebb-final-review/SKILL.md`
- Create: `.agents/skills/ebb-implement-task/SKILL.md`
- Create: `.agents/skills/ebb-quality-gates/SKILL.md`
- Create: `.agents/skills/ebb-repository-context/SKILL.md`
- Create: `.agents/skills/ebb-repository-maintenance/**`
- Create: `.agents/skills/ebb-review-plan/**`
- Create: `.agents/skills/ebb-review-task/SKILL.md`
- Create: `.agents/skills/ebb-security-review/**`
- Create: `.agents/skills/ebb-web-e2e/**`
- Create: `.agents/skills/ebb-write-plan/**`
- Keep temporarily: `tools/hermes/skills/**` until Task 5.

**Interfaces:**
- Produces: one reviewed candidate canonical skill tree, still coexisting temporarily with the old path for rollback.

- [ ] **Step 1: Copy the provided canonical bundle exactly into `.agents/skills`**

Expected: 13 skill directories; no `ebb-task-execution-gates` directory.

- [ ] **Step 2: Validate skill structure/frontmatter**

Check for every skill: directory/name equality, lowercase-hyphen name, non-empty description, standard frontmatter, existing relative references, no stale hardcoded `tools/hermes/skills` or profile skill path.

Expected: all 13 pass.

- [ ] **Step 3: Search trigger overlap**

Review descriptions for at least these prompt classes: bug/debug, write plan, review plan, execute plan, implement one task, task review, quality verification, final review, security, web E2E, repository cleanup/move, skill curation.

Expected: each class has one primary Ebb trigger; no standalone execution-gates duplicate.

---

### Task 3: Refactor Hermes setup/check/tests away from skill copying

**Files:**
- Modify: every exact `SETUP_OWNER[]` file resolved in Task 1.
- Modify: every exact `CHECK_OWNER[]` file resolved in Task 1.
- Modify: applicable `TEST_OWNER[]` files resolved in Task 1.
- Modify: `tools/hermes/README.md`.

**Interfaces:**
- Consumes: canonical `.agents/skills` tree from Task 2 and owner lists from Task 1.
- Produces: setup that trusts/configures project skills without copying them; check/test logic that validates project-local discovery instead of installed-copy hashes.

- [ ] **Step 1: Write/update failing tests for the new setup contract**

Assertions must prove:

- setup resolves repository root;
- setup no longer creates/overwrites an Ebb skill tree under fake `HERMES_HOME`;
- setup invokes the supported Hermes project-trust path (`hermes skills trust <repo-root>` or the exact supported equivalent) using argv + `shell:false` in Node tooling;
- repeated setup is idempotent;
- supported capabilities behavior outside skill copying remains unchanged. Provider-addition/configuration behavior is explicitly removed per the approved scope clarification; no provider helper or smoke harness should remain.

Run the focused Hermes tooling tests.

Expected RED: old code still performs copy/sync or lacks project trust.

- [ ] **Step 2: Implement minimal setup change**

Remove only Ebb skill copy/sync behavior. Feature-detect the installed Hermes command where appropriate (`hermes skills trust --help`) rather than inventing a version number. Preserve unrelated Hermes configuration behavior.

- [ ] **Step 3: Rewrite check semantics**

Replace source-vs-`HERMES_HOME` skill hash equality with:

1. canonical `.agents/skills` validation;
2. expected 13-skill inventory validation;
3. repository trust/project-discovery verification with a clear remediation command when not trusted;
4. existing supported capability/delegation checks that remain applicable. Provider-addition and provider-profile checks are out of scope per the approved clarification above; no provider helper or smoke harness should remain.

A stale profile-local `ebb-*` copy may be reported as a warning, not used as the canonical pass criterion.

- [ ] **Step 4: Update `tools/hermes/README.md`**

Document `.agents/skills` as source of truth; explain that `hermes:setup` establishes Hermes runtime prerequisites/trust and no longer copies project skills. Document `hermes:check` accordingly.

- [ ] **Step 5: GREEN + neighboring tests**

Run focused script tests, then `pnpm hermes:test`.

Expected: migration-specific tests pass; any pre-existing failures are separately named and unchanged.

---

### Task 4: Verify real Hermes and Codex discovery before deleting the old source

**Files:**
- Modify: none unless verification exposes a real defect.

**Interfaces:**
- Consumes: Task 2 canonical tree and Task 3 setup/check behavior.
- Produces: real-runtime evidence that both hosts consume `.agents/skills`.

- [ ] **Step 1: Hermes setup/check**

Run: `pnpm hermes:setup` then `pnpm hermes:check` from the repository worktree.

Expected: setup succeeds without copying Ebb skills to `HERMES_HOME`; check recognizes canonical project skills.

- [ ] **Step 2: Hermes project skill discovery**

Run the current Hermes skill-list/show command from inside the repository.

Expected: all 13 `ebb-*` skills are visible as project skills. Verify at least `ebb-write-plan`, `ebb-execute-plan`, `ebb-repository-maintenance`, and `ebb-curate-skills` explicitly.

- [ ] **Step 3: Codex repository skill discovery**

Start Codex from the repository and use `/skills` (or `$` skill mention discovery).

Expected: the same 13 `ebb-*` skills are visible from `.agents/skills`.

- [ ] **Step 4: Companion smoke checks**

For one planning prompt and one bug prompt, confirm the expected Ebb skill is selectable and its Superpowers companion is available in that runtime. If Superpowers is intentionally installed outside the repo, record its provenance rather than copying it into `.agents/skills`.

---

### Task 5: Remove `tools/hermes/skills` and all repository references

**Files:**
- Delete: `tools/hermes/skills/ebb-debug-issue/**`
- Delete: `tools/hermes/skills/ebb-execute-plan/**`
- Delete: `tools/hermes/skills/ebb-final-review/**`
- Delete: `tools/hermes/skills/ebb-implement-task/**`
- Delete: `tools/hermes/skills/ebb-quality-gates/**`
- Delete: `tools/hermes/skills/ebb-repository-context/**`
- Delete: `tools/hermes/skills/ebb-review-plan/**`
- Delete: `tools/hermes/skills/ebb-review-task/**`
- Delete: `tools/hermes/skills/ebb-security-review/**`
- Delete: `tools/hermes/skills/ebb-web-e2e/**`
- Delete: `tools/hermes/skills/ebb-write-plan/**`
- Modify: every repository file from Task 1 that still references the old path.

**Interfaces:**
- Consumes: passing dual-runtime discovery from Task 4.
- Produces: exactly one Git-tracked Ebb skill source.

- [ ] **Step 1: Refresh the old-path/reference inventory immediately before deletion**

Expected: no newly appeared owner/reference is missed; if inventory differs from Task 1, reconcile it before continuing.

- [ ] **Step 2: Delete the old source tree and update remaining repository references**

Do not delete profile-local `HERMES_HOME` skills in this task.

- [ ] **Step 3: Prove old repository path is gone**

Run repository search for `tools/hermes/skills` and legacy copy/hash semantics.

Expected: zero active references; intentional migration-history text, if any, is explicitly classified.

- [ ] **Step 4: Re-run Hermes and Codex discovery**

Expected: Task 4 results remain unchanged after old source deletion.

---

### Task 6: Final quality and review

**Files:**
- Modify: only confirmed findings from review.

**Interfaces:**
- Produces: completion evidence for the migration.

- [ ] **Step 1: Run repository gates**

Run at minimum the applicable Hermes tests/checks, docs validation, lint/typecheck/test/build required by the repository policy, and `git diff --check`.

Expected: fresh outputs on current HEAD; failures are classified, not hidden.

- [ ] **Step 2: Whole-change review**

Use `ebb-final-review`, with `ebb-repository-maintenance` and `ebb-curate-skills` as specialist rubrics for the migration/skill-set parts.

Expected: `PASS` or concrete `CHANGES_REQUESTED` findings. Fix confirmed findings narrowly and re-run affected gates/re-review.

- [ ] **Step 3: Final state proof**

Verify:

```text
.agents/skills = only Git-tracked canonical Ebb skill tree
tools/hermes/skills = absent
pnpm hermes:setup = no skill-copy behavior
pnpm hermes:check = project-skill validation/discovery semantics
Codex = 13 Ebb skills visible
Hermes = 13 project Ebb skills visible
```

Expected: all statements are backed by current commands/output.

---

## Separate post-migration operator action: legacy Hermes profile copies

Do not bundle this into normal setup. First inventory every profile-local `ebb-*` directory under the active `HERMES_HOME`, compare names/content, and present the exact delete list. Only after explicit approval may those stale copies be removed. The repository migration is functionally complete without this cleanup because trusted project skills have higher precedence inside Ebb Orchestrator.
