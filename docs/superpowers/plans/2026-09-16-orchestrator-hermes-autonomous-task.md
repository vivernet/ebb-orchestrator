# Orchestrator Hermes Runtime & Autonomous Task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подключить Hermes как единственный реальный AgentRuntime v1 и довести вручную созданную standalone Task через Developer → Reviewer → QA → Integration → manual final merge.

**Architecture:** Orchestrator создаёт изолированный `HERMES_HOME`, запускает Hermes в назначенном worktree и предоставляет единственный Orchestrator MCP toolset. Hermes завершает run через `submit_result`; backend не парсит свободный финальный текст как domain outcome.

**Tech Stack:** Hermes CLI; stdio MCP; TypeScript/Zod contracts; Node process adapter; existing Action Gateway/Git/Workflow modules.

**Spec:** `docs/superpowers/specs/2026-09-16-local-ai-development-orchestrator-design.md`

## Global Constraints

- Не использовать Hermes `--worktree`; worktree создаёт Orchestrator.
- Не использовать `--yolo` как способ авторизации действий.
- Hermes profile изолирован через `HERMES_HOME`; repository `AGENTS.md`/rules/memory не инжектируются автоматически.
- Hermes получает только `mcp-orchestrator` toolset, соответствующий RoleContract.
- `submit_result` — один финальный valid result на Run.
- Reviewer получает fresh session; Developer rework resume same task session; QA independent; Integration own session.
- GitHub credentials и реальные user HOME credentials не передаются Hermes subprocess.

---

### Task 1: Shared role/output contracts and semantic validators

**Files:**
- Create: `packages/contracts/src/roles/common.ts`
- Create: `packages/contracts/src/roles/developer.ts`
- Create: `packages/contracts/src/roles/reviewer.ts`
- Create: `packages/contracts/src/roles/qa.ts`
- Create: `packages/contracts/src/roles/integration.ts`
- Create: `apps/server/src/modules/runtime/output-validator.ts`
- Test: `apps/server/test/modules/runtime/output-validator.test.ts`

**Interfaces:**
- Produces: Zod schemas `DeveloperOutputSchema`, `ReviewerOutputSchema`, `QaOutputSchema`, `IntegrationOutputSchema`.
- Produces: `validateRoleOutput(role, value): ValidatedRoleOutput`.

- [ ] **Step 1: Write schema and semantic-invalid tests**

Examples that must fail:

```ts
validateRoleOutput("reviewer", {
  schema_version: 1,
  outcome: "PASS",
  findings: [{ ref: "finding_1", severity: "MAJOR", blocking: true, category: "CORRECTNESS", title: "x", description: "x", evidence: [] }],
  summary: "pass"
});
```

QA `PASS` with required AC `FAIL` must also fail.

- [ ] **Step 2: Verify tests fail**

```bash
pnpm --filter @orchestrator/server test -- output-validator.test.ts
```

- [ ] **Step 3: Implement compact versioned schemas**

Developer outcomes: `COMPLETED|BLOCKED`.
Reviewer: `PASS|CHANGES_REQUESTED|BLOCKED`.
QA: `PASS|FAIL|BLOCKED`.
Integration: `PASS|BLOCKED`.

Do not require taskId/runId/model in model output; backend already owns metadata.

- [ ] **Step 4: Run tests/typecheck**

```bash
pnpm --filter @orchestrator/server test -- output-validator.test.ts
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/roles apps/server/src/modules/runtime/output-validator.ts apps/server/test/modules/runtime/output-validator.test.ts
git commit -m "feat: add structured role output contracts"
```

---

### Task 2: RoleContract registry with tools, models, sessions and permissions

**Files:**
- Create: `apps/server/src/modules/runtime/role-contract.ts`
- Create: `apps/server/src/modules/runtime/role-registry.ts`
- Create: `apps/server/src/modules/runtime/default-roles.ts`
- Test: `apps/server/test/modules/runtime/role-registry.test.ts`

**Interfaces:**
- Produces: `RoleContract` for all 9 roles; only Developer/Reviewer/QA/Integration executed in this plan.

- [ ] **Step 1: Write contract snapshot tests**

