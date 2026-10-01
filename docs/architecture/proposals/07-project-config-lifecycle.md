---
id: proposal-07
status: accepted
title: Жизненный цикл Project Config и восстановление после перезапуска
date: 2026-09-29
type: proposal
tags: [project-config, persistence, migration, v1]
---

# Proposal: жизненный цикл Project Config

**Статус:** accepted пользователем 2026-09-29; production persistence, activation и migration выполняются только в рамках утверждённого Plan 19 / Plan 06 scope и описанных ниже границ.

## 1. Goal и non-goals

Определить production source of truth, trust/approval lifecycle, migration и recovery для repository-authored Project Config. Закрыть разрыв Plan 06 Task 9 между onboarding discovery и работающей Project Configuration.

Не входят: автоматическое применение изменений из подключённого репозитория, хранение secrets в Git, замена SQLite, изменение approval/security policy либо изменение scope v1.

## 2. Текущее состояние

- До этого изменения `spec-01`, onboarding/UI концепты и `RepositoryDiscovery` расходились в имени repository config directory; обнаружение не делало config authority.
- §20 определяет versioned repository state, schema versions, fail-closed unknown versions, разделение format/semantic migrations, backup и atomic writes.
- `ConfigMigrator` — generic version gate; он не подключён к durable Project Config repository/service или production activation flow.
- Project-local runtime state, credentials и machine-specific data хранятся отдельно от Git config.

## 3. Подходы и рекомендация

### A. Канонический `.ebb-orchestrator/` (принято пользователем)

Использовать `.ebb-orchestrator/` для repository Project Config, workflows, Guidelines и Decisions. Пользователь явно подтвердил этот path 2026-09-29 и потребовал согласовать с ним spec, onboarding/UI и discovery.

Плюсы: точное имя проекта и согласование с repository storage. Все прежние ссылки на другое имя конфигурационного каталога удаляются; каталог с прежним именем не является legacy source, не обнаруживается и не мигрируется.

### B. Несколько равноправных config directories

Поддерживать более одного canonical config directory.

Отклоняется: при наличии обоих возникает неоднозначность ownership/precedence и риска расхождения двух наборов конфигурации; это требует нового lifecycle contract и превышает необходимый v1 scope.

## 4. Рекомендуемое решение

Использовать только `.ebb-orchestrator/`. Одновременные альтернативные directory sources не поддерживать: они создают неоднозначность ownership и precedence и противоречат утверждённому пользователем требованию брендинга.

## 5. Lifecycle и boundaries

1. `.ebb-orchestrator/` в managed repository — источник candidate config, но не runtime authority. Файлы остаются недоверенными независимо от branch/repository ownership.
2. Discovery — read-only к репозиторию: он собирает candidate и findings; ни parse, ни migration, ни новый Git revision не меняют active config.
3. Candidate содержит Orchestrator-generated `candidateId`, `projectId`, source `HEAD` OID для provenance, manifest path/hash и snapshot точных bytes файлов. В manifest входят добавленные, изменённые и удалённые config files; пути относительны repository root, используют `/`, сортируются ordinal, каждый файл обязан быть regular file. Symlink/junction, path traversal, duplicate normalized paths, неизвестные файлы и превышение application limits отклоняются.
4. Manifest hash — SHA-256 с domain separator `ebb-project-config-manifest-v1\0` и canonical JSON UTF-8 encoding: object keys в фиксированном порядке `files`, `path`, `state`, `sha256`; arrays сортируются ordinal по normalized path; строки кодируются JSON escaping без insignificant whitespace; file states — `present`/`deleted`; digest для deleted entries — `null`. Hash включает все entries, в том числе deletions. `HEAD` хранится отдельно и не заменяет manifest hash, поэтому uncommitted/untracked edits также образуют candidate. Immutable candidate сохраняет точные source bytes каждого `present` file и manifest; UI показывает diff этих bytes и derived normalized preview.
5. Capture проверяет canonical repository root, читает только пути под `.ebb-orchestrator/` через no-follow/reparse-safe path handling и повторно строит manifest после чтения. Если проходы различаются, candidate отбрасывается как unstable; он не записывается как reviewable. На Windows capture запрещён до подтверждённой safe handle/reparse verification и возвращает controlled unavailable error.
6. Создание candidate сериализуется per-project transaction: insert immutable candidate as `PENDING_REVIEW`, transition every prior current `PENDING_REVIEW` candidate to `STALE`, and update the project's `currentCandidateId` pointer atomically. Snapshot capture and parsing happen before this transaction; failed/unstable capture changes neither candidate nor pointer. Idempotency lookup is scoped to the current candidate and active revision only: an identical current `(projectId, manifestHash)` returns that identity; historical/superseded hashes create a fresh candidate and do not reactivate old candidates/revisions.
7. User approval привязан к точному `candidateId` и `manifestHash`, показанным вместе с diff; UI и approval API отправляют обе величины, server сверяет их с immutable persisted candidate. Валидированный результат отдельно получает `revisionHash` — SHA-256 с domain separator `ebb-project-config-revision-v1\0` от canonical JSON UTF-8 normalized payload согласно schema version; canonical encoding фиксирует property order, JSON escaping, числа и отсутствие insignificant whitespace. Persisted revision содержит schema version, normalized payload, `manifestHash` и `revisionHash`. Approval, insert append-only revision, active-pointer update, transition incoming candidate to `APPROVED_ACTIVE`, and transition the formerly active candidate to `SUPERSEDED` выполняются одним compare-and-set transaction; если active revision отсутствует, переход прежнего candidate пропускается. Он требует, что incoming candidate всё ещё `PENDING_REVIEW`, совпадает с `currentCandidateId`, его `manifestHash` точен и expected active revision не изменился. Stale/replaced candidate/hash отклоняется. Restart проверяет `revisionHash` пересчётом по сохранённым schema version и normalized payload; source provenance отдельно связывается с `manifestHash`.
8. Новый candidate не меняет active revision; approved active snapshot действует до атомарного одобрения следующего candidate. Все capture и approval операции используют один per-project serialization/CAS boundary: если capture нового candidate commit первым, прежний становится `STALE` и approval старого отклоняется; если approval commit первым, следующий capture создаёт новый `PENDING_REVIEW`, сохраняя только что одобренную revision active.
9. Runtime читает только active approved snapshot из SQLite. Repository Config не содержит секретные значения или machine-local runtime/auth state; допустимы только logical secret references.

