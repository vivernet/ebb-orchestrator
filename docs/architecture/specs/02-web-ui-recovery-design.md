---
id: spec-02
status: superseded
title: Web UI Recovery Design
date: 2026-09-18
stage: 08
type: spec
tags: [web, ui, recovery, design]
---


# Ebb Orchestrator — Web UI Recovery Design

## Status and scope

Это recovery design по результатам factual audit в [`docs/audit/web-ui-gap-analysis.md`](../../audit/09-web-ui-gap-analysis.md). Он сохраняет утверждённую V1 information architecture и текущий React/Vite stack. Это не implementation plan и не разрешение менять backend contracts или добавлять post-v1 scope.

Current recovery verdict: shell and projection foundation are usable; onboarding, approval decisions, run evidence, editable configuration and complete primary navigation require staged recovery. Backend remains the authority for permissions, transitions, approvals, scheduling, budgets, Git and recovery.

## Application shell

- `AppShell` owns the persistent shell, global navigation, project context and outlet.
- Primary navigation: Dashboard, Projects (project index + New Project), Approvals, Execution, Usage, Settings.
- Project-scoped navigation is rendered from a resolved project context: Overview, Epics, Tasks, Runs, Git, Guidelines, Usage, Settings. It must not guess IDs or expose actions the backend did not provide. A project index/read endpoint is a prerequisite for an honest Projects entry; it is a backend contract gap, not a client-side workaround.
- Breadcrumbs use route metadata and stable display labels, not raw untrusted path segments as the only label.
- Shell owns global session bootstrap/restore, connection indicator, accessible live-region announcements and a compact notification outlet.
- No client-side security boundary: visible actions come from backend capability/approval state and are revalidated by backend.

## Routing/navigation

Retain React Router `createBrowserRouter` and direct URL support. Add only V1 routes required by the approved screens:

| Route | Purpose |
|---|---|
| `/` | Dashboard |
| `/projects` | project index and onboarding entry |
| `/projects/new` | discovery input and onboarding start |
| `/projects/:projectId` | Project View |
| `/projects/:projectId/epics/:epicId` | project-scoped Epic View alias, if backend IDs resolve |
| `/projects/:projectId/tasks/:taskId` | project-scoped Task View alias |
| `/projects/:projectId/runs/:runId` | project-scoped Run Detail alias |
| `/approvals` | Approval Inbox |
| `/execution` | Execution Queue / Agents Monitor |
| `/runs/:id` | canonical Run Detail deep link |
| `/usage` | global Usage & Budget |
| `/settings` | effective global configuration |

Existing `/epics/:id`, `/tasks/:id`, `/projects/:id`, `/runs/:id` deep links remain compatible during migration. Direct navigation and reload must serve the SPA through the existing backend fallback.

## Frontend module boundaries

- `app/`: router, route metadata, session/application bootstrap only.
- `components/shell/`: AppShell, project switcher, breadcrumbs, nav, connection/notification regions.
- `components/ui/`: PageState, EmptyState, ErrorAlert, StatusBadge, ActionButton, DataTable, FormField, MetricCard, Timeline.
- `api/`: client, typed endpoint adapters, SSE subscription port; no domain decisions.
- `state/`: query cache, mutation state, invalidation and session-scoped lifecycle.
- `features/dashboard`, `projects`, `onboarding`, `epics`, `tasks`, `approvals`, `execution`, `runs`, `usage`, `settings`: route composition and feature-specific view models.
- `features/*/api.ts`: feature adapter from shared contract/read model to view data; no direct persistence details.
- `test/`: component/contract tests; `test/e2e/`: browser and persistence tests.

Feature modules may depend on `api`, `state` and `components/ui`; they must not import another feature's internal state or backend implementation. Cross-feature navigation uses route builders.

## Shared UI primitives / design system

Retain and consolidate `PageState`, `StatusBadge`, `WorkflowTimeline`, `SanitizedTerminal`. Add:

- `AsyncBoundary`: loading/error/empty/unavailable/stale states with consistent accessible semantics.
- `CapabilityAction`: renders an action only when backend capability allows it, shows blocked reason when appropriate, and reports mutation state.
- `MetricCard`, `DataTable`, `EvidencePanel`, `ReasonCallout`, `FormField`, `NotificationRegion`.
- Canonical status map from backend code to label, variant and explanation; never use color alone.
- All actions expose keyboard focus, disabled pending state, safe error text and a post-mutation announcement.

## API client

