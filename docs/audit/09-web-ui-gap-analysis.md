---
id: audit-09
status: superseded
kind: audit
title: Gap Analysis Web UI
date: 2026-09-23
---

# Ebb Orchestrator — Gap Analysis Web UI

## Verdict

Текущий Web UI — рабочий read-only/control-plane skeleton на правильном React/Vite/React Router stack, но не завершённый V1 product surface. Browser shell, session restore, empty/error projections и cancel/approve happy paths частично доказаны E2E. Полные approved V1 flows не замыкаются: onboarding не имеет discovery/select entry point, settings не редактируются, approvals поддерживают только approve, а task/epic/project creation и workflow transitions не подключены. Рекомендуется staged recovery на текущем stack; backend contracts расширять только отдельными доказанными gaps.

## Baseline

- Реальный stack и source map: [`web-ui-code-map.md`](./08-web-ui-code-map.md).
- `pnpm lint` и root `pnpm typecheck` прошли.
- `pnpm --filter @ebb-orchestrator/web test:e2e` прошёл: 3/3 Playwright tests; browser harness запустил реальный backend и Vite proxy, проверил shell, reload, missing/empty/error pages.
- Unit/test/build baseline красный по pre-existing deletion `apps/web/test/setup.ts`; server suite дополнительно имеет Windows/git-worktree failure. Audit не маскирует эти failures.

## Approved V1 Screens

| Экран | Required data/actions | Route / consumer | Backend | Browser | Tests | Решение |
|---|---|---|---|---|---|---|
| Dashboard | agents, work, approvals, spend, projects, queue; Pause All/New Request | `/`, `DashboardPage` | `/dashboard`, `/execution` | Да: empty/error/link states | Да, E2E + component | FIX |
| Project View | repo/GitHub, work, settings, activity, budget, coordinator | `/projects/:id`, `ProjectPage` | `/projects/:id` | Да: missing route проверен; populated navigation не доказана | Component | FIX |
| Epic View | lifecycle, child tasks, review/QA/integration/merge, blockers | `/epics/:id`, `EpicPage` | `/epics/:id`, planning routes | Да: missing route проверен | Component | FIX |
| Task View | contract/workflow/runs/findings/QA/Git/recovery/usage/deps/events | `/tasks/:id`, `TaskPage` | `/tasks/:id`, dependencies, pause/dispatch | Да: missing route проверен | Component | FIX |
| Approval Inbox | detail/evidence, approve/reject/request changes, scope | `/approvals`, `ApprovalInboxPage` | GET approvals, POST approve | Да: empty state; pending action not E2E | Component | CONTRACT_MISMATCH |
| Execution Queue / Agents Monitor | queue, running/blocked/waiting reason, pause/cancel | `/execution`, `ExecutionPage` | GET execution, cancel run; scheduler config separate | Да: empty state; cancel only code/component | Component + E2E empty | FIX |
| Agent Run Detail / Live Logs | events, tools, logs, permissions, usage, recovery | `/runs/:id`, `AgentRunPage` | GET run, cancel, SSE | Да: missing/error + Retry | Component + E2E error | REWRITE |
| Usage & Budget | tokens/cache/cost/context/recovery/effective cost; limits | `/usage`, `UsagePage` | GET usage | Да: empty state | Component + E2E empty | MISSING_UI |
| Settings / Project Configuration | effective config, edits, validation, persistence | `/settings`, `SettingsPage` | GET settings; scheduler PUT exists | Да: read-only/unavailable | Component + E2E | MISSING_UI |
| Project Onboarding | repository→discovery→review→approval→activate | `/projects/new`, onboarding page | discover/get/approval/approve/activate | Да: empty guard only; no discovery | Component + E2E empty | MISSING_UI |

KEEP разрешён только для shell/session/error primitives and E2E harness behavior, not for a whole approved screen without populated browser evidence and end-to-end tests.

## Route Matrix

| Route | Direct navigation | Reload | Loading | Empty | Error | Data wiring | Primary gap |
|---|---|---|---|---|---|---|---|
| `/` | verified | verified via session reload | inline text | verified | retry exists | dashboard + execution GET | no Pause All/New Request |
| `/projects/:id` | missing id verified | router works | query branch | projection branch | inline Retry | project projection | no project list/create/config tabs |
| `/epics/:id` | missing id verified | router works | query branch | tasks empty | inline Retry | epic projection | no create/run/review/merge actions |
| `/tasks/:id` | missing id verified | router works | query branch | runs/findings empty | inline Retry | task projection | no dispatch/pause/action workflow UI |
| `/approvals` | verified | shell preserves route | loading text | verified | Retry | GET + approve | no reject/request changes/detail evidence |
| `/execution` | verified | route works | projection branch | verified | Retry | GET + cancel | no pause-all; no explicit waiting/blocked action model |
| `/runs/:id` | missing id verified | route works | query branch | n/a | verified | GET + cancel | logs/events/permissions/recovery not rendered |
| `/usage` | verified | route works | query branch | verified | Retry | GET | metrics/budget controls absent |
| `/settings` | verified | route works | query branch | unavailable fields | Retry | GET | read-only, no supported edit mutation |
| `/projects/new` | verified | route works | verified for id case | verified no-id guard | local error branch | GET only when id supplied | no discovery/select route or form |

