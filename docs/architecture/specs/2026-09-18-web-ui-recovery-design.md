# Ebb Orchestrator — Web UI Recovery Design

> Recovery design produced from the bounded Stage 10 audit on 2026-09-21. This document defines the next implementation boundary; it does not authorize production-code changes, new backend capabilities, or post-v1 scope.

## Design decisions

1. Keep React + Vite + TypeScript + React Router 7. The audit found incomplete composition and contract wiring, not evidence that the current framework cannot implement the approved V1 information architecture.
2. Keep the backend/read-model boundary authoritative. UI state may render, cache, retry, and optimistically mark pending mutation state, but it must not invent lifecycle transitions, approval authority, scheduler reasons, Git state, budgets, or persistent IDs.
3. Add UI only for evidenced endpoints. Where the approved screen requires an unsupported action or projection, record a contract decision and keep the control absent until the backend contract is approved and implemented.
4. Keep local-session security: bearer remains memory-only, reload uses same-origin HttpOnly session plus CSRF token, and untrusted terminal content is sanitized before display.

## Application shell

`AppShell` remains the root layout and gains:

- primary navigation to Dashboard, projects, approvals, execution, usage, settings;
- context links from project/work/run records, breadcrumb/back navigation, and an explicit `/404`/route error surface;
- consistent page header, status, action, loading, error, empty, and inline-confirmation primitives;
- responsive navigation that remains keyboard reachable at the existing 700px/960px breakpoints.

The shell must not add a fake Projects list or a fake Coordinator Chat. It may link to a real project list/create contract once one is available. `/projects/new` must either become a real onboarding entry form using `POST /onboarding/discover` or be replaced by a route that has a real contract; it must not silently fabricate an identifier.

## Routing and navigation

Retain the current route identities and add route-level error/404 handling:

| Route | Page | Required navigation |
|---|---|---|
| `/` | Dashboard | links to real project, epic, task, approval, execution, and run IDs present in returned projections |
| `/projects/:id` | Project | real internal links for epics/tasks/runs/usage where IDs/data exist |
| `/epics/:id` | Epic | child task links and project back link |
| `/tasks/:id` | Task | run, dependency, approval, project/epic links |
| `/approvals` | Approval Inbox | approval detail context; no unsupported reject/change buttons |
| `/execution` | Execution monitor | task/run links; cancel only for rows and statuses accepted by backend |
| `/runs/:id` | Agent Run | task/epic links; supported observable sections only |
| `/usage` | Usage & Budget | scope links/drill-down only for returned IDs |
| `/settings` | Settings | project/config context once a real editable scope is selected |
| `/projects/new` | Onboarding entry | repository path → discovery → review; never requires a guessed project ID |

No browser route is allowed to treat a 200 empty fallback projection as proof that an entity exists; the page must distinguish not-found/empty/error according to the backend response contract.

## Frontend module boundaries

```text
apps/web/src/app/              router, providers, route boundaries
apps/web/src/components/       shell and reusable visual/state primitives
apps/web/src/api/              typed transport, endpoint paths, SSE/refetch events
apps/web/src/state/            query cache, invalidation, mutation lifecycle
apps/web/src/features/         one page module per approved screen
apps/web/test/                 contract, state, route and accessibility-oriented tests
```

Feature modules own page composition and view-specific mapping. They do not reach into server persistence or duplicate policy. Shared state owns request lifecycle and invalidation, not domain transitions.

## Shared UI primitives / design system

Create or refactor the following within the existing CSS approach:

- `PageState`: loading, error with retry, empty, and not-found variants;
- `PageHeader` and `Breadcrumbs`;
- `StatusBadge` with deterministic status-to-variant mapping, while preserving raw canonical status text;
- `ActionButton`/`ActionGroup` with pending/disabled and confirmation support;
- `MetricCard`, `DataList`, `DataTable`, `Timeline`, `EventList`, and `InlineAlert`;
- `SensitiveText`/`SanitizedTerminal` for untrusted tool output only when the backend supplies an approved log projection.

