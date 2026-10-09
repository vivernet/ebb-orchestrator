---
id: proposal-15
kind: proposal
title: macOS production process containment for Plan20 Task5A-M
status: draft
created: 2026-10-09
updated: 2026-10-09
---

# Proposal 15 — macOS production process containment

> **Статус:** design draft для независимого архитектурного/security review и последующего решения пользователя. Это не implementation plan и не разрешение на production implementation. Никакой из вариантов ниже ещё не принят.

## 1. Цель и границы

Определить проверяемую Darwin-native основу Plan20 Task5A-M, которая позволяет Ebb Orchestrator работать на macOS наряду с Windows и Linux и сохраняет существующий lifecycle contract Run: durable ownership до dispatch, безопасное обнаружение после рестарта Orchestrator, точное подтверждение остановки прежнего process scope до cleanup/recovery и fail-closed поведение при любой неоднозначности.

Task5A-M — provider-free foundation. Она не доказывает Hermes provider/auth readiness, `session_id` capture или same-session resume. Эти проверки относятся соответственно к Task5B-M и Task5C-M.

Не входит в этот draft:

- изменение Windows/Linux process contracts или их CI;
- изменение host ACL/owner или инвентаризация разрешений;
- выбор или настройка второго provider, Ebb credential store либо `.env` credential mapping;
- использование недокументированного/private SPI как production dependency;
- изменение существующего Hermes auth ownership: provider credentials и их разрешение принадлежат Hermes;
- утверждение, что Local Mode является OS sandbox против hostile same-user/admin;
- изменение `context_hash`, восстановление неизвестного session ID или ослабление `STOPPED` до проверки PID/PGID снимка.

## 2. Архитектурные требования и проверяемый контракт

1. **Durable before dispatch.** Для каждой generation существуют атомарно сохранённый owner и correlation tuple до любого системного dispatch. Запись включает Run ID, generation, attempt, launch nonce, состояние, точный OS boot-session identity, выбранный containment kind и все используемые native object/configuration identities. Операция dispatch не повторяется автоматически после неопределённого результата.
2. **Единственный владелец OS state.** Platform adapter выполняет launch/inspect/stop; RunService/owner repository сохраняет детерминированный доменный lifecycle через CAS. Ни stdout/stderr, ни UI, ни Hermes model output не становятся доказательством OS state.
3. **Restart-inspectable identity.** Новый процесс Orchestrator, не унаследовавший file descriptors или in-memory handles, должен определить ровно один исходный owner либо вернуть `UNKNOWN`. PID, process name, label, отсутствие процесса в одной выборке или отсутствие service entry отдельно недостаточны.
4. **Authoritative STOPPED.** Доказательство покрывает весь исходный scope, исключает поздний/повторный dispatch исходной generation и привязано к Run/generation/attempt/containment ID/nonce и boot identity. Оно должно пережить процессный restart и оставаться неизменяемой историей. Кандидат, где child может detached/escaped scope, не соответствует контракту.
5. **Interruption safety.** До owner preflight нельзя выполнять recovery callbacks, terminalize Run, освобождать capability/reservation, чистить profile/source snapshot или запускать новую generation. Любой unknown owner, отсутствующая запись, boot/identity mismatch, недоступный OS manager, timeout, parser drift или CAS conflict оставляет ресурсы удержанными и переводит recovery в `UNKNOWN`/`DEGRADED`.
6. **Generation isolation.** Старое доказательство STOPPED относится только к старой generation и не разрешает cleanup объектов новой generation. Same-Run resume остаётся Task5C и использует исходный durable Hermes `session_id`.
7. **macOS is required.** Успех Windows/Linux не закрывает Darwin. Task5/Plan20 остаются incomplete до macOS Task5A-M, 5B-M и 5C-M.

## 3. Текущее состояние

Существующая production composition выбирает Windows Job Object на Windows и systemd user service/cgroup v2 на Linux. На Darwin composition пока использует unsupported supervisor; RunService не создаёт Darwin containment kind; native-helper launcher и Hermes source snapshot/build принимают только Windows/Linux. Это зафиксировано в:

- `apps/server/src/platform/home/production-composition.ts` — `createPlatformSupervisor`;
- `apps/server/src/modules/runtime/run-service.ts` — `currentContainmentKind`;
- `apps/server/src/platform/process/native-helper-launcher.ts`;
- `apps/server/scripts/build-hermes-profile-path.mjs` и `apps/server/scripts/package-native-assets.mjs`;
- `apps/server/src/modules/runtime/hermes/hermes-source-snapshot.ts`;
- `apps/server/test/e2e/hermes-process-scope.acceptance.test.ts` и `apps/server/scripts/test-hermes-profile-path-native.mjs`.

