# Worktree safety checklist

- Detect linked worktree vs submodule before action.
- Never create a second worktree when current workspace is already isolated.
- Verify chosen project-local worktree directory is ignored.
- Record source branch, full pinned `develop_base_sha`, task branch and PR target `develop` explicitly for ordinary tasks; validate ancestry and ownership of an existing workspace before reuse.
- Do not create nested worktrees, silently reset/rebase a provided workspace, or use release-only `master` as an ordinary task base. An explicit published-release hotfix follows `ebb-release` and includes forward-port to `develop`.
- Run dependency/setup commands only from actual project manifests; avoid unnecessary reinstall when workspace shares generated caches by policy.
- Capture baseline test command/result before implementation.
- Worktree removal must run from outside removed directory.
- If removal reports untracked/modified files, inventory them and stop; never force-delete unknown-only copies.
- `git worktree prune` is cleanup after a proven removal, not permission to delete active worktrees.