Avoid a new major component framework. Keep semantic headings, table headers, keyboard focus, visible focus, and `aria-live` only for transient status updates that are safe to expose.

## API client

Refactor `apps/web/src/api/client.ts` into a typed endpoint catalog while preserving its security behavior. Include actual paths for session, dashboard, projects, epics, tasks, approvals, execution, runs, usage, settings, onboarding, and events. Align or extend `packages/contracts/src/api.ts:63-71` rather than maintaining a second undocumented path list.

Each request must support:

- same-origin credentials and current CSRF/bearer headers;
- structured server error parsing with status and safe message;
- abort/cancellation on route change;
- typed response validation at the boundary for new/changed contracts;
- no logging of launch tokens, bearer tokens, secrets, prompts, or raw untrusted artifacts.

## Query/cache/state strategy

Use a small project-local query store rather than introducing a major dependency in this recovery stage. A query key is the canonical endpoint plus normalized parameters. The store owns `idle/loading/success/error`, data timestamp, retry, and invalidation. SSE events cause invalidation/refetch of affected keys; SSE payloads are hints, not authoritative state. Detail pages must refetch after mutations and after reconnect when their key is invalidated.

Mutation state must include pending, structured failure, and confirmed success. Avoid optimistic domain-state transitions for approvals, lifecycle, Git, scheduler, or activation; show “pending” until the authoritative read model confirms the result.

## Loading, error, and empty states

Every page has explicit states:

- loading: stable skeleton/label and no destructive controls;
- error: safe server message, retry, and preserved route context;
- not found: distinguish missing entity from empty collection;
- empty: explain what is empty and provide a real next action only if an endpoint supports it;
- mutation failure: preserve current data, identify the action, and offer retry/reload without hiding the server status.

## Forms and validation

Forms are allowed only for evidenced commands:

- onboarding repository path → `POST /onboarding/discover`;
- onboarding semantic approval request/approve/activate → existing routes and exact backend policy;
- project/task/epic creation → existing `POST` routes with their current schemas;
- task dependencies → existing dependency routes;
- run cancel → existing cancel route.

Use field-level validation for request shape and backend error rendering for policy/conflict decisions. Never implement client-only activation, approval, lifecycle, budget, or Git transitions.

## Notifications and status presentation

Inline alerts remain the primary durable error channel. Add a non-blocking success/status region for confirmed mutations, with accessible announcements and no sensitive payload. Raw domain status remains visible; human labels may be layered on top but must not replace canonical codes. Wait reasons must show both code and message from the Scheduler projection.

## Page composition and acceptance criteria

### Dashboard `/`

- Purpose: global active work, running agents, pending approvals, AI spend, active projects, queue and agent pool summary.
- Data: `GET /api/v1/dashboard` and `GET /api/v1/execution`.
- Actions: links to real records; Pause All/New Request only after an evidenced, policy-checked contract exists.
- States: independent loading/error/empty for dashboard and queue.
- Acceptance: every displayed project/work/run/approval identifier navigates to a real route; no static “Coordinator Chat” action; reconnect invalidates the dashboard keys.

### Project View `/projects/:id`

- Purpose: project identity, repository/GitHub state, epics/tasks, blockers, activity, budget and scoped configuration context.
- Data: `ProjectOverviewProjection` from `GET /projects/:id`.
- Actions: links to child records; create controls only for `POST /projects/:id/tasks`, `POST /projects/:id/epics`, or separately approved project creation.
- States: loading, not-found, error, and empty child collections.
- Acceptance: “tabs” are navigable links or are removed; every visible count has a corresponding list/detail or clear empty explanation.

### Epic View `/epics/:id`

- Purpose: lifecycle/stages, contract, child-task graph/list, blockers, approvals, events, Git and usage.
- Data: `EpicOverviewProjection` from `GET /epics/:id`.
- Actions: child task navigation; planning/approve-run controls only against `epics.ts` contracts.
- States: lifecycle loading/error/empty and explicit blocked/waiting reason.
- Acceptance: stage status comes from projection; no UI computes or mutates lifecycle transitions.

### Task View `/tasks/:id`

