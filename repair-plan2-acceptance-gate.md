# Repair Plan 2 Acceptance Gate

Plan 2 did not pass its final acceptance gate. Do NOT start Plan 3.

Repair the existing `feat/domain-workflow-scheduler` branch.

## Root causes already established

1. `packages/testing/src/fake-agent-runtime.ts` is incorrectly placed in a shared
   package while importing `AgentRuntime` and `RunOutcome` as local files:

   - `./agent-runtime.js`
   - `./run-types.js`

   Those contracts actually live under:

   - `apps/server/src/modules/runtime/`

   `@orchestrator/testing` also does not declare `@orchestrator/contracts`.

   `FakeAgentRuntime` is currently only infrastructure for testing the server
   runtime/workflow and does not need to be a reusable production package.

2. A TypeScript emitting/build invocation generated untracked `.js` files beside
   `apps/server/**/*.ts` plus `apps/server/tsconfig.tsbuildinfo`.

   Source compilation for this repository must not emit JavaScript beside
   TypeScript sources.

## Required repair

- Move `FakeAgentRuntime` out of `packages/testing` into the server test support
  area, preferably:

  `apps/server/test/fakes/fake-agent-runtime.ts`

- Import `AgentRuntime` and `RunOutcome` from the real server runtime modules using
  correct TypeScript/NodeNext `.js` import specifiers.

- Update every server test/scenario that consumes `FakeAgentRuntime` to import the
  test fake from its new location.

- Remove `packages/testing/src/fake-agent-runtime.ts` and remove any export of it
  from `packages/testing/src/index.ts`. Keep `@orchestrator/testing` available as
  an empty/shared testing package for future genuinely cross-package helpers.

- Do NOT introduce a dependency from `@orchestrator/testing` to
  `@orchestrator/server` and do NOT duplicate `AgentRuntime`/`RunOutcome` just to
  make imports compile.

- Fix any strict TypeScript error inside `FakeAgentRuntime`, including the current
  `string | undefined` error, without weakening strictness.

- Add `"noEmit": true` to the shared TypeScript configuration so accidental raw
  `tsc`/build invocations cannot emit JavaScript beside source files. If a future
  production build needs emitted server JavaScript, it must use a dedicated build
  config rather than weakening the normal development config.

- Add `**/*.tsbuildinfo` to the root `.gitignore`.

- Delete ONLY the generated untracked `apps/server/**/*.js` files and
  `apps/server/tsconfig.tsbuildinfo`.

- Do not use `git clean -fd` or `git clean -fdx`.

- Do not delete tracked `eslint.config.js` or any intentional JavaScript source.

- Verify no generated `.js` files remain under `apps/server/src` or
  `apps/server/test`.

## Acceptance gate

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

All three must pass.

Then run:

```bash
git status --short
```

There must be no untracked generated `.js` or `.tsbuildinfo` files.

## Commit

Commit the repair on `feat/domain-workflow-scheduler` with:

```text
fix: repair fake runtime boundaries and TypeScript emit
```

## Final report

Report:

- files moved/changed,
- exact verification results,
- final commit SHA,
- final git status.

Do not merge, push, delete the worktree, or start another implementation plan.
