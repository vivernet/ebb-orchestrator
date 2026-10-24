---
name: ebb-final-review
description: Используй после реализации всего change/plan Ebb Orchestrator для независимого read-only whole-change review перед готовностью ветки.
metadata:
  project: "ebb-orchestrator"
  version: "5.2.0"
---

# Ebb Final Review

В свежем контексте попытайся **опровергнуть** готовность полного изменения.

1. Получи approved requirements/design/plan, pinned develop base и полный reviewed diff, exact task SHA/tree, final gate evidence и ledger rulings. Для integrated-source review отдельно получи actual squash SHA/tree и post-integration local/CI gates; для explicit release — identities/evidence от `ebb-release`. Не наследуй implementer history и не переноси task verdict на иную identity.
2. Проверь requirement/spec coverage, architecture/authority boundaries, state transitions, error semantics, persistence/migrations/recovery, startup/shutdown, Git/worktree safety, integration, tests и docs.
3. Database/security/Web scope требует наличия соответствующего `ebb-database-engineering` evidence / `ebb-security-review` / `ebb-web-e2e`; final reviewer проверяет достаточность specialist evidence, а не симулирует его полный audit.
   Для docs-worthy setup/config/API/command changes требуется affected-owner `ebb-maintain-project-docs` evidence; это changed-scope sync, не утверждение полного project audit. Maintenance владеет file operations, docs skill — root/nested README/.env.example content.
4. Review Focus из plan проверяется намеренно, особенно input/failure classes, которые не были полностью покрыты task tests.
5. Finding только evidence-backed: `BLOCKER / IMPORTANT / MINOR / FALSE_POSITIVE`, path/symbol, impact, evidence и минимальное условие исправления.
6. Verdict `PASS` или `CHANGES_REQUESTED`. При findings controller использует `ebb-handle-review-feedback`, запускает targeted gates и запрашивает свежий final review затронутого whole-change state.
7. Не выдавай косметический churn за качество. Whole-change PASS не разрешает автоматически push/merge/publication/rollback/tag; следующая стадия ordinary task — `ebb-finish-branch` с PR squash target `develop`. `master` только release commits, absent при zero releases; legacy transition — отдельный Plan26. Release вызывается только явно пользователем.
