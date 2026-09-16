# Orchestrator Git, Execution & Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить реальные Git/worktree operations, controlled execution, Permission Engine и security boundaries так, чтобы deterministic workflow мог безопасно работать с локальным repository без Hermes.

**Architecture:** Git Manager и Local Execution являются adapters за typed services. Любое действие агента в будущем проходит `RunCapability → ActionGateway → PermissionEngine → controlled executor`; GitHub credentials и SecretStore не доступны через этот путь.

**Tech Stack:** Node.js 24 `child_process.spawn`; native Git CLI; TypeScript; Vitest; SQLite.

**Spec:** `docs/superpowers/specs/2026-09-16-local-ai-development-orchestrator-design.md`

## Global Constraints

- Никогда не выполнять Git/command через `shell: true` по умолчанию.
- Worktree path всегда назначается Orchestrator, не передаётся агентом.
- `master` — fixture default branch, но production branch берётся из Project config.
- Final merge исполняется только Merge Service после approval.
- Git hooks отключены для managed Git operations по умолчанию.
- Local Mode — policy isolation, не OS sandbox; это должно быть отражено в API/UI metadata.

---

### Task 1: Safe process executor and Git command adapter

**Files:**
- Create: `apps/server/src/platform/process/process-executor.ts`
- Create: `apps/server/src/modules/git/git-cli.ts`
- Test: `apps/server/test/modules/git/git-cli.test.ts`

**Interfaces:**
- Produces: `ProcessExecutor.exec(file, args, options)`.
- Produces: `GitCli.run(repoPath, args)` with `shell:false`, timeout, stdout/stderr capture.

- [ ] **Step 1: Write argument-safety test**

Pass a branch name containing shell metacharacters and assert it is treated as a literal argument; no side-effect file is created.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- git-cli.test.ts
```

- [ ] **Step 3: Implement executor**

Use `spawn(file, args, { shell: false, cwd, env, windowsHide: true })`, bounded output buffers and explicit cancellation via `AbortSignal`.

- [ ] **Step 4: Run tests on current platform**

```bash
pnpm --filter @orchestrator/server test -- git-cli.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/platform/process/process-executor.ts apps/server/src/modules/git/git-cli.ts apps/server/test/modules/git
git commit -m "feat: add safe process and git executor"
```

---

### Task 2: Repository discovery and onboarding facts

**Files:**
- Create: `apps/server/src/modules/projects/repository-discovery.ts`
- Create: `apps/server/src/modules/projects/onboarding-service.ts`
- Test: `apps/server/test/modules/projects/repository-discovery.test.ts`

**Interfaces:**
- Produces: `RepositoryFacts { root, defaultBranch, remotes, packageManager, languageHints, testCommands }`.
- Produces: detected facts separately from proposed policy fields.

- [ ] **Step 1: Write fixture discovery test**

Create temp repo with `master`, `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, GitHub remote. Assert all are DETECTED and workflow/permission recommendations are absent from facts.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- repository-discovery.test.ts
```

- [ ] **Step 3: Implement deterministic discovery**

Use Git commands + filesystem checks only. Do not run package scripts. Existing `.orchestrator/` is reported as `untrustedExistingConfig` until explicit import approval.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- repository-discovery.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/projects apps/server/test/modules/projects
git commit -m "feat: add deterministic repository discovery"
```

---

### Task 3: Branch/worktree manager and GitOperation journal

**Files:**
- Create: `apps/server/src/modules/git/git-types.ts`
- Create: `apps/server/src/modules/git/git-operation-repository.ts`
- Create: `apps/server/src/modules/git/worktree-manager.ts`
- Create: `apps/server/src/modules/git/branch-manager.ts`
- Create: `apps/server/src/platform/database/migrations/007_git.sql`
- Test: `apps/server/test/modules/git/worktree-manager.test.ts`

