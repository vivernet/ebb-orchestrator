---
id: roadmap-02
status: current
kind: roadmap
title: Текущая сверка и последовательность закрытия работ
created: 2026-09-28
updated: 2026-10-03
---

# Текущая сверка и последовательность закрытия работ

Этот документ фиксирует фактическую последовательность закрытия уже принятых обязательств и проверки evidence. Он не создаёт продуктовый scope. Идентификаторы, статусы и зависимости планов авторитетно публикуются в [сгенерированном реестре](generated.md); подробная доказательная сверка находится в [ledger-07](../architecture/plans/governance/evidence/07-current-plan-reconciliation.md).

## Текущие статусы, отличные от `completed`

| Plan | Статус | Следующее условие закрытия |
|---|---|---|
| `plan-04` | `blocked` | Developer readiness обновлена 2026-10-02: установленный Hermes CLI, `pnpm hermes:check` и disposable-profile setup прошли; provider/auth/network не проверялись. `hermes:check` не снимает runtime gate. После безопасного Hermes-native per-Run профиля/auth path по Plan20 нужны реальный provider-backed Developer → Reviewer → QA → Integration acceptance и whole-plan review. |
| `plan-05` | `blocked` | Request API/UI, durable request/plan linkage, approval gate, startup resume реализованы; `pnpm plan05:epic-restart:acceptance` PASS на production `dist/main.js` recovery: 12 Runs/12 phases preserved, `FINAL_APPROVAL`, control plan `PENDING`, cleanup PASS. Этот seeded-checkpoint harness не заменяет same-request restart и real Hermes request → Epic. Production ContextManifest producer отсутствует; Proposal 08 принят 2026-09-30, implementation plan проходит независимое review. Решение о PM/Architect summary до materialization покрыто принятым Proposal 06 A; остаются real Hermes acceptance и whole-plan review. |
| `plan-06` | `in_progress` | Production GitHub inbox и Project Config services/UI wired. По решению пользователя capture на Windows fail closed с HTTP 503 до safe-handle verification; Windows happy-path недоступен. Ранее пройденные rollback/restart acceptances предшествуют этому fail-closed revision. Run artifacts показывают только metadata, Settings/Usage read-only projections добавлены; persisted task-bound ContextManifest acceptance остаётся открытым до реализации и acceptance по принятому Proposal 08. Schema v1 — первая поддерживаемая версия без predecessor migration. Остаются supported-platform acceptance, hosted Ubuntu keyring result и whole-plan review. |
| `plan-07` | `blocked` | Актуальный `tools/hermes/fixtures/parity-plan.md` подготовлен. Developer readiness (`hermes --version`, `pnpm hermes:check`, disposable-profile setup) прошла 2026-10-02, но это не provider acceptance. Реальный parity run, два параллельных read-only subagents, provider-backed evidence и teardown report не подтверждены; запуск ждёт безопасный native provider/profile path и отдельный parity acceptance. |
| `plan-09` | `in_progress` | После окончательных code/UI правок нужен свежий independent source security scan, disposition findings и whole-plan review. `.github/workflows/codeql.yml` настроен, но hosted scan/SARIF для текущей revision отсутствует; dependency audit отдельно не заменяет source scan, а запуск CI требует разрешённого publication path. |
| `plan-14` | `proposed` | Оставить вне v1 закрытия до подтверждения Docker artifacts/version/hash/architectures, credential bridge и CI/release scope. |
| `plan-16` | `blocked` | Rebaseline 2026-10-02 классифицировал 97 путей: 75 уже отсутствовали, 14 актуальных README/инструкций/активных планов сохранены, 8 точных исторических файлов удалены без архива в `966f1ec`. Других целей удаления этот inventory не содержит. Остаются аудит команд и актуализация README/governance; статус плана не менялся. |
| `plan-19` | `in_progress` | Plan review `APPROVED`; Tasks 0/1/2 закрыты. Task 3 developer Hermes readiness PASS на 2026-10-02; real provider acceptance — отдельный gate. Tasks 4/7 ждут безопасный native provider/profile path и runtime acceptance; Task 5 production restart recovery harness PASS только в ограниченном fake-seed scope, остаются same-request restart, real Hermes и whole-plan review. Task 6 включает fail-closed Windows capture по решению пользователя; остаются supported-platform acceptance, реализация и acceptance принятого Proposal 08, Ubuntu keyring evidence и whole-plan review. Schema v1 — первый поддерживаемый Project Config формат. Task 8 требует свежий source scan; Task 9 — final gates/reviews и roadmap reconciliation. |
| `plan-20` | `in_progress` | Независимый Plan20 review получил `APPROVED` 2026-10-02; первые baseline Tasks 0–3 проверены без runtime-изменений: `pnpm docs:check`, provenance — 19/19, role/context — 79/79, migration preservation — 20/20; server typecheck PASS. Подтверждены обратная зависимость Plan05/06 → downstream, durable `session_id`, process-stop evidence, 13 subject/role pairs, 18 producer bindings, три отдельно проверяемых event consumers и сохранение `context_deltas`/FK. Пользователь утвердил направление Proposal09: Runs используют уже настроенные Hermes-native provider/auth; второй Ebb SecretStore credential и root `.env` provider key не требуются. Старые provider/model значения являются историческими observations. Runtime/provider acceptance и Tasks 4–7 остаются впереди; статусы Plan05/06/19 не менялись.

