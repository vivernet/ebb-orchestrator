---
id: roadmap-02
status: current
kind: roadmap
title: Текущая сверка и последовательность закрытия работ
created: 2026-09-28
updated: 2026-09-28
---

# Текущая сверка и последовательность закрытия работ

Этот документ фиксирует фактическую последовательность закрытия уже принятых обязательств и проверки evidence. Он не создаёт продуктовый scope. Идентификаторы, статусы и зависимости планов авторитетно публикуются в [сгенерированном реестре](generated.md); подробная доказательная сверка находится в [ledger-07](../architecture/plans/governance/evidence/07-current-plan-reconciliation.md).

## Текущие статусы, отличные от `completed`

| Plan | Статус | Следующее условие закрытия |
|---|---|---|
| `plan-01` | `in_progress` | Добавить process-level recovery acceptance: остановить и перезапустить сервер, когда одновременно ожидают durable outbox event и retryable job; проверить один запуск migration, redelivery, lease reclaim и переход startup до READY. |
| `plan-04` | `blocked` | Использовать настроенный OpenAI-compatible provider через SecretStore либо получить решение по безопасной OAuth-границе; затем выполнить provider-backed Developer → Reviewer → QA → Integration acceptance и review. |
| `plan-05` | `blocked` | Зафиксировать workflow/API acceptance, совместимый с текущим scope, затем доказать реальный Hermes → Epic и restart/resume; текущий FakeAgentRuntime не является заменой. |
| `plan-06` | `in_progress` | Подтвердить durable/idempotent GitHub feedback, production backup/config-migration wiring, реальную crash/restart matrix и Windows+Unix keyring acceptance; исправить отдельные findings по мере проверки. |
| `plan-07` | `blocked` | Получить завершившийся provider-backed parity run с report и доказанной очисткой; предыдущий разрешённый запуск завершился timeout. |
| `plan-09` | `in_progress` | Pre-READY cancellation и остановка workers исправлены и прошли focused review/gates. Ввести testable production composition seam для зависимостей без listen/spawn; завершить supported source security scan и повторный whole-plan review. `pnpm audit` не заменяет source scan. |
| `plan-12` | `in_progress` | Lifecycle cancellation race исправлена. Убрать runtime DDL из сервисов и покрыть fresh/upgraded DB migrations; затем выполнить controlled process restart, browser/runtime acceptance и independent whole-plan review. |
| `plan-14` | `proposed` | Оставить вне v1 закрытия до подтверждения Docker artifacts/version/hash/architectures, credential bridge и CI/release scope. |
| `plan-16` | `blocked` | Перед external archive/delete пользователь должен одобрить frozen 97-entry disposition, точный archive target и proposed README/policy changes после завершения текущей проверки. |

## Очерёдность

1. Завершить текущую сверку completed-планов с незакрытыми историческими чек-листами. По каждому содержательному пункту добавить ссылку на актуальную реализацию и acceptance evidence либо вернуть план в активный статус, если исходное обязательство остаётся без доказательства. Не массово проставлять чекбоксы.
2. Закрыть технические acceptance Plan `01` и `06`, а также исправить findings по `09` и `12`; `03` и `08-02` закрыты после fixes, review и gates.
3. Для `plan-04`, `plan-05` и `plan-07` выполнять только уже разрешённые provider acceptance runs. Сейчас в process env нет Hermes provider bridge config и `HERMES_MODEL`, а `pnpm hermes:check` завершился `FAILED`; без полного настроенного config run не подтверждает acceptance. Если credential, provider или acceptance contract отсутствуют, сохранить точный blocker; не подменять runtime fake-тестом.
4. Определить судьбу пустых UI reference placeholders. Metadata specs `01`–`03` уже согласованы с текущими нормативными ссылками; design contracts не менялись.
5. Перегенерировать этот документ и [Plan Register](generated.md) после подтверждённых изменений; сверить, что generated statuses соответствуют frontmatter всех `kind: plan`.

## Открытые evidence-reconciliation записи

Планы `02`, `11` и `13` содержат незакрытые исторические execution marks при metadata `completed`. Для них запрещено автоматически восстанавливать прежние legacy paths или повторять мигрированные реализации. Аудит должен сопоставить каждое существенное исходное требование с кодом, тестом, текущим планом-заменой или historical evidence. Plan `01`, `03` и `06` возвращены в `in_progress` из-за открытых acceptance criteria; `16` заблокирован собственным approval gate.

План `00-02` закрыт по отдельному AGENTS review. Его closeout должен включать перечисленные в самом плане поля отчёта, результат `git diff --check`, unresolved governance handoff по metadata и факт, что коммит не создавался. Это не разрешение включать несвязанные изменения в коммит.

## Вопросы, требующие scope/governance решения

- Спецификации `spec-01`–`spec-03` теперь имеют metadata `current`, согласованную с их активным использованием как design contracts; исторические implementation sequence не тождественны статусу самих contracts.
- `docs/reference/ui/01-03-ui-spec.md`, `02-03-ui-spec.md` и `03-03-ui-spec.md` — пустые placeholders со статусом `planned`. Их заполнение создаст/уточнит UI scope и требует отдельного решения; до него они остаются явно неразрешённым disposition, а не завершёнными задачами.
- Docker runtime в `plan-14` — будущий scope. Наличие draft не является разрешением на реализацию.

## Завершённые проверки этой сверки

- Реестр содержит 32 документа `kind: plan`; девять статусов выше отличаются от `completed`.
- Полный локальный suite и documentation gates записаны в `ledger-07`; они не заменяют provider acceptance, fresh security scan или оставшиеся independent reviews.
- Никакие внешние изменения, commit, push или merge этим roadmap не разрешаются.
