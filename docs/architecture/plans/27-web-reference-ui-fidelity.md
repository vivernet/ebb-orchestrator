---
id: plan-27
kind: plan
status: planned
title: 'Web UI по reference-ui: визуальная точность и backend-покрытие'
summary: 'Точное компактное соответствие Web UI всем десяти reference-ui макетам с закрытием необходимых backend API, durable state и проверок.'
created: 2026-10-25
updated: 2026-10-25
depends_on:
  - plan-25
specs:
  - ../specs/01-system-design.md
  - ../specs/02-web-ui-recovery-design.md
---

# Web UI по reference-ui: визуальная точность и backend-покрытие

**Статус:** план одобрен независимым review и пользователем; implementation ещё не начата.  
**Цель:** привести production Web UI в компактное и плоское соответствие всем 10 референсам и закрыть backend/API/state gaps для каждого показанного поля и действия.  
**Authority:** одобренный `web-ui-redesign-design.md`; `docs/architecture/reference-ui/01-dashboard-concept.html`–`10-agent-run-detail-concept.html`; `docs/architecture/specs/01-system-design.md`; `docs/architecture/specs/02-web-ui-recovery-design.md`; `docs/architecture/policies/branch-and-release-policy.md`; текущие contracts, routes и read models.  
**Зафиксированная база:** `develop` / `b37e87b268c6ac436a98013094bdfbce326bbd4d`; рабочая копия чистая. Предлагаемая task branch: `web-reference-ui-fidelity`, pinned source/base — актуальный `develop`. Перед implementation проверить актуальный pinned SHA и создать изолированный worktree согласно `ebb-worktree`; не начинать код в `develop`. Интеграционный путь определяется фактическим наличием опубликованного production release на момент старта: до первого release — проверенный direct fast-forward; после — reviewed squash PR с target `develop`, без local merge. Ничего не предполагать по старому статусу. В обоих режимах отдельно фиксировать approved/reviewed task SHA и integrated source SHA, затем запускать обязательные post-integration gates на фактически интегрированном SHA.
**Архитектура:** React UI остаётся presentation/client layer; Fastify, доменные сервисы и typed contracts владеют состояниями и решениями. Каждое production-поле получает реальный backend projection/детерминированный derivation либо явное `unavailable`; каждое действие — backend-owned transition с проверяемым результатом. Макеты задают визуальную композицию, но их фиктивные данные и устаревшие product claims не копируются.  
**Глобальные ограничения:** не обходить Action Gateway, Permission Engine, approvals, scheduler admission или Git policy; не показывать secrets; не выполнять скрытые shell/hooks/network; все UI-тексты по-русски; миграции только forward; не выполнять release/merge/push/commit без отдельного разрешения. Все тестовые данные остаются только в deterministic test harness.  
**Specialist constraints:** `ebb-database-engineering` для migrations/data/recovery; `ebb-security-review` для config-file writes, run controls, events/terminal и secret handling; `ebb-web-e2e` для реального HTTP/process/browser пути; `ebb-maintain-project-docs` для changed-scope README/API/config claims; независимый `ebb-final-review` перед готовностью ветки.  
**Review focus:** (1) все 10 production screenshots действительно соответствуют HTML-референсам; (2) pause admission проверяется внутри scheduler transaction; (3) кооперативная Run pause не выдаёт успех до безопасного checkpoint и не теряет provenance при resume; (4) cancel-all ограничен подтверждённым набором Run и сообщает частичный результат; (5) Settings candidate не становится active до отдельного approval и безопасно восстанавливается при сбое записи; (6) metrics/evidence не выдумываются и секреты не утекут.  
**Execution policy:** implementer/reviewer — task subagents согласно проектным правилам; одновременно максимум 2 активных subagents всех ролей; controller только координирует/интегрирует.  
**Integration evidence:** зафиксировать отдельно reviewed task SHA и интегрированный `develop` SHA; после интеграции повторить обязательные gates на фактическом SHA. Этот план и завершение UI не запускают release.

**Каноникализация до исполнения:** этот review-approved план сохранён как `docs/architecture/plans/27-web-reference-ui-fidelity.md` после отдельного approval пользователя. Перед execution сверить его с одобренным session-state review artifact; roadmap обновлять только штатным `pnpm docs:roadmap`, затем проверять `pnpm docs:check`. Не редактировать вручную `docs/roadmap/01-roadmap.md` (архив) или `docs/roadmap/generated.md` (generated output). Implementation начинается только в изолированной task branch/worktree от актуального pinned `develop`, после выполнения prerequisites и повторной проверки актуальности источника.

## Требования по экранам и API gap baseline

| Референс | Существующий backend surface | Требуемое покрытие |
|---|---|---|
| Dashboard | `GET /api/v1/dashboard`, planning/chat routes, approvals, execution | Все сводки из фактических записей; расход «сегодня» по UTC-окну; состояние общей паузы; реальные переходы к проектам/согласованиям/очереди; coordinator chat использует существующий request lifecycle. |
| Task | `GET /api/v1/tasks/:id`, dependencies, dispatch, pause | Полный task/run/findings/dependency/approval/git/usage/recovery projection; `pause`/`resume`, изменение приоритета; отсутствие фальшивого процента или статуса. |
| Epic | `GET /api/v1/epics/:id`, planning/orchestration | Lifecycle, graph, capacity, spend, child tasks, blockers, events; scoped pause/resume и replan через существующий planning/approval lifecycle. |
| Approval Inbox | `GET /api/v1/approvals`, approve/reject/request-changes | Pending и resolved history, детальная proposal/evidence/impact проекция, oldest/high-priority counters и переход к policy configuration без чтения сырых несвязанных таблиц из UI. |
| Execution Queue | `GET /api/v1/execution`, scheduler config | Running/waiting/blocked, capacity, resource locks, scheduler events, pending approvals, hourly usage; durable dispatch pause/resume; подтверждённый cancel-all с per-Run outcome. |
| Project | `GET /api/v1/projects`, `GET /api/v1/projects/:id`, GitHub sync/mapping | Paginated project index and project lifecycle, epic/task graph, blockers/events/budget/usage, pause/resume и существующий GitHub sync. Таргеты Git соответствуют актуальной branch/release policy, а не старому `master` sample. |
| Project Onboarding | `POST /api/v1/onboarding/discover`, read/approval/activate | Все шаги discovery → facts/proposals review → config candidate → approval → activation; обнаруженные факты остаются отличимы от LLM proposals. |
| Settings | `GET /api/v1/settings`, provider settings, Project Config GET/candidate/approve | Иерархия global/project/role/task-epic, все показанные редактируемые категории; candidate сохраняется отдельно от active revision и активируется только отдельным exact-hash approval. Secrets отображаются только безопасным статусом. |
| Usage & Budget | `GET /api/v1/usage` | ISO UTC window, daily trends и реальные breakdowns по роли/причине/модели, budget contexts/reservations, comparison/efficiency projections, budget policy command. Anomaly classifications remain unavailable pending approved policy; unsupported metrics never become fabricated values. |
| Agent Run Detail | run, artifacts, context, events, tools, permissions, recovery, cancel | Реальные event/terminal streams, usage/runtime/checkpoint evidence; manual checkpoint без остановки; cooperative pause → durable safe checkpoint → paused → validated resume; cancel сохраняет текущую lifecycle semantics. |

