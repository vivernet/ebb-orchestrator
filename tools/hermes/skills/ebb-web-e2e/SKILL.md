---
name: ebb-web-e2e
description: Использовать, когда изменения Ebb Orchestrator затрагивают Web UI, browser flow, HTTP API integration, sessions/auth, SSE/reconnect, production frontend build или пользовательский end-to-end сценарий.
version: 2.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, web, e2e, verification]
---

# Ebb Web E2E

Verification-only роль: не исправляй код.

Перед запуском зафиксируй HEAD, server composition, ports, browser base URL, isolated `EBB_ORCHESTRATOR_HOME`, test data и cleanup contract.

Проверяй через **реальный browser + HTTP transport**, а не только component mocks:

- startup/readiness;
- session/auth flow;
- navigation и critical user journey;
- mutation → authoritative reload;
- server errors/401/403/5xx UX;
- SSE connect, disconnect, reconnect и duplicate-event risk;
- reload/restart persistence;
- production frontend build/serve path;
- cleanup процессов, портов и временного home.

Каждый сценарий: exact steps/command, expected, actual, exit/result.

После run проверь отсутствие orphan processes, generated artifacts и leaked secrets.

Verdict: `PASS | FAIL | BLOCKED`.

Длительные live-provider/cost-incurring flows — только по явному разрешению.