`app-config.ts` перечисляет `darwin` в типе платформ, но это не означает production runtime support. `main.ts` ещё передаёт Linux home-kind для любой платформы, кроме Windows; это требуется отдельно исправить и покрыть проверкой до Darwin readiness.

Plan20 §5A-M уже задаёт последовательность design → независимый review → implementation/native/package/CI → 5B-M → 5C-M. `docs/architecture/proposals/14-macos-coalition-phase2-feasibility.md` описывает только bounded provider-free feasibility fixtures. Hosted Phase2 17/17 PASS относится к одному конкретному macOS build и тестовой coalition; документ оставляет `platformReadiness=NOT_CLAIMED`, `productionPackaging=NOT_RUN`, `fullABICompatibility=NOT_CLAIMED`. Эти результаты — вход для исследования, не production contract и не основание включать приватный ABI в runtime.

## 4. Рассмотренные варианты

### Вариант A — per-Run launchd LaunchAgent и process group

**Модель.** Для каждой generation Ebb регистрирует отдельный `launchd` job в точном пользовательском domain, с уникальными label и одноразовой launch policy. Перед dispatch Ebb durable-CAS публикует owner; supervisor выполняет `bootstrap`, exact readback, одноразовый `kickstart`, затем bind-ит запущенный root. `KeepAlive=false`, `RunAtLoad=false`, без demand triggers, `LaunchOnlyOnce=true`; повторная dispatch старой generation запрещена. При остановке supervisor закрывает dispatch, просит launchd завершить job и ждёт подтверждённого завершения.

**Durable owner identity.** Минимальная candidate identity: `run_id`, generation, attempt, nonce, `uid`, точный launchd domain, уникальный label, boot-session ID, точный plist path плюс nofollow object identity/digest, first-party launcher executable identity/digest, immutable argv/policy digest, dispatch state/revision. Новый Orchestrator обязан проверить exact owner row, launchd registration/job readback и все immutable bindings заново. Launchd plist и job label сами по себе не являются доказательством STOPPED.

**Преимущество.** Использует штатный macOS service manager и public/documented `launchctl`/Service Management model; низкая стоимость внедрения относительно VM; есть durable OS-visible service identity и no-replay policy. Apple документирует LaunchAgents для процессов текущего пользователя и job label/status.

**Фатальное ограничение для текущего требования.** Документированный `AbandonProcessGroup=false` behavior убивает после смерти job только оставшиеся процессы с **тем же PGID**. Процесс, который вызывает `setsid`/меняет группу или иным образом уходит из PGID, не покрыт этим доказательством. Hermes/tool subprocesses нельзя считать не способными к daemonize/detach. `launchctl bootout`/отсутствующий job доказывают изменение job registration, а не смерть любого detached child. Enumeration процесса или повторные process table/PGID snapshots не устраняют гонку fork и не становятся authoritative stop.

**Failure modes.** PGID сменился; fork произошёл между snapshot и stop; root умер до подтверждённой binding; label переиспользован/не совпал с exact plist; старый launchctl executor ещё может выполнить kickstart; OS boot identity изменилась; launchd parser/API недоступен; менеджер вернул неизвестную state signature; job исчез, пока child жив. Каждый такой случай — `UNKNOWN`, без fallback на PID/PGID.

**Оценка.** Подходит только если runtime/продуктовый контракт ограничит child processes и докажет, что detach невозможен для всех Hermes tools и user workloads. Это новое ограничение функциональности и не рекомендуется для полного coding-agent use case. Не принимать как эквивалент Job Object или cgroup v2.

### Вариант B — launchd-managed resource coalition

**Модель.** Запускать каждую generation как отдельный launchd job и проверять kernel-owned resource-coalition membership, наследуемую дочерними процессами. Коалиция потенциально охватывает fork/exec/posix_spawn и descendants, которые меняют PGID; durable owner привязывает boot ID, точный launchd job, coalition ID и generation. Stop требует закрыть повторную dispatch, остановить/сигнализировать все точные members и получить доказательство завершения всей коалиции.

**Преимущество.** Pinned XNU coalition document описывает неизменяемое наследование membership через `fork`, `exec`, `posix_spawn`, непереиспользуемые coalition IDs и связь coalition с launchd job — это ближе к требуемому scope, чем PID/PGID.