Текущие проверенные разрывы: Execution DTO содержит только `running/waiting/blocked`; Settings DTO read-only и оставляет `project/role/taskEpic: null`; Usage агрегирует all-history totals; Approval list отдаёт только pending rows; Run имеет cancel/read routes, но не user checkpoint/pause/resume; Project Config capture работает только вне Windows до появления safe platform verification. Контрактная реализация должна покрыть все поля/действия матрицы без копирования mock values.

## Полная матрица видимых полей и действий

Эта матрица закрывает design prerequisite для inventory до реализации. Каждая перечисленная группа входит в референс; все показанные значения приходят из указанного backend owner либо отображаются как `unavailable` с причиной. Sample IDs, названия, цифры, ветки и прогресс из HTML — только fixtures. Source of truth — указанный API/owner; мутации подтверждаются ответом backend и refetch.

| № / экран | Видимые поля и блоки | Видимые действия → authoritative command / исход |
|---|---|---|
| 01 Dashboard | Активные проекты и прогресс; задачи по статусам; approvals/count; активные и ожидающие Runs; dispatch/capacity и пул доступных агентов; coordinator chat/status | Приостановить новую работу → `PUT /scheduler/dispatch-state`; новый запрос → существующий planning request; открыть approvals/queue/project → route navigation; chat → существующий chat lifecycle. Сводки — `dashboard`, `approvals`, `execution` projections. |
| 02 Task | Идентификатор/заголовок/статус; lifecycle/process; task contract, описание/acceptance; plan/checklist; findings; Runs; review result; Git/branch/worktree; current agent; recovery; usage; dependencies; recent events | Пауза/возобновление → Task lifecycle command с сохранением prior stage; изменение priority → валидированный backend command; открыть worktree → существующий проверенный Git/worktree reference; Run/dependency/event links → navigation. |
| 03 Epic | Идентификатор/статус; lifecycle stages; dependency/parallel graph и critical path; contract; branch/worktree; active/capacity; approvals/blockers; budget; events | Пауза/возобновление → scoped scheduler/lifecycle state; перепланировать → planning request, далее существующий approval/materialization lifecycle; открыть coordinator/proposal → route/chat. |
| 04 Approval Inbox | Pending/resolved queue; category/status/priority/project/time; summary counters и oldest age; selected proposal, rationale, before/after plan diff, scope/role/architecture/delay/budget impact, evidence timeline, decision actor/outcome | Filter/history/detail/policy navigation → GET projections; approve/reject/request changes → существующие approval decision commands с optimistic current-state check, evidence, audit actor и refetch. |
| 05 Execution Queue | Running/waiting/blocked items; Run/role/task/project; effective priority и wait/block reason; selected Run; total/used capacity; held locks; scheduler event timeline/cursor; dispatch pause state | Pause/resume new dispatch → durable scheduler command, уже запущенные Run продолжаются; stop all → confirm неизменяемый список активных Run, `POST /runs/cancel-all`, per-ID outcome; открыть Run; выбранный Run pause/cancel → run lifecycle commands, refetch. |
| 06 Project | Project identity/lifecycle/default branch; Epics/Tasks and progress; dependency graph/critical path; blockers/events; budget/usage; coordinator context | Pause/resume Project без отмены текущих Run; GitHub sync через существующий command; new request через planning; graph/event/item navigation через устойчивые route IDs. |
| 07 Project Onboarding | Repo selection/validated identity; discovered branch/stack/package manager/test runner/remote facts; coordinator proposals отдельно от facts; reviewed project name/branch/process/execution/capacity/GitHub choices; proposed files; activation summary и unchanged source code claim | Cancel/back/re-discover → existing onboarding lifecycle; edit/review → typed proposal/config candidate; approve & activate → существующая approval + activation gates; при action error stage не продвигается. |
| 08 Settings | Project name; repository path (read-only/redacted by policy); validated default branch и Local execution mode; role/runtime/model/effective override source; project scheduler concurrency, priority aging, critical-path boost; recovery session resume/attempt limits/cycle/no-progress; Git integration strategy, GitHub connection, issue/PR/sync preferences; configuration ownership tree; navigation labels General/Roles/Processes/Runtime/Scheduler/Recovery/Permissions/GitHub/Budgets/Recommendations/Secrets | View config diff → current/candidate projection; Save → isolated unapproved candidate; activation only via exact-hash approval; navigation is real section navigation. Only fields in reference and mutable under current backend policy are editable. Global/Project/role/Task/Epic resolution is displayed with source; only an authorized Project override is editable here. Default branch is a candidate field only when its target is permitted by backend branch policy; prohibited/unknown targets are read-only with reason. Local paths, runtime/permission facts, secrets and unsupported policy values remain read-only or unavailable; no fabricated editor for nav-only categories. |
| 09 Usage & Budget | Selected UTC period; spend/tokens/cache/recovery summary; project budget versus actual and active reservations; role spend/share/run count/average; spend by trigger/reason; efficiency: cache share, avg initial context, avg output, AI runs/task, rework cycles/task, deterministic-check count/cost; cost anomaly panel; role/model cost and rework comparison; budget scope/soft-hard limits/actions/reservation mode | Date range/tab filter → window-scoped GET projection; project/run links → navigation; budget policies → Settings candidate, then explicit approval. Initial context uses persisted `context_manifests.initial_token_size`; output/spend from usage rows; AI runs/task from run rows; rework from persisted trigger/recovery classifications; check count/cost only from recorded deterministic-check executions (never assume `$0`). Cost anomaly and task recovery-share entries render field-level `unavailable` until an approved, evidence-backed anomaly/recovery classification policy exists; do not introduce heuristic threshold or alert semantics in this task. |
| 10 Agent Run Detail | Run identity/role/status; live events/autoscroll; sanitized terminal; task target; runtime health; permission decisions; Run-specific input/cached/output tokens and effective cost; recovery/loop signals; context package; tool invocation count; artifacts and checkpoint provenance; elapsed time; progress | Create checkpoint (does not stop); cooperative pause/resume same Run; cancel → Run owner commands; event notifications invalidate/refetch; terminal snapshot is Run-bound and sanitized. Token totals and effective cost come only from the canonical persisted Run row (with nullability preserved) and are individually `unavailable` when the corresponding `agent_runs` field is NULL; no aggregate-usage fallback. Effective cost means the persisted reconciled actual Run cost, not reservation/estimate; until reconciliation, it is unavailable. Tool count derives from persisted run events. Elapsed time derives from authoritative start/end timestamps. Percentage progress is `unavailable` for this task: never infer it from task stage, event count, elapsed time, or model output. No control reports success before persisted/runtime-confirmed outcome. |

**Unavailable-state contract:** every unsupported metric/evidence/capability has a field-level `availability: available | unavailable` plus stable reason code, renders a localized unavailable label at the corresponding reference field, and is tested with an absent-source fixture. In particular deterministic checks are unavailable unless a durable check-execution source exists; Run input/cached/output tokens and effective cost are individually unavailable when the canonical Run field is NULL; anomaly and task recovery-share classifications are unavailable pending explicit policy; Run percentage progress is unavailable in this task. A persisted numeric zero remains `available: 0`, distinct from NULL/unavailable; no NULL-to-zero projection is permitted. These values are never silently omitted or replaced by mock/example data.

