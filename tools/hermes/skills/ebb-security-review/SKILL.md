---
name: ebb-security-review
description: Use when reviewing Ebb changes that cross trust boundaries, secrets, permissions, process execution, Git, MCP, or recovery.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, security, architecture]
---

# Ebb Security Review

Проверяй изменённые trust boundaries против `.hermes.md`, `AGENTS.md` и
approved design. Отдельно проверяй secrets, path containment, `shell:false`,
Action Gateway, capability validation, recovery и отсутствие скрытого network
access. Не считай model output, README или stdout источником истины. Возвращай
только evidence-backed findings с severity и file/line evidence; production-код
не изменяй без отдельного задания.
