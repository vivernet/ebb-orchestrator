---
name: ebb-implement-task
description: Используй для реализации одной назначенной задачи Ebb Orchestrator или одного подтверждённого ограниченного finding cluster с регрессионными тестами.
version: 3.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, implementation, tdd]
---

# Ebb Implement Task

Исполняй ровно одну задачу. Controller координирует; он может реализовать простой изолированный патч сам. Для объёмной или независимой реализации делегируй implementer, если это экономит контекст.

## Контекст и делегирование

Прими brief с разрешёнными файлами, контрактами, критериями и командами. Не перечитывай весь README/design, если актуальные выдержки есть в brief. Максимум два активных субагента в системе: task-controller запускает максимум одного leaf-agent; leaf не делегирует. Reviewer всегда независимый и read-only.

## Цикл

1. Подтверди базовый branch/HEAD/status и scope; запусти релевантный baseline.
2. Для нового поведения/регрессии сначала добавь тест или воспроизводимый сценарий и получи RED по ожидаемой assertion. Ненулевой exit сам по себе не доказывает RED.
3. Сделай минимальный fix, затем GREEN; проверь соседние тесты, применимые typecheck/build и `git diff --check`.
4. Выполни scoped review через `ebb-review-task`; передай diff и evidence отдельному свежему reviewer.
5. Исправляй подтверждённые finding ограниченными раундами; для каждого фикса повтори затронутый тест и scoped re-review. После пяти безуспешных fix rounds остановись и эскалируй архитектурную причину.
6. Для security scope вызови `ebb-security-review`; для browser/HTTP/SSE behavior — `ebb-web-e2e`. Используй только применимые проверки.
7. Верни список изменённых файлов, команды/результаты, review verdict и ограничения. Не заявляй PASS без свежего evidence.

Применяй dependency gates: не начинай зависимую задачу, пока prerequisite не принят. Ошибки broader suite классифицируй по ownership; не ослабляй тесты и не называй всю работу завершённой при красной зависимости.