**Settings clarification:** reference 08 shows editable content only for General, Roles and Models, Scheduler, Recovery, Git & GitHub, and a read-only ownership tree; other side-nav labels are navigation affordances, not authority to invent new settings fields. The role table’s Global/Project provenance is shown as effective source. Project Config owns only versioned project overrides; global provider/security/runtime facts and task/epic effective overrides remain at their existing owners, are read-only here, or show `unavailable`. Default branch is included in a candidate only when an authoritative allowed-ref projection validates the target. Mock `master` and “merge” values are replaced by actual `develop`/branch-policy facts and are not made editable when they would contradict policy.

## File / interface map

| Owner | Пути | Ответственность и producer/consumer seam |
|---|---|---|
| Shared API contracts | `packages/contracts/src/api.ts`; contract tests | Typed screen projections, request/response schemas, error unions и canonical `apiPaths`; producer для server/client. |
| Scheduler | `apps/server/src/modules/scheduler/scheduler-service.ts`, `scheduler-types.ts`, `resource-lock-service.ts`; `apps/server/src/app/routes/scheduler.ts`; `apps/server/src/app/read-models/execution-projection.ts`; scheduler/route tests | Durable dispatch pause, project/epic scoped pause gates, queue capacity/locks/events projection; `PUT /api/v1/scheduler/dispatch-state`. |
| Run lifecycle/runtime | `apps/server/src/modules/runtime/run-service.ts`, `agent-runtime.ts`, `hermes/hermes-runtime-adapter.ts`; `apps/server/src/app/routes/runs.ts`; run repository/runtime/process-recovery tests | Manual checkpoint, pause request/confirmed paused state, validated resume via scheduler admission, source-bound event/terminal reads, cancel-all outcomes. |
| Project Config | `apps/server/src/modules/projects/project-config-service.ts`, `project-config-repository.ts`, `apps/server/src/platform/config/project-config.ts`, project config routes/tests; migration `055_project_config_write_journal.sql` | Versioned v2 editor candidate, safe `.ebb-orchestrator/` write, write journal/recovery, existing exact-hash approval and immutable active revision. Continue to read existing v1 files without changing their meaning. |
| Projects / work lifecycle | `apps/server/src/modules/work/*`; `apps/server/src/app/routes/{projects,work}.ts`; Projects-owned index read model; project/epic/task read models and tests | Paginated project index plus project/epic/task scoped pause/resume, task priority command, Epic replan routed through planning/approval; preserve lifecycle authority. |
| Approvals & usage | `apps/server/src/app/routes/{approvals,usage}.ts`; `apps/server/src/app/read-models/usage-read-model.ts`; relevant approval/budget owners and tests | History/detail/evidence/policy projections, time-window analytics, source-backed model comparison and field-level unavailable states, budget policy command. |
| Compact Web system | `apps/web/src/styles/base.css`, `components/AppShell.tsx`, `app/router.tsx`, `components/ui/*`, shell/layout tests | Shared flat/compact tokens and geometry, navigation, responsive behavior, accessible primitives. |
| Screen consumers | `apps/web/src/features/{dashboard,projects,epics,tasks,approvals,execution,runs,usage,settings,onboarding}/`; `apps/web/src/api/client.ts`; `apps/web/src/i18n/ru.ts` | Each route consumes typed API and renders all 10 corresponding references, including loading/empty/error/blocked states. |
| Browser acceptance | `apps/web/test/e2e/` and existing `apps/web/test/e2e/run-e2e.mjs`; reference HTML under `docs/architecture/reference-ui/` | Real process/browser journeys, per-screen screenshot comparisons, authenticated mutations/reloads/reconnect/restart and deterministic cleanup. |
| Documentation | affected first-party README/API/config docs and canonical generated docs only if source says so | Changed-scope sync; no `.env.example` change unless an actual new environment key is added (none is planned). |

## Task DAG

### Task 1 — Typed screen and command contracts

**Depends on:** —

**Create/modify:** `packages/contracts/src/api.ts`; create `packages/contracts/test/reference-screen-contracts.test.ts`; modify `packages/contracts/test/scheduler-projection-contract.test.ts` and `packages/contracts/test/overview-child-dtos.test.ts`; create deterministic browser harness and initial `apps/web/test/e2e/reference-ui-visual.spec.ts` plus route/action specs before screen/backend implementation.

**Interfaces:** Add typed projections for `ExecutionQueueProjection` (capacity, locks, recent durable events, dispatch state), `ApprovalInboxProjection`/detail/evidence, periodized `UsagePageProjection`, extended Settings hierarchy, run checkpoint/control/stream, and project/epic/task controls. Extend `GET /api/v1/runs/:id` usage DTO to preserve NULL-vs-zero availability per Run field. Add paths:

- `PUT /api/v1/scheduler/dispatch-state` with `{paused:boolean}` → persisted `{paused,updatedAt}`.
- `POST /api/v1/runs/cancel-all` with `{expectedRunIds:string[]}` → ordered per-ID outcomes `CANCELLED | NOT_ACTIVE | FAILED`; no newly started Run is included implicitly.
- `POST /api/v1/runs/:id/checkpoint`, `/pause`, `/resume`; retain existing `GET /api/v1/events` as ephemeral live invalidation only (no SSE cursor/replay/filter contract); extend persisted `GET /api/v1/runs/:id/events?afterId&limit` with stable bounded outbox cursor for Run timeline replay; `GET /api/v1/runs/:id/terminal`.
- `POST /api/v1/projects/:id/pause|resume`; `POST /api/v1/epics/:id/pause|resume|replan`; `POST /api/v1/tasks/:id/resume|priority`.
- `GET /api/v1/projects?cursor&limit` → stable cursor page of authoritative project-index rows; no path leakage and no client-built index.
- `POST /api/v1/projects/:id/config/candidates/editor` with `{expectedManifestHash,settings}` → persisted candidate/manifest hash/diff; it does not activate. Existing exact-hash candidate approval remains activation authority.
- `POST /api/v1/projects/:id/config/journals/:journalId/reconcile` with `{expectedPhase:'DEGRADED',observedManifestHash,resolution:'ACCEPT_EXTERNAL'|'RESTORE_APPROVED'}`; privileged local operator command only. It never overwrites unexplained external files. `ACCEPT_EXTERNAL` is allowed only after the current canonical files are safely re-read and validate against ProjectConfigV2; it records them as a fresh unapproved candidate, leaves the previous active revision unchanged, updates `current_candidate_id` to that candidate and `config_status` to `READY` in the same CAS transaction that closes the journal as `RECONCILED_EXTERNAL`. Dispatch continues only from the unchanged prior approved active revision (and remains rejected when no active revision exists). Invalid/unreadable/untrusted observed files keep the journal DEGRADED. `RESTORE_APPROVED` is available only when exact prior approved bytes and file identities are still provable; it restores those bytes via the safe writer, verifies the manifest, sets `current_candidate_id` to the active revision's candidate and `config_status='READY'` without changing `active_revision_id`, then closes the journal as `RECONCILED_RESTORED`. Both paths record actor, resolution, verified hash/time, use CAS over journal phase/hash, and preserve journal evidence. Retry/restart returns the existing resolution result and never starts a second write.
- `GET /api/v1/approvals?status=pending|resolved`, `GET /api/v1/approvals/:id`, `GET /api/v1/approvals/policies`; `GET /api/v1/usage?from&to&granularity`. The Usage policy link navigates to the Project Settings budget editor; budget policy is not mutated through a second competing source of truth.

