---
title: Plan Document
status: active
created: 2026-09-23
---
# Следующие этапы разработки Ebb Orchestrator

> Этот roadmap продолжает работу после текущего V1 hardening.
>
> Первые два исполняемых плана:
>
> 1. `2026-09-18-hermes-development-workflow-migration.md`
> 2. `2026-09-18-web-ui-audit-and-recovery-design.md`

---

# Этап 9 — Миграция development workflow с OpenCode на Hermes

**Цель:** полностью прекратить использование OpenCode как внешнего executor при разработке Ebb Orchestrator.

**Результаты:**
- `.hermes.md`;
- repository-owned Hermes skills;
- воспроизводимые `setup/check/execute` commands;
- concurrency = 2;
- delegation depth = 1;
- child worktree isolation disabled;
- реальный parity-run через Hermes;
- удаление active `.opencode` только после parity PASS.

**Exit gate:** настоящий implementation plan успешно выполняется через Hermes с review, tests и commit.

---

# Этап 10 — Аудит и recovery design Web UI

**Цель:** установить, что существующий frontend реально умеет, и определить точную границу между `KEEP`, `FIX` и `REWRITE`.

**Результаты:**
- карта frontend-кода;
- route/API contract matrix;
- browser gap analysis;
- approved recovery design;
- dependency-ordered implementation stages.

**Exit gate:** пользователь утверждает `2026-09-18-web-ui-audit-and-recovery-design.md`.

---

# Этап 11 — Web UI Foundation

Точный implementation plan создаётся **только после утверждения Stage 10**.

Ожидаемый scope:

- application shell;
- navigation;
- routing;
- shared UI primitives;
- API client;
- query/cache layer;
- mutation foundation;
- global loading/error/empty conventions;
- forms/validation;
- notifications;
- базовая responsive/accessibility модель.

Plan обязан использовать реальные пути из:

```text
docs/audit/web-ui-code-map.md
```

и утверждённую архитектуру из recovery spec.

---

# Этап 12 — Core Functional Web UI

Создать после успешного Stage 11.

Ожидаемый scope:

- Project Onboarding;
- Dashboard;
- Project View;
- Approval Inbox;
- базовая Task/Epic navigation;
- все primary actions должны реально работать через backend.

Недопустимы декоративные controls без реальной функции.

---

# Этап 13 — Operational Web UI + Browser E2E

Ожидаемый scope:

- Epic View;
- Task View;
- Execution Queue / Agents Monitor;
- Agent Run Detail;
- Usage & Budget;
- Settings;
- browser end-to-end flows.

Для deterministic browser E2E использовать `FakeAgentRuntime`, где это соответствует архитектуре.

Live Hermes остаётся отдельным ограниченным adapter smoke gate.

**Exit gate:**
- критические workflows реально доступны из браузера;
- нет dead primary actions;
- E2E покрывает главные переходы состояния;
- production build проходит.

---

# Этап 14 — V1 Productization и Release

Создать только после того, как Web UI реально функционален.

Ожидаемый scope:

- production server build/artifact;
- production web build;
- локальная установка;
- единая команда запуска;
- logs/diagnostics locations;
- migration/upgrade runbook;
- release checklist;
- clean-environment smoke test;
- финальный architecture/security/recovery review;
- финальное подтверждение merge пользователем;
- `v1.0.0` только после явного approval.

---

# Глобальные правила всех последующих планов

- Основная ветка — `master`.
- Работать в отдельной branch/worktree.
- Одновременно максимум 2 субагента.
- Nested subagents запрещены.
- Child worktree isolation отключён, пока отдельно не перепроектирован.
- Все новые/изменяемые production comments — на русском.
- Публичные/контрактные API используют качественный русский JSDoc.
- Behavior changes идут через TDD/regression tests.
- Для значимых задач обязателен independent review.
- Перед commit обязательны полные gates.
- Merge/push/tag/release запрещены без явного подтверждения пользователя.
- Нельзя добавлять post-v1 scope только потому, что в архитектуре существует extension point.