## Functional Flow Matrix

| Flow | Current evidence | Classification |
|---|---|---|
| Repository→Discovery→Review→Approve Config→Activate | Backend has `POST /onboarding/discover`, get, approval, approve, activate; `/projects/new` has no discovery input and refuses to guess id | backend supports; UI missing entry/mutations |
| Standalone Task create→development→review→QA→integration→approval | Backend has create/dispatch/pause and task projection; UI only reads task and links runs | partial backend, state not exposed as UI actions |
| Epic project→child tasks→review→QA→integration→final merge approval | Backend epic planning/final merge routes exist; UI renders projection only | partial backend, UI missing mutation flow |
| Approval request→evidence→approve/reject/request changes→persist | GET + approve wired; current route/component lacks reject/request-changes contracts and evidence detail | contract mismatch |
| Queue→running/blocked/waiting→pause/cancel | execution projection and cancel wired; pause-all absent; reason display exists for rows | partial UI |
| Run→events/tools/logs/permissions/usage/recovery | GET run and cancel wired; `SanitizedTerminal` exists but run page does not render event/tool/permission/recovery panels | UI missing data presentation |
| Effective config→edit→validation→persist | GET settings is intentionally read-only; scheduler PUT backend exists but no form | backend capability not connected |

## Browser Findings

| ID | Route/action | Expected | Actual | Evidence | Severity |
|---|---|---|---|---|---|
| B-01 | `/projects/new`, open Projects | Start project onboarding/discovery | Navigation lands on an empty guard: “Select a project…”; no repository input or discovery action | Playwright `v1-ui.spec.ts` assertion; `ProjectOnboardingPage.tsx:48-53` | Critical |
| B-02 | Dashboard primary actions | Pause All and New Request from approved Appendix A | No such controls in `DashboardPage`; only links/retry | `DashboardPage.tsx:37-46`; E2E checks only shell/empty data | Important |
| B-03 | `/approvals`, pending approval | Approve/reject/request changes with evidence | Only Approve button is rendered; empty browser fixture cannot exercise it | `ApprovalInboxPage.tsx:103-110`; backend `approvals.ts` only approve route | Critical |
| B-04 | `/settings`, edit configuration | Edit supported values, validate and persist | Page explicitly renders read-only projection and “Unavailable” project overrides; no form/mutation | Playwright assertion; `SettingsPage.tsx:28-54`; backend `scheduler.ts` has PUT | Important |
| B-05 | `/runs/:id`, active run detail | logs, tools, permission decisions, recovery | Current view shows metadata/timing/usage and cancel; no live event/log/permission/recovery sections | `AgentRunPage.tsx:61-85`; `SanitizedTerminal` not consumed there | Important |
| B-06 | Shell navigation, Projects | project list and project-scoped navigation | “Projects” points only to `/projects/new`; no project index route | `AppShell.tsx` nav; router has no `/projects` collection route | Important |
| B-07 | Any route with live events | listener lifecycle should be bounded to mounted consumer | Current pre-existing `EventClient.onInvalidate` has no unsubscribe and hook cleanup is comment-only | `events.ts`, `useEventClient.ts` diff | Important, subject to pre-existing change |

## KEEP

- Current React/Vite/Router stack and contract package integration.
- Local session bootstrap/restore boundary: HttpOnly cookie + in-memory tokens; browser E2E proves reload restore.
- Backend-provided projection model and SSE-as-invalidation approach.
- App shell as a starting point, `PageState`/`StatusBadge`/`WorkflowTimeline`/sanitized output primitives after consolidation.
- E2E harness with real backend, Vite proxy, isolated home and teardown verification.

## FIX

- Shared route metadata/nav and project index entry.
- Query/mutation/invalidation ownership and listener unsubscribe.
- Consistent page state components, status labels, error messages, and action capability rendering.
- Dashboard primary actions once backend-supported semantics are exposed.
- Queue/run cancel feedback and approval mutation feedback.
- Responsive shell and accessible semantic tables/actions.

## REWRITE

- `apps/web/src/app/router.tsx` + `components/AppShell.tsx` navigation composition.
- `features/runs/AgentRunPage.tsx` as a composed run detail with event/log/permission/recovery sections.
- Cross-feature repeated projection/query/mutation patterns, preferably through small feature adapters rather than a new framework.

## MISSING UI