## Очерёдность

1. Довести Plan20 до исполнимого состояния и получить новое независимое `APPROVED`; до этого не начинать его runtime implementation.
2. После approval реализовать Plan20, пройти его migration/profile/session/provider acceptance и independent recovery/architecture review. Только затем обновлять связанные обязательства Plan05/06/19, и только после их собственных gates.
3. После готовности Hermes-native profile/auth path выполнить реальный Plan04 acceptance и Plan07 parity; developer `hermes:check` сам по себе эти gates не закрывает.
4. Для Plan16 использовать выполненный rebaseline и удаление восьми точных исторических файлов без архива; завершить оставшиеся README, command-matrix и governance obligations. Не расширять удаление за пределы зафиксированного inventory без отдельного точного disposition.
5. После завершения source changes подготовить свежий Plan09 source security scan на том же revision, который прошёл финальные gates; для hosted CI нужен разрешённый publication path.
6. Провести closure audit всех планов, кроме Plan14, затем общие quality/build/browser gates, independent whole-plan reviews, reconciliation и lifecycle updates по evidence.
7. Перегенерировать [Plan Register](generated.md) после подтверждённых lifecycle изменений; не проставлять статусы или чекбоксы без evidence.

## Открытые evidence-reconciliation записи

Планы `02`, `11` и `13` содержат незакрытые исторические execution marks при metadata `completed`. Для них запрещено автоматически восстанавливать прежние legacy paths или повторять мигрированные реализации. Аудит должен сопоставить каждое существенное исходное требование с кодом, тестом, текущим планом-заменой или historical evidence. `plan-01` и `plan-12` закрыты согласно generated register и evidence ledger; `plan-16` остаётся заблокирован из-за незавершённых README, command-matrix и governance obligations.

План `00-02` закрыт по отдельному AGENTS review; его closeout `AGENTS_POLICY_APPROVED`, перечень проверенных инструкций, результат `git diff --check` и факт отсутствия отдельного коммита записаны в самом плане (2026-09-28). Устаревшее утверждение о предстоящем closeout снято.

## Вопросы, требующие scope/governance решения

