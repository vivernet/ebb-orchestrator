# Orchestrator Web UI, GitHub & v1 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Довести backend до управляемого через Web UI продукта, добавить optional GitHub integration, secure secret storage, diagnostics/backup/migrations и пройти два утверждённых v1 acceptance scenarios.

**Architecture:** Web UI читает read-model projections через HTTP и live events через SSE; commands идут обычными authenticated HTTP requests. GitHub реализует `GitHosting` port и никогда не становится источником истины workflow. Secrets хранятся в OS credential store через adapter.

**Tech Stack:** React 19.3; React Router 7.18; Vite 8.1 + `@vitejs/plugin-react` 6.1; TypeScript 7; Fastify; SSE; Zod; `@napi-rs/keyring`; GitHub REST/GitHub App installation auth; Vitest; Testing Library; Playwright 1.63 for UI smoke/E2E.

**Spec:** `docs/superpowers/specs/2026-09-16-local-ai-development-orchestrator-design.md`

## Global Constraints

- UI не рендерит repository/agent HTML как trusted HTML; Markdown sanitizes strictly.
- Mutating API endpoints require local session auth + valid Origin/CSRF protection.
- GitHub outage never blocks local Development/Review/QA/Integration.
- GitHub sync v1 = polling + manual Sync Now; no webhooks.
- GitHub token/private key never enters Hermes environment or prompt.
- Final merge default remains manual approval.
- Container Mode, multi-user/RBAC, GitLab/Jira/Linear and distributed workers remain out of scope.

---

### Task 1: Read models and HTTP API surface

**Files:**
- Create: `apps/server/src/app/read-models/dashboard-projection.ts`
- Create: `apps/server/src/app/read-models/project-projection.ts`
- Create: `apps/server/src/app/read-models/epic-projection.ts`
- Create: `apps/server/src/app/read-models/task-projection.ts`
- Create: `apps/server/src/app/read-models/execution-projection.ts`
- Create: `apps/server/src/app/routes/projects.ts`
- Create: `apps/server/src/app/routes/work.ts`
- Create: `apps/server/src/app/routes/approvals.ts`
- Create: `apps/server/src/app/routes/runs.ts`
- Create: `packages/contracts/src/api.ts`
- Test: `apps/server/test/app/api.test.ts`

**Interfaces:**
- Produces typed JSON endpoints under `/api/v1` and read-only projections allowed to join module-owned tables.

- [ ] **Step 1: Write API contract tests**

At minimum assert:

```text
GET /dashboard
GET /projects/:id
GET /epics/:id
GET /tasks/:id
GET /execution
GET /approvals
POST /approvals/:id/approve
POST /tasks/:id/pause
POST /runs/:id/cancel
```

Mutating requests without local session/CSRF token fail.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- api.test.ts
```

- [ ] **Step 3: Implement projections and thin controllers**

Controllers call application services only; no direct domain writes in route handlers. Return exact wait/block reasons, active agents and usage summaries required by approved UI.

- [ ] **Step 4: Run API tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- api.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/app packages/contracts/src/api.ts apps/server/test/app/api.test.ts
git commit -m "feat: expose orchestrator api and read models"
```

---

### Task 2: React/Vite shell, routing and secure API client

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app/App.tsx`
- Create: `apps/web/src/app/router.tsx`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/api/events.ts`
- Create: `apps/web/src/components/AppShell.tsx`
- Create: `apps/web/src/styles/base.css`
- Test: `apps/web/test/app-shell.test.tsx`

**Interfaces:**
- Produces routes `/`, `/projects/:id`, `/epics/:id`, `/tasks/:id`, `/approvals`, `/execution`, `/runs/:id`, `/usage`, `/settings`, `/projects/new`.

- [ ] **Step 1: Write shell navigation test**

