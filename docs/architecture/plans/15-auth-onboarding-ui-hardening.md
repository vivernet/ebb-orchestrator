---
id: plan-15
kind: plan
roadmap: 01
stage: 13
status: completed
title: Устойчивые auth, onboarding и Russian Web UI
summary: Устранить подтверждённые дефекты ephemeral auth/bootstrap и рассинхронизации onboarding, сохранив backend authority, loopback trust boundary и проверяемый real HTTP/browser flow.
created: 2026-09-25
updated: 2026-09-26
depends_on:
  - plan-12
  - plan-13
specs:
  - ../specs/01-system-design.md
  - ../specs/02-web-ui-recovery-design.md
  - ../specs/03-production-readiness-design.md
evidence:
  - apps/server/src/app/create-app.ts
  - apps/server/src/main.ts
  - apps/server/src/platform/security/auth-service.ts
  - apps/server/src/app/routes/onboarding.ts
  - apps/server/src/modules/approvals/approval-service.ts
  - apps/server/src/modules/approvals/approval-types.ts
  - apps/server/src/platform/events/outbox-repository.ts
  - apps/web/src/api/client.ts
  - apps/web/src/features/onboarding/api.ts
  - apps/web/test/e2e/v1-ui.spec.ts
  - scripts/docs-governance.test.mjs
  - scripts/roadmap-generator-cli.mjs
---

# Auth, onboarding и Russian Web UI — draft implementation plan

> **Для агентного исполнения:** REQUIRED SKILL: `ebb-execute-plan`. Этот файл и части плана только фиксируют будущие изменения; production-код, тесты, roadmap и commit этим draft не изменяются.

## Цель и доказанный root cause

В текущем checkout auth создаётся в памяти `createApp`: raw bearer/CSRF/bootstrap token теряются после рестарта; `create-app.ts` принимает bootstrap query-token, открывает `POST /api/v1/session/new?local=true`, а `EBB_DISABLE_AUTH=1` обходит весь API. Web хранит bearer в памяти, silently создаёт local session при любом не-OK restore и SSE бесконечно reconnect-ится после 401. `POST /api/v1/onboarding/discover` возвращает facts без `projectId`, тогда как Web продолжает flow по optional `projectId`; approval-клиент отправляет `{}`, хотя сервер требует `repositoryPath`. Эти факты подтверждены текущими файлами и repo-relative evidence, а не историческим HEAD или статусами старых планов.

## Зафиксированные approved decisions

- V1 — один локальный пользователь без username; первый запуск — интерактивный CLI wizard.
- В SQLite сохраняется только PHC-formatted Argon2id password hash, созданный pinned `argon2@0.45.1`; plaintext не попадает в argv, env, файлы, SQLite, logs, API или UI.
- Persistent session переживает backend restart; SQLite хранит только hash opaque session token. Idle TTL — **30 минут**, absolute TTL — **24 часа**. Logout revokes session.
- Browser получает `HttpOnly` session cookie и JS-visible synchronizer CSRF token; privileged bearer token в browser JavaScript/storage запрещён.
- Истёкшая или revoked session отвечает `401`; Web очищает auth state и показывает login, а не создаёт новую session.
- Bootstrap query token, user-facing bootstrap link/file, `GET /session/bootstrap` user flow и `POST /session/new?local=true` удаляются. Если оставшийся internal migration/fixture reference нужен, он не является production route и не получает bypass semantics.
- `EBB_DISABLE_AUTH` удаляется из production auth path; тесты используют injected auth adapter/fixture, не environment-wide bypass.
- `discover` атомарно валидирует repository, создаёт и возвращает draft `projectId`; дальнейший flow — review → explicit approval request → approve → activate.
- Draft нельзя schedule/dispatch до activation; backend, а не Web, является authority.
- UI полностью русифицируется, включая accessible names, aria/title/placeholder/status/error/loading/empty text. Async ошибки имеют live-region/focus semantics.
- README описывает factual first run, login, TTL/logout/recovery limitation; stale bootstrap artifact удаляется или заменяется без token workflow.

## Решения, которые запрещено принимать молча

- Не сохранять raw session/CSRF/password или передавать пароль в SecretStore: SecretStore остаётся только для external credentials.
- Не выбирать hash cost, cookie flags, CSRF rotation или route DTO по догадке: первый deliverable `15-01` фиксирует pinned dependency, Argon2id parameters и contract decision до начала downstream tasks.
- Не добавлять password recovery в v1. Forgotten password требует отдельного явно одобренного destructive local reset decision.
- Не делать migration rollback через редактирование 001–025 и не удалять данные автоматически при startup failure.
- Не добавлять i18n provider, remote auth, multi-user, roles, password reset, Docker или unrelated scheduler refactor.
- Не считать старые `plan-08-*`, `plan-12`, `plan_verification_status.json` доказательством текущего runtime contract без real verification.

