---
name: ebb-execute-plan
description: Использовать, когда существует утверждённый implementation plan Ebb Orchestrator со статусом planned/in_progress и его нужно выполнить в текущем worktree.
version: 4.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, execution, implementation-plan, subagents]
---

# Ebb Execute Plan

Plan-controller координирует; production/test/docs implementation выполняется через `ebb-implement-task`.

1. Используй `ebb-repository-context`; прочитай plan + authoritative spec.
2. Проверь frontmatter/naming, dependency graph, Files/Interfaces и stale paths. Существенно stale/broken plan → `ebb-write-plan`, не импровизация.
3. Если status `planned`, после валидного старта переведи в `in_progress`, обнови `updated`, запусти `pnpm docs:roadmap`.
4. Веди persistent ledger. Каждая task: `WAITING/READY/RUNNING/DONE/BLOCKED`.
5. Для READY task создай минимальный brief и запусти **один** task-controller `ebb-implement-task`. Пока он активен, plan-controller не запускает других субагентов.
6. Не повторяй task review/gates, уже выполненные task-controller, без новой причины.
7. После всех load-bearing tasks вызови fresh `ebb-quality-gates`.
8. По изменённому scope дополнительно вызови `ebb-security-review` и/или `ebb-web-e2e`, если они ещё не дали plan-level evidence.
9. Создай MERGE_BASE..HEAD review package и вызови `ebb-final-review`.
10. `CHANGES_REQUESTED` → одна grouped final fix wave через `ebb-implement-task`, затем fresh gates + scoped final review.
11. Только при final gates PASS + final review PASS + acceptance evidence переведи plan в `completed`, обнови roadmap и создай требуемый локальный completion commit.
12. Верни branch, BASE/HEAD, tasks, gates, reviews, rulings и working-tree status.

Не merge/push/tag/release. Не считать child exit code доказательством completion.