Schemas are strict, bounded and reject unknown fields. Dates are UTC ISO instants; budget scopes use existing `global|project|epic|task`; pause and checkpoint statuses are discriminated unions. Run-specific usage fields each preserve `null` as `{availability:'unavailable',reason:'NOT_RECORDED'}` and numeric values (including 0) as `{availability:'available',value}`; no `?? 0` compatibility fallback is allowed in Run detail. Run event HTTP paging accepts an opaque outbox event ID cursor and bounded `limit`; the server resolves that ID within the requested Run and returns subsequent rows in `(created_at,id)` order. An unknown/foreign cursor returns `400 INVALID_CURSOR`; it never broadens the Run scope. `/api/v1/events` remains ephemeral and clients always refetch authoritative projections on reconnect. Terminal response is discriminated `{availability:'available',entries:[...]}` or `{availability:'unavailable',reason:'NO_SANITIZED_PERSISTED_SOURCE'}` and reads only an existing persisted source explicitly designated sanitized by the Run owner; it must not reinterpret `agent_runs.output`, model output or raw process stdout as terminal data. No credential values, arbitrary filesystem paths or raw runtime environment objects in contracts.

**RED:** `pnpm --filter @ebb-orchestrator/contracts exec vitest run test/reference-screen-contracts.test.ts test/scheduler-projection-contract.test.ts test/overview-child-dtos.test.ts` must initially fail on absent schemas/paths; assert malformed windows, stale-hash shapes, empty/duplicate cancel IDs, invalid scope and secret-shaped fields are rejected. Create and run initial real-browser baseline using `pnpm --filter @ebb-orchestrator/web test:e2e` against current HEAD before Tasks 2–8; record which of the 10 direct routes, reference sections, actions, viewport screenshots and backend outcomes fail. Baseline is expected to expose gaps and is not a pass gate; these same tests are then the pre-existing RED suite for implementation.

**GREEN:** Implement schemas/path builders and pass `pnpm --filter @ebb-orchestrator/contracts exec vitest run test/reference-screen-contracts.test.ts test/scheduler-projection-contract.test.ts test/overview-child-dtos.test.ts` plus `pnpm --filter @ebb-orchestrator/contracts exec tsc -p tsconfig.json --noEmit`.

**Expected:** All server/UI tasks consume one stable typed contract; no arbitrary URL or unvalidated body.

**Review Focus:** Contract completeness against the full field/action inventory; project index pagination/ownership; `CANCEL_ALL` never broadens past `expectedRunIds`; candidate approval binds exact manifest hash; Run nullable usage distinguishes missing from actual zero; degraded journal reconciliation is explicit and CAS-bound; event API preserves current path and invalidation/refetch semantics.

**BLOCKED:** Any route contract would violate recovery design, branch/release policy or expose secrets.

**Docs:** N/A — contract-only producer; API docs are updated by Task 9.

### Task 2 — Durable scheduler controls and full execution projection

**Depends on:** Task 1.

**Create/modify:** Add `apps/server/src/platform/database/migrations/053_scheduler_dispatch_controls.sql`, `apps/server/test/platform/database/scheduler-dispatch-controls-migration.test.ts` and `apps/server/test/app/routes/scheduler.test.ts`; modify `apps/server/src/modules/scheduler/scheduler-service.ts`, `scheduler-types.ts`, `resource-lock-service.ts`, `apps/server/src/app/routes/scheduler.ts`, `apps/server/src/app/read-models/execution-projection.ts`, `apps/server/test/modules/scheduler/project-dispatch-guard.test.ts`, `apps/server/test/modules/scheduler/scheduler.test.ts` and `apps/server/test/app/read-models/scheduler-projection.test.ts`.

**Interfaces:** Add `scheduler_config.dispatch_paused INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_paused IN (0,1))`; add `scheduler_scope_pauses(scope TEXT CHECK (scope IN ('PROJECT','EPIC')),scope_id TEXT,paused_at TEXT,actor TEXT,PRIMARY KEY(scope,scope_id))`; no task pause duplicate because Task already has `PAUSED`. `PUT /scheduler/dispatch-state` updates state transactionally. The same scheduler admission/reservation transaction checks global and ancestor scope pauses; it rejects new reservation but does not cancel current Run. `GET /execution` reports current counts, configured/used capacity, held resource locks, recent outbox events, blocked/waiting reasons, approvals, hourly usage and dispatch state from persisted owners. `/api/v1/events` remains only the existing ephemeral invalidation/refetch channel; Run timeline paging is the separate Task 3 HTTP API and does not add SSE cursors/filters/replay.

