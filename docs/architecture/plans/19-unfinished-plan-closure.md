---
id: plan-19
kind: plan
status: proposed
title: План разблокирования и завершения открытых планов v1
created: 2026-09-29
updated: 2026-09-29
depends_on: []
specs:
  - ../specs/01-system-design.md
  - ../specs/03-production-readiness-design.md
evidence:
  - ../proposals/05-github-human-feedback-mapping.md
  - ../proposals/06-coordinator-request-and-epic-recovery.md
  - governance/evidence/07-current-plan-reconciliation.md
  - 04-hermes-autonomous-task.md
  - 05-planning-epics-context-knowledge.md
  - 06-web-github-release.md
  - 07-hermes-development-workflow.md
  - 09-production-readiness.md
---

# План разблокирования и завершения открытых планов v1

**Goal:** Закрыть подтверждённые обязательства `plan-04`, `plan-05`, `plan-06`, `plan-07` и `plan-09`, провести required reviews и обновить статусы только после получения evidence.

**Architecture:** Реализация остаётся внутри утверждённых local-first v1 contracts `spec-01` и `spec-03`. `Plan 05` и `Plan 06` proposals задают предлагаемые API/data/lifecycle решения и должны быть явно приняты до реализации. Project Config lifecycle требует отдельного design decision, потому что текущий `ConfigMigrator` не подключён к durable production Project Config. Hermes/provider и source security scan — независимые внешние acceptance gates; fake runtime, dependency audit и отсутствие findings в старом отчёте их не заменяют.

**Authority:** `docs/architecture/specs/01-system-design.md`, `docs/architecture/specs/03-production-readiness-design.md`, принятые решения по `docs/architecture/proposals/05-github-human-feedback-mapping.md` и `docs/architecture/proposals/06-coordinator-request-and-epic-recovery.md`, затем конкретные исходные планы `04`, `05`, `06`, `07`, `09`.

**Global Constraints:** Не включать `plan-14` и `plan-16`; не передавать secrets в prompts/logs/repository; не считать FakeAgentRuntime/provider wrapper завершённым external acceptance; не ослаблять gates; не менять approval/workflow/security policy; не push и не merge без отдельного разрешения; все коммиты на русском.

**Review Focus:** Дизайны не реализуются до явного принятия; startup resume не обходит Scheduler/budget/permissions и не запускает final merge; GitHub feedback не получает authority менять workflow; source scan получает свежий успешный отчёт на том же revision, что прошёл gates; статус original Plan меняется только после полного evidence и независимого whole-plan review.

## Область и текущий baseline

В scope этого плана входят только незакрытые обязательства:

| Исходный plan | Текущий статус | Gate для завершения |
|---|---|---|
| `plan-04` | `blocked` | Поддерживаемые Hermes CLI/profile и настроенный OpenAI-compatible provider через SecretStore; полный реальный Developer → Reviewer → QA → Integration acceptance и review. |
| `plan-05` | `blocked` | Принятое решение по request API/UI/recovery; реальный Hermes request → Epic и process restart/resume acceptance; whole-plan review. |
| `plan-06` | `in_progress` | Принятый GitHub feedback mapping, production inbox/wiring, Project Config lifecycle, keyring/runtime и release acceptance; whole-plan review. |
| `plan-07` | `blocked` | Поддерживаемый Hermes runtime/provider и завершённый parity plan с report, двумя read-only subagents и доказанным teardown; review. |
| `plan-09` | `in_progress` | Свежий source security scan после изменений, все gates и whole-plan review без load-bearing finding. |

`plan-01` и `plan-12` уже `completed` в generated register и ledger; current-state snapshot синхронизирован при подготовке этого плана и проверяется повторно в Task 2. `plan-14` и `plan-16` остаются за пределами данного плана по решению пользователя.

Статус `plan-19` остаётся `proposed`, пока пользователь не примет решения в Tasks 0 и 1, а `ebb-review-plan` не выдаст `APPROVED`.

## Зависимости

