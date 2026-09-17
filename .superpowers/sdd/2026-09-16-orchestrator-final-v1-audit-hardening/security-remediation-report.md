# Security remediation report

## Scope
Remediated SEC-001, SEC-002, SEC-004, EXEC-005, and GIT-007 only. SEC-003, GIT-006, and GIT-008 were not changed.

## Changed files
- `apps/server/src/modules/execution/git-tools.ts`: replaced shell-interpolated Git execution with argv-based `GitCli`; `add` uses `--`, commit messages remain one argv element, managed commits use `--no-verify`.
- `apps/server/src/modules/git/git-cli.ts`: bounded Git execution and shared Git ref validation.
- `apps/server/src/modules/git/git-reconciler.ts`: validates branch refs and uses Git end-of-options protection.
- `apps/server/src/modules/git/branch-manager.ts`: validates base refs before branch creation.
- `apps/server/src/platform/security/path-resolver.ts`: resolves the nearest existing ancestor with realpath before appending non-existing suffixes; rejects symlink escapes while allowing new in-workspace paths.
- `apps/server/src/modules/execution/command-tools.ts`: reuses `ProcessExecutor` for shell-disabled bounded timeout/output execution while preserving `ExecResult`.
- `apps/server/src/platform/process/process-executor.ts`: waits for child close before rejecting output-bound failures so cancellation cannot leak a running child.
- Added regression tests in `apps/server/test/modules/execution/security-remediation.test.ts` and `security-execution-path.test.ts`.

## Verification
- Focused security/Git/execution/path tests: `6 passed, 40 passed`.
- Server full test suite: `60 passed, 602 passed, 2 skipped`.
- Server typecheck: passed (`tsc -p tsconfig.json --noEmit`).
- Root lint: passed (`eslint .`).
- Targeted lint: passed.

## Remaining concerns
- Hook suppression intentionally uses Git's `--no-verify` policy for managed commits; hooks remain enabled for ordinary user Git operations.
- Windows junction-specific regression remains guarded by the existing platform test; Unix symlink coverage executes on Unix only.
- Existing compatibility behavior retains lexical resolution for entirely virtual/nonexistent workspace roots; existing real workspace roots use fail-closed ancestor realpath containment.