`ProjectConfigService` в существующей Projects module boundary владеет capture orchestration, parse/validation, candidate lifecycle и approval command. `ProjectConfigRepository` владеет SQLite durability/revision history. `RepositoryDiscovery` сообщает только факты о наличии canonical config directory и не выбирает config. `ProjectConfigV1Schema` остаётся schema authority; `ConfigMigrator` возвращает migration result, но не активирует значения. Existing authenticated onboarding/settings routes и UI показывают candidate/hash/diff и передают explicit approval через application service; client не выбирает repository path, project ownership или content hash для другого candidate.

### State transitions

```text
ABSENT → PENDING_REVIEW → APPROVED_ACTIVE
                    ├──→ STALE
                    └──→ INVALID
APPROVED_ACTIVE → SUPERSEDED (only after another candidate is explicitly approved)
```

`INVALID` означает неперсистированный результат validation до создания reviewable candidate; `STALE` означает сохранённый candidate, больше не являющийся current. Ни один из них и failed capture не меняет active pointer. Idempotency применяется только к текущему candidate/active revision с тем же `(projectId, manifestHash)`; исторический `SUPERSEDED` candidate никогда не реактивируется. Capture-versus-approval races разрешаются указанной транзакционной сериализацией; только одна операция может пройти CAS для observed current candidate и active revision.

## 6. Versioning, migration и failure model

- Каждый document имеет явный `schema_version`; неизвестные поля/версии отклоняются fail-closed.
- `schema_version: 1` — первая поддерживаемая версия Project Config. В документации и миграциях репозитория не найден shipped predecessor для `.ebb-orchestrator/project.yaml`; legacy `.orchestrator/` не импортируется и не мигрируется. Поэтому predecessor-format migration не входит в acceptance v1. Будущая несовместимая версия получает explicit format migration только после отдельного design/review; semantic/ambiguous изменения требуют explicit user approval.
- Каждая format или semantic migration только создаёт новый immutable candidate. Даже детерминированная format migration не меняет active snapshot; новая точная версия/hash требует explicit user approval. Semantic/ambiguous migration возвращает `USER_DECISION_REQUIRED` и сохраняет текущий active snapshot.
- Approved revisions и active pointer хранятся в SQLite. Revision insert и pointer compare-and-set — одна транзакция; crash до commit сохраняет прежний active pointer, crash после commit восстанавливает новую approved revision целиком.
- Отдельный filesystem backup на каждое config approval не создаётся: SQLite transaction и append-only revision history защищают update. Перед SQLite schema migration действует существующий обязательный verified database backup; его failure останавливает startup до migration. Database restore восстанавливает согласованный DB snapshot целиком; application-level rollback к прежней config revision — отдельное authenticated user action и audit event.
- На restart runtime проверяет schema/hash активной revision до dispatch. Missing/corrupt/unsupported active revision переводит только affected Project в `DEGRADED`/blocked configuration state, не запускает его Agents и не подставляет repository candidate, defaults или предыдущую revision автоматически. Ремонт/rollback требует explicit approval; revision history сохраняется для восстановления.
- Одновременные capture/approval requests сериализуются per-project compare-and-set по `currentCandidateId`, `candidateId`, `manifestHash` и ожидаемому active revision. Повторная команда idempotent только для той же approval identity/hash; approval candidate со статусом `STALE` или не являющегося current отклоняется.