## Trust boundaries и failure semantics

| Boundary | Invariant | Failure behavior |
|---|---|---|
| TTY wizard → auth repository | stdin only, hidden confirmation, no argv/env/logging | non-TTY, mismatch или DB error aborts startup before listener/READY |
| Browser → API | HttpOnly cookie + synchronizer CSRF + exact loopback Origin for mutation | missing/invalid/expired/revoked session `401`; bad Origin/CSRF `403`; no fallback |
| SQLite auth repository | only password hash, token hash, CSRF hash and timestamps | transaction rollback leaves no partial user/session; DB unavailable fails closed |
| Web → SSE | SSE is invalidation only; backend projection is authority | stream `401` stops reconnect and emits session-expired; transient non-401 may reconnect |
| Repository path → onboarding | real absolute existing directory, backend realpath/redaction | invalid or discovery failure `400`; no client-selected project authority |
| Draft project → scheduler | only ACTIVE project and ACTIVE onboarding config are dispatchable | DRAFT/PROPOSED or missing config is hard `BLOCK` with `ONBOARDING_NOT_ACTIVE`; it is excluded from runnable/waiting and creates no reservation/dispatch |
| SecretStore → auth | no dependency from local password/session auth to external secret backend | keyring/Infisical outage does not change local login semantics |

## Dependency graph

```text
15-01 contract + crypto feasibility
  ├── 15-02 SQLite auth/repository + migration
  │     └── 15-03 wizard/startup composition
  │           └── 15-09 atomic auth v2 remediation
  │                 └── 15-04 server boundary/routes/CSRF
  │                 ├── 15-05 contracts + Web auth/SSE
  │                 └── 15-06 onboarding draft/approval/scheduler guard
  │                       └── 15-07 Russian UI/accessibility + README/artifact cleanup
  └──────────────────────────────────────────────────────────────────────────────┐
                                  15-08 focused/full/security/browser verification and review
```

The parent plan and all nine child plans are explicitly in scope: `15-auth-onboarding-ui-hardening.md`, `15-01-auth-contract-and-crypto.md`, `15-02-auth-persistence-and-repository.md`, `15-03-auth-cli-and-startup.md`, `15-09-atomic-auth-v2-remediation.md`, `15-04-server-security-boundary.md`, `15-05-web-auth-and-sse.md`, `15-06-onboarding-draft-and-scheduler-guard.md`, `15-07-russian-ui-and-artifact-cleanup.md`, and `15-08-verification-and-review.md`. Governance must therefore count exactly ten `plan-15` entries: this parent plus nine child plans. Before final promotion, parent `in_progress`, `15-01`–`15-07` and `15-09` `completed`, `15-08` `planned`; after verification parent and all nine children become `completed`. IDs are unique and all are stage 13. Parts were ordered so no Web or E2E fixture encodes an unapproved auth DTO. `15-01` was the hard contract gate for versioned auth/onboarding DTOs and the server-owned `apps/server/test/platform/security/auth-onboarding-contract.test.ts`; `15-09` verified the atomic v2 internal seam before 15-04 route composition. `15-06` schema/service work followed 15-01, its Web edits followed 15-05, and its scheduler guard is required before final E2E.

The dependency order is also an ownership boundary: `15-03` owns only first-run wizard and startup gating. It must not construct `AuthService`, add `authService` to `createApp`, or otherwise wire the auth boundary. `15-09` owns the v2 internal `AuthService`/repository/fake contract remediation and its concurrency proof. Only after its PASS may `15-04` own `AuthService` composition and the `createApp`/`AppDeps.authService` route wiring in `create-app.ts` and `main.ts`; it consumes rather than changes the atomic port. `15-06` owns only the separate onboarding composition seam in those files (`ApprovalService` → `ApprovalTransactionPort` → transaction-aware `OnboardingService` → `AppDeps.onboardingService`), with no route-level `db`/approval fallback.

## Migration, rollback and recovery policy