**RED:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/scheduler-dispatch-controls-migration.test.ts test/modules/scheduler/project-dispatch-guard.test.ts test/modules/scheduler/scheduler.test.ts test/app/read-models/scheduler-projection.test.ts test/app/routes/scheduler.test.ts`. New assertions must fail before implementation because the migration/state/projection/routes are absent; cover fresh DB and populated v052 upgrade, missing capacity/locks/events, pause persistence across restart, global and ancestor scope gates, and a race proving no new Run reservation commits after pause commit.

**GREEN:** Implement migration/service/projection and pass `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/scheduler-dispatch-controls-migration.test.ts test/modules/scheduler/project-dispatch-guard.test.ts test/modules/scheduler/scheduler.test.ts test/app/read-models/scheduler-projection.test.ts test/app/routes/scheduler.test.ts`.

**Expected:** Fresh migration chain 001–053 and 052→053 upgrade preserve existing scheduler state; pause is durable/idempotent; current runs continue.

**Specialist evidence:** `ebb-database-engineering`: schema/default/constraint, transaction race, fresh + upgrade, restart. `ebb-security-review`: route auth/CSRF and scoped pause ownership.

**Review Focus:** Pause gate is inside authoritative reservation transaction, hierarchy cannot leak across projects, capacity derives from current reservations, errors do not claim success.

**BLOCKED:** Existing scheduler admission paths can create reservations without this gate.

**Docs:** N/A — no public command/setup change; API docs in Task 9.

### Task 3 — Run checkpoint, cooperative pause/resume and bulk cancellation

**Depends on:** Tasks 1–2.

**Create/modify:** Add `apps/server/src/platform/database/migrations/054_run_control_checkpoints.sql`, `apps/server/test/app/run-controls-routes.test.ts`, and `apps/server/test/platform/database/run-control-checkpoints-migration.test.ts`; modify `apps/server/src/modules/runtime/run-service.ts`, `agent-runtime.ts`, `hermes/hermes-runtime-adapter.ts`, scheduler run-request handling, `apps/server/src/app/routes/runs.ts`, and the existing `apps/server/test/modules/runtime/run-service.test.ts`, `apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts`, and `apps/server/test/modules/runtime/run-process-owner.test.ts`.

**Interfaces:** Add `run_control_commands(request_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES agent_runs(id),attempt INTEGER NOT NULL CHECK(attempt>0),command TEXT NOT NULL CHECK(command IN ('CHECKPOINT','PAUSE','RESUME')),expected_version INTEGER NOT NULL CHECK(expected_version>=0),status TEXT NOT NULL CHECK(status IN ('REQUESTED','COMPLETED','FAILED')),result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(run_id,attempt,request_id),UNIQUE(request_id,run_id,attempt))`; `run_checkpoints(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES agent_runs(id),attempt INTEGER NOT NULL CHECK(attempt>0),request_id TEXT NOT NULL,session_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,containment_ref TEXT NOT NULL,launch_nonce_hash TEXT NOT NULL,context_hash TEXT NOT NULL,workspace_snapshot_hash TEXT NOT NULL,event_cursor TEXT NOT NULL,checkpoint_hash TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(run_id,attempt,request_id),UNIQUE(id,run_id,attempt),FOREIGN KEY(request_id,run_id,attempt) REFERENCES run_control_commands(request_id,run_id,attempt))`; and `run_control_state(run_id TEXT PRIMARY KEY REFERENCES agent_runs(id),attempt INTEGER NOT NULL CHECK(attempt>0),state TEXT NOT NULL CHECK(state IN ('ACTIVE','PAUSE_REQUESTED','PAUSED','RESUME_PENDING','CLOSED')),checkpoint_id TEXT,version INTEGER NOT NULL CHECK(version>=0),updated_at TEXT NOT NULL,FOREIGN KEY(checkpoint_id,run_id,attempt) REFERENCES run_checkpoints(id,run_id,attempt),CHECK(state NOT IN ('PAUSED','RESUME_PENDING') OR checkpoint_id IS NOT NULL))`. Store only hashes/opaque runtime references, never transcript or credentials. Keep `agent_runs.status` within its existing lifecycle enum; `run_control_state` is the orthogonal durable pause overlay exposed by the typed projection, not a new unreviewed status value. Allowed transitions are absent→ACTIVE, ACTIVE→PAUSE_REQUESTED→PAUSED→RESUME_PENDING→ACTIVE; failed pause returns to ACTIVE, failed resume returns to PAUSED, and any confirmed terminal Run closes control state as `CLOSED`; no terminal Run can transition back. Manual checkpoint does not change control state. Every command uses `request_id` plus expected control version as idempotency/CAS; service transaction verifies command Run/attempt/session and owner generation/containment reference/launch nonce against the canonical current Run and process-owner record. `POST /runs/:id/checkpoint` persists intent, asks runtime for a validated safe checkpoint and leaves execution active. `POST /runs/:id/pause` persists `PAUSE_REQUESTED`; reservation and locks remain held until runtime confirms a safe checkpoint and the existing process owner proves exact Run process `STOPPED`. Only then, in a scheduler-owned transaction, change control state to `PAUSED`, persist checkpoint provenance and release capacity/locks; retain existing budget reservation and task’s nonterminal stage. A failed/unsupported checkpoint returns explicit `409/503` and never claims paused. Resume creates one scheduler `RUN_RESUME` request bound to the same Run/attempt/session/context/workspace and exact process-owner identity; scheduler atomically reacquires capacity/locks before runtime resume. Failed launch returns to `PAUSED` and releases reacquired resources; no unrelated Run may substitute. On every process owner state other than proven `STOPPED`, fail closed and retain ownership/reservation. `POST /cancel-all` applies existing `cancelRun` sequentially to the immutable confirmed IDs, reports each outcome and is retry-safe. Existing `/api/v1/events` remains ephemeral live invalidation only; reconnect always refetches. `GET /runs/:id/events?afterId&limit` returns the durable, Run-scoped outbox page for timeline history, ordered by `(created_at,id)` with bounded pagination; it is not SSE and not terminal output. Terminal data is exposed only from an explicitly persisted, already-sanitized Run output source; otherwise its typed panel state is `unavailable` (never raw process stdout or model output).

**RED:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/runtime/run-service.test.ts test/modules/runtime/hermes-runtime-adapter.test.ts test/modules/runtime/run-process-owner.test.ts test/app/run-controls-routes.test.ts test/platform/database/run-control-checkpoints-migration.test.ts`. New route/migration assertions must fail before implementation because those APIs/schema are absent; updated runtime assertions must fail on missing persisted control behavior, not harness setup. Cover fresh DB and v052→v054 upgrade, all command/checkpoint/state constraints, persisted `GET /runs/:id` numeric zero versus NULL/unavailable for each input/cached/output/effective-cost field and no aggregate-usage fallback; `GET /runs/:id/events` cursor page boundaries/order/Run containment; reconnecting `/api/v1/events` triggers refetch and never claims replay; active→pause-requested→checkpoint→proven STOPPED→paused→resume admission, duplicate request replay, CAS loss, checkpoint error, concurrent pause/cancel, crash/restart at every durable boundary, unknown process owner, provenance mismatch including attempt/session/context/workspace and supervisor launch identity, full/partial/stale/duplicate cancel-all, and no raw secret in event/terminal DTO.

**GREEN:** Implement repository/service/runtime/HTTP; pass focused run-service, runtime-adapter, route, process-recovery and migration tests; run `pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/runtime test/app/run-controls-routes.test.ts test/platform/database/run-control-checkpoints-migration.test.ts`.

**Expected:** Pause/resume is durable and cooperative; cancellation preserves existing terminal semantics; no fake checkpoint is created when the runtime cannot prove one.

**Specialist evidence:** `ebb-database-engineering` on transition/restart/failure recovery; `ebb-security-review` on event/terminal disclosure, command authorization and process ownership.

**Review Focus:** no force-kill mislabeled as a checkpoint; no NULL-to-zero usage; no replay promise on ephemeral SSE; no resume without the exact bound workspace/session/context/attempt/owner generation/containment identity/launch nonce; no capacity/lock leak or double reservation.

**BLOCKED:** Hermes adapter cannot prove safe checkpoint + later resume for a supported active Run. In that case stop before exposing the action as enabled; return to user with exact evidence.

**Docs:** N/A — internal API; public API docs in Task 9.

### Task 4 — Safe project settings candidates and scoped work actions

**Depends on:** Tasks 1–3.

**Create/modify:** Add `apps/server/src/platform/database/migrations/055_project_config_write_journal.sql`, `apps/server/test/modules/projects/project-config-editor.test.ts`, `apps/server/test/modules/work/scoped-work-controls.test.ts`, `apps/server/test/platform/database/project-config-write-journal-migration.test.ts`, and `apps/server/test/app/project-work-route-controls.test.ts`; modify `apps/server/src/platform/config/project-config.ts`, `apps/server/src/modules/projects/project-config-service.ts`, `project-config-repository.ts`, `apps/server/src/app/routes/project-config.ts`, `projects.ts`, `work.ts`, project/epic/task services and projections; add a paginated project-index projection owned by Projects.

**Interfaces:** Add strict `ProjectConfigV2Schema` for visible mutable fields: project display name; policy-validated default branch; role runtime/provider/model override; project scheduler capacity/priority-aging/critical-path options; recovery resume/attempt/cycle/no-progress options; GitHub issue/PR/sync preferences; and budget-policy values surfaced by Usage (daily soft/hard limits, threshold actions and reservation mode). Default branch must be checked against an authoritative allowed-ref projection and cannot override protected integration/release policy. Local-only execution mode, actual integration strategy and permission/security facts are rendered from authoritative policy and remain read-only. Preserve secret-presence facts only; preserve `ProjectConfigV1` parsing/meaning for existing files. A saved editor candidate is stored in SQLite as immutable candidate bytes/manifest and does not write the repository or affect active readers. It is displayed from that snapshot and is never read as active.