Render app with mocked API and assert persistent left navigation includes Dashboard, Projects, Approvals, Execution, Usage, Settings.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/web test -- app-shell.test.tsx
```

- [ ] **Step 3: Add the web package and implement app shell/authenticated client**

`apps/web/package.json` must include the exact baseline dependencies and scripts:

```json
{
  "name": "@ebb-orchestrator/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ebb-orchestrator/contracts": "workspace:*",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "react-router": "^7.18.3",
    "zod": "^4.6.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.3.3",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.1",
    "jsdom": "^30.0.1",
    "vite": "^8.1.0",
    "vitest": "^5.0.0"
  }
}
```

`apps/web/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: [],
  },
});
```

Bootstrap the local session from the server-provided same-origin endpoint; keep the token in memory, never `localStorage`. Route with `react-router`; SSE reconnect must trigger a projection refetch so missed ephemeral events cannot leave stale UI state.

- [ ] **Step 4: Run web tests/build**

```bash
pnpm --filter @ebb-orchestrator/web test
pnpm --filter @ebb-orchestrator/web build
```

- [ ] **Step 5: Commit**

```bash
git add apps/web package.json pnpm-workspace.yaml
git commit -m "feat: add orchestrator web application shell"
```

---

### Task 3: Dashboard, Project, Epic and Task views

**Files:**
- Create: `apps/web/src/features/dashboard/DashboardPage.tsx`
- Create: `apps/web/src/features/projects/ProjectPage.tsx`
- Create: `apps/web/src/features/epics/EpicPage.tsx`
- Create: `apps/web/src/features/tasks/TaskPage.tsx`
- Create: `apps/web/src/components/StatusBadge.tsx`
- Create: `apps/web/src/components/WorkflowTimeline.tsx`
- Test: `apps/web/test/core-views.test.tsx`

**Interfaces:**
- Implements approved UI information architecture from Appendix A.

- [ ] **Step 1: Write content tests from approved mockups**

Dashboard must expose Running agents, Active work, Need approval, AI spend, active projects, queue and Coordinator entry. Task view must expose contract, workflow, Agent Runs, findings/defects, Git state, recovery and usage.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/web test -- core-views.test.tsx
```

- [ ] **Step 3: Implement views with real projections**

Preserve dark visual language from approved concepts, but prioritize semantic HTML and responsive layout. Do not add new UX concepts not present in approved IA.

- [ ] **Step 4: Run tests and production build**

```bash
pnpm --filter @ebb-orchestrator/web test -- core-views.test.tsx
pnpm --filter @ebb-orchestrator/web build
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features apps/web/src/components apps/web/test/core-views.test.tsx
git commit -m "feat: add dashboard project epic and task views"
```

---

### Task 4: Approval Inbox, Execution monitor and Agent Run detail

**Files:**
- Create: `apps/web/src/features/approvals/ApprovalInboxPage.tsx`
- Create: `apps/web/src/features/execution/ExecutionPage.tsx`
- Create: `apps/web/src/features/runs/AgentRunPage.tsx`
- Create: `apps/web/src/components/SanitizedTerminal.tsx`
- Test: `apps/web/test/operations-views.test.tsx`

**Interfaces:**
- Approval actions: approve/reject/request changes; permission ASK supports once/run/task/project where policy allows.

- [ ] **Step 1: Write security/rendering tests**

Agent text `<img onerror=...>` renders as text, not DOM node. ANSI/OSC terminal sequences outside allowlist are stripped. Queue row must show exact wait reason.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/web test -- operations-views.test.tsx
```

- [ ] **Step 3: Implement operational views**

Run page shows observable actions/results, permissions, usage, context manifest, recovery signals and artifacts; never exposes hidden chain-of-thought as a UI concept.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ebb-orchestrator/web test -- operations-views.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/approvals apps/web/src/features/execution apps/web/src/features/runs apps/web/src/components/SanitizedTerminal.tsx apps/web/test/operations-views.test.tsx
git commit -m "feat: add approvals execution and run monitoring"
```

---

### Task 5: Project onboarding, Settings and Usage/Budget UI

**Files:**
- Create: `apps/web/src/features/onboarding/ProjectOnboardingPage.tsx`
- Create: `apps/web/src/features/settings/SettingsPage.tsx`
- Create: `apps/web/src/features/usage/UsagePage.tsx`
- Create: `apps/server/src/app/routes/settings.ts`
- Create: `apps/server/src/app/routes/onboarding.ts`
- Test: `apps/web/test/configuration-views.test.tsx`

**Interfaces:**
- Onboarding steps: Repository → Discovery → Review findings → Approve config → Activate.
- Settings sections match approved mockup hierarchy.

- [ ] **Step 1: Write DETECTED vs PROPOSED onboarding test**

