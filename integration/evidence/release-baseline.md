# Release baseline — observed before authoring

Recorded 2026-10-02. Method: this author loaded the current source `ebb-finish-branch`, `ebb-worktree`, `ebb-quality-gates`, `ebb-orchestrate-work` and their routing/safety/evidence references, then reasoned through the three requests below using only those instructions. These are bounded instruction-following dry-runs, not independent agent trials or live Git/GitHub/GHCR executions. No release skill had been written at this point.

## 1. First release; zero published releases; master = develop = H

Observed route: `ebb-orchestrate-work` has no release row. Its nearest route is branch integration → `ebb-finish-branch`. Finish determines the actual base and requests authorization for tag/release/publish. Gates require fresh tests at current HEAD and a full integration suite. Worktree rules preserve the provided workspace.

Observed gap: none of the loaded instructions rejects an existing development-history master, requires an absent master before first publication, describes a separate preflight transition, or constructs a root snapshot with the exact approved source tree. The base-name-agnostic finish policy cannot establish develop as integration branch. A conservative agent following the available instructions must stop for unspecified release policy; a normal merge of H into master would preserve development history and fail the requested release-only history. This is an uncovered requirement, not evidence of a performed destructive action.

## 2. Delete first or latest later release and its publications

Observed route: tag/release/force-push need authorization under finish; generic destructive discard receives an inventory and confirmation. Fresh gates verify repository claims.

Observed gap: no loaded rule inventories annotated version tags, GitHub Release/assets, public GHCR package-version IDs and shared multiarch digest ownership together. No root-versus-parent master update rule, Release-before-tag deletion order, GitHub immutable-release constraint, permissions/ruleset refusal, >5000 public-download restriction, or post-deletion proof exists. There is no durable consumed-version store after tag/master deletion. Therefore generic branch discard cannot satisfy the requested rollback; claiming complete deletion would lack proof.

## 3. Partial publication and retry with deleted-version reuse pressure

Observed route: gates prohibit stale evidence and generic finish demands authorization for publishing. They do not identify partially completed remote operations.

Observed gap: no bounded release lock, exact pinned candidate/source/old-master identities, authoritative remote reconciliation, persistent operation checkpoint, resumable state machine, version reservation independent of deleted publications, or no-reuse rule exists. A retry cannot establish whether it must reuse the exact candidate or create a new commit/version. Existing freshness rules also do not bind final confirmation to the pinned release bundle. Thus the observed result is BLOCKED by missing deterministic tool and recovery policy; neither a new release candidate nor reusing an erased version can be justified.

## Baseline conclusion

The current skills provide generic authorization, workspace safety, and verification discipline, but leave all three release-specific cases unresolved. The new repository skill must close these gaps without treating generic authorization as a substitute for a concrete final release/rollback confirmation. Later scenario checks must distinguish executable support from documented requirements: actual repository release tools have not been supplied.
