# Ebb Orchestrator — карта кода Web UI

> Bounded Stage 10 audit, 2026-09-21. Это read-only статическая карта текущего checkout. Playwright smoke harness запускается успешно; browser evidence ниже означает только bounded smoke coverage, а не полную acceptance matrix.

## Baseline

- Repository: `C:\Users\alex1\Repos\NEW\DEV\ebb-orchestrator-develop`.
- Current branch/status: checkout-specific `safe.directory` override потребовался из-за Windows ownership. Рабочее дерево уже содержит unrelated modified files и untracked `apps/web/test/e2e/run-e2e.mjs`, `artifacts/security/pnpm-audit-prod-2026-09-21-current.json`; audit их не меняет.
- Canonical inputs: `docs/architecture/plans/2026-09-18-web-ui-audit-and-recovery-design.md`, `docs/architecture/specs/2026-09-16-ebb-orchestrator-design.md`, root `AGENTS.md`, `.hermes.md`.
- Approved V1 screen set is Appendix A of the design and contains 10 screens. Stage 10 here is an audit/design boundary, not frontend implementation.

## Frontend Stack

- React `^19.3.0`, React DOM, TypeScript/TSX, Vite `^8.1.0`.
- Router: `react-router` `^7.18.3`, `createBrowserRouter` in `apps/web/src/app/router.tsx:1,25-76`.
- API transport: small hand-written `fetch` client in `apps/web/src/api/client.ts`; base path `/api/v1`.
- Realtime: SSE client in `apps/web/src/api/events.ts`, mounted by `useEventClient` in `apps/web/src/hooks/useEventClient.ts`.
- No query/cache library and no shared mutation abstraction. Each page owns `useEffect`/`useState` loading, error, and refetch logic.
- Tests: Vitest + Testing Library (`apps/web/test/*.test.tsx`, `routing-bootstrap.test.ts`); Playwright launcher/spec exists under `apps/web/test/e2e/` and now runs the compiled production server plus Vite frontend in an isolated temporary home. Three smoke tests exist; one also visits all 10 route identities and checks bounded empty/not-found/error-safe states.
- Scripts from `apps/web/package.json`: `dev`, `build`, `test`, `test:watch`, `test:e2e`.

## Routes

| V1 screen | Browser route | Component | Current API consumer | Evidence |
|---|---|---|---|---|
| Dashboard | `/` | `features/dashboard/DashboardPage.tsx` | `GET /dashboard`, `GET /execution` | `router.tsx:30-34`; page lines 19-59 |
| Project View | `/projects/:id` | `features/projects/ProjectPage.tsx` via `ProjectRoute` | `GET /projects/:id` | `router.tsx:35-39`; page lines 16-43 |
| Epic View | `/epics/:id` | `features/epics/EpicPage.tsx` via `EpicRoute` | `GET /epics/:id` | `router.tsx:40-44`; page lines 16-42 |
| Task View | `/tasks/:id` | `features/tasks/TaskPage.tsx` via `TaskRoute` | `GET /tasks/:id` | `router.tsx:45-49`; page lines 14-57 |
| Approval Inbox | `/approvals` | `features/approvals/ApprovalInboxPage.tsx` | `GET /approvals`, `POST /approvals/:id/approve` | `router.tsx:50-53`; page lines 75-134 |
| Execution Queue / Agents Monitor | `/execution` | `features/execution/ExecutionPage.tsx` | `GET /execution`, `POST /runs/:id/cancel` | `router.tsx:54-57`; page lines 40-104 |
| Agent Run Detail / Live Logs | `/runs/:id` | `features/runs/AgentRunPage.tsx` | `GET /runs/:id`, `POST /runs/:id/cancel` | `router.tsx:58-61`; page lines 30-96 |
| Usage & Budget | `/usage` | `features/usage/UsagePage.tsx` | `GET /usage` | `router.tsx:62-65`; page lines 25-76 |
| Settings / Project Configuration | `/settings` | `features/settings/SettingsPage.tsx` | `GET /settings` | `router.tsx:66-69`; page lines 24-76 |
| Project Onboarding | `/projects/new` and parameterized `projects/:id` is not registered for onboarding | `features/onboarding/ProjectOnboardingPage.tsx` via `OnboardingRoute` | `GET /onboarding/:id`; no UI caller for discover/approval/approve/activate | `router.tsx:18,70-73`; page lines 32-108 |