Migration `055_project_config_write_journal.sql` adds only a new table and indexes; it does not rebuild or alter `project_config_candidates`, so migration runner's existing FK-enabled transactional path is sufficient. Table schema: `id TEXT PRIMARY KEY`; `project_id TEXT NOT NULL`; `candidate_id TEXT NOT NULL`; `approval_id TEXT NOT NULL`; `expected_manifest_hash TEXT NOT NULL`; `old_files_json TEXT NOT NULL`; `new_files_json TEXT NOT NULL`; `phase TEXT NOT NULL CHECK(phase IN ('PREPARED','WRITING','APPLIED','DEGRADED','RECONCILED_EXTERNAL','RECONCILED_RESTORED'))`; nullable `failure_code`, `resolution`, `resolved_by`, `resolved_manifest_hash`, `resolved_at`; `created_at TEXT NOT NULL`; `updated_at TEXT NOT NULL`; a CHECK requires the four resolution fields NULL for non-reconciled phases and all populated for `RECONCILED_EXTERNAL|RECONCILED_RESTORED`; FKs to `projects(id) ON DELETE CASCADE`, `project_config_candidates(candidate_id)` and `approvals(id)` with default NO ACTION for the latter two; index `(project_id,created_at DESC)` and a partial unique index on `project_id` for phases `PREPARED`, `WRITING` or `DEGRADED`. All candidate capture/approval/apply commands are rejected while such a journal exists; only explicit reconciliation can transition `DEGRADED` to a terminal reconciliation phase.

`055` applies normally through `runMigrations` with FK enforcement enabled and the usual migration transaction; no custom FK-off mode and no runner exception is added. The actual populated-v052→v055 runner test asserts fresh upgrade, `PRAGMA foreign_key_check`, full `foreign_key_list` for all three existing Project Config tables and new journal (including on_update/on_delete/match), unchanged indexes/triggers and exact candidate/revision/state rows and pointers. Since no existing table is rebuilt, the `033_project_config_lifecycle.sql` FK/index/trigger definitions remain untouched.

Keep existing `project_config_state.config_status` enum; scheduler admission rejects any `PREPARED`/`WRITING`/`DEGRADED` journal, so dispatch fails closed during application without inventing a success state. Save creates only the immutable candidate in SQLite and does not write repo files, create a journal, or change active config. Exact-hash approval transaction creates the approved immutable revision and persists a `PREPARED` journal while leaving candidate status `PENDING_REVIEW` and `active_revision_id` unchanged; API projection derives `APPLYING` from the journal, avoiding any candidate CHECK rebuild. Only then does the writer touch canonical allowlisted `.ebb-orchestrator/` files. After complete target-manifest verification, one DB transaction marks journal `APPLIED`, candidate `APPROVED_ACTIVE`, and advances active revision; prior active revision remains authoritative until this commit. Recovery may complete only a journal bound to the already-approved exact candidate; no unapproved bytes are written/read as active. It compares each observed file identity/hash with the journal's old/new snapshots and resumes only when every change is explainable as old or approved-new. Unknown identity/content or failed proof marks config `DEGRADED`, retains journal bytes, blocks dispatch and requires explicit reconciliation without overwriting that external change. `ACCEPT_EXTERNAL` runs under a per-project reconciliation lock, re-reads the full canonical manifest from verified Windows-safe handles, validates V2 schema/size/path policy, and computes its exact hash before mutation; in one `DEGRADED` + expected-hash CAS transaction it creates a fresh `PENDING_REVIEW` candidate, sets `current_candidate_id` to it, leaves `active_revision_id` unchanged, sets `config_status='READY'`, and marks journal `RECONCILED_EXTERNAL` with actor, resolution, hash and timestamp. Dispatch resumes only against the unchanged prior approved active revision; with no active revision it remains denied by the existing admission rule. It never writes those external bytes. If verification or the transaction fails, no pointer/status changes and the journal remains `DEGRADED`; an already committed retry returns that recorded terminal result without creating another candidate. `RESTORE_APPROVED` requires a previously active approved revision and proof that its exact bytes and file identities are still recoverable from journal snapshots; the safe writer restores and rereads those bytes, then a single CAS transaction verifies the journal is still DEGRADED, sets `current_candidate_id` to the candidate referenced by unchanged `active_revision_id`, sets `config_status='READY'`, and marks `RECONCILED_RESTORED` with actor, hash and timestamp. If write/verification/CAS fails, keep or re-enter `DEGRADED`, preserve journal evidence, and do not dispatch. Both outcomes leave `active_revision_id` unchanged; both terminal journal records preserve the observed hash and cannot be replayed into another resolution. Preserve authoritative active reads through `approvedProjectConfigSnapshotTx`; consumers read only active approved revision, never candidate files.

**Windows capture/write precondition:** Current `capture()` deliberately returns `PROJECT_CONFIG_UNSUPPORTED_PLATFORM` on Windows. Do not weaken that gate or use `realpath/lstat` string checks as file authority. Before enabling Settings candidate creation or approval on Windows, implement and test native handle-based capture and writer: open each path component without following reparse points; bind volume/file ID for each verified parent/child; read exact bytes from verified handles; hold no-delete-sharing handles through stable capture/write; write only via verified handles; and use verified handle-based replace/rename for each file. Unsupported query, identity change, share conflict, cross-volume operation or noncanonical path fails closed. The production path must pass Windows tests for junction/symlink/reparse races, replacement between verification and read/write, interrupted multi-file write/restart, and unknown external modifications. If evidence cannot be produced, keep candidate capture/editor and repository mutation disabled on Windows and stop this task as blocked rather than shipping an unsafe fallback.

Project/epic pause uses the scope table from Task 2 and blocks new descendant admissions while current Runs continue. Task pause/resume uses existing workflow state and preserves prior stage. Task priority is a validated backend command on the existing canonical priority field and records an event. Epic replan creates a planning request under the existing coordinator/approval lifecycle; it does not directly rewrite accepted child work. Project GitHub sync uses its existing command.

**Project index:** Add `GET /api/v1/projects?cursor&limit` in the Projects route, backed by a Projects-owned read model over existing authoritative rows. Return stable display/lifecycle fields, opaque next cursor and bounded page size; do not expose repository paths or derive from browser-local data. Empty page is distinct from backend error. Add pagination, ownership isolation, empty/error and real-route tests.

**RED:** Run `pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/projects/project-config-editor.test.ts test/modules/work/scoped-work-controls.test.ts test/platform/database/project-config-write-journal-migration.test.ts test/app/project-work-route-controls.test.ts`. The new tests must fail before implementation for fresh v001 and populated v052→v055 through the actual migration runner; stale expected manifest; non-allowlisted config; malformed config; symlink/reparse path and identity race; size limits; every journal phase/restart and partial multi-file apply; rejection of candidate capture/approval while PREPARED/WRITING/DEGRADED; candidate-not-active before exact approval; existing Project Config FK/index/trigger preservation without rebuild; for both reconciliation branches, each pointer/status and scheduler admission outcome, invalid/unreadable bytes, active revision absent/present, transaction/CAS loss, retry/restart idempotency, and unresolved lockout; project-index pagination/ownership; project/epic scoped pause and task priority/replan validation. Windows native writer tests must prove the handle/identity precondition above before approval mutation can be enabled.

**GREEN:** Implement using Project Config and Work domain owners; pass `pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/projects/project-config-editor.test.ts test/modules/work/scoped-work-controls.test.ts test/platform/database/project-config-write-journal-migration.test.ts test/modules/projects test/app/project-config-routes.test.ts test/app/project-work-route-controls.test.ts test/modules/scheduler/project-dispatch-guard.test.ts`. Fresh DB 001–055 and supported upgrade 052→055 must pass, including Windows/Linux safe-path tests.

