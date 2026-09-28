---
name: ebb-final-review
description: Используй, когда все задачи плана Ebb Orchestrator выполнены и нужен независимый whole-change review перед объявлением работы завершённой.
metadata:
  project: "ebb-orchestrator"
  version: "4.0.0"
---

# Ebb Final Review

В свежем контексте попытайся опровергнуть готовность полного изменения. Если Superpowers SDD уже запускает final reviewer, передай ему этот rubric вместо второго дублирующего review.

1. Прочитай approved spec/plan, task verdicts, полный current diff и свежие `ebb-quality-gates` outputs.
2. Проверь requirement coverage и cross-task integration: authority boundaries, state/lifecycle transitions, persistence/migrations/recovery, scheduler/runtime paths, startup/shutdown, Git/worktree safety и документацию.
3. Проверь, что task-level PASS не скрыл deferred dependency, stale evidence или незапущенный plan-required gate.
4. Для security scope потребуй `ebb-security-review` evidence; для Web/HTTP/session/SSE — `ebb-web-e2e`. Отсутствие обязательного specialist evidence — finding, а не предположение о PASS.
5. Для docs/localization изменений проверь фактический changed-file inventory, корректность commands/paths и отсутствие orphan references.
6. Finding содержит severity, path/symbol, evidence, impact и минимальное условие исправления. Не создавай cosmetic churn.
7. Verdict: `PASS` или `CHANGES_REQUESTED`. После исправления load-bearing finding нужен свежий scoped verification/re-review, а затем актуальный final verdict.

Review read-only. Не называй проект production-ready шире, чем доказанный scope текущего plan.
