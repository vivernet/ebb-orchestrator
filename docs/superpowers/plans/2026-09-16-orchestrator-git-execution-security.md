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
- Plan 2 must already be merged into the current base and the starting tree must pass `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
- Agent-facing Git/filesystem/command actions pass through Action Gateway; deterministic Orchestrator core services may use internal Git services directly.
- Reconciliation must not perform implicit network access (`git fetch`, push, remote auth). Remote state means currently known remote-tracking refs until an explicit hosting/sync operation updates them.

---

### Task 1: Safe process executor and Git command adapter

**Files:**
- Create: `apps/server/src/platform/process/process-executor.ts`
- Create: `apps/server/src/modules/git/git-cli.ts`
- Test: `apps/server/test/modules/git/git-cli.test.ts`

**Interfaces:**
- Produces: `ProcessExecutor.exec(file, args, options)`.
- Produces: `GitCli.run(repoPath, args)` with `shell:false`, timeout, stdout/stderr capture.

- [ ] **Step 1: Write executor safety tests**

Test `ProcessExecutor` directly with a harmless fixture process and a literal argument containing shell metacharacters; assert the argument reaches the child unchanged and no side-effect command/file is executed.

Also cover timeout, `AbortSignal` cancellation, non-zero exit capture, and bounded stdout/stderr behavior. `GitCli` tests must prove it delegates via `shell:false`.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- git-cli.test.ts
```

- [ ] **Step 3: Implement executor**

Use `spawn(file, args, { shell: false, cwd, env, windowsHide: true })`, bounded output buffers and explicit cancellation via `AbortSignal`.

- [ ] **Step 4: Run tests on current platform**

```bash
pnpm --filter @ebb-orchestrator/server test -- git-cli.test.ts
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
pnpm --filter @ebb-orchestrator/server test -- repository-discovery.test.ts
```

- [ ] **Step 3: Implement deterministic discovery**

Use Git commands + filesystem checks only. Do not run package scripts. Existing `.orchestrator/` is reported as `untrustedExistingConfig` until explicit import approval.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- repository-discovery.test.ts
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
- Migration `007_git.sql` also creates the persistence needed for first-class `MergeConflict` records used by Task 4.

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
pnpm --filter @ebb-orchestrator/server test -- worktree-manager.test.ts
```

- [ ] **Step 3: Implement journalled operations**

Before Git mutation insert operation row; after command inspect actual Git state and only then mark `VERIFIED`.

Disable repository hooks per managed Git invocation (for example with `git -c core.hooksPath=<managed-empty-hooks-dir> ...`) rather than permanently rewriting the user's repository config. Add a fixture hook that would create a marker file and prove managed commit/worktree operations do not execute it.

Retries after a crash must reconcile an existing STARTED operation instead of blindly creating duplicate branches/worktrees.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- worktree-manager.test.ts
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
- Create: `apps/server/src/modules/git/merge-conflict-repository.ts`
- Test: `apps/server/test/modules/git/integration-service.test.ts`
- Test: `apps/server/test/modules/git/merge-service.test.ts`

**Interfaces:**
- Produces: `prepareIntegration(sourceBranch, currentTargetBranch): IntegrationAttempt`.
- Produces: `MergeService.mergeApproved(subjectId, approvalId)`.

- [ ] **Step 1: Write moving-target test**

Create Task-2 from Epic SHA A, integrate Task-1 so Epic becomes B, then prepare Task-2 integration. Assert integration base is B, not A.

Also assert MergeService refuses when the approval is absent, rejected, the wrong approval type, or belongs to a different Task/Epic. An approved `FINAL_MERGE` is valid only for the exact subject being merged.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- integration-service.test.ts merge-service.test.ts
```

- [ ] **Step 3: Implement integration branch/worktree**

Use a temporary integration branch/worktree owned by the integration attempt. Never experiment in the Task worktree or `master`.

Persist each merge conflict as a first-class record with source, target, files, status, and nullable/pending classification. Deterministic classification may resolve only cases it can prove; semantic classification remains for the later Integration role.

`MergeService.mergeApproved(subjectId, approvalId)` must load the approval itself and verify: `type=FINAL_MERGE`, `status=APPROVED`, and `subjectId` matches exactly. After merge it verifies the resulting target SHA before recording completion.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- integration-service.test.ts merge-service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/git apps/server/test/modules/git
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
- Produces a typed/canonical `ActionId` set shared by Permission Engine and Action Gateway (including workspace, Git, command, merge, permission/config mutation actions).
- Produces: `evaluate({ capability, action, globalPolicy, projectPolicy, rolePolicy, taskPolicy })`.

- [ ] **Step 1: Write table-driven tests**

At minimum:

```text
Developer workspace.read ALLOW
Developer git.commit ALLOW
Developer git.push DENY
Developer merge.default ABSOLUTE_DENY
Developer permission.modify ABSOLUTE_DENY
Developer config.security.modify ABSOLUTE_DENY
Reviewer workspace.write DENY
DevOps publish ASK
Global DENY + Task ALLOW => DENY
ABSOLUTE_DENY cannot be weakened by more specific scope
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- permission-engine.test.ts
```

- [ ] **Step 3: Implement most-restrictive composition**

Encode ordering:

