---
name: ebb-security-review
description: Используй, когда изменение Ebb Orchestrator затрагивает trust boundary, auth, secrets, permissions, process execution, security-sensitive persistence/recovery или security-sensitive transport.
metadata:
  project: "ebb-orchestrator"
  version: "5.1.0"
---

# Ebb Security Review

Независимый read-only specialist review изменённых и непосредственно связанных security paths.

1. Сверь approved design/plan, repository security instructions и actual diff; явно назови reviewed/unreviewed scope.
2. Проверь authentication/authorization, secret lifetime/logging, path containment, process execution (`shell:false`/argv where applicable), capability validation, network boundary, security-sensitive persistence/recovery и error disclosure.
3. Не считай model output, README, UI state или stdout авторитетным security control. Enforcement должен находиться на реальном trust boundary.
4. Для platform/native credentials, concurrency, encoded values или test-fake contracts используй [security testing checklist](references/security-testing-checklist.md).
5. Findings только evidence-backed: severity, path/symbol, exploitability/impact и минимальный remediation. Theoretical hardening без reachable impact не является blocker.
6. Fix выполняется через `ebb-implement-task`; после fix нужен scoped security re-review и свежие gates.
7. `PASS` относится только к заявленному scope и не означает аудит всего проекта.