- Retain `apiClient`, `ApiError`, in-memory bearer and same-origin HttpOnly session/CSRF behavior.
- Use `packages/contracts/src/api.ts` path builders everywhere, including onboarding; no string-concatenated endpoint paths in feature components.
- Add typed endpoint adapters per feature. Adapters may normalize `null`/empty projections but may not invent missing data or silently convert errors to success.
- Normalize errors into `{ status, code, message, retryable, fieldErrors? }`; preserve machine code and safe server message.
- Mutations refetch or invalidate authoritative query keys after success. No optimistic workflow transition unless backend returns the authoritative updated projection.

## Query/cache/state strategy

- Replace per-component isolated stores with one app-scoped query cache keyed by canonical endpoint plus normalized params.
- Each query has `idle | loading | success | empty | error | stale` state and an AbortSignal.
- Mutations are keyed by resource/action and expose pending/success/error; they never own domain state.
- SSE remains invalidation/presentation only. It marks matching query keys stale and triggers bounded refetch. On reconnect, always refetch authoritative state.
- SSE subscription API must return an unsubscribe function; mounted hooks must remove listeners on cleanup.
- No secrets in browser storage, prompts, UI state or logs.

## Mutation/error strategy

- Use `CapabilityAction` and feature adapters for all mutations.
- Backend response is the source of truth; display updated projection after mutation.
- 401/403: session/permission boundary message and safe recovery path. 404: resource not found. 409: state conflict with backend reason. 422: field/domain validation. 429/503: retryable state. Unknown errors: safe generic message with correlation/request ID only if backend provides one.
- Never render repository paths, tokens, raw stack traces or privileged payloads in generic error UI.

## Loading/error/empty states

Every approved screen must define all four states:

- loading: skeleton or scoped progress without implying data exists;
- empty: explain why empty and provide an allowed next action;
- error: safe message, retry when retryable, back/context link where relevant;
- unavailable/blocked: backend reason and required approval/configuration, with no client bypass.

Stale data is labeled and remains readable while refetching. Empty is not conflated with error or unavailable.

## Forms/validation

- Onboarding form validates repository path/input locally only for shape, then calls `onboardingDiscover`; backend validates repository trust and semantics.
- Settings form edits only fields exposed as mutable by backend capability/read model; submit uses the scheduler/config contract and then refetches.
- Future task/epic forms use contracts and backend validation; they do not duplicate workflow rules.
- Field errors are associated with labels and announced; invalid submit does not clear user input.

## Notifications and status presentation

- NotificationRegion announces mutation success/failure and stale/reconnect state.
- StatusBadge uses canonical status + text explanation; actionable blocked/waiting reasons come from backend projections.
- Live updates never claim a transition until the refetch confirms it.

## Page composition

Pages compose `AsyncBoundary`, feature adapter, summary header, primary action bar, and sections. A page does not create its own API client, invent endpoint strings, or repeat generic error markup.

## Approved V1 screen contracts and acceptance criteria

### Dashboard — `/`

- Purpose: overview of running agents, active work, approvals, AI spend, active projects, queue, agent pool and coordinator entry.
- Data: `DashboardProjection` + `ExecutionQueueProjection`.
- Actions: navigate to New Request/project/task/run/approvals; Pause All only if backend exposes capability.
- States: loading per projection; empty copy for no agents/work/queue/projects; error with independent retry; blocked action with backend reason.
- Backend: `/api/v1/dashboard`, `/api/v1/execution`; no invented Pause All endpoint.
- Reusable: MetricCard, StatusBadge, ReasonCallout, ActionButton.
- Acceptance: direct/reload works; all links resolve; independent projection failure is visible; action persistence is confirmed by refetch.

### Project View — `/projects/:id`

- Purpose: repository/GitHub, overview, epics/tasks/runs/Git/guidelines/usage, dependencies, runtime/isolation/parallel/merge settings, activity and budget.
- Data: `ProjectOverviewProjection`.
- Actions: links to child work; create/config actions only when backend capability exists.
- States: loading, no project, empty work, backend error/blocked.
- Backend: `/api/v1/projects/:id` plus separately verified child routes.
- Acceptance: project context navigation and direct/reload preserve ID; no client-side transition/merge decision.

### Epic View — `/epics/:id`

- Purpose: lifecycle, contract, child tasks, review/QA/integration/merge, approvals, blockers, events and usage.
- Data: `EpicOverviewProjection`.
- Actions: child task navigation and approved planning actions where endpoint/capability exists.
- States: projection loading, missing epic, no tasks, blocked lifecycle, error.
- Backend: `/api/v1/epics/:id`, planning/final-merge routes; UI must not bypass approval.
- Acceptance: every stage shows backend status/reason; merge action requires backend-provided approval capability and authoritative result.

### Task View — `/tasks/:id`

