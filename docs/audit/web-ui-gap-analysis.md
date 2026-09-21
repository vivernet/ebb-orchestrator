# Ebb Orchestrator — Gap Analysis Web UI

> Bounded Stage 10 baseline audit, 2026-09-21. The analysis below records the pre-implementation gap inventory. Stage A1 was subsequently implemented and verified; later stages must re-check any baseline statement against current source.

## Verdict

The V1 route skeleton exists for all 10 approved screens, and the core read projections are present. Stage A1 now supplies shell breadcrumbs, route boundaries, and Dashboard links; the implementation is still not a complete V1 control plane because several pages remain projection-shaped summaries, onboarding cannot be started from the UI, and important backend mutations are not wired to screens. The recovery boundary should retain the current React/Vite/router stack and typed backend projections, then refactor the API/query foundation, page composition, and action surfaces in dependency order.

## Implementation update after baseline audit

Stage A1 is **PASS**. The current implementation now has:

- route-level 404 and safe error/retry boundaries;
- shell breadcrumbs and context navigation;
- client-side Dashboard links for returned project/task/run/queue IDs;
- encoded route segments, malformed-segment-safe breadcrumbs, and root `NavLink end` behavior;
- no static Coordinator Chat or unsupported Pause All/New Request controls;
- route/error/link regression coverage and passing production-composition E2E.

Stage B foundation slice is also **PASS**, and the Dashboard/Project/Epic/Task/Execution/AgentRun read-only migration pilot plus approve-only Approval flow are now **PASS**: the API client supports cancellation and structured errors, `apiPaths` has encoded builders for evidenced endpoints, the dependency-free query store covers cache/dedupe/invalidation/stale-result protection, the React adapter covers shared-consumer-safe subscriptions, and the mutation store covers cancel and approve POST lifecycles with pending/dedupe/error/authoritative-refetch behavior. The pilot also verifies encoded detail links and SSE reconnect refetch. The Usage route's migration-backed aggregate contract, shared `COMPLETING` status correction, and Settings explicit-unavailable contract are verified; remaining work is SSE key invalidation for remaining consumers and broader browser flow coverage. Reject/request-changes remain intentionally absent because the backend exposes approve only.

The remaining gaps below are intentionally still scoped to the pending Stage B migration and Stages C–F: onboarding/project flows, Task/Epic/Approval composition, operational screens, and matrix-wide browser verification.

Classification in this document is bounded to `KEEP`, `FIX`, `MISSING_UI`, and `CONTRACT_MISMATCH`. `KEEP` means retain the underlying route/projection or security behavior, not that the screen is production-complete.

## Baseline

- Frontend: React 19 + Vite 8 + TypeScript + React Router 7.
- API: `/api/v1`, hand-written `fetch` client, in-memory bearer plus same-origin HttpOnly session recovery and CSRF token.
- Realtime: SSE reconnect client; projections remain the source of truth.
- Existing evidence: Vitest/Testing Library coverage for shell, core views, configuration views, operations, API remediation, and session bootstrap; three Playwright smoke tests against compiled `apps/server/dist/main.js` plus Vite in an isolated temporary home. One launched-backend smoke test now visits all 10 approved route identities and checks their empty/not-found/error-safe states, but this is not the full Stage F matrix.
- Current unrelated worktree changes were preserved and are outside this audit.

## Approved V1 Screens

The 10-screen set is Appendix A of `docs/architecture/specs/2026-09-16-ebb-orchestrator-design.md`: Dashboard; Project View; Epic View; Task View; Approval Inbox; Execution Queue / Agents Monitor; Agent Run Detail / Live Logs; Usage & Budget; Settings / Project Configuration; Project Onboarding.

## Route Matrix

