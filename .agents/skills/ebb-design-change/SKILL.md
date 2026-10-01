---
name: ebb-design-change
description: Используй, когда изменение Ebb Orchestrator требует проектных решений, новой архитектуры, нового subsystem/interface или уточнения поведения до написания implementation plan.
metadata:
  project: "ebb-orchestrator"
  version: "5.1.0"
---

# Ebb Design Change

Цель — превратить намерение в проверяемый approved design до планирования реализации.

## Classify

- **Spike:** вопрос о feasibility; результат — evidence/recommendation, не production implementation.
- **Bounded design:** существующий поток, небольшое изменение контракта; достаточно короткого design note.
- **Architectural:** новый subsystem, cross-component interface либо изменение load-bearing persistence/security/lifecycle contract; нужен design document.

## Workflow

1. Получи `ebb-repository-context`; сформулируй intended outcome, constraints и success criteria. Не спрашивай повторно то, что пользователь уже явно решил.
2. Выяви только решения, реально меняющие product/API/security/data/lifecycle contract. Для независимых исследований используй `ebb-dispatch-agents`.
3. Для architectural scope предложи 2–3 жизнеспособных подхода с trade-offs; выбери рекомендуемый на основании repository constraints, YAGNI и failure modes.
4. Design фиксирует: boundaries/owners, interfaces, data/state transitions, failure/recovery, security assumptions, migration/compatibility, verification strategy и non-goals. Если меняется database contract, получи database-specific invariants/risks из `ebb-database-engineering`, не дублируя его policy в design skill.
5. Проверь design на placeholders, contradictions, скрытые решения и недоказанные assumptions.
6. Перед implementation-plan стадией design должен быть явно принят пользователем либо уже считаться утверждённым authoritative artifact проекта. Изменение load-bearing решения инвалидирует прежнее approval.
7. После approval передай design в `ebb-write-plan`.

Формат: [references/design-format.md](references/design-format.md).
