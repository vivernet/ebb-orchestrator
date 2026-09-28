---
name: ebb-implement-task
description: Используй, когда нужно реализовать одну задачу утверждённого плана Ebb Orchestrator или один ограниченный bugfix с проверяемым scope.
metadata:
  project: "ebb-orchestrator"
  version: "4.0.0"
---

# Ebb Implement Task

Исполняй ровно одну task или один подтверждённый bounded finding cluster.

**Companion:** используй Superpowers `test-driven-development` для behavior changes/bugfixes. Ebb scope policy имеет приоритет над generic full-suite default: task обязана доказать focused + plan-required checks; repository-wide suite выполняй здесь только если plan/repository policy требует её на каждой task, иначе её владеет `ebb-quality-gates`/final stage.

## Cycle

1. Прими task brief с exact paths, contracts, acceptance, commands и dependency rulings. Проверь branch/HEAD/status и pre-existing changes.
2. Для нового поведения/регрессии получи meaningful RED: ожидаемая assertion/failure reason, а не просто non-zero exit или setup error.
3. Сделай минимальный GREEN fix; не расширяй scope «заодно». Затем refactor только при сохранённом GREEN.
4. Запусти focused tests, neighboring checks и task-required typecheck/build/docs/security/E2E gates; зафиксируй actual selected tests/counts, когда forwarding команды может быть неоднозначным.
5. Передай diff + task requirements + evidence свежему reviewer. Если используется Superpowers `requesting-code-review`/SDD reviewer dispatch, rubric — `ebb-review-task`.
6. Для подтверждённых findings делай узкий fix и scoped re-review. Не переоткрывай unrelated scope; после повторяющихся неудачных раундов эскалируй root cause/model согласно execution workflow.
7. Security-sensitive scope требует `ebb-security-review`; browser/HTTP/session/SSE — `ebb-web-e2e`.
8. Верни changed paths, exact commands/results, review verdict и ограничения. Не заявляй `PASS` без свежего evidence.

Не начинай dependent task, пока prerequisite не принят. Broader-suite failure можно классифицировать как external dependency только после воспроизведения и доказательства ownership; тесты/fixtures нельзя ослаблять, чтобы скрыть красную зависимость.
