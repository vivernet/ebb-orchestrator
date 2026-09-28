---
name: ebb-execute-plan
description: Используй, когда утверждённый implementation plan Ebb Orchestrator нужно выполнить с dependency-aware orchestration, subagents, task reviews и финальными gates.
metadata:
  project: "ebb-orchestrator"
  version: "4.0.0"
---

# Ebb Execute Plan

**Preferred companion:** Superpowers `subagent-driven-development` при наличии subagent runtime; иначе `executing-plans`. Используй его dispatch/recovery/review mechanics, но Ebb project policy ниже имеет приоритет.

## Invariants

- Работай в уже выбранном Ebb worktree/branch. Не создавай nested/automatic worktree поверх него без требования plan.
- Не push/merge/tag/release. Commit только когда это разрешено plan/repository governance.
- Coordinator владеет dependency graph и file ownership. Не допускай неконтролируемый nested fan-out.
- Параллельно запускай только `READY` tasks с доказанно непересекающимся mutable scope; иначе используй свежего агента последовательно.

## Procedure

1. Проверь plan path/status, `APPROVED` verdict, prerequisites, HEAD/status и актуальность contracts. При существенном drift верни plan на review.
2. Веди persistent ledger `WAITING / READY / RUNNING / REVIEW / DONE / BLOCKED`. Если активен Superpowers SDD, используй его plan-owned ledger вместо второго параллельного журнала.
3. Для task передай свежему implementer минимальный brief: task text, нужные interfaces/rulings, exact paths и artifact path для отчёта. Не передавай историю сессии.
4. Реализация следует `ebb-implement-task`. Reviewer из Superpowers task loop должен использовать `ebb-review-task` как Ebb rubric — не запускай дублирующий review только ради двух названий.
5. Findings исправляй scoped rounds с повтором затронутых тестов и re-review. Используй model escalation/fix-loop companion skill; не создавай второй независимый цикл.
6. Task становится `DONE` только после нужного review и task-level gates. Broader failure классифицируй по ownership; deferred dependency остаётся явно красной/blocked, а не скрывается.
7. После всех tasks запусти `ebb-quality-gates`, затем один независимый whole-change `ebb-final-review` (или передай его rubric final reviewer Superpowers).
8. Отчёт содержит HEAD, task ledger, commands/results, review verdicts, remaining limitations и worktree status. Partial work не называй полной.