```ts
const rank = { ALLOW: 0, ASK: 1, DENY: 2, ABSOLUTE_DENY: 3 } as const;
```

Return reason + matched policy refs for UI/Audit. Unknown/unregistered Action IDs must fail closed rather than silently defaulting to ALLOW.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- permission-engine.test.ts
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
- Create: `apps/server/src/modules/execution/git-tools.ts`
- Create: `apps/server/src/platform/security/path-resolver.ts`
- Test: `apps/server/test/modules/execution/action-gateway.test.ts`
- Test: `apps/server/test/modules/execution/git-tools.test.ts`
- Test: `apps/server/test/platform/security/path-resolver.test.ts`

**Interfaces:**
- Produces: capability-bound `workspace.read/search/patch`.
- Produces agent-facing `git.status`, `git.diff`, and `git.commit`, always scoped to the capability-assigned worktree.
- `git.push`, final merge, permission mutation, and security/config mutation are denied/not exposed for Developer capability.
- Agent-facing request never accepts arbitrary workspace root.

- [ ] **Step 1: Write traversal and symlink/junction tests**

Assert `../`, absolute external path and a platform-appropriate link escape are denied before file access: directory junction on Windows, symlink on Unix. Tests must not require Windows Developer Mode merely to create a symlink.

Also assert agent-facing Git requests cannot supply a different repository/worktree path and that Developer cannot execute push/final merge/policy mutation through Action Gateway.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- action-gateway.test.ts git-tools.test.ts path-resolver.test.ts
```

- [ ] **Step 3: Implement canonical containment check**

Resolve existing ancestor realpaths and target path; compare path segments, not string prefix. Audit every DENY/ASK without storing file contents.

`git.status/diff/commit` resolve the repository from `RunCapability`, not from model input, and use the internal Git adapter with managed hooks disabled.

- [ ] **Step 4: Run the portable security tests on the current platform**

```bash
pnpm --filter @ebb-orchestrator/server test -- action-gateway.test.ts git-tools.test.ts path-resolver.test.ts
```

The suite must contain both Windows-junction and Unix-symlink branches so the same tests exercise the appropriate implementation when CI for the other OS is added later. Lack of Unix CI in Plan 3 must not block local completion; Plan 6 CI must run this suite on at least Windows and one Unix runner before v1 release.

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
pnpm --filter @ebb-orchestrator/server test -- command-tools.test.ts environment-builder.test.ts
```

- [ ] **Step 3: Implement allowlisted minimal env and shell classification**

Build child environments from a small platform baseline/allowlist plus explicitly scoped injected variables; do not clone `process.env` and then blacklist a few known names. Preserve only variables required to locate/launch approved executables on the current platform (for example PATH and required Windows runtime variables), plus explicit scoped additions.

Treat executables `bash`, `sh`, `zsh`, `cmd`, `powershell`, `pwsh` as `SHELL_EXECUTION` requiring separate permission. Known project actions are policy-known, not automatically security-safe.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- command-tools.test.ts environment-builder.test.ts
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
pnpm --filter @ebb-orchestrator/server test -- git-reconciler.test.ts
```

- [ ] **Step 3: Implement reconciliation**

Recovery may complete an operation only when actual Git state proves the intended effect occurred. Ambiguous state produces `GIT_STATE_DRIFT` and blocks relevant work.

Reconciliation is local-only: it may inspect existing remote-tracking refs but must not implicitly `fetch`, push, authenticate, or contact a remote. External refresh belongs to the later GitHosting/Sync subsystem.

- [ ] **Step 4: Run the pre-commit quality checks**

```bash
pnpm lint
pnpm typecheck
pnpm test
```

All three commands must pass before committing Task 8.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/git apps/server/src/platform/process/startup-reconciler.ts apps/server/test/modules/git
git commit -m "feat: reconcile git state after interruptions"
```

- [ ] **Step 6: Run the final clean-tree gate**

```bash
pnpm lint
pnpm typecheck
pnpm test
git status --short
```

All quality commands must pass and `git status --short` must be empty. Generated `.js`/`.tsbuildinfo` artifacts are not acceptable.

## Plan 3 acceptance gate

Before declaring Plan 3 complete:

```bash
pnpm lint
pnpm typecheck
pnpm test
git status --short
```

All quality commands must pass and the working tree must be clean.

Using a temporary repository with `master`:

- create Epic/Task branches and worktrees from correct current targets;
- prove managed Git operations do not execute repository hooks by default;
- execute **agent-facing** filesystem, Git (`status/diff/commit`) and command actions only through Action Gateway;
- deny path escapes and alternate-worktree injection;
- deny raw final merge, push, permission modification and security/config policy modification for Developer capability;
- persist merge conflicts as first-class records;
- final Merge Service refuses absent/rejected/wrong-subject/wrong-type approvals and succeeds only with matching approved `FINAL_MERGE`;
- crash between Git mutation and DB verification is recoverable without duplicate branches/worktrees;
- reconciliation never performs implicit network access;
- environment construction is allowlist-based and does not leak parent secrets/SSH-agent capabilities;
- malicious repo text/scripts do not grant authority; Local Mode warning remains true because arbitrary approved project processes still have OS user privileges.

Before starting Plan 4, its expected `git.diff` tool must already be implemented by this plan through Action Gateway.
