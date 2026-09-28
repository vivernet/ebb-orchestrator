---
name: ebb-execute-plan
description: Используй для исполнения утверждённого implementation plan Ebb Orchestrator с persistent ledger, dependency gates, subagent или inline режимом, review loops и финальной проверкой.
metadata:
  project: "ebb-orchestrator"
  version: "5.0.0"
---

# Ebb Execute Plan

Вход: repo-relative path к актуальному `APPROVED` plan. Execution полностью определяется Ebb skills.

## Setup

1. Получи `ebb-repository-context`; проверь plan authority, status, prerequisites, current worktree/branch и protected unrelated changes. Не создавай worktree автоматически.
2. Создай plan-owned scratch workspace через `git rev-parse --git-path "ebb-execution/<plan-id>"`; ledger переживает compaction и не попадает в commit.
3. Прочитай plan/spec один раз, создай task state `WAITING / READY / RUNNING / REVIEW / DONE / BLOCKED` и pre-flight interface scan для зависимых tasks.
4. Любую неоднозначность, которую можно разрешить из spec/repo evidence, фиксируй как `Ruling:` в ledger и продолжай. Остановись только на destructive/security/publish side effect либо когда любой путь — догадка.

## Choose mode

- **SUBAGENT:** независимые tasks + доступен delegation runtime. Fresh implementer per task; fresh reviewer per task; scoped fix/re-review; final whole-change reviewer.
- **INLINE:** controller реализует tasks сам. TDD/evidence и ledger остаются обязательными; task-level fresh review применяется только если plan требует его или reviewer доступен без превращения inline mode в полный subagent loop; final independent review предпочтителен всегда.

## Task loop

1. READY task получает минимальный brief и BASE. Если task делегируется — используй `ebb-dispatch-agents`.
2. Реализация следует `ebb-implement-task`; implementer не получает историю controller.
3. SUBAGENT mode: `ebb-review-task` читает task brief + diff/evidence. `CHANGES_REQUIRED` → узкий fix → scoped re-review. После 3 неудачных rounds пересмотри root cause; rounds 4–5 требуют свежего implementer/более сильного reasoning. После 5 unresolved load-bearing findings task `BLOCKED`.
4. INLINE mode: после task completion contract запиши evidence в ledger; если отдельного reviewer нет, явно пометь self-review как reduced assurance.
5. Parallel READY tasks разрешены только с доказанно непересекающимся mutable scope; иначе последовательность.
6. Не спрашивай «продолжать?» между tasks. Выполняй plan непрерывно до named stop condition или завершения.

## Finish

После всех tasks: `ebb-quality-gates` → один `ebb-final-review` → при findings адресный fix и свежая re-review. Отчёт включает HEAD, ledger states, commands/results, verdicts, rulings, ограничения и worktree state.

Детали: [execution state](references/execution-state-machine.md), [ledger](references/ledger-format.md), [subagent mode](references/subagent-mode.md), [inline mode](references/inline-mode.md).
