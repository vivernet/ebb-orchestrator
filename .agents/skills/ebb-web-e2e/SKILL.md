---
name: ebb-web-e2e
description: Используй, когда изменение Ebb Orchestrator затрагивает Web UI, HTTP, sessions, SSE или browser-visible behavior и нужен реальный process/browser E2E.
metadata:
  project: "ebb-orchestrator"
  version: "5.0.0"
---

# Ebb Web E2E

Проверяй пользовательский путь через реальный browser + HTTP/process composition. Component/mock tests не заменяют E2E, когда меняется backend contract.

1. Зафиксируй server composition, dynamic ports, isolated `EBB_ORCHESTRATOR_HOME`, readiness signal, expected process exit и deterministic cleanup.
2. Проверь real transport и применимые сценарии: auth/session lifecycle, authoritative reload после mutation, SSE reconnect/replay, restart с той же persistence и отсутствие orphan processes/generated artifacts.
3. Не передавай secrets через unsafe IPC/logging; соблюдай project security rules и worker-safe process control.
4. UI copy/localization/accessibility scope проверяй по [localization checklist](references/localization-accessibility-checklist.md).
5. Запиши exact commands, browser assertions, process exits и ограничения. Невозможность реально запустить required path = `BLOCKED`, а не PASS.
6. Длительные live-provider flows запускай только когда они входят в approved plan или явно разрешён side effect/cost.
7. E2E finding исправляется через `ebb-implement-task`; после fix повторяется конкретный browser scenario и relevant `ebb-quality-gates`.