## 7. Security

Repository config, Git metadata, paths и все текстовые поля — недоверенный ввод. Нельзя исполнять directives/hooks из конфигурации. Capture фиксирует canonical repository root один раз, отказывает для symlink/reparse point на любом сегменте, открывает файлы no-follow, проверяет identity/metadata до и после чтения и повторно подтверждает content manifest. Изменение файлов во время capture даёт controlled `CONFIG_CANDIDATE_UNSTABLE`, а не частичный candidate. User approval привязан к immutable snapshot bytes и exact content hash; текст репозитория не становится policy override. Credentials живут только в SecretStore; runtime state — только в local home/SQLite.

## 8. Compatibility и migration

Repository-authored changes никогда не применяются автоматически. Discovery может читать и проверять candidate, но active snapshot изменяется только после review и явного одобрения пользователя. Источник, `HEAD`, manifest, content hash и approval identity фиксируются в durable provenance. Directory вне canonical `.ebb-orchestrator/` не импортируется, не переименовывается и не мигрируется автоматически.

Публичный path decision уже принят и согласован с §4/§20.1 `spec-01`, onboarding/UI и discovery. Оставшиеся lifecycle детали должны пройти design approval до реализации. Реализация ограничивается существующими Project/onboarding/settings, SQLite, approval и UI boundaries; новые runtime roles, policy authority или deployment subsystem не добавляются.

## 9. Verification

- Unit: schema/version validation, canonical path boundary/encoding and both hash algorithms across HEAD/dirty/untracked/deleted files, source-to-normalized revision binding, candidate vs active transitions, atomic current-candidate replacement, capture/approval race orderings, compare-and-set, idempotency and rejection of config outside the canonical repository root.
- Persistence/recovery: atomic approved snapshot and active pointer, crash before/after transaction, DB migration backup failure, restore, restart with active + pending/stale candidate, corrupt/unsupported active revision blocks Project dispatch without fallback.
- Security: traversal/symlink/junction/reparse points, changing files during capture, hostile text, unknown fields/version, secret redaction, approval-to-immutable-exact-hash binding and cross-project isolation.
- API/UI: project ownership, local session/Origin/CSRF, explicit diff review, stale candidate approval rejection.
- Migration: every supported format migration creates a reviewable candidate; semantic migration returns `USER_DECISION_REQUIRED`; migration failure preserves current active pointer; никакое repository изменение само не активируется.

## 10. Proposed implementation map

- Extend `apps/server/src/platform/config/project-config.ts` only for versioned parsing/normalization contract; it remains free of persistence and approval side effects.
- Add candidate/active-snapshot application service and repository under `apps/server/src/modules/projects/`, reusing the existing Projects ownership boundary.
- Add an append-only SQLite migration after already reserved Plan 19 migration numbers `031` (PlanningRequest linkage) and `032` (GitHub feedback); migration owner assigns the next available sequence in Task 6.
- Extend the existing onboarding/configuration server composition in `apps/server/src/main.ts`, `apps/server/src/app/create-app.ts` and authenticated route boundary; do not create a parallel approval authority.
- Extend existing project configuration/onboarding UI under `apps/web/src/features/` to display the exact candidate diff/hash and require explicit approval.
- Add unit, persistence, API/security and UI tests under existing server/web test trees, with production restart acceptance in a disposable project/home.

## 11. Принятое решение и review

Пользователь 2026-09-29 утвердил `.ebb-orchestrator/` как единственный repository config directory, запретил автоматическое применение repo-authored изменений и 2026-09-29 принял полный lifecycle design. Независимый review proposal завершился `PASS`; `spec-01`, onboarding/UI concepts, discovery и tests согласуются с canonical path.

Дополнение к принятому решению (2026-09-30): Project Config capture на Windows должен fail closed до реализации и проверки safe handle/reparse verification. До этого `ProjectConfigService.capture` возвращает `PROJECT_CONFIG_UNSUPPORTED_PLATFORM` (HTTP 503) до чтения файлов и создания candidate. Windows acceptance подтверждает этот отказ и отсутствие candidate/state записей; полный lifecycle/restart сценарий на Windows получает `WAIVED / NOT RUN` и не засчитывается как supported-platform acceptance.
