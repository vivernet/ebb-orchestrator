---
name: ebb-final-review
description: Используй после реализации всего change/plan Ebb Orchestrator для независимого read-only whole-change review перед готовностью ветки.
metadata:
  project: "ebb-orchestrator"
  version: "5.0.0"
---

# Ebb Final Review

В свежем контексте попытайся **опровергнуть** готовность полного изменения.

1. Получи approved requirements/design/plan, merge/base range или полный current diff, final gate evidence и ledger rulings. Не наследуй implementer history.
2. Проверь requirement/spec coverage, architecture/authority boundaries, state transitions, error semantics, persistence/migrations/recovery, startup/shutdown, Git/worktree safety, integration, tests и docs.
3. Security/Web scope требует наличия соответствующего `ebb-security-review`/`ebb-web-e2e` evidence; final reviewer проверяет его достаточность, а не симулирует specialist audit.
4. Review Focus из plan проверяется намеренно, особенно input/failure classes, которые не были полностью покрыты task tests.
5. Finding только evidence-backed: `BLOCKER / IMPORTANT / MINOR / FALSE_POSITIVE`, path/symbol, impact, evidence и минимальное условие исправления.
6. Verdict `PASS` или `CHANGES_REQUESTED`. При findings controller использует `ebb-handle-review-feedback`, запускает targeted gates и запрашивает свежий final review затронутого whole-change state.
7. Не выдавай косметический churn за качество. Whole-change PASS не разрешает автоматически push/merge; следующая стадия — `ebb-finish-branch`.
