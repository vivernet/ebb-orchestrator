---
name: ebb-implement-task
description: Используй для реализации одной назначенной задачи Ebb Orchestrator или одного подтверждённого ограниченного finding cluster с test-first evidence и контролем scope.
metadata:
  project: "ebb-orchestrator"
  version: "5.0.0"
---

# Ebb Implement Task

Исполняй ровно одну task. Core rule для behavior change/bugfix: **сначала доказуемый failing test/reproduction, потом production change.**

1. Прими task brief: scope, exact files/interfaces, acceptance, commands и protected unrelated changes. Зафиксируй BASE/status и baseline.
2. **RED:** создай минимальный test/reproduction одного поведения и запусти его. Он должен падать по ожидаемой assertion/reason; случайный syntax/setup error и просто non-zero exit не являются RED.
3. **GREEN:** внеси минимальное production изменение, необходимое для RED. Не добавляй speculative features/refactor.
4. Повтори targeted test до PASS, затем neighboring/applicable tests. После GREEN разрешён refactor без нового поведения; тесты остаются зелёными.
5. Если command output не совпадает с expected, не наслаивай fixes: используй `ebb-debug-issue` для root cause.
6. Проверь `git diff`, scope creep, `git diff --check`, generated artifacts/secrets и task-specific build/type/docs gates.
7. Если execution mode требует independent task review, передай brief + exact diff + evidence в `ebb-review-task`. Findings обрабатывай через `ebb-handle-review-feedback`.
8. Security/Web changes требуют соответственно `ebb-security-review`/`ebb-web-e2e`.
9. Верни files changed, exact commands/results, RED/GREEN evidence, review verdict и limitations. Не утверждай PASS без свежей проверки текущего HEAD.

Подробный test-first protocol: [references/tdd-protocol.md](references/tdd-protocol.md).
