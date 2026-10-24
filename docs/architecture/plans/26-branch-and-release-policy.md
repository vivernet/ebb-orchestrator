---
id: plan-26
kind: plan
status: proposed
title: Политика веток и безопасных release snapshots
summary: 'Переход на develop как default/integration ветку, отделение master snapshots и реализация проверяемой ручной публикации/withdrawal GitHub/GHCR без deployment.'
created: 2026-10-24
updated: 2026-10-24
---

# 26. Политика веток и безопасных release snapshots — Implementation Plan

**Статус:** подготовленный план для preflight настоящего репозитория; implementation не выполнена.
**Goal:** перейти на develop как default/integration, отделить master snapshots и реализовать проверяемую ручную публикацию/withdrawal GitHub/GHCR без deployment.
**Architecture:** portable Node CLI управляет pinned immutable operation; pure policy/snapshot/gates отделены от GitHub/GHCR adapters. Append-only reservation на develop — authoritative no-reuse record, journal в git-common-dir — recoverable cache. Public mutations выполняет один trusted manual serialized workflow; отдельный validation workflow даёт exact-SHA evidence.
**Authority:** подтверждённая политика [branch-and-release-policy](../policies/branch-and-release-policy.md), актуальные root/scoped `AGENTS.md`, system design и roadmap после Task0; `ebb-release/references/release-tool-contract.md` и `rollback-recovery.md` внутри `.agents/skills/`.
**Global Constraints:** source tree equality, root/one-parent master, no dummy history/hidden backups, develop reservations before source pin, no version reuse, explicit final approval, no deployment/БД, exact remote identities, no secrets.
**Specialist Constraints:** `ebb-security-review` для input/credentials/permissions; `ebb-maintain-project-docs` для first-party README/examples; `ebb-repository-maintenance` для docs governance и portable scripts; `ebb-quality-gates`/`ebb-final-review` для evidence. Остальные owners включаются только по реальному scope.
**Review Focus:** root withdrawal, partial operations, provider отказ, immutable releases, CI wrong SHA/skipped checks, защищённые refs, shared image ownership, resume без нового commit и различие PUBLISH/WITHDRAW gates.

## 1. Исполнение и граница авторизации

Контроллер использует `ebb-execute-plan`, `ebb-dispatch-agents`, `ebb-implement-task` и `ebb-review-task`. Implementation выполняют **только task subagents**; независимый review также отдельный task/review subagent. Одновременно не более **двух subagents, включая reviewer**. Контроллер координирует, ведёт ledger, проверяет evidence и интегрирует reviewed commits; не пишет implementation inline и не заменяет независимый review самопроверкой автора. Соседние tasks с общей файловой областью выполняются последовательно. Не запускать внешнюю methodology/skills как обязательные зависимости.

После авторизации implementation локальная task branch/worktree и tests не требуют вопросов «продолжать?» на каждом шаге. Push, integration merge, repository settings, candidate refs, real registry/GitHub mutations и final release/withdrawal требуют разрешения в своём concrete scope; ранее данное разрешение переиспользуется. Реальный production/staging runtime не трогать. Disposable Git fixtures, mocked APIs и local registry fixtures разрешены как tests; настоящий staging registry разрешается только отдельным конкретным scope.

План выполняется из isolated task branch от pinned develop. Pre-existing intended/unrelated work защищается, reset/clean не применять. Если develop уже checkout в linked worktree, main worktree переключается в одобренную новую `chore/plan26` от pinned `origin/develop`, а не `git switch develop`; каталог main repo/.git не удаляется. Конфликт существующего branch/worktree имени — BLOCKED до выбора безопасного нового имени. Package scripts/paths ниже **будущие**, их наличие сейчас не предполагается.

Каждая task: context → RED → минимальный GREEN → meaningful gates → независимый review → исправление findings → reviewed commit и integration по разрешённому scope. Task закрывается только после recorded evidence; unresolved load-bearing finding, missing required platform или external prerequisite означает BLOCKED. Не объявлять Plan Complete, если последний enablement gate не выполнен.

## 2. Контракт файлов и интерфейсов

