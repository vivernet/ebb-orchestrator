---
name: ebb-execute-plan
description: Используй, когда нужно исполнить актуальный утверждённый implementation plan Ebb Orchestrator.
metadata:
  project: "ebb-orchestrator"
  version: "5.1.0"
---

# Ebb Execute Plan

Вход: repo-relative path к актуальному `APPROVED` plan. План исполняется **через task subagents**; controller координирует, ведёт ledger, проверяет evidence и интегрирует результаты, но не подменяет implementer.

## Setup

1. Получи `ebb-repository-context`; проверь plan authority, status, prerequisites, current worktree/branch и protected unrelated changes. Не создавай worktree автоматически.
2. Создай plan-owned scratch workspace через `git rev-parse --git-path "ebb-execution/<safe-plan-id>"`; ledger переживает compaction и не попадает в commit.
3. Прочитай plan/spec один раз, создай task state `WAITING / READY / RUNNING / REVIEW / DONE / BLOCKED` и pre-flight interface scan для зависимых tasks.
4. Любую неоднозначность, которую можно разрешить из spec/repo evidence, фиксируй как `Ruling:` в ledger и продолжай. Остановись только на destructive/security/publish side effect либо когда любой путь — догадка.

## Task loop

1. READY task получает минимальный self-contained brief, BASE и только applicable domain constraints. Делегируй через `ebb-dispatch-agents`; один mutable scope имеет одного implementer-owner.
2. Если task меняет database contract, brief включает `ebb-database-engineering`; security/Web scope — соответствующие specialist requirements. Реализация следует `ebb-implement-task`.
3. Технический failure subagent (crash/timeout/no usable return, без содержательного implementation verdict) автоматически retry тем же deterministic brief; повторный technical failure использует fresh agent/более надёжный model, если доступен. После 3 technical failures task `BLOCKED` с evidence — controller не становится implementer.
4. После usable implementation свежий `ebb-review-task` читает task brief + diff/evidence. `CHANGES_REQUIRED` → узкий fix subagent → scoped re-review. После 3 неудачных fix rounds пересмотри root cause; rounds 4–5 требуют fresh implementer/stronger reasoning. После 5 unresolved load-bearing findings task `BLOCKED`.
5. Parallel READY tasks разрешены только с доказанно непересекающимся mutable scope и в пределах project/runtime concurrency policy; иначе последовательность.
6. Не спрашивай «продолжать?» между tasks. Выполняй plan непрерывно до named stop condition или завершения.

## Finish

После всех tasks: `ebb-quality-gates` → один fresh-context `ebb-final-review` → при findings адресный subagent fix и свежая re-review. Отчёт включает HEAD, ledger states, commands/results, verdicts, rulings, ограничения и worktree state.

Детали: [execution state](references/execution-state-machine.md), [ledger](references/ledger-format.md), [subagent mode](references/subagent-mode.md).