**Ключевой production blocker.** Тот же XNU документ прямо говорит, что `coalition_create`, `coalition_terminate`, `coalition_reap` и `posix_spawnattr_setcoalition_np` предназначены для launchd/XNU tests, а не для обычного приложения. Для production реализации ещё не установлен поддерживаемый Apple public API/ABI, который позволяет Ebb достоверно перечислить, адресно остановить/закрыть spawn race и после рестарта доказать terminal/empty state. Использование private SPI/raw syscall/task-for-pid/privileged entitlement/root было бы отдельным security/API решением и не разрешено этим draft.

**Durable owner identity.** Если supported contract будет найден, owner должен содержать launchd domain/label и exact job digest, coalition ID как decimal string, boot identity, kernel-bound root identity (PID + unique/pidversion/audit token при необходимости), generation/attempt/nonce, source/helper identity, launch policy и durable state revision. Все volatile bindings из старого процесса после restart перечитываются и повторно связываются с exact immutable owner. Не backfill-ить null поля из одного process listing.

**Failure modes.** Нет public coalition query/termination на target macOS; manager job label не соответствует сохранённой coalition; reboot/source update invalidates ABI assumptions; coalition entry неполна/недоступна; spawn/termination race; helper dies до state commit; coalition ID отсутствует или двусмыслен; counters/query ABI изменились. В каждом случае `UNKNOWN`; не делать PGID/PID fallback.

**Оценка.** Только research candidate. Proposal14 Phase2 подтверждает bounded fixture feasibility на записанном build, включая отдельные fixture scenarios; он не подтверждает production entitlement, public API, packaged helper, supported OS matrix, SQLite persistence или live Hermes. Этот вариант не может быть выбран до установления supported production contract и независимого architecture/security review. Этот draft не предлагает использовать private SPI.

### Вариант C — per-Run VM через Virtualization.framework с постоянным host owner

**Модель.** Выполнять Hermes и все Run subprocesses в отдельной macOS guest VM на generation. Отдельный first-party host manager/helper, запущенный штатным launchd user service, владеет `VZVirtualMachine`, durable VM configuration и RPC lifecycle; Orchestrator обращается к нему по authenticated local IPC. Секреты и provider config не читаются/копируются Orchestrator: точный механизм доступности Hermes-owned auth для guest должен остаться в design gate. VM не заменяет Task5B Hermes profile/auth acceptance.

**Durable owner identity.** Перед VM start: SQLite owner CAS + fsync journal с Run/generation/attempt/nonce, boot-session ID, unique VM UUID, exact guest image and VM configuration digest, immutable bundle/disk object identities, launchd helper domain/label, helper binary/code-signing identity, IPC endpoint object identity и lifecycle state. Manager подтверждает running VM и bound VM UUID/config через RPC, после чего durable callback записывает identity и разрешает payload. После Orchestrator restart helper перечитывает durable owner и отвечает только за exact VM. Если helper уже недоступен или не может доказать, что связанный VM остановлен, recovery — `UNKNOWN`.

**STOPPED.** Для запущенного manager instance — await успешного `VZVirtualMachine.stop()` completion и повторного `VZVirtualMachine.state == .stopped`, затем durable STOPPED CAS с тем же Run/generation/attempt/nonce/VM UUID/config digest. Stop — destructive и не обещает guest graceful shutdown. VM boundary останавливает guest execution независимо от process groups внутри guest. Для helper/process crash требуется отдельный native acceptance, доказывающий, что VM execution не переживает потерю helper и что новый manager не может создать duplicate/restore прежнюю generation. Нельзя считать VM plist исчезновение, PID death helper или сам ответ IPC достаточными без этого proof.

**Преимущество.** Публичный Virtualization.framework имеет documented VM lifecycle/state/start/stop APIs и выполняет гостевые процессы внутри VM boundary, поэтому не зависит от POSIX PGID semantics. Apple документирует запуск Linux guests на Apple Silicon и Intel, а macOS guest — на Apple Silicon; framework требует virtualization entitlement. Следовательно, macOS-guest вариант C является только arm64 candidate. Linux guest на Intel нельзя считать эквивалентным запуску macOS workload: tool/runtime/workspace/auth semantics требуют отдельного product design.

**Риски/стоимость.** Существенная смена product/runtime architecture: VM boot/storage overhead, guest image lifecycle, shared workspace semantics, Hermes bootstrap and auth continuity, provider token refresh, IPC, VM cleanup and upgrade. `VZVirtualMachine.stop()` действует на объект в живом controller; public attach/lookup уже работающей VM после полного падения owner process не доказан. Требуется постоянно живущий manager с durable journal либо acceptance, доказывающий automatic VM termination на helper crash. GitHub документирует стандартные macOS hosted runners как M1 arm64 VM и указывает, что nested virtualization на arm64 macOS runners не поддерживается. Поэтому hosted runner подходит для обычных Darwin native tests, но не считается доказательством запуска production macOS guest VM. VM acceptance потребует отдельно проверенного physical/self-hosted Apple Silicon host либо другого production design; добавление self-hosted runner требует отдельного operational/security design и не предполагается автоматически. Не переносить production key/provider credentials в Ebb; guest auth path должен использовать уже настроенный Hermes source и пройти отдельный review.

