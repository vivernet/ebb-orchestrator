---
name: ebb-repository-maintenance
description: Используй, когда Ebb Orchestrator требует cleanup, move/rename, documentation restructuring, setup/dev-script changes или проверку repository command contracts.
metadata:
  project: "ebb-orchestrator"
  version: "5.2.0"
---

# Ebb Repository Maintenance

Repository maintenance — управляемое изменение структуры и tooling contracts, а не «уборка по имени файла».

1. Зафиксируй branch/HEAD/status и immutable список pre-existing changes.
2. Построй actual inventory. Для move/delete/cleanup используй atomic disposition: `path`, Git state, action, destination, reason, verification.
3. Перед rename/move выполни repository-wide reference scan по instructions/docs/skills/manifests/scripts/tests. Старый path считается удалённым только после классификации remaining references.
4. Проверяй commands по source: dispatcher/package script, cwd, prerequisites, side effects, exact exit/output. README сам по себе не доказывает behavior.
5. Cross-platform Node/setup tooling проверяй по [cross-platform checklist](references/cross-platform-script-checklist.md); documentation structure/localization mechanics — по [documentation checklist](references/documentation-checklist.md). Root/nested first-party README и `.env.example` content, в том числе после setup/config/API/command changes, передавай `ebb-maintain-project-docs` по affected-owner closure; maintenance не заменяет его content audit.
6. Cleanup/rewrite migration files, DB bootstrap artifacts или migration history сначала проходит `ebb-database-engineering`; repository-maintenance владеет file/disposition mechanics, но не решает самостоятельно, безопасно ли менять database history.
7. Destructive action над local/runtime/user data требует точного актуального списка и approval. Изменившийся inventory инвалидирует прежнее approval.
8. Для multi-step/risky maintenance создай `ebb-write-plan`; независимые inventories можно делегировать через `ebb-dispatch-agents`.
9. После каждой стадии проверь exact postconditions, references, status/diff, generated artifacts и applicable tests. Mismatch останавливает следующий destructive step.
10. Финальный отчёт: moved/deleted/preserved paths, commands/results, unresolved references и recovery notes.

Ordinary maintenance task идёт от pinned `develop` через PR squash в `develop` и отдельные post-integration gates, как `ebb-finish-branch`. Branch migration/release не скрывай под cleanup: legacy master removal — отдельный reviewed Plan26 после подтверждённого develop preservation/default change; master содержит только release commits или absent при zero releases. Не оставляй dummy/baseline/restore/archive commit. Publication/rollback/tag требуют explicit `ebb-release`; docs content sync не разрешает внешние side effects.

Расширенный checklist: [references/repository-maintenance-checklist.md](references/repository-maintenance-checklist.md).