```text
Task 0 (принять proposals 05/06)
  ├── Task 5 (Plan 05 request-to-Epic implementation)
  └── Task 6 (Plan 06 feedback inbox implementation)

Task 1 (Project Config design decision) → Task 6
Task 3 (Hermes readiness) → Task 4 (Plan 04 real Hermes acceptance)
Task 3 (Hermes readiness) → Task 5 (Plan 05 real Hermes acceptance)
Task 3 (Hermes readiness) → Task 7 (Plan 07 parity)
Tasks 4–7 → Task 8 (fresh source scan after code changes)
Tasks 0–8 → Task 9 (release gates, reviews and lifecycle closeout)
```

Plan04 provider acceptance может выполняться после Task 3 параллельно с Task 4/6, но один Hermes profile не используется одновременно несколькими acceptance runs.

## File / interface map

- `docs/architecture/plans/19-unfinished-plan-closure.md` — этот координирующий план и его task evidence.
- `docs/roadmap/02-current-state.md` — актуальный список статусов и последовательность; `docs/roadmap/generated.md` обновляется только `pnpm docs:roadmap`.
- `docs/architecture/proposals/05-github-human-feedback-mapping.md` — решение по repository → Project mapping, inbox, retention и UI; implementation owner после approval: `apps/server/src/modules/github/` и `apps/web/src/features/`.
- `docs/architecture/proposals/06-coordinator-request-and-epic-recovery.md` — решение по NL request API, plan approval UI и startup resume; implementation owner после approval: `apps/server/src/modules/planning/`, `apps/server/src/app/routes/`, `apps/server/src/main.ts`, `apps/web/src/features/`.
- `docs/architecture/proposals/07-project-config-lifecycle.md` — создать в Task 1; определяет production source-of-truth, migration/approval и recovery contract для Plan06 Task 9. До approval Project Config production wiring не реализовывать.
- `apps/server/src/modules/runtime/hermes/` и `tools/hermes/` — существующие runtime/provider boundary и Hermes development runner; изменять только если preflight/acceptance даёт воспроизводимую source-level ошибку.
- `.github/workflows/codeql.yml` — рекомендуемый свежий source scan на GitHub CodeQL advanced setup для JavaScript/TypeScript; доступность code scanning и сохранение результата проверяются до исполнения.
- `docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md` — добавить конечные run IDs/commit SHAs/review verdicts и точные remaining blockers.
- Original plan files `04-hermes-autonomous-task.md`, `05-planning-epics-context-knowledge.md`, `06-web-github-release.md`, `07-hermes-development-workflow.md`, `09-production-readiness.md` — обновлять только чекбоксы/evidence и lifecycle после принятия соответствующего Task.

## Tasks

### Task 0: Принять решения, которые меняют product contract

**Depends on:** none.

**Files:**
- Read: `docs/architecture/proposals/05-github-human-feedback-mapping.md`
- Read: `docs/architecture/proposals/06-coordinator-request-and-epic-recovery.md`
- Modify: оба proposal только для записи принятого варианта и даты; код не меняется.

**Interfaces:**
- Plan 05: выбрать вариант request-to-Epic; отдельно решить automatic startup resume и минимальный UI.
- Plan 06: выбрать mapping cardinality, retention и API-only vs Project inbox UI.
- Источник approval — явное решение пользователя в текущем task; proposal frontmatter/section фиксирует точное принятое решение.

**RED:** Proposal остаётся `proposed`; по нему нельзя составить approved implementation boundary.

**GREEN:** В каждом proposal записаны выбранные ответы и non-goals. Если ответ меняет рекомендованный контракт, обновить proposal и повторно предъявить на approval до продолжения dependent tasks.

**Completion evidence:** явное принятое решение отражено в proposals; `pnpm docs:check` и `pnpm docs:test` проходят.

**Blocked when:** нет явного принятия либо ответы конфликтуют с `spec-01`; не начинать Tasks 4 и 5.

**Review Focus:** не интерпретировать прежнюю просьбу «подготовить proposal» как approval реализации.

### Task 1: Зафиксировать Project Config lifecycle для Plan06 Task 9

