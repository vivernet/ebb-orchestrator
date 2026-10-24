---
name: ebb-orchestrate-work
description: Используй при начале инженерной работы над Ebb Orchestrator, когда ещё не определён правильный канонический Ebb workflow для задачи.
metadata:
  project: "ebb-orchestrator"
  version: "5.2.0"
---

# Ebb Orchestrate Work

Это корневой routing skill для Ebb Orchestrator. **Канонический workflow должен быть замкнут внутри `ebb-*` skills.** Не делегируй обязательную методологию другому набору skills.

## Primary routing

1. Сначала создай компактный `ebb-repository-context` и определи тип работы.
2. Новый/неясный cross-component design → `ebb-design-change`.
3. Утверждённые требования, требующие нескольких задач → `ebb-write-plan` → `ebb-review-plan` → `ebb-execute-plan`.
4. Одна ограниченная реализационная задача → `ebb-implement-task`.
5. Bug/test/build/unexpected behavior → `ebb-debug-issue` до fix.
6. Move/cleanup/rename/documentation structure/setup tooling → `ebb-repository-maintenance`. Root/nested first-party README и `.env.example` content → `ebb-maintain-project-docs`. Setup/config/API/command changes автоматически добавляют changed-scope docs sync по affected owners/consumers к выбранному primary workflow; full audit только по явному запросу.

## Domain overlays

Domain overlay добавляет специализированные invariants/evidence и **не заменяет primary workflow**.

7. Schema/migrations/persisted-data/transaction/database-engine/lifecycle contract → `ebb-database-engineering` как domain owner внутри выбранного primary workflow.
8. Security-sensitive scope → `ebb-security-review`; Web/HTTP/session/SSE → `ebb-web-e2e`.
9. Перед любым PASS/DONE → `ebb-quality-gates`; перед принятием всего изменения → `ebb-final-review`.
10. После завершения ветки/PR handoff → `ebb-finish-branch`. Создание/изменение Ebb skills → `ebb-curate-skills`.
11. Только явный пользовательский вызов `ebb-release` → release/hotfix/rollback/resume/status workflow. Не вызывай его по завершению task/plan/PR, merge, CI или обнаружению готовности. Publication withdrawal не означает deployment/database rollback.

## Invariants

- Загружай только skills, относящиеся к текущей стадии; references открывай по необходимости.
- Domain specialist владеет domain policy; primary workflow skill не копирует его checklist.
- Не повторяй уже доказанный контекст: controller хранит brief/ledger, leaf-agent получает минимальный self-contained brief.
- При нескольких независимых исследованиях/задачах используй `ebb-dispatch-agents`.
- Не подменяй решение пользователя скрытым предположением о public API, security policy, irreversible cleanup, merge/push/publish.
- Уже утверждённый scope не требует повторного запроса подтверждения без нового существенного решения.
- Ordinary task: pinned `develop` → task branch → PR squash `develop` → post-integration gates. Task local merge и master target запрещены; explicit published-release hotfix/forward-port определяет `ebb-release`.
- `master` только release commits, отсутствует при zero releases. Legacy removal — отдельный reviewed Plan26 после develop preservation/default change, без baseline/dummy/restore/archive commit в master. Approved task, integrated source и candidate identities не смешиваются.
- Docs owner получает affected closure из brief/plan и передаёт evidence до task/gate/finish/release acceptance; каждый task не запускает полный scan проекта.

См. [references/workflow-router.md](references/workflow-router.md) для детальной таблицы переходов.
