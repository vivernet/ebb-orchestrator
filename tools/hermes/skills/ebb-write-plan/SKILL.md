---
name: ebb-write-plan
description: Использовать, когда для Ebb Orchestrator есть утверждённые требования, spec/design или подтверждённый root cause и требуется новый многошаговый implementation plan до изменения кода.
version: 2.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, planning, implementation-plan, subagents]
---

# Ebb Write Plan

Plan-controller не реализует код. Исследование выполняют read-only scouts; draft пишет свежий Plan Author; независимую проверку выполняет `ebb-review-plan`.

## Workflow

1. Используй `ebb-repository-context` и зафиксируй authoritative requirements.
2. Через 1–2 scouts собери только недостающие repo facts: exact files/symbols/interfaces, tests/tooling/CI, working patterns.
3. До задач составь file/interface map и dependency graph.
4. Определи имя:
   - один plan в Stage → `XX-name.md`, `id: plan-XX`;
   - Stage с несколькими частями → основной `XX-name.md` + части `XX-YY-name.md`, `id: plan-XX-YY`.
   - governance → `00-YY-name.md`, `id: plan-00-YY`.
5. Новый утверждённый plan получает `status: planned`.
6. Plan Author создаёт draft по `references/plan-format.md`.
7. Обязательно вызови `ebb-review-plan`; findings исправляет отдельный Plan Fixer, затем свежий re-review. Максимум 3 rounds.
8. После `APPROVED` сохрани plan, запусти `pnpm docs:roadmap`, затем docs validation, `git diff --check`.
9. Создай **локальный commit** `feat: add plan <id> <short-title>`. Не push/merge.
10. Верни path, id, tasks, dependencies, reviewer verdict и commit SHA.

README-файлы не создаются/переименовываются этим naming rule.

Если требования требуют нового фундаментального product/security/architecture решения, не выдумывай его: `REQUIREMENTS_BLOCKED`.