- Purpose: contract, workflow, runs, findings/defects, QA, Git/worktree, recovery, usage, dependencies/events.
- Data: `TaskOverviewProjection` plus dependency route when needed.
- Actions: dispatch/pause/dependency actions only from capabilities.
- States: loading, missing, empty findings/runs, wait reason, error.
- Backend: `/api/v1/tasks/:id`, dispatch/pause/dependencies.
- Acceptance: workflow timeline reflects projection, not local guessed transitions; wait/block reason is visible; mutation refetches.

### Approval Inbox — `/approvals`

- Purpose: pending decisions with evidence, scope and action history.
- Data: approval projection from `/api/v1/approvals`.
- Actions: approve/reject/request changes only when contract and capability exist.
- States: loading, no pending approvals, conflict/error, unavailable evidence.
- Backend: current GET + approve; reject/request-changes require an approved contract change before implementation. The domain service alone is not sufficient evidence of an HTTP/UI contract.
- Acceptance: decision result persists after reload; no action appears without authority; evidence is inspectable before decision.

### Execution Queue / Agents Monitor — `/execution`

- Purpose: running/waiting/blocked queue, capacity, reasons and supported pause/cancel.
- Data: `ExecutionProjection`.
- Actions: refresh, cancel run; pause only if backend route exists.
- States: loading, empty, backend error, stale/reconnecting, blocked reason.
- Backend: `/api/v1/execution`, `/api/v1/runs/:id/cancel`, scheduler capabilities.
- Acceptance: cancel result is confirmed by refreshed projection; reason code/message is visible; no fake Pause All.

### Agent Run Detail / Live Logs — `/runs/:id`

- Purpose: lifecycle, events, tool calls, sanitized logs, permission decisions, usage and recovery.
- Data: run projection + SSE invalidation/event projection + sanitized output. Current HTTP projection does not yet expose all required events/tools/permissions/recovery/log fields; those are explicit backend contract prerequisites.
- Actions: cancel active run; navigate task/epic; inspect evidence.
- States: loading, missing, active/stale, terminal, log unavailable, error.
- Backend: `/api/v1/runs/:id`, `/api/v1/events`; permission/recovery fields only if read model exposes them.
- Acceptance: no raw secrets/log payloads; reconnect refetches; cancel is persisted; active/terminal distinctions are clear.

### Usage & Budget — `/usage`

- Purpose: tokens, cache, cost, context size, recovery/rework share, effective cost and budget state.
- Data: usage projection and backend budget fields.
- Actions: navigation to settings; budget edits only where supported.
- States: loading, no records, unavailable metric, error.
- Backend: `/api/v1/usage` and approved budget/config route.
- Acceptance: concrete units and scope are labeled; no invented quality score; negative/debt/blocking state follows backend projection.

### Settings / Project Configuration — `/settings`

- Purpose: effective hierarchy and supported global/project settings.
- Data: `SettingsProjection`, mutable scheduler config where authorized.
- Actions: edit/validate/save only exposed fields.
- States: loading, read-only/unavailable scope, validation error, conflict, saved confirmation.
- Backend: `/api/v1/settings`; scheduler config mutation only after contract/capability mapping.
- Acceptance: refresh shows persisted server value; unavailable scopes are explicit; no client-side policy override.

### Project Onboarding — `/projects/new` and `/onboarding/:id`

- Purpose: Repository → Discovery → Review Findings → Approve Config → Activate.
- Data: discovery result and `OnboardingProject` projection.
- Actions: discover, request approval, approve, activate according to backend authority.
- States: initial form, discovery loading, findings/empty, approval pending/rejected, activation blocked/success, error.
- Backend: `/api/v1/onboarding/discover`, `/onboarding/:id`, `/approval`, `/approve`, `/activate`.
- Acceptance: no guessed identifier; each step persists and is reloadable; activation is impossible until backend-approved semantic config.

## Existing modules classification

| Path/module | Decision | Boundary |
|---|---|---|
| `apps/web/src/api/client.ts` | RETAIN | Preserve session/CSRF/error semantics; add adapters around it |
| `packages/contracts/src/api.ts` | RETAIN | Source of canonical paths/types; change only with contract decision |
| `apps/web/src/api/events.ts` | REFACTOR | unsubscribe, typed invalidation, reconnect/refetch semantics |
| `apps/web/src/state/*` | REFACTOR | app-scoped query cache and mutation lifecycle |
| `apps/web/src/app/router.tsx` | REFACTOR | route metadata, project index, aliases, direct/reload tests |
| `apps/web/src/components/AppShell.tsx` | REFACTOR | shell/nav/context/notifications/accessibility |
| `apps/web/src/components/PageState.tsx`, `StatusBadge.tsx`, `WorkflowTimeline.tsx`, `SanitizedTerminal.tsx` | RETAIN then REFACTOR | consolidate shared design primitives |
| `features/dashboard`, `projects`, `epics`, `tasks` | REFACTOR | compose adapters and capability actions |
| `features/onboarding` | REWRITE | discovery/select/form and full persisted flow |
| `features/approvals` | REWRITE | evidence and contract-approved decision actions |
| `features/runs` | REWRITE | events/tools/logs/permissions/recovery composition |
| `features/execution`, `usage`, `settings` | REFACTOR | capabilities, forms/metrics and state semantics |
| `apps/web/test/e2e/*` | RETAIN then EXTEND | add populated/mutation/reload/viewport coverage |
| `authenticatedHeaders` and discarded `projectId` prop | DELETE later | only after pre-existing diff and consumers are reconciled |