Detected default branch/package manager must render separately from Coordinator proposals; activation button cannot proceed with unresolved semantic config approval.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/web test -- configuration-views.test.tsx
```

- [ ] **Step 3: Implement configuration forms**

Settings show effective hierarchy Global → Project → Role → Task/Epic and distinguish security most-restrictive behavior. Local Mode warning is visible for untrusted code execution.

- [ ] **Step 4: Run tests/build**

```bash
pnpm --filter @ebb-orchestrator/web test
pnpm --filter @ebb-orchestrator/web build
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/onboarding apps/web/src/features/settings apps/web/src/features/usage apps/server/src/app/routes/settings.ts apps/server/src/app/routes/onboarding.ts apps/web/test/configuration-views.test.tsx
git commit -m "feat: add onboarding settings and usage views"
```

---

### Task 6: OS SecretStore adapter and diagnostics redaction

**Files:**
- Create: `apps/server/src/platform/security/secret-store.ts`
- Create: `apps/server/src/platform/security/keyring-secret-store.ts`
- Create: `apps/server/src/platform/security/secret-redactor.ts`
- Create: `apps/server/src/app/routes/secrets.ts`
- Test: `apps/server/test/platform/security/secret-store.test.ts`
- Test: `apps/server/test/platform/security/redaction.test.ts`

**Interfaces:**
- Produces: `SecretStore.store/resolveForService/revoke/listMetadata`.
- Production adapter uses `@napi-rs/keyring`; tests use in-memory adapter.

- [ ] **Step 1: Write no-plaintext tests**

Store unique secret and assert it does not appear in SQLite dump, logs, artifact metadata, diagnostics JSON or AgentRun environment.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- secret-store.test.ts redaction.test.ts
```

- [ ] **Step 3: Implement keyring adapter and exact-value redactor**

SQLite persists only secret metadata/reference IDs. Secret retrieval requires named service purpose. No API endpoint returns secret plaintext after storage.

- [ ] **Step 4: Run tests on Windows plus one Unix CI runner**

```bash
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/platform/security apps/server/src/app/routes/secrets.ts apps/server/test/platform/security package.json pnpm-lock.yaml
git commit -m "feat: store credentials in os keyring"
```

---

### Task 7: GitHosting port and GitHub App installation adapter

**Files:**
- Create: `apps/server/src/modules/github/git-hosting.ts`
- Create: `apps/server/src/modules/github/github-app-token-provider.ts`
- Create: `apps/server/src/modules/github/github-adapter.ts`
- Create: `apps/server/src/modules/github/github-sync-service.ts`
- Create: `apps/server/src/platform/database/migrations/013_github.sql`
- Test: `apps/server/test/modules/github/github-adapter.test.ts`

**Interfaces:**
- Produces: `GitHosting` methods for Issue import, push coordination, PR create/update, PR merge, comments/review publishing later-safe.
- Auth uses GitHub App app ID/private key/installation ID from SecretStore; installation tokens are short-lived and cached only in memory until expiry.

- [ ] **Step 1: Write fake-GitHub HTTP tests**

Assert expired installation token triggers refresh; 401 -> `BLOCKED_AUTH`, 403 -> `BLOCKED_PERMISSION`, rate limit -> retry at reset, timeout -> transient retry. Token length/prefix is never assumed.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- github-adapter.test.ts
```

- [ ] **Step 3: Implement REST adapter and token provider**

Generate GitHub App JWT only inside token provider, exchange for installation access token, request repository-scoped permissions. Keep private key in SecretStore. Hermes receives none of these values.

- [ ] **Step 4: Run adapter tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- github-adapter.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/github apps/server/src/platform/database/migrations/013_github.sql apps/server/test/modules/github
git commit -m "feat: add optional github app adapter"
```

---

### Task 8: Polling sync, manual Sync Now and offline queue

**Files:**
- Create: `apps/server/src/modules/github/github-sync-worker.ts`
- Create: `apps/server/src/app/routes/github.ts`
- Test: `apps/server/test/modules/github/github-sync-worker.test.ts`

**Interfaces:**
- Produces `SYNC_PENDING`, inbound `HumanFeedback`, outbound dedupe markers, manual sync endpoint.

- [ ] **Step 1: Write offline/idempotency test**

Simulate PR create success followed by process crash before job acknowledgement. On restart worker queries external state and marks existing PR success rather than creating another.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- github-sync-worker.test.ts
```

- [ ] **Step 3: Implement polling worker**

Outbound objects carry Orchestrator marker to avoid feedback loops. GitHub Issue closure never directly marks Task DONE; it creates reconciliation input/HumanFeedback when semantically relevant.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- github-sync-worker.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/github apps/server/src/app/routes/github.ts apps/server/test/modules/github
git commit -m "feat: add resilient github polling sync"
```

