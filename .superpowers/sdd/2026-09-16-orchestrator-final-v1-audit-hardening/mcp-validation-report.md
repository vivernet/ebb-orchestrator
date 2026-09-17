# MCP-001 remediation report

## Status

`ADDRESSED` — MCP tool arguments are validated at runtime against each registered tool's existing `inputSchema` before handler dispatch.

## Changes

- Added object-root validation, required-property checks, primitive/container type checks, and `additionalProperties: false` enforcement in `McpServer.callTool`.
- Invalid arguments return the existing `{ success: false, error }` tool result shape and cannot reach handlers.
- Added regression coverage for missing `path`, wrong `path`/`message`/`patches` types, missing `patches`, unexpected properties, and valid path/patch/message calls.
- No parked architecture findings were changed.

## Verification

- Focused MCP test: PASS — 1 file, 15 tests.
- Full server tests: PASS — 60 files, 612 passed, 2 skipped.
- Full typecheck: PASS — contracts, testing, and server packages.
- Lint: PASS.
- `git diff --check`: PASS.

## Files

- `apps/server/src/modules/execution/mcp/mcp-server.ts`
- `apps/server/test/modules/execution/mcp/mcp-server.test.ts`
- `.superpowers/sdd/2026-09-16-orchestrator-final-v1-audit-hardening/mcp-validation-report.md`

## Concerns

The declared `workspace.patch.patches` schema only specifies `type: array`; item-level shape validation is intentionally not added because it is not present in the existing `inputSchema`.

## HIGH item-level patch validation fix

### Status

`ADDRESSED` — `workspace.patch.patches` now declares and enforces item objects with required numeric `start`/`end`, string `content`, and no additional properties before handler dispatch.

### Changes

- Added recursive array/object schema support to MCP runtime argument validation.
- Added the complete `workspace.patch` patch-item schema and removed the handler's unsafe patch-array cast via type narrowing.
- Added regression coverage proving an invalid item is rejected without mutating the workspace, while a valid patch still mutates as before.
- No architecture findings were changed.

### Verification

- Focused MCP test: PASS.
- Full server tests: PASS.
- Typecheck: PASS.
- Lint: PASS.