**Interfaces:**
- Produces: `createTaskWorkspace(task, targetRef)`, `createEpicBranch(epic, baseRef)`, `removeWorkspace(worktreeId)`.
- Persists GitOperation `STARTED → VERIFIED`.

- [ ] **Step 1: Write real temp-repo tests**

Assert:

```text
standalone task branches from current master
Epic child branches from current epic branch
managed worktree appears outside source repo in ORCHESTRATOR_HOME/worktrees
failed verification leaves GitOperation STARTED for reconciliation
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- worktree-manager.test.ts
```

- [ ] **Step 3: Implement journalled operations**

Before Git mutation insert operation row; after command inspect actual Git state and only then mark `VERIFIED`. Set hooks path to a managed empty hooks directory for Orchestrator Git commands.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- worktree-manager.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/git apps/server/src/platform/database/migrations/007_git.sql apps/server/test/modules/git
git commit -m "feat: add managed branches and worktrees"
```

---

### Task 4: Integration workspace, current-target merge and Merge Service

**Files:**
- Create: `apps/server/src/modules/git/integration-service.ts`
- Create: `apps/server/src/modules/git/merge-service.ts`
- Test: `apps/server/test/modules/git/integration-service.test.ts`

**Interfaces:**
- Produces: `prepareIntegration(sourceBranch, currentTargetBranch): IntegrationAttempt`.
- Produces: `MergeService.mergeApproved(subjectId, approvalId)`.

- [ ] **Step 1: Write moving-target test**

Create Task-2 from Epic SHA A, integrate Task-1 so Epic becomes B, then prepare Task-2 integration. Assert integration base is B, not A.

Also assert MergeService refuses without approved `FINAL_MERGE`.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- integration-service.test.ts
```

- [ ] **Step 3: Implement integration branch/worktree**

Use temporary `integration/task-<n>` or `integration/epic-<n>` branch. Never experiment in task worktree or `master`. Conflict result records file list and deterministic class candidate; semantic classification comes later via Integration role.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- integration-service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/git apps/server/test/modules/git/integration-service.test.ts
git commit -m "feat: add isolated integration and merge service"
```

---

### Task 5: Permission Engine and policy composition

**Files:**
- Create: `apps/server/src/modules/permissions/permission-types.ts`
- Create: `apps/server/src/modules/permissions/permission-policy.ts`
- Create: `apps/server/src/modules/permissions/permission-engine.ts`
- Test: `apps/server/test/modules/permissions/permission-engine.test.ts`

**Interfaces:**
- Produces: `PermissionDecision = ALLOW | ASK | DENY | ABSOLUTE_DENY`.
- Produces: `evaluate({ capability, action, globalPolicy, projectPolicy, rolePolicy, taskPolicy })`.

- [ ] **Step 1: Write table-driven tests**

At minimum:

```text
Developer workspace.read ALLOW
Developer git.commit ALLOW
Developer git.push DENY
Developer merge.default ABSOLUTE_DENY
Reviewer workspace.write DENY
DevOps publish ASK
Global DENY + Task ALLOW => DENY
ABSOLUTE_DENY cannot be weakened by more specific scope
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- permission-engine.test.ts
```

- [ ] **Step 3: Implement most-restrictive composition**

Encode ordering:

```ts
const rank = { ALLOW: 0, ASK: 1, DENY: 2, ABSOLUTE_DENY: 3 } as const;
```

Return reason + matched policy refs for UI/Audit.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- permission-engine.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/permissions apps/server/test/modules/permissions
git commit -m "feat: add composable permission engine"
```

---

### Task 6: RunCapability and Action Gateway with path confinement

**Files:**
- Create: `apps/server/src/modules/execution/run-capability.ts`
- Create: `apps/server/src/modules/execution/action-gateway.ts`
- Create: `apps/server/src/modules/execution/workspace-tools.ts`
- Create: `apps/server/src/platform/security/path-resolver.ts`
- Test: `apps/server/test/modules/execution/action-gateway.test.ts`
- Test: `apps/server/test/platform/security/path-resolver.test.ts`

