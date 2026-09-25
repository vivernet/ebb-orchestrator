---
name: ebb-debug-issue
description: Используй при сообщении об ошибке или баге Ebb Orchestrator, чтобы воспроизвести симптом, найти root cause и организовать проверенное исправление.
version: 3.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, debugging, root-cause]
---

# Ebb Debug Issue

Докажи симптом и причину до выбора fix. Не маскируй ошибку fallback-ом и не начинай реализацию только по совпадению с предыдущим инцидентом.

## Workflow

1. Создай краткий Context Brief через `ebb-repository-context`; собери точные expected/actual, команду, exit/status, окружение и затронутый scope.
2. Для сложного или cross-boundary бага делегируй независимые reproduction и investigation, если стоимость dispatch оправдана. Для простого воспроизводимого бага выполняй сам. Максимум два активных агента.
3. Зафиксируй data flow и evidence root cause; сравни working/broken state или изменения, если это помогает. Проверяй одну гипотезу за раз минимальным пробником.
4. Для load-bearing проблемы запрашивай свежий независимый Diagnosis Review. Решения по продукту, security policy или публичным контрактам эскалируй пользователю.
5. Ограниченный fix передай `ebb-implement-task`. Для multi-task/cross-component исправления создай план через `ebb-write-plan`, затем `ebb-review-plan` и `ebb-execute-plan`.
6. После fix проведи отдельный whole-bug review, повтори исходное воспроизведение свежим verification и запусти связанные regression/gates. Security и Web пути требуют соответствующего specialist review.
7. Вердикт: `DONE`, `BLOCKED`, `PARTIALLY_VERIFIED` или `NOT_REPRODUCED`. Укажи evidence и непроверенные области. Не заявляй исправление без свежего повторения исходного симптома.

См. `references/architectural-debugging-checklist.md` для cross-boundary/load-bearing случаев. Останови patch churn после трёх неудачных направлений и проверь архитектурное предположение.

