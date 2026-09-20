# Дорожная карта реализации Local AI Development Orchestrator v1

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ SUB-SKILL: используйте superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans для реализации этого плана по задачам. Для отслеживания шаги используют синтаксис флажков (`- [ ]`).

**Цель:** Реализовать утверждённый local-first Orchestrator v1 как последовательность независимо проверяемых вертикальных срезов без преждевременного подключения лишних интеграций.

**Архитектура:** pnpm-monorepo с локальным Fastify backend, React Web UI и общими типизированными контрактами. Backend остаётся модульным монолитом; записи домена идут через application services и transactional outbox, AI подключается только после того, как детерминированное ядро проходит сценарии на FakeAgentRuntime.

**Технологический стек:** Node.js 24 LTS; TypeScript 7; pnpm 11.27; Fastify 5.12; React 19.3; Vite 8.1; Vitest 5; Zod 4; ESLint 10.10 + typescript-eslint 8.70; SQLite через `node:sqlite`; native `git` CLI через `spawn(..., { shell: false })`.

**Спецификация:** `docs/architecture/specs/2026-09-16-ebb-orchestrator-design.md`

## Глобальные ограничения

- Основная ветка проекта пользователя всегда настраивается; примеры и приёмочные fixtures используют `master`, не `main`.
- v1 — один локальный процесса backend, Web UI на loopback, без распределённых workers и без multi-user/RBAC.
- Hermes — единственный реальный `AgentRuntime` v1; `FakeAgentRuntime` обязателен для детерминированного набора тестов.
- Local Execution — единственный backend выполнения v1; Container Mode остаётся только точкой будущего расширения.
- Финальное слияние в target/default branch всегда требует явного одобрения пользователя в v1.
- GitHub опционален; локальный workflow должен полностью работать без GitHub.
- AI не меняет состояние домена напрямую; каждый вывод проходит проверку схемы + проверку семантики.
- AI не получает GitHub учётные данные, SecretStore, право менять RoleContract/PermissionPolicy или делать final слияния.
- `node:sqlite` скрывается за внутренним `Database` adapter, чтобы его можно было заменить без изменения модули домена.
- Все durable handlers должны быть idempotent; event delivery — at-least-once.
- Все критические основные тесты выполняются без LLM и без сети.

---

## План декомпозиции

Спецификация охватывает несколько самостоятельных подсистем, поэтому реализация разбита на шесть последовательных планов. Каждый следующий план предполагает, что предыдущий слит в `master` и все его приёмочные тесты проходят.

| # | Plan | Рабочий результат |
|---|---|---|
| 1 | `2026-09-16-ebb-orchestrator-основы-persistence.md` | Backend стартует и имеет миграции SQLite, Outbox/Jobs, health/SSE и защищённый от сбоев каркас запуска |
| 2 | `2026-09-16-ebb-orchestrator-domain-workflow-scheduler.md` | Project/Epic/Task/Approval/Workflow/Scheduler/Recovery работают сквозным образом на FakeAgentRuntime |
| 3 | `2026-09-16-ebb-orchestrator-git-execution-security.md` | Реальные Git/worktree, Action Gateway, Permission Engine, Local Execution и границы безопасности |
| 4 | `2026-09-16-ebb-orchestrator-hermes-autonomous-task.md` | Hermes Developer → Reviewer → QA → Integration выполняют standalone Task до ручного одобрение слияния |
| 5 | `2026-09-16-ebb-orchestrator-planning-epics-context-knowledge.md` | Coordinator/PM/Architect, жизненный цикл Epic, Context Engine, Guidelines/Decisions, бюджеты/использование |
| 6 | `2026-09-16-ebb-orchestrator-web-github-release.md` | Утверждённый Web UI, необязательный GitHub, диагностику, миграции/резервное копирование и приёмочный набор v1 |

## Граф зависимостей

```text
Plan 1 Foundation/Persistence
          ↓
Plan 2 Domain/Workflow/Scheduler/Recovery
          ↓
Plan 3 Git/Execution/Security
          ↓
Plan 4 Hermes Autonomous Task
          ↓
Plan 5 Planning/Epics/Context/Knowledge
          ↓
Plan 6 Web/GitHub/Release Hardening
```

Не параллелить планы 1–4 между собой: каждый вводит контракты, от которых зависит следующий. Внутри планов 5 и 6 отдельные UI/integration задачи можно параллелить только после стабилизации общих контрактов.

## Целевая структура репозитория

