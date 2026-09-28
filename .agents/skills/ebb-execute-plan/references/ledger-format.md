# Execution ledger format

Store under the plan-owned Git metadata scratch path so it survives conversation compaction without polluting the worktree.

```markdown
# Ebb execution ledger — plan: <repo-relative plan path>
Base: <merge/base SHA>
Mode: SUBAGENT | INLINE

## Pre-flight
- Task 1 → Task 2: produces X / consumes X — OK
- Ruling: <finding> — <decision> — <evidence> — <risk if wrong>

## Tasks
- Task 1: DONE — commits <range> — tests <command/result> — review <verdict>
- Task 2: RUNNING — BASE <sha> — brief <artifact path>
```

After compaction/restart, ledger + Git history override conversational recollection. Never redispatch a task marked `DONE` unless its acceptance evidence was invalidated by later change.
