---
id: audit-08
status: completed
kind: audit
title: Карта кода Web UI
date: 2026-09-23
---

# Карта кода Web UI

## Baseline

- Дата аудита: 2026-09-22.
- Checkout: `develop`, HEAD `62860e5` (`refactor: add shared UI primitives (PageState, StatusBadge)`); upstream `origin/develop` недоступен (`[gone]`).
- В рабочем дереве до аудита уже были изменения в `apps/web/src/api/events.ts`, `apps/web/src/hooks/useEventClient.ts` и удаление `apps/web/test/setup.ts`. Они не относятся к этому audit/design commit и сохранены.
- Browser evidence: `pnpm --filter @ebb-orchestrator/web test:e2e` — backend `READY`, Playwright `3 passed`, harness teardown подтвердил отсутствие bootstrap artifact.
- Baseline checks: `pnpm lint` — pass; `pnpm typecheck` — pass; root `pnpm test` — fail из-за отсутствующего pre-existing `apps/web/test/setup.ts` и отдельного Windows/git-worktree failure в server test; web build — fail на отсутствующих `@testing-library/jest-dom` matcher typings после удаления setup file.

## Frontend Stack

- React `^19.3.0`, TypeScript, Vite `^8.1.0`.
- Router: `react-router` `^7.18.3`, `createBrowserRouter` in `apps/web/src/app/router.tsx`.
- Query/state: local `createQueryStore`/`useQuery` in `apps/web/src/state/query-store.ts`, `use-query.ts`; local `createMutationStore` in `mutation-store.ts`; no external cache library.
- API: typed-but-runtime-generic `apiClient` in `apps/web/src/api/client.ts`, paths/types from `@ebb-orchestrator/contracts`.
- Live updates: SSE client in `apps/web/src/api/events.ts`, hook in `apps/web/src/hooks/useEventClient.ts`; reconnect/invalidation is presentation-only and pages refetch authoritative projections.
- Test runner: Vitest 5 + jsdom + Testing Library. Browser: Playwright 1.63 through `apps/web/test/e2e/run-e2e.mjs`.
- Scripts: `dev`, `build` (`tsc -b && vite build`), `test`, `test:e2e`; root scripts are `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm web:build`.

## Routes

| Route | Source | Backend read model / endpoint | Current primary actions |
|---|---|---|---|
| `/` | `features/dashboard/DashboardPage.tsx` | `/api/v1/dashboard`, `/api/v1/execution` | links to work/run/project; refresh/retry |
| `/projects/:id` | `features/projects/ProjectPage.tsx` | `/api/v1/projects/:id` | links to epics/tasks |
| `/epics/:id` | `features/epics/EpicPage.tsx` | `/api/v1/epics/:id` | links to child tasks |
| `/tasks/:id` | `features/tasks/TaskPage.tsx` | `/api/v1/tasks/:id` | links to project/epic/runs/dependencies; retry |
| `/approvals` | `features/approvals/ApprovalInboxPage.tsx` | `/api/v1/approvals` | `POST /api/v1/approvals/:id/approve` |
| `/execution` | `features/execution/ExecutionPage.tsx` | `/api/v1/execution` | refresh; cancel active run |
| `/runs/:id` | `features/runs/AgentRunPage.tsx` | `/api/v1/runs/:id` | cancel active run; related links |
| `/usage` | `features/usage/UsagePage.tsx` | `/api/v1/usage` | read-only |
| `/settings` | `features/settings/SettingsPage.tsx` | `/api/v1/settings` | read-only; no mutation |
| `/projects/new` | `features/onboarding/ProjectOnboardingPage.tsx` | `/api/v1/onboarding/:id`; discover/approval/approve/activate exist in backend/contracts | current route has no project discovery input and refuses to guess an id |
| `*` | `NotFoundPage` | none | link to Dashboard |

## Application Shell / Layout

- `apps/web/src/app/App.tsx` restores/bootstraps local session and renders `RouterProvider`.
- `apps/web/src/components/AppShell.tsx` owns left navigation, `Outlet`, and breadcrumb rendering.
- `apps/web/src/styles/base.css` owns global responsive/layout styling.
- Shell navigation exposes Dashboard, Projects (only `/projects/new`), Approvals, Execution, Usage, Settings. Project/Epic/Task/Run are reached only through contextual links/direct URL.
- `RouteBreadcrumbs` is rendered inside an element also named `route-breadcrumbs`; this is a confirmed markup/layout smell, not a backend contract issue.

