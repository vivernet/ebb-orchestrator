---
name: ebb-review-plan
description: Используй, когда implementation plan Ebb Orchestrator готов к независимой read-only проверке перед исполнением.
metadata:
  project: "ebb-orchestrator"
  version: "5.2.0"
---

# Ebb Review Plan

Работай в свежем контексте как независимый reviewer. Не переписывай plan вместо автора.

1. Прочитай authoritative requirements/design, актуальный plan и только необходимые repository sources; проверь существование заявленных файлов/scripts/commands.
2. Проверь coverage требований, scope, naming/lifecycle metadata, exact file ownership, dependency DAG и отсутствие конкурирующих owners нового файла.
3. Сверь producer/consumer interfaces, DTO/error semantics, persistence/transaction/lifecycle boundaries и порядок cross-component изменений. Если plan меняет database contract, проверь наличие и корректное применение constraints/evidence из `ebb-database-engineering`, а не воспроизводи его полный checklist локально.
4. Для каждой task проверь meaningful RED, конкретный GREEN, выполнимые `Run`/`Expected`, acceptance и возможность выполнить task свежим агентом без истории чата.
5. Проверь соответствие фактическим project conventions: plan path, worktree/branch policy, commits, docs layout, generated artifacts.
6. Для cleanup/move/rename/structure/tooling scope используй `ebb-repository-maintenance`; для README/.env.example content и docs-worthy setup/config/API changes проверь affected-owner sync prerequisites `ebb-maintain-project-docs`; для load-bearing cross-component plan — [references/plan-review-checklist.md](references/plan-review-checklist.md).
7. Verdict: `APPROVED` либо `CHANGES_REQUIRED`. Blocking/important finding содержит path/symbol, evidence, риск и минимальное условие исправления.

Проверь pinned `develop` source, PR squash target `develop`, отдельные approved-task/integrated-source identities и post-integration gates. Local task merge, auto release/tag/rollback и baseline/dummy commit в release-only `master` — policy defects. Legacy transition отделён в Plan26; published hotfix требует explicit source exception и forward-port. Controller не реализует task; default max 2 применяется ко всем активным implementer/fix/reviewer/scout вместе; более узкий plan/runtime limit имеет приоритет, превышение двух требует explicit user policy amendment.

После изменения plan предыдущий verdict недействителен. Style preference без impact не является blocker.