**Оценка.** Единственный из перечисленных публично документированных вариантов, который потенциально сохраняет строгую границу для detached guest processes. Рекомендуется как первый supported-API feasibility target, если Task5A-M обязана обеспечивать тот же full-scope STOPPED, что Windows/Linux. Это пока условная рекомендация, не production approval: design gate блокируется, если нельзя доказать manager crash/restart recovery, auth boundary или hosted/native CI capability без изменения пользовательского продуктового контракта.

## 5. Рекомендуемая позиция и decision gate

Сохранять требование Windows/Linux/macOS и неизменный строгий `STOPPED` контракт. **Не выбирать вариант A как production equivalent**: процессная группа не покрывает detached descendants. **Не выбирать вариант B на основании Proposal14**: Phase2 fixture не превращает launchd-only coalition internals/private ABI в supported product API. **Первым проверить вариант C как публичную containment boundary**, включая его owner/restart и Hermes auth costs. Параллельно разрешить независимое исследование public launchd/coalition management contract; private SPI не может быть скрытым dependency или fallback.

Результат feasibility/design review должен завершиться ровно одним из следующих выводов:

1. `SUPPORTED DESIGN`: выбран public/reviewed механизм, все acceptance gates §10 выполнимы на поддерживаемых macOS versions/architectures, owner/restart and STOPPED доказуемы; тогда подготовить dependency-ordered Task5A-M implementation plan.
2. `DESIGN CHANGES REQUIRED`: остались технически разрешимые design gaps; исправить их и повторить независимый review без production implementation.
3. `NO SUPPORTED IMPLEMENTATION`: ни один вариант не обеспечивает contract с supported API и приемлемой Hermes auth boundary. Остановить macOS implementation и представить пользователю конкретное продуктовое решение; не ослаблять STOPPED автоматически.

## 6. Boundaries, ownership и launch protocol

- **RunService + durable owner repository:** sole owner of Run/generation/attempt CAS, containment kind, state and terminal proof; platform adapter cannot mutate Run state directly.
- **Darwin supervisor/native host helper:** owns launchd/VM side effects, OS state inspection and exact stop operation; reports typed bounded evidence. It must not own orchestration decisions, Scheduler/reservation state or provider secrets.
- **SystemLifecycle/ProductionComposition:** exact startup order stays instance lock → DB/migrations → RECOVERING → owner preflight → Project Config integrity → outbox/jobs/artifacts/other reconcilers → workers → READY. A Darwin UNKNOWN blocks all later recovery callbacks and Run dispatch.
- **Task5B Hermes adapter:** may read only supported explicit non-secret Hermes selection and invoke Hermes using Hermes-native configured auth. Ebb does not read credential values, copy keys, invent `.env` mappings or infer provider configuration from runtime output.
- **Native protocol:** bounded versioned typed framing over a private local IPC endpoint; fixed allowlisted messages only (`READY`, `BOUND`, `STOP_REQUEST`, `STOPPED`, `ERROR`). Correlate every frame with generation/attempt/nonce and expected durable revision. Authenticate peer by supported OS identity/code identity. No prompt, raw stdout/stderr, provider credential, token or arbitrary process output enters protocol logs/DB/artifacts. ACK is allowed only after awaited durable owner identity readback.
- **Dispatch barrier:** PREPARED is fsynced/read back before service bootstrap/VM start. Only one dispatch attempt per generation. LAUNCHING with uncertain dispatcher/job/VM state stays UNKNOWN; recovery does not issue a second kickstart/start.

Exact IPC API, identity checks, service packaging and error vocabulary are implementation-plan outputs after the selected platform mechanism has passed design review; these are not implied by this draft.

## 7. Durable state and failure/recovery model

Candidate logical states, independent of chosen native mechanism:

`PREPARED → LAUNCHING → BOUND → RELEASED → STOPPING → STOPPED`

Terminal/non-running auxiliary results:

- `NEVER_LAUNCHED`: only if PREPARED plus exclusive durable owner and settled executor prove native dispatch did not happen;
- `UNKNOWN`: durable last state retained on missing row/object, corrupt journal, boot/identity mismatch, service/VM ambiguity, parser drift, unavailable API, timeout, incomplete stop or CAS failure.

