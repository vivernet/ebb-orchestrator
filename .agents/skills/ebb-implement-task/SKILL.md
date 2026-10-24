---
name: ebb-implement-task
description: Используй для реализации одной назначенной задачи Ebb Orchestrator или одного подтверждённого ограниченного finding cluster с test-first evidence и контролем scope.
metadata:
  project: "ebb-orchestrator"
  version: "5.2.0"
---

# Ebb Implement Task

Исполняй ровно одну task. Core rule для behavior change/bugfix: **сначала доказуемый failing test/reproduction, потом production change.**

1. Прими task brief: scope, exact files/interfaces, acceptance, commands и protected unrelated changes. Зафиксируй pinned `develop_base_sha`, task branch/HEAD, diff BASE/status и baseline; обычная task идёт через PR squash в `develop`. Валидируй предоставленный workspace через `ebb-worktree`, не создавай вложенный автоматически.
2. Выполни applicable domain preflight до production change: database contract → `ebb-database-engineering`; security boundary → security requirements; browser/HTTP/session/SSE → E2E requirements. Не загружай specialist skill без реального trigger.
3. **RED:** создай минимальный test/reproduction одного поведения и запусти его. Он должен падать по ожидаемой assertion/reason; случайный syntax/setup error и просто non-zero exit не являются RED.
4. **GREEN:** внеси минимальное production изменение, необходимое для RED. Не добавляй speculative features/refactor.
5. Повтори targeted test до PASS, затем neighboring/applicable tests. После GREEN разрешён refactor без нового поведения; тесты остаются зелёными.
6. Если command output не совпадает с expected, не наслаивай fixes: используй `ebb-debug-issue` для root cause.
7. Проверь `git diff`, scope creep, `git diff --check`, generated artifacts/secrets и task-specific build/type/docs/domain gates.
8. Если execution mode требует independent task review, передай brief + exact diff + evidence в `ebb-review-task`. Findings обрабатывай через `ebb-handle-review-feedback`.
9. Security/Web changes требуют соответственно `ebb-security-review`/`ebb-web-e2e`; database change требует evidence, определённого `ebb-database-engineering`.
   README/.env.example либо затронутые setup/config/API/commands требуют changed-scope sync через `ebb-maintain-project-docs` до task gates/review; file move/delete/restructure остаётся у `ebb-repository-maintenance`. Не выполняй полный docs audit без запроса.
10. Верни files changed, exact commands/results, RED/GREEN evidence, specialist/docs/review verdicts, exact task HEAD и limitations. Не утверждай PASS без свежей проверки текущего HEAD. Реализация не интегрирует branch локально и не публикует release/tag/rollback; task approval, integrated source и candidate metadata фиксируются на своих стадиях.

Подробный test-first protocol: [references/tdd-protocol.md](references/tdd-protocol.md).