## Shared UI Primitives

- `PageState.tsx`: loading/error/empty/not-found helpers; `EmptyState`, `ErrorAlert`, and a duplicate `StatusBadge` are exported from this file, but production feature pages do not consume these helpers consistently.
- `StatusBadge.tsx`: separate duplicate status primitive is present; current production consumers are not established by repository-wide references.
- `WorkflowTimeline.tsx`: task lifecycle display.
- `SanitizedTerminal.tsx`: sanitized output display for run detail.
- Repeated page-level loading/error/empty markup remains in feature modules despite these primitives.

## API Client

- `apps/web/src/api/client.ts` prefixes canonical paths with `/api/v1`, carries same-origin credentials, in-memory bootstrap bearer and CSRF token, and exposes `ApiError`.
- `packages/contracts/src/api.ts` is the path/projection contract source used by most pages.
- Onboarding is the exception: it constructs `/onboarding/:id` as a string instead of using `apiPaths.onboarding(id)`; `/projects/new` currently passes the sentinel `new` and remains a dead-end rather than a discovery form.
- SSE uses `apiClient` token fields directly. The exported `authenticatedHeaders()` has no consumer after the current pre-existing events diff; it is confirmed unreferenced in the repository.

## Query / State Layer

- Each feature creates its own `createQueryStore()` with `useQuery`; there is no shared process-level cache or invalidation key registry.
- Each mutating feature creates a local `createMutationStore()` and refetches its own query after success.
- SSE invalidation callbacks trigger refetches, but listener removal is not represented in `EventClient`; `useOnSSEReconnect` currently leaves listeners in the process-local set. This overlaps the pre-existing uncommitted change and is recorded as a review finding, not changed here.

## Feature Modules

- `features/dashboard`: two independent projections and repeated status branches.
- `features/projects`, `epics`, `tasks`: projection-oriented detail pages with links but no create/edit workflow UI.
- `features/approvals`: list and approve only; reject/request-changes are absent from the component and current route contract.
- `features/execution`, `runs`: queue/run read models and cancel mutation.
- `features/usage`, `settings`: read-only projections.
- `features/onboarding`: loads an already identified project; no discover/select step.

## Tests

- Unit/component suites: `apps/web/test/{app-shell,core-views,operations-views,configuration-views,query-store,query-hook,mutation-store,api-client-foundation,routing-bootstrap,ui-api-remediation}.test.*`.
- E2E: `apps/web/test/e2e/v1-ui.spec.ts`, launched by `test/e2e/run-e2e.mjs` with an isolated in-memory backend and Vite proxy.
- Current web unit suite cannot load because `vite.config.ts` references deleted `test/setup.ts`; this is a pre-existing checkout condition.

## Backend Routes and Read Models

- Registration boundary: `apps/server/src/app/create-app.ts`.
- Projections: `dashboard-projection.ts`, `project-projection.ts`, `epic-projection.ts`, `task-projection.ts`, `execution-projection.ts`.
- Routes include dashboard, projects, work/task/epic, approvals, runs, onboarding, scheduler/settings, usage, events/SSE, dependencies, final merge, secrets and optional GitHub/diagnostics.
- Existing backend mutation routes are broader than current UI: project/task/epic creation, task dispatch/pause, dependencies, onboarding discover/approval/approve/activate, scheduler config and final merge are not wired to the current Web UI.
- Backend remains authoritative for workflow, approvals, scheduling, security and Git; recovery design must consume projections/capabilities instead of recreating those rules in React.

## Подтверждённый dead/unused code

- `authenticatedHeaders()` in `apps/web/src/api/client.ts` is unreferenced after the current SSE header change (repository-wide `rg` found only its declaration).
- `projectId` prop of `ApprovalInboxPage` is explicitly discarded (`void projectId`) and no route supplies it; project-scoped approval view is therefore not implemented, though the component signature suggests one.
- No source file is deleted in this audit. Suspected unused code outside these two cases is not classified as dead without a reference/build proof.