The router has no explicit 404 route and no route-level loader/error boundary. `projects/new` is the only navigation target for “Projects” (`AppShell.tsx:11-17`), although its component receives an empty `id` and renders an empty-state explanation instead of starting onboarding.

## Application Shell / Layout

`apps/web/src/components/AppShell.tsx` supplies the persistent left navigation and `<Outlet>` (`:8-23`). Navigation exposes Dashboard, Projects, Approvals, Execution, Usage, and Settings, but not direct links to existing Project/Epic/Task/Run detail routes. `apps/web/src/styles/base.css` contains the dark responsive layout and basic focus-visible styling; detail pages still mostly render raw paragraphs/lists rather than domain navigation.

`apps/web/src/app/App.tsx` gates route mounting on session bootstrap error and mounts SSE after successful bootstrap. `apps/web/src/main.tsx` owns bootstrap-token/session-restore startup.

## Shared UI Primitives

- `StatusBadge.tsx`: present but not consumed by the feature pages found in this pass; status color variant is caller-selected.
- `WorkflowTimeline.tsx`: consumed by Task; maps lifecycle values to display stages but is not used by Project/Epic.
- `SanitizedTerminal.tsx`: sanitizes terminal text and has unit coverage, but no current page imports it.
- `AppShell.tsx`: layout/navigation, not a reusable page-state or action primitive.
- Common loading/error/empty markup is duplicated inline in feature pages; there is no shared `PageState`, `ErrorNotice`, `EmptyState`, form, toast, or confirmation primitive.

## API Client

`apps/web/src/api/client.ts:8-71` implements generic `get`/`post` only, prepends `/api/v1`, sends same-origin credentials, bearer-in-memory and CSRF headers, parses structured `{ error }`, and has no typed endpoint registry, cache invalidation, abort handling, or mutation state model. `bootstrap` and `restoreSession` are implemented in `:76-104`.

`apps/web/src/api/events.ts:17-112` consumes `/api/v1/events` as SSE and reconnects every 5 seconds. The reconnect callback only dispatches a browser event; only Dashboard subscribes to it in the source inspected. Projections remain authoritative, consistent with the architecture spec.

## Query / State Layer

The application now has a dependency-free shared query store with cache, dedupe, abort/stale-result protection and explicit invalidation; migrated screens use the React adapter. SSE still does not invalidate every mounted projection, and onboarding remains outside the migration. A shared mutation store backs the supported approve/cancel flows; there is still no durable notification channel.

## Feature Modules

| Module | Responsibility found | Significant current boundary |
|---|---|---|
| `dashboard` | Dashboard projection plus execution summary | Two independent GETs and mostly text summaries; no action handlers |
| `projects` | Project overview projection | “Tabs” are plain text, not navigation; lists are not links |
| `epics` | Epic projection | Renders counts/list and text, not graph/stages/actions |
| `tasks` | Task projection, lifecycle timeline | Displays projection fields; does not expose pause/dispatch/dependency actions |
| `approvals` | Approval list and approve mutation | Backend/UI exposes approve only; no decision detail form |
| `execution` | Scheduler projection and run cancel | Good wait-reason rendering; no pause/stop-all/resource-lock controls |
| `runs` | Safe run summary and cancel | No logs/events/permission decisions/recovery/checkpoints |
| `usage` | Global/project/epic/task totals | Read-only compact summary, no budget editing or run attribution UI |
| `settings` | Effective hierarchy/security read view | No edit form or mutation; raw JSON is the primary presentation |
| `onboarding` | Existing onboarding record read view | No discovery or approval/activation controls; empty route cannot begin flow |