Rules:

1. The adapter confirms exact manager/VM configuration after pre-dispatch binding and before payload release.
2. A process may not execute payload before owner identity has been committed and read back.
3. After restart, preflight discovers all nonterminal Runs and verifies their owner; no active Run may lack an owner row. It inspects the exact durable service/VM object rather than enumerating unrelated host processes/jobs.
4. On `BOUND`/`RELEASED`, recovery asks the same owner to stop and waits for its platform proof. It does not launch a new generation or Hermes while old STOPPED is unknown.
5. `STOPPED` is recorded only from a source-defined, fresh owner proof tied to exact old generation; a later independent cleanup-boundary check revalidates private objects before deletion.
6. Boot identity mismatch permits STOPPED only if the selected platform design proves a host reboot necessarily destroyed the old execution boundary. Otherwise it is UNKNOWN.
7. Helper crash, Orchestrator crash, machine reboot, power loss, partially written owner, stale IPC, concurrent recovery, stop timeout and controller shutdown each have independent fault injection cases. Cleanup is never a substitute for evidence.

## 8. Security, path identity, packaging and source integrity

- Preserve Proposal13: existing host ACL/mode, owner and foreign grants are not an admission predicate; no host permission inventory or mutation. Tests may create/change only disposable objects they own.
- Every Ebb-private root, launch descriptor, helper, plist/VM bundle, configuration, socket and source snapshot is opened/checked nofollow and bounded. Tie pathname to immutable file/object identity, size/content digest and expected parent; retain file handles/leases across the launch/stop boundary where available. Revalidate immediately before dispatch and at cleanup; path replacement, symlink, hardlink policy violation, rename race, digest mismatch or inaccessible identity fails closed.
- `launchctl`/ServiceManagement/Virtualization output is not itself authority. Parsers are bounded and versioned; unsupported OS build or unrecognized response is `UNKNOWN`, never “not found” by substring.
- Package first-party Darwin native helper(s) per supported architecture. Build must fail closed without the expected Apple Clang/Xcode SDK and must record exact compiler, SDK, deployment target, OS build, architecture, helper digest, signing/entitlement identity and package manifest on every acceptance source SHA. Do not package a helper for the wrong host/guest architecture or use `macos-latest` as an unpinned compatibility identity.
- If using Virtualization.framework, record and validate `com.apple.security.virtualization` entitlement in the delivered helper/app; no silent fallback to uncontained host execution if entitlement, host capability, guest image or shared-folder policy is unavailable.
- Threat boundary: Local Mode does not claim protection against hostile same-user/admin/kernel principals. Stop proof is for Ebb’s exact OS-owned generation; it does not imply a general OS sandbox or prevent user-authorized host processes outside the generation.

## 9. Persistence and migration invariants

Any Darwin owner-schema change is additive and versioned in a new forward migration. Do not alter migrations 037/038 in place, reinterpret Windows/Linux fields, fabricate historical Darwin identities, or silently backfill missing owner/session values. Define typed containment kind and nullable native identity fields only after option selection; store 64-bit IDs as decimal text if JavaScript safe integer precision is not guaranteed. Update migration catalog, domain validation, repositories, startup preflight, and rollback/recovery tests together.

**Mandatory preservation invariant:** preserve every existing `context_deltas` row and its diagnostic-only meaning, table/index/root-page behavior where required, both existing foreign-key targets and their exact `ON DELETE` semantics. Do not rebuild/copy `context_deltas` as part of a Darwin migration. Verify populated upgrade and fresh install with ordered migrations and `PRAGMA foreign_key_check`; compare row values/counts, both FK definitions/delete actions, indexes, and deletion behavior before/after. If no Darwin schema field is necessary, do not add a migration solely to label platform support.

## 10. CI and acceptance matrix

The current `.github/workflows/macos-runtime-feasibility.yml` is fixture-only; it must remain explicitly named and reported as feasibility. It does not run production server tests and cannot satisfy Task5A-M. Add production Darwin jobs to `.github/workflows/production-gates.yml` only in the same implementation tranche that supplies the selected production adapter and real provider-free tests; a workflow that builds only the feasibility fixture would be hollow evidence.

### Hosted runner matrix

Пользователь 2026-10-09 подтвердил продуктовую матрицу: **macOS 13.5+ на Apple Silicon (arm64) only; Intel/x86_64 is out of scope**. Минимум 13.5 согласован с `package.json` (`Node >=24.15`) и официальным минимумом Node 24 для prebuilt macOS binaries. Более старые macOS потребуют отдельного Node distribution/source-build contract и не входят в утверждённую матрицу.

