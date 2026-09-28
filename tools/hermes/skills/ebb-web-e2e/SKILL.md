---
name: ebb-web-e2e
description: Используй, когда изменение Ebb Orchestrator затрагивает Web UI, HTTP, sessions, SSE или browser-visible behavior и нужен реальный process/browser E2E.
metadata:
  project: "ebb-orchestrator"
  version: "4.0.0"
---

# Ebb Web E2E

Проверяй затронутый пользовательский путь через реальный browser + HTTP/process composition. Component/mock tests не заменяют E2E, когда меняется backend contract.

1. До запуска зафиксируй server composition, dynamic ports, isolated `EBB_ORCHESTRATOR_HOME`, readiness signal, expected process exit и deterministic cleanup.
2. Проверь real transport и применимые сценарии: auth/session lifecycle, authoritative reload после mutation, SSE reconnect/replay, restart с той же persistence и отсутствие orphan processes/generated artifacts.
3. Не передавай secrets через unsafe IPC/logging; соблюдай project security rules и worker-safe process control.
4. Если scope затрагивает перевод, visible copy или accessible names, используй [references/localization-accessibility-checklist.md](references/localization-accessibility-checklist.md).
5. Запиши exact commands, browser assertions, process exits и ограничения. Невозможность реально запустить required path = `BLOCKED`, а не PASS.
6. Длительные live-provider flows запускай только когда они входят в approved plan или пользователь явно разрешил внешний side effect/cost.
