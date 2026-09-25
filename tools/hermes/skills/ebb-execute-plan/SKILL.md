---
name: ebb-execute-plan
description: Используй для исполнения утверждённого implementation plan Ebb Orchestrator с учётом зависимостей, ledger, проверок и финального аудита.
version: 3.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, execution, implementation-plan]
---

# Ebb Execute Plan

Вход: repo-relative path к `APPROVED` plan со статусом `planned` или `in_progress`.

## Invariants

- Работай в текущем worktree/branch; проверь branch, HEAD, dirty files и сохранность unrelated changes.
- Не более двух активных субагентов: запускай максимум одного task-controller одновременно; тот может запустить максимум одного leaf-agent. Leaf-agent не создаёт агентов. Для мелкой/сильно связанной задачи контроллер может выполнить работу сам.
- Не включай auto worktree isolation. Не делай push/merge/tag/release. Commit только если план явно требует, либо на основании отдельного согласованного правила.
- Следуй `.hermes.md`, применимым `AGENTS.md`, approved design и plan; при конфликте зафиксируй ruling/evidence до продолжения.

## Procedure

1. Проверь актуальность plan, его review verdict, prerequisites и status. Изменившийся контракт требует повторного review.
2. Создай persistent ledger `WAITING / READY / RUNNING / REVIEW / DONE / BLOCKED`; планируй только READY tasks и не запускай конкурирующих владельцев файлов.
3. Передавай каждому task-controller минимальный brief и нужные файлы. Большие отчёты храни как artifacts, в ledger держи статус и краткую ссылку.
4. Исполняй задачу через `ebb-implement-task`. Task принимается после свежего `ebb-review-task` и применимых specialist checks.
5. После всех задач обнови metadata/roadmap только по правилам governance, запусти применимые `ebb-quality-gates`, проверь полный diff и вызови `ebb-final-review`.
6. На подтверждённый blocker вернись к root cause, исправь ограниченную область, повтори нужные проверки и вызови свежего final reviewer.
7. Отчитайся о HEAD, задачах, командах/результатах, verdicts, ограничениях и состоянии worktree. Не называй частичную работу полной.