| Create / Modify | Ответственность и producer → consumer |
|---|---|
| `.ebb/release-policy.json` (new) | Reviewed versioned config: real repository ID/owner/name/remote, default/release refs, stable MAJOR.MINOR.PATCH/version-tag/image encoding, asset layout, exact gates/check identities/platforms, trusted workflow/script pins, timeouts. Task0 mapping → policy/gates/adapters. |
| `release.json` (new **только если Task0 доказал отсутствие канонического manifest**) | `{ "version": "<SemVer>" }`, reviewed source contract; private root package не подменяет версию. Existing manifest изменяется только по exact Task0 map. |
| `docs/releases/version-reservations.json` (new) | `schemaVersion: 1`, append-only `reservations[]`: `{version, operationId, reservedAt, intent}`. No circular self SourceSHA; protected develop history → prepare/no-reuse/CI. |
| `scripts/release.mjs` (new) | CLI `prepare|validate|publish|rollback|resume|status`; validated inputs → JSON report/exit status. No hidden mutation on status/prepare. |
| `scripts/release/policy.mjs`, `policy.test.mjs` (new) | Config/schema, repo/ref/version/gate identity validation, CI ordinary PR target and master-history rules. Task2 bootstrap config со structured null/pending bindings → Task8 reviewed final binding → Task11 enablement acceptance. Только полностью bound `PolicyV1` допускает release operation. |
| `scripts/release/version-reservations.mjs`, `version-reservations.test.mjs` (new) | Append-only diff/uniqueness/ownership and proof of reviewed remote develop reservation → prepare/gates. |
| `scripts/release/snapshot.mjs`, `snapshot.test.mjs` (new) | Pin source SHA/tree + oldMaster; root/one-parent candidate/annotated tag object with persisted deterministic inputs → gates/operations. |
| `scripts/release/gates.mjs`, `gates.test.mjs` (new) | Exact-SHA/platform run evidence, PUBLISH full matrix vs WITHDRAW safety, evidence digest → approval/operations. |
| `scripts/release/github.mjs`, `github.test.mjs` (new) | Authoritative repo/refs/checks/Release/assets, trusted workflow dispatch/readback → operations; no guessed IDs. |
| `scripts/release/ghcr.mjs`, `ghcr.test.mjs` (new) | Package/version/OCI inventory, public readback, ownership/deletion eligibility/target-only deletion → operations. |
| `scripts/release/journal.mjs`, `journal.test.mjs` (new) | Safe UUID paths in git-common-dir, bounded lock, atomic checkpoint, append-only events, checksum backup/import → operations/resume. |
| `scripts/release/operations.mjs`, `operations.test.mjs` (new) | Monotonic publish/withdraw/resume orchestration, per-side-effect intent/reconcile, approvals/CAS. Legacy retirement не является release operation; initial native CAS transition выполняется до нового tooling. |
| `scripts/release.test.mjs` (new) | CLI/adapter integration and fault injection; safe spawned Node argv/environment tests. |
| `.github/workflows/release-validation.yml` (new, создаёт executor) | Trusted manual exact source/candidate matrix including currently push-only Linux acceptance; produces immutable run/check IDs. No public publisher rights. |
| `.github/workflows/release-operations.yml` (new, создаёт executor) | Единственный trusted manual PUBLISH/WITHDRAW/RESUME writer, общая repo concurrency, finite timeouts, validated intents. |
| `.github/workflows/production-gates.yml`, `codeql.yml` (modify) | Только PR targets master→develop в supplied patch; push [master,develop] сохраняется. Дополнительные future policy gates — отдельное reviewed addition. |
| `.github/workflows/security-audit-failure-paths.yml` (preserve) | Не менять audit semantics/permissions/platforms/scenarios ради release. |
| `package.json` (modify после source inspection) | Регистрация будущих `release`, `release:test`, `release:policy:check` с точными scripts; исходный manifest не заменять архивной копией. |
| `AGENTS.md`, `.agents/skills/ebb-*`, policy/Plan26 (merge supplied proposals) | Routing/authority owners и единый workflow contract; unrelated sections сохраняются. |
| Реальные first-party README/`.env.example`, canonical generators/templates (Task0 exact map) | Документация фактических commands/config; generated targets только regeneration. |

Не создавать Dockerfile/Compose/Hermes artifacts на основании отсутствующего source. Task0 связывает existing Docker support или separately approved dependency; Task9 не invent provider/secrets/runtime architecture.

**Общие seam schemas** (versioned JSON, exact names фиксируются RED tests):

- `PinnedSource = {sourceRef, sourceSha, sourceTree, oldMaster}`; полные SHA, oldMaster — full SHA или `ABSENT`. Task SHA и integrated SHA — отдельные evidence fields, не aliases source/candidate.
- `ReservationProof = {version, operationId, reservedAt, developSha, recordHash}`; immutable source pin происходит после reservation commit. Ledger read из authoritative remote, не только local file.
- `Candidate = {candidateSha, candidateTree, parent, commitInputs, annotatedTagObject}`; parent `null` или pinned oldMaster. candidateTree==sourceTree; immutable commitInputs включают timestamps/identity/message. Resume возвращает этот же object.
- `GateEvidence = {commandIdentity, conclusion, sourceSha, candidateSha, tree, platform, timestamp, logDigest, scope, runId, checkId, event, ref, headSha}`; non-CI поля run/check явно null. `success` только после required checks; skipped/missing/expired/wrong SHA → BLOCKED.
- `RemoteInventory = {repositoryId, refs, releases, assets, packages, versions, ociObjects, ownership, observedAt}`; каждый external ID и digest связан с operation/source/version; canonical digest `inventoryHash`.
- `ApprovalBundle` связывает mode/action list/pins/reservation/inventory/gates/policy hashes; receipt с explicit user confirmationHash без credentials. Final receipt не получается из prompt CLI автоматически.
- `OperationReport` точно соответствует release-tool-contract: `schemaVersion`, `operationId`, `mode`, `status`, `stage`, `repositoryId`, `version`, `sourceRef`, `sourceSha`, `sourceTree`, `oldMaster`, `candidateSha`, `candidateTree`, `policyHash`, `reservationProof`, `inventoryHash`, `gateEvidenceHash`, `confirmationHash`, `remoteIdentities`, `blockers`, `nextAction`. Null явно, empty output не success. States PREPARED/VALIDATED/AWAITING_CONFIRMATION/PUBLISHING/PUBLISHED/ROLLBACK_PREPARED/ROLLING_BACK/ROLLED_BACK/PARTIAL/BLOCKED/CONFLICT.

Все child processes используют validated argv, `shell:false`; repository hooks не выполняются по умолчанию. Inputs от workflow/repo/API недоверенные. Exceptions преобразуются в typed error/code/report; incomplete mutation — nonzero+PARTIAL; exact-stage verified success — exit 0. Status/read-only operations не repair state.

## 3. Task0 — реальный repository preflight и binding map

**Deliverable:** полный source/capability map и независимое подтверждение исполнимости плана. **Depends on:** none. **Create:** local `git-common-dir/ebb-plan26/preflight.json` и `execution-ledger.json`, вне tracked tree; policy проектируется позже. **Modify:** этот план только для exact source bindings после review. **Test:** read-only preflight checks; никаких app/source mutations.

