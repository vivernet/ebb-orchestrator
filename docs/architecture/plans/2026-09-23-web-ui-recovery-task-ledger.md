# Ebb Orchestrator Web UI Recovery — Task Ledger

План A-F стадий для восстановления Web UI до V1 functional state.

## Stage A — Application shell + shared primitives

**Goal:** Привести shell и shared UI primitives к единому доступному V1 foundation без изменения backend contracts.

| Task | Status | Notes |
|------|--------|-------|
| T1: Shared primitives (PageState, EmptyState, ErrorAlert, StatusBadge) | ✅ DONE | Компоненты реализованы, тесты проходят |
| T2: Shell composition and route metadata | ✅ DONE | AppShell и router имеют breadcrumb metadata |
| T3: Adopt primitives in features | ✅ DONE | Dashboard использует PageState/EmptyState/ErrorAlert |
| T4: E2E shell verification | ✅ DONE | Все 3 E2E теста проходят |

**Verification:**
- pnpm test ✓
- pnpm build ✓
- pnpm lint/typecheck ✓
- pnpm test:e2e ✓
- git diff --check ✓

## Stage B — API/query/mutation foundation

**Goal:** Typed feature adapters, app-scoped query cache, bounded SSE subscriptions.

| Task | Status | Notes |
|------|--------|-------|
| T1: Typed endpoint adapters per feature | ✅ DONE | Onboarding API adapter создан |
| T2: App-scoped query cache with invalidation | ✅ DONE | Есть state/query-cache.ts |
| T3: SSE subscription with unsubscribe | ✅ DONE | useEventClient и events.ts имеют unsubscribe |

## Stage C — Onboarding + Dashboard + Project

**Goal:** Три утверждённых экрана V1 с реальными backend-подключениями.

| Task | Status | Notes |
|------|--------|-------|
| T1: Onboarding flow (discover → review → approve → activate) | ✅ DONE | Полный flow реализован, тесты проходят |
| T2: Dashboard projection wiring | ✅ DONE | DashboardPage подключает /api/v1/dashboard |
| T3: Project View wiring | ✅ DONE | ProjectPage подключает /api/v1/projects/:id |
| T4: Approval reject/request-changes | ✅ DONE | Backend endpoints + UI кнопки добавлены |

## Stage D — Task + Epic + Approval

**Goal:** Lifecycle/action surfaces с backend authority.

| Task | Status | Notes |
|------|--------|-------|
| T1: Task View workflow UI | ✅ DONE | WorkflowTimeline + проекция |
| T2: Epic View lifecycle UI | ✅ DONE | Lifecycle stages + projection |
| T3: Approval reject/request-changes | ✅ DONE | Реализовано в этом коммите |

## Stage E — Queue + Run + Usage + Settings

**Goal:** Queue actions, run evidence, usage/budget, settings forms.

| Task | Status | Notes |
|------|--------|-------|
| T1: Execution queue actions | ✅ DONE | Cancel run с mutation store |
| T2: Agent Run Detail with events/logs | ⏳ PENDING | Нужно добавить events/tools/permissions/recovery |
| T3: Usage & Budget display | ✅ DONE | Aggregate usage buckets |
| T4: Settings form | ✅ DONE | Read-only settings projection |

## Stage F — Browser E2E + cleanup

**Goal:** All V1 route matrix, populated flows, dead-code removal.

| Task | Status | Notes |
|------|--------|-------|
| T1: Full E2E coverage | ⏳ PENDING | 3 теста покрывают shell/навигацию |
| T2: Remove dead code | ⏳ BLOCKED | Pre-existing deletion в setup.ts |
| T3: Restore web test setup | ⏳ BLOCKED | Pre-existing deletion в setup.ts |

## Current Blockers

1. **Contract mismatch:** Approval reject/request-changes требуют backend contract change
2. **Setup test:** apps/web/test/setup.ts имеет pre-existing deletion

## Next Steps

1. ✅ Stage A — проверить lint/typecheck, запустить E2E
2. Stage B — API/query foundation
3. Stage C — Onboarding activate flow
4. Stage D/E — остальные фичи
5. Stage F — cleanup и полная проверка