- Исходный этап добавил ровно `026_local_auth.sql` после `025_audit_log.sql`; отдельная таблица `027_onboarding_draft.sql` не добавляется. Модель draft сохраняет существующий CHECK `projects.status` (`ACTIVE|ARCHIVED|DELETED`) и использует `onboarding_configs.status='PROPOSED'`; миграция `021_onboarding_approval.sql` повторно используется без изменений. Ни одну из исторических миграций `001`–`026` не редактировать.
- После независимого review выявлен старый дефект видимого действия «Запросить изменения»: `ApprovalService.requestChanges` пишет `CHANGES_REQUESTED`, которого нет в CHECK таблицы `approvals`. Пользователь отдельно согласовал расширение scope: добавить новую forward-only `027_approval_changes_requested.sql`. Она пересоздаёт только `approvals`, копирует все колонки и строки без изменения ID, восстанавливает исходные индексы и добавляет разрешённый статус; `approval_metadata`, `onboarding_configs` и прочие дочерние данные/FK должны сохраниться. Поскольку production migrator оборачивает каждую migration в транзакцию, а SQLite не меняет `PRAGMA foreign_keys` внутри транзакции, migration-контракт явно разрешает для этой версии контролируемый путь: migrator выключает FK до `BEGIN IMMEDIATE` и проверяет, что PRAGMA вернул OFF; выполняет атомарную пересборку; проверяет `PRAGMA foreign_key_check` до commit. При ошибке migration transaction callback обязан завершиться и migrator обязан подтвердить rollback до восстановления FK. Внешний `finally` migrator-а, уже после commit/rollback и вне транзакции, включает FK ON и проверяет фактическое состояние; ошибку rollback или восстановления нельзя скрывать, startup закрывается fail-closed. Не переключать FK из transaction callback и не использовать `defer_foreign_keys` как замену. Доказать механизм populated upgrade-тестом с реальными дочерними строками и FK ON до/после, а также failure/rollback и повторным запуском. Для onboarding `CHANGES_REQUESTED` проецируется как `DRAFT`, история решения остаётся, новый request создаёт новый approval ID, а `ACTIVE`/scheduler остаются закрытыми до нового `APPROVED`. Покрыть HTTP и реальный browser flow. Запрет на `027_onboarding_draft.sql` сохраняется.
- Fresh and upgraded SQLite fixtures must prove migration idempotence, transaction rollback, foreign keys and singleton constraints. There is no legacy persistent auth data to migrate: old in-memory sessions expire with the old process, and bootstrap files/tokens are discarded rather than imported.
- Before rollout, stop the server and execute the backup/restore rehearsal owned by `15-02`: `pnpm --filter @ebb-orchestrator/server test -- backup-restore.test.ts`. The test copies the closed SQLite file, injects a failed 026 migration, restores the backup after database/process stop, and reruns forward migrations. A failed migration rolls back its transaction and prevents listener/worker startup; no automatic destructive downgrade is part of v1.
- `revokeExpired` performs idempotent cleanup during startup recovery; validation always enforces revoked, idle and absolute limits. Logout is an explicit revocation, not merely cookie deletion.
- If the wizard fails after migrations, the database remains schema-valid but the process does not become READY. Re-run the supported start command interactively; no empty/default password is created.

## No hidden scope / completion definition

Implementation is complete only when every part’s focused RED → GREEN tests pass, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm server:build`, `pnpm web:build`, relevant server security tests, and real `pnpm --filter @ebb-orchestrator/web test:e2e` pass; browser verification covers restart, expiry, logout, CSRF/Origin, onboarding activation guard and Russian accessible names. `git diff --check` must pass and generated temporary bootstrap files must be absent. A reviewer must run `ebb-review-plan` and report `APPROVED` with no BLOCKER/IMPORTANT findings before this draft can be promoted.

## Governance note

The repository’s current canonical roadmap is stale and the plan files are intentionally draft-only. No roadmap or generated status file is modified in this Plan Fixer round. `15-08` owns creation and verification of the repo-relative governance ledger `docs/architecture/plans/governance/evidence/05-plan-15-roadmap-reconciliation.md` with parser-allowed frontmatter `id: ledger-05`, `kind: ledger`, `status: draft`, `title`, `created` and `updated`; `kind: evidence`, an `evidence-*` ID and `status: planned` are forbidden. Run the repository root script `pnpm docs:roadmap -- --output=docs/roadmap/01-roadmap.md`, capture its stdout (`Roadmap generated: ...`, `Plans included: ...`) and exact `docs:check`/`docs:test` results there, read back the exact canonical output, reconcile plan-15 metadata/dependencies, then run `pnpm docs:check` and `pnpm docs:test` again. External Hermes cache paths, absolute user paths and untracked cache artifacts are not evidence inputs.