1. Через `ebb-repository-context` прочитать actual root/scoped AGENTS, spec `docs/architecture/specs/01-system-design.md`, roadmap `docs/roadmap/generated.md`, docs naming/governance и текущие manifests/lockfile/scripts. Выполнить `git worktree list --porcelain`, `git status --short`, `git remote -v`, read-only ref/history inventory после авторизованного fetch. Remote output не должен содержать credentials; не читать secrets/.env. `gh auth status` проверяет auth, token не печатать.
2. Зафиксировать actual GitHub repository ID, owner/name, visibility, default branch, refs/full SHA, branch/rulesets/required checks, merge modes, permissions; Release/tag/GHCR inventory и current master/develop ancestry. Сравнить **текущие** trees и SHA, unique commits, worktree uncommitted/unintegrated data. Если есть releases/master unique history, transition этого плана BLOCKED: сохранить evidence и получить separate design, не стирать историю.
3. Привязать каждую manifest command к real script/function/test definition и cwd. Проверить declared engines Node>=24.15/pnpm>=12, docs `docs:inventory`, `docs:check`, `docs:rename:check`, `docs:link:sync`, `docs:test`, `skills:test`, `skills:dependencies:test`. Source snapshot содержит объявления, не реализации: absent implementation в настоящем repo — BLOCKED соответствующего gate, не invented replacement.
4. Найти authoritative version contract. Нет его — подтвердить fallback root `release.json`. Проверить Dockerfile/build contexts/images/platforms/runtime requirements/Buildx support. Отсутствие approved Docker support записать `BLOCKED_DOCKER_DEPENDENCY`, назначить existing/approved work dependency; earlier hermetic tooling продолжать можно, release-ready объявлять нельзя.
5. Перенести full существующий CI matrix в exact policy binding: job names, platform/runtime, event constraints, workflow SHA, source checkout, required check IDs, security/build/browser/keyring/native tests. Определить runner scope: existing self-hosted Linux `[self-hosted, Linux, X64, ebb-systemd-cgroup-v2]` prerequisites и Windows native helper обязательны. Не объявлять Linux push-only job выполненным по обычному PR.
6. Составить permission/action map: смена default branch, develop protections/required checks/squash policy, master namespace ruleset при absent branch, кандидатные refs, trusted workflow permissions, GHCR public publish/delete, immutable release settings. Narrow withdrawal rights отдельно утверждаются; никаких broad bypass/admin toggles. Проверить актуальные provider limits по SOURCES.
7. Составить README/examples ownership map всех first-party dirs/languages, config loaders/dynamic key bindings/generators, исключения deps/vendor/generated. Link/governance status берётся из real tool, не предполагается по path.

**RED:** supplied snapshot не содержит app/tests/Docker/config loaders; capability map обязан выдавать unavailable/BLOCKED, а не PASS. Пустая provenance/permissions mapping не допускает мутации. **GREEN:** каждый load-bearing binding имеет exact path/symbol/command/cwd/evidence либо явный blocker+dependency. Independent `ebb-review-plan` проверяет source mapping/dependencies/contracts до первой mutation. **Gates:** read-only evidence, no-secret review. **Review Focus:** no assumed files/functions; equality не historic claim; master refs не удалять. **Completion:** approved binding ledger; BLOCKED external prerequisites остаются видимыми. Никакого implementation claim от preflight.

## 4. Task1 — интеграция policy/skills и develop default governance

**Deliverable:** единый repository governance на develop, без преждевременного release. **Depends on:** Task0 reviewed mapping. **Create:** policy/Plan26 и два новых skill dirs из bundle. **Modify:** actual AGENTS, existing ebb skills, production/codeql PR triggers; actual root docs links по Task0. **Preserve:** security-audit-failure-paths.yml byte-for-byte. **Test:** actual skills/docs governance tests и workflow diff checks.

**Interfaces:** supplied proposals → current repo files через three-way/manual merge; сохранить current unrelated changes. Default develop settings → ordinary branch/PR tooling; legacy master retire immediately после proofs/approval, до разработки release tooling.

**RED:** source skill dependency/dispatch fixtures должны ловить прежний master target, slash-command assumption и missing docs/release owners; workflow comparison показывает PR master. Добавить regression assertions в exact existing skill-test source, закреплённый Task0; не invent runtime tests вне их реализаций. **GREEN:** merged owners/routing/callers, PR target develop; workflows сохраняют исходные jobs, permissions, node/platform scope и audit failure semantics. Выполнить фактические `pnpm skills:test`, `pnpm skills:dependencies:test`, applicable docs gates. Отдельным concrete settings bundle получить authorization и применить default branch develop, squash integration и required checks; master namespace protection проектируется с учётом future root/later CAS и отдельно одобренного withdrawal.

Не убрать push [master,develop]; absent master не требует dummy branch. Не подменять security audit `continue-on-error`/evidence upload/explicit final failure. **Review Focus:** small diff, native invocation, no auto release. **Completion:** reviewed integration SHA и verified settings readback; при отказе setting API/protection BLOCKED, не обходить. Push/merge/settings только в подтверждённом scope.

**Initial transition:** [BEFORE-PLAN](../../../integration/BEFORE-PLAN.md) даёт практический one-off native Git CAS порядок, без будущего CLI. Если он уже выполнен, Task0 проверяет master ABSENT; иначе сразу здесь после read-only fresh proofs/default develop/worktree safety и отдельного concrete approval удалить exact legacy master ref, затем verify develop/default/data unchanged. Не ждать новых modules/workflows или первого release. Если master имеет unique commits/не сохранённые в develop данные, есть releases или incompatible история либо protection refusal — BLOCKED transition, не force/bypass. Publication остаётся disabled. Отдельную retirement feature в future CLI не строить.

