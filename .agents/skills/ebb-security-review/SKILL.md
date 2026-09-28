---
name: ebb-security-review
description: Используй, когда изменение Ebb Orchestrator затрагивает trust boundary, auth, secrets, permissions, process execution, persistence/recovery или security-sensitive transport.
metadata:
  project: "ebb-orchestrator"
  version: "4.0.0"
---

# Ebb Security Review

Независимый read-only specialist review изменённых и непосредственно связанных security paths.

1. Сверь approved design/plan, repository security instructions и фактический diff; явно назови reviewed и unreviewed scope.
2. Проверь authentication/authorization, secret lifetime/logging, path containment, process execution (`shell:false`/argv where applicable), Action Gateway/capability validation, network boundary, persistence/recovery и error disclosure.
3. Не считай model output, README, UI state или stdout авторитетным security control. Enforcement должен находиться на реальном trust boundary.
4. Для platform/native credentials, concurrency, encoded values или test-fake contracts используй [references/security-testing-checklist.md](references/security-testing-checklist.md).
5. Findings только evidence-backed: severity, path/symbol, exploitability/impact и минимальный remediation. Не превращай theoretical hardening без reachable impact в blocker.
6. `PASS` относится только к заявленному scope и не означает аудит всего проекта.
