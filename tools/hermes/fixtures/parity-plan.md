# Hermes Development Workflow Parity Plan

## Goal

Prove that Hermes can execute an Ebb repository plan end-to-end without OpenCode.

## Hard rules

- Read `.hermes.md`.
- Use no more than two concurrent subagents.
- No nested delegation.
- Do not modify production code.
- Do not merge/push/tag/release.

## Task 1 — Independent context checks

Launch exactly two read-only subagents concurrently.

Subagent A verifies:
- `.hermes.md` is loaded/consistent;
- `master` is documented as primary branch;
- Russian JSDoc rule is present;
- no-more-than-two rule is present.

Subagent B verifies:
- `tools/hermes/skills/` has the expected four source skills;
- active Hermes config has concurrency=2, depth=1, orchestrator disabled, child worktree isolation disabled.

Both return evidence only.

## Task 2 — Repository verification

Run:
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `git diff --check`

Do not modify code to make failures disappear.
If a baseline project failure exists, report it precisely.

## Task 3 — Write parity report

Create/update `docs/audit/hermes-development-workflow-parity.md`.

Include date, branch, HEAD, context verification, subagent concurrency evidence, delegation config, commands/results, final verdict `PASS` or `FAIL`.

Do not commit unless all project-controlled gates pass.

## Task 4 — Commit

If and only if verdict is PASS:

`git add docs/audit/hermes-development-workflow-parity.md`

Inspect staged diff.

Commit:

`docs: verify Hermes development workflow parity`

Do not include unrelated files.