## 5. Task2 — policy schemas и machine branch invariants

**Deliverable:** deterministic PolicyV1 и проверка branch/history contracts. **Depends on:** Tasks0–1. **Create:** `.ebb/release-policy.json`, `scripts/release/policy.mjs`, `policy.test.mjs`. **Modify:** package script `release:policy:check` после manifest inspection; future CI addition отдельным diff. **Test:** `node --test scripts/release/policy.test.mjs`.

**Interfaces:** preflight exact mapping → schema-valid bootstrap config/hash с `bindingStatus: "pending"`, structured null для ещё не созданных trusted workflow/script full-SHA bindings и `pendingBindings[]` с field/producerTask/blocker. Это **не valid mutation config**. Task2 produces schema/bootstrap и pure validation; Task8 produces fully bound PolicyV1 (`bindingStatus: "bound"`, pendingBindings пустой); Task11 проверяет enablement. Pure validator → structured blockers; module command `node scripts/release/policy.mjs check --event-file <validated-path>` → read-only report. CLI не получает secrets/path authority из input.

**RED:** malformed repo ID/remote mismatch, unsupported prerelease/build SemVer suffix/encoding, missing gate platform, ordinary PR base master, dummy/merge release commit, missing provenance, absent master with zero releases, root/later parent mismatch fixtures. Expected: forbidden inputs rejected; allowed absent root state explicitly accepted; pending/null trusted bindings разрешены только в bootstrap schema, все public release mutations fail closed с named blockers. **GREEN:** conservative schema/error codes; CI проверяет ordinary PR target develop и surviving master root/one-parent/tree/provenance цепочку; release trusted writer events allowlisted. Не путать machine check с server protection. Existing legacy master pre-transition сообщает BLOCKED_LEGACY_MASTER, не silently legitimate release.

**Gates:** tests, lint/typecheck relevant module; static workflow/security review. **Review Focus:** no unverified config placeholders, no invented owner; trusted workflow pin update lifecycle без self-approval. **Completion:** schema/pure tests PASS, exact уже доступные source bindings/hash и malformed input evidence; будущие trusted bindings явно null/pending с producer Task8, не fake placeholder SHA. Task2 может завершить schema/bootstrap deliverable при этих известных pending fields, сохраняя release BLOCKED. Unresolved namespace/version encoding и неизвестные source bindings остаются blocker соответствующего deliverable. Пока Task8 не bind reviewed workflow/script full SHAs и Task11 не закроет full gates, bootstrap не разрешает publish/withdraw/resume или temporary remote candidate writes.

## 6. Task3 — reservation и canonical version

**Deliverable:** durable no-reuse contract. **Depends on:** Task2. **Create:** `docs/releases/version-reservations.json`, `scripts/release/version-reservations.mjs`, `version-reservations.test.mjs`; fallback `release.json` только по Task0. **Modify:** existing canonical version source только exact mapping, policy canonical path; docs governance manifest если его существующие rules требуют регистрацию. **Test:** `node --test scripts/release/version-reservations.test.mjs`.

**Interfaces:** protected remote develop history + ledger → ReservationProof; manifest version + candidate request → match validation. Schema root `{schemaVersion:1,reservations:[]}`; record `intent` равен `release` или `hotfix`. Этот пустой ledger допустим до первой конкретной reservation; не заранее потреблять выдуманную версию.

**RED:** repeated version/operationId, edits/reorder/delete старого record, invalid timestamp, case/encoding collision, release removed then reuse, interrupted/cancelled operation, local-only unreviewed reservation, circular SourceSHA field. **GREEN:** append-only history/diff validation, UUID operation IDs, SemVer policy, reviewed remote reservation proof. Перед каждой publication сначала reviewed reservation/version PR в develop, затем pin source; источник hotfix/version также reviewed. Source pin может включать уже committed ledger, circular write не нужен. Initial policy разрешает только stable MAJOR.MINOR.PATCH без prerelease/build metadata; расширение требует separate reviewed change.

**Gates:** module tests, actual docs governance and skills gates; CI append-only protection introduced alongside policy check. **Review Focus:** no-reuse после root rollback/cache loss, protected develop authority. **Completion:** reservation verifier rejects mutations/reuse; no current release version promised. Real reservation PR требуется только для конкретной operation с approval.

## 7. Task4 — immutable snapshot и annotated tag

**Deliverable:** release tree/history без development history. **Depends on:** Tasks2–3. **Create:** `scripts/release/snapshot.mjs`, `snapshot.test.mjs`. **Test:** `node --test scripts/release/snapshot.test.mjs` в disposable Git/bare fixtures.

**Interfaces:** PolicyV1+PinnedSource+ReservationProof+persisted commit inputs → Candidate и tag object; отсутствие journal ownership запрещает regeneration. Git commands spawn argv/shell:false, hooks отключены.

**RED:** snapshot автоматически получает source parent, второй snapshot 2 parents/merge, tree меняется README/version stamping, old master/source drift, resumed timestamp создаёт новый SHA, wrong annotated tag target, missing source object. **GREEN:** `git commit-tree` exact source tree с 0/1 parents; source/previous master metadata в commit/tag, никаких tracked-file edits. Commit inputs persist до использования, candidate/tag IDs stable. Atomic Git push/CAS fixtures проверяют absent master creation, later update, stale lease refusal, root ref deletion и later parent restore. Publication здесь не выполняется на real remotes.

**Gates:** tests, tree/parent readback; local proof из archive только design evidence, не substitute implementation tests. **Review Focus:** parent/tree exact equality и known compare SHA, no backup tags. **Completion:** все snapshot fixture assertions PASS; unsupported real atomic capability остаётся BLOCKED до policy decision, не fallback без review.

