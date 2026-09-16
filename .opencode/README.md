# OpenCode SDD configuration (V2)

Project-local OpenCode configuration for executing the approved implementation plans using a primary SDD coordinator and fresh implementation/review subagents.

## Agents
- `sdd-orchestrator`: primary coordinator; does not edit product code.
- `implementer`: implements exactly one plan task, tests and commits locally.
- `reviewer`: independent read-only task review.
- `final-reviewer`: independent read-only whole-branch review.

## Commands
- `/execute-plan <plan-path>`: start a plan in the current non-master worktree.
- `/resume-plan <plan-path>`: resume from the durable ledger.
- `/final-review <plan-path>`: run a whole-branch final review.

## Safety
- Do not run implementation directly on `master`.
- Subagents cannot push, merge, rebase, reset, clean worktrees, or access files outside the worktree.
- `.env` files are denied except `.env.example`.
- The implementation ledger is stored under `.opencode/state/` and is intentionally ignored by Git.

## Models
No model IDs are pinned here. Configure/provider-connect OpenCode first, run `opencode models`, then add explicit `model:` values per agent if desired.