Reviewer snapshot must not contain `workspace.patch`, `git.commit`, `command.shell`. Developer must not contain `git.push`, `merge.default`, permission/config mutation.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- role-registry.test.ts
```

- [ ] **Step 3: Implement role definitions**

Example:

```ts
{
  id: "reviewer",
  runtime: "hermes",
  modelConfigKey: "roles.reviewer.model",
  sessionPolicy: "fresh_per_task",
  tools: ["workspace.read", "workspace.search", "git.diff", "project.test", "submit_result"],
  outputSchema: ReviewerOutputSchema,
}
```

Do not hardcode actual model names in domain code; resolve from project/global config.

- [ ] **Step 4: Run snapshot tests**

```bash
pnpm --filter @orchestrator/server test -- role-registry.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/runtime apps/server/test/modules/runtime/role-registry.test.ts
git commit -m "feat: define role contracts and tool surfaces"
```

---

### Task 3: Orchestrator MCP stdio server and submit_result lifecycle

**Files:**
- Create: `apps/server/src/modules/execution/mcp/mcp-server.ts`
- Create: `apps/server/src/modules/execution/mcp/tool-registry.ts`
- Create: `apps/server/src/modules/execution/mcp/submit-result-tool.ts`
- Create: `apps/server/src/bin/orchestrator-mcp.ts`
- Test: `apps/server/test/modules/execution/mcp-server.test.ts`

**Interfaces:**
- Produces MCP tools mapped to Action Gateway using capability ID from process environment/argv.
- `submit_result(payload)` validates role schema and atomically sets run `COMPLETING`.

- [ ] **Step 1: Write MCP tool filtering tests**

Instantiate MCP server for Reviewer capability; assert tool list contains read/search/diff/test/submit only. Call `submit_result` twice; second call must fail `RUN_ALREADY_COMPLETING`.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- mcp-server.test.ts
```

- [ ] **Step 3: Implement stdio MCP bridge**

MCP handler must never trust task/workspace IDs from model payload. It resolves capability server-side and forwards typed calls to ActionGateway.

After a valid `submit_result`, block new write-capable tool calls for that Run.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- mcp-server.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/execution/mcp apps/server/src/bin/orchestrator-mcp.ts apps/server/test/modules/execution/mcp-server.test.ts
git commit -m "feat: expose capability-bound orchestrator mcp"
```

---

### Task 4: Isolated Hermes profile builder

**Files:**
- Create: `apps/server/src/modules/runtime/hermes/hermes-profile.ts`
- Create: `apps/server/src/modules/runtime/hermes/hermes-config.ts`
- Test: `apps/server/test/modules/runtime/hermes-profile.test.ts`

**Interfaces:**
- Produces: `prepareHermesProfile(run): HermesLaunchProfile { hermesHome, env, toolsetName }`.

- [ ] **Step 1: Write profile isolation test**

Assert generated environment:

```text
HERMES_HOME=<ORCHESTRATOR_HOME>/runtime/hermes
HOME=<HERMES_HOME>/home for tool subprocess isolation
no GITHUB_TOKEN
no SSH_AUTH_SOCK
no inherited personal Hermes profile
```

Generated `config.yaml` contains only Orchestrator-managed settings and MCP server definition whose command runs `orchestrator-mcp` with capability ref. `terminal.home_mode: profile`.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- hermes-profile.test.ts
```

- [ ] **Step 3: Implement profile builder**

Do not persist provider API keys into prompts. If Hermes itself requires a provider credential, inject only the credential needed by Hermes process from SecureStore integration stub, never into MCP child tools.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- hermes-profile.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/runtime/hermes apps/server/test/modules/runtime/hermes-profile.test.ts
git commit -m "feat: isolate hermes runtime profile"
```

---

### Task 5: HermesRuntimeAdapter start/resume/cancel/result collection

**Files:**
- Create: `apps/server/src/modules/runtime/hermes/hermes-cli.ts`
- Create: `apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts`
- Create: `apps/server/src/modules/runtime/hermes/hermes-session-parser.ts`
- Test: `apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts`

**Interfaces:**
- Implements `AgentRuntime`.
- Launch command shape for new run:

```text
hermes chat
  --query-file <prompt-file>
  --model <resolved-model>
  --toolsets mcp-orchestrator
  --in <managed-worktree>
  --ignore-rules
  --source tool
  --max-turns <role-limit>
```

- Resume adds `--resume <session-id>` and keeps `--in <managed-worktree>`.

- [ ] **Step 1: Write launch-argument tests with fake process executor**

Assert adapter never adds `--worktree` or `--yolo`; prompt body is written to a file and passed with `--query-file`, not interpolated into shell command.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- hermes-runtime-adapter.test.ts
```

- [ ] **Step 3: Implement adapter**

Capture session ID, process PID, stdout/stderr artifacts, exit code. A process exit without valid submitted result is `AGENT_OUTPUT_MISSING`, not success. Cancellation first sends graceful signal/checkpoint path, then hard kill after configured timeout.

- [ ] **Step 4: Run adapter contract suite against fake CLI**

```bash
pnpm --filter @orchestrator/server test -- hermes-runtime-adapter.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/runtime/hermes apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts
git commit -m "feat: add hermes runtime adapter"
```

---

### Task 6: Basic ContextPackage and prompt builder for execution roles