- Purpose: contract, lifecycle, runs, findings/defects, dependencies, approvals/events, Git, recovery reason and usage.
- Data: `TaskOverviewProjection` from `GET /tasks/:id`.
- Actions: supported pause, dispatch, dependency mutations and links; final merge only through exact approved authority contract.
- States: projection loading/error/not-found, empty findings/dependencies/runs, explicit wait reason.
- Acceptance: `WorkflowTimeline` preserves exceptional states; controls are disabled/pending while mutation is unresolved and refetch after confirmation.

### Approval Inbox `/approvals`

- Purpose: pending decisions with subject, scope, evidence and resolution history.
- Data: `GET /approvals` plus a future approved detail contract if required.
- Actions: current contract proves approve only. Reject/request-changes must not be rendered until backend routes and schemas are approved.
- States: pending list, no pending approvals, load/mutation conflict error.
- Acceptance: server envelope mapping remains covered; resolution is confirmed by refetch rather than local-only status.

### Execution Queue `/execution`

- Purpose: running/queued/blocked work, scheduler capacity, exact wait reason, and supported stop/cancel controls.
- Data: `GET /execution`; current projection has running/waiting/blocked and `WaitReason`.
- Actions: run cancel; future pause/stop-all/resource-lock controls only when contracts exist.
- States: loading/error/empty and mutation failure.
- Acceptance: each row links to its Task/Run; code and message are both shown; no reason is inferred in the browser.

### Agent Run Detail `/runs/:id`

- Purpose: observable run metadata, usage, logs/events, permission decisions and recovery signals without hidden chain-of-thought.
- Data: current `GET /runs/:id` safe metadata/usage; additional sections require an explicit backend contract.
- Actions: current cancel only when active; checkpoint/resume/recovery controls require approved routes.
- States: loading/not-found/error, active/inactive, and unavailable-observability sections clearly separated.
- Acceptance: no raw prompt, hidden reasoning, secret, capability artifact, or unsupported subresource is requested; `SanitizedTerminal` is used only for an approved sanitized log field.

### Usage & Budget `/usage`

- Purpose: global/project/epic/task spend, effective limits, reservations and attributable run usage.
- Data: current `GET /usage` hierarchy response; extend only through an explicit contract.
- Actions: scope navigation and read-only drill-down; budget edits only when a server mutation is approved.
- States: loading/error/empty/no-budget-data.
- Acceptance: totals identify their scope and units; hard-limit/wait state is not conflated with zero spend.

### Settings `/settings`

- Purpose: effective hierarchy and security posture, plus validated editable project configuration when supported.
- Data: current `GET /settings`; scheduler config remains a distinct contract.
- Actions: current page is read-only. Add edit/save only after a backend validation/persistence contract is approved.
- States: loading/error and explicit read-only/unsupported state.
- Acceptance: no JSON dump is the only representation of a user-editable setting; Local Mode warning remains accurate and visible.

### Project Onboarding `/projects/new`

- Purpose: repository input, discovery, DETECTED facts, PROPOSED config, semantic approval, activation.
- Data/actions: `POST /onboarding/discover`, `GET /onboarding/:id`, `POST /onboarding/:id/approval`, `POST /onboarding/:id/approve`, `POST /onboarding/:id/activate`.
- States: initial input, discovery loading/error, review, approval pending/approved/conflict, activation success/failure.
- Acceptance: DETECTED and PROPOSED remain visually distinct; activation only follows persisted approved semantic authority; secrets/runtime state are never rendered.

## Existing modules: retain / refactor / rewrite / delete

### RETAIN

- `apps/web/src/app/router.tsx` route identities as the starting point.
- `apps/web/src/app/App.tsx`, `main.tsx`, and `api/client.ts` session security behavior.
- `apps/web/src/api/events.ts` SSE transport principle.
- `apps/web/src/components/WorkflowTimeline.tsx` lifecycle display semantics.
- `apps/web/src/components/SanitizedTerminal.tsx` sanitization utility and tests, conditional on a supported log projection.
- `apps/server/src/app/read-models/*` and `packages/contracts/src/api.ts` as authoritative projection boundary.