## Browser/E2E testing

Playwright must run the real repository harness. For every route test normal navigation, direct URL, reload, loading, empty, error where possible, network request/result, primary action, refetch/persistence and console errors. Use seeded deterministic backend fixtures for populated flows, and separate contract tests for 403/409/422/503. Test desktop and narrow viewport. No screenshot-only acceptance.

## Accessibility baseline

Semantic headings/landmarks, labeled navigation/forms/tables, keyboard-complete actions, visible focus, `aria-live` for async result/error, `role=alert` only for actionable errors, no color-only status, sufficient text contrast, and focus restoration after dialogs/route transitions.

## Responsive behavior

Desktop keeps persistent nav; narrow viewport collapses it to an accessible menu. Tables become stacked labeled rows or horizontal scroll with headers. Primary action remains reachable without hover. E2E covers 1280px desktop and 390px narrow viewport for shell, dashboard, approvals and run detail.

## Independently testable implementation stages

### A. Application shell + shared primitives

- Modules: `app/router.tsx`, `components/AppShell.tsx`, `components/PageState.tsx`, `StatusBadge.tsx`, `styles/base.css`, new `components/shell/*`, `components/ui/*`.
- Acceptance: project index/nav/breadcrumb, accessible states, responsive shell, direct/reload routes.
- Tests: app-shell, router, primitive accessibility, Playwright shell viewport.
- Depends on: none.
- Must not change: backend routes, auth/session contract, domain transitions.

### B. API/query/mutation foundation

- Modules: `api/client.ts`, new `api/adapters/*`, `api/events.ts`, `hooks/useEventClient.ts`, `state/*`.
- Acceptance: canonical path builders, typed errors, app-scoped cache, invalidation unsubscribe, refetch after reconnect/mutation.
- Tests: client contract, query/mutation lifecycle, SSE unsubscribe/reconnect, 401/403/409/422 handling.
- Depends on: A primitives for state display.
- Must not change: backend authority/security semantics or browser token storage policy.

### C. Onboarding + Dashboard + Project

- Modules: `features/onboarding/*`, `features/dashboard/*`, `features/projects/*`, route metadata and relevant adapters.
- Acceptance: discovery→review→approval→activation UI uses existing endpoints; dashboard/project actions and projections are connected.
- Tests: seeded backend component/API tests; browser populated onboarding/dashboard/project persistence.
- Depends on: A, B.
- Must not change: onboarding service validation or add client-side repository trust decisions.

### D. Task + Epic + Approval

- Modules: `features/tasks/*`, `features/epics/*`, `features/approvals/*`, workflow/timeline components.
- Acceptance: projection-driven lifecycle and evidence; task/epic actions appear only from capabilities; approval decisions match approved backend contract.
- Tests: projection states, 409/conflict, action refetch; browser task/epic/approval flows.
- Depends on: A, B, C project context.
- Must not change: workflow engine transitions or approval authority in frontend.

### E. Queue + Agent Run + Usage + Settings

- Modules: `features/execution/*`, `runs/*`, `usage/*`, `settings/*`, notification/status primitives.
- Acceptance: queue reasons/cancel, run evidence/live invalidation, concrete usage/budget, supported settings edit/persistence.
- Tests: event reconnect, sanitized output, cancel persistence, config validation; browser responsive run/settings/usage.
- Depends on: A, B, and D for task/run/approval links.
- Must not change: scheduler/recovery/budget policy; do not implement unsupported controls.

### F. Browser E2E + cleanup

- Modules: `apps/web/test/e2e/*`, all touched web modules, confirmed dead-code sites.
- Acceptance: all V1 route matrix cases, populated flows, direct/reload/viewport/persistence, console/network assertions; full lint/typecheck/test/build green.
- Tests: Playwright and all workspace gates.
- Depends on: A–E.
- Must not change: unrelated pre-existing working-tree changes, backend contracts without separate approval.

## Approval gate

Этот design останавливает работу перед implementation. Следующий этап требует подтверждения пользователя, потому что он меняет frontend architecture and feature composition. До такого подтверждения не начинать stages A–F.