**Interfaces:**
- Produces: capability-bound `workspace.read/search/patch`.
- Agent-facing request never accepts arbitrary workspace root.

- [ ] **Step 1: Write traversal and symlink/junction tests**

Assert `../`, absolute external path and symlink/junction resolving outside workspace are denied before file access.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- action-gateway.test.ts path-resolver.test.ts
```

- [ ] **Step 3: Implement canonical containment check**

Resolve existing ancestor realpaths and target path; compare path segments, not string prefix. Audit every DENY/ASK without storing file contents.

- [ ] **Step 4: Run tests on Windows and one Unix CI runner before merge**

```bash
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/execution apps/server/src/platform/security apps/server/test/modules/execution apps/server/test/platform/security
git commit -m "feat: add capability-bound action gateway"
```

---

### Task 7: Controlled command/project actions and environment isolation

**Files:**
- Create: `apps/server/src/modules/execution/command-tools.ts`
- Create: `apps/server/src/modules/execution/project-actions.ts`
- Create: `apps/server/src/platform/security/environment-builder.ts`
- Test: `apps/server/test/modules/execution/command-tools.test.ts`
- Test: `apps/server/test/platform/security/environment-builder.test.ts`

**Interfaces:**
- Produces: `command.exec({ executable, args })`; no raw shell syntax.
- Produces: typed `project.test/lint/typecheck/build` mapping from approved project config.

- [ ] **Step 1: Write environment leakage test**

Set parent process env with `TEST_SECRET_SUPER_UNIQUE_123`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`; assert child env omits all unless a specific scoped injection is configured.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- command-tools.test.ts environment-builder.test.ts
```

- [ ] **Step 3: Implement minimal env and shell classification**

Treat executables `bash`, `sh`, `zsh`, `cmd`, `powershell`, `pwsh` as `SHELL_EXECUTION` requiring separate permission. Known project actions are policy-known, not automatically security-safe.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- command-tools.test.ts environment-builder.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/execution apps/server/src/platform/security apps/server/test/modules/execution apps/server/test/platform/security
git commit -m "feat: add controlled local command execution"
```

---

### Task 8: Git reconciliation, drift states and startup recovery

**Files:**
- Create: `apps/server/src/modules/git/git-reconciler.ts`
- Modify: `apps/server/src/platform/process/startup-reconciler.ts`
- Test: `apps/server/test/modules/git/git-reconciler.test.ts`

**Interfaces:**
- Produces: `IN_SYNC | LOCAL_AHEAD | REMOTE_AHEAD | DIVERGED | BRANCH_MISSING | WORKTREE_MISSING | UNCOMMITTED_CHANGES`.

- [ ] **Step 1: Write drift/restart tests**

Create unfinished `GitOperation`, manually mutate HEAD/delete worktree, restart reconciler and assert observed state is recorded without blindly mutating Git.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- git-reconciler.test.ts
```

- [ ] **Step 3: Implement reconciliation**

Recovery may complete an operation only when actual Git state proves the intended effect occurred. Ambiguous state produces `GIT_STATE_DRIFT` and blocks relevant work.

- [ ] **Step 4: Run full Plan 3 suite**

```bash
pnpm typecheck
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/git apps/server/src/platform/process/startup-reconciler.ts apps/server/test/modules/git
git commit -m "feat: reconcile git state after interruptions"
```

## Plan 3 acceptance gate

Using a temporary repository with `master`:

- create Epic/Task branches and worktrees from correct current targets;
- execute safe filesystem and Git actions only through Action Gateway;
- deny path escapes, raw final merge, push and policy modification for Developer capability;
- final Merge Service refuses without approval;
- crash between Git mutation and DB verification is recoverable;
- malicious repo text/scripts do not grant authority; Local Mode warning remains true because arbitrary approved project processes still have OS user privileges.
