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

## Follow-up security task review closure

### Changed files
- `apps/server/src/platform/security/path-resolver.ts`: uses `lstat` so dangling symlink ancestors are not treated as missing; `realpath` failure is fail-closed while valid new in-workspace suffixes remain allowed.
- `apps/server/src/platform/process/process-executor.ts`: truncates each stdout/stderr chunk to the remaining per-stream limit before rejecting and killing the child.
- `apps/server/src/modules/execution/command-tools.ts`: adds compatible `AbortSignal` to `ExecOptions` and forwards it to `ProcessExecutor`.
- `apps/server/src/modules/git/git-cli.ts`: rejects Git ref violations including dot components, `.lock` components, and the lone `@` ref.
- `apps/server/src/modules/git/branch-manager.ts`: validates generated `epic/${epicId}` refs before Git execution.
- Regression tests cover dangling symlinks, cancellation forwarding, bounded output behavior, malformed refs, generated branch refs, shell-metacharacter commit messages, hook suppression, and `git add --` path separation.

### Verification commands and output
- `pnpm exec vitest run apps/server/test/modules/execution/security-execution-path.test.ts apps/server/test/modules/execution/security-remediation.test.ts apps/server/test/modules/git/worktree-manager.test.ts` — `Test Files 3 passed; Tests 20 passed`.
- `pnpm test` — `apps/server: Test Files 60 passed; Tests 608 passed | 2 skipped`; `apps/web: Test Files 6 passed; Tests 65 passed`; workspace completed successfully.
- `pnpm typecheck` — packages and server completed successfully.
- `pnpm lint` — `eslint .` completed successfully.

### Remaining concerns
- SEC-003, GIT-006, and GIT-008 remain intentionally out of scope.
- Windows junction coverage remains guarded by existing platform tests; dangling-symlink regression executes on Unix only.
- The pre-existing untracked plan file `docs/superpowers/plans/2026-09-16-orchestrator-final-v1-hardening.md` was not modified.

## Critical dangling workspace-root and aborted-signal closure

### Changed files
- `apps/server/src/platform/security/path-resolver.ts`: uses `lstat` to distinguish a dangling workspace-root symlink from a genuinely absent virtual root; dangling or otherwise existing roots cannot enter lexical fallback.
- `apps/server/src/platform/process/process-executor.ts`: rejects an already-aborted `AbortSignal` before calling `spawn`, preserving the existing failure result contract through `CommandTools`.
- `apps/server/test/modules/execution/security-execution-path.test.ts`: adds Unix-guarded dangling workspace-root coverage for both containment APIs and already-aborted signal coverage.

### Verification
- Focused path/execution tests: `2 files passed; 16 tests passed`.
- Server test suite: `60 files passed; 610 tests passed; 2 skipped`.
- Server typecheck: passed (`tsc -p tsconfig.json --noEmit`).
- Root lint: passed (`eslint .`).

### Remaining concerns
- SEC-003, GIT-006, and GIT-008 remain intentionally out of scope.
- Unix symlink regression is platform-guarded; Windows junction behavior remains covered by existing tests.