## Tests

- `app-shell.test.tsx`: shell/navigation rendering.
- `routing-bootstrap.test.ts`: stable route IDs and bootstrap/reload session behavior.
- `core-views.test.tsx`: dashboard/project/epic/task core rendering.
- `configuration-views.test.tsx`: onboarding detected/proposed separation, settings, usage.
- `operations-views.test.tsx`: terminal sanitization, queue wait reason, run detail contract.
- `ui-api-remediation.test.tsx`: approval envelope/mutation and dashboard error/dead-action behavior.
- `e2e/v1-ui.spec.ts`: persistent navigation, reload restore, and launched-backend smoke across all 10 route identities. It does not yet cover the full direct-load/reload/loading/error-retry/populated/mutation/responsive/accessibility matrix or full product flows.

## Backend Routes and Read Models

| UI need | Backend route(s) | Read model / response | Mutation availability |
|---|---|---|---|
| Dashboard | `GET /api/v1/dashboard` (registered in `create-app.ts`) and `GET /api/v1/execution` | `DashboardProjection`, `ExecutionProjection` | No dashboard Pause All/New Request route consumed by UI |
| Project | `GET /api/v1/projects/:id` | `ProjectProjection` → `ProjectOverviewProjection` | `POST /api/v1/projects` exists; no UI form |
| Epic | `GET /api/v1/epics/:id` | `EpicProjection` → `EpicOverviewProjection` | Work/epic plan/approve-run routes exist; no UI actions |
| Task | `GET /api/v1/tasks/:id` | `TaskProjection` → `TaskOverviewProjection` | `POST /tasks/:id/pause`, dispatch, dependency routes exist; no UI actions |
| Approvals | `GET /api/v1/approvals`, `POST /api/v1/approvals/:id/approve` | DB approval rows mapped by `mapApprovalRow` | Approve only in this route surface; reject/request-changes not evidenced |
| Execution / Run | `GET /api/v1/execution`, `GET /api/v1/runs/:id`, `POST /api/v1/runs/:id/cancel` | `ExecutionProjection`, safe run response | Cancel exposed; dispatch exists but is not linked from UI |
| Usage | `GET /api/v1/usage` | Usage hierarchy response from `usage.ts` | No usage mutation route consumed |
| Settings | `GET /api/v1/settings`; scheduler config GET/PUT exists separately | Effective hierarchy/security response | No settings-page mutation path |
| Onboarding | discover POST, record GET, approval POST, approve POST, activate POST in `onboarding.ts` | `projectView()` onboarding response | Full backend sequence exists, no corresponding UI controls |

Read-model source files are `apps/server/src/app/read-models/dashboard-projection.ts`, `project-projection.ts`, `epic-projection.ts`, `task-projection.ts`, `execution-projection.ts`, and `git-state.ts`. Shared projection interfaces are in `packages/contracts/src/api.ts:19-61`.

## Подтверждённый dead/unused code

- `SanitizedTerminal.tsx` is covered by tests (`operations-views.test.tsx`) but is not imported by `AgentRunPage` or another current page; it is a candidate for retention only if the recovery design adds a safe log surface, otherwise deletion after implementation review.
- `StatusBadge.tsx` is not referenced by current feature pages found by source search; status chips are duplicated as spans in operations/run pages.
- The `projectId` prop in `ApprovalInboxPage` is accepted and used only as an effect dependency; `/approvals` supplies no project filter and no route passes the prop.
- `packages/contracts/src/api.ts:63-71` has canonical `apiPaths`, but it covers only dashboard/projects/epics/tasks/execution/approvals while the actual web client also uses runs, usage, settings, onboarding, session, and events. This is a contract-maintenance gap, not proof that those backend endpoints are absent.