### 7.1. Journal, checkpoint/lock и transfer — вторая часть Task4

**Deliverable:** interruption-safe local state outside tree. **Depends on:** проверенный snapshot contract первой части Task4. **Create:** `scripts/release/journal.mjs`, `journal.test.mjs`. **Test:** `node --test scripts/release/journal.test.mjs` на Windows и Linux path fixtures.

**Interfaces:** validated UUID operation + git common dir → state/events/inventory/gates/approval files; checksums + safe importer → restored cache. Storage names `operations/<uuid>/{state.json,events.jsonl,inventory.json,gates.json,approval.json}`, backup checksum manifest. No credentials/log payload secrets.

**RED:** path traversal, symlink escape, hostile Windows path, truncated/tampered JSON, crash before/after rename, duplicate lock, stale lock without owner termination evidence, checkpoint deletion followed by guessed resume, secret in environment/error logging. **GREEN:** validated bounded roots, atomic writes, append-only intent/result journal, integrity/schema/version checks, monotonic stages, finite mutex wait. Lock защищает только local cache; remote serialization workflow Task8. Persist intent before remote request, reconcile unknown response by exact IDs. Backup/import deterministic и без access tokens; lost cache → authoritative rebuild либо BLOCKED ambiguity.

**Gates:** module tests, security review process/environment/path handling. **Review Focus:** common dir across linked worktrees, stale owner/no fencing assumption. **Completion:** crash/corruption/transfer tests и no-secret checks PASS; journal не изменяет source/candidate tree.

## 8. Task5 — GitHub и GHCR adapters

**Deliverable:** exact provider identities/inventory/eligibility. **Depends on:** Tasks2–4. **Create:** `github.mjs`, `github.test.mjs`, `ghcr.mjs`, `ghcr.test.mjs` в `scripts/release/`. **Test:** `node --test scripts/release/github.test.mjs scripts/release/ghcr.test.mjs` с mocked HTTP/registry fixtures.

**Interfaces:** validated repository/policy → RemoteInventory; typed request identity → provider response/reconciliation; package/version/digest ownership → exact publication/deletion action. Credentials injected из approved runtime environment, never output/journal. No implicit changes repository visibility.

**RED:** repository/owner mismatch, paging missing IDs, stale inventory, wrong tag/Release asset hashes, private image, untested image metadata, shared multiarch manifest ownership, unknown package owner, no deletion permission, known >5,000 downloads restriction, API response без undocumented download_count, deletion server refusal и ambiguous response, immutable Release tag refusal. **GREEN:** official supported API/OCI adapters, full paginated inventories/readback, digest/platform/version/source label linkage и exact target-only deletion. Не выдумывать endpoint download_count. Known restriction → BLOCKED; unavailable count → explicit eligibility uncertainty field, first confirmed target-only deletion evaluates provider permission before any Release/ref deletion. Server refusal stops later steps; several image versions may yield PARTIAL. Shared image layout ambiguity → BLOCKED до первого удаления, surviving publications не трогать.

**Gates:** mocked tests, exact provider documentation/source attribution, security review least permissions/rate/timeouts. **Review Focus:** provider retention/caches не prove instant GC, package целиком не удалять. **Completion:** every response mapped to report/errors, no fake owner/endpoints; live permissions/capability checks позднее Task11, отсутствие live evidence не PASS.

## 9. Task6 — gates и CLI preparation

**Deliverable:** read/preparation flow, mode-specific evidence и concrete approval bundle. **Depends on:** Tasks2–5. **Create:** `scripts/release/gates.mjs`, `gates.test.mjs`, `scripts/release.mjs`, `scripts/release.test.mjs` initial cases. **Modify:** package `release`/`release:test` registration только через small diff. **Test:** `node --test scripts/release/gates.test.mjs scripts/release.test.mjs`.

**Interfaces:** PolicyV1+Candidate+RemoteInventory → gate plan/evidence digest/ApprovalBundle; CLI mode inputs validated → OperationReport. `prepare` read-only кроме named local objects/journal, remote refs требуют отдельной authorization. `rollback` по default prepares inventory, не deletion. `status` read-only, `resume` пока mutation backend не готов — BLOCKED.

**RED:** version missing silently chosen, stale/wrong SHA CI, skipped matrix leg, check from different workflow/event/platform, source/master drift, dummy legacy master, no confirmed reservation, approval from another inventory/policy, PUBLISH missing app tests, WITHDRAW incorrectly requires buggy app tests, root withdraw requires nonexistent parent image. **GREEN:** exact source/candidate full PUBLISH matrix; WITHDRAW safety subset specified below с pinned trusted tool/tests и fresh CI. Missing version возвращает required choice/nextAction, skill предлагает пользователю SemVer. No CLI prompt auto-approval. Null fields explicit; exit contract validated.

**Gates:** fixture matrix and CLI tests, relevant lint/typecheck, specialist/final review. **Review Focus:** source SHA vs candidate SHA/tree binding, workflow pin и approval hashing; prepare never retires master. **Completion:** PREPARED/VALIDATED report only when postconditions verified; full CI/Docker unavailable remains BLOCKED.

## 10. Task7 — operations state machines и отказ на каждом boundary

**Deliverable:** PUBLISH/WITHDRAW/RESUME orchestration через journalled adapters. **Depends on:** Tasks4–6. **Create:** `scripts/release/operations.mjs`, `operations.test.mjs`. **Modify:** release CLI integration tests. **Test:** `node --test scripts/release/operations.test.mjs scripts/release.test.mjs`.