**Depends on:** Task 0 для границ GitHub config; решение об изменении Project Config отдельно.

**Files:**
- Create: `docs/architecture/proposals/07-project-config-lifecycle.md`
- Read: `docs/architecture/specs/01-system-design.md` §4 и Settings / Project Configuration; `apps/server/src/platform/database/config-migrator.ts`; onboarding config routes/services.
- Modify after decision: `docs/architecture/plans/19-unfinished-plan-closure.md` и, если меняется API/scope, `docs/architecture/plans/06-web-github-release.md`.

**Interfaces:**
- Design должен однозначно определить canonical config location (`.orchestrator/project.yaml` и связанные документы согласно `spec-01`), active approved snapshot, version/hash/provenance, `USER_DECISION_REQUIRED`, backup/migration order и source trust boundary.
- Не смешивать repository-authored config с machine-local runtime/auth/secrets state.
- Design review решает, хранится ли active normalized snapshot в SQLite либо читается из проверенного Git revision; до выбора implementation не начинается.

**RED:** Proposal ссылается только на generic `ConfigMigrator` и не определяет кто/где читает/пишет Project Config; Plan06 Task 9 не имеет production acceptance.

**GREEN:** Proposal покрывает source-of-truth, lifecycle, schema, migration, backup/recovery и API/UI approval boundary; `ebb-review-plan`/design review фиксирует verdict и принятое решение. После approval этот план дополняется точными implementation paths и acceptance.

**Review Focus:** неизвестная/новая version fail-closed; semantic migration не активируется без решения; repo config остаётся недоверенным до review/approval.

**Blocked when:** принятое решение требует изменения `spec-01`; тогда сначала обновить/утвердить spec, затем этот plan.

### Task 2: Исправить roadmap snapshot и publish plan-19

**Depends on:** none.

**Files:**
- Modify: `docs/roadmap/02-current-state.md`
- Generate: `docs/roadmap/generated.md` через штатный CLI; не редактировать вручную.
- Read: `docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md` и metadata всех `kind: plan`.

**RED:** На исходном baseline current-state расходился с metadata `plan-01`/`plan-12`, а evidence ledger продолжает утверждать, что `plan-01` `in_progress`. Этот baseline частично исправлен при подготовке plan-19; остаётся синхронизировать ledger и повторно проверить все три источника.

**GREEN:** `02-current-state.md` и ledger согласованы с metadata/generated register: `plan-01`/`plan-12` completed, открытые планы указаны без пропусков, `plan-14`/`plan-16` явно вне scope, `plan-19` proposed; следующий шаг отражает порядок Tasks 0–8.

```text
Run: pnpm docs:roadmap
Expected: генератор записывает плановые статусы без ручной правки generated.md.
Run: pnpm docs:check
Expected: All documentation files pass checks.
Run: pnpm docs:test
Expected: все governance tests PASS.
Run: git diff --check
Expected: exit code 0.
```

**Review Focus:** metadata `kind: plan` — authority статуса; current-state/ledger не возвращают завершённые `plan-01/12` в список blocker. Повторить синхронизацию после изменения статусов в Task 9.

### Task 3: Восстановить поддерживаемый Hermes CLI/profile/provider preflight

**Depends on:** none; требуется локальный Hermes runtime и разрешённый provider credential.

**Files:**
- Existing: `scripts/hermes-dev.mjs`, `scripts/project-env.mjs`, `.agents/skills/`, `tools/hermes/`, `apps/server/src/modules/runtime/hermes/hermes-provider-bridge.ts`.
- Modify only on reproduced source-level defect: соответствующий script/profile/runtime test и production source.
- Do not write: credentials, profile tokens, private provider values into repo, prompt or logs.

**Interfaces:**
- Для Orchestrator runtime задать non-secret `EBB_HERMES_PROVIDER_BASE_URL`, `EBB_HERMES_PROVIDER_SECRET_NAME` и supported `HERMES_MODEL`; credential хранить только в `SecretStore` с service `hermes-provider`.
- Для development parity использовать canonical project skills и isolated managed `HERMES_HOME`; не синхронизировать данные в personal profile.

