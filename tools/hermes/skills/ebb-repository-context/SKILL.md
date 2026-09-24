---
name: ebb-repository-context
description: Использовать, когда начинается работа в Ebb Orchestrator или требуется определить актуальный scope, authority hierarchy, Git/worktree-контекст и релевантные инструкции.
version: 2.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, context, bootstrap]
---

# Ebb Repository Context

Короткий bootstrap, а не обязательная загрузка всей документации.

1. Прочитай `.hermes.md`.
2. Прочитай root `AGENTS.md`; scoped `AGENTS.md` — только для реально затрагиваемой области.
3. Зафиксируй branch, HEAD и `git status --short`.
4. Определи source of truth только для текущей задачи: approved spec/design, implementation plan, roadmap или bug evidence.
5. Сформируй компактный `Context Brief`: scope, запрещённый scope, обязательные invariants, релевантные пути и gates.
6. Передавай leaf-субагентам `Context Brief`, а не весь README/spec/plan.

При конфликте: текущее явное требование пользователя → approved spec/design → `.hermes.md`/AGENTS → plan → код как evidence текущей реализации → исторические audit/roadmap records.

Не расширяй scope скрыто. Не заставляй каждого субагента повторно читать весь repository context.