**Interfaces:** exact ApprovalBundle/receipt + gate evidence + trusted serialized-run identity → mutation intent; adapters results → stage/reconciliation. Local process не public writer: future CLI delegates to Task8 workflow. Publication prepare не выполняет initial legacy retirement.

**RED:** approval absent/mismatch, second writer, lost workflow still running, crash/timeout before request/after remote success/before checkpoint at **every** boundary, unknown artifact IDs, republish after rollback, candidate regenerated, source/master drift after gate, tag collision, atomic unsupported, protected ref refusal, GHCR deletion refusal after one success, immutable Release order violation, rollback earlier release with descendants. **GREEN:**

1. PUBLISH: verify pins/receipt/run → exact tested version-only GHCR objects/public readback → atomic CAS master+annotated tag → GitHub Release/assets → final readback + candidate cleanup. Cross-system failure reports PARTIAL.
2. WITHDRAW: full deletion inventory/ownership and safety → exact GHCR target versions first → Release/assets → atomic CAS tag removal + master parent/ABSENT → target absence/survivor integrity checks. Root master disappears; no dummy restore. Known restriction blocks, unavailable count disclosed; provider refusal prevents later Release/ref steps. Multi-version partial explicitly recorded.
3. RESUME: remote reconciliation by immutable IDs and original intent, no new SHA/version/operation; original approval только при unchanged bundle и fresh mode-specific gates. Changed deletion scope requires fresh receipt. Withdrawal partial publish is separate approved intent.
4. STATUS: read-only state/remaining identities/ambiguities, never repair.

**Gates:** full hermetic release module suite, security review concurrency/idempotence/ownership/CAS. **Review Focus:** no unconditional force, no rollback app-green requirement, no completion until all postconditions. **Completion:** boundary matrix produced with expected state/IDs and test evidence, tool still disabled until Tasks8–11 live prerequisites complete.

## 11. Task8 — trusted exact-SHA validation и один public writer

**Deliverable:** new workflows созданные/проверенные executor, без ослабления supplied CI. **Depends on:** Tasks0–7; Docker-dependent jobs await Task9. **Create:** `.github/workflows/release-validation.yml`, `release-operations.yml`. **Modify:** `.ebb/release-policy.json` trusted identities/required checks, existing production/codeql only reviewed additive policy checks; preserve supplied scopes/audit. **Test:** workflow schema/contracts fixtures в `gates.test.mjs`/`operations.test.mjs`, actual exact-SHA manual runs в Task11.

**Interfaces:** workflow_dispatch untrusted source/candidate/operation inputs → validated argv; trusted pinned config/scripts исполняют checks/operations. Source checkout для product tests не становится authority publisher scripts. Privileged job не запускает arbitrary code из candidate; script bundle источник — approved trusted pin. Workflow changes требуют reviewed develop PR и explicit policy pin update, не runtime floating HEAD. Task8 сначала получает independently reviewed workflow/script commit(s) и их полные immutable SHA, затем отдельным reviewed config update bind реальные identities и меняет bootstrap bindingStatus на bound. Config не содержит circular SHA собственного commit; approved config identity/hash фиксируется внешним operation evidence. До этого null/pending bindings дают fail-closed BLOCKED, а не валидный mutation config.

**RED:** workflow checkout wrong ref, inputs interpolated в shell, approval interpreted as generic yes, attacker candidate scripts получает secrets, skipped Linux push-only coverage принят, separate PUBLISH/rollback concurrency groups, cancel-in-progress true, unbounded queue/job, manually bypassed required job. **GREEN:** один manual release-operations workflow, одна repository group для publish/withdraw/resume, `cancel-in-progress: false`, finite queue acquisition/job timeout и trusted minimal permissions. Queue timeout/termination/pending replacement or cancellation наблюдаются CLI через workflow status; актуальная queue policy выбирается Task0. Не обещать FIFO/persistent pending queue, no imagined remote mutex/API fencing. Выход writer включает OperationReport/readback artifacts без secrets.

Validation workflow повторяет **весь** pinned source matrix: exact candidate/source tree, required OS/runtime/build/security/browser/keyring/native cases, release tests и Docker scope. Existing Linux native test push-only остаётся в original workflow; manual validation запускает его явно на configured selfhosted runner. Artifact/check IDs pin и consumed gates; GitHub event head ref SHA alone не заменяет explicit tested source/candidate metadata. WITHDRAW dispatch использует withdrawal safety path и parent checks только при parent.

**Gates:** workflow static/security review, module regression, future real-run evidence; нельзя назвать непроверенный YAML publisher ready. **Review Focus:** secrets/source trust boundary, permissions/readback/termination, no audit semantics degradation. **Completion:** reviewed workflow/script commits с full immutable SHA, затем reviewed fully bound config и tests rejecting pending/mismatched identities; все Task2 pending trusted fields разрешены реальными binding proofs. Public writer остаётся disabled/guarded до Task11 full prerequisite/gate acceptance; наличие bound config само по себе не разрешает mutation.

## 12. Task9 — Docker dependency, tested image contract

**Deliverable:** actual tested Docker publication artifacts и ownership layout. **Depends on:** Task0 approved Docker dependency + Tasks5–8. **Create/Modify:** только existing/approved exact Docker source paths из ledger; `.ebb/release-policy.json` image/platform/version encoding; GHCR/gates tests. **Test:** exact Docker Buildx build/smoke commands из inspected approved source, release modules и image fixture tests.

**Interfaces:** pinned source/build inputs → OCI artifacts/digests/config/platform manifests + tests → publication inventory. Каждый image версия соответствует canonical source/reservation/tag, source labels full SHA, no latest/mutable aliases. Package namespace uses actual owner and release-specific ownership strategy.

