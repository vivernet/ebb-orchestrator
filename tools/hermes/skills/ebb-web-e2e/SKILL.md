---
name: ebb-web-e2e
description: E2E-тестирование UI Ebb Orchestrator, реальный браузер, HTTP API, сессии, SSE, сборка продакшена.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, web, e2e]
---

# Ebb Web E2E

Проверяй flow через browser и реальный HTTP transport, а не только component
tests. Перед запуском прочитай план и зафиксируй серверный composition, ports,
isolated `EBB_ORCHESTRATOR_HOME`, cleanup и expected exit code. Проверяй
authoritative reload после mutation, SSE reconnect и отсутствие generated
artifacts. Не запускай длительный live-provider flow без явного разрешения.