---

### Task 9: Backup, migration compatibility and diagnostics export

**Files:**
- Create: `apps/server/src/platform/database/backup-service.ts`
- Create: `apps/server/src/platform/database/config-migrator.ts`
- Create: `apps/server/src/platform/diagnostics/diagnostics-service.ts`
- Create: `apps/server/src/app/routes/diagnostics.ts`
- Test: `apps/server/test/platform/database/backup.test.ts`
- Test: `apps/server/test/platform/diagnostics/diagnostics.test.ts`

**Interfaces:**
- Produces backup before DB schema upgrade; project config compatibility range; sanitized diagnostics archive.

- [ ] **Step 1: Write migration/backup tests**

Open old fixture DB/config, create backup, migrate to latest, run integrity/foreign-key checks. Config newer than supported fails closed; ambiguous semantic config migration returns `USER_DECISION_REQUIRED`.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- backup.test.ts diagnostics.test.ts
```

- [ ] **Step 3: Implement backup/diagnostics**

Diagnostics includes app/schema versions, migration history, worker health, pending outbox/dead-letter, stale locks and sanitized recent errors; excludes secret values and raw sensitive environment.

- [ ] **Step 4: Run migration matrix**

```bash
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/platform/database apps/server/src/platform/diagnostics apps/server/src/app/routes/diagnostics.ts apps/server/test/platform
git commit -m "feat: add backup migration and diagnostics tooling"
```

---

### Task 10: Final v1 acceptance and crash/security matrix

**Files:**
- Create: `apps/server/test/e2e/v1-autonomous-task.test.ts`
- Create: `apps/server/test/e2e/v1-epic.test.ts`
- Create: `apps/server/test/e2e/v1-crash-matrix.test.ts`
- Create: `apps/server/test/e2e/v1-security.test.ts`
- Create: `apps/web/test/e2e/v1-ui.spec.ts`
- Create: `apps/web/playwright.config.ts`
- Modify: `apps/web/package.json`
- Modify: CI workflow files chosen for the repository.

**Interfaces:**
- No new product API; this is the v1 release gate.

- [ ] **Step 1: Add Playwright release-test wiring and implement Autonomous Task acceptance test**

Add to `apps/web/package.json`:

```json
{
  "scripts": {
    "test:e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.63.0"
  }
}
```

`apps/web/playwright.config.ts` must start the local server/web app through `webServer`, use Chromium for the mandatory CI smoke path, and keep retries at `0` locally so flakes are visible.

Request/Task: `Add /health endpoint returning {status:'ok'}`. Assert managed worktree, real Dev/Review/QA/Integration, manual merge approval, `master` result, cleanup, audit and usage. The UI E2E must create/select the fixture project, open the Task, observe the workflow stages, approve final merge, and assert the resulting DONE state.

- [ ] **Step 2: Implement Epic acceptance test**

Request: provider-like feature with normal + streaming support. Assert Coordinator plan approval, dependency-aware parallel Tasks, Task integrations into Epic branch, Epic Review/QA/final integration and manual merge.

- [ ] **Step 3: Add failpoint crash matrix**

Force crashes after branch create, DB commit, event dispatch before ack, budget reserve, run start and GitHub PR create. After restart assert no lost committed code, duplicate merge/PR, stale lock or forever-RUNNING Run.

- [ ] **Step 4: Run release gate**

Deterministic CI:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @ebb-orchestrator/web build
pnpm --filter @ebb-orchestrator/web test:e2e
```

Opt-in real Hermes acceptance:

```bash
RUN_HERMES_E2E=1 pnpm --filter @ebb-orchestrator/server test -- v1-autonomous-task.test.ts v1-epic.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/test/e2e apps/web/test/e2e apps/web/playwright.config.ts apps/web/package.json .github
git commit -m "test: add orchestrator v1 release acceptance suite"
```

## Plan 6 / v1 release gate

v1 is releasable only when:

- Web UI supports all approved top-level screens without CLI dependence;
- autonomous Task and Epic acceptance tests pass;
- kill/restart recovery passes failpoint matrix;
- GitHub can be entirely disabled and all local workflows still pass;
- credentials remain in OS keyring and never appear in Hermes context/logs;
- final merge into configured default branch requires explicit user approval;
- deterministic CI uses zero AI tokens;
- real Hermes tests are opt-in release/eval gates, not ordinary unit CI.
