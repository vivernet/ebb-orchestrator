---
id: plan-19
kind: plan
status: in_progress
title: План разблокирования и завершения открытых планов v1
created: 2026-09-29
updated: 2026-10-03
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

**Architecture:** Реализация остаётся внутри утверждённых local-first v1 contracts `spec-01` и `spec-03`. Уже принятые Proposal 05/06 определяют API/data/lifecycle решения для своих implementation tasks. Полный Project Config lifecycle утверждён в Proposal 07 после независимого design review; production wiring выполняется только в Plan 06 Task 9 в пределах его source-of-truth, approval, migration и recovery boundaries. Hermes/provider и source security scan — независимые внешние acceptance gates; fake runtime, dependency audit и отсутствие findings в старом отчёте их не заменяют.

**Authority:** `docs/architecture/specs/01-system-design.md`, `docs/architecture/specs/03-production-readiness-design.md`, принятые решения по `docs/architecture/proposals/05-github-human-feedback-mapping.md` и `docs/architecture/proposals/06-coordinator-request-and-epic-recovery.md`, затем конкретные исходные планы `04`, `05`, `06`, `07`, `09`.

**Global Constraints:** `plan-14` исключён. Closure audit охватывает все остальные планы, включая `plan-16`. Для Plan16 пользователь подтвердил удаление старых материалов: выполненный 2026-10-02 rebaseline точно классифицировал 97 путей, восемь существующих tracked-файлов удалены без архива в `966f1ec`, 14 актуальных README/инструкций/активных планов сохранены; иных delete targets этот inventory не содержит. Отдельный archive destination или повторное approval для этих восьми удалений не требуются. Оставшиеся README, command-matrix и governance criteria Plan16 проверяются отдельно; не расширять удаление за пределы inventory. Не передавать secrets в prompts/logs/repository; не считать FakeAgentRuntime/provider wrapper завершённым external acceptance; не ослаблять gates; не менять approval/workflow/security policy; не push и не merge без отдельного разрешения; все коммиты на русском.

**Review Focus:** Дизайны не реализуются до явного принятия; startup resume не обходит Scheduler/budget/permissions и не запускает final merge; GitHub feedback не получает authority менять workflow; source scan получает свежий успешный отчёт на том же revision, что прошёл gates; статус original Plan меняется только после полного evidence и независимого whole-plan review.

## Область и текущий baseline

В scope этого плана входят только незакрытые обязательства:

| Исходный plan | Текущий статус | Gate для завершения |
|---|---|---|
| `plan-04` | `blocked` | Поддерживаемые Hermes CLI/profile и безопасный Hermes-native provider/auth path для изолированного Run; полный реальный provider-backed Developer → Reviewer → QA → Integration acceptance и review. Ebb SecretStore mapping не является целевым путём. |
| `plan-05` | `blocked` | Mandatory request/plan UI, startup recovery до `READY` и deterministic production-process Epic recovery harness реализованы; harness прошёл, но он не заменяет same-request restart и real Hermes request → Epic acceptance. Нужно завершить ContextManifest producer по принятому Proposal 08 и пройти whole-plan review. Решение о показе PM/Architect summary до materialization содержится в принятом варианте A Proposal 06. |
| `plan-06` | `in_progress` | Production inbox/wiring/UI и Project Config lifecycle реализованы. По решению пользователя capture на Windows теперь fail closed с HTTP 503 до safe-handle verification; Windows happy-path недоступен. Metadata-only Artifact/Run UI и read-only Settings/Usage projections реализованы; persisted task-bound ContextManifest acceptance остаётся открытым до producer/acceptance по Proposal 08. Schema v1 — первый поддерживаемый формат; predecessor migration не требуется. Остаются supported-platform acceptance, hosted Ubuntu keyring evidence и whole-plan review. |
| `plan-07` | `blocked` | Поддерживаемый Hermes runtime/provider и завершённый parity plan с report, двумя read-only subagents и доказанным teardown; review. |
| `plan-09` | `in_progress` | Свежий source security scan после изменений, все gates и whole-plan review без load-bearing finding. |

`plan-01` и `plan-12` уже `completed` в generated register и ledger; current-state snapshot синхронизирован при подготовке этого плана и проверяется повторно в Task 2. По уточнению пользователя от 2026-09-30 closure охватывает все планы, кроме `plan-14`, включая `plan-16`. Его exact deletion disposition уже выполнен по решению пользователя; для остальных obligations Plan16 повторно сверить acceptance, не восстанавливая старые approval/archive prerequisites.

Plan review обновлённой редакции завершился `APPROVED`; Proposal 05/06, полный lifecycle Proposal 07, canonical `.ebb-orchestrator/` и весь Proposal 08 приняты пользователем. Proposal 08 утверждён 2026-09-30; его implementation plan проходит отдельное независимое review.

## Зависимости

