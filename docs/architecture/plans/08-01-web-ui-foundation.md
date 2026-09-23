---
id: plan-08-01
title: Plan Document
status: superseded
created: 2026-09-23
---

# Web UI Recovery Stage A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Привести application shell и shared UI primitives к единому доступному V1 foundation без изменения backend contracts, session security или workflow semantics.

**Architecture:** Сохраняем React 19 + Vite 8 + React Router 7 и текущий `Outlet`-based shell. Route metadata и shared primitives отделяются от feature transport/state; backend capabilities остаются единственным источником разрешённых действий. Stage A не добавляет fake project list или неподдержанные кнопки.

**Tech Stack:** React, TypeScript, React Router 7, Vite, Vitest, Testing Library, Playwright, существующий CSS без нового UI framework.

**Spec:** `docs/architecture/specs/02-web-ui-recovery-design.md`

## Global Constraints

- Не менять backend contracts, persistence, workflow transitions, permissions, approval authority, Git или scheduler policy.
- Не добавлять post-v1 scope и fake controls.
- Сохранять same-origin HttpOnly session, in-memory bearer и CSRF semantics.
- Все production comments/JSDoc, которые добавляются или изменяются, писать на русском языке.
- Не включать pre-existing изменения в `apps/web/src/api/events.ts`, `apps/web/src/hooks/useEventClient.ts` и deletion `apps/web/test/setup.ts` в этот plan.
- Проверять `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @ebb-orchestrator/web build`, relevant E2E и `git diff --check`.

## Review Focus

- Direct navigation/reload to every current route must keep the shell and route error boundary usable.
- Unknown/untrusted path segments must not become unsafe breadcrumb markup or crash rendering.
- Loading, empty, error and not-found states must have distinct accessible semantics and retry/back actions.
- Narrow viewport navigation must remain keyboard reachable without inventing a mobile-only security boundary.
- Shared primitive adoption must not hide backend error/status codes or create optimistic domain transitions.

## Files and responsibilities

- Modify `apps/web/src/app/router.tsx`: route metadata/error boundary only; preserve existing route identities.
- Modify `apps/web/src/components/AppShell.tsx`: shell/nav/breadcrumb composition; remove layout nesting defect.
- Modify `apps/web/src/components/PageState.tsx`: canonical page-state primitives; remove duplicate status implementation.
- Modify `apps/web/src/components/StatusBadge.tsx`: canonical status presentation and accessible text.
- Modify `apps/web/src/styles/base.css`: shell, focus, narrow viewport and shared primitive styles only.
- Test `apps/web/test/app-shell.test.tsx`, `apps/web/test/core-views.test.tsx`, new `apps/web/test/shared-primitives.test.tsx`, and `apps/web/test/routing-bootstrap.test.ts`.
- Extend `apps/web/test/e2e/v1-ui.spec.ts` only with shell/direct-route/viewport assertions that do not require new backend capabilities.

## Task 1: Canonical shared state primitives

**Interfaces:** Existing feature pages may continue to render their current markup; new primitive exports are stable and presentation-only.

- [ ] Write a failing `shared-primitives.test.tsx` test for `PageState` variants: loading uses `role=status`, error uses `role=alert` plus retry, empty has an actionable optional slot, and not-found supports back navigation.
- [ ] Run `pnpm --filter @ebb-orchestrator/web test -- test/shared-primitives.test.tsx`; expect failure because the new assertions/exports are absent or inconsistent.
- [ ] Implement the minimum canonical `PageState`, `EmptyState`, `ErrorAlert`, `StatusBadge` behavior in the component files. Keep canonical raw status available through text/title and do not add domain mapping.
- [ ] Add a failing test that verifies `StatusBadge` renders label plus canonical status semantics without color-only meaning.
- [ ] Run the focused test and verify it passes.
- [ ] Run `pnpm --filter @ebb-orchestrator/web test -- test/shared-primitives.test.tsx test/core-views.test.tsx`; record any failure caused solely by the pre-existing missing test setup separately.

## Task 2: Repair shell composition and route metadata

**Interfaces:** `AppShell` continues to render the existing router `Outlet`; `router` keeps `/`, `/projects/:id`, `/epics/:id`, `/tasks/:id`, `/approvals`, `/execution`, `/runs/:id`, `/usage`, `/settings`, `/projects/new`, and wildcard routes.

- [ ] Write failing tests asserting that breadcrumbs are outside the main content outlet wrapper, route labels are stable, encoded identifiers render as text, and wildcard/error pages expose accessible retry/back links.
- [ ] Run the focused shell/routing tests and observe the expected failure against the current nested `.route-breadcrumbs` layout or missing route metadata.
- [ ] Implement route metadata and shell composition with one breadcrumb landmark, one main landmark, and preserved navigation links. Do not add a project list endpoint or fake project item.
- [ ] Add/adjust CSS only for the corrected shell structure, visible focus, horizontal narrow-nav behavior and primitive state layout.
- [ ] Run `pnpm --filter @ebb-orchestrator/web test -- test/app-shell.test.tsx test/routing-bootstrap.test.ts`; expect pass once setup is restored or use the focused non-jsdom route assertions available in the checkout.

## Task 3: Adopt primitives without changing feature behavior

**Interfaces:** Feature pages keep existing API calls and projection shapes; only repeated presentation markup moves to shared primitives.

- [ ] Write a failing component test for one loading/error/empty feature path that asserts the canonical primitive semantics while retaining the existing user-visible copy.
- [ ] Run the test and confirm it fails for the current page-local markup.
- [ ] Refactor only Dashboard, Project, Epic, Task, Approval, Execution, Run, Usage, Settings and Onboarding state wrappers to consume the canonical primitives where the existing state already exists.
- [ ] Do not add mutations, endpoint strings, capability inference or optimistic transitions.
- [ ] Run affected component tests and compare user-visible text/action counts with the baseline E2E expectations.

## Task 4: Browser foundation verification

- [ ] Extend the existing Playwright suite with direct navigation/reload assertions for the shell and one narrow viewport assertion for keyboard-reachable navigation.
- [ ] Run `pnpm --filter @ebb-orchestrator/web test:e2e`; expect the existing backend/Vite harness plus the new shell checks to pass.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm --filter @ebb-orchestrator/web build`, `pnpm test`, and `git diff --check`.
- [ ] If the pre-existing `apps/web/test/setup.ts` deletion still blocks web tests/build, do not repair it silently in Stage A; record it as a separate prerequisite and keep the failure evidence.

## Completion and commit

- Review the full diff and verify only Stage A files plus its tests changed.
- Commit locally with Russian message: `feat: укрепить foundation Web UI`.
- Do not push or merge.
- Stage B (API/query/mutation foundation) remains separate and starts only after Stage A review.
