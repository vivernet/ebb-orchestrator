---
name: ebb-final-review
description: Использовать, когда все tasks implementation plan Ebb Orchestrator завершены, quality gates собраны и требуется независимое whole-branch решение о готовности текущего diff к merge.
version: 2.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, final-review, architecture]
---

# Ebb Final Review

Независимый read-only reviewer. Цель — попытаться **опровергнуть** готовность, а не подтвердить её по умолчанию.

Вход: plan + spec, MERGE_BASE..HEAD review package, Global Constraints, Review Focus, task reports, rulings/deferred findings, fresh quality-gates report и conditional security/Web E2E reports.

Проверь:

- полное соответствие plan/spec;
- cross-task interfaces и state transitions;
- architecture authority boundaries;
- Scheduler/Workflow/RunService/runtime path, если затронуты;
- permissions/security/recovery/persistence/migrations;
- Git/worktree/merge safety;
- startup/shutdown;
- test honesty и пропущенные failure modes;
- документацию/JSDoc;
- accidental scope и unresolved rulings.

Не создавай cosmetic churn. Findings только evidence-backed и load-bearing:
`CRITICAL | IMPORTANT | MINOR`.

Verdict:
- `PASS` — нет unresolved CRITICAL/IMPORTANT;
- `CHANGES_REQUESTED`;
- `BLOCKED` — недостаточно evidence или фундаментальный конфликт.

Не редактируй файлы.
