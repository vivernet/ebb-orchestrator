---
name: ebb-write-plan
description: Используй для исследования требований и создания нового implementation plan Ebb Orchestrator с конкретными задачами, владельцами файлов, интерфейсами и проверками.
version: 3.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, planning, implementation-plan]
---

# Ebb Write Plan

Создай исполнимый план на основе текущего репозитория и утверждённых требований. Не начинай реализацию.

## Workflow

1. Используй `ebb-repository-context` для краткого Context Brief; зафиксируй требования, ограничения, branch/HEAD/status.
2. Для объёмного независимого исследования назначь до двух scouts (например, architecture/code и tests/tooling). Для простого плана исследуй сам. Каждый scout возвращает краткие выводы с путями/символами и evidence-файлом для подробностей.
3. Зафиксируй открытые продуктовые/API/security решения. Не изобретай значения, меняющие публичный контракт или модель угроз: запроси решение пользователя либо пометь план `BLOCKED`/proposal согласно policy.
4. Разбей работу на dependency-ordered tasks. Каждая должна выполняться свежим агентом без истории чата и содержать цель, точные `Create`/`Modify` файлы, владельца, интерфейсы, зависимости, RED→GREEN, `Run` и конкретный `Expected`, а также `Review Focus`.
5. Проверь покрытие требований, единственность владельца новых файлов, межмодульные контракты, циклы зависимостей, реальные evidence paths и полноту gates. Формат — `references/plan-format.md`.
6. Создай plan с canonical filename/metadata по governance policy; утверждённый и готовый к исполнению план получает `status: planned`. Generated registers вручную не правь: запусти `pnpm docs:roadmap`, затем `pnpm docs:check` и `git diff --check`, если эти команды существуют.
7. Передай план независимому `ebb-review-plan`. При `CHANGES_REQUIRED` внеси только адресные изменения и запроси свежий review.
8. После `APPROVED` создай обязательный локальный commit только для файлов плана и его generated outputs: `feat: add plan <plan-id> <short-title>`. Не включай unrelated/частичные изменения; если безопасно отделить scope нельзя, остановись и сообщи блокировку. Push/merge запрещены.

Не создавай субагентов для форматирования, простого поиска или короткого плана. Максимум два активных агента; не пересылай большие логи в controller context.