### REFACTOR

- `apps/web/src/components/AppShell.tsx` for navigation, breadcrumbs, route boundaries and shared states.
- `apps/web/src/api/client.ts` and `apps/web/src/api/events.ts` around typed paths/query invalidation.
- All ten `apps/web/src/features/*Page.tsx` files for page composition and shared state usage.
- `apps/web/src/styles/base.css` only for shared primitives/responsive/accessibility needs; no framework replacement.

### REWRITE

- The onboarding entry/action surface, because the current `/projects/new` empty-id page cannot represent the backend flow.
- Approval decision detail only after the approve-only vs full decision contract is resolved.
- Agent Run observability sections only after backend exposes explicit safe projections.

### DELETE

- No immediate deletion in Stage 10. After implementation evidence, candidates are unused `StatusBadge`, unused `projectId` prop, and any `SanitizedTerminal` path proven to have no supported consumer. Deletion requires a separate consumer/test check.

## Browser/E2E testing

The next implementation must add a matrix-driven Playwright suite using the existing `apps/web/test/e2e/run-e2e.mjs` harness. For all 10 routes it must test normal navigation, direct load, reload/session restore, loading, empty, error/retry, and supported primary actions. It must assert network/API shape for mutations, authoritative refetch after mutation, no console errors, and no unsupported controls. The current Stage 10 audit did not run this suite because the request required a bounded read-only pass and no long-running browser tests.

## Accessibility and responsive baseline

- All actions have accessible names and keyboard focus; status and mutation results use appropriate `role`/`aria-live` without leaking sensitive data.
- Tables keep semantic headers; mobile layouts provide reachable horizontal scroll or card alternatives.
- Focus-visible styling remains visible against the dark theme.
- 320px minimum width and existing 700px/960px breakpoints are acceptance inputs, not assumptions.

## Independently testable implementation stages

| Stage | Files/modules | Acceptance criteria | Tests | Dependencies / non-goals |
|---|---|---|---|---|
| A. Shell + primitives | `app/router.tsx`, `AppShell.tsx`, `styles/base.css`, new shared state primitives | 404/error boundary, breadcrumbs, accessible shared states, real links from known IDs | shell/router/component tests at desktop/mobile widths | Depends on current routes; no backend changes |
| B. API/query foundation | `api/client.ts`, `api/events.ts`, `packages/contracts/src/api.ts`, new web state module | typed path catalog, abort, cache/refetch/invalidation, mutation lifecycle, SSE key invalidation | client/query/mutation tests and API error tests | Preserve session/CSRF; no new capability inference |
| C. Onboarding + Dashboard + Project | `features/onboarding`, `dashboard`, `projects` | repository discovery through persisted activation; linked dashboard/project data; no fake controls | route/API flow tests and targeted browser tests | Depends A/B; use existing onboarding/project routes only |
| D. Task + Epic + Approval | `features/tasks`, `epics`, `approvals`, `WorkflowTimeline` | linked lifecycle/detail surfaces; supported mutations; approval contract decision recorded | projection mapping, mutation/refetch, decision-state tests | Depends C; do not invent reject/change routes |
| E. Queue + Run + Usage + Settings | `features/execution`, `runs`, `usage`, `settings`, `SanitizedTerminal` | exact queue reasons, supported cancel, safe run observability, scoped usage, explicit settings read-only/edit contract | operations/configuration tests and route matrix browser checks | Depends B; backend contract gaps must remain explicit |
| F. Browser E2E + cleanup | `apps/web/test/e2e/*`, dead-code candidates | all 10 routes verified direct/reload/action/error/empty; only then remove proven unused code | full web test/build/E2E relevant gate | Final verification; no post-v1 scope |

## Explicit non-goals

- No new major frontend framework, global state platform, or backend persistence technology.
- No hidden chain-of-thought, raw prompt, secret, or untrusted artifact exposure.
- No invented Pause All, New Request, reject/request-changes, checkpoint, resume, settings-save, or log endpoints.
- No production implementation, commit, merge, push, or browser E2E execution as part of this bounded audit.
