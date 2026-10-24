# Existing skill update evidence

Scope: targeted updates to all supplied canonical skill copies for the confirmed branch, release and README/configuration policy. Source: `source/skills/`; output: `bundle/.agents/skills/`. New `ebb-release` and `ebb-maintain-project-docs` are separate owners and are not edited here.

## Static baseline recorded before edits

The original corpus was read and inspected, including `ebb-curate-skills` and its authoring protocol. No dynamic agent pressure tests or application runtime tests were run; the following are static gaps in the supplied text, not observations of live agent behavior.

| Scenario / retrieval question | Original evidence | Gap |
|---|---|---|
| Finish an ordinary task under time pressure | `ebb-finish-branch/SKILL.md` steps 2, 4, 6 allow unspecified base and local merge | No fixed develop task source, PR squash target or integrated-source identity |
| Resume execution after compaction | `ebb-execute-plan/references/ledger-format.md` has `Base`, commits and HEAD without identity roles | Approved task SHA, integrated develop SHA and release candidate can be conflated |
| Configuration/API change without a docs request | `ebb-orchestrate-work` routes docs/setup to maintenance | No automatic changed-scope README/.env.example content owner |
| Finish a plan without asking for publication | Root router has only branch finish and no manual release route | No explicit separation of ordinary completion and release/rollback/tag |
| Create a task workspace from release-only history | Worktree/context have generic base/status checks | No pinned develop ancestry/target validation or legacy master boundary |
| Withdraw a release whose app tests fail | Quality gates require full suite before branch integration without withdrawal scope | No distinct identity/tool safety evidence scope |
| First supported installation is 0.x | Migration lifecycle declares pre-v1 mutable until first stable release | Version number can incorrectly override published migration contract |

Baseline method: direct source reads and `rg` inspection. Original ownership, retry patterns and useful references will be preserved. Verdict: `MERGE_PATTERN` into existing workflow owners; new domains remain owned by the two new skills. Dynamic discipline RED/GREEN is unavailable in this archive-only task and will remain an explicit limitation.

## Result

All 20 original skill directories and their 42 files were copied; none of their reference files were dropped or replaced with stubs. Targeted edits changed 15 original skills / 28 files; 5 complete skills and 14 original files remain byte-identical. Changed workflow versions are 5.2.0, changed database version is 1.1.0. The two new skills are separately owned and were only read here.

| Original skill | Result version | Actual changed paths |
|---|---|---|
| `ebb-curate-skills` | 5.2.0 | `SKILL.md`, `references/skill-authoring-protocol.md` |
| `ebb-database-engineering` | 1.1.0 | `SKILL.md`, `references/migration-lifecycle-policy.md` |
| `ebb-debug-issue` | unchanged | UNCHANGED — byte-identical complete directory |
| `ebb-design-change` | unchanged | UNCHANGED — byte-identical complete directory |
| `ebb-dispatch-agents` | 5.2.0 | `SKILL.md`, `references/dispatch-brief.md` |
| `ebb-execute-plan` | 5.2.0 | `SKILL.md`, `references/execution-state-machine.md`, `references/ledger-format.md`, `references/subagent-mode.md` |
| `ebb-final-review` | 5.2.0 | `SKILL.md` |
| `ebb-finish-branch` | 5.2.0 | `SKILL.md` |
| `ebb-handle-review-feedback` | unchanged | UNCHANGED — byte-identical complete directory |
| `ebb-implement-task` | 5.2.0 | `SKILL.md` |
| `ebb-orchestrate-work` | 5.2.0 | `SKILL.md`, `references/workflow-router.md` |
| `ebb-quality-gates` | 5.2.0 | `SKILL.md`, `references/completion-evidence.md` |
| `ebb-repository-context` | 5.2.0 | `SKILL.md` |
| `ebb-repository-maintenance` | 5.2.0 | `SKILL.md`, `references/documentation-checklist.md`, `references/repository-maintenance-checklist.md` |
| `ebb-review-plan` | 5.2.0 | `SKILL.md`, `references/plan-review-checklist.md` |
| `ebb-review-task` | 5.2.0 | `SKILL.md` |
| `ebb-security-review` | unchanged | UNCHANGED — byte-identical complete directory |
| `ebb-web-e2e` | unchanged | UNCHANGED — byte-identical complete directory |
| `ebb-worktree` | 5.2.0 | `SKILL.md`, `references/worktree-safety.md` |
| `ebb-write-plan` | 5.2.0 | `SKILL.md`, `references/plan-format.md` |

## Static verification and trigger/retrieval matrix

Checks executed with one-shot Python inspections and `rg`; no helper script/framework was added:

- Original/copy per-directory file sets match: 20 directories / 42 files, no missing references.
- Changed skill versions, frontmatter name/structure and Russian observable-trigger descriptions: PASS.
- Relative Markdown links resolve and canonical cross-skill names exist: PASS. `ebb-release-candidates` is a Git metadata directory in the new release contract, not a missing skill.
- Trailing-whitespace inspection of Markdown: PASS.
- Read-only `git diff --no-index --stat` inspection produced exit 1 because the archive copy intentionally differs; this is an inventory of edits, not a test failure.
- Scope scan found no third-party runtime skill/plugin calls in changed rules. Original useful RED/GREEN, independent review, ownership, retry (3 technical failures; 5 fix rounds) and worktree safety patterns remain present.
- Default max 2 active subagents is shared across implementers/fixes/reviewers/scouts, with narrower plan/runtime limits and explicit user amendment required for more. Dispatch, execute, ledger/state-machine and plan contracts agree; controller cannot implement to evade the limit.

| Static question / scenario | Retrieval result | Limit |
|---|---|---|
| Ordinary task from workspace through integration | Context/worktree pin develop; finish requires PR squash develop and separate integrated gates | Git operations not executed |
| Compaction after task approval / squash | Ledger/state-machine distinguish accepted task SHA, integrated source SHA and explicit-release candidate metadata | No live agent compaction run |
| Docs-worthy config/API/setup change | Task/plan/review/router/gates/finish route affected owners to docs content owner | No actual project docs audit |
| Unrelated bounded task | Docs changed-scope policy and explicit-only full audit avoid project-wide scan | Static negative-case check |
| Completion without release request | Manual-only release route; completion/PR/CI never publish/tag/rollback | No external mutation executed |
| Zero-release legacy master | Separate Plan26 preservation/default-branch/removal transition; no baseline/dummy/restore/archive commit retained | Source repository not supplied here |
| Bad released app needs withdrawal | Quality gates route exact identity/tool/permission/provenance and applicable local/CI safety; broken app suite not required to turn green | Tools are specifications, not implemented/runtime-tested here |
| Published 0.x migrations | DB contract becomes immutable on publication/supported installation; withdrawal does not roll data/deployment back | No schema/migrations modified or tested |

## Limitations

These are static archive checks. Dynamic discipline pressure tests, runtime agent execution, source-project application/build/database tests, actual Git PR/squash migration, CI, GitHub/GHCR publication and deletion were NOT_RUN. No claim is made that release tools exist or have passed runtime tests. No personal installation or source-project mutation was performed. New skill content and AGENTS/Plan26 are validated by their respective owners; a final combined archive review remains with the controller.
