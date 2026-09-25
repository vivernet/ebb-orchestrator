---
name: ebb-web-e2e
description: Используй при изменении Web UI, HTTP transport, сессий или SSE Ebb Orchestrator, когда нужен реальный browser/process end-to-end сценарий.
version: 2.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, web, e2e]
---

# Ebb Web E2E

Проверяй затронутый пользовательский путь через browser и реальный HTTP transport; component/mock tests этого не заменяют, если меняется backend contract.

До запуска зафиксируй composition сервера, dynamic ports, изолированный `EBB_ORCHESTRATOR_HOME`, readiness, expected exit code и cleanup. Для соответствующих сценариев проверь authoritative reload после mutation, session/auth behavior, SSE reconnect/replay, restart с тем же persistence и отсутствие orphan processes/generated artifacts.

Используй worker-safe IPC и безопасную передачу secrets согласно проектным правилам. Не запускай длительные live-provider flows без явного разрешения. Запиши команды, результаты и ограничения; при невозможности запуска верни `BLOCKED`, а не PASS.