**Expected:** Settings Save creates a real, durable, unapproved candidate; separate approval is the only activation path; scoped pauses never cancel active Runs.

**Specialist evidence:** `ebb-database-engineering` for migration 055/journal/recovery and fresh/upgrade; `ebb-security-review` for file writes, path containment, config injection and authorization.

**Review Focus:** No symlink/path traversal; no loss of pre-existing config on partial write; active revision remains unchanged until exact approval; no product behavior is inferred from model proposal text.

**BLOCKED:** The native Windows handle-based write protocol cannot prove component identity and mutation safety, or an unrecognized external write prevents deterministic recovery. Do not enable Settings file mutation in UI without safe support; this is not waived by hiding errors.

**Docs:** N/A — config/API public docs updated in Task 9.

### Task 5 — Approval evidence/history and Usage/Budget APIs

**Depends on:** Tasks 1–4.

**Modify:** `apps/server/src/app/routes/approvals.ts`, `apps/server/src/app/routes/usage.ts`, approval read-model/service owner, `apps/server/src/app/read-models/usage-read-model.ts`, `apps/server/src/app/read-models/dashboard-projection.ts`; create `apps/server/test/app/approval-usage-projections.test.ts`. No migration is planned for this task; settings policies remain owned by the candidate/approval lifecycle in Task 4, while Usage analytics derive from existing persisted records.

**Interfaces:** Approval list supports pending/resolved with stable cursor; detail projection returns proposal, rationale, typed plan/impact, provenance/evidence, resolution and actor—never raw internal rows. Policy view uses backend-owned effective policy. `GET /usage?from=<UTC>&to=<UTC>&granularity=day` returns summary, daily series, role/reason/model breakdowns, model comparison, recovery/efficiency/anomaly evidence, budgets/active reservations. Spend/tokens/cache derive from persisted usage rows; average initial context uses `context_manifests.initial_token_size`; average output and AI runs/task use persisted run/usage rows; rework share uses persisted trigger/recovery classifications; deterministic-check count/cost are `unavailable` until durable check-execution records exist. Cost-anomaly panel and task recovery-share classifications remain `unavailable` until an explicitly approved, evidence-backed policy exists; no statistical threshold or heuristic is introduced in this task. Model comparison aggregates actual persisted usage by role/model. Budget policy edits go through the Settings candidate and its exact-hash approval; this read model does not own a competing budget write command.