| Screen / route | Real component and backend contract | Evidence | Decision |
|---|---|---|---|
| Dashboard `/` | `DashboardPage`; `GET /dashboard` + `GET /execution`; `DashboardProjection` + `ExecutionProjection` | `apps/web/src/app/router.tsx:30-34`; `DashboardPage.tsx:19-59`; `dashboard-projection.ts`; `runs.ts:31` | **FIX** |
| Project `/projects/:id` | `ProjectPage`; `GET /projects/:id`; `ProjectOverviewProjection` | `router.tsx:35-39`; `ProjectPage.tsx:16-43`; `projects.ts:20-32` | **FIX** |
| Epic `/epics/:id` | `EpicPage`; `GET /epics/:id`; `EpicOverviewProjection` | `router.tsx:40-44`; `EpicPage.tsx:16-42`; `work.ts:19,54` | **FIX** |
| Task `/tasks/:id` | `TaskPage`; `GET /tasks/:id`; `TaskOverviewProjection` | `router.tsx:45-49`; `TaskPage.tsx:14-57`; `work.ts:20,55-58` | **FIX** |
| Approval Inbox `/approvals` | `ApprovalInboxPage`; GET list + approve POST | `ApprovalInboxPage.tsx:75-134`; `approvals.ts:10-25`; remediation tests assert approve-only behavior | **CONTRACT_MISMATCH** |
| Execution `/execution` | `ExecutionPage`; GET queue + run cancel POST | `ExecutionPage.tsx:40-104`; `runs.ts:30-31,121-124`; operations test asserts exact wait reason | **FIX** |
| Agent Run `/runs/:id` | `AgentRunPage`; safe GET detail + cancel POST | `AgentRunPage.tsx:30-96`; `runs.ts:89-124`; operations test asserts supported projection only | **CONTRACT_MISMATCH** |
| Usage `/usage` | `UsagePage`; `GET /usage`; usage hierarchy response | `UsagePage.tsx:25-76`; `usage.ts:10-28` | **FIX** |
| Settings `/settings` | `SettingsPage`; `GET /settings`; effective hierarchy/security response | `SettingsPage.tsx:24-76`; `settings.ts:11-47` | **CONTRACT_MISMATCH** |
| Project Onboarding `/projects/new` | `ProjectOnboardingPage` with empty `id`; backend discover + onboarding record/approval/activation endpoints | `AppShell.tsx:12-17`; `router.tsx:18,70-73`; `ProjectOnboardingPage.tsx:32-108`; `onboarding.ts:40-108` | **MISSING_UI** |

### Screen evidence and gaps

1. **Dashboard — FIX.** The page reads the authoritative projection through `useQuery` and has independent loading/error/empty/retry states for dashboard and queue (`DashboardPage.tsx`), so the route/data foundation is retainable. Stage A1 links returned project/work/run/queue IDs and removes unsupported Coordinator Chat, Pause All, and New Request surfaces. Appendix A actions remain absent until evidenced contracts exist; mutation UI and full browser flow coverage remain later-stage work.

2. **Project View — FIX.** Backend projection includes project, Git, epics, tasks, approvals, blockers, events, and usage (`packages/contracts/src/api.ts:46-55`), and the page now consumes it through `useQuery` with explicit loading/error/not-found/retry states. Returned epics/tasks are encoded links; unsupported Overview/Epics/Tasks/Runs/Git/Guidelines/Usage tab controls and creation forms remain absent until evidenced contracts are scoped.

3. **Epic View — FIX.** `EpicProjection` returns lifecycle, tasks, approvals, blockers, events, usage and Git (`epic-projection.ts:11-27`), and `EpicPage` now uses the shared query lifecycle with explicit loading/error/not-found/empty states. The approved parallel graph, review/QA/merge affordances, and navigable children remain absent; backend epic planning/approve-run endpoints exist in `epics.ts:21-58`, but no mutation is invented here.

4. **Task View — FIX.** `TaskOverviewProjection` is a suitable read foundation and `WorkflowTimeline` preserves exceptional lifecycle states (`WorkflowTimeline.tsx:7-39`). `TaskPage` now uses the shared query lifecycle with explicit loading/error/not-found/empty states, but still has no pause, dispatch, dependency management, approval detail, or final-merge action. Backend exposes pause (`work.ts:56-58`), dispatch (`runs.ts:32-87`), dependencies (`dependencies.ts:27-66`), and final merge (`final-merge.ts:49-104`); absence is a UI wiring gap, not permission to invent alternate actions.

5. **Approval Inbox — CONTRACT_MISMATCH.** Current UI correctly maps snake_case/uppercase server rows (`ApprovalInboxPage.tsx:49-65`) and only renders an approve button because that is the evidenced mutation (`:95-121`; `approvals.ts:15-25`). Appendix A requires approve/reject/request changes with evidence/detail. The backend route surface shown in this checkout provides approve only, so the approved UX and current contract are not equivalent. Recovery must either add an approved backend contract in a later scope decision or explicitly narrow the V1 approval contract; this audit does not implement either.

6. **Execution Queue — FIX.** Current page is the strongest functional surface: it renders running/waiting/blocked rows, exact scheduler reason code/message, refresh, cancel, empty, and error states (`ExecutionPage.tsx:67-104`). It still lacks scheduler capacity, resource locks, pause/stop-all controls and links to Task/Run detail required by Appendix A. Existing tests prove reason fidelity but not browser navigation or mutation persistence.

