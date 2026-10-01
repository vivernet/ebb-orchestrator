---
name: ebb-database-engineering
description: Используй, когда задача Ebb Orchestrator меняет или исследует database schema, migrations, persisted-data representation, ORM mappings, queries/indexes, transactions, constraints, database-engine semantics или lifecycle базы данных.
metadata:
  project: "ebb-orchestrator"
  version: "1.0.0"
---

# Ebb Database Engineering

Канонический domain skill для database/persistence engineering. Он владеет **database-specific policy и invariants**, но не заменяет design, implementation, debugging, review или quality workflow.

## Boundary

Применяй skill, когда корректность зависит от schema/migration/data/transaction/database-engine contract. Обычный repository/query call без изменения persistence contract сам по себе не является trigger.

## Workflow

1. Получи `ebb-repository-context` и зафиксируй фактические DB engine, migration framework, ORM/query layer, schema/migration paths и lifecycle state — только то, что относится к scope.
2. До изменения classify impact по [database change gates](references/database-change-gates.md): schema, existing data, fresh install, upgrade, transactions/concurrency, engine-specific behavior, destructive/recovery risks.
3. Если затронута migration history, применяй [migration lifecycle policy](references/migration-lifecycle-policy.md). Не переписывай published production history ради чистоты.
4. Определи **desired final state + transition**, а не только migration file. Для data migration зафиксируй source states, target representation, invalid/ambiguous input, retry/idempotency и integrity checks.
5. Архитектурное решение остаётся у `ebb-design-change`; implementation выполняется через `ebb-implement-task`; root-cause investigation — через `ebb-debug-issue`. Этот skill передаёт им database invariants и required evidence.
6. После изменения выполни применимые fresh/upgrade/schema/data checks из [database verification](references/database-verification.md). Existing dev DB PASS не доказывает fresh install; fresh DB PASS не доказывает upgrade safety.
7. Database-affecting task/review/gates получают компактный handoff: engine/framework, affected objects, final state, compatibility/data risks, required verification и unresolved blockers.

## Invariants

- Migration architecture — canonical schema-evolution path, если approved architecture явно не устанавливает иное; не создавай молча второй независимый source of truth через ORM auto-create/sync.
- Engine-specific behavior допустимо, если оно осознанно, изолировано/документировано и проверено. Не строй speculative abstraction только ради гипотетической portability.
- Destructive/data-loss operation требует явной классификации preservation/recovery до выполнения.
- Failure/partial migration state сначала исследуется; неизвестно частично применённую migration нельзя слепо rerun.
- Database work не `DONE` без свежего evidence для затронутых invariants.

Не дублируй эти правила в generic `ebb-*` skills: они должны маршрутизировать сюда и владеть только своим workflow.
