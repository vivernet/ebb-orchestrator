# Hermes Development Capabilities and Inception Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reproducible project-local Hermes skill/capability registry and an explicit Inception Labs provider profile, with safe setup/check commands and complete Russian documentation.

**Architecture:** `tools/hermes` remains the repository source of truth. The existing setup script synchronizes skills and non-secret provider templates into the selected `HERMES_HOME`; provider selection is explicit and development-only. Production runtime configuration remains unchanged unless a future approved plan introduces a runtime provider contract.

**Tech Stack:** Node.js ESM, pnpm, Hermes CLI, YAML/Markdown, Vitest, ESLint, TypeScript.

**Spec:** `docs/superpowers/specs/2026-09-21-hermes-development-capabilities-and-inception-provider.md`

## Global Constraints

- Never commit or print API keys, tokens, or secret values.
- Keep Hermes delegation at no more than 2 concurrent children and depth 1.
- Do not remove `.opencode` until Stage 9 parity has a successful provider-backed run.
- Do not change production runtime provider behavior in this plan.
- All new project-facing documentation and comments are in Russian; technical identifiers remain unchanged.
- Preserve existing unrelated working-tree changes.

## Review Focus

- A changed installed skill must fail hash verification; cover in setup/check tests.
- Provider setup must not accept arbitrary provider names or write secrets; cover command validation and redacted output.
- A path outside the worktree must fail closed; cover setup/execute path handling.
- Existing setup without provider selection must remain compatible; cover legacy setup flow.
- Documentation must enumerate every canonical skill and capability; cover a deterministic registry/documentation check.

---

### Task 1: Add canonical capability and provider registries

**Files:**
- Create: `tools/hermes/capabilities.yaml`
- Create: `tools/hermes/providers/inception.yaml`
- Create: `tools/hermes/skills/ebb-security-review/SKILL.md`
- Create: `tools/hermes/skills/ebb-web-e2e/SKILL.md`
- Create: `tools/hermes/skills/ebb-provider-integration/SKILL.md`
- Create: `tools/hermes/skills/ebb-repository-context/SKILL.md`
- Create: `tools/hermes/skills/ebb-quality-gates/SKILL.md`
- Test: `scripts/hermes-dev.test.mjs`

**Interfaces:**
- `capabilities.yaml` exposes nine named project capabilities and their allowed scope.
- `providers/inception.yaml` exposes `name`, `provider`, `api`, `model`, `key_env`.
- Each new `SKILL.md` uses valid frontmatter with `name` and a trigger-only description.

- [ ] **Step 1: Write failing validation tests** for registry names, provider fields, skill frontmatter, secret absence, and documentation coverage.
- [ ] **Step 2: Run `node --test scripts/hermes-dev.test.mjs`** and confirm the new files/validators are missing.
- [ ] **Step 3: Add the registries and five focused skills** with minimal process-specific instructions and no duplicated AGENTS policy.
- [ ] **Step 4: Run the focused test** and verify it passes.
- [ ] **Step 5: Run `git diff --check`** and inspect only Task 1 files.

### Task 2: Extend Hermes setup/check/provider commands

**Files:**
- Modify: `scripts/hermes-dev.mjs`
- Modify: `package.json`
- Modify: `tools/hermes/README.md`
- Modify: `docs/development/hermes.md`
- Test: `scripts/hermes-dev.test.mjs`

**Interfaces:**
- `pnpm hermes:setup` synchronizes all skill directories and provider templates.
- `pnpm hermes:check` validates source/target hashes, registries and supported config.
- `pnpm hermes:provider -- inception` configures only the named profile and uses `INCEPTION_API_KEY` via `key_env`.

- [ ] **Step 1: Add failing tests** for provider command parsing, unsupported provider rejection, isolated target copy, and redacted output.
- [ ] **Step 2: Run focused tests** to confirm failure.
- [ ] **Step 3: Implement deterministic setup/check/provider helpers** using `shell:false`, explicit allowlists, and no secret reads beyond key name metadata.
- [ ] **Step 4: Run `pnpm hermes:setup` and `pnpm hermes:check`** against a temporary `HERMES_HOME`, then run the focused tests.
- [ ] **Step 5: Verify legacy `pnpm hermes:execute -- <plan>` validation still rejects missing/out-of-worktree plans.

### Task 3: Document every installed capability and provider

**Files:**
- Modify: `README.md`
- Modify: `tools/hermes/README.md`
- Modify: `docs/development/hermes.md`
- Create: `docs/development/hermes-capabilities.md`

**Interfaces:**
- README has one entry per skill, capability and provider profile.
- Documentation states source path, installed path, exact setup/check/provider commands, and secret boundary.
- Official Inception links are included without embedding credentials.

- [ ] **Step 1: Add a documentation coverage check** that reads the canonical registry and README markers.
- [ ] **Step 2: Run it against the current README** and confirm missing entries.
- [ ] **Step 3: Add Russian documentation with exact paths and commands.**
- [ ] **Step 4: Run the coverage check and inspect rendered Markdown structure.**

### Task 4: Validate the complete change

**Files:**
- Modify: `docs/audit/PROJECT_STATE.md`

- [ ] **Step 1: Run `pnpm lint`.**
- [ ] **Step 2: Run `pnpm typecheck`.**
- [ ] **Step 3: Run `pnpm test`.**
- [ ] **Step 4: Run `pnpm server:build` and `pnpm web:build`.**
- [ ] **Step 5: Run `git diff --check` and `git status --short`; confirm no generated artifacts or secrets are tracked.**
- [ ] **Step 6: Update project state with exact evidence and remaining Stage 9 provider-credential limitation.**