- Спецификации `spec-01`–`spec-03` теперь имеют metadata `current`, согласованную с их активным использованием как design contracts; исторические implementation sequence не тождественны статусу самих contracts.
- `docs/reference/ui/01-03-ui-spec.md`, `02-03-ui-spec.md` и `03-03-ui-spec.md` — пустые placeholders со статусом `planned`. Их заполнение создаст/уточнит UI scope и требует отдельного решения; до него они остаются явно неразрешённым disposition, а не завершёнными задачами.
- Docker runtime в `plan-14` — будущий scope. Наличие draft не является разрешением на реализацию.
- Proposals `05` и `06` приняты пользователем 2026-09-29: Project-scoped inbox с retention до явного удаления и обязательным UI; project-scoped request API, обязательный minimal UI и resume одобренных Epic до `READY`. Основная implementation и production acceptance для inbox завершены; остаются исходные UI-обязательства Plan 06 и process/provider acceptance Plan 05.
- Project Config path `.ebb-orchestrator/`, запрет автоматического применения repo-authored config и полный lifecycle Proposal 07 приняты после независимого design review PASS. Production store/routes/UI и restart/rollback acceptance реализованы. По решению пользователя Windows capture теперь fail closed до safe-handle verification; schema v1 является первой поддерживаемой версией без predecessor migration. Supported-platform acceptance остаётся открытым. PM/Architect approval summary timing уже определён принятым Proposal 06 вариантом A.
- Свежий source security scan для `plan-09` отсутствует. CodeQL route требует подтвердить доступность Code Scanning для repository; dependency audit остаётся отдельным контролем.
- Реальные Hermes acceptance `plan-04/05/07` требуют поддерживаемого isolated CLI/profile и provider; текущая проверка managed setup завершается до role dispatch из-за `ruamel` provision failure, поэтому personal-profile smoke не закрывает эти gates.

## Завершённые проверки этой сверки

- Plan metadata и [generated register](generated.md) сверены: 33 записи совпадают по ID/status/title. Этот register публикует lifecycle, но narrative и evidence требуют обновления после последнего acceptance.
- Полный локальный suite и documentation gates записаны в `ledger-07`; они не заменяют provider acceptance, fresh security scan или оставшиеся independent reviews.
- Никакие внешние изменения, commit, push или merge этим roadmap не разрешаются.

## Дополнение по evidence от 2026-10-02

Таблица и dated notes выше сохранены как снимок предыдущей сверки. Следующие факты относятся к текущему checkout и уточняют более ранние environment-dependent наблюдения, не удаляя их исторический контекст.

- Refs сейчас: `develop=4336b95`, `master=d74a784`, `origin/master=6eb51ae`; более ранняя запись, что обе локальные ветки указывали на `6eb51ae`, отражает промежуточный post-merge checkpoint.
- Вне sandbox `hermes --version` и `pnpm hermes:check` прошли для Hermes `v0.21.5+4831.g02e4118`; sandbox-side failure был связан с denied access к bundled Python в ограниченной среде. Wrapper tests прошли 28/28, scoped ESLint и независимый scoped review PASS. Это не provider-backed acceptance: его не запускали, поэтому runtime/provider acceptance остаётся открытым. Пользовательский профиль и credentials не читались и не менялись.
- Для Plan09 настроен hosted CodeQL workflow на push `master`/`develop`, PR в `master` и weekly schedule. CodeQL run/result или SARIF для текущей revision `4336b95` отсутствует. `pnpm audit` dependency artifacts не являются source scan evidence.
- Plan16 остаётся `blocked`; на момент этой сверки не было одобренного rebaseline, точного external destination и письменного approval полного disposition package. Архивирование, удаление и перемещение файлов были запрещены до получения этих решений.
- All-plan audit ещё не является полной матрицей проверки требований и checklist items. Ранее зафиксированные 525 исторических unchecked procedural marks требуют индивидуального evidence disposition; они не равны 525 доказанным дефектам.
- `docs/roadmap/generated.md` сейчас содержит 34 Plan и совпадает с Plan frontmatter по ID/title/status. Указание выше о 33 записях относится к предыдущему snapshot. Статусы не менялись и реестр не перегенерировался.

## Дополнение от 2026-10-03 — решение по старым материалам Plan16

- Пользователь подтвердил, что старые материалы являются мусором и должны удаляться, а не архивироваться. В рамках точного Plan16 rebaseline восемь tracked historical targets уже удалены по одному после проверки path, Git tracking и SHA-256; коммит `966f1ec` содержит эти удаления.
- Остальные 75/97 inventory entries уже отсутствовали; 14 существующих путей — актуальные README, инструкции и активные Plan15 документы — сохранены. В этом inventory новых исторических delete targets нет, и broader filesystem cleanup не выполнялся.
- Старые формулировки о необходимости внешнего archive target и approval rebaseline больше не являются текущими prerequisites. Plan16 остаётся `blocked` по независимым незавершённым README, command-matrix и governance acceptance criteria; статус не менялся.
