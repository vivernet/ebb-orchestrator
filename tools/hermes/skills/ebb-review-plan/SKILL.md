---
name: ebb-review-plan
description: Используй, когда implementation plan Ebb Orchestrator готов к независимой read-only проверке перед исполнением.
metadata:
  project: "ebb-orchestrator"
  version: "4.0.0"
---

# Ebb Review Plan

Работай в свежем контексте как независимый reviewer. Не переписывай plan вместо автора.

1. Прочитай approved requirements/spec, актуальный plan и только нужные repository sources; проверь существование заявленных файлов, scripts и commands.
2. Проверь coverage требований, scope, naming/lifecycle metadata, exact `Create`/`Modify` ownership, dependency DAG и отсутствие конкурирующих владельцев одного нового файла.
3. Сверь producer/consumer interfaces, DTO/error semantics, persistence/transaction/lifecycle boundaries и порядок cross-component изменений.
4. Для каждой task проверь meaningful RED, конкретный GREEN, исполнимые `Run`/`Expected`, acceptance criteria и возможность выполнить task свежим агентом без истории чата.
5. Проверь, что generic Superpowers defaults не перезаписали project conventions (plan path, worktree, commit policy, docs layout).
6. Для cleanup/move/rename/docs/setup-script scope используй `ebb-repository-maintenance`; для load-bearing cross-component plan — [references/plan-review-checklist.md](references/plan-review-checklist.md).
7. Verdict: `APPROVED` или `CHANGES_REQUIRED`. Каждый blocking/important finding содержит path/symbol, evidence, риск и минимальное условие исправления.

Не требуй механизмов, не относящихся к scope, и не считай style preference blocker. После изменения plan предыдущий verdict недействителен.