**RED:** absent Dockerfile/support, wrong platform, failed smoke, wrong source/version labels, untested build after approval, private visibility assumption, shared package version used surviving release, SemVer prerelease/`+` suffix rejection, provider/Hermes runtime requirement invented. **GREEN:** validate discovered approved images locally с Buildx; artifact hashes/tests pin before final release approval. Схема layout обеспечивает удаление exact target version identities без destroying surviving publication; unsupported/shared ownership ambiguity блокирует. Remote staging только отдельный approved exact scope/inventory; local registry fixture preferred для hermetic tests.

**Gates:** real build/smoke each required image/platform, dependency owner's existing acceptance, security review secrets/build contexts. **Review Focus:** no unapproved new runtime architecture, public GHCR vs repo/npm flags separate. **Completion:** all required Docker evidence; если dependency absent, Task9 и release enablement BLOCKED, earlier tools остаются prepared.

## 13. Task10 — полный first-party README и environment examples audit

**Deliverable:** truthful first-party docs/examples и ownership report. **Depends on:** Task0 map, Tasks1–9 current contracts (external blockers показывать как blockers). **Modify:** exact README/examples/generator source paths из ledger; root README без metadata/numeric prefix. **Test:** existing docs governance implementation, safe command examples/config loader tests.

**Interfaces:** real source manifests/commands/loaders/config defaults/namespaces → docs claims/key mapping; content owner `ebb-maintain-project-docs`, file organization/tooling owner `ebb-repository-maintenance`. Scope explicit full audit всех first-party README/examples, multilingual variants; dependencies/vendor excluded, generated output regenerate from canonical source.

**RED:** docs claims command absent/wrong cwd, dev/production confusion, nested owners forgotten, required/default/type contradicted by loader, optional active empty assignment ломает omitted default, dynamic prefix key guessed, Compose host vars смешаны с app runtime, real secrets read, generated output handedit. **GREEN:** minimal source-grounded corrections, accurate files unchanged disposition. Root project purpose; nested package/service actual instructions; `.env.example` безопасные placeholders/comments, required/optional/default/type/loading contract. Dynamic bindings trace or explicit unresolved blocker. Не переписывать architecture/spec/roadmap wholesale и не придумывать «бардак» по отсутствующим файлам.

**Gates:** inspected existing `pnpm docs:inventory`, `pnpm docs:check`, `pnpm docs:rename:check`, `pnpm docs:link:sync`, `pnpm docs:test`; rerun changed config-owner tests и safe examples. Commands requiring secrets/live runtime не запускать без specific authorization, mark unverified. Link sync/governance mutations заранее inspect; нет duplicate governance tool. **Review Focus:** first-party exhaustive coverage vs changed scope, zero real .env exposure, proposal описана future. **Completion:** owner/disposition/source-anchor/verification table, all required docs gates либо explicit blockers; missing actual docs не PASS.

## 14. Task11 — полный matrix, authorized integration и независимая acceptance

**Deliverable:** evidence release tooling готово к ручной invocation, **без** автоматической публичной production publication. **Depends on:** Tasks0–10 с закрытыми load-bearing prerequisites. **Modify:** release tests/implementation только при выявленном дефекте; evidence local outside tree, canonical docs status/governance по правилам repo. **Test:** full modules + actual source matrix + individually approved staging test scope.

**Interfaces:** execution ledger/task reviewed SHAs/integrated SHA/workflow/config pins → final evidence; independent `ebb-final-review` → acceptance blockers. Full matrix below не сокращается только потому, что scripts новые.

1. Выполнить full release suite: `node --test scripts/release.test.mjs scripts/release/*.test.mjs` (shell glob не пользовательский input; portable package registration must resolve via inspected Node test runner conventions), actual docs/skills tests и `pnpm lint`, `pnpm typecheck`, `pnpm test`, applicable builds/E2E/recovery/security. CI exact source/candidate on Linux Node24/26, Windows/Linux native/keyring и CodeQL обязательны по map.
2. Каждый publication/deletion boundary fault-injection с before-request, after-remote-success, lost response, crashed checkpoint, retry; expected immutable IDs/stage/PARTIAL и terminal postconditions. Отдельно source/master drift, duplicate trusted writer, root/no parent, later parent, no-reuse после удаления, corrupted transfer/lost cache, wrong SHA/skipped/missing platform, package download restriction/no count/server refusal, shared manifests, protected update refusal, public visibility failed, unsafe path/no secrets.
3. Approved staging acceptance repository/registry имеет exact disposable identities и deletion rights; approval lists all artifacts/refs/images/cleanup. Никакой staging deploy/runtime. Если scope не разрешён или provider restriction мешает tests — BLOCKED нужного capability, не выдавать mock за live PASS. Retire legacy/protected-root creation/atomic ref behavior проверяются на actual allowed settings без broad bypass.
4. Verify real manual validation workflow consumes pinned candidate/source, output IDs correct, full matrix including push-only native Linux and Windows helper. Проверить original audit failure scenarios upstream-failure/audit-failure/install-failure/cancel-before-audit сохраняют ожидаемые outcomes/evidence; live cancellation test specific allowed scope. Test Docker publication/readback/delete только authorised disposable registry identities.
5. Independent reviewer отдельно оценивает policy/tool/CI/image ownership/permissions и report. Controller integrates approved task changes через squash→develop, записывает новый integrated SHA; meaningful changed-source gates rerun на этом SHA, старый task SHA не переименовывается в integrated evidence.