| Tier | Runner coverage | Required evidence |
|---|---|---|
| Every production PR/push | Apple Silicon arm64 on the oldest supported macOS version. Pin version labels, not `macos-latest`. | Native helper build/package, process-scope acceptance, path/source acceptance, owner restart/recovery and startup ordering. |
| Current-release compatibility | Latest supported macOS release on Apple Silicon arm64; run on every production PR if capacity allows, otherwise as a required scheduled/release gate with a fresh source SHA. | Same required native contracts and package/source identity. |
| Feasibility | Existing `macos-runtime-feasibility.yml`, exact OS build/source SHA. | Fixture-only report; never production readiness. |
| Live provider/recovery | Separate user-authorized execution under the already configured Hermes provider/auth. | Task5B live session capture and Task5C same-Run/session restart/recovery; do not put provider credentials into hosted CI or replace with seeded/mock cases. |

GitHub currently documents standard Apple Silicon arm64 runner labels starting at `macos-14`; `macos-15` is a supported pinned label. There is no documented standard hosted label for the approved minimum macOS 13.5, so testing the oldest supported OS requires a separately managed physical/self-hosted Apple Silicon runner (or another reviewed host arrangement); a `macos-15` pass cannot prove 13.5 compatibility. Pin the verified label and assert `uname -m == arm64` in hosted production jobs. GitHub also documents that nested virtualization is not supported on arm64 macOS runners. Hosted `macos-15` can verify ordinary Darwin native behavior, but any test that boots a macOS guest VM needs a separately verified execution host/capability. Confirm labels, image availability, Apple entitlement and virtualization support at implementation time; labels and supported runner images change. If a required host capability is unavailable on hosted runners, use an explicitly approved and documented self-hosted gate or report that gate NOT RUN; do not skip it or infer readiness from another architecture.

### Provider-free Task5A-M acceptance

Implementation plan must name concrete tests/scripts and exact commands, with no skip on unsupported Darwin CI. At minimum:

1. Platform factory selects the Darwin adapter and Darwin orchestrator home correctly; unsupported platform values fail closed.
2. Build/package: expected native architecture and compiler/SDK; signature/entitlement and helper source digest; tampered/missing/misarch helper rejected.
3. Owner state: PREPARED fsync/readback before dispatch; exact durable binding before payload; CAS concurrency; no duplicate dispatch; exact cleanup generation binding.
4. Scope coverage challenge: child fork, exec, posix_spawn, double-fork, setsid/process-group change and crash while detached child is live. Each proves the selected mechanism still stops every member; otherwise test must fail and owner stays UNKNOWN. A PID/PGID snapshot test cannot be accepted as full scope proof.
5. Authoritative stop: supervisor/root crash before binding, after binding/before ACK, after ACK, during stop, stop timeout, machine boot change, stale label/object, stop race with a new spawn, unrelated sentinel remains alive; positive evidence that the target scope was live before stop and exact full-scope STOPPED after it.
6. Restart: independent Orchestrator process recovers exact old owner; missing/corrupt/mismatched owner, unavailable manager, changed source identity and unresolved prior LAUNCHING stay UNKNOWN; no callbacks/worker dispatch/release happen before all owners pass preflight.
7. Filesystem/source: nofollow/object identity; symlink/hardlink/path traversal, replacement, rename, cross-volume/device, digest, lease/GC cleanup races; cleanup only after STOPPED and fresh identity check.
8. No secret transport: no credential path/value in arguments, environment, journal, logs, artifacts or test output. Provider-free fixture carries harmless payload only.
9. Migration: fresh install and populated upgrade as §9 defines; preserve all `context_deltas` rows/FKs/actions. Tests must not be seeded-only evidence for old durable state.

### CI job behavior

- Add one native macOS production job per required matrix entry, wired to the same production PR (`master`) and push (`master`/`develop`) boundary as current production gates. The Linux process gate is currently push-only, so ensure PR coverage for macOS instead of inheriting that gap.
- Install frozen Node/pnpm dependencies; record `sw_vers`, build, `uname -m`, Xcode/SDK/Clang identity; compile all Darwin helpers; validate actual package manifest and generated helper integrity anchors.
- Run named provider-free Task5A-M tests with exact exit codes; run scoped and full quality gates from the repository policy. Any prerequisite/entitlement/native API/parser/coverage failure is failed or NOT RUN, never PASS.
- For VM option, verify the actual execution host before implementation. GitHub-hosted arm64 macOS runners document nested virtualization as unsupported, so do not assume that they can run the production guest VM. Guest start/stop, helper/controller crash, workspace sharing, repeat generation and stop proof must execute on a host that supports the selected public virtualization API; nested virtualization support is additionally required only if the execution host is itself virtualized. Compile-only checks are insufficient. If this requires a physical/self-hosted Mac, obtain the product/operations decision and document the runner's trust boundary before adding it.
- Retain bounded JSON artifact with source SHA, runner OS/build/arch/SDK, helper digest, scenario-level results, per-step exit codes, source/tool identities, cleanup result and all unrun scenarios. Never include secrets, raw environment, prompts, full paths outside controlled test fixtures, or unrestricted launchctl output.

