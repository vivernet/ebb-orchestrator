---
name: ebb-review-plan
description: Используй для независимой проверки implementation plan Ebb Orchestrator перед началом реализации, особенно для многочастных и межкомпонентных изменений.
version: 2.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, planning, review]
---

# Ebb Review Plan

Работай в свежем контексте и только как read-only reviewer. Проверь реальные требования и существующие файлы, затем попробуй доказать, что план нельзя выполнить безопасно или однозначно.

Проверь: coverage требований; naming/frontmatter/evidence; ownership и точные Create/Modify paths; интерфейсы и producer/consumer совместимость; порядок зависимостей; тесты RED→GREEN; исполнимые `Run` и конкретные `Expected`; gates; выполнимость каждой задачи агентом без истории чата; scope и открытые решения.

Для cross-component/load-bearing плана используй `references/plan-review-checklist.md`. Это условный reference, не глобальный список обязательных механизмов для каждой задачи.

Вердикт: `APPROVED` либо `CHANGES_REQUIRED`. Каждый blocker/important finding содержит путь/символ, конкретный пробел, риск и минимально необходимое исправление. Не исправляй план сам. Не требуй тестов или матриц, не относящихся к изменённым контрактам.