**RED:**

```text
Run: hermes --version
Expected baseline failure: текущий установленный CLI возвращает exit 1 без версии.
Run: pnpm hermes:check
Expected baseline failure: проверка указывает точные отсутствующие CLI/trust/provider/delegation prerequisites.
```

**GREEN:** `hermes --version` возвращает поддерживаемую версию; `pnpm hermes:setup` завершается успешно в managed home; `pnpm hermes:check` сообщает `PASSED`; redacted smoke подтверждает доступность выбранной модели без публикации credential. Любой setup/profile failure сначала классифицируется: runtime install/config vs source bug.

**Review Focus:** `HTTP 401`, `MODEL_FAILED`, timeout, пустой exit-1 и `HERMES_EXECUTE COMPLETED` не считаются provider acceptance. Не повторять бесконечно существующий 180/300-секундный failed run без изменения предварительного условия.

**Blocked when:** нет доступного поддерживаемого CLI, provider/model или активного SecretStore backend; сохранить redacted диагностику и не закрывать Plan04/07.

### Task 4: Выполнить реальный Autonomous Task acceptance Plan04

**Depends on:** Task 3.

**Files:**
- Read/Run: `apps/server/test/e2e/v1-autonomous-task.test.ts`, `docs/architecture/plans/04-hermes-autonomous-task.md`.
- Modify only for test-first reproduced failure: runtime/MCP/context source and matching regression tests.
- Evidence: `docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md`.

**Interfaces:** реальный Hermes выполняет fixture Task через production Runtime/ActionGateway в disposable home/worktree; Developer, независимые Reviewer, QA и Integration передают только валидированный `submit_result`; финальный merge остаётся pending до explicit approval test actor.

**RED:** текущий разрешённый acceptance не доказывает role completion: Hermes CLI завершает до корректного результата либо зависает до timeout.

**GREEN:**

```text
Run: pnpm server:build
Expected: production dist собирается.
Run (PowerShell): сохранить текущее `$env:RUN_HERMES_E2E`, установить `$env:RUN_HERMES_E2E = '1'`, выполнить `pnpm --filter @ebb-orchestrator/server exec vitest run test/e2e/v1-autonomous-task.test.ts --pool=forks --maxWorkers=1`, затем в `finally` восстановить или удалить переменную.
Expected: все роли завершаются подтверждённым structured result; Task достигает FINAL_MERGE approval; фиксация в fixture master происходит только после approval; чистый teardown и redacted evidence.
```

**Review Focus:** реальные credentials не наследуются child tools; никакого merge до approval; проверять run outputs, а не только exit code.

**Blocked when:** provider вызов неуспешен/не завершён или роль не прошла. В evidence сохранить `FAIL / NOT VERIFIED` с marker и cleanup status.

### Task 5: Реализовать и принять Coordinator request → Epic recovery по Plan05

**Depends on:** Task 0 с принятым Proposal 06; Task 3 для real Hermes части.

**Files:**
- Modify/Create: `apps/server/src/modules/planning/planning-service.ts`, `apps/server/src/modules/planning/epic-orchestrator.ts`, `apps/server/src/app/routes/epics.ts`, `apps/server/src/app/create-app.ts`, `apps/server/src/main.ts`.
- Create: `apps/server/src/platform/database/migrations/031_planning_request_linkage.sql`.
- Modify/Create: `apps/server/test/modules/planning/`, `apps/server/test/modules/runtime/`, `apps/server/test/e2e/request-to-epic.hermes.test.ts`, `apps/server/test/e2e/fixtures/epic-restart/`.
- Modify/Create per accepted UI scope: `apps/web/src/features/coordinator/`, `apps/web/src/app/router.tsx`, `apps/web/test/`.

**Interfaces:** использовать project-scoped `POST /api/v1/projects/{projectId}/requests`, durable `requestId`/`planId` связь и существующий authenticated approve-run gate по принятому Proposal 06. Startup recovery выполняется после migrations, run/scheduler/git reconciliation и до `READY`; повторно использует сохранённые Epic/Task IDs и validated phase checkpoints.

