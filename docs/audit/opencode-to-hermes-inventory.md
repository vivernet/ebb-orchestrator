# OpenCode → Hermes Development Workflow Inventory

## Baseline

- Branch: develop
- HEAD: 91c27aa docs: ренировать структуру документации
- Worktrees: 2 (master, develop)
- Untracked: 1 (docs/architecture/plans/2026-09-18-hermes-development-workflow-migration.md)

## Active OpenCode Files

### .opencode/opencode.jsonc
Purpose: Default agent configuration
- default_agent: sdd-orchestrator

### .opencode/README.md
Purpose: Configuration documentation
Type: ACTIVE_DOCUMENTATION

### .opencode/agents/sdd-orchestrator.md
Purpose: Plan coordinator (implements tasks, dispatches subagents)
Type: ACTIVE_CONFIG
- Permissions: edit on .opencode/state/**, read on *
- Subagents: implementer, reviewer, final-reviewer (allowed)
- Shell: git operations allowed

### .opencode/agents/implementer.md
Purpose: Implements single plan task
Type: ACTIVE_CONFIG
- Permissions: edit on *, subagent denied
- Shell: git, pnpm test/lint/typecheck/build allowed

### .opencode/agents/reviewer.md
Purpose: Independent task review
Type: ACTIVE_CONFIG
- Permissions: edit denied, read only
- Shell: git, pnpm verification allowed

### .opencode/agents/final-reviewer.md
Purpose: Whole-branch final review
Type: ACTIVE_CONFIG
- Permissions: edit denied, read only
- Shell: git, pnpm verification allowed

### .opencode/commands/execute-plan.md
Purpose: Start plan execution
Type: ACTIVE_CONFIG

### .opencode/commands/resume-plan.md
Purpose: Resume interrupted plan
Type: ACTIVE_CONFIG

### .opencode/commands/final-review.md
Purpose: Final review command
Type: ACTIVE_CONFIG

### .opencode/state/
Purpose: Plan ledger storage
Type: ACTIVE_CONFIG (gitignored)

## Behaviors To Preserve

1. **Plan execution flow**: Execute tasks in order from docs/architecture/plans/
2. **Subagent limit**: Max 2 concurrent subagents (enforced by policy)
3. **Review discipline**: implementer → reviewer → fix → re-review loop
4. **Final review**: Whole-branch review after all tasks complete
5. **Git policy**: No push/merge/rebase/reset/clean from agents
6. **Ledger**: Track progress in state files
7. **Security**: Deny .env access

## Behaviors To Drop

1. .opencode directory and its JSON/YAML configs
2. Agent definitions in .opencode/agents/
3. Command definitions in .opencode/commands/
4. Ledger files in .opencode/state/

## Repository Instructions To Move To .hermes.md

From AGENTS.md and README.md:
- Primary branch: master
- Work in non-master worktree/branch only
- Quality gates: pnpm lint, typecheck, test
- JSDoc policy: Russian comments for public APIs
- Subagent discipline: max 2 concurrent
- No push/merge without explicit human approval

## Behaviors To Move To Hermes Skills

1. **ebb-execute-plan**: Coordinate plan execution with subagents
2. **ebb-implement-task**: Implement single task with tests
3. **ebb-review-task**: Review task diff
4. **ebb-final-review**: Final branch review

## Package/Script References

From package.json:
- scripts: lint, test, typecheck, build
- No hermes:setup/execute/check scripts yet

## Documentation References

- docs/architecture/specs/2026-09-16-ebb-orchestrator-design.md
- AGENTS.md
- README.md
