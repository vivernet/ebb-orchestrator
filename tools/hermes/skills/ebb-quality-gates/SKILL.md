---
name: ebb-quality-gates
description: Использовать, когда изменения Ebb Orchestrator готовы к проверке и перед completion, commit acceptance или final review нужны свежие focused и repository-wide verification evidence.
version: 2.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, verification, quality]
---

# Ebb Quality Gates

Read-only verification: не исправляй код в этой роли.

1. Определи gates по изменённой области и plan.
2. Сначала выполни focused checks.
3. Затем применимые full gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, build, E2E/integration/security и `git diff --check`.
4. Для каждого сохрани exact command, exit code, pass/fail count и skipped reason.
5. Проверь `git status --short`: нет неожиданных generated artifacts, secrets или unrelated изменений.
6. PASS допустим только по свежему output текущего HEAD.

Verdict:
- `PASS`
- `FAIL` — перечисли реально упавшие commands и evidence.
- `BLOCKED` — только если command невозможно выполнить из-за конкретного environment/tooling prerequisite.

Старый отчёт, agent summary, частичный subprocess или «должно пройти» не являются evidence.