**RED:** тест доказывает отсутствующий flow/recovery: authenticated NL request не создаёт durable PlanningRequest/plan relation, либо restart дублирует completed child Run/Task.

**GREEN:**

```text
Run: pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/planning test/app/epic-routes.test.ts --pool=forks --maxWorkers=1
Expected: routes/state transitions, ownership, duplicate requests and approvals pass.
Run: pnpm --filter @ebb-orchestrator/server exec vitest run test/e2e/request-to-epic.hermes.test.ts --pool=forks --maxWorkers=1
Expected deterministic path and production kill/restart acceptance pass; same request resumes without duplicate Task/Run/phase and stops at human final approval.
Run (PowerShell): сохранить текущее `$env:RUN_HERMES_E2E`, установить `$env:RUN_HERMES_E2E = '1'`, выполнить `pnpm --filter @ebb-orchestrator/server exec vitest run test/e2e/request-to-epic.hermes.test.ts --pool=forks --maxWorkers=1`, затем в `finally` восстановить или удалить переменную.
Expected: real Coordinator creates 2–3 dependent Tasks; validated plan waits for approval; Epic completes roles and persists resume evidence.
```

**Review Focus:** no materialization or child dispatch before plan approval; startup never auto-approves final merge; resumed work re-enters Scheduler and budgets; failure before/after durable checkpoint is idempotent.

**Blocked when:** Proposal 06 answers unaccepted, real Hermes run unavailable, or user decision changes architecture. Do not mark Plan05 completed based only on FakeAgentRuntime.

### Task 6: Завершить production GitHub feedback, Project Config и Plan06 acceptance

**Depends on:** Task 0 with Proposal 05 accepted; Task 1 Project Config design approved.

**Files:**
- Create: `apps/server/src/modules/github/human-feedback-service.ts`, `apps/server/src/modules/github/github-project-mapping.ts`, `apps/server/src/app/routes/human-feedback.ts`, `apps/server/src/platform/database/migrations/032_github_project_mapping_feedback.sql` (031 is reserved for PlanningRequest linkage in Task 5).
- Modify: `apps/server/src/modules/github/github-sync-worker.ts`, `apps/server/src/app/create-app.ts`, `apps/server/src/main.ts`, `apps/server/src/platform/database/config-migrator.ts` and Project Config files named in approved Proposal 07.
- Create: `apps/server/test/modules/github/human-feedback-service.test.ts`, `apps/server/test/app/human-feedback-routes.test.ts`; extend `apps/server/test/modules/github/github-sync-worker.test.ts` and config migration/startup tests.
- Modify/Create for approved UI: `apps/web/src/features/human-feedback/`, `apps/web/src/app/router.tsx`, `apps/web/test/`.
- Modify: `.github/workflows/production-gates.yml` only for the required Windows keyring acceptance matrix.

**Interfaces:** GitHub transport supplies Issue comment DTO; HumanFeedback module owns Project mapping, atomic inbox insert+receipt acknowledgement, dedupe and triage. Production `main.ts` constructs worker/service and passes `deps.github`; sync is optional and local workflow remains usable offline. Project Config follows only approved Proposal 07 contract. Keyring acceptance runs on Windows and Ubuntu without provider secrets.

**RED:**

```text
Run: pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/github/human-feedback-service.test.ts test/app/human-feedback-routes.test.ts test/modules/github/github-sync-worker.test.ts --pool=forks --maxWorkers=1
Expected baseline failure: domain inbox/mapping route absent, crash cannot atomically link durable item and delivery receipt.
Run: pnpm --filter @ebb-orchestrator/web test -- human-feedback
Expected baseline failure: project feedback inbox route/component absent when UI is approved.
```

**GREEN:**

