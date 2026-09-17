# UI/API remediation report

## Scope

Remediated only confirmed findings F-002, F-003, and F-007. Architectural findings F-001, F-004, F-005, and F-006 were not changed.

## Changed files

- `apps/web/src/features/approvals/ApprovalInboxPage.tsx`
  - Consumes the server `{ approvals: ApprovalRow[] }` envelope.
  - Explicitly maps server snake_case fields and uppercase status values to the UI model.
  - Keeps only the authorized `POST /api/v1/approvals/:id/approve` mutation.
  - Shows approval load and mutation errors, each with a retry affordance where applicable.
- `apps/web/src/features/dashboard/DashboardPage.tsx`
  - Preserves explicit dashboard projection and execution queue error states with retry controls.
  - Avoids rendering empty projection data after a failed request.
  - Removes dead `Pause All` and `New Request` actions.
- `apps/web/src/api/client.ts`
  - Preserves a structured server `{ error: string }` message for failed responses.
  - Falls back to `API error: <status> <statusText>` for non-JSON responses.
- `apps/web/test/ui-api-remediation.test.tsx`
  - Adds focused regression coverage for envelope/field/status mapping, authorized mutation visibility, rejected approval loads, mutation failures, dashboard and queue failures, removed actions, and API error parsing.
- `apps/web/test/core-views.test.tsx`
  - Updates the dashboard action assertion to require the dead actions to remain unavailable.

## Verification

- Focused UI/API tests: `pnpm --filter @ebb-orchestrator/web test -- ui-api-remediation.test.tsx core-views.test.tsx` — 6 test files passed, 65 tests passed.
- Full web tests: `pnpm --filter @ebb-orchestrator/web test` — 6 test files passed, 65 tests passed.
- Web build: `pnpm --filter @ebb-orchestrator/web build` — TypeScript build and Vite production build passed; 39 modules transformed.
- Root typecheck: `pnpm typecheck` — contracts, testing, and server typechecks passed.
- Root lint: `pnpm lint` — ESLint passed with no output/errors.

## Remaining concerns

- Reject and request-changes remain intentionally unavailable because no corresponding authorized server endpoints exist in the v1 API.
- The pre-existing unrelated untracked file `docs/superpowers/plans/2026-09-16-orchestrator-final-v1-audit-hardening.md` was not modified or included.