7. **Agent Run Detail — CONTRACT_MISMATCH.** The current route deliberately uses the supported safe run projection and cancel endpoint (`AgentRunPage.tsx:30-96`); the test explicitly verifies that unavailable subresources are not requested (`operations-views.test.tsx`). Appendix A requires live observable events, sanitized terminal output, permission decisions, session/attempt/resume, recovery/loop signals, context package and checkpoint controls. The backend `GET /runs/:id` response in `runs.ts:89-119` exposes only metadata/usage. `SanitizedTerminal` exists but is unused. This is a backend/UI contract gap, not a reason to expose hidden model reasoning or raw artifacts.

8. **Usage — FIX.** `GET /usage` and the page's global/project/epic/task totals are real and typed locally (`UsagePage.tsx:4-16`; `usage.ts:10-28`). The approved screen also needs attributable run history, budget/reservation states, effective limits, and actionable hard-limit/wait explanations. Current UI is read-only text with no project context selector, drill-down links, or explicit stale-reservation/debt presentation. No missing endpoint is asserted beyond what the current route response proves.

9. **Settings — CONTRACT_MISMATCH.** The page reads effective hierarchy and security settings, including the Local Mode warning (`SettingsPage.tsx:24-76`), which is valuable and must be retained. Appendix A requires project configuration editing/validation/persistence; current page has no inputs or mutations. Backend exposes `GET /settings` only for this page (`settings.ts:11-47`); scheduler config PUT is a separate route and is not a complete project settings contract. Recovery must not fake editability with client-only state.

10. **Project Onboarding — MISSING_UI.** The page preserves DETECTED vs PROPOSED separation and fails closed for empty `id` (`ProjectOnboardingPage.tsx:32-108`), but the shell links `/projects/new`, which supplies no id and cannot call `POST /onboarding/discover`. The backend already has discovery, semantic approval request, approve, and activation (`onboarding.ts:40-108`). Thus the required flow is not represented in the UI at all; the missing surface includes repository path input, discovery result, proposal review, approval action, activation action, and status refresh.

## Functional Flow Matrix

| Flow | Backend evidence | UI evidence | Result |
|---|---|---|---|
| Onboarding Repository → Discovery → Review → Approve → Activate | `onboarding.ts:40-108` | `/projects/new` has no form/action; only existing-record read view | **MISSING_UI** |
| Standalone Task create → development → review → QA → integration → approval | task create/dispatch/final-merge routes exist (`work.ts`, `runs.ts`, `final-merge.ts`) | no create/dispatch/pause/final-merge controls on Project/Task | **MISSING_UI / FIX** |
| Epic project → child tasks → review/QA/integration/merge | epic projections and planning routes exist | Epic page has list/counts only; no graph or stage controls | **FIX** |
| Approval request → evidence → approve/reject/changes | list + approve only | approve only; no detail/reject/change contract | **CONTRACT_MISMATCH** |
| Queue → running/waiting/blocked reason → cancel | execution projection + cancel | core read/cancel works by source tests; no links/capacity/stop-all | **FIX** |
| Run → events/logs/permissions/usage/recovery | current run GET only metadata/usage | no event/log/permission/recovery UI | **CONTRACT_MISMATCH** |
| Settings read → edit → validate → persist | settings GET; scheduler config PUT is separate | read-only raw JSON | **CONTRACT_MISMATCH** |

## KEEP

- React/Vite/TypeScript and React Router route skeleton.
- Backend read projections and shared projection contracts; they are the authoritative data boundary.
- Session bootstrap/reload model in `api/client.ts` and `App.tsx`.
- SSE client principle: events trigger refetch; events are not authoritative state.
- Exact scheduler wait reason display in Execution.
- DETECTED/PROPOSED onboarding separation and fail-closed activation messaging.
- Terminal sanitization implementation and tests, pending a real supported log contract.

## FIX

- Introduce shell-level detail navigation, breadcrumbs, route-level 404/error boundaries, and action feedback.
- Replace plain Project/Epic/Task text summaries with linked, structured sections while preserving projection contracts.
- Add UI for backend-supported task/project/epic/run operations only after mapping each action to its existing policy-checked endpoint.
- Extend shared query/mutation/refetch state and consistent loading/error/empty behavior to the remaining pages.
- Add usage drill-down and budget/wait/reservation presentation from an explicit backend response.
- Add responsive table/list navigation and accessible status/action semantics.

## MISSING UI

- Onboarding start/discovery and the complete approval/activation progression.
- Project creation and work creation surfaces, if those are part of the approved V1 user flow.
- Epic/Task/Run detail navigation and links from detail/operational screens; Dashboard and Project returned-ID links are covered by the Stage A1/Stage B pilot.
- Dashboard request and pause controls once their authoritative contracts are confirmed.

