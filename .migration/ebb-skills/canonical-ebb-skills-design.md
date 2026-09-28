# Canonical Ebb Skills Design

Date: 2026-09-28

## Goal

Maintain exactly one Git-tracked, project-local canonical `ebb-*` skill set that works in both Codex and Hermes Agent, while reusing Superpowers for generic engineering process mechanics and preventing runtime/self-improvement copies from becoming competing sources of truth.

## Non-goals

- Vendoring Superpowers into the Ebb skill tree.
- Making Ebb skills globally available outside Ebb Orchestrator.
- Redirecting Hermes automatic skill creation into the canonical repository directory.
- Automatically deleting existing profile-local Hermes skills during migration.

## Architecture

```text
Ebb Orchestrator repository
├── .agents/
│   └── skills/
│       ├── ebb-debug-issue/
│       ├── ebb-execute-plan/
│       ├── ...
│       ├── ebb-repository-maintenance/
│       └── ebb-curate-skills/
│
└── tools/
    └── hermes/
        ├── README.md
        ├── capabilities.yaml
        └── (no canonical skills directory after migration)
```

### Codex

Codex consumes repository skills directly from `$REPO_ROOT/.agents/skills`. No install/copy step is required for project-local use.

### Hermes Agent

Hermes consumes `<project-root>/.agents/skills` as project-local skills after the repository is trusted with `hermes skills trust`. Project skills have higher precedence than profile-local skills and are repository-owned, so autonomous curation does not silently rewrite them.

`pnpm hermes:setup` therefore changes from **copy/sync skills** to **ensure project-skill prerequisites/trust + configure Hermes-specific runtime settings**.

`pnpm hermes:check` changes from **source-vs-HERMES_HOME hash equality** to **canonical skill validation + trusted project/discovery verification + supported capability checks**. Per the approved 2026-09-28 scope clarification, provider-addition/configuration behavior was obsolete and is removed; setup/check must not configure providers or include provider smoke harnesses.

## Superpowers composition

Ebb skills are project overlays, not forks of general engineering skills:

- design clarification → `brainstorming`;
- implementation planning → `writing-plans`;
- plan execution → `subagent-driven-development` or `executing-plans`;
- behavior implementation → `test-driven-development`;
- bug investigation → `systematic-debugging`;
- task/final reviewer dispatch → `requesting-code-review`;
- completion claims → `verification-before-completion`;
- future Ebb skill authoring/refactoring → `writing-skills`.

When a generic Superpowers rule conflicts with an explicit Ebb repository rule, the Ebb/project rule wins and the override is stated in the relevant Ebb skill.

## Curation policy

`ebb-curate-skills` is the promotion gate for new skill ideas. Frequently used, self-improvement-generated, profile-local or captured skills are candidates only. A candidate enters `.agents/skills` only after an evidence-backed curation decision and Agent Skills validation.

## Migration safety

1. The new skill content can first replace `tools/hermes/skills` as a drop-in without changing infrastructure.
2. Create `.agents/skills` from the same reviewed bundle.
3. Refactor Hermes setup/check/tests to consume project-local skills directly.
4. Verify Codex and Hermes discovery from the repository.
5. Remove `tools/hermes/skills` only after both runtimes pass.
6. Legacy `HERMES_HOME` copies are optional cleanup and require a separate exact inventory/approval.

## Acceptance criteria

- One Git-tracked canonical copy exists: `.agents/skills`.
- Codex `/skills` exposes all expected `ebb-*` skills from the repo.
- Hermes, from the trusted repo, exposes all expected `ebb-*` skills as project skills.
- `pnpm hermes:setup` does not copy Ebb skills into `HERMES_HOME`.
- `pnpm hermes:check` does not require hash equality against an installed skill copy.
- No repository code/docs depend on `tools/hermes/skills` after removal.
- Superpowers generic workflows remain external dependencies rather than duplicated Ebb content.
- Automatically created/profile skills cannot silently mutate the canonical set.
