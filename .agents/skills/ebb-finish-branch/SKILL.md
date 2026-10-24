---
name: ebb-finish-branch
description: Используй, когда реализация task branch Ebb Orchestrator завершена и требуется PR handoff или проверка её интеграции в develop.
metadata:
  project: "ebb-orchestrator"
  version: "5.2.0"
---

# Ebb Finish Branch

Integration — отдельная стадия после verified implementation.

1. Для docs-worthy changes получи changed-scope sync evidence от `ebb-maintain-project-docs`, затем запусти `ebb-quality-gates` для полного task scope на exact task HEAD. Красный обязательный gate блокирует finish.
2. Определи repository/worktree, branch/detached HEAD, upstream, pinned `develop_base_sha`, reviewed diff range, exact approved task SHA и PR target `develop`; сверяй с plan/repo evidence.
3. Проверь `ebb-final-review` PASS и отсутствие unresolved BLOCKER/IMPORTANT.
4. Обычная task интегрируется только PR squash merge в `develop`. Выполняй разрешённый pipeline step либо предоставь конкретный PR handoff. Task local merge и PR target `master` запрещены. Drift task HEAD инвалидирует его review/gates; не обходи protections, не force-push и не rebase без отдельной authority.
5. Push/PR squash merge требуют authorization пользователя либо уже approved pipeline step. Завершение task/plan не разрешает tag, release, publication или rollback и не вызывает `ebb-release` автоматически.
6. После squash зафиксируй PR identity, approved task SHA и новый integrated `develop` SHA отдельно. Выполни mandatory post-integration local/CI gates на exact integrated source tree; task PASS не заменяет их. До PASS статус integrated-but-unverified/BLOCKED, а не проверенная интеграция. Release candidate создаёт отдельный вручную вызванный `ebb-release`.
7. Worktree cleanup выполняй через правила `ebb-worktree`: PR/active-review worktree обычно сохраняется; removal только при доказанном ownership и без unique uncommitted files.
8. Discard branch/worktree — destructive action с точным inventory и явным подтверждением. Force deletion без такого подтверждения запрещена.

Финальный report: branch/base/target, approved task SHA, PR/squash result и integrated `develop` SHA при наличии, отдельные task/post-integration verification evidence и preserved/removed workspace state. `master` — только release commits, отсутствующий при zero releases; legacy migration выполняется отдельно в Plan26, без baseline/dummy/restore/archive commit в `master`.