```text
Task 0 (сверить уже принятые proposals 05/06)
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
- `docs/architecture/proposals/05-github-human-feedback-mapping.md` — принятое решение по repository → Project mapping, inbox, retention и UI; implementation owner: `apps/server/src/modules/github/` и `apps/web/src/features/`.
- `docs/architecture/proposals/06-coordinator-request-and-epic-recovery.md` — принятое решение по NL request API, plan approval UI и startup resume; implementation owner: `apps/server/src/modules/planning/`, `apps/server/src/app/routes/`, `apps/server/src/main.ts`, `apps/web/src/features/`.
- `docs/architecture/proposals/07-project-config-lifecycle.md` — принятый после независимого `PASS` design; определяет production source-of-truth, migration/approval и recovery contract для Plan06 Task 9.
- `apps/server/src/modules/runtime/hermes/` и `tools/hermes/` — существующие runtime/provider boundary и Hermes development runner; изменять только если preflight/acceptance даёт воспроизводимую source-level ошибку.
- `.github/workflows/codeql.yml` — рекомендуемый свежий source scan на GitHub CodeQL advanced setup для JavaScript/TypeScript; доступность code scanning и сохранение результата проверяются до исполнения.
- `docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md` — добавить конечные run IDs/commit SHAs/review verdicts и точные remaining blockers.
- Original plan files `04-hermes-autonomous-task.md`, `05-planning-epics-context-knowledge.md`, `06-web-github-release.md`, `07-hermes-development-workflow.md`, `09-production-readiness.md` — обновлять только чекбоксы/evidence и lifecycle после принятия соответствующего Task.

## Tasks

### Task 0: Зафиксировать принятые product-contract решения

**Depends on:** none.

**Files:**
- Read: `docs/architecture/proposals/05-github-human-feedback-mapping.md`
- Read: `docs/architecture/proposals/06-coordinator-request-and-epic-recovery.md`
- Modify: оба proposal только для записи принятого варианта и даты; код не меняется.

**Interfaces:**
- Plan 05 / Proposal 06: пользователь принял вариант A — project-scoped request API, minimal request/plan approval UI и automatic resume одобренных Epic до `READY`; recovery проходит migrations, run/scheduler/git reconciliation, бюджеты и permissions, повторно использует persisted IDs/checkpoints и останавливается перед `FINAL_APPROVAL`.
- Plan 06 / Proposal 05: пользователь принял вариант A — один GitHub repository связан максимум с одним активным Project, комментарии поступают в Project inbox, UI link/ignore/resolve обязателен, тело хранится до явного удаления feedback или Project.
- Решения пользователя от 2026-09-29 уже записаны в Proposal 05/06. Задача сверяет записи и устраняет только документальные расхождения; новых approval-вопросов не открывает.

**RED:** proposals или этот plan противоречат зафиксированным решениям пользователя.

**GREEN:** Proposal 05/06 и plan содержат согласованные варианты, retention, обязательный UI, resume boundary и non-goals.

**Completion evidence:** явное принятое решение отражено в proposals; `pnpm docs:check` и `pnpm docs:test` проходят.

**Blocked when:** записанное решение противоречит `spec-01`; не начинать зависимые tasks до согласования документации.

**Review Focus:** не переоткрывать принятые решения и не трактовать их как approval автоматического plan approval, final merge или автоматического применения repo config.

### Task 1: Зафиксировать Project Config lifecycle для Plan06 Task 9

**Depends on:** Task 0 для границ GitHub config; решение об изменении Project Config отдельно.

**Files:**
- Read/Review: `docs/architecture/proposals/07-project-config-lifecycle.md`
- Read: `docs/architecture/specs/01-system-design.md` §4 и Settings / Project Configuration; `apps/server/src/platform/database/config-migrator.ts`; onboarding config routes/services.
- Modify after review: `docs/architecture/plans/19-unfinished-plan-closure.md` и, если меняется API/scope, `docs/architecture/plans/06-web-github-release.md`; Proposal 07 изменять только для addressable review findings.

**Interfaces:**
- Canonical repository config directory уже выбран пользователем: только `.ebb-orchestrator/`; repository-authored изменения нельзя применять автоматически. Соответствующие места `spec-01`, onboarding/UI, README и discovery приведены к этому пути.
- Accepted design определяет active approved SQLite snapshot, immutable candidate source bytes, manifest/revision hashes/provenance, `USER_DECISION_REQUIRED`, verified DB backup/migration order и recovery behavior. Repository-authored config остаётся недоверенным до явного review/approval и никогда не применяется автоматически.
- Не смешивать repository-authored config с machine-local runtime/auth/secrets state.
- Пользователь принял Proposal 07 целиком 2026-09-29 после независимого review `PASS`; active normalized snapshot хранится в SQLite.

**RED (historical baseline):** до Proposal 07 существовал только generic `ConfigMigrator`, не подключённый к durable Project Config service/repository; после принятия design этот gap закрывается implementation и acceptance в Task 6, а не считается текущим дефектом proposal.

**GREEN:** Proposal покрывает source-of-truth, lifecycle, schema, migration, backup/recovery и API/UI approval boundary; независимый design review `PASS` и approval пользователя зафиксированы. Plan 19 Task 6 содержит implementation boundary и acceptance.

**Review Focus:** неизвестная/новая version fail-closed; semantic migration не активируется без решения; repo config остаётся недоверенным до review/approval.

**Completion evidence:** accepted Proposal 07, независимый review verdict `PASS`, явное принятие пользователя 2026-09-29; lifecycle implementation входит в Task 6.

User decision follow-up (2026-09-30): Project Config capture на Windows должен fail closed до поддержки safe handle/reparse verification. Реализация возвращает `PROJECT_CONFIG_UNSUPPORTED_PLATFORM`/HTTP 503 до чтения repository-файлов; acceptance на Windows проверяет отказ и отсутствие candidate/state записей, а полный lifecycle/restart сценарий помечает `WAIVED / NOT RUN`.

### Task 2: Исправить roadmap snapshot и publish plan-19

**Depends on:** none.

**Files:**
- Modify: `docs/roadmap/02-current-state.md`
- Generate: `docs/roadmap/generated.md` через штатный CLI; не редактировать вручную.
- Read: `docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md` и metadata всех `kind: plan`.

**RED:** На исходном baseline current-state расходился с metadata `plan-01`/`plan-12`, а evidence ledger продолжает утверждать, что `plan-01` `in_progress`. Этот baseline частично исправлен при подготовке plan-19; остаётся синхронизировать ledger и повторно проверить все три источника.

**GREEN:** `02-current-state.md` и ledger согласованы с metadata/generated register: `plan-01`/`plan-12` completed, открытые планы указаны без пропусков, `plan-14` явно вне scope, остальные планы включая `plan-16` входят в closure audit, `plan-19` in_progress; следующий шаг отражает порядок Tasks 0–8.

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

### Task 3: Подтвердить Hermes CLI и developer project-trust readiness

**Depends on:** none; требуется поддерживаемый локальный Hermes CLI. Provider credentials не являются prerequisite этого developer preflight.

**Files:**
- Existing: `scripts/hermes-dev.mjs`, `scripts/project-env.mjs`, `.agents/skills/`, `tools/hermes/`.
- Modify only on reproduced source-level defect: соответствующий script/profile/runtime test и production source.
- Do not write: credentials, profile tokens, private provider values into repo, prompt or logs.

**Interfaces:**
- Developer setup/check используют canonical project skills, project trust/discovery и настройки delegation в выбранном Hermes home. Для `hermes:setup` в acceptance применять отдельный disposable Hermes-native home; не менять пользовательский default profile.
- Этот Task не настраивает provider для production Run. По принятому условному направлению Proposal09 Hermes владеет provider/auth; Plan20 отдельно проверяет безопасный per-Run native profile path. Не требовать `EBB_HERMES_PROVIDER_BASE_URL`, `EBB_HERMES_PROVIDER_SECRET_NAME`, provider-key entry в Ebb `SecretStore` или provider credentials в root `.env`.
- Имена ключей root `.env` — только `EBB_ORCHESTRATOR_HOME` и `PORT`; это настройки Ebb Orchestrator, а не Hermes provider credentials.

**Developer readiness commands:**

```text
Run: hermes --version
Expected: поддерживаемая версия Hermes, exit code 0.
Run: pnpm hermes:check
Expected: exit code 0 только если проходят CLI health, `.hermes.md`, canonical project skills inventory, project trust/discovery и delegation checks. Команда не проверяет provider credentials, authentication, network access или доступность модели.
Run: pnpm hermes:setup with HERMES_HOME pointing to an empty disposable Hermes-native profile
Expected: setup completes in that disposable profile; the user's default profile is not changed.
```

**GREEN:** Hermes CLI, project trust/discovery and delegation checks pass; `hermes:setup` succeeds in a disposable native profile. Это подтверждает только developer readiness. Provider-backed smoke и runtime auth acceptance выполняются отдельно по Plan04/Plan20 после прохождения их profile/configuration safety gates; `hermes:check` не заменяет этот acceptance. Любой setup/profile failure сначала классифицируется: runtime install/config vs source bug.

**Review Focus:** `pnpm hermes:check` подтверждает только developer project prerequisites. `HTTP 401`, `MODEL_FAILED`, timeout, пустой exit-1 и `HERMES_EXECUTE COMPLETED` не считаются provider acceptance без отдельного реального provider-backed evidence. Не повторять бесконечно существующий 180/300-секундный failed run без изменения предварительного условия.

**Blocked when:** нет доступного поддерживаемого CLI или не выполнены project trust/discovery/delegation prerequisites; сохранить redacted диагностику. Отсутствие Ebb SecretStore provider entry не блокирует этот developer preflight. Plan04/07 остаются открытыми, пока их отдельные runtime/provider acceptance gates не пройдены.

**Scoped source hardening (2026-09-30):** repo-owned Hermes wrapper теперь выводит bounded/sanitized stderr + exit code, завершает setup до trust/config при CLI health failure и применяет 30-секундный timeout к `hermes --version`. Regression покрывает sanitization, порядок вызовов, spawn failure и timeout. `node --test scripts/hermes-dev.test.mjs` PASS 23/23; scoped ESLint и `git diff --check` PASS; независимый scoped review APPROVED.

**Fresh developer-readiness evidence (2026-10-02):** `hermes --version` exit 0: Hermes Agent `v0.21.5+5778.g0a374d1`, upstream/source prefix `0a374d16`, Python `3.14.7`, OpenAI SDK `2.24.0`. `pnpm hermes:check` on the current real Hermes profile exit 0: CLI version, project `.hermes.md`, canonical skills inventory (20), project trust/discovery and all three delegation settings PASS; provider/auth/network/model access were not checked. `node scripts/hermes-dev.mjs setup` (the `pnpm hermes:setup` package entrypoint) ran with `HERMES_HOME` set to an empty disposable native profile under `%LOCALAPPDATA%\hermes\profiles\<unique-temp>`; exit 0 and setup completion line were observed, and the temporary profile was removed with cleanup verified. The generated unique suffix was not retained. The personal/default Hermes profile was not changed. Root `.env` variable names were checked without reading values: only `EBB_ORCHESTRATOR_HOME` and `PORT`. Real provider invocation: **NOT RUN**; this readiness evidence does not clear Plan04/Plan07 provider acceptance.

**Fresh post-update developer-readiness evidence (2026-10-06):** the user reported Hermes Agent `v0.21.5+7357.g9244275` and successfully ran `hermes --version` in PowerShell. `pnpm hermes:check`, executed outside the workspace sandbox after the sandboxed runner was denied access to the Hermes Python runtime, exited 0; CLI health, `.hermes.md`, all 20 canonical skills, trusted-project, project discovery, and all three delegation settings passed. `pnpm hermes:test` passed 28/28. `pnpm hermes:setup` exited 0 in a newly created unique empty `HERMES_HOME` under `%LOCALAPPDATA%\hermes\profiles`; its setup-completion marker was observed. Cleanup first encountered a locked `cron/.tick.lock`; after the setup process exited, a read-only process check found no recent Hermes/Python process, the exact lock file opened exclusively, the exact UUID-named disposable profile was removed, and absence was verified. The default Hermes profile, credentials, provider configuration and auth were not read or changed. This closes only developer readiness: no provider/auth/model invocation was performed, so Plan04/Plan07 provider acceptance remains open.

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
- Create: `apps/server/src/platform/database/migrations/031_planning_request_linkage.sql` and `036_planning_request_role_runs.sql` for durable request-to-role-run linkage and validated-decision requirement on new queued requests.
- Modify/Create: `apps/server/test/modules/planning/`, `apps/server/test/modules/runtime/`, `apps/server/test/e2e/request-to-epic.hermes.test.ts`, `apps/server/test/e2e/fixtures/epic-restart/`.
- Modify/Create mandatory minimal request/plan approval UI: `apps/web/src/features/coordinator/`, `apps/web/src/app/router.tsx`, `apps/web/test/`.

**Interfaces:** использовать project-scoped `POST /api/v1/projects/{projectId}/requests`, durable `requestId`/`planId` связь, обязательный minimal request/plan approval UI и существующий authenticated approve-run gate по принятому Proposal 06. Для нового Epic request до approval допускаются Coordinator и request-bound Product Manager/Architect planning Runs; последние имеют отдельную durable request↔role↔run связь, не получают `task_id`/`epic_id`, используют read-only planning tools, а их validated decisions входят в durable pending plan и видимый approval summary. Здесь формулировка «до одобрения нет AgentRuns» означает отсутствие child-work Runs: до явного human `approve-run` не создаются доменные Epic/Task IDs, child-work Runs и child Scheduler reservations. Только `approve-run` материализует доменные IDs и разрешает child dispatch. До `READY` startup выполняет migrations, run/scheduler/git reconciliation, затем возобновляет только одобренные Epic до `FINAL_APPROVAL`; recovery повторно использует сохранённые Epic/Task IDs и validated phase checkpoints и проходит обычные Scheduler, budgets и permissions. Ни plan approval, ни final merge не выполняются автоматически.

**RED:** тест доказывает отсутствующий flow/recovery: authenticated NL request не создаёт durable PlanningRequest/plan relation, либо restart дублирует completed child Run/Task.

**GREEN:**

```text
Run: pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/planning test/app/epic-routes.test.ts --pool=forks --maxWorkers=1
Expected: routes/state transitions, ownership, duplicate requests and approvals pass.
Run: pnpm --filter @ebb-orchestrator/server exec vitest run test/e2e/request-to-epic.hermes.test.ts --pool=forks --maxWorkers=1
Expected deterministic path and production kill/restart acceptance pass; same request resumes without duplicate Task/Run/phase and stops at human `FINAL_APPROVAL`.
Run (PowerShell): сохранить текущее `$env:RUN_HERMES_E2E`, установить `$env:RUN_HERMES_E2E = '1'`, выполнить `pnpm --filter @ebb-orchestrator/server exec vitest run test/e2e/request-to-epic.hermes.test.ts --pool=forks --maxWorkers=1`, затем в `finally` восстановить или удалить переменную.
Expected: real Coordinator creates 2–3 dependent Tasks; validated plan waits for approval; Epic completes roles and persists resume evidence.
```

**Review Focus:** minimal request/plan UI shows validated PM/Architect decisions before approval; duplicate delivery/restart reuses durable request-bound role Runs without duplicates; preapproval planning Runs are distinct from child-work Runs; no domain Epic/Task IDs, child-work Runs or child reservations before explicit human plan approval; startup recovers approved Epic before `READY`, never auto-approves plan/final merge, and resumes only through `FINAL_APPROVAL`; resumed work re-enters Scheduler, budgets and permissions; failure before/after durable checkpoint is idempotent.

**Blocked when:** real Hermes run unavailable or implementation reveals a contradiction with the accepted Proposal 06 contract. Do not mark Plan05 completed based only on FakeAgentRuntime.

**Execution evidence (2026-09-30):** `pnpm plan05:epic-restart:acceptance` PASS после server build. Fixture-runtime checkpoints были подготовлены в parent test process; restart и startup recovery выполнялись собранным production `dist/main.js`. Evidence: Epic `663ca96d-2e78-4224-9dd3-6c66171896d4`, plan `2efcaad5-93ba-4630-b5aa-ed7fed6f5a2f`, tasks `88dc8af9-f094-42ae-b8ab-a37ea80768f1` и `a858db0a-de22-4b2e-885a-6779ef712d1c`; восстановлены 12 Run IDs и 12 phase IDs, стадия `FINAL_APPROVAL`, ровно одно pending final approval, контрольный plan остался `PENDING`. Это подтверждает production startup recovery для seeded checkpoints, но не same-request process restart или Hermes provider execution (`provider=NOT_INVOKED`). Три acceptance tests прошли, включая allowlisted child environment и fail-closed child teardown. Independent re-review исправлений harness: `PASS`.

**Повторная acceptance-проверка (2026-09-30):** `pnpm plan05:epic-restart:acceptance` снова завершилась `PASS` после добавления journal-verified Epic worktree и child branches от Epic branch. Новые IDs: Epic `f51deac4-5613-4a50-ae17-4f2db602a94b`, plan `31fd77da-66b2-4235-a637-2e7e58b53152`, tasks `3c142777-11a6-4f75-80d1-800727eb64f6` и `0ca995e5-a65d-49c5-bd1f-96e6c104539a`; recovery сохранил 12 Runs/12 phases и завершился на `FINAL_APPROVAL` с одним pending final approval. Это по-прежнему seeded-checkpoint process recovery, `provider=NOT_INVOKED`; same-request restart и real Hermes остаются открытыми.

### Task 6: Завершить production GitHub feedback, Project Config и Plan06 acceptance

**Depends on:** Task 0 with Proposal 05 accepted; Task 1 Project Config design approved.

**Files:**
- Create: `apps/server/src/modules/github/human-feedback-service.ts`, `apps/server/src/modules/github/github-project-mapping.ts`, `apps/server/src/app/routes/human-feedback.ts`, `apps/server/src/platform/database/migrations/032_github_project_mapping_feedback.sql` (031 is reserved for PlanningRequest linkage in Task 5).
- Modify: `apps/server/src/modules/github/github-sync-worker.ts`, `apps/server/src/app/create-app.ts`, `apps/server/src/main.ts`, `apps/server/src/platform/database/config-migrator.ts` and Project Config files named in approved Proposal 07.
- Create: `apps/server/test/modules/github/human-feedback-service.test.ts`, `apps/server/test/app/human-feedback-routes.test.ts`; extend `apps/server/test/modules/github/github-sync-worker.test.ts` and config migration/startup tests.
- Modify/Create mandatory Project inbox UI with link/ignore/resolve: `apps/web/src/features/human-feedback/`, `apps/web/src/app/router.tsx`, `apps/web/test/`.
- Complete original Plan 06 operational/configuration read-only views: apps/server/src/app/routes/runs.ts, apps/web/src/features/runs/AgentRunPage.tsx, apps/server/src/app/routes/settings.ts, apps/web/src/features/settings/SettingsPage.tsx, and the Usage route/page/read-model and focused tests.
- Create Project Config repository/service/approval API and tests under `apps/server/src/modules/projects/`, `apps/server/src/app/routes/`, and existing server test trees as specified by accepted Proposal 07; extend onboarding/configuration UI and tests under `apps/web/src/features/`.
- Project Config production v1 treats `schema_version: 1` as its first supported format; repository inspection found no shipped predecessor. Only `.ebb-orchestrator/` is canonical; the legacy `.orchestrator/` path is not imported. ContextManifest production producer remains gated on the independent design proposal `../proposals/08-production-context-manifest.md`; no placeholder provenance is permitted.
- Create append-only Project Config SQLite migration after `031_planning_request_linkage.sql` and `032_github_project_mapping_feedback.sql`; select and verify the next unused migration sequence before implementation.
- Modify: `.github/workflows/production-gates.yml` only for the required Windows keyring acceptance matrix.

**Interfaces:** GitHub transport supplies Issue comment DTO; HumanFeedback module owns Project mapping, atomic inbox insert+receipt acknowledgement, dedupe and triage. Production `main.ts` constructs worker/service and passes `deps.github`; sync is optional and local workflow remains usable offline. Project Config reads candidates only from `.ebb-orchestrator/`, stores immutable candidates and active approved normalized revisions in SQLite, binds approval to candidate/hash, and never auto-applies repository changes. Keyring acceptance runs on Windows and Ubuntu without provider secrets.

**RED:**

```text
Run: pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/github/human-feedback-service.test.ts test/app/human-feedback-routes.test.ts test/modules/github/github-sync-worker.test.ts --pool=forks --maxWorkers=1
Expected baseline failure: domain inbox/mapping route absent, crash cannot atomically link durable item and delivery receipt.
Run: pnpm --filter @ebb-orchestrator/web test -- human-feedback
Expected baseline failure: required project feedback inbox route/component is absent.
```

**GREEN:**

```text
Run: pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/github/human-feedback-service.test.ts test/app/human-feedback-routes.test.ts test/modules/github/github-sync-worker.test.ts test/platform/database/config-migrator.test.ts test/main.test.ts --pool=forks --maxWorkers=1
Expected: exact GitHub comment-ID dedupe, bot/marker filtering, transaction/restart, session/Origin/CSRF, cross-project isolation, production worker wiring, offline behavior and Project Config migration lifecycle pass.
Run: pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/projects/project-config-service.test.ts test/modules/projects/project-config-repository.test.ts test/app/project-config-routes.test.ts test/platform/database/project-config-migration.test.ts --pool=forks --maxWorkers=1
Expected: immutable candidate source bytes and canonical manifest hash across HEAD/dirty/untracked/deleted files; normalized revision hash binding and restart integrity; current-candidate idempotency; atomic stale transition and capture/approval race orderings; exact candidateId/hash approval CAS and stale rejection; cross-project ownership; symlink/junction/reparse/traversal/TOCTOU rejection; failed capture preserves current candidate and active pointer; format migration creates reviewable candidate; semantic migration returns USER_DECISION_REQUIRED; verified DB-backup failure stops schema migration; transaction crash before/after commit preserves old/new active pointer consistently; corrupt/unsupported active revision blocks Project dispatch without repository/default/older-revision fallback.
Run: pnpm --filter @ebb-orchestrator/web test -- human-feedback
Expected: approved inbox interactions and untrusted text rendering pass; these tests are required by the accepted Proposal 05 scope.
Run: pnpm --filter @ebb-orchestrator/web test -- project-config onboarding
Expected: UI renders the persisted candidate's exact source diff and manifest hash, sends approval for that exact candidate/hash, rejects stale candidates, and cannot silently activate or apply repository changes.
Run: pnpm --filter @ebb-orchestrator/web test:e2e
Expected: backend-backed E2E passes with clean child-process and home teardown.
```

**Acceptance:** Re-run current 7-case `v1-crash-matrix.test.ts` and persisted merge restart test; run GitHub issue comment poll twice and across production restart; prove exactly one inbox row, one receipt, no workflow mutation, no PR comments/reviews; run Windows + Ubuntu keyring import/store/retrieve/revoke smoke with ephemeral non-production test entries and verified cleanup.

Project Config production restart acceptance runs in a disposable Project/home against the composed production server: persist an approved active revision and a separate pending candidate; restart the process; prove only the approved normalized snapshot is runtime authority, the pending candidate remains reviewable, and exact diff/hash approval activates only that snapshot. In separate recovery cases, inject failure before/after the active-pointer transaction and corrupt/unsupported active revision; prove atomic old/new recovery and that the affected Project remains blocked with no fallback or Agent dispatch. Record migration backup result, restart/process cleanup, and redacted evidence. A mocked service unit test alone does not satisfy production restart acceptance. On Windows, the acceptance command verifies capture returns `PROJECT_CONFIG_UNSUPPORTED_PLATFORM`/HTTP 503 before any candidate/state row is written, then reports the lifecycle/restart happy path as `WAIVED / NOT RUN`; that platform result does not substitute for full supported-platform acceptance.

Plan 06 also requires its original operational/configuration UI contract: Run displays a persisted task-bound context manifest (IDs/versions only) and safe artifact metadata without contents, prompts or hidden reasoning; Coordinator request-bound Runs whose manifest is unsupported by schema v1 state that manifest is unavailable. Settings displays only server-authoritative values with their actual scope/source, identifies unsupported hierarchy/security values as unavailable, and derives Local Mode warning from server state. Usage displays applicable budget scopes, policy, spent/reserved values, effective limit and RESERVED entries from existing budget authority; historical aggregate usage records are labeled separately. These are read-only projections; they do not add active-config/budget write paths or new policy semantics.

**Partial execution evidence (2026-09-30):** Run UI/API now project artifact metadata only and exact task/run-bound persisted ContextManifest IDs/versions. A corrupted ID JSON value or a non-string array causes a generic `503 context manifest unavailable`; focused route regression passed, and independent security re-review is `PASS`. Request-bound Runs return no fabricated manifest and the UI labels it unavailable. Production has no ContextManifest writer or callsite tied to actual runtime context construction, so there are no records from real Runs to display; this acceptance remains open until the accepted Proposal 08 implementation and runtime-backed acceptance pass. Settings and Usage now render read-only server-authoritative facts and budget/reservation projections, with unsupported values called unavailable. Browser E2E passed 6/6 with launcher exit 0 and verified teardown; the malformed-project response fixture still emits expected error-boundary console noise.

**Повторный acceptance и teardown review (2026-09-30):** `pnpm plan06:github-inbox:acceptance` прошла на production `dist/main.js` с local GitHub HTTP fixture: повторный poll до/после restart сохранил одну inbox row и один `DELIVERED` receipt, workflow tables остались без изменений, cleanup прошёл; test-only keyring shim не является OS-keyring evidence. После принятия fail-closed на Windows `pnpm plan06:project-config:acceptance` проверила HTTP 503 `PROJECT_CONFIG_UNSUPPORTED_PLATFORM`, отсутствие candidate/state rows и integrity базы, затем вывела `WAIVED / NOT RUN` для Windows lifecycle/restart happy path. Полная Project Config lifecycle acceptance на supported POSIX host остаётся незапущенной. Independent review прежнего browser E2E teardown выявил, что Playwright detached browser groups не покрывались проверкой родительской process group; старый E2E PASS сам по себе это замечание не закрывает. Исправление теперь отслеживает подтверждённые detached sessions и оставляет isolated home при неразрешённом ownership; regression, `node --check`, ESLint и `git diff --check` прошли, но POSIX integration кейсы на Windows `SKIP`, Linux execution остаётся `NOT RUN`.

**Review Focus:** unknown/ambiguous Project mapping never routes comment elsewhere; request body cannot choose repository/project ownership; comment text remains untrusted; credentials/body never appear in logs; existing `github_feedback_deliveries` are not mislabeled as inbox records; no secret value in CI.

### Task 7: Пройти Hermes development parity acceptance Plan07

**Depends on:** Task 3; execute separately from Task 4/5 real provider runs.

**Files:**
- Create: `scripts/fixtures/hermes-development-workflow-parity-plan.md` как актуальный, безопасный fixture для текущего canonical `.agents/skills/` workflow; не копировать устаревший contract из исходного Plan07 без адаптации.
- Read/Run: `docs/architecture/plans/07-hermes-development-workflow.md`, canonical `.agents/skills/`.
- Evidence target: `docs/audit/hermes-development-workflow-parity.md`.
- Modify migration scripts/config only after a reproduced failing contract and test-first fix; do not remove active `.opencode` workflow in this Task.

**RED:** prior approved parity runner timed out/failed before a valid parity report; fixture `scripts/fixtures/hermes-development-workflow-parity-plan.md` создан, но required two read-only subagent behavior and provider-backed parity report are unproven.

**GREEN:**

```text
Run: pnpm hermes:setup
Expected: setup validates the canonical repository-owned `.agents/skills/` inventory and configures project trust/discovery in the isolated managed profile; it does not copy those skills into Hermes profile directories.
Run: pnpm hermes:check
Expected: supported CLI, canonical skills inventory, project discovery/trust and delegation settings all PASS. This check does not test provider/auth/network access; provider-backed parity remains a separate acceptance gate and must have its own report.
Run: create `scripts/fixtures/hermes-development-workflow-parity-plan.md` with the current contracts: ровно два параллельных read-only subagents без nested delegation; только `.agents/skills/`; lint/typecheck/test/diff-check; no product-code changes, merge, push or release; report has date/branch/HEAD/commands/evidence/verdict; no automatic commit.
Expected: fixture exists, is reviewable, excludes stale `.hermes.md` and `tools/hermes/skills/` assumptions and cannot authorize repository mutations.
Run: pnpm hermes:execute -- scripts/fixtures/hermes-development-workflow-parity-plan.md
Expected: parity verdict PASS, exactly two read-only subagents, no nested/third child, repository gates PASS, report committed as separate evidence, child processes and artifacts fully cleaned.
```

**Review Focus:** wrapper `COMPLETED exit_code=0` alone does not prove provider-backed parity; require parity report, actual two child results and clean process/artifact inventory. Preserve `.opencode` until existing Plan07 task explicitly permits deletion after PASS.

### Task 8: Добавить и получить свежий независимый source security scan для Plan09

**Depends on:** Tasks 4–7 complete; scan targets the final source revision.

**Files:**
- Verify/configure: `.github/workflows/codeql.yml` using GitHub CodeQL advanced setup for JavaScript/TypeScript.
- Modify: `docs/architecture/plans/09-production-readiness.md`, `docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md`.
- No source scanner binary or SARIF/report is committed to the product repository.

**Interfaces:** workflow runs on `push` to `master`/`develop`, `pull_request` to `master`, and scheduled refresh; use read-only `contents`/`actions` and only `security-events: write` required for Code Scanning result upload. GitHub CodeQL advanced setup for JavaScript/TypeScript uploads the analysis when `analyze` completes; verify repository is public or has Code Security entitlement before relying on upload ([official setup](https://docs.github.com/en/code-security/code-scanning/creating-an-advanced-setup-for-code-scanning/configuring-advanced-setup-for-code-scanning)). Dependency audit artifact remains a separate existing control and never satisfies this source scan.

**Current state (2026-09-30):** `.github/workflows/codeql.yml` is present with JavaScript/TypeScript CodeQL analysis and least-privilege job permissions. No hosted analysis result is tied to the current source revision, so Task 8 remains open; a configured workflow is not scan evidence.

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
- `plan-19` changes to `completed` only after its final review and every completion criterion above passes. `plan-14` is not changed by this plan. Plan16 status/evidence may be reconciled; the eight approved exact historical files were deleted without archive in `966f1ec`. No further deletion is authorized by that inventory; remaining Plan16 acceptance criteria still require evidence.
- No push or merge is part of completion; branch transfer requires a separate instruction.

## Continuation evidence (2026-09-30, final review and current gates)

- User decision: Project Config capture fails closed on Windows until safe handle/reparse verification is implemented and verified. `pnpm plan06:project-config:acceptance` on Windows reports HTTP 503 `PROJECT_CONFIG_UNSUPPORTED_PLATFORM`, no candidate/state writes, and `WAIVED / NOT RUN` for the Windows lifecycle path. Supported POSIX lifecycle acceptance remains open.
- Windows E2E teardown review finding fixed: `terminateWindowsChild` failure now records PID, exit/signal state, `taskkill` code, bounded stderr and cause; `run-e2e.mjs` includes the child name/lifecycle summary. A platform-independent regression injects `taskkill` and exit polling. `node --test apps/web/test/e2e/credential-handoff.test.mjs` PASS: 29 passed, 2 POSIX-only skipped.
- Browser E2E rerun inside the restricted runner passed all six browser scenarios but `taskkill.exe` returned code 1 and the frontend child remained alive; the launcher correctly failed and retained that run's isolated home. After verifying the exact child PID/name/start time, only that E2E-owned process was stopped; its retained home was not deleted. The same `pnpm --filter @ebb-orchestrator/web test:e2e` rerun outside that restriction passed 6/6 with exit 0 and verified teardown/home cleanup. No application defect was found in this failure.
- Fresh gates after the final code changes: `pnpm lint` PASS; `pnpm typecheck` PASS; unrestricted `pnpm test` PASS (113 files, 1,016 passed, 13 skipped; root launcher/acceptance scripts 21/21); `pnpm build` PASS; browser E2E 6/6, exit 0. The separate limited-runner full test previously failed only on nested `tsx` `uv_os_get_passwd ENOMEM` and readiness acknowledgements.
- Documentation reconciliation: `pnpm docs:check` PASS; `pnpm docs:test` PASS 20/20; `pnpm docs:rename:check` PASS, 43 entries; `pnpm docs:roadmap` generated 33 Plans and read-back matches metadata/statuses. Current-state documentation records the missing ContextManifest producer, the then-current Hermes check failure (now superseded by the 2026-10-02 developer-readiness evidence in Task 3), Plan09 source-scan gap, Plan10 historical-report caveat and Plan16 stale inventory/archive gate; historical completed statuses/unchecked items were not rewritten.
- Historical Hermes observation (2026-09-30): `hermes --version` exited 1 without output and `pnpm hermes:check` was `CHECK_FAILED` for CLI version, project trust/discovery and delegation settings; `.hermes.md` and all 19 then-current canonical skills passed. Managed setup was not retried at that time because the prior attempt stopped before dispatch on the missing Python `ruamel` dependency. The fresh 2026-10-02 developer-readiness result and separate real-provider status are recorded under Task 3.
- Plan16 remains blocked: 97-entry inventory is stale (75 paths absent including 11 directories; 24 Git-state mismatches), external archive destination is unknown, and its strict plan gate disallows packaging or side effects before written inventory-rebaseline approval and an exact target.
- Fresh whole-plan reviews: Plan05's documentation finding about accepted Proposal 06 was resolved and independently re-reviewed `PASS`; Plan05 itself remains blocked by real Hermes/same-request acceptance and the not-yet-implemented ContextManifest producer. Plan06's plan-consistency review is `APPROVED`, but this is not completion approval: supported-platform Project Config acceptance, Ubuntu keyring evidence, ContextManifest implementation/acceptance, and external Hermes acceptance remain open.
- Proposal08 was independently reviewed `PASS` and explicitly approved by the user on 2026-09-30. It requires Run bindings for TASK/EPIC/REQUEST, version/hash provenance, exact-fingerprint same-session resume with fail-closed mismatch handling, and the corresponding `spec-01` §10.2 update. A separate implementation plan is being prepared and must pass independent plan review before code changes.
- Plan05 and Plan06 remain blocked/in progress on real Hermes request-to-Epic/same-request restart, production ContextManifest implementation/acceptance, supported-platform Config acceptance, and Ubuntu keyring evidence. Plan05's whole-plan review still has blocking acceptance gates; Plan06's approved plan-consistency review does not clear its implementation gates. Schema v1 is the first supported Project Config format; no predecessor migration is applicable. Plan09 remains in progress without current-revision CodeQL/SARIF and dependent whole-plan review. These gates are NOT VERIFIED; no plan lifecycle is being closed.
- `git diff --check` PASS. No commit, push, merge, archive, inventory mutation or lifecycle closeout was performed.

## Дополнение от 2026-10-03 — решение пользователя по Plan16 и актуальный Plan20 checkpoint

- Пользователь подтвердил, что старые материалы Plan16 являются мусором и должны удаляться. Rebaseline сверил 97 путей: восемь существовавших tracked-файлов проверены по path/tracking/SHA-256 и удалены без архива в `966f1ec`; 75 путей уже отсутствовали, 14 актуальных README/инструкций/активных Plan15 путей сохранены. В этом inventory других точных целей удаления нет.
- Строка 418 и другие утверждения выше о запрете удаления/неизвестном archive destination относятся к snapshot на 2026-09-30 и superseded этим решением и точным rebaseline. Plan16 остаётся `blocked` по оставшимся README, command-matrix и governance acceptance criteria; его статус не менялся.
- На checkpoint `66a51b1` удалён Ebb provider-key bridge из Hermes process scope; production Run fail closed до безопасной Hermes-native реализации Task5B. Task5A code review повторно получил `APPROVED`, `pnpm test`, lint, typecheck, docs check и diff check прошли. Root `pnpm build` и Windows provider-free native acceptance также PASS в существующем VS2019 Developer Environment (6 passed, 2 Linux-only skipped). Sandbox-only test attempt падал до test body из-за blocked `os.userInfo()`; unsandboxed rerun прошёл. Linux native acceptance остаётся `NOT RUN` из-за WSL `Installing`/`WSL_E_DISTRO_NOT_FOUND`; provider acceptance также `NOT RUN`. Plan05/06/19/20 статусы не менялись.
- Проведённая read-only all-plan recovery подтвердила, что прежние audit streams остаются частичными: полной requirement/code/test/acceptance/evidence/checklist матрицы на каждый план в репозитории пока нет. Её нужно создать и завершить после текущих implementation/review gates; metadata `completed` не служит доказательством.

## Дополнение от 2026-10-03 — интеграция Hermes readiness и scout evidence

- Свежий unsandboxed `pnpm hermes:check` завершился exit 0: все 8 checks `PASS`, `All checks passed.` Это read-only CLI/project readiness; provider/API/model request не выполнялся. Developer preflight подтверждён, а реальные Hermes provider acceptance для Plan04/05/07 остаются `NOT RUN`/открытыми.
- Plan09 read-only scout проверил HEAD `48936eec0c6d5ee8b8c1c7693bb7778d01c4698c`: доступный успешный hosted CodeQL run `36944963382` относится к `master` SHA `6eb51ae1ee11c37b851cf2fc492f49d8ad738844`, а не к этому HEAD. Локальные CodeQL и Semgrep отсутствуют; поддерживаемый repository route — обычный push на `master` после фиксации окончательного проверенного SHA (`workflow_dispatch` отсутствует). В текущей revision и в более поздних незакоммиченных source edits нет подтверждённого CodeQL/SARIF evidence. Task8 остаётся `NOT VERIFIED`; Plan09 lifecycle/checklist не менялись.
- Plan16 archive/rebaseline blocker superseded: прямое указание пользователя исполнено для ровно восьми tracked targets после 97-path rebaseline в commit `966f1ec`; ещё 75 путей уже отсутствовали, 14 preservation paths сохранены. Inventory не даёт дополнительных delete targets. Plan16 остаётся `blocked` по незавершённым README, command-matrix и governance acceptance criteria; новые удаления/перемещения/архивирование этим disposition не разрешены.
- Повторный all-plan audit ещё не сформировал полную матрицу `requirements → code → tests → acceptance → evidence → open checklist` для каждого плана, кроме Plan14. Metadata `completed`, прежние audit summaries и unchecked procedural marks сами по себе не доказывают завершение. До завершения матрицы спорные планы остаются на evidence reconciliation; Plan05/06/19 lifecycle metadata и checklists не изменены.
- `docs/roadmap/generated.md` сверена с Plan metadata: в реестре есть `plan-20 | in_progress` и `plan-19 | in_progress`; изменений статусов не было, поэтому generated register не перегенерировался.
- После независимого blocker finding по наследованию systemd manager environment supervisor запускает wrapper через `/usr/bin/env -i` с проверенным allowlist, без чтения manager environment и без `--setenv`. Изменение и regression coverage зафиксированы в `d37e691`; focused suite прошёл 15 тестов, 7 platform-specific cases пропущены, server typecheck и scoped ESLint прошли; повторный scoped review — PASS. Это закрывает только найденную code issue: Linux native acceptance остаётся `NOT RUN`, Task5A и Plan20 lifecycle не закрыты.
- Свежая read-only WSL диагностика нашла `Application Error 1000`: `wslservice.exe` падал внутри `OldNewExplorer64.dll` v1.1.8.1 с `0xc0000005` в 07:35:50 и 07:39:26; `Service Control Manager 7034` фиксировал остановку WSL Service в 07:35:54 и 07:39:39. Тот же DLL также связан с повторными падениями SearchIndexer. Это сильная причина проверить DLL interference, но не доказывает, что она единственная причина нынешнего `Installing`. `consent.exe` live, однако его target/parent не удалось прочитать; действия с OldNewExplorer или reboot не разрешены и не выполнялись. `wsl --list --online` подтверждает `Ubuntu-26.04` как новейшую доступную Ubuntu LTS.

## Дополнение от 2026-10-03 — пользователь прекратил установку Linux; свежая сверка Plan09

- После последней elevated-проверки пользователь прямо распорядился прекратить работу по установке Linux и продолжить остальные независимые задачи. Ubuntu больше не запускается, повторно не устанавливается и не удаляется; неизвестный системный запрос не подтверждается. Последняя проверка показывала единственную запись `Ubuntu-26.04 / Installing / WSL2`; `wsl --update`, MSI и общий Windows consent prompt оставались активны, но цель consent не была установлена. Windows/OldNewExplorer configuration не менялась.
- Linux native acceptance Plan20 Task5A остаётся `NOT RUN`; пользовательское решение остановить provisioning не является acceptance и не меняет checklist/lifecycle. Зависимые Task5B/5C не начинаются без требуемого Task5A PASS; Plan20 остаётся `in_progress`.
- Независимый Plan09 scout проверил текущий HEAD `81a2f32759ca9617a33ced23c8b9b3fae1bc3652`. CodeQL/Semgrep локально отсутствуют; tracked current-SHA SARIF не найден. Workflow `.github/workflows/codeql.yml` запускается на push в `master`/`develop`, PR в `master` и weekly schedule; `workflow_dispatch` нет. Запрос GitHub API текущих runs завершился блокировкой сетевого доступа (`connectex ... forbidden by its access permissions`), поэтому наличие hosted scan этого SHA не установлено. Единственный известный успешный run `36944963382` покрывает старый SHA `6eb51ae1ee11c37b851cf2fc492f49d8ad738844`. Plan09 source scan/SARIF и findings disposition остаются `NOT VERIFIED`; fake PASS не выставлялся, push не выполнялся.
- Preliminary all-plan recovery остаётся незавершённой: нужна проверяемая матрица requirements → code → tests → acceptance → evidence → open checklist для каждого плана, кроме Plan14. Plan16 продолжает независимую README/command-matrix/governance работу; дополнительных файловых операций не требуется.
- Статусы Plan05/06/09/16/19/20 и их закрывающие checklists этой сверкой не изменены; `docs/roadmap/generated.md` не перегенерировался, поскольку lifecycle metadata не менялась.

## Дополнение от 2026-10-03 — повторная сверка Plan00–02

- Plan00: текущий evidence подтверждает supersession прежних naming/roadmap требований, однако acceptance criterion о полной документации `docs/README.md` остаётся открытым до завершения связанных README obligations Plan16. Независимый актуальный whole-plan review Plan00 не получен.
- Plan01: свежий `pnpm plan01:acceptance` на HEAD `81a2f32759ca9617a33ced23c8b9b3fae1bc3652` (source unchanged) завершился `PLAN01_PROCESS_RECOVERY_ACCEPTANCE=PASS`, exit `0`; migrations unchanged, pending event retried, expired lease recovered, `READY` after restart, second instance rejected, owned processes/temp home cleaned up. Это закрывает только stale targeted-acceptance evidence gap; актуальный независимый whole-plan review остаётся открытым.
- Plan02: полный `pnpm test` на текущем checkout прошёл (1,144 passed, 21 skipped; root scripts 22/22), что закрывает только свежесть полного test-suite evidence. В frontmatter Plan02 исправлена ссылка на существующую scheduler suite `apps/server/test/modules/scheduler/`; независимый актуальный whole-plan review остаётся открытым.
- На момент этой первичной сверки актуальные whole-plan reviews ещё не были подтверждены; более поздний Plan01 review `CHANGES_REQUIRED` зафиксирован ниже. Независимые whole-plan reviews Plan00 и Plan02 остаются открытыми. Lifecycle statuses и task/acceptance checklists всех трёх планов не менялись.

## Дополнение от 2026-10-03 — Plan01 whole-plan review findings

- Свежий независимый review Plan01 завершился `CHANGES_REQUIRED`. Подтверждён blocker: штатный shutdown не координирует остановку активных Run process scopes до закрытия БД/освобождения lock; см. `spec-01 §19.5`, `apps/server/src/main.ts`, `platform/process/system-lifecycle.ts` и `modules/runtime/run-service.ts`. Startup preflight умеет остановить оставшиеся scopes на следующем запуске, но не заменяет shutdown contract. Требуется scoped fix и regression acceptance; изменений План05/06/19 statuses это не разрешает.
- Reviewer также отметил отсутствие отдельного artifact hash-mismatch test, отсутствие свежих quality gates в Plan01 completion evidence и неразрешённые dispositions старых 40 procedural checklist marks. Код `artifact-store.ts` уже переводит несовпавший STAGING hash в `MISSING`; нужно добавить тестовое покрытие, а не менять это поведение без отдельного дефекта.
- Plan01 supplemental acceptance от 2026-10-03 остаётся валидным для своего bounded restart/recovery сценария, но не закрывает shutdown blocker или whole-plan review. Перед повторным review будут выполнены свежие gates, а legacy checklist items сопоставлены с evidence либо явно оставлены историческими без ложного PASS.
- Plan01 review/fix loop открыт; lifecycle statuses и checklists Plan01/05/06/19/20 не менялись.

## Дополнение от 2026-10-03 — продолжение после остановки WSL/Linux

- По прямому указанию пользователя работа по Linux/WSL прекращена; к установке, обновлению или удалению дистрибутивов и подтверждению системных запросов не возвращаться. Это не является Linux acceptance и не снимает platform gate Plan20.
- Свежий независимый re-review матрицы Task 5 Plan16 завершился `APPROVED`: все 28 ссылок на строки README сверены с фактическими командами, включая `README.md:338`, `README.md:442–443` и package commands `README.md:337–349`. Первоначальное замечание о stale refs уже не применялось к текущему дереву. Это одобряет проверенную матрицу, но не закрывает Task 5/Plan16: оставшиеся команды и общие Task 9 gates ещё требуют evidence; lifecycle/checklists не изменены.
- В Plan01 добавлено датированное сопоставление 40 исторических procedural steps (8 × 5) с текущими implementation/test artifacts. Ни один checkbox не отмечен: текущие artifacts и SHA подтверждают provenance, но не доказывают исторический порядок или RED-stage failures. Supplemental `pnpm plan01:acceptance` покрывает restart/recovery, но не shutdown.
- Отсутствующее покрытие hash-mismatch artifact получило regression test; focused команда `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/artifacts/artifact-store.test.ts` завершилась `PASS` (1 файл, 9 тестов). Production code не менялся; полный quality gate и свежий Plan01 review остаются открытыми.
- Plan20 Task 6 (safe manifest API/UI acceptance) и независимый whole-plan review Plan02 выполняются отдельно. Task5A Linux acceptance остаётся `NOT RUN`; Task5B/Task5C не запускаются без полного Task5A PASS. Статусы Plan01/02/16/19/20 и generated roadmap этой сверкой не менялись.

## Дополнение от 2026-10-03 — новые Plan02 и Plan20 review/acceptance findings

- Независимый whole-plan review Plan02 завершился `CHANGES_REQUIRED`. Подтверждён production gap: failure path `run-event-handlers.ts` переводит Task в `FAILED` и освобождает reservation, но не вызывает Recovery; `RecoveryService` и `recovery_scheduler_requests` используются модулем/тестами, а Scheduler не читает persisted requests. Plan02 явно требует Recovery → Scheduler request, поэтому сценарий failed runtime → Recovery → durable scheduling/dispatch остаётся незакрытым.
- Пользовательским решением от 2026-10-03 зафиксирован Scheduler policy contract: category order остаётся строгим первым ключом; после прохождения всех non-capacity gates возраст задачи, ожидающей capacity, повышает enum-priority на один уровень за каждые полные 24 часа до `Critical`; начало ожидания хранится durable в UTC и сбрасывается при non-capacity gate, выходе из capacity wait и dispatch, а legacy rows остаются `NULL` до первой свежей eligible-capacity observation. Critical path — самая длинная forward-цепочка unfinished `BLOCKING` tasks, по одному unit на задачу; его длина сравнивается только при равном aged priority внутри category, не суммируется с priority; ties разрешаются по `created_at`, затем `id`. Контракт документирован в `spec-01 §8.1` и Plan02 Task5; implementation отсутствует.
- Engineering gaps по Scheduler остаются открытыми: durable timestamp/reconciliation и scoring не реализованы; требуется additive forward migration без переписывания истории, с сохранением строк `context_deltas` и обеих FK-семантик, плюс acceptance для thresholds, gates, durable restart/read-only queries, reset, strict category, branching/terminal/leaf paths, deterministic ties и graph-integrity error на persisted cycle. Указанный выше production failure → durable Recovery request → Scheduler dispatch wiring также отсутствует. Статусы, checklists и roadmap этим обновлением не меняются.
- Первый независимый review policy-amendment Plan02 завершился `CHANGES_REQUIRED`: отсутствовали вызываемый production path для durable wait reconciliation, RED до реализации новых policy behaviors и точные migration suites с совместимым покрытием catalog 039→040. Эти три finding были внесены в Task5/spec. Последующий независимый review закрыл их, но оставил вердикт `CHANGES_REQUIRED` из-за двух подтверждённых `IMPORTANT`: нужно однозначно закрепить sole-writer/reconcile/atomic-dispatch границу и проверить одновременные capacity+budget gates, где ранний `wait_reason` скрывает budget. Требования добавлены в `spec-01 §8.1` и Task5; implementation не начиналась. Нужен новый независимый review amended policy до разрешения реализации.
- Отдельный production-consumer gap остаётся открытым: `startWorkflowRuns()` содержит ordered queue selection, но не имеет production caller. Runtime/routes/Epic сейчас используют targeted `dispatchTask()` call sites, а периодический safety tick выполняет только reconciliation и не доказывает priority ordering. Task6 должен подключить production Scheduler→Runtime event/queue consumer к Task5 ordered selection и проверить конкурирующие READY tasks при ограниченной capacity; targeted dispatch не должен обходить selection, кроме доказанного единственного eligible candidate. Пока эта интеграционная acceptance не выполнена, production scoring/dispatch ordering остаётся неподтверждённым. Production failure → durable Recovery request → Scheduler dispatch gap из первого пункта также остаётся открытым.
- Review также не признал общий `pnpm test` evidence достаточным для двух production требований и обнаружил, что focused команды вида `pnpm --filter ... test -- <file>` могут передать буквальный `--` и запустить невыбранные suites. Нужна проверенная точечная форма команд. Более сильный Epic и standalone E2E evidence найден и может заменить слабые ручные scenario references.
- Plan20 Task 6 API acceptance: `test/app/api.test.ts` PASS 22/22; `operations-views.test.tsx` PASS 18/18. Браузер дал 6/6 assertions, однако полный `test:e2e` launcher завершился exit `1`: Windows `taskkill.exe` получил Access Denied и не остановил принадлежащий E2E Vite child. Exact PID был остановлен; node/browser PID inventory вернулся к baseline, временный home очищен. Это `NOT PASS` до диагностики причины и полного launcher exit `0`.
- По официальной текущей документации Hermes отдельный standalone setup использует `hermes model`/`hermes auth`; это не доказывает поддержку command/profile пути pinned Hermes build или production profile isolation Ebb. `pnpm hermes:setup` остаётся только trust/delegation setup. Plan20 Task7 README/provider acceptance не выполнен; не менять user Hermes profile и не заявлять provider readiness.

## Дополнение от 2026-10-03 — Hermes setup documentation review

- Независимый reviewer выявил два замечания `IMPORTANT`, оба подтверждены (`VALID`): README и `docs/development/05-hermes.md` предписывали `hermes model` / `hermes auth --help` как setup flow, хотя evidence покрывал только help output; clean-checkout install → Hermes-native auth → harmless real provider Run walkthrough не был выполнен и не мог считаться документированным. Более раннее упоминание upstream Hermes docs в ledger — только справочный источник, не pinned-CLI verification и не acceptance.
- Устранена вводящая в заблуждение часть: эти команды удалены из actionable setup sequences. Help results остаются только в Plan16 command/evidence matrix; wizard, native-auth flow и provider request помечены `NOT RUN / NOT VERIFIED`. Документы сохраняют правило, что provider credentials принадлежат Hermes-native auth и не дублируются в Ebb `.env` или Ebb SecretStore.
- Точное ограничение: полный pinned-Hermes clean-checkout walkthrough и real provider Run не подтверждены. `pnpm hermes:setup` покрывает только project trust/discovery/delegation, а `pnpm hermes:check` — CLI/project prerequisites, не provider acceptance. Production per-Run auth/session остаётся gated на Plan20 Task5A → Task5B → Task5C.
- Для сохранения gates Linux/WSL, профиль Hermes, auth state и provider не трогались; Task5A/5B/5C не обходились. Plan16 Task6/Plan16 и Plan20 Task7 остаются открытыми; statuses, generated roadmap и checklists не изменены.

## Дополнение от 2026-10-03 — Plan20 Tasks 0–4 revalidation

- На HEAD `81a2f32759ca9617a33ced23c8b9b3fae1bc3652` Task0 documentation/source readback подтвердил согласование spec §10.2 и §13.1, optional trusted `ContextBudgetPolicyV1`, сохранение роли Hermes как владельца native auth и superseded статус старого Ebb credential bridge. По pinned Hermes source выполнены только поддерживаемые field-scoped запросы: `hermes config get model.provider --json` вернул `openai-api`, `hermes config get model.default --json` — `gpt-6-luna`. Auth status/list, raw config, профиль, credential values и provider request не читались/не запускались. Безопасный запрос эффективного endpoint не найден: endpoint может приходить из нескольких слоёв, а URL может содержать секретные части. Поэтому Task0 остаётся частичным до безопасного endpoint evidence; эти значения не фиксируют поддерживаемую runtime matrix.
- Task1 fresh verification: `context-provenance.test.ts` — 19/19; server typecheck exit 0. Task2: migration/migrator suites — 20/20; проверки сохранили строки, schema/root-page/index и обе FK-семантики `context_deltas`, с пустым `foreign_key_check`. Task3 baseline suites — 79/79 для builder/selector/assembler и 13 subject-role pairs.
- Task3 source review обнаружил старый orphaned `ContextDelta.isResumeSafe()`, который объявлял частичные изменения guideline/finding/defect безопасными для resume. Это противоречило `context_hash` contract и diagnostic-only роли `ContextDelta`. Production callsite не найден; helper, `ResumeSafetyResult`, `MATERIAL_FIELDS` и устаревшие policy assertions удалены, diagnostic `compare()` сохранён. Новая regression сначала упала ожидаемо (`1 failed, 27 passed`), после удаления helper focused suite прошёл 23/23. Независимый scoped review: PASS, finding ADDRESSED, новых замечаний нет.
- Task4 production bindings acceptance: пять suites — 85 passed, 1 skipped, exit 0; проверены 18 source-backed producer bindings и 3 event-consumer cases. Единственный skip — `planning-run-binding.test.ts:65`, capability capture test, ограниченный поддерживаемой платформой; он не засчитан как PASS. Свежий независимый review Tasks1–4 завершился `APPROVED`, без BLOCKER/IMPORTANT. Один MINOR follow-up: `ContextDelta.compare()` сравнивает membership ID и версию контракта, но не item digest/version V2; production consumer сейчас не найден, поэтому это не блокирует Tasks1–4; покрытие provenance tuples потребуется до подключения диагностики к V2 UI/recovery.
- После Task3 fix свежие root gates: `pnpm lint` PASS; `pnpm typecheck` PASS; `pnpm test` PASS — 123 server test files passed, 1 skipped; 1,141 server tests passed, 21 skipped; root scripts 22/22. `pnpm docs:check` PASS, `pnpm docs:test` 20/20 PASS, `git diff --check` PASS. README/Hermes docs review подтвердил исправление непроверенных setup-команд; полный pinned clean-checkout + real provider Run walkthrough остаётся IMPORTANT acceptance gap Plan20 Task7/Plan16.
- По прямому указанию пользователя Linux/WSL больше не запускается. Plan20 Task5A Linux acceptance — `NOT RUN`; Task5B/5C остаются gated, а Task7, Plan16 и Plan20 не закрыты. Plan01 artifact hash-mismatch test review — PASS, его единственный MINOR wording finding исправлен; Plan01 всё ещё открыт из-за shutdown contract. Lifecycle statuses, acceptance checklists и generated roadmap этой сверкой не менялись.

## Дополнение от 2026-10-03 — продолжение без Linux и свежая проверка Plan09

- На чистом HEAD `b153907a9b30746a25c89c2c8f2d2b52e460aa0d` повторно проверен точный Plan09 scan evidence. Локальных CodeQL/Semgrep CLI и tracked SARIF/report нет. `gh run list --workflow codeql.yml --commit b153907a9b30746a25c89c2c8f2d2b52e460aa0d --json databaseId,headSha,event,status,conclusion,createdAt,url` вернул `[]`; `gh api 'repos/vivernet/ebb-orchestrator/code-scanning/analyses?ref=refs/heads/develop' --jq 'map(select(.commit_sha == "b153907a9b30746a25c89c2c8f2d2b52e460aa0d"))'` вернул `[]`. Следовательно Plan09 и Plan19 Task8 остаются `NOT VERIFIED`; прежние сканы других SHA не заменяют этот gate.
- Поддерживаемая workflow запускается на push в `master`/`develop`, PR в `master` и weekly schedule; `workflow_dispatch` отсутствует. Проверка exact-SHA была read-only; push и изменения GitHub auth/config не выполнялись. После окончательного кода и reviews потребуется обычный разрешённый push финального SHA в `develop`, затем read-back завершённого CodeQL run, анализа для этого SHA и findings disposition.
- Hermes read-only проверки вне sandbox: `hermes --version` — exit `0`, `Hermes Agent v0.21.5+5778.g0a374d1`, source `0a374d16`; `hermes model --help` и `hermes auth --help` — exit `0`. Это подтверждает доступность CLI-команд и формы справки, но не выполнение wizard/native auth, не изменение профиля, не credentials и не provider request. Поэтому clean-checkout native-auth/provider walkthrough Task7 остаётся открытым.
- Read-only Plan16 audit подтверждает: точная очистка восьми rebaselined files и сохранение 14 paths уже доказаны; README command-matrix получила независимый `APPROVED` для 28 ссылок, но это не закрывает весь Task5 — часть invocations остаётся `NOT RUN / NOT VERIFIED`. Открыты проверки полного README/docs README содержания, links/UTF-8/Russian prose, skills inventory consistency, Plan16 ISO date snippet/generated-artifact absence, `pnpm build`, `pnpm server:build`, `pnpm web:build` и финальный whole-plan review. Task7 `.gitignore`/`AGENTS.md` имеет обоснованное no-change решение. План не завершён, новые файловые операции не выполнялись.
- После добавления этого evidence выполнены `pnpm docs:check` (PASS), `pnpm docs:test` (20/20), `pnpm docs:rename:check` (43 entries, PASS), `pnpm skills:test` (30/30), README/Hermes guide UTF-8 readback и Plan16 ISO-date validator (PASS). Это закрывает только соответствующие bounded checks; полный Plan16 Task5/6 acceptance не заявляется.
- Build gates сначала подтвердили средовую причину: обычный `pnpm build` и повтор под установленным VS2022 завершились `WINDOWS_PROCESS_SCOPE_BUILD_TOOLS_UNAVAILABLE`; VS2022 BuildTools присутствует без `cl.exe`. Поддерживаемый установленный VS2019 Developer Environment v16.11.40 / MSVC 14.29 собрал helper: `pnpm build` PASS, затем exact `pnpm server:build` PASS. Параллельный вызов `pnpm web:build` с server build временно не разрешил `@ebb-orchestrator/contracts` из-за shared `contracts/dist` cleanup; после завершения server build отдельный последовательный `pnpm web:build` PASS. Успешная Vite сборка вывела non-fatal chunk-size warning.
- Сгенерированные сборками `apps/server/dist`, `apps/web/dist` и `packages/contracts/dist` проверены как директории внутри репозитория, ignored и не содержащие tracked files, затем удалены точечным cleanup; temp `.cmd` launcher был удалён в `finally`. `git diff --check` прошёл; рабочее дерево содержит только этот reconciliation document. Exact-SHA CodeQL readout addendum получил независимый re-review PASS после добавления воспроизводимых команд и фильтра.
- По прямому указанию пользователя Linux/WSL не запускался и не изменялся. Plan20 Task5A Linux native acceptance остаётся `NOT RUN`; зависимые Task5B/5C не запускались и не обходились. Текущие plan lifecycle statuses, task checklists и generated roadmap не менялись.

## Дополнение от 2026-10-03 — Plan02 повторное policy review, queue gap и актуальный Plan09 scan path

- Пользователь уточнил tie-break Plan02: critical-path length сравнивается только между задачами с равным aged priority внутри категории. Это отражено в `spec-01 §8.1` и Task5 вместе со строгой категорией, aging по полным 24 часам, durable timestamp, simultaneous capacity+budget case, RED-first и миграцией 039→040 с preservation `context_deltas` и обеих FK-семантик. Свежий независимый review подтвердил Task5 policy и предыдущие sole-writer/capacity+budget/migration findings как закрытые.
- Тот же review завершился `CHANGES_REQUIRED` для Task6 по двум источниковым пробелам. `AgentRunRequested` имеет production consumer в `RuntimeOrchestrator`, но production producer не найден; `WorkflowEngine` записывает `TaskStateChanged`, на который Runtime не подписан; `startWorkflowRuns()` не вызывается production-кодом. `EventDispatcher` ограничивает повторные ошибки и отправляет событие в dead letter после пяти попыток, поэтому нехватку capacity нельзя превращать в ошибку handler и считать долговечной очередью.
- Production targeted callers в `runs.ts`, `run-event-handlers.ts` и `epic-orchestrator.ts` сначала отдельно создают Run через `prepareRun()`, затем пытаются dispatch. При отказе созданный Run завершается как failed; это не соответствует Task6 acceptance, где проигравший арбитража не должен создавать Run, и не обеспечивает повторный запуск запроса после ожидания.
- Source не определяет durable queue unit для отложенного вызова: explicit RunRequest с `taskId`/`role`/`model` либо READY Task, для которой роль/модель выбирает Scheduler и ручной caller должен повторить вызов после отказа. Этот продуктовый выбор запрошен у пользователя. До ответа Task6 остаётся `CHANGES_REQUIRED`; Plan02 implementation по изменённому dispatch path не начиналась, статусы/checklists/roadmap не менялись.
- Свежий read-only Plan09 scout проверил HEAD `9a9a8b08d6d5f252bb75d1fb1f65a522143763e0`: локального CodeQL/Semgrep и tracked SARIF/report нет; exact-SHA hosted analysis в этой проверке не запрашивался, поэтому его наличие не установлено. Единственный настроенный source-scan путь — `.github/workflows/codeql.yml` на push в `master`/`develop`, PR в `master` и weekly schedule; `workflow_dispatch` отсутствует. `production-gates.yml` dependency audit не является source scan. Plan09/Plan19 Task8 остаются `NOT VERIFIED` до read-back успешного CodeQL run/analysis для окончательного SHA и disposition findings; публикация ради запуска scan не выполнялась.

## Дополнение от 2026-10-03 — Plan20 повторное review

- Независимый read-only re-review Plan20 подтвердил, что четыре исходных blocking issues устранены: Plan05/06 названы downstream; исходный Hermes `session_id` фиксируется live init callback → SQLite CAS и читается после restart; остановка прежнего процесса подтверждается membership точного Windows Job или systemd/cgroup scope; семь ролей проверяются через 13 subject/role пар и 18 source-backed producer labels с публичными callsites. Также подтвердил решение пользователя по `ContextBudgetPolicyV1`: без trusted versioned limit сохраняется весь role-selected context, pruning отключён, `initialTokenSize = NULL`, fit не обещается; `context_deltas` и обе FK-семантики сохраняются.
- Review завершился `CHANGES_REQUIRED` по одному IMPORTANT: Plan20 требует стабильную provider-policy identity с model/endpoint, но не описывает безопасную стабильную идентификацию custom/private endpoint без записи или раскрытия URL. Это совпадает с уже заданным пользователю архитектурным вопросом о внутреннем HMAC fingerprint key либо fail-closed для такого endpoint; до ответа и обновления текста Plan20 approval не получен, реализация новых Task5B изменений не начиналась. Reviewer не смог повторно подтвердить pinned Hermes emitter из локального source; такой source re-audit остаётся обязательным перед live acceptance.
- В ходе review Task02 пользователь выбрал durable `RunRequest`, сохраняющий `taskId`, выбранные `role` и `model`, и автоматически ожидающий своей очереди после restart. Решение внесено в spec-01 §8.1 и Plan02 Task6: pending queue вместо dead-letter wait, request/status API, startup/event/safety-tick worker, одна транзакция на arbitration → Run/manifest → reservation/workflow/outbox, общий путь для route/Epic/Recovery, migration 041 и production competition/restart acceptance. Кодовая реализация не начиналась; новое независимое review этого amended contract ещё не получено.

## Дополнение от 2026-10-03 — Plan02 durable Task dispatch и актуальный Plan09 scan evidence

- Пользователь выбрал durable `RunRequest` для Task dispatch: сохранять `taskId`, выбранные `role`/`model`, переживать restart и запускать после доступности capacity/очереди. Пользователь также подтвердил strict category order, aging по полным 24 часам и critical-path только tie-break при равном aged priority. Эти решения отражены в `spec-01 §8.1` и Plan02; Task6 пока не реализован.
- Новое независимое Plan02 review подтвердило закрытие READY gate, deferred `AgentRunRequested` delivery, crash/replay, повторов `Idempotency-Key` после `DISPATCHED`, migration 040→041 и сохранение `context_deltas`. Остаётся CHANGES_REQUIRED по sole-writer consistency: Task5 ещё описывает atomic timestamp clear в `dispatchTask()`, а Task6/§8.1 различают durable RunRequest и approved-Epic recovery direct path. Пользователю задан один уточняющий вопрос, как совместить approved-Epic resume до System READY с новой очередью: recovery-only durable lane с category/aging order или прямой approved-Epic dispatch вне queue ordering. До ответа и последующего scoped review Plan02 не получает APPROVED; реализации и lifecycle-status changes нет.
- Read-only Plan09 scout на HEAD `9a9a8b08d6d5f252bb75d1fb1f65a522143763e0`, ветке `develop`, подтвердил: `codeql`/`semgrep` не установлены; `gh` найден, но `gh auth status` сообщает invalid token; GitHub API запросы запрещены сетевым ограничением Windows (`connectex` socket permissions). Это не результат scan и не доказывает отсутствие hosted analysis; Code Scanning analysis для этого SHA неизвестен, findings не установлены. Единственный настроенный source scan — `.github/workflows/codeql.yml` на push `master`/`develop`, PR в `master`, weekly schedule; `workflow_dispatch` нет. Plan09/Task8 остаётся `NOT VERIFIED` до успешного read-back CodeQL run и analysis на окончательный SHA с findings disposition.
- После текущих Plan02/spec правок `git diff --check` прошёл; `pnpm docs:check` PASS, `pnpm docs:test` PASS 20/20. Это только docs evidence; не запускались application tests/build/source scan и не менялись plan lifecycle/checklists/generated roadmap.
- Свежий Hermes readiness scout подтвердил средовой blocker sandbox, а не repository defect: внутри ограниченной сессии тот же обнаруженный `C:\Users\alex1\AppData\Local\hermes\bin\hermes.exe --version` завершается exit 1 без stdout; разрешённый read-only запуск того же executable вне sandbox возвращает `Hermes Agent v0.21.5+5778.g0a374d1`, exit 0. Внешний `pnpm hermes:check` завершился exit 0, все 8 проверок PASS; wrapper `scripts/hermes-dev.mjs` запускает `hermes --version` напрямую с `shell:false`. Провайдер, `hermes auth`, credentials, пользовательский профиль, install/update не трогались. Это закрывает только CLI/check readiness; реальный provider-backed acceptance по-прежнему `NOT RUN`.
- `pnpm docs:roadmap` успешно сгенерировал `docs/roadmap/generated.md` с 34 планами; readback показывает `plan-02` и `plan-20` как `in_progress`. Lifecycle статусы, task checklists и generated roadmap content не изменялись относительно source metadata; отдельный `docs/roadmap/registry.json` в проекте отсутствует.

## Дополнение от 2026-10-03 — pinned Hermes auth source и повторные Plan02/Plan20 blockers

- Read-only re-audit подтвердил совпадение локального Hermes source checkout, `install-stamp.json` и launcher path с чистым commit `0a374d167424cdc730ce9761368b62255b551e58` (`v0.21.5+5778.g0a374d1`); проверенные source blobs `hermes_constants.py`, `hermes_cli/auth.py` и `agent/credential_pool.py` совпадают с этим commit. Pinned `get_default_hermes_root()` отображает профиль только по layout `<auth-owning root>/profiles/<run-id>`; auth state и `credential_pool` могут fallback из свежего профиля к global/default store в том же root. Это доказывает source-supported lookup, не реальный provider/refresh request. Hermes-профиль `.env`, process environment и plugins не наследуются этим механизмом; credentials/live auth files не читались.
- Текущий production Ebb path хранит `HERMES_HOME` вне native auth-owning Hermes root, поэтому не видит уже настроенную Hermes native auth; запуск пока fail-closed (`HERMES_NATIVE_AUTH_NOT_READY`). Plan20 дополняется точным `/profiles/<run-id>` layout и обязательными Windows/Linux default/custom-root tests; реальный provider acceptance остаётся открытой.
- Свежий Plan02 review обнаружил cross-lifecycle blocker: исходный `/tasks/:id/dispatch` принимает Epic-owned Task, а approved Epic startup recovery может запустить ту же Task до READY, пока user `RunRequest` остаётся pending. Пользовательский выбор durable RunRequest A отражён в Plan02/spec-01; дополнительно запрошено продуктовое решение — запретить такие requests для Epic-owned Task либо атомарно помечать ожидающий request `SUPERSEDED_BY_EPIC`. До ответа и повторного review Plan02 не получает approval; implementation/status changes не выполнялись.
- Повторный Plan20 review подтверждает закрытие четырёх исходных blocking issues и находит единственный remaining blocker: безопасная стабильная identity для custom/private provider endpoint. Пользовательский выбор внутреннего защищённого HMAC key либо fail-closed для endpoint без безопасного stable ID запрошен отдельно; до ответа и повторного независимого review Plan20 approval отсутствует. Реализация Plan20 не начиналась.
- После текущих документных правок `pnpm docs:check` PASS, `pnpm docs:test` PASS (20/20), `git diff --check` PASS. Lifecycle metadata, task checklists и generated roadmap не изменялись.

## Дополнение от 2026-10-03 — ответы пользователя и согласование Plan16/Plan20

- Пользователь подтвердил вариант A для Task dispatch: сохранять durable `RunRequest` с `taskId`, выбранными `role`/`model` и idempotency key; запрос переживает restart и ждёт доступности capacity. Это решение уже отражено в `spec-01 §8.1` и Plan02 Task6; выбор больше не является открытым вопросом.
- Отдельное cross-lifecycle решение Plan02 остаётся ожидающим ответа: отклонять user RunRequest для Epic-owned Task либо принимать его, но при одобренном Epic-resume атомарно переводить запрос в `SUPERSEDED_BY_EPIC`. До ответа не менять эту семантику и не начинать реализацию Plan02.
- Закрывая повторный Plan20 review finding, Plan16 Task6 теперь сохраняет provider/model/native-auth инструкции как `NOT RUN` до Plan20 Task7; Plan20 владеет финальным проверенным provider/auth/Run/recovery content, а Plan16 после этого выполняет consistency/readback своей общей навигации и command matrix. Plan20 Task7 не ждёт завершения Plan16, поэтому обратная зависимость не вводится.
- Для custom/private provider endpoint пользовательского ответа о внутреннем HMAC не требуется: уже принятый Proposal09 прямо запрещает Ebb-owned HMAC/key и сохранение/хеширование endpoint URL. Plan20 закрепляет совместимый fail-closed исход `HERMES_ENDPOINT_ID_UNAVAILABLE`, когда pinned Hermes не даёт source-backed stable identity. Текущий независимый re-review проверит, что это закрывает старый finding без расширения auth-контракта. Реализация Plan20 не начинается до approval; фактические provider/auth acceptance остаются отдельными обязательными gates.
- После согласования Plan16/Plan20 ownership повторно выполнены `pnpm docs:check` (PASS), `pnpm docs:test` (20/20 PASS), `pnpm docs:roadmap -- --dry-run` (34 Plans; PASS) и `git diff --check` (PASS). Это только документные проверки; lifecycle status, checklists, generated roadmap content и код не менялись.

## Дополнение от 2026-10-03 — verified Plan16 package command prerequisites

- Точная README package-command matrix завершена. Из восьми package invocations прошли: server `typecheck`; `test:auth-contract` (2 files/12 tests); web `test` (22 files/219 tests); contracts `typecheck` и `test` (3 files/4 tests); testing `typecheck` и `test` (`--passWithNoTests`, пустой suite). Bare `pnpm --filter @ebb-orchestrator/server test` первоначально завершился `FAIL` (exit 1, 264.93s; 3 files failed/120 passed/1 skipped; 7 tests failed/1134 passed/21 skipped/10 unhandled) из-за отсутствующих `contracts/dist/index.js` и `apps/server/dist/main.js`.
- Root `pnpm test` сам строит contracts, но не server; clean-checkout server full test требует `pnpm server:build`. Обычный PowerShell `pnpm server:build` отдельно завершился `WINDOWS_PROCESS_SCOPE_BUILD_TOOLS_UNAVAILABLE` (14.98s) при отсутствующих `VCToolsInstallDir` и `cl.exe`; найденный VS 2019 BuildTools был активирован только в transient x64 Developer Environment. В нём `pnpm server:build` прошёл (14.87s), затем точная команда `pnpm --filter @ebb-orchestrator/server test` прошла (222.56s): 123 files passed/1 skipped; 1141 tests passed/21 skipped; Vitest duration 221.01s. Root `pnpm test` отдельно не запускался.
- Созданные только этими проверками `apps/server/dist` (220 files) и `packages/contracts/dist` (13 files) удалены после проверки containment, отсутствие tracked files и reparse points; оба пути теперь отсутствуют. Документация README/Plan16 указывает сборочную предпосылку и отделяет bare failure от post-build PASS. `docs:check` прошёл; `docs:test` 20/20; `docs:roadmap -- --dry-run` собрал 34 Plans; `git diff --check` прошёл. Новый scoped Plan16 review ожидает результата. Plan16 остаётся `blocked`; статусы, чеклисты и generated roadmap не менялись.

## Дополнение от 2026-10-03 — результат повторного Plan16 amendment review

- Независимый scoped re-review вернул `APPROVED` для README/Plan16 amendment: `pnpm server:build` стоит перед `pnpm test` в Quick Start и Quality, все Task5 README line anchors ведут на соответствующие команды, Windows x64 Developer-shell prerequisite согласован с фактическими build/test evidence, а Plan20 Task7 остаётся owner финальной provider/auth документации без обратной зависимости от Plan16. Предыдущие два review findings закрыты. Это approval только данного amendment; весь Plan16 не утверждён и остаётся `blocked` до остальных acceptance gates и последующей Plan20 documentation readback. Reviewer был read-only; статусы, checklists и generated roadmap не менялись.

## Дополнение от 2026-10-03 — итог свежего Plan20 re-review после ownership correction

- Независимый review повторно подтвердил устранение четырёх исходных blocking issues Plan20: downstream dependency direction, durable Hermes `session_id`, OS-owned stop evidence, и выполнимая матрица семи ролей/13 subject-role пар. Также подтверждены точный Hermes `/profiles/<run-id>` auth lookup layout, сохранение `context_deltas`/FK semantics и отсутствие Plan20→Plan16 dependency после правки документационной ownership. Review остаётся `CHANGES_REQUIRED` только до отдельного пользовательского выбора stable identity для custom/private endpoint (HMAC либо fail-closed) и следующего review. Plan20 не получил approval; реализации и status/checklist updates не было.

## Дополнение от 2026-10-03 — свежая сверка остатка Plan16

- Read-only Plan16 audit подтвердил актуальные bounded checks: `docs:check` PASS; `docs:test` 20/20; `docs:rename:check` 43 entries PASS; `hermes:test` 28/28; `skills:test` 30/30; `skills:dependencies:test` 7/7 (658 text paths); ISO-date snippet PASS; `docs:roadmap -- --dry-run` PASS для 34 Plans; `git diff --check` PASS. Проверки не создали артефактов; tracked filesystem inventory не повторялся.
- Удаление восьми ранее rebaselined targets и сохранение 14 путей остаются доказанными; новых archive/delete/move действий не требуется и не выполнялось. Task7 no-change решение по `.gitignore`/`AGENTS.md` подтверждено existing evidence.
- Plan16 Task5 ещё не reconciled: reviewer одобрил 28 README references, но остаются exact README/package `--filter` invocations со статусом `NOT RUN / NOT VERIFIED`; manifest scripts сами по себе не доказывают конкретные command invocations. `pnpm docs:link:sync` всё ещё указан как runnable README command, хотя выполняется с exit 1/unsupported. Быстрый пример `pnpm hermes:setup` нуждается в adjacent warning о side effect и запуске только в isolated copy. Содержательные README/Hermes-provider инструкции и реальные provider evidence зависят от Plan20; Plan20 Task7 пока указан как owner этих документов.
- Task9 и whole-Plan16 review остаются открытыми. Ранее собранные broad root gates требуется повторить на финальном source revision после более поздних `context-delta.ts` и artifact-test edits; текущие bounded docs/skills/date checks не заменяют эти gates. Plan16 остаётся `blocked`, checkboxes 366–370 не изменялись.

## Дополнение от 2026-10-03 — корректировка Plan01 lifecycle и reconciled CI evidence

- По свежему независимому Plan01 review `CHANGES_REQUIRED` lifecycle metadata исправлена `completed` → `in_progress`: shutdown не останавливает активные Run process scopes до закрытия БД/освобождения lock. Это только status correction; shutdown fix, acceptance, broad quality gates и repeat review ещё впереди, исторические Plan01 checkboxes не менялись.
- Прежняя exact list non-completed планов в ledger-07 содержала `plan-12` (`completed`) и пропускала `plan-02` (`in_progress`). Ledger-07 исправлен: `plan-12` убран из списка, Plan02 добавлен с актуальным Task6 decision/review state, Plan01 включён после status correction. `pnpm docs:roadmap` пересоздал 34-record registry; read-back подтверждает Plan01=`in_progress`, Plan16=`blocked`, Plan19/20=`in_progress`.
- Для текущего checkout последними повторно прошли `pnpm docs:check`, `pnpm docs:test` (20/20), `pnpm docs:roadmap -- --dry-run` (34 Plans) и `git diff --check`. Root gates и browser E2E на HEAD `5423594` не считаются свежими для `9a9a8b08d6d5f252bb75d1fb1f65a522143763e0`; Plan19 Task9 остаётся открытым.

## Дополнение от 2026-10-03 — read-back hosted CodeQL evidence и старого production-gates run

- GitHub Actions read-back для опубликованного `master` SHA `6eb51ae1ee11c37b851cf2fc492f49d8ad738844` подтвердил CodeQL workflow run `36944963382`: run и job `Analyze JavaScript and TypeScript` завершились `success`; job log сообщает CodeQL CLI 2.27.1, успешное сканирование 403/403 TypeScript, 54/54 JavaScript, 11/11 HTML и 3/3 GitHub Actions files, `Successfully uploaded results` и `Analysis upload status is complete`. Это реальное scan/upload evidence именно для этого удалённого SHA; отдельный Code Scanning analysis/findings read-back и disposition findings не получены.
- Текущий локальный `develop` HEAD `9a9a8b08d6d5f252bb75d1fb1f65a522143763e0` отсутствует на GitHub: commit lookup не нашёл SHA, ветка `develop` отсутствует, а Actions-запрос по этому SHA вернул `total_count=0`; diff от сканированного `6eb51ae…` содержит 42 изменённых source/test paths. Поэтому CodeQL evidence для `6eb51ae…` не закрывает Plan09 gate для окончательного локального/final SHA. Push или запуск workflow не выполнялись; Plan09/Plan19 Task8 остаются `NOT VERIFIED` до успешного CodeQL run и analysis read-back на финальный SHA с установленным findings disposition.
- Отдельный remote `production-gates` run `36944963399` относится к тому же старому `master` SHA, не к текущему локальному HEAD. Read-back jobs/logs показал: обе Node 24/26 lint matrix jobs завершили `Lint` с четырьмя ESLint errors — недопустимые JSDoc tag names `precondition`/`sideEffects` в `apps/server/src/modules/planning/epic-orchestrator.ts:783–784` и два unused `projectId` в `apps/server/test/modules/planning/coordinator-planning-job.test.ts:94,115`; последующие typecheck/tests/build/E2E/integrity/browser steps были skipped. `pnpm audit --prod --json` вернул failure, audit artifacts `11201945655` и `11201826168` загрузились, затем explicit audit gate failed; доступные logs не раскрывают advisories, artifact contents не проверялись, поэтому выводов о наличии или количестве advisories нет. Windows native process-scope acceptance job завершилась `failure`: 8 tests, 5 passed, 2 skipped, 1 failed; child process теста timed out after 15,000 ms, после чего возник `WINDOWS_HELPER_CRASH_SCOPE_CLEANUP_ERRORS`. Linux acceptance job была cancelled; Ubuntu и Windows keyring acceptance jobs passed. Эти старые remote результаты не заменяют свежие локальные gates или окончательную Plan20 acceptance и требуют отдельной сверки при соответствующем whole-plan/recovery review.

## Дополнение от 2026-10-03 — Plan20 readiness approved после endpoint-identity re-review

- На `develop` HEAD `00e36c0842e001c0a4f6d28042f74dbf063a8c55` свежий независимый whole-plan review Plan20 вернул `APPROVED`, без blocking/important findings. Reviewer повторно подтвердил: Plan20 не зависит от Plan05/06; durable Hermes `session_id` CAS/readback переживает restart; STOPPED доказывается точным Windows Job Object либо Linux systemd/cgroup scope; семь ролей покрываются 13 subject/role pairs, 18 producer labels и тремя отдельными consumer cases; migration acceptance сохраняет строки `context_deltas`, обе FK и `CASCADE`/`SET NULL`; ContextBudgetPolicy A согласован. Это approval readiness плана, не implementation completion.
- По требованию пользователя provider selection/configuration и авторизация остаются исключительно у Hermes. Resume fingerprint принимает только source-backed mutation-sensitive provider/endpoint identity/revision из поддерживаемой Hermes config; неизменного alias недостаточно, если `api`/`base_url` может измениться. Если pinned Hermes не докажет revision, меняющуюся при каждом effective endpoint change, Plan20 требует `HERMES_ENDPOINT_ID_UNAVAILABLE` и отказ до Run/manifest/resume. Raw URL/URL hash, дополнительный HMAC key, Ebb SecretStore mapping и root `.env` provider settings запрещены.
- Реальный provider-backed acceptance разрешён только для уже выбранных provider, endpoint, model и native auth в Hermes. Не создавать второй provider setup или credential; для не выбранного custom/private endpoint допустимы только projection/fail-closed checks, а live acceptance остаётся `NOT RUN`.
- После интеграции findings прошли `pnpm docs:check`, `pnpm docs:test` (20/20) и `git diff --check`. Менялись только Plan20, Proposal09 и `spec-01`; код, статусы/checklists Plan05/06/19, generated roadmap и данные `context_deltas` не менялись. Plan20 всё ещё `in_progress`; его runtime/auth/session acceptance, Linux Task5A evidence, Plan05/06 sub-obligations и Plan19 closure остаются открытыми. WSL/Linux локально не запускались согласно более позднему указанию пользователя.

## Дополнение от 2026-10-03 — возобновление после безопасной паузы

- Повторная проверка текущего установленного Hermes выполнена только в read-only режиме: `hermes --version` PASS (`v0.21.5+5778.g0a374d1`), `pnpm hermes:check` PASS — 8/8 checks. В sandbox обе команды раньше завершались exit 1: установленный `hermes.exe` находился в PATH, но sandbox запрещал доступ к его bundled Python; повтор вне sandbox прошёл. Это ограничение процесса проверки, не дефект wrapper/repository. Hermes profile, credentials, PATH и внешняя конфигурация не менялись; provider request не выполнялся.
- GitHub Actions run `37144265580` проверен read-only для исходного опубликованного SHA `f4494b5f14925b04d3416e5d48339848d3e0fe74`: Windows process-scope acceptance завершилась `failure` из-за 15-секундного crash-cleanup timeout; Linux job оставалась `queued` на недоступной self-hosted метке. Linux quality matrix также показала отсутствие собранного `apps/server/dist/main.js` при clean checkout и несоответствующий актуальному `RunService` тестовый `contextInput`.
- В текущем рабочем diff `pnpm test` первым шагом собирает production server (включая contracts), workflow удаляет дублирующую server build-команду, а Project Config regression передаёт canonical `createRunContextInput`. Windows cleanup regression не запускает повторное завершение scope после уже успешного recovery. Свежая локальная provider-free Windows acceptance прошла: 6 passed, 2 Linux-only skipped; весь local `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` ранее завершился успешно на этом worktree. Отдельный workflow-contract suite после исправления — 10/10 PASS.
- Чтобы получить Linux evidence без WSL, provider-free job перенесена на GitHub-hosted `ubuntu-24.04`; workflow поднимает transient runner-user systemd manager, задаёт `XDG_RUNTIME_DIR`/D-Bus и сохраняет явные cgroup-v2/systemd prerequisite checks. Независимый review workflow и assertions — `APPROVED`. Реальный hosted Linux native acceptance ещё не запускался; Task5A остаётся открытой до нового Actions run с успешным acceptance.
- Task6 разрешено выполнять параллельно с Task5A, поскольку его зависимости — только Tasks2 и 4. На текущем дереве API acceptance прошла 22/22, component — 18/18, browser — 6/6 с exit 0 и доказанным process/home/port teardown на повторном запуске вне sandbox; первый запуск не принят из-за teardown denial. Независимый read-only reviewer одобрил scoped closure Task6. Task5B/5C по-прежнему ожидают полного Task5A PASS, Task7 — Tasks0–6 и реального provider-backed Run. Plan05/06/19 lifecycle статусы не менялись.
- Plan09 source-scan gate остаётся `NOT VERIFIED` для финального SHA: успешный старый CodeQL run не покрывает текущие изменения; `pnpm audit` его не заменяет. Plan19 Tasks8–9 и whole-plan reviews остаются впереди.
