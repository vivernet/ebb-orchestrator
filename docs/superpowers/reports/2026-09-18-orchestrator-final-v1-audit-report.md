# Ebb Orchestrator — Final V1 Audit & Hardening Report

Дата: 2026-09-18  
Ветка: `audit/final-v1-hardening`  
Базовый commit: `ca4a6ae`  
Финальный remediation commit на момент отчёта: `5bd9be7`

## Executive summary

Аудит подтвердил и исправил автоисправимые security, execution, MCP и Web UI/API defects. Исправления прошли focused review, scoped re-review и полный test/lint/typecheck gate.

Релизный статус: **NOT_READY** для полной V1-интеграции.

Причина: остаются load-bearing архитектурные решения, которые нельзя безопасно внедрить без явного решения по startup/recovery ownership, PermissionEngine wiring, GitHub durable sync, worktree cleanup policy, реальному Hermes release gate и production packaging.

## Verification results

- `pnpm install --frozen-lockfile`: PASS (`pnpm v12.4.2`).
- `pnpm lint`: PASS.
- `pnpm typecheck`: PASS (`packages/contracts`, `packages/testing`, `apps/server`).
- `pnpm test`: PASS — server: 60 files, 612 passed, 2 skipped; web: 6 files, 65 passed; contracts/testing завершились через `--passWithNoTests`.
- `pnpm --filter @ebb-orchestrator/web build`: PASS — Vite production build, 39 modules transformed.
- `git diff --check`: PASS.
- Security focused suites and MCP focused suites: PASS; все scoped reviews автоисправлений завершились `ADDRESSED`.

Два skipped server tests — opt-in real Hermes tests, требующие `RUN_HERMES_E2E=1` и настроенный Hermes/model; они не считаются доказательством production Hermes wiring.

## FIXED

- F-002/F-003/F-007: Approval Inbox envelope/field/status mapping, approve-only authorized action, visible/retryable load/mutation errors, dashboard error/retry states, removal of dead actions, structured API errors. Commits: `acfd7aa`, `9867669`.
- SEC-001: shell-interpolated `GitTools` заменён на argv-based execution.
- SEC-002: path containment теперь fail-closed для symlink/junction ancestors, dangling symlinks и workspace-root symlink; valid in-workspace new files сохранены.
- SEC-004: managed commit hook suppression через `--no-verify`.
- EXEC-005: bounded timeout, output limits, AbortSignal propagation and pre-aborted signal handling.
- GIT-007: Git ref validation, end-of-options protection and generated branch validation.
- MCP-001: runtime validation MCP tool arguments, включая recursive item-level validation для `workspace.patch.patches`; malformed payloads rejected before handler mutation. Commits: `137ce0c`, `5bd9be7`.

## ACCEPTED LIMITATIONS / REQUIRES HUMAN DECISION

Следующие findings подтверждены независимым whole-branch review и намеренно не исправлялись молча:

- **SEC-003 / Critical:** `PermissionEngine` не подключён к agent-facing mutation paths; capability allowlist остаётся отдельной проверкой. Требуется архитектурное решение о server-side policy context и wiring через Action Gateway.
- **F-001 / GIT-006 / Critical:** `main.ts` обращается к `projects` до migrations, GitReconciler не инициализируется repository path, reconciliation errors могут быть залогированы перед переходом в READY. Требуется решение по startup/project repository ownership и fail-closed recovery state.
- **GIT-008 / Critical:** `worktree remove --force` и fallback `rmSync(..., recursive:true, force:true)` могут удалить dirty data. Требуется lifecycle policy для dirty worktrees, retention и recovery.
- **F-004 / Important:** GitHub sync state по умолчанию process-local, polling errors не durable/retriable. Требуется persistent outbox/sync-record design.
- **F-005 / Important:** real Hermes E2E opt-in/skipped by default. Требуется deterministic Hermes fixture либо обязательный отдельный release gate.
- **F-006 / Important:** отсутствует production server build/package gate; web build существует отдельно. Требуется определить deployable artifact/package contract.

## Architecture coverage

- Modular monolith boundaries: **PARTIAL** — отдельные modules/services присутствуют, но PermissionEngine boundary не wired в agent mutation path.
- Deterministic-first: **PASS** в проверенных scheduler/budget/Git/approval paths; unresolved startup/GitHub policy decisions перечислены выше.
- Source-of-truth boundaries: **PARTIAL** — SQLite/Git/repository config разделены, но startup Git reconciliation не завершает надёжный ownership flow.
- AgentRuntime abstraction: **PASS**.
- Role boundaries and submit_result: **PASS/PARTIAL** — fake/runtime unit coverage зелёная; real Hermes path opt-in.
- Persistence/migrations: **PARTIAL** — migrations, FK/WAL, transactional migration tests проходят; production startup reads schema before migration.
- Recovery/scheduler/budget: **PARTIAL** — unit/crash/budget suites проходят; production reconciliation jobs/artifacts and fail-closed startup wiring incomplete.
- Web UI/API: **PASS** for remediated v1 flows covered by tests.
- GitHub integration: **PARTIAL** — optional adapter exists, durable restart-safe sync unresolved.
- Build/reproducibility: **PARTIAL** — frozen install/lint/typecheck/web build pass; server production artifact gate unresolved.
- Documentation: **PARTIAL** — this report records limitations; operator README still needs a separate operational documentation pass.

## Security summary

- Action Gateway bypass: **PARTIAL / unresolved SEC-003** — PermissionEngine integration is not silently claimed as fixed.
- Path containment: **PASS** for tested lexical, symlink, dangling symlink and root symlink cases; Windows junction coverage remains platform-guarded.
- Shell/process policy: **PASS** for remediated GitTools/CommandTools paths: argv, `shell:false`, timeout, bounded output and cancellation.
- Git hooks: **PASS** for managed commit path; ordinary user Git operations are outside this managed policy.
- Secrets/environment: existing environment allowlist and local loopback binding verified.
- Approval enforcement: final merge approval checks remain covered; UI exposes only implemented approve action.
- Prompt-injection boundary: no automatic repository instruction authority was found in the audited paths.

## Reliability summary

- Migration ordering and transactionality: tested and passing.
- Startup recovery: **NOT_READY** because production wiring is schema-dependent before migrations and reconciliation can fail open.
- Git journal/reconciliation: **PARTIAL**; initialization/dirty-worktree policy unresolved.
- Idempotency/concurrency/budget reservation: covered by passing suites, with unresolved production integration gaps above.
- GitHub retry/durability: unresolved.

## Test summary

- Final workspace suite: server 60 test files / 612 passed / 2 skipped; web 6 test files / 65 passed.
- Focused security tests cover argv commit messages, hook suppression, ref validation, symlink/dangling/root containment, timeout/output limits and cancellation.
- Focused MCP tests cover required/type/additionalProperties and recursive patch-item validation.
- Real Hermes E2E tests remain explicitly opt-in and skipped in the default suite.

## Final recommendation

**NOT_READY**.

The branch is suitable as a reviewed hardening branch with explicit architectural blockers, not as a claim of complete release-ready V1. Do not merge to `master`, push, or begin post-v1 feature work until the listed human decisions are resolved and the corresponding startup/recovery, PermissionEngine, GitHub durability, worktree safety, Hermes gate and packaging checks are implemented and re-audited.