- Project collection/discovery selection.
- Onboarding mutation form and step states.
- Settings/configuration forms and validation/persistence UI.
- Usage budget limits and recovery/effective-cost presentation.
- Approval reject/request-changes/evidence detail.
- Dashboard New Request/Pause All where backend capability is available.
- Run live event/tool/permission/recovery panels.

## MISSING BACKEND

- Нет GET project collection/list read endpoint: `projectsCollection` есть в contracts, но `projects.ts` реализует POST collection и GET by id.
- Approval HTTP route публикует только list pending и approve; domain service имеет reject/getById, но соответствующих HTTP decisions для reject/request-changes нет.
- Run HTTP projection не публикует events, tool calls, permission decisions, recovery/checkpoints или logs; текущий UI не может отобразить их без отдельного read-model contract.
- Нет HTTP contract для `Pause All`/`Stop All Agents`, capacity/locks/scheduler events, несмотря на expectations Appendix A.
- Final merge route существует, но не представлен в `packages/contracts/src/api.ts` и Web UI.

Эти gaps не реализуются в рамках audit/design этапа: для них нужны отдельные contract/architecture decisions.

## CONTRACT MISMATCH

- Appendix A requires approval decisions beyond approve; current `packages/contracts/src/api.ts` and `apps/server/src/app/routes/approvals.ts` expose only approve mutation.
- Appendix A requires onboarding start/discovery from Projects; current UI route cannot call the existing discover endpoint because it has no repository input/select state.
- Appendix A requires editable configuration; current Settings contract is read-only while scheduler config PUT is separate and not represented in Web UI.

## DEAD CODE

- `authenticatedHeaders()` is unreferenced after the current SSE change.
- `ApprovalInboxPage` accepts and discards `projectId`; no project-scoped route consumes it.
- Do not delete either in this audit commit because the first is inside a pre-existing uncommitted change and the second may be an intentional future boundary; classify for cleanup stage.

## Cross-Cutting Problems

- application shell/navigation: no project index; contextual routes are hidden from primary nav; breadcrumb wrapper class is duplicated.
- data fetching/cache: every page owns a fresh query store; no shared cache/invalidation policy; SSE listener cleanup is incomplete in current diff.
- mutations: local one-off mutation stores; capability/allowed action metadata is not standardized; errors are caught and discarded after local rendering.
- loading/error/empty states: inconsistent copy/markup and some pages use raw `<div>`/`<p>` instead of shared primitives.
- forms/validation: no onboarding/settings/task/epic forms; no browser validation flow.
- notifications: no durable success/toast/announcement pattern after mutations.
- tables/lists: execution table exists, but dashboard/project/approval lists lack consistent row/action patterns.
- status visualization: canonical backend status is often rendered as raw code text; status mapping/semantic labels are not centralized.
- accessibility: some `role=status` regions and labels exist, but focus/error announcement, table headers/actions and keyboard flow need an explicit baseline.
- responsiveness: CSS has a mobile breakpoint, but the route/action matrix has no browser viewport acceptance coverage.
- testability: unit suites are currently un-runnable because setup file is missing; E2E covers mostly empty/error states and not mutation persistence.

## Backend Gaps

Только доказанные: approval backend route/contract currently has approve only, while Appendix A expects reject/request-changes. Everything else is a UI exposure/wiring gap until a concrete read-model or mutation absence is demonstrated.

## Recommended Rewrite Boundary

RETAIN `apps/web/src/api/client.ts`, `packages/contracts/src/api.ts`, E2E harness, styles as a base, and backend routes/read models. REFACTOR `app/router.tsx`, `components/AppShell.tsx`, `state/*`, `hooks/useEventClient.ts`, shared state primitives. REWRITE feature composition for onboarding, approvals, run detail and configuration forms. DELETE only confirmed unused code in a later cleanup after the pre-existing diff is reconciled.

## Required Implementation Stages

1. **A — Shell + primitives:** route metadata, project index entry, nav/breadcrumb, shared PageState/Action/Status/Form primitives; no backend contract changes.
2. **B — API/query/mutation foundation:** typed feature adapters, shared cache/invalidation, bounded SSE subscriptions, capability/error normalization; preserve backend authority.
3. **C — Onboarding + Dashboard + Project:** discovery/select/review actions against existing endpoints, dashboard/project composition and empty/error/persistence tests.
4. **D — Task + Epic + Approval:** lifecycle/action surfaces; approval contract decision required before implementing reject/request changes.
5. **E — Queue + Run + Usage + Settings:** queue actions, run evidence/live projections, usage/budget read model, settings form only for supported scheduler mutation.
6. **F — Browser E2E + cleanup:** route direct/reload/viewport/action/persistence coverage, remove proven dead code, restore green web test setup, then full gates.

## Evidence Boundary

Browser evidence is from the repository Playwright harness, not an external production instance. No live GitHub, real repository onboarding, real agent run, merge, or external secret store was exercised.