## CONTRACT_MISMATCH

- Approval Inbox design asks for decisions beyond the current approve-only backend route.
- Agent Run design asks for observable events/logs/permissions/recovery/checkpoints not present in the current run response/routes.
- Settings design asks for editable project configuration while the screen/backend pair is GET-only.

## Cross-Cutting Problems

- **Application shell/navigation:** persistent shell, breadcrumbs, route boundaries, and Dashboard context links now exist; detail-page composition and the `/projects/new` onboarding flow remain incomplete.
- **Data fetching/cache:** a shared query store and React adapter now exist and are used by all migrated read screens, including Usage and Settings; onboarding remains outside the migration and SSE key invalidation is not wired to all consumers.
- **Mutations:** a typed local mutation lifecycle primitive now backs approve and cancel; pending/disabled/dedupe/error/authoritative-refetch behavior is covered locally, while broader mutation flows and durable notifications remain pending.
- **Loading/error/empty:** basic states exist on newer operations pages; older detail/config pages mix raw “Loading…” and `Error:` text and lack retry in some paths.
- **Forms/validation:** no UI forms for onboarding, settings, task/epic/project creation, dispatch, dependencies, or approval notes.
- **Notifications:** only inline alerts; no durable success/conflict feedback pattern.
- **Tables/lists:** queue is a real table; most domain collections are unlinked lists or counts.
- **Status visualization:** raw uppercase statuses dominate; `StatusBadge` is unused and lifecycle is only reusable on Task.
- **Accessibility:** focus-visible basics exist, but action names, table navigation, status semantics and responsive detail navigation need acceptance tests.
- **Responsiveness:** CSS has 700px/960px breakpoints; queue has horizontal scrolling, but all 10 screen compositions are not verified at small widths.
- **Testability:** component tests cover selected contracts, but no matrix-wide route/API tests or full flow tests cover all 10 screens.

## Backend Gaps

Only proven gaps are recorded: the current approval route surface exposes approve but not reject/request-changes; the current run detail response exposes no logs/events/permission/recovery/checkpoint data; settings is GET-only for the page. The audit does not infer that new endpoints should be invented. Any addition must be separately approved against v1 scope and the deterministic Action Gateway/approval model.

## Recommended Rewrite Boundary

- Retain: `apps/web/src/app/router.tsx`, session bootstrap in `App.tsx`/`api/client.ts`, SSE transport, feature-to-projection mapping, `WorkflowTimeline`, `SanitizedTerminal`, and server read models/contracts.
- Refactor: `AppShell`, API client around typed endpoint definitions, shared page states/actions, Dashboard, Project, Epic, Task, Execution, Usage, Settings, and onboarding composition.
- Rewrite within existing stack: approval/run detail surfaces only after their backend contracts are explicit; do not expose unsupported actions or hidden chain-of-thought.
- Delete only after implementation proves no consumer remains: unused `StatusBadge`, dead `projectId` prop, and `SanitizedTerminal` if no supported log surface is approved.

## Required Implementation Stages

1. **A — Shell and primitives:** route error/404 boundaries, context navigation, page-state/action/status primitives, accessibility baseline. Depends on current router/CSS; no backend contract changes.
2. **B — API/query/mutation foundation:** typed paths (including currently omitted runs/usage/settings/onboarding/events), request cancellation, cache/refetch/invalidation, mutation pending/error/success handling. Preserve `/api/v1`, session, CSRF, SSE semantics.
3. **C — Onboarding + Dashboard + Project:** expose only existing onboarding/project contracts; link dashboard/project/work items; add no invented Pause All/New Request endpoint.
4. **D — Task + Epic + Approval:** compose projections, lifecycle/stage views, linked child work, and only policy-backed mutations. Resolve the approval approve/reject/request-changes contract mismatch before implementation claims full V1.
5. **E — Queue + Run + Usage + Settings:** retain exact scheduler reasons; add supported links/cancel; define contracts for run observability and settings editing before wiring UI; add usage drill-down only to returned data.
6. **F — Browser verification and cleanup:** route direct-load/reload/navigation/error/empty/mutation checks for all 10 screens, then remove unused code only with passing consumer/test evidence. A bounded route/empty/not-found smoke slice now exists; the full matrix, populated fixtures, mutations and responsive/accessibility evidence remain future work.

## Audit Limitations

- The bounded Playwright harness was run successfully, but no long-running browser session or full Stage F matrix was executed.
- No production files, backend data, endpoints, or configuration were changed.
- Static source and existing tests establish route/contract evidence; they do not prove current live browser behavior for every screen.
