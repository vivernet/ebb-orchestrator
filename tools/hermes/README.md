# Hermes Development Tools

This directory contains canonical repository source for Ebb development skills.

## Structure

- `skills/` — Source SKILL.md files for Hermes Agent
  - `ebb-execute-plan/` — Coordinates plan execution with subagents
  - `ebb-implement-task/` — Implements single plan task
  - `ebb-review-task/` — Reviews completed task diff
  - `ebb-final-review/` — Performs final branch review
- `capabilities.yaml` — project-local development capabilities registry
- `providers/inception.yaml` — non-secret Inception Labs provider template
- `fixtures/` — Test fixtures and parity plans

## Usage

Installed copies in HERMES_HOME are generated/synchronized from these sources. Do not manually edit installed copies.

After changing skills, run:
```bash
pnpm hermes:setup
pnpm hermes:check
```

## Workflow

1. `pnpm hermes:setup` — Sync skills to HERMES_HOME and configure Hermes
2. `pnpm hermes:check` — Verify setup is correct
3. `pnpm hermes:provider -- inception` — Configure the explicit Inception alias
4. `pnpm hermes:smoke` — Run a bounded provider smoke from `scripts/hermes-provider-smoke.mjs`
5. `pnpm hermes:execute -- <plan>` — Execute a development plan

The provider smoke is deliberately isolated: it creates a disposable
`HERMES_HOME`, an empty temporary workspace and the synthetic prompt
`Reply with exactly: SMOKE_OK`. It uses an explicit environment allowlist,
passes the provider key only through the child environment, runs with
`shell:false`, captures no raw provider output, and reports only a fixed marker,
exit code, `redacted=true` and `cleanup_verified`. Temporary files are removed
after the bounded run. It does not receive a real worktree, plan, repository
files or the `mcp-orchestrator` toolset.

This smoke is not Hermes parity. A successful smoke proves only provider
reachability/auth and response handling; Stage 9 still requires an explicitly
authorized provider-backed run of the parity plan with its repository-context
and delegation checks, followed by a separate decision about `.opencode`.

The complete Russian catalog and installation locations are documented in
`docs/development/hermes-capabilities.md`. Provider credentials are always
external (`INCEPTION_API_KEY`) and are never copied into this repository.
