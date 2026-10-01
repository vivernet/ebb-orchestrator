---
id: roadmap-02
status: current
kind: roadmap
title: Текущая сверка и последовательность закрытия работ
created: 2026-09-28
updated: 2026-09-30
---

# Текущая сверка и последовательность закрытия работ

Этот документ фиксирует фактическую последовательность закрытия уже принятых обязательств и проверки evidence. Он не создаёт продуктовый scope. Идентификаторы, статусы и зависимости планов авторитетно публикуются в [сгенерированном реестре](generated.md); подробная доказательная сверка находится в [ledger-07](../architecture/plans/governance/evidence/07-current-plan-reconciliation.md).

## Текущие статусы, отличные от `completed`

| Plan | Статус | Следующее условие закрытия |
|---|---|---|
| `plan-04` | `blocked` | Свежая проверка 2026-09-30: `hermes --version` завершается exit 1 без вывода, `pnpm hermes:check` — `CHECK_FAILED` (CLI version, project trust/discovery и delegation settings); `.hermes.md` и 19 canonical skills проходят. Ранее изолированный `pnpm hermes:setup` останавливался до role dispatch на отсутствующем Python `ruamel`. Нужны исправный managed profile/provider, реальный Developer → Reviewer → QA → Integration acceptance и whole-plan review. |
| `plan-05` | `blocked` | Request API/UI, durable request/plan linkage, approval gate, startup resume реализованы; `pnpm plan05:epic-restart:acceptance` PASS на production `dist/main.js` recovery: 12 Runs/12 phases preserved, `FINAL_APPROVAL`, control plan `PENDING`, cleanup PASS. Этот seeded-checkpoint harness не заменяет same-request restart и real Hermes request → Epic. Production ContextManifest producer отсутствует; Proposal 08 принят 2026-09-30, implementation plan проходит независимое review. Решение о PM/Architect summary до materialization покрыто принятым Proposal 06 A; остаются real Hermes acceptance и whole-plan review. |
| `plan-06` | `in_progress` | Production GitHub inbox и Project Config services/UI wired. По решению пользователя capture на Windows fail closed с HTTP 503 до safe-handle verification; Windows happy-path недоступен. Ранее пройденные rollback/restart acceptances предшествуют этому fail-closed revision. Run artifacts показывают только metadata, Settings/Usage read-only projections добавлены; persisted task-bound ContextManifest acceptance остаётся открытым до реализации и acceptance по принятому Proposal 08. Schema v1 — первая поддерживаемая версия без predecessor migration. Остаются supported-platform acceptance, hosted Ubuntu keyring result и whole-plan review. |
| `plan-07` | `blocked` | Актуальный `tools/hermes/fixtures/parity-plan.md` подготовлен. Реальный parity run, два параллельных read-only subagents, provider-backed evidence и teardown report не подтверждены; managed setup блокируется до dispatch, а свежий `pnpm hermes:check` остаётся `CHECK_FAILED` по CLI/trust/discovery/delegation prerequisites. |
| `plan-09` | `in_progress` | После окончательных code/UI правок нужен свежий independent source security scan, disposition findings и whole-plan review. `.github/workflows/codeql.yml` настроен, но hosted scan/SARIF для текущей revision отсутствует; dependency audit отдельно не заменяет source scan, а запуск CI требует разрешённого publication path. |
| `plan-14` | `proposed` | Оставить вне v1 закрытия до подтверждения Docker artifacts/version/hash/architectures, credential bridge и CI/release scope. |
| `plan-16` | `blocked` | Его 97-entry inventory/metadata validator не совпадают с текущим состоянием: 75 путей отсутствуют (включая 11 каталогов), 24 entries имеют Git-state mismatch, external archive target неизвестен. Из 13 acceptance criteria отмечены 2. По строгому gate Plan16 сначала нужно явно одобрить пересмотр устаревшего inventory и предоставить точный archive target; до этого нельзя готовить package или выполнять delete/move/policy side effects. |
| `plan-19` | `in_progress` | Plan review `APPROVED`; Tasks 0/1/2 закрыты. Task 3 частично blocked (managed Hermes dependency); Tasks 4/7 ждут runtime; Task 5 production restart recovery harness PASS в ограниченном fake-seed scope, остаются same-request restart, real Hermes и whole-plan review. Task 6 включает fail-closed Windows capture по решению пользователя; остаются supported-platform acceptance, реализация и acceptance принятого Proposal 08, Ubuntu keyring evidence и whole-plan review. Schema v1 — первый поддерживаемый Project Config формат. Task 8 требует свежий source scan; Task 9 — final gates/reviews и roadmap reconciliation. |

## Очерёдность

1. Закрыть независимые Plan 05/06 остатки: same-request/realtime Hermes acceptance, реализовать принятый дизайн ContextManifest и собрать producer/evidence, supported-platform Config capture acceptance, Ubuntu keyring result and whole-plan reviews.
2. Разблокировать Hermes managed setup без profile/auth копирования; затем выполнить real acceptance Plan 04/05 и parity Plan 07 с безопасной изоляцией.
3. Для Plan 16 получить письменное решение о rebaseline stale inventory и точный external archive target; лишь после этого снимать новый inventory и готовить approval package. Не делать archive/delete или policy edits до explicit approval точного списка и target.
4. После завершения всех изменений подготовить и получить свежий source security scan Plan 09 на том же revision, который прошёл финальные gates; для hosted CI нужен разрешённый publication path.
5. Запустить общие quality/build/browser gates, выполнить independent whole-plan reviews и обновить original plan evidence/status только после PASS.
6. Перегенерировать [Plan Register](generated.md) после подтверждённых lifecycle изменений; не проставлять статусы или чекбоксы без evidence.

## Открытые evidence-reconciliation записи

Планы `02`, `11` и `13` содержат незакрытые исторические execution marks при metadata `completed`. Для них запрещено автоматически восстанавливать прежние legacy paths или повторять мигрированные реализации. Аудит должен сопоставить каждое существенное исходное требование с кодом, тестом, текущим планом-заменой или historical evidence. `plan-01` и `plan-12` закрыты согласно generated register и evidence ledger; `plan-16` заблокирован собственным approval gate.

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
