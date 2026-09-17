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