## 11. Task5B-M and Task5C-M dependency boundaries

### Task5B-M — Hermes profile/auth and live session capture

Begins only after Task5A-M provider-free native/package/CI gates and fresh process-scope/security review pass. It verifies the exact supported Hermes version/command/source and selected configured non-secret provider/model/endpoint identity; auth continues to be resolved by Hermes from the already configured Hermes-owned provider. It verifies isolated per-Run profile/source integrity and no Ebb credential reads/copies, then performs a real user-authorized provider request and proves one correlated allowlisted `system/init.session_id`, RunService CAS, durable SQLite readback while scope is live, and readback after Orchestrator restart. Missing/ambiguous source, plugin-backed unsupported auth path, provider failure or session mismatch is NOT VERIFIED; mocks/fixtures remain protocol tests only.

### Task5C-M — same-Run/session recovery

Begins only after fresh Task5A-M and Task5B-M evidence. It requires durable original Hermes `session_id`, source/fingerprint/workspace identity, exact previous generation stop proof, exclusive recovery CAS and Scheduler/capability/budget/lock gates. After Orchestrator restart, exactly one provider-backed resume uses the same Run and original session, rotates to a new durable generation, and releases no old owner/capability/reservation before authoritative STOPPED and normal reconciliation. Run independent recovery, code and architecture review. No replacement Run, guessed session, mock resume or PID/PGID fallback.

## 12. Readiness and closure criteria

`macOS production readiness` may be claimed only when all are true:

- selected public/reviewed native design has no unresolved blocking architecture/security finding;
- exact supported OS version and CPU architecture matrix is approved and has fresh passing native/package CI evidence on each required entry;
- `main.ts`, platform-home resolution, production composition, RunService containment kind, helper launch/integrity, source snapshot/profile cleanup and package paths all have Darwin implementations and fail-closed unsupported behavior;
- PREPARED→LAUNCHING→BOUND→RELEASED→STOPPING→STOPPED and every interruption/restart path has independent native evidence; no scenario equates PID/PGID/job absence with full STOPPED;
- startup recovery preflight precedes every reconciliation/worker callback;
- schema changes pass populated/fresh migration checks and preserve `context_deltas` exactly;
- Task5B-M real configured-provider live capture and Task5C-M same-Run/session restart/recovery pass with exact-source evidence and independent review;
- no provider credentials, raw output or secrets appear in persisted state/artifacts/logs;
- clean current-HEAD quality gates, `git diff --check`, final security/recovery/architecture reviews pass, and Plan20 checklist/status is reconciled afterward.

Task5A-M alone is never Plan20 completion or provider readiness. The feasibility workflow is not production evidence.

## 13. Remaining evidence and decisions

The following are **technical evidence tasks**, not questions for the user: independently prove VM/helper crash and restart semantics; verify whether an approved public coalition management API exists on the eventual support floor; confirm native host capabilities on GitHub's arm64 runner and guest-VM behavior on a host that supports the selected public virtualization API (with nested virtualization additionally required only for a virtualized host); establish whether existing typed owner schema is sufficient or a forward additive migration is needed; and prove Hermes-owned auth/workspace compatibility inside any guest. No VM, coalition or migration implementation starts until the evidence and scoped design review close.

### Evidence update — 2026-10-09

Apple DocC availability metadata confirms the base Virtualization.framework lifecycle, macOS guest configuration/boot, and directory-sharing APIs used by the VM candidate are available before the approved 13.5 floor. `saveMachineStateTo`/`restoreMachineStateFrom` are available only from macOS 14, so the minimum-floor design must not depend on those APIs. Apple documents VM `stop(completionHandler:)` as destructive; `requestStop()` is only a guest request. Neither API documentation alone establishes helper-crash termination or durable restart inspection of the exact VM owner.

Current GitHub-hosted arm64 standard and larger-runner labels begin at macOS 14 and do not support nested virtualization. GitHub documents self-hosted macOS ARM64 runners for macOS 11+, but ARM64 remains public preview; this makes a user-managed physical runner technically available for a 13.5 floor, without proving that one is configured or tested. These facts narrow the future CI design but do not select the VM architecture or grant runner operations.

