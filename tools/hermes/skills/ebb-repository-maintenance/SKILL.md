---
name: ebb-repository-maintenance
description: Используй, когда Ebb Orchestrator требует repository cleanup, move/rename каталогов, documentation refresh или изменения setup/dev scripts и их команд.
metadata:
  project: "ebb-orchestrator"
  version: "1.0.0"
---

# Ebb Repository Maintenance

Этот skill владеет безопасным изменением структуры репозитория и tooling/doc contracts. Для multi-step maintenance сначала создай/review plan через `ebb-write-plan`.

1. Зафиксируй branch/HEAD/status и immutable список pre-existing changes. Не классифицируй файл как мусор по имени.
2. Собери actual inventory. Для move/delete/cleanup используй атомарный disposition: `path`, Git state (`tracked/untracked/ignored/mixed`), action, destination, reason, verification.
3. Перед rename/move ищи references по всему relevant tree (`AGENTS.md`, skills, docs, manifests, scripts, tests). Старый path считается удалённым только после нулевого intended-reference scan.
4. Проверяй команды по source, а не README: найди dispatcher/package script, cwd, prerequisites, side effects, exact exit/output. Setup/sync команда не является read-only.
5. Для Node/cross-platform tooling используй [references/cross-platform-script-checklist.md](references/cross-platform-script-checklist.md); для docs/localization — [references/documentation-checklist.md](references/documentation-checklist.md).
6. Destructive action над local/runtime/user data требует явного approval текущего точного списка. Если inventory изменился после approval, пересобери disposition.
7. После каждой стадии проверь exact postconditions, ссылки, status/diff, generated artifacts и applicable tests/docs gates. Не продолжай после mismatch.
8. Финальный отчёт перечисляет moved/deleted/preserved paths, commands/results, unresolved references и rollback/recovery notes.

Расширенный checklist: [references/repository-maintenance-checklist.md](references/repository-maintenance-checklist.md).
