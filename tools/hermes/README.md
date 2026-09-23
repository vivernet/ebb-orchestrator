# Hermes Development Tools

This directory contains canonical repository source for Ebb development skills.

## Structure

- `skills/` — Source SKILL.md files for Hermes Agent
  - `ebb-execute-plan/` — Coordinates plan execution with subagents
  - `ebb-implement-task/` — Implements single plan task
  - `ebb-review-task/` — Reviews completed task diff
  - `ebb-final-review/` — Performs final branch review
- `fixtures/` — Test fixtures and parity plans

## Usage

Installed copies in HERMES_HOME are generated/synchronized from these sources. Do not manually edit installed copies.

After changing skills, run:
```bash
pnpm hermes:setup
pnpm hermes:check
```

## Workflow

1. `pnpm hermes:setup` — Sync skills to HERMES_HOME
2. `pnpm hermes:check` — Verify setup is correct
3. `pnpm hermes:execute -- <plan>` — Execute a development plan