```text
.
├── apps/
│   ├── server/
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── create-app.ts
│   │   │   │   └── routes/
│   │   │   ├── modules/
│   │   │   │   ├── projects/
│   │   │   │   ├── work/
│   │   │   │   ├── workflow/
│   │   │   │   ├── approvals/
│   │   │   │   ├── scheduler/
│   │   │   │   ├── runtime/
│   │   │   │   ├── recovery/
│   │   │   │   ├── git/
│   │   │   │   ├── execution/
│   │   │   │   ├── permissions/
│   │   │   │   ├── planning/
│   │   │   │   ├── context/
│   │   │   │   ├── knowledge/
│   │   │   │   ├── usage/
│   │   │   │   └── github/
│   │   │   ├── platform/
│   │   │   │   ├── database/
│   │   │   │   ├── events/
│   │   │   │   ├── jobs/
│   │   │   │   ├── artifacts/
│   │   │   │   ├── logging/
│   │   │   │   ├── process/
│   │   │   │   └── security/
│   │   │   └── main.ts
│   │   └── test/
│   └── web/
│       ├── src/
│       │   ├── app/
│       │   ├── api/
│       │   ├── features/
│       │   └── components/
│       └── test/
├── packages/
│   ├── contracts/
│   │   └── src/
│   └── testing/
│       └── src/
├── docs/
│   └── superpowers/
│       ├── specs/
│       └── plans/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── eslint.config.js
```

### Правила структуры

- Domain-модуль экспортирует только `index.ts` public API; соседние модули не импортируют `internal/*`.
- Общие HTTP/agent schemas находятся в `packages/контракты`; persistence-specific rows туда не попадают.
- `platform/*` содержит adapters/infrastructure, но не принимает бизнес-решения.
- SQL migrations — append-only files в `apps/server/src/platform/database/migrations/`.
- Test fixtures и FakeAgentRuntime — в `packages/testing`, если они используются несколькими модулями.

## Контрольные точки

### Контрольная точка A — детерминированный backend

До подключения Hermes должны проходить:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

И сценарий FakeAgentRuntime:

```text
Task READY
→ DEVELOPMENT
→ REVIEW
→ QA
→ READY_FOR_INTEGRATION
→ READY_FOR_MERGE
```

### Контрольная точка B — локальная автономная задача

До Coordinator/Epic пользователь вручную создаёт Task и получает:

```text
managed task branch/worktree
→ Hermes Developer
→ independent Reviewer
→ QA
→ Integration
→ user merge approval
→ master
```

### Контрольная точка C — Epic

Coordinator создаёт Epic и несколько Task с зависимостями; обязательные Task интегрируются в Epic branch, затем Epic Review/QA/Integration и ручное слияние в `master`.

### Контрольная точка D — выпуск v1

Оба приёмочных сценария из design spec стабильно проходят после принудительного завершения/перезапуска backend. Local workflow не требует GitHub.

## Матрица покрытия спецификации

| Раздел design | План реализации |
|---|---|
| 1–2 Архитектура / детерминированный подход | планы 1–2 |
| 3 Agent Runtime / роли | планы 4–5 |
| 4 Онбординг/конфигурация | планы 1, 3, 6 |
| 5–7 Работа/жизненный цикл/workflow | плана 2 |
| 8 Scheduler | плана 2 |
| 9 Structured контракты | плана 4 |
| 10 Context | планы 4–5 |
| 11 Guidelines/Decisions | плана 5 |
| 12 Разрешения/Action Gateway | плана 3 |
| 13 Security | планы 3, 6 |
| 14 Git/worktrees/интеграция | плана 3 |
| 15 GitHub | плана 6 |
| 16 Recovery | плана 2 + плана 3 согласование |
| 17 Использование/бюджет | плана 5 |
| 18 Backend/API/модели чтения | планы 1–2, 6 |
| 19 События/Jobs/Workers | плана 1 |
| 20 Хранение/конфигурация/миграции | Plans 1, 6 |
| 21 Testing/Reliability/v1 объёма | все планы, финальная контрольная точка в плане 6 |
| Приложение A: UI | плана 6 |
| Приложение B: инварианты | планы 2–3 наборы тестов |

## Правила коммитов

- Одна задача реализации → один логически завершённый commit, если task не требует нескольких пригодных для проверки коммитов.
- Не смешивать refactor и новую функциональность без необходимости.
- Каждый commit должен оставлять `pnpm test` и `pnpm typecheck` зелёными для уже реализованного объёма.
- Migration + repository code + tests для неё коммитятся вместе.

## Условия остановки

Остановить выполнение текущего плана и вернуться к проверке design/spec, если обнаружено хотя бы одно из следующего:

- требуется второй процесса backend или распределённая координация;
- Hermes нельзя безопасно ограничить утверждённой tool/capability моделью;
- `node:sqlite` не поддерживает требуемую семантику сбоев/транзакций и замена adapter меняет domain контракты;
- Git integration требует workflow с переписыванием истории как обязательный базовую возможность;
- появляется необходимость изменить утверждённые Task/Epic состояния или политику одобрение, а не просто дополнить код.