**RED:** любой обязательный prerequisite/run absent/skipped/wrongSHA/failed, remote refused mutation или retained target version → acceptance fails/BLOCKED, не done. **GREEN:** full fresh evidence + unresolved findings=0; verified cleanup staging/candidate refs и no production release. `git diff --check`, `git status --short`, intended changes committed/integrated в разрешённом scope; unrelated data preserved.

**Completion:** independent review signed evidence, Task8 fully bound reviewed config без null/pending trusted identities и documented READY_FOR_MANUAL_RELEASE только при всех checks. Task2 schema/bootstrap → Task8 final binding → Task11 enablement — обязательная producer/consumer цепочка; pending field или отсутствующий full SHA исключает Plan Complete и public release mutation. Последний production publish требует будущего отдельного invocation/prepare/reservation/version choice/full exact-source evidence/final concrete approval. Этот task его не выполняет. Partial live staging leftovers report exact IDs и next action; нельзя заявить cleanup complete без readback.

## 15. Обязательные gate matrices и final confirmation

| PUBLISH gate owner | Required source/platform evidence из supplied baseline, подлежит actual Task0 binding |
|---|---|
| Quality/security Ubuntu Node24 и Node26 | Frozen install; `pnpm lint`, `pnpm typecheck`, `pnpm test`; `pnpm server:build`, `node scripts/local-user-stdin-smoke.mjs`, `pnpm web:build`; `node --test scripts/security-audit-evidence.test.mjs apps/web/test/e2e/credential-handoff.test.mjs`; dependency audit/evidence upload/explicit failure; diff integrity; Playwright Chromium/browser E2E. |
| Native Windows Node24 | Visual Studio2022 C++ helper build `pnpm --filter @ebb-orchestrator/server build:windows-run-supervisor`; provider-free native process-scope acceptance with `EBB_RUN_NATIVE_SCOPE_ACCEPTANCE=1`. |
| Native Linux Node24 | Existing selfhosted systemd/cgroup-v2 label/prerequisites and native process-scope acceptance. Сейчас PUSH-only; trusted manual validation обеспечивает exact-SHA coverage до approval. |
| OS keyring Linux/Windows Node24 | `node --test scripts/keyring-acceptance.test.mjs`; `pnpm exec tsx apps/server/scripts/keyring-smoke.ts`; real OS store, без secrets в artifacts. |
| CodeQL Ubuntu | Existing JS/TS build-mode none analysis and exact source/run metadata; preserve schedule/push/permissions. |
| Governance/release/Docker | Actual docs/skills existing gates; every release module/CLI regression; configured image/platform build+smoke/version/labels/digests/public metadata; all actual mandatory DB/security/Web/recovery gates for affected scope. |

Ни один из этих runtime commands не запускался при подготовке архива; snapshot имеет только manifest/workflow объявления. Task0 привязывает exact implementations/check IDs/cwd. Node26 scope не уменьшать из-за Node>=24.15 minimum. Новые macOS/arm64 requirements вводить только по reviewed actual release scope, не invent.

WITHDRAW matrix: trusted release-tool regressions (policy/reservations/snapshot/journal/provider/operations/CLI), exact target/root-or-parent provenance, surviving publications если parent есть, current permissions/ruleset/deletion layout/eligibility evidence и fresh configured local/CI safety checks. Defect target app matrix не требуется зелёным; withdrawal не запускает БД/deployment. Unknown download count раскрывается, provider refusal stops before Release/refs. Полный action inventory/ownership нужен до первого удаления.

Final publish confirmation показывает real repository/visibility/namespaces, mode/version/operation, source/candidate SHA/tree, previous master/ABSENT, exact annotated tag, Release/assets checksums, every image package/version/platform/digest, public visibility, tested matrix/run IDs, reservation proof, policy/inventory/gates hashes, temporary refs/cleanup и irreversible consumed version. Withdrawal confirmation показывает exact удаляемые identities, parent/ABSENT, surviving items/ownership, known restrictions и eligibility uncertainty. Approval после всех соответствующих mode gates/final review; изменённый bundle требует новый receipt.

## 16. Зависимости, BLOCKED и self-review

Последовательность: Task0 → Task1 (включая initial legacy transition) → Task2 → Task3 → Task4 (snapshot+journal) → Task5 → Task6 → Task7 → Task8. Task9 зависит также от approved external Docker work; Task10 использует актуальные contracts и может документировать blockers; Task11 требует закрытия всех load-bearing prerequisites. После stable scopes часть independent test fixtures/docs content может идти параллельно в лимите двух subagents; shared module/config/workflows commits не редактируются одновременно.

Обязательные BLOCKED cases: actual source/scoped authority absent, no exact command bindings, existing production/history conflicts с zero-baseline transition, master unique commits/unpreserved data, settings/permissions refusal, no reservation/no-reuse proof, unsupported atomic policy, Docker prerequisite/image ownership unresolved, missing runner/platform/check, untrusted workflow identity, provider eligibility known restriction, shared target deletion ambiguity, lost operation identity/cache not recoverable. Не лечить blockers ручными destructive commands, пропуском tests или broad bypass. Controller фиксирует owner/next concrete action, продолжает независимую authorized работу и не задаёт «continue?» на каждом шаге.

Self-review: все новые seam producers перечислены до consumers; Task0 binds неизвестные original symbols; source/task/integrated/candidate SHA разделены; reservation precedes pin; PUBLISH vs WITHDRAW matrices различаются; master retirement отдельный с fresh proofs; first root и root deletion covered; every remote boundary имеет journal/fault injection; no-reuse survived total public deletion; single trusted workflow serialization не обещает API fencing/cross-system atomicity; original CI/audit сохранены; Docker dependency не invented; actual README/env audit поручен content owner; package manifest merge минимален; staging/production actions не implied tests. Archive не является implementation evidence.
