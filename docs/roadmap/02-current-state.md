---
id: roadmap-02
status: current
kind: roadmap
title: Текущая сверка и последовательность закрытия работ
created: 2026-09-28
updated: 2026-09-29
---

# Текущая сверка и последовательность закрытия работ

Этот документ фиксирует фактическую последовательность закрытия уже принятых обязательств и проверки evidence. Он не создаёт продуктовый scope. Идентификаторы, статусы и зависимости планов авторитетно публикуются в [сгенерированном реестре](generated.md); подробная доказательная сверка находится в [ledger-07](../architecture/plans/governance/evidence/07-current-plan-reconciliation.md).

## Текущие статусы, отличные от `completed`

| Plan | Статус | Следующее условие закрытия |
|---|---|---|
| `plan-04` | `blocked` | Восстановить поддерживаемые Hermes CLI/profile и настроенный OpenAI-compatible provider в SecretStore; затем получить реальный Developer → Reviewer → QA → Integration acceptance и whole-plan review. |
| `plan-05` | `blocked` | Принять/revise request-to-Epic proposal, реализовать natural-language request flow и startup resume; доказать реальный Hermes Epic и process kill/restart без дубликатов. |
| `plan-06` | `in_progress` | Принять GitHub mapping proposal и утвердить Project Config lifecycle; включить production feedback worker/inbox, пройти keyring/crash/release acceptance и whole-plan review. |
| `plan-07` | `blocked` | После Hermes readiness завершить parity run через `pnpm hermes:execute`, сохранить PASS report, подтвердить двух read-only subagents и clean teardown. |
| `plan-09` | `in_progress` | После финальных code changes получить свежий source security scan, закрыть findings и повторить whole-plan review. Dependency audit отдельно не заменяет source scan. |
| `plan-14` | `proposed` | Оставить вне v1 закрытия до подтверждения Docker artifacts/version/hash/architectures, credential bridge и CI/release scope. |
| `plan-16` | `blocked` | Перед external archive/delete пользователь должен одобрить frozen 97-entry disposition, точный archive target и proposed README/policy changes после завершения текущей проверки. |
| `plan-19` | `proposed` | Пройти независимый plan review и принять решения по GitHub feedback mapping, Coordinator request/recovery, Project Config lifecycle и source-scanner route до реализации зависимых задач. |

## Очерёдность

1. Пройти `plan-19` Task 0 и Task 1: явно принять proposals 05/06 и утвердить Project Config lifecycle; иначе связанные implementation tasks остаются заблокированы.
2. Восстановить Hermes readiness, затем закрыть real provider acceptance для `plan-04`, request-to-Epic/restart для `plan-05` и parity для `plan-07`.
3. Реализовать approved GitHub feedback/config lifecycle для `plan-06`; после всех code changes получить fresh source security scan для `plan-09`.
4. Запустить общие quality/build/browser gates, выполнить independent whole-plan reviews и обновить original plan evidence/status только после PASS.
5. Перегенерировать [Plan Register](generated.md) после подтверждённых lifecycle изменений; не проставлять статусы или чекбоксы без evidence.

## Открытые evidence-reconciliation записи

Планы `02`, `11` и `13` содержат незакрытые исторические execution marks при metadata `completed`. Для них запрещено автоматически восстанавливать прежние legacy paths или повторять мигрированные реализации. Аудит должен сопоставить каждое существенное исходное требование с кодом, тестом, текущим планом-заменой или historical evidence. `plan-01` и `plan-12` закрыты согласно generated register и evidence ledger; `plan-16` заблокирован собственным approval gate.

План `00-02` закрыт по отдельному AGENTS review. Его closeout должен включать перечисленные в самом плане поля отчёта, результат `git diff --check`, unresolved governance handoff по metadata и факт, что коммит не создавался. Это не разрешение включать несвязанные изменения в коммит.

## Вопросы, требующие scope/governance решения

- Спецификации `spec-01`–`spec-03` теперь имеют metadata `current`, согласованную с их активным использованием как design contracts; исторические implementation sequence не тождественны статусу самих contracts.
- `docs/reference/ui/01-03-ui-spec.md`, `02-03-ui-spec.md` и `03-03-ui-spec.md` — пустые placeholders со статусом `planned`. Их заполнение создаст/уточнит UI scope и требует отдельного решения; до него они остаются явно неразрешённым disposition, а не завершёнными задачами.
- Docker runtime в `plan-14` — будущий scope. Наличие draft не является разрешением на реализацию.
- Proposals `05` и `06` задают неутверждённые решения для `plan-06` и `plan-05`; implementation ждёт явного принятия.
- Project Config lifecycle в `plan-06` требует design contract до production wiring; generic `ConfigMigrator` не является подключённым Project Config store.
- Свежий source security scan для `plan-09` отсутствует. CodeQL route требует подтвердить доступность Code Scanning для repository; dependency audit остаётся отдельным контролем.
- Реальные Hermes acceptance `plan-04/05/07` требуют поддерживаемого CLI/profile и provider; прежние разрешённые runs завершились без acceptance evidence.

## Завершённые проверки этой сверки

- Список статусов сверяется с Plan metadata и [generated register](generated.md); `plan-01` и `plan-12` уже `completed`, `plan-19` координирует закрытие `plan-04/05/06/07/09`.
- Полный локальный suite и documentation gates записаны в `ledger-07`; они не заменяют provider acceptance, fresh security scan или оставшиеся independent reviews.
- Никакие внешние изменения, commit, push или merge этим roadmap не разрешаются.
