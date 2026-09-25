---
name: ebb-security-review
description: Используй при изменении trust boundaries Ebb Orchestrator, включая авторизацию, секреты, разрешения, процессы, Git/MCP, persistence и recovery.
version: 2.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, security, review]
---

# Ebb Security Review

Независимый read-only review только изменённых и непосредственно связанных security paths. Сверяй `.hermes.md`, применимые `AGENTS.md` и approved design.

Проверь threat boundary, authentication/authorization, secret lifetime/logging, path containment, process execution (`shell:false` где требуется), Action Gateway/capability validation, network access, recovery и error disclosure. Не считай model output, README или stdout авторитетным security control.

Возвращай только evidence-backed findings с severity, path/symbol, exploitability/impact и минимальным remediation. Не изменяй production code. Укажи scope и проверки, которые не удалось выполнить; `PASS` не означает аудит всего проекта.