**RED:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/app/approval-usage-projections.test.ts test/app/usage-route.test.ts` must fail on missing resolved history/evidence/time windows/breakdowns; tests exercise UTC boundaries, empty datasets, malformed windows, unauthorized scope and aggregate reconciliation against source rows.

**GREEN:** Implement typed projections and service routes; pass `pnpm --filter @ebb-orchestrator/server exec vitest run test/app/approval-usage-projections.test.ts test/app/usage-route.test.ts test/modules/approvals/approvals.test.ts` and compare each aggregate to fixture records. Budget edits remain in the candidate approval path from Task 4.

**Expected:** Every displayed count/evidence/usage value is derived from persisted state, window-scoped where shown, and traceable to its owner.

**Specialist evidence:** `ebb-database-engineering` for aggregate query correctness and transaction changes; `ebb-security-review` for approval evidence/secret redaction.

**Review Focus:** UTC inclusivity, duplicate event exclusion, no cross-project evidence, field-level unavailability for unsupported statistics, efficiency denominators, budget precedence is unchanged.

**BLOCKED:** Required mock metrics have no reliable deterministic source. Return explicit `unavailable` rather than inventing state.

**Docs:** N/A — API docs in Task 9.

### Task 6 — Shared Web foundation, typed clients and Russian strings

**Depends on:** Task 1.

**Modify:** `apps/web/src/styles/base.css`, `apps/web/src/components/AppShell.tsx`, shared `apps/web/src/components/ui/`, `apps/web/src/api/client.ts`, `apps/web/src/api/events.ts`, `apps/web/src/i18n/ru.ts`, `apps/web/test/reference-layouts.test.tsx`; add `apps/web/test/api-client.test.ts`.

**Interfaces:** Align fixed reference geometry: sidebar `230px`, main content insets `24px/28px`, panels `16px`, reference spacing/type/color hierarchy, flat surfaces and no unreferenced gradients/shadows. Preserve responsive narrow layout, route behavior, accessibility and focus. Add typed adapters for every Task 1 API path using `apiPaths`; adapters preserve server error/`unavailable` states and never invent fallback data. Add Russian strings for all reference sections, labels, actions and errors.

**RED:** `pnpm --filter @ebb-orchestrator/web exec vitest run test/reference-layouts.test.tsx test/api-client.test.ts test/localization-accessibility.test.tsx` must fail on current oversized geometry or missing response validation, route builders, error distinctions and reference labels; failures must be assertion-level, not test-runner setup errors.

**GREEN:** Replace layered overrides with one coherent token/layout system, shared primitives, typed clients and localized copy; pass `pnpm --filter @ebb-orchestrator/web test`.

**Expected:** Common layout and adapter foundation is compact, flat, accessible, fully typed and Russian-localized.

**Review Focus:** Ensure CSS cascade has no hidden stale override; route builders are used; errors remain actionable; accessibility/focus does not reintroduce spacious layouts.

**BLOCKED:** A projection requires an untyped/secret-bearing adapter, or CSS geometry still materially exceeds the reference.

**Docs:** N/A — no external behavior/config claim.

### Task 7 — Dashboard, Project, Epic, Task and Onboarding screens

**Depends on:** Tasks 1–6.

**Modify:** `apps/web/src/features/dashboard/DashboardPage.tsx`, `apps/web/src/features/projects/ProjectPage.tsx`, `apps/web/src/features/epics/EpicPage.tsx`, `apps/web/src/features/tasks/TaskPage.tsx`, `apps/web/src/features/onboarding/ProjectOnboardingPage.tsx`; create `apps/web/test/primary-workflows.test.tsx`.

**Interfaces:** Consume only typed API adapters. Render real metrics, lifecycle, blockers, graph, task dependencies/runs/Git/usage/recovery and onboarding facts/proposals. Wire request/chat flows already present, project sync, scoped pause/resume, Epic replan, task pause/resume/priority and safe worktree links. Use route builders, not endpoint strings. Render unavailable/empty/error distinctly; never fill missing values from sample HTML.

**RED:** `pnpm --filter @ebb-orchestrator/web exec vitest run test/primary-workflows.test.tsx` must fail on each missing reference section/action; the suite asserts failing HTTP states, while Task 6 adapter tests assert route, request body and error mapping. Real-browser interactions are covered in Task 9.

**GREEN:** Implement each route against Tasks 2/4 API results; pass `pnpm --filter @ebb-orchestrator/web exec vitest run test/primary-workflows.test.tsx test/reference-layouts.test.tsx` and verify direct/reload/navigation paths in Task 9 E2E.

**Expected:** Five reference screens are functionally connected and preserve current route/auth behavior.

**Review Focus:** No cross-feature internal state imports; no raw repository path as HTML; no premature success before API response; mock values absent outside fixtures.

**BLOCKED:** Required read-model field has no authoritative source or action has no backend gate.

**Docs:** N/A — API documentation belongs to Task 9.

### Task 8 — Approval, Execution, Settings, Usage and Agent Run screens

**Depends on:** Tasks 1–6.

**Modify:** `apps/web/src/features/approvals/ApprovalInboxPage.tsx`, `apps/web/src/features/execution/ExecutionPage.tsx`, `apps/web/src/features/settings/SettingsPage.tsx`, `apps/web/src/features/usage/UsagePage.tsx`, `apps/web/src/features/runs/AgentRunPage.tsx`; create `apps/web/test/operations-workflows.test.tsx`.

**Interfaces:** Render and wire these five reference screens. Approval actions use backend decision routes and show resolved evidence/history. Execution Queue uses global pause, confirmed cancel-all and selected-run controls; partial failures are itemized. Settings edits typed project config into an unapproved candidate, displays returned diff, and links to exact-hash approval; provider credentials continue using existing secure provider endpoints and values never render. Usage selects a UTC window and renders source-derived breakdowns/budget outcomes. Run screen uses `/api/v1/events` only for ephemeral invalidation and refetch; it pages durable timeline data through the Run-scoped HTTP cursor endpoint, renders sanitized persisted terminal output or the typed unavailable state, and handles checkpoint/pause/resume/cancel according to server state.

**RED:** `pnpm --filter @ebb-orchestrator/web exec vitest run test/operations-workflows.test.tsx` must fail where a control does not invoke its typed backend route or where error/partial outcomes are hidden.

**GREEN:** Implement all sections/actions; pass `pnpm --filter @ebb-orchestrator/web exec vitest run test/operations-workflows.test.tsx test/reference-layouts.test.tsx` and rerun all ten visual references in Task 9.

**Expected:** No mock control is a dead button, and no panel claims data the backend did not provide.

**Review Focus:** Approval race/stale state; cancel confirmation snapshot; reconnect-triggered authoritative refetch (without SSE replay claim); config candidate never shown as active before approval; secret/output sanitization.

**BLOCKED:** A Run control cannot be supported safely by the selected runtime; leave disabled with truthful capability/error state and return to the approved design boundary before completion.

**Docs:** N/A — API documentation belongs to Task 9.

### Task 9 — Real browser E2E, docs sync and integrated verification

**Depends on:** Tasks 1–8.

**Create/modify:** Extend/finalize the browser specs and harness created/run as a pre-implementation baseline in Task 1; extend existing `apps/web/test/e2e/run-e2e.mjs` only when required; update only affected first-party README/API/config documentation and canonical generated docs. Do not create `.env.example` keys.

**Interfaces/scenarios:** Start real server and browser with isolated `EBB_ORCHESTRATOR_HOME`, dynamic ports, existing auth/session flow and deterministic SQLite fixture. Cover all 10 direct routes, navigation/reload/loading/empty/error, every primary action, backend-confirmed refetch, approval changes, queue pause persistence/restart, partial cancel-all, config candidate/stale approval/restart/Windows-safe write, run checkpoint/pause/restart/resume/cancel, usage UTC boundary, Run timeline HTTP cursor paging, and SSE reconnect triggering authoritative refetch. Use fixed fixture timestamps and persisted IDs; verify no orphan processes, generated artifacts or console/network errors. Compare all 10 pages with the corresponding reference HTML at both `1440×900` desktop and `390×844` narrow viewport with per-screen `maxDiffPixelRatio <= 0.01`; narrow is a screenshot comparison, not only a smoke test. Ignore only explicitly identified nondeterministic browser chrome, never UI content.

**RED:** `pnpm --filter @ebb-orchestrator/web test:e2e` re-runs the baseline browser matrix after Tasks 1–8; each selected command/read model is exercised through real HTTP/browser, not only a mocked component. Expected RED is a failing assertion for an unimplemented requirement, not harness startup/auth/dependency failure. Fix any test-only harness changes that mask behavior before acceptance.

**GREEN:** `pnpm --filter @ebb-orchestrator/web test:e2e` passes the complete exact browser journeys; update docs claims from manifests/loaders/API contracts and run `pnpm docs:check` plus `pnpm docs:test`.

**Run:** `pnpm --filter @ebb-orchestrator/web test:e2e`; `pnpm --filter @ebb-orchestrator/web build`; `pnpm docs:check`; `pnpm docs:test`.

**Expected:** Real process/browser acceptance green; changed-scope docs claims are current; no generated artifact remains.

**Specialist evidence:** `ebb-web-e2e` and changed-scope `ebb-maintain-project-docs`.

**Review Focus:** Real HTTP, real persistence, exact desktop and narrow screenshot comparison, deterministic fixtures, cleanup, no secret in browser/IPC/logs, no external provider spend.

**BLOCKED:** Required UI path fails in real process composition, Windows config-write identity cannot be established, or documentation source is generated but has no canonical update route.

### Task 10 — Security review, quality gates and final review

**Depends on:** Task 9.

**Modify:** No product code unless a confirmed finding returns to its owning task; final evidence is stored in session artifacts.

**Interfaces:** Run scoped independent security review over scheduler/run control, config writer/journal, approval/usage projection and SSE/terminal data; address confirmed findings through a new `ebb-implement-task` cycle and scoped re-review. Run full project gates on final task SHA:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @ebb-orchestrator/web test:e2e
git diff --check
git status --short
```

Also run `pnpm --filter @ebb-orchestrator/server exec vitest run` and the exact migration/recovery suites named in Tasks 2–4. Request independent `ebb-final-review` after all changes; integrate only after reviewer and gates pass under branch/release governance. Record reviewed task SHA separately from integrated `develop` SHA and rerun gates after any integration.

**RED:** Any mandatory gate is red, any generated/unintended file remains, security or review has an unresolved load-bearing finding, or working tree has unintended changes.

**GREEN:** All required gates pass, focused fresh/upgrade/browser evidence is attached, `git diff --check` passes, intended working tree state is documented, independent review is PASS, and post-integration SHA gates pass.

**Expected:** Ready-for-integration evidence only; no commit/push/merge/release is implied.

**Review Focus:** Whole change versus approved design, exact visual fidelity, source-of-truth semantics, security/data recovery and current `develop` policy.

**BLOCKED:** Any mandatory gate, reviewer, migration recovery scenario, or exact visual threshold remains unresolved.

## Self-review

1. All visible field/action groups of every reference are inventoried with an authoritative source/command or explicit read-only/unavailable disposition before implementation; each contract is also tied to a domain owner.
2. User-confirmed pause-all, stop-all, candidate approval and cooperative Run pause semantics are explicit; no new behavior is hidden in the implementation.
3. Migrations continue from current `052_chat.sql` as `053`–`055`; schema changes are forward-only and each has fresh/upgrade/restart verification.
4. Producers precede consumers: contracts → backend services/read models + shared web clients → screen consumers → real browser E2E → security/final review.
5. UI foundation and independent backend domains can proceed in parallel only when they do not share mutable files; after Task 1 contracts, active subagent cap remains two.
6. Visual acceptance is measurable (all 10 screens at fixed desktop and narrow viewports, max 1% pixel ratio with deterministic fixtures) and does not substitute for HTTP/process E2E.
7. Docs/API sync is explicitly covered; no README or `.env.example` claims are presumed current.
8. Plan does not authorize commit, push, merge, release, or any unrelated branch/settings mutation.
