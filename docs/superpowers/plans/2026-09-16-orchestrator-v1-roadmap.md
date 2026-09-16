# Local AI Development Orchestrator v1 Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать утверждённый local-first Orchestrator v1 как последовательность независимо проверяемых vertical slices без преждевременного подключения лишних интеграций.

**Architecture:** pnpm-monorepo с локальным Fastify backend, React Web UI и общими typed contracts. Backend остаётся модульным монолитом; domain writes идут через application services и transactional outbox, AI подключается только после того, как deterministic core проходит сценарии на FakeAgentRuntime.

**Tech Stack:** Node.js 24 LTS; TypeScript 7; pnpm 11.27; Fastify 5.12; React 19.3; Vite 8.1; Vitest 5; Zod 4; ESLint 10.10 + typescript-eslint 8.70; SQLite через `node:sqlite`; native `git` CLI через `spawn(..., { shell: false })`.

**Spec:** `docs/superpowers/specs/2026-09-16-local-ai-development-orchestrator-design.md`

## Global Constraints

- Основная ветка проекта пользователя всегда настраивается; примеры и acceptance fixtures используют `master`, не `main`.
- v1 — один локальный backend process, Web UI на loopback, без distributed workers и без multi-user/RBAC.
- Hermes — единственный реальный `AgentRuntime` v1; `FakeAgentRuntime` обязателен для deterministic test suite.
- Local Execution — единственный execution backend v1; Container Mode остаётся только портом будущего расширения.
- Final merge в target/default branch всегда требует явного user approval в v1.
- GitHub опционален; local workflow должен полностью работать без GitHub.
- AI не меняет domain state напрямую; каждый output проходит schema + semantic validation.
- AI не получает GitHub credentials, SecretStore, право менять RoleContract/PermissionPolicy или делать final merge.
- `node:sqlite` скрывается за внутренним `Database` adapter, чтобы его можно было заменить без изменения domain modules.
- Все durable handlers должны быть idempotent; event delivery — at-least-once.
- Все критические core tests выполняются без LLM и без network.

---

## План декомпозиции

Спецификация охватывает несколько самостоятельных подсистем, поэтому реализация разбита на шесть последовательных планов. Каждый следующий план предполагает, что предыдущий слит в `master` и все его acceptance tests проходят.

| # | Plan | Рабочий результат |
|---|---|---|
| 1 | `2026-09-16-orchestrator-foundation-persistence.md` | Backend стартует, имеет SQLite migrations, Outbox/Jobs, health/SSE, crash-safe startup skeleton |
| 2 | `2026-09-16-orchestrator-domain-workflow-scheduler.md` | Project/Epic/Task/Approval/Workflow/Scheduler/Recovery работают end-to-end на FakeAgentRuntime |
| 3 | `2026-09-16-orchestrator-git-execution-security.md` | Реальные Git/worktree, Action Gateway, Permission Engine, Local Execution и security boundaries |
| 4 | `2026-09-16-orchestrator-hermes-autonomous-task.md` | Hermes Developer → Reviewer → QA → Integration выполняют standalone Task до manual merge approval |
| 5 | `2026-09-16-orchestrator-planning-epics-context-knowledge.md` | Coordinator/PM/Architect, Epic lifecycle, Context Engine, Guidelines/Decisions, budgets/usage |
| 6 | `2026-09-16-orchestrator-web-github-release.md` | Утверждённый Web UI, optional GitHub, diagnostics, migrations/backup, v1 acceptance suite |

## Dependency Graph

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

Не параллелить планы 1–4 между собой: каждый вводит контракты, от которых зависит следующий. Внутри Plan 5 и Plan 6 отдельные UI/integration задачи можно параллелить только после стабилизации shared contracts.

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
- Общие HTTP/agent schemas находятся в `packages/contracts`; persistence-specific rows туда не попадают.
- `platform/*` содержит adapters/infrastructure, но не принимает бизнес-решения.
- SQL migrations — append-only files в `apps/server/src/platform/database/migrations/`.
- Test fixtures и FakeAgentRuntime — в `packages/testing`, если они используются несколькими модулями.

## Milestone gates

### Gate A — Deterministic backend

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

### Gate B — Local autonomous task

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

### Gate C — Epic

Coordinator создаёт Epic и несколько Task с зависимостями; required Task интегрируются в Epic branch, затем Epic Review/QA/Integration и manual merge в `master`.

### Gate D — v1 release

Оба acceptance scenarios из design spec стабильно проходят после принудительного kill/restart backend. Local workflow не требует GitHub.

## Spec coverage matrix

| Design section | Implementation plan |
|---|---|
| 1–2 Architecture / deterministic-first | Plans 1–2 |
| 3 Agent Runtime / roles | Plans 4–5 |
| 4 Onboarding/config | Plans 1, 3, 6 |
| 5–7 Work/Lifecycle/Workflow | Plan 2 |
| 8 Scheduler | Plan 2 |
| 9 Structured contracts | Plan 4 |
| 10 Context | Plans 4–5 |
| 11 Guidelines/Decisions | Plan 5 |
| 12 Permission/Action Gateway | Plan 3 |
| 13 Security | Plans 3, 6 |
| 14 Git/worktrees/integration | Plan 3 |
| 15 GitHub | Plan 6 |
| 16 Recovery | Plan 2 + Plan 3 reconciliation |
| 17 Usage/Budget | Plan 5 |
| 18 Backend/API/read models | Plans 1–2, 6 |
| 19 Events/Jobs/Workers | Plan 1 |
| 20 Persistence/Config/Migrations | Plans 1, 6 |
| 21 Testing/Reliability/v1 scope | all plans, final gate in Plan 6 |
| Appendix A UI | Plan 6 |
| Appendix B invariants | Plans 2–3 test suites |

## Commit discipline

- Один implementation task → один логически завершённый commit, если task не требует нескольких reviewable commits.
- Не смешивать refactor и новую функциональность без необходимости.
- Каждый commit должен оставлять `pnpm test` и `pnpm typecheck` зелёными для уже реализованного scope.
- Migration + repository code + tests для неё коммитятся вместе.

## Stop conditions

Остановить выполнение текущего плана и вернуться к design/spec review, если обнаружено хотя бы одно из следующего:

- требуется второй backend process или distributed coordination;
- Hermes нельзя безопасно ограничить утверждённой tool/capability моделью;
- `node:sqlite` не поддерживает требуемую crash/transaction semantics и замена adapter меняет domain contracts;
- Git integration требует history-rewriting workflow как обязательный baseline;
- появляется необходимость изменить утверждённые Task/Epic states или approval policy, а не просто дополнить код.
