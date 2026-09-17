# Ebb Orchestrator Server — Agent Instructions

Этот файл дополняет корневой `AGENTS.md` для `apps/server/**`.

Корневые правила имеют приоритет при любом конфликте.

## 1. Backend authority

Backend является authoritative boundary для:

- domain state;
- permissions;
- workflow;
- approvals;
- budgets;
- scheduling;
- Git operations;
- recovery;
- persistence.

Не переносить authoritative security/domain decisions во frontend или Agent Runtime.

## 2. Module ownership

Соблюдать modular-monolith boundaries.

Модули владеют своими domain rules и persistence access.

Не читать/изменять таблицы другого модуля напрямую только ради удобства, если существует module API/event/port.

Использовать:

- Commands — выполнить действие;
- Queries — получить состояние;
- Events — сообщить о свершившемся факте.

## 3. Persistence

SQLite хранит orchestration state/history.

При изменениях persistence:

- создавать versioned migration;
- не править старую migration после того, как она стала частью истории;
- сохранять foreign-key/integrity invariants;
- учитывать transaction boundary;
- учитывать restart/reconciliation;
- писать regression/migration tests.

State change + outbox event должны быть атомарны там, где этого требует design.

## 4. Workflow

State transitions выполняются только через deterministic workflow/domain logic.

Не менять статус прямым SQL/update в обход guards.

Transition должен явно учитывать необходимые:

- approvals;
- dependencies;
- review/QA results;
- merge state;
- blocking conditions.

## 5. Scheduler и recovery

Scheduler не должен зависеть от LLM для deterministic eligibility/priority/locks.

Recovery должен различать как минимум:

- agent/task failure;
- timeout;
- tool/infrastructure failure;
- blocker;
- no-progress/loop.

Не эскалировать на более сильную модель проблему, причина которой инфраструктурная и не требует reasoning.

## 6. Execution / Permission boundary

Agent-facing mutation выполняется через Action Gateway.

Не добавлять прямые agent tools, которые обходят:

- Permission Engine;
- RunCapability/workspace scope;
- path containment;
- command classification;
- audit.

Unknown/unregistered action должен fail closed.

## 7. Git

Для managed Git:

- repository/worktree берётся из capability/domain state, не из произвольного model input;
- normal process invocation использует `shell:false`;
- hooks отключены по умолчанию;
- reconciliation локальный и не выполняет implicit fetch/push;
- merge approval проверяется по exact subject/type/status;
- успешная операция подтверждается фактическим Git state.

## 8. Hermes / Runtime

Core domain зависит от `AgentRuntime` abstraction, а не от Hermes internals.

Hermes-specific behavior держать в adapter layer.

Scoped session/profile/context/capabilities нельзя смешивать между независимыми runs.

Structured result проходит Output Validator до применения.

## 9. Background workers

Workers должны быть restart-safe и idempotent.

Startup lifecycle:

`STARTING → RECOVERING → READY`

Scheduler не должен dispatch новую работу до завершения обязательного reconciliation.

## 10. Server quality

При изменении server-кода выполнить минимум:

```bash
pnpm --filter @ebb-orchestrator/server typecheck
pnpm --filter @ebb-orchestrator/server test
pnpm lint
```

Дополнительно выполнить relevant scenario/security/recovery tests.

Нельзя удалить failing server test только ради зелёного gate.