Primary evidence: [Apple `VZVirtualMachine.start`](https://developer.apple.com/tutorials/data/documentation/virtualization/vzvirtualmachine/start(completionhandler:).json), [Apple `VZVirtualMachine.stop`](https://developer.apple.com/tutorials/data/documentation/virtualization/vzvirtualmachine/stop(completionhandler:).json), [Apple save state API](https://developer.apple.com/tutorials/data/documentation/virtualization/vzvirtualmachine/savemachinestateto(url:completionhandler:).json), [Apple restore state API](https://developer.apple.com/tutorials/data/documentation/virtualization/vzvirtualmachine/restoremachinestatefrom(url:completionhandler:).json), [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [GitHub larger runners](https://docs.github.com/en/actions/reference/runners/larger-runners), and [GitHub self-hosted runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners).

Only these are **product decisions** that cannot be derived from repository or API evidence:

1. **Runtime architecture:** whether a per-Run VM is an acceptable product/runtime architecture if it proves to be the only supported mechanism meeting the current strict STOPPED contract. This choice affects startup latency, storage, workspace exchange, packaging, and Hermes-auth availability; it is not implied by the general requirement to support macOS.
2. **CI ownership:** the approved 13.5 floor and current GitHub runner labels require an explicitly managed physical/self-hosted Apple Silicon gate to test the oldest supported macOS version. Decide whether the project may operate such a runner and define its ownership/security boundary before adding it. No self-hosted runner is presumed.
3. **If no supported mechanism can meet the current contract:** decide product scope/containment requirements explicitly. Until then Task5A-M remains blocked; do not silently weaken strict STOPPED to PID/PGID snapshots.

## 14. Primary references

- Repository architecture source: `docs/architecture/specs/01-system-design.md` §§10.2, 13.1, and 13.3 (Local Mode trust and security contract; §16 is Recovery Engine).
- Plan dependency and acceptance: `docs/architecture/plans/20-production-context-manifest.md` §§Task5A-M, Task5B/5C, CI acceptance, and migration invariants.
- Existing approved host-permission direction: `docs/architecture/proposals/13-local-mode-host-permission-compatibility.md`.
- Feasibility only: `docs/architecture/proposals/14-macos-coalition-phase2-feasibility.md`.
- Apple, Service Management / `SMAppService` LaunchAgent registration and status: https://developer.apple.com/documentation/servicemanagement/smappservice
- Apple/OSS launchd `launchd.plist(5)` (job label, KeepAlive/RunAtLoad/LaunchOnlyOnce, `AbandonProcessGroup`): https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5
- Apple, Virtualization framework overview, guest operating systems and entitlement: https://developer.apple.com/documentation/virtualization
- Apple, `VZMacPlatformConfiguration` (configuration for booting a macOS guest on Apple Silicon): https://developer.apple.com/documentation/virtualization/vzmacplatformconfiguration
- Apple, `VZVirtualMachine.stop(completionHandler:)` (destructive stop; guest does not receive a clean-shutdown opportunity; macOS 12+): https://developer.apple.com/documentation/virtualization/vzvirtualmachine/stop(completionhandler:)
- Node.js v22-to-v24 migration notes (Node v24 prebuilt macOS binary floor is macOS 13.5): https://nodejs.org/en/blog/migrations/v22-to-v24
- Apple XNU coalition design, pinned to the exact source revision already used by Proposal14: https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/doc/observability/coalitions.md . It says membership is preserved across fork/exec/posix_spawn and immutable, while coalition create/terminate/reap and set-coalition interfaces are for launchd/XNU tests only. This is source evidence for feasibility, not a public runtime support guarantee.
- GitHub-hosted runner image registry (available macOS labels and architectures; recheck at implementation time): https://github.com/actions/runner-images
- GitHub-hosted runner reference (arm64/macOS labels and nested-virtualization limitation; recheck at implementation time): https://docs.github.com/en/actions/reference/runners/github-hosted-runners

## 15. Review scope

Independent architecture/security review must verify: the strict STOPPED invariant is unchanged; each option's failure modes are correctly represented; launchd PGID is not overstated; private coalition SPI is not treated as approved production interface; the VM choice has a restart/owner proof rather than relying on a live in-memory VM object; startup-order and CAS semantics are complete; Hermes-owned auth remains authoritative; no source/credential leakage is introduced; migrations preserve every `context_deltas` row/FK/delete action; CI matrix matches approved support floor/architectures; feasibility results are not mislabeled production readiness; and no implementation scope is inferred from this draft.