```text
Run: pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/github/human-feedback-service.test.ts test/app/human-feedback-routes.test.ts test/modules/github/github-sync-worker.test.ts test/platform/database/config-migrator.test.ts test/main.test.ts --pool=forks --maxWorkers=1
Expected: exact GitHub comment-ID dedupe, bot/marker filtering, transaction/restart, session/Origin/CSRF, cross-project isolation, production worker wiring, offline behavior and Project Config migration lifecycle pass.
Run: pnpm --filter @ebb-orchestrator/web test -- human-feedback
Expected: approved inbox interactions and untrusted text rendering pass; omit only if Proposal 05 explicitly chose API-only and records that UI scope is moved out of Plan06.
Run: pnpm --filter @ebb-orchestrator/web test:e2e
Expected: backend-backed E2E passes with clean child-process and home teardown.
```

**Acceptance:** Re-run current 7-case `v1-crash-matrix.test.ts` and persisted merge restart test; run GitHub issue comment poll twice and across production restart; prove exactly one inbox row, one receipt, no workflow mutation, no PR comments/reviews; run Windows + Ubuntu keyring import/store/retrieve/revoke smoke with ephemeral non-production test entries and verified cleanup.

**Review Focus:** unknown/ambiguous Project mapping never routes comment elsewhere; request body cannot choose repository/project ownership; comment text remains untrusted; credentials/body never appear in logs; existing `github_feedback_deliveries` are not mislabeled as inbox records; no secret value in CI.

### Task 7: Пройти Hermes development parity acceptance Plan07

**Depends on:** Task 3; execute separately from Task 4/5 real provider runs.

**Files:**
- Create: `tools/hermes/fixtures/parity-plan.md` как актуальный, безопасный fixture для текущего canonical `.agents/skills/` workflow; не копировать устаревший contract из исходного Plan07 без адаптации.
- Read/Run: `docs/architecture/plans/07-hermes-development-workflow.md`, canonical `.agents/skills/`.
- Evidence target: `docs/audit/hermes-development-workflow-parity.md`.
- Modify migration scripts/config only after a reproduced failing contract and test-first fix; do not remove active `.opencode` workflow in this Task.

**RED:** prior approved parity runner timed out/failed before a valid parity report; fixture `tools/hermes/fixtures/parity-plan.md` отсутствует, а required two read-only subagent behavior is unproven.

**GREEN:**

```text
Run: pnpm hermes:setup
Expected: canonical skills are materialized in the isolated managed profile with verified hashes.
Run: pnpm hermes:check
Expected: supported CLI, trust/discovery, delegation and provider checks all PASS.
Run: create `tools/hermes/fixtures/parity-plan.md` with the current contracts: ровно два параллельных read-only subagents без nested delegation; только `.agents/skills/`; lint/typecheck/test/diff-check; no product-code changes, merge, push or release; report has date/branch/HEAD/commands/evidence/verdict; no automatic commit.
Expected: fixture exists, is reviewable, excludes stale `.hermes.md` and `tools/hermes/skills/` assumptions and cannot authorize repository mutations.
Run: pnpm hermes:execute -- tools/hermes/fixtures/parity-plan.md
Expected: parity verdict PASS, exactly two read-only subagents, no nested/third child, repository gates PASS, report committed as separate evidence, child processes and artifacts fully cleaned.
```

**Review Focus:** wrapper `COMPLETED exit_code=0` alone does not prove provider-backed parity; require parity report, actual two child results and clean process/artifact inventory. Preserve `.opencode` until existing Plan07 task explicitly permits deletion after PASS.

### Task 8: Добавить и получить свежий независимый source security scan для Plan09

**Depends on:** Tasks 4–7 complete; scan targets the final source revision.

**Files:**
- Create: `.github/workflows/codeql.yml` using GitHub CodeQL advanced setup for JavaScript/TypeScript.
- Modify: `docs/architecture/plans/09-production-readiness.md`, `docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md`.
- No source scanner binary or SARIF/report is committed to the product repository.

