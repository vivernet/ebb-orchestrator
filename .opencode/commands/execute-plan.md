---
description: Execute one approved implementation plan with implementer/reviewer subagents.
agent: sdd-orchestrator
subagent: false
---

Execute the approved implementation plan at:

`$ARGUMENTS`

Current branch:
!`git branch --show-current`

Current Git status:
!`git status --short`

Follow your SDD orchestration protocol exactly.

- Treat the specification referenced by the plan as authoritative.
- Do not implement code yourself.
- Use a fresh `implementer` for each plan task and an independent `reviewer` after every implementation/fix round.
- Maintain the plan ledger under `.opencode/state/` so execution can resume safely after interruption or context compaction.
- After all tasks pass, invoke `final-reviewer` for the entire branch.
- Never push, merge to `master`, publish, deploy, or start another plan.
- If the current branch is `master`, stop before implementation and tell me to create/enter an isolated implementation worktree.

Continue through routine task/review/fix loops without asking whether to proceed.
