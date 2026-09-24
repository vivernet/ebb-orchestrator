---
id: audit-08
status: updated
kind: audit
title: Web 401 and Project Completion Evidence
date: 2026-09-24
---

# Ebb Orchestrator — Web 401 and Project Completion Evidence

## Task 10 Evidence Report

### Current Revision
- Branch: `develop`
- HEAD: `7ee0f64` (clean working tree)
- Date: 2026-09-24

### Tasks 1-7 Implementation Status

#### Task 1: DONE ✓
- Server startup fix (SIGINT/SIGTERM handling)
- `scripts/run-server.js` syntax fix applied
- Review PASS (pre-existing lint limitation recorded)

#### Task 2: DONE ✓
- Protected session plus public one-shot bootstrap
- `create-app.ts` implementation complete
- Review PASS (minor UI wiring gap deferred)

#### Task 3: DONE ✓
- Canonical host/proxy/origin verification
- Review PASS (minor Vite indentation deferred)

#### Task 4: DONE ✓
- Acquisition/readiness/cleanup lifecycle
- `main.ts` implementation complete
- Review PASS (controlled SIGINT limitation recorded)

#### Task 5: DONE ✓
- Append-only migrations and no runtime DDL
- `run-service.ts` implementation complete
- 25 migration files in place
- Transactional migration runner

#### Task 6: DONE ✓
- Typed command policy before spawn
- Execution/action registry interfaces implemented

#### Task 7: DONE ✓
- Terminal run immutability and conditional transition
- `resumeRun` validation for status/capability/attempt/result
- Terminal states (COMPLETED, FAILED, CANCELLED) immutable
- 6 new RED tests added covering transition matrix

### Build Evidence

`pnpm server:build`: **FAIL**
- `AgentRun.output` property undefined in contracts
- Blocking TypeScript error at line 324
- Contracts need `output?: string` field added

### Test Evidence

`pnpm test`: **PARTIAL PASS**
- contracts: 3/3 passed ✓
- web: 148/148 passed ✓
- server: 717/721 passed (4 failed)

#### Known Test Failures (4 total)

1. **test-origin.test.ts**: Bootstrap URL format mismatch
   - Expected: `http://127.0.0.1:3000/#ebb-bootstrap=`
   - Actual: HTML page content with `localhost:3000`

2. **mcp-server.test.ts**: 3 submit_result lifecycle failures
   - Expected: `RUN_ALREADY_COMPLETING` error code
   - Actual: `Tool calls are not allowed after submit_result has been called`

### Migration Integrity Evidence

- 25 migration files in `apps/server/src/platform/database/migrations/`
- Append-only SQL schema evolution
- Transactional migration runner in place
- Outbox events: `appendOutboxEvent()`

### Remaining Issues

1. **TypeScript Build Error**: `AgentRun.output` property missing from contracts
2. **test-origin.test.ts**: Bootstrap URL uses `localhost` instead of `127.0.0.1`
3. **mcp-server.test.ts**: Error message mismatch (not returning RUN_ALREADY_COMPLETING)
4. **Working tree**: Clean (committed), but build/test gates still failing

### Evidence Checklist

| Category | Status | Notes |
|----------|--------|-------|
| Build | ❌ FAIL | Contract error - missing `output` field |
| Tests | ⚠️ PARTIAL | 4 server tests failed |
| Migrations | ✅ OK | 25 files, append-only |
| Git State | ✅ CLEAN | Working tree committed |
| Tasks 1-7 | ✅ COMPLETE | All implemented |
| Task 8 (Web UI) | ⚠️ IN PROGRESS | Stage A1 complete |
| Task 9 (Parity) | ⚠️ IN PROGRESS | Requires API key |
| Task 10 (Audit) | ✅ IN PROGRESS | Current document |

### Files Modified for Evidence

- `docs/audit/08-web-401-and-project-completion-evidence.md` — this file
- `.superpowers/sdd/12-401-web-completion/progress.md` — task ledger