**Files:**
- Create: `apps/server/src/modules/context/context-types.ts`
- Create: `apps/server/src/modules/context/context-builder.ts`
- Create: `apps/server/src/modules/context/context-manifest.ts`
- Create: `apps/server/src/modules/runtime/prompt-builder.ts`
- Test: `apps/server/test/modules/context/context-builder.test.ts`

**Interfaces:**
- Produces: `ContextPackage` and `ContextManifest`.
- Developer package: Task Contract, relevant active findings/defects, target/workspace metadata, role contract summary, output instructions.
- Reviewer package: Task Contract, Git diff, checks, relevant constraints; no Developer conversation.

- [ ] **Step 1: Write role-separation tests**

Reviewer context must not contain Developer session transcript. Resolved finding is excluded. P0 Task Contract can never be pruned.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- context-builder.test.ts
```

- [ ] **Step 3: Implement P0–P3 budget pruning**

No LLM summarization. Source code is not bulk-loaded; Developer/Reviewer read on demand through tools. Persist manifest IDs/versions, not secrets.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- context-builder.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/context apps/server/src/modules/runtime/prompt-builder.ts apps/server/test/modules/context
git commit -m "feat: build role-specific run context"
```

---

### Task 7: Stable Reviewer findings and QA defects across re-runs

**Files:**
- Create: `apps/server/src/modules/work/findings-service.ts`
- Create: `apps/server/src/modules/work/defects-service.ts`
- Create: `apps/server/src/platform/database/migrations/008_quality.sql`
- Modify: `apps/server/src/modules/runtime/run-event-handlers.ts`
- Test: `apps/server/test/modules/work/quality-records.test.ts`

**Interfaces:**
- Produces stable DB IDs `FINDING-n` and `DEFECT-n` per project.
- Re-review accepts `finding_updates` against existing IDs.

- [ ] **Step 1: Write lifecycle tests**

Reviewer first output `finding_1` → persisted `FINDING-1`. Re-review marks same ID `RESOLVED`; no duplicate finding created. Equivalent QA defect lifecycle required.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- quality-records.test.ts
```

- [ ] **Step 3: Implement mapping and fingerprints**

Persist source run, severity, blocking, evidence, guideline ref, status. Generate Recovery fingerprint from stable ID + current evidence signature.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- quality-records.test.ts recovery.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/work apps/server/src/modules/runtime/run-event-handlers.ts apps/server/src/platform/database/migrations/008_quality.sql apps/server/test/modules/work
git commit -m "feat: persist stable review findings and qa defects"
```

---

### Task 8: First real Developer → Reviewer → QA → Integration vertical slice

**Files:**
- Create: `apps/server/test/e2e/fixtures/health-service/`
- Create: `apps/server/test/e2e/autonomous-task.hermes.test.ts`
- Modify: runtime handlers only where the E2E exposes missing wiring.

**Interfaces:**
- No new API; proves the vertical slice.

- [ ] **Step 1: Create the fixture repository and failing acceptance test**

Fixture has `master`, a tiny TypeScript HTTP service, working `pnpm test`, and no `/health` route. Test creates Task Contract:

```text
Goal: Add GET /health
AC: returns 200 and JSON {"status":"ok"}
Non-goal: no auth changes
```

- [ ] **Step 2: Run with real Hermes and expect first wiring failure**

```bash
RUN_HERMES_E2E=1 pnpm --filter @orchestrator/server test -- autonomous-task.hermes.test.ts
```

Do not weaken permissions to make it pass; fix adapter/tool/context wiring.

- [ ] **Step 3: Complete real stage wiring**

Expected sequence:

```text
managed worktree
→ Developer commit
→ independent Reviewer PASS
→ QA PASS with AC evidence
→ Integration against current master PASS
→ FINAL_MERGE approval pending
```

No merge yet.

- [ ] **Step 4: Approve final merge through ApprovalService and verify master**

The test programmatically acts as human approver, calls MergeService, then asserts `master` contains `/health`, Task `DONE`, worktree cleanup policy triggered, Audit/Usage placeholders recorded.

- [ ] **Step 5: Commit**

```bash
git add apps/server/test/e2e apps/server/src
git commit -m "feat: complete autonomous task vertical slice"
```

## Plan 4 acceptance gate

Required deterministic tests:

```bash
pnpm typecheck
pnpm test
```

Required opt-in real runtime smoke:

```bash
RUN_HERMES_E2E=1 pnpm --filter @orchestrator/server test -- autonomous-task.hermes.test.ts
```

The run must prove Hermes uses Orchestrator-managed worktree and MCP tools, no repository rules are auto-injected, no personal GitHub/SSH credentials are inherited, and final merge is impossible until explicit approval.
