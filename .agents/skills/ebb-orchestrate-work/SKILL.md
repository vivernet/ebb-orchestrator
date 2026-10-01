---
name: ebb-orchestrate-work
description: Используй при начале инженерной работы над Ebb Orchestrator, когда ещё не определён правильный канонический Ebb workflow для задачи.
metadata:
  project: "ebb-orchestrator"
  version: "5.1.0"
---

# Ebb Orchestrate Work

Это корневой routing skill для Ebb Orchestrator. **Канонический workflow должен быть замкнут внутри `ebb-*` skills.** Не делегируй обязательную методологию другому набору skills.

## Primary routing

1. Сначала создай компактный `ebb-repository-context` и определи тип работы.
2. Новый/неясный cross-component design → `ebb-design-change`.
3. Утверждённые требования, требующие нескольких задач → `ebb-write-plan` → `ebb-review-plan` → `ebb-execute-plan`.
4. Одна ограниченная реализационная задача → `ebb-implement-task`.
5. Bug/test/build/unexpected behavior → `ebb-debug-issue` до fix.
6. Move/cleanup/setup/docs/tooling → `ebb-repository-maintenance`.

## Domain overlays

Domain overlay добавляет специализированные invariants/evidence и **не заменяет primary workflow**.

7. Schema/migrations/persisted-data/transaction/database-engine/lifecycle contract → `ebb-database-engineering` как domain owner внутри выбранного primary workflow.
8. Security-sensitive scope → `ebb-security-review`; Web/HTTP/session/SSE → `ebb-web-e2e`.
9. Перед любым PASS/DONE → `ebb-quality-gates`; перед принятием всего изменения → `ebb-final-review`.
10. После завершения ветки/PR handoff → `ebb-finish-branch`. Создание/изменение Ebb skills → `ebb-curate-skills`.

## Invariants

- Загружай только skills, относящиеся к текущей стадии; references открывай по необходимости.
- Domain specialist владеет domain policy; primary workflow skill не копирует его checklist.
- Не повторяй уже доказанный контекст: controller хранит brief/ledger, leaf-agent получает минимальный self-contained brief.
- При нескольких независимых исследованиях/задачах используй `ebb-dispatch-agents`.
- Не подменяй решение пользователя скрытым предположением о public API, security policy, irreversible cleanup, merge/push/publish.
- Уже утверждённый scope не требует повторного запроса подтверждения без нового существенного решения.

См. [references/workflow-router.md](references/workflow-router.md) для детальной таблицы переходов.
