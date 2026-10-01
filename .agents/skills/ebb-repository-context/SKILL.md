---
name: ebb-repository-context
description: Используй при начале новой работы над Ebb Orchestrator, когда нужно определить актуальные инструкции, границы scope, состояние Git и минимальный контекст для планирования или делегирования.
metadata:
  project: "ebb-orchestrator"
  version: "5.1.0"
---

# Ebb Repository Context

Создай компактный Context Brief для контроллера. Это bootstrap, а не требование каждому агенту перечитывать весь репозиторий.

1. Зафиксируй repository root, branch, HEAD, worktree status и `git status --short`; pre-existing unrelated changes считаются защищёнными.
2. Найди применимые repository instructions (`AGENTS.md` и scoped equivalents), approved design/spec, plan и относящиеся README/architecture docs. Определи authority order.
3. Прочитай только источники, нужные для текущего scope. Если актуальный brief уже содержит проверенный факт, не перечитывай большой документ без причины.
4. Для database-affecting scope дополнительно зафиксируй только необходимые факты для handoff в `ebb-database-engineering`: DB engine, migration framework, ORM/query layer, relevant schema/migration paths и known migration state. Не делай полный DB audit для задачи, которая не меняет persistence contract.
5. Сформируй brief: goal, in-scope/out-of-scope, invariants, authoritative sources, relevant paths/symbols, dependencies, required gates, known blockers и unresolved decisions.
6. Для делегирования передавай только этот brief + нужные файлы/выдержки. Дополнительный контекст запрашивается по конкретному пробелу.
7. Если requirements, approved plan и код расходятся, зафиксируй evidence и не меняй scope молча.
8. Если разведка распадается на независимые домены, используй `ebb-dispatch-agents`; простую разведку выполняй inline.
