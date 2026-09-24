# Task 10 Fix Report: no such column: epic_id

## Summary
Fixed the database schema defect in `autonomous-task.hermes.test.ts` that caused `no such column: epic_id` error.

## Changes Made

### File Modified: `apps/server/test/e2e/autonomous-task.hermes.test.ts`

**Issue**: The test created a simplified `tasks` table schema that was missing required columns including `epic_id`. The workflow engine and other components expect the full schema with `epic_id`, `display_id`, `title`, `required`, `created_at`, and `updated_at` columns.

**Fix**: Updated the migration SQL for version 2 (`002_work_domain`) to include all necessary columns:
- Added `epic_id TEXT`
- Added `display_id TEXT NOT NULL`
- Added `title TEXT NOT NULL`
- Added `required INTEGER NOT NULL DEFAULT 1`
- Added `created_at TEXT NOT NULL` and `updated_at TEXT NOT NULL`
- Updated status column with proper DEFAULT 'DRAFT' and CHECK constraint

Updated the INSERT statement to provide values for all required columns.

## Verification
The test now passes the database setup stage. The `no such column: epic_id` error is resolved.

Note: The test now has a different issue (workflow transition validation) which is unrelated to the database schema fix.
