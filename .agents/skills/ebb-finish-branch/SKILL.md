---
name: ebb-finish-branch
description: Используй, когда реализация Ebb Orchestrator завершена и проверена, чтобы безопасно передать branch в PR/merge workflow, сохранить worktree и не выполнить интеграцию без разрешения.
metadata:
  project: "ebb-orchestrator"
  version: "5.0.0"
---

# Ebb Finish Branch

Integration — отдельная стадия после verified implementation.

1. Запусти `ebb-quality-gates` для полного integration scope на текущем HEAD. Красный обязательный gate блокирует finish.
2. Определи current repository/worktree state, branch/detached HEAD, upstream и фактическую base branch из plan/repo history; не предполагай имя base.
3. Проверь `ebb-final-review` PASS и отсутствие unresolved BLOCKER/IMPORTANT.
4. Если approved project pipeline уже задаёт следующий шаг (например PR handoff), следуй ему. Иначе предложи пользователю безопасные варианты: сохранить branch; push/create PR; local merge — только те, которые реально поддерживаются текущим окружением.
5. Push, merge, tag, release, force-push и publish никогда не выполняются по предположению. Нужна явная authorization либо уже утверждённый pipeline step.
6. После local merge повтори required integration tests на merged tree до cleanup.
7. Worktree cleanup выполняй через правила `ebb-worktree`: PR/active-review worktree обычно сохраняется; removal только при доказанном ownership и без unique uncommitted files.
8. Discard branch/worktree — destructive action с точным inventory и явным подтверждением. Force deletion без такого подтверждения запрещена.

Финальный report: branch/HEAD/base, chosen integration action, PR/merge result при наличии, verification evidence и preserved/removed workspace state.
