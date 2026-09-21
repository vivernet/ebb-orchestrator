---
name: ebb-repository-context
description: Use when starting Ebb work that depends on architecture, v1 scope, Git policy, runtime boundaries, or existing implementation plans.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, context, planning]
---

# Ebb Repository Context

Сначала прочитай `.hermes.md`, root `AGENTS.md`, релевантные вложенные
`AGENTS.md`, approved design, текущий plan и `README.md`. Затем проверь branch,
HEAD и status. Отделяй текущий v1 scope от post-v1 roadmap и сохраняй unrelated
changes. Если код противоречит плану, зафиксируй evidence и останови скрытое
расширение scope.
