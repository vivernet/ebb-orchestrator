---
name: ebb-worktree
description: Используй, когда нужно проверить или создать изолированный Git worktree для Ebb Orchestrator либо безопасно определить, что текущий workspace уже является worktree.
metadata:
  project: "ebb-orchestrator"
  version: "5.0.0"
---

# Ebb Worktree

Изоляция не должна создавать второй случайный workspace или ломать host-managed environment.

1. Сначала определи repository root, `git rev-parse --git-dir`, `--git-common-dir`, текущую branch и superproject status. `git-dir != git-common-dir` означает linked worktree только если это не submodule.
2. Если уже находишься в нужном worktree, **не создавай вложенный worktree**. Проверь branch/status и продолжай.
3. Новый worktree создавай только если это требует approved workflow/plan или пользователь. Предпочитай host-native workspace mechanism; `git worktree add` — fallback.
4. Для project-local `.worktrees/`/`worktrees/` до создания докажи `git check-ignore`; не допускай случайного tracking дерева worktree.
5. После создания выполни project setup по фактическому manifest и baseline verification. Красный baseline фиксируется отдельно; не приписывай его новой реализации.
6. Не auto-create worktree из `ebb-execute-plan`: execution работает в предоставленном workspace и вызывает этот skill только при явной необходимости.
7. Cleanup выполняется только для workspace, ownership которого доказан. Modified/untracked-only files запрещают force removal без явного destructive approval.

См. [references/worktree-safety.md](references/worktree-safety.md).