**Interfaces:** workflow runs on `push` to `master`/`develop`, `pull_request` to `master`, and scheduled refresh; use read-only `contents`/`actions` and only `security-events: write` required for Code Scanning result upload. GitHub CodeQL advanced setup for JavaScript/TypeScript uploads the analysis when `analyze` completes; verify repository is public or has Code Security entitlement before relying on upload ([official setup](https://docs.github.com/en/code-security/code-scanning/creating-an-advanced-setup-for-code-scanning/configuring-advanced-setup-for-code-scanning)). Dependency audit artifact remains a separate existing control and never satisfies this source scan.

**RED:** no `.github/workflows/codeql.yml` exists and no fresh source scan result is tied to current revision.

**GREEN:**

```text
Run: pnpm lint
Expected: PASS.
Run: pnpm typecheck
Expected: PASS.
Run: pnpm test
Expected: PASS; on this Windows host execute in a runtime that can spawn test children (restricted sandbox previously returned uv_os_get_passwd ENOMEM).
Run in CI: CodeQL workflow for the exact post-fix commit.
Expected: completed JavaScript/TypeScript analysis, retained run/SARIF evidence and no unreviewed load-bearing finding.
```

If GitHub Code Scanning entitlement is unavailable, stop before claiming PASS and obtain approval for a local/CI SARIF-retaining scanner route. Do not repeat the already-authorized npm registry audit as a substitute.

CI evidence requires a workflow run on the scanned commit. Do not push solely to trigger it; wait for an approved branch/PR publication path if no authorized CI event is available.

**Review Focus:** workflow permissions are least privilege; no secrets are required; source scan occurs after all fixes; failed/cancelled/missing analysis is NOT VERIFIED; every finding is dispositioned and fixed findings are scanned again on a new revision.

### Task 9: Закрыть исходные планы evidence, reviews и lifecycle

**Depends on:** Tasks 0–8.

**Files:**
- Modify: `docs/architecture/plans/04-hermes-autonomous-task.md`, `05-planning-epics-context-knowledge.md`, `06-web-github-release.md`, `07-hermes-development-workflow.md`, `09-production-readiness.md`.
- Modify: `docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md`, `docs/roadmap/02-current-state.md`.
- Generate: `docs/roadmap/generated.md` via `pnpm docs:roadmap`.

**Interfaces:** Каждый original plan завершает свой `ebb-final-review` whole-plan review; Critical/Important finding проходит `ebb-handle-review-feedback`, targeted regression, full quality gates и повторный review. Ledger, current-state snapshot и generated register сверяются с frontmatter всех Plans. Лишь после verdict PASS и всех acceptance gates metadata меняется в `completed`.

**RED:** хотя бы у одного плана отсутствует live acceptance report, scanner evidence, accepted design, closed reviewer finding, clean diff или полный required gate.

**GREEN:**

```text
Run: pnpm lint
Expected: PASS.
Run: pnpm typecheck
Expected: PASS.
Run: pnpm test
Expected: PASS; workspace suite includes contracts, server, web and launcher scripts.
Run: pnpm server:build
Expected: PASS.
Run: pnpm web:build
Expected: PASS.
Run: pnpm --filter @ebb-orchestrator/web test:e2e
Expected: PASS with verified process/home teardown.
Run: pnpm docs:check
Expected: All documentation files pass checks.
Run: pnpm docs:test
Expected: all docs governance tests pass.
Run: pnpm docs:roadmap
Expected: generated Plan Register matches lifecycle metadata.
Run: git diff --check
Expected: exit code 0; `git status --short` lists only reviewed intended evidence or clean tree.
```

**Review Focus:** preserve original plan criteria and status semantics; do not close plan just because plan-19 tasks or implementation checkboxes are complete; add exact CI/run/review revision IDs, failure/cleanup facts and remaining limitations.

## Completion criteria for plan-19

- `plan-04`, `plan-05`, `plan-06`, `plan-07`, `plan-09` have all source acceptance criteria met, required provider/security scan evidence retained, and independent whole-plan reviews PASS.
- Original metadata/checkboxes/evidence and `02-current-state.md` agree with `generated.md`.
- `plan-19` changes to `completed` only after its final review and every completion criterion above passes. `plan-14` and `plan-16` are not changed by this plan.
- No push or merge is part of completion; branch transfer requires a separate instruction.
