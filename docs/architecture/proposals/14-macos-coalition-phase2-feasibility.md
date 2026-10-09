---
id: proposal-14
kind: proposal
title: macOS coalition Phase 2 — provider-free feasibility
status: accepted
accepted: 2026-10-09
created: 2026-10-09
updated: 2026-10-09
---

# Proposal 14 — macOS coalition Phase 2

Документ — revised design для independent architecture/security review после B1/B2 CHANGES_REQUIRED. Пользователь разрешил необходимые работы по Goal; independent architecture/security review одобрил этот bounded feasibility spike. Approval ограничен provider-free Phase2 fixture и CI: он не разрешает production port и не является gate evidence. macOS production path сейчас unsupported; migration037 допускает Windows/Linux, а не Darwin containment. Task5A-M/5B-M/5C-M остаются открытыми. Никакого macOS PASS до фактической native evidence.

## 1. Scope, evidence и ownership

Phase 2 проверяет отдельную unprivileged launchd resource coalition, наследование membership, token-bound signals, crash/restart и authoritative STOPPED на контролируемых first-party fixtures. Нет provider/auth/profile/env inspection, host ACL inventory/remediation, root/entitlements, task_for_pid, raw syscall numbers, coalition create/terminate/reap/setcoalition calls, WSL/VM или копирования runtime sources. Local Mode доверяет существующим host permissions; новые fixture objects создаются приватными. Это policy isolation, не OS sandbox против hostile same-user/admin.

Phase1 source SHA: `b0746d413e146292c0dbb01e15050b7ccee20a56`; GitHub run `37881882470`; macOS `26.6.2`/`25G83`, arm64, SDK `26.5`, clang `21.0.0`. Public SDK compile FAIL; SPI compile/export, `proc_pidinfo` 56/40 bytes, task name/audit-token reads и own-child correct-token SIGTERM PASS. Wrong pidversion token return `3` оставил child LIVE. Membership/fullScopeStop/restart/staleAfterExec NOT_RUN. Phase2 design prepared against local HEAD `5bd72ece84ff74a0431718fd6d41b9e949aaf94a`; новые результаты обязаны указывать свой exact SHA.

Apple XNU source pin: `f6217f891ac0bb64f3d375211650a4c1ff8ca1ea`. [Coalitions](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/doc/observability/coalitions.md) описывает immutable fork/exec/posix_spawn membership и non-reused IDs; это source hypothesis, не доказательство поведения произвольного installed kernel.

Approved bounded Phase2 owner получает только `scripts/macos-runtime-feasibility.cpp`, `.mjs`, `.test.mjs` и existing `.github/workflows/macos-runtime-feasibility.yml`. Production native helpers, TypeScript owners, schemas/migrations и Windows/Linux CI остаются вне его scope. Документ не назначает себе их ownership. Native source остаётся first-party fixture, не production supervisor; Phase1 режим сохраняется. Дальнейший production owner отдельно определяет Darwin adapter/helper, package build/install/architecture paths и native source-isolation design.

## 2. Durable owner и состояния

Spike имеет private durable journal; это не изменение SQLite. Перед socket/plist/bootstrap создаётся и fsync-публикуется PREPARED owner в новом private temporary directory. Directory fsync и atomic rename/readback обязательны; crash durability unsupported — FAIL. Journal хранит generation/revision, nonce, boot-session identity, exact uid/domain/label, intended socket/plist paths, exact first-party binary identity/digest/argv shape, deadline и launch policy. В начальной PREPARED revision ещё не созданные socket/plist имеют строго NULL object identities и plist digest. После создания каждого exact artifact controller проверяет nofollow/type/object identity, вычисляет plist digest и атомарно CAS/fsync/readback публикует binding в следующую PREPARED revision. LAUNCHING разрешена только после durable complete bindings обоих artifacts и свежей equality проверки; missing/torn binding запрещает bootstrap. PID/unique/pidversion/token/coalition поля строго NULL до durable kernel binding. Null не backfill из догадки или process listing.

Состояния: `PREPARED → LAUNCHING → BOUND → RELEASED → STOPPED`; `NEVER_LAUNCHED` — terminal proof для PREPARED, не синоним отсутствия PID. `UNKNOWN` — наблюдение, сохраняющее durable last state и все locks. CAS сравнивает journal revision, generation, nonce, expected state и boot binding; один controller держит exclusive journal lock. Никакой следующий controller не dispatch/replay старую LAUNCHING generation.

Перед **любым** `launchctl bootstrap` controller CAS/fsync/readback PREPARED→LAUNCHING. Native command executor получает authority только после этого commit. PREPARED доказывает NEVER_LAUNCHED только при целой journal chain, отсутствии authorized dispatch и завершённом/исключённом старом executor; missing/torn/corrupt owner или pending executor — UNKNOWN. Отсутствие записи не является never-launched evidence.

BOUND commit атомарно записывает kernel-bound root PID/unique ID/pidversion/audit token/resource coalition ID и подтверждённые launch/socket bindings. Только после awaited durable readback разрешён nonce ACK. Callback error, CAS rejection, timeout, failed readback, duplicate/out-of-order frame, EOF или root death до ACK запрещают release. После ACK root может исполнять только fixed fixture scenario; production payload здесь отсутствует.

## 3. First-party barrier и точный transport

Controller создаёт AF_UNIX/SOCK_STREAM listener внутри exact new private directory; pathname не берётся из managed repo/model. Socket/owner/plist проверяются nofollow/type/identity; socket удаляется только при matching creation identity. Root binary имеет фиксированные `fixture <generation> <nonce> <socketPath> <absoluteDeadline> <scenario>` argv. До ACK root **не fork/spawn/exec payload**, не создаёт descendants и не выполняет сценарий; только connect, bounded READY, ожидание ACK и watchdog exit.

Protocol v2: 4-byte unsigned big-endian length + UTF-8 JSON, max 4096 bytes/frame, max один READY и один ACK; strict field allowlist/type/range, 5-second framing deadline, no raw stdout authority. READY содержит protocol/generation/nonce/scenario; ACK содержит те же correlation fields и owner committed revision. Kernel peer PID берётся из native socket peer API `LOCAL_PEERPID`, uid — `getpeereid`; unsupported peer API закрывает spike. Затем controller получает task-name audit token и bracketed proc unique/pidversion/coalition reads. READY само по себе не доказывает PID/image/membership. Nonce, peer identity, held exact binary/plist, launchd readback и root barrier должны одновременно соответствовать.

Реальный callback имеет форму `await bindOwner(expectedRevision, verifiedKernelBinding)`; durable owner service alone CAS-публикует identity. Controller не ACK до successful callback/readback. Root на EOF/controller death/invalid ACK/timeout до release выходит без payload. После release leaf имеет independent bounded watchdog; его cleanup не засчитывается STOP proof. Только after-ACK crash acceptance обязан восстановиться до watchdog и показать leaf LIVE. Pre-ACK crash acceptance доказывает NEVER_RELEASE/no fork/no descendants; это не NEVER_LAUNCHED и не STOPPED. UNKNOWN сохраняется, если exact root/barrier либо durable scope нельзя восстановить.

## 4. Fixed launchctl contract и dispatch closure

Все команды — `/bin/launchctl`, `shell:false`, bounded stdout/stderr, 5-second timeout. Domain только `user/<getuid()>`, service target `<domain>/<uniqueLabel>`. Label `com.ebb.phase2.<generation>.<random>` создаётся Ebb; существующие jobs не перечисляются/меняются. Plist exact: `Label`, `Program` (held compiled fixture), `ProgramArguments`, `RunAtLoad=false`, `KeepAlive=false`, `LaunchOnlyOnce=true`; никаких sockets/MachServices/watch/calendar/interval/QueueDirectories/StartOnMount triggers. Detached fixture может требовать `AbandonProcessGroup=true`; actual semantics и survival должны быть доказаны до соответствующего PASS.

`print <domain>` используется только для bounded manager-health parsing: output может содержать чужие service entries, поэтому parser проверяет только allowlisted domain header/status, не перечисляет и не сохраняет entries. Raw domain stdout/stderr не попадают в artifacts/logs/API; сохраняются лишь exit/signal/timeout, matched expected domain identity и health verdict. Output overflow/неподдерживаемый header → UNKNOWN. Health check не является host-permission inventory.

| Операция | Fixed argv | Acceptance |
|---|---|---|
| Domain health | `print <domain>` | exit 0 и bounded supported domain parser; иначе UNAVAILABLE |
| Register | `bootstrap <domain> <exactPlistPath>` | exit 0; затем successful registered-inactive readback; ошибка/timeout не значит never-launched |
| Registration readback | `print <serviceTarget>` | exit 0 + supported parser exact label/domain/Program/argv/plist/generation/policy; PID обязан отсутствовать при RunAtLoad=false до kickstart; unexpected PID запрещает dispatch и даёт UNKNOWN |
| Post-kickstart readback | `print <serviceTarget>` | exit 0 + same exact registration bindings и current PID; PID затем kernel-authenticated через current barrier/token/unique/pidversion/coalition до BOUND; mismatch WRONG_GENERATION, отсутствие/неверифицируемость root UNKNOWN |
| One dispatch | `kickstart <serviceTarget>` | только once после LAUNCHING/readback; без `-k`/`-p`; timeout/nonzero UNKNOWN, no retry |
| Remove binding | `bootout <serviceTarget>` | только после exact verified matching generation; затем closure/readback; exit 0 alone не STOPPED |

Print output не является stable documented machine schema. До activation gate записываются exact launchctl binary identity, OS build, supported bounded parser fixture и **observed** absent-result signature. Calibration: domain health success; print independently generated never-registered negative label; exact failed exit/stderr normalized only for label/uid; domain health success снова. Сохраняются numeric exit, signal, timeout и bounded signature. Arbitrary nonzero, substring `not found`, пустой output, timeout, unsupported parser/build, domain failure или другая signature — UNAVAILABLE/UNKNOWN. Никакой придуманный universal exit code. Target ABSENT допускается только exact calibrated signature и successful same-domain health reads до/после. Если менеджер не позволяет доказать такое различие, closure gate FAIL и Phase2 не реализует отсутствие как PASS.

WRONG_GENERATION, program/plist/nonce mismatch: не signal/bootout даже при совпадающем label; UNKNOWN сохраняет locks. Nonterminal LAUNCHING без durable coalition после restart: successful matching job readback + authenticated current first-party root barrier позволяют bind-and-stop **без ACK/release**. Root отсутствует/неверифицируем/уже вышел и coalition не была durably bound — UNKNOWN, даже если label ABSENT. No PID-only kill.

Dispatch CLOSED требует: старый command executor settled/dead и exclusive journal ownership; no retry/pending kickstart; exact matching job removed и target ABSENT через classifier; plist вне auto-load directories; launch configuration и tested LaunchOnlyOnce/no demand/restart behavior; generation больше никогда не bootstrap/kickstart. Существующие descendants ещё могут fork — CLOSED не означает STOPPED. Пока closure не доказана, empty counter snapshot недостаточен: launchd может позднее dispatch новую root.

## 5. Kernel accounting, tokens и STOPPED

[Wrapper ABI](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/libsyscall/wrappers/coalition.c): `int coalition_info_resource_usage(uint64_t, coalition_resource_usage*, size_t)` возвращает syscall 0 либо -1/errno, не byte count/direct errno. [Kernel syscall](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/sys_coalition.c) копирует MIN(requestedSize, struct size), не возвращает copied length. Report не выдумывает returnedBytes.

Читается pinned 16-byte prefix `tasks_started`/`tasks_exited` (offsets 0/8) с static assertions, distinct sentinels и surrounding canary. Controlled live/start/exit transitions обязаны подтвердить semantics; observed bytes/prefix confidence не означают full ABI compatibility. Записываются requested bytes/result/immediate errno/changed byte map/source pin/OS build; ABI unresolved — FAIL/NOT VERIFIED. `started>=exited`, monotonic counters в одной generation и LIVE пока controlled detached leaf alive обязательны. Exec может менять task counters; не приравнивать counter delta количеству OS PID или process forks.

[Kernel implementation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/kern/coalition.c) читает task counters under coalition lock; reap удаляет ID после terminated и active_count=0. Ранее **durably bound, успешно queried resource** coalition absence может стать final-empty proof только same boot, CLOSED dispatch, validated SPI/errno semantics и source/executable binding. Boot mismatch, unknown/zero ID, arbitrary ESRCH, unsupported kernel — UNKNOWN. Future dispatch/external spawn routes и exact source/kernel applicability должны быть рассмотрены security review; privilege escalation/coalition mutations самим probe запрещены.

Process list — discovery only, никогда final empty proof. На каждом candidate: unique/pidversion/coalition before token acquisition → actual audit token → unique/pidversion/coalition after; mismatch/race reject and repeat boundedly. Полученный token должен совпасть с stable identity и target immutable resource coalition. Signal только `proc_signal_with_audittoken` (direct errno result), no PID/PGID fallback. После exec нужен свежий token; stale-token negative проверяет rejection и live exact fixture/sentinel. Token failures/visibility holes не превращаются в vanished proof.

STOPPED: CLOSED плюс successful validated kernel counter equality либо previously-known same-boot ID absence as above; отдельно final fresh observation на cleanup boundary. Leaf death/watchdog, root death, job ABSENT/bootout, empty PID list, clean waitpid или successful signal сами по себе не дают STOPPED. Signal/discovery/accounting loop ≤30 sec; ambiguity/timeout UNKNOWN, owner/capabilities/reservations retained. Only STOPPED/NEVER_LAUNCHED допускают exact fixture cleanup; UNKNOWN не удаляет owner или source locks и не допускает resume/new dispatch/normal recovery callbacks. Production same-Run resume остаётся отдельной Task5C-M после её собственных gates.

## 6. Пять обязательных crash points

| Fault injection | Durable state | Restart contract |
|---|---|---|
| Before bootstrap | PREPARED либо LAUNCHING после CAS | No root/payload/fork/descendants; PREPARED при proven unauthorized dispatch → NEVER_LAUNCHED; LAUNCHING без verified barrier/root → UNKNOWN |
| After dispatch before kernel readback | LAUNCHING, kernel NULL | NEVER_RELEASE/no fork/no descendants; authenticate exact live barrier + manager binding, persist BOUND, stop без ACK; иначе UNKNOWN |
| After kernel readback before commit | LAUNCHING, kernel NULL | NEVER_RELEASE/no fork/no descendants; volatile identity забывается; новое readback/binding; иначе UNKNOWN |
| After commit before ACK | BOUND | NEVER_RELEASE/no fork/no descendants; fresh same-boot exact kernel binding, CLOSED then STOP; root EOF не заменяет proof |
| After ACK | BOUND/RELEASED | Detached leaf demonstrably LIVE; new controller stops full durably bound scope |

Timeouts/EOF/death/CAS failure тестируются отдельно в READY/binding/ACK paths. Injection включает kill controller и restart independent process, а не simulated in-memory callback. Каждая fixture ≤60 sec, runner ≤10 min; watchdog cleanup отделён от pass evidence. Tests удерживают harmless unrelated sentinel outside coalition и доказывают его LIVE после всех target signals. Parent/helper death и bootout не должны автоматически сделать survival test vacuous.

## 7. Acceptance, report, CI и production migration boundary

Report schema v2 содержит phase/source SHA/XNU pin/platform/binary+parser identity, durable transition/readback outcomes, exact launchctl result classifications, observed ABI constraints, scenario verdicts, CLOSED/kernel proof kind, sentinel/cleanup outcomes. Только bounded first-party protocol/kernel/command metadata; no env dump/provider/raw runtime streams. Values 64-bit IDs/counters хранятся decimal strings, не JS lossy numbers. `phaseVerdict` не заменяет individual gates; `platformReadiness=NOT_CLAIMED` всегда.

Required scenarios: barrier/no-fork-before-ACK; separate controller/root/sentinel coalition; accounting positive live leaf + negative absent ID; fork/exec/posix_spawn/setsid/doublefork inheritance; root/helper death with detached leaf LIVE; пять crashes; fork burst during STOP; stale token and sentinel negatives; launchd no-restart/no-demand + root-exit/bootout behavior; reload new generation preserving old owner rejection; malformed/missing/torn owner, unavailable domain/parser, wrong generation; exact cleanup. Неисполненный сценарий NOT_RUN, не PASS.

Текущий workflow `.github/workflows/macos-runtime-feasibility.yml` запускается через `workflow_dispatch`, а также на `pull_request` в `master`/`develop` и `push` в `master`/`develop`. Оба автоматических triggers ограничены paths: сам workflow и `scripts/macos-runtime-feasibility.cpp`, `.mjs`, `.test.mjs`; изменения server production code сами по себе его не запускают. Runner — `macos-latest`, Node24. Отдельные artifacts `macos-runtime-feasibility-phase1` и `macos-runtime-feasibility-phase2` публикуются через `always()` с retention 7 days. First-party fixture native build/invocation проверяется в Phase2; это не production packaging/native gate. Tests provider-free, no credentials. Run exact pushed/reviewed SHA; unpushed local changes не evidence.

### Hosted evidence — 2026-10-09

[GitHub Actions run `37923868841`](https://github.com/vivernet/ebb-orchestrator/actions/runs/37923868841) завершился `success` на exact source SHA `0bf01e58cc7e37231808ed83fa779276d9fad62a`. Platform: macOS `26.6.2`, build `25G83`, `arm64`, SDK `26.5`, Apple clang `21.0.0` (`clang-2100.1.1.101`). XNU source pin остаётся `f6217f891ac0bb64f3d375211650a4c1ff8ca1ea`.

Artifact `macos-runtime-feasibility-phase2/macos-runtime-feasibility-phase2.json` имеет SHA-256 `a71f0779f41326c2dce55bf8a92a34bb3c25f699b805fc190a24ff99dbd56abe`. В нём все 17 обязательных сценариев получили `PASS`, нет `NOT_RUN`:

| Scenario | Verdict |
|---|---|
| `barrier` | PASS |
| `fork` | PASS |
| `exec` | PASS |
| `spawn` | PASS |
| `setsid` | PASS |
| `doublefork` | PASS |
| `root-exit` | PASS |
| `burst` | PASS |
| `crash-before-bootstrap` | PASS |
| `crash-before-ack` | PASS |
| `crash-after-ack` | PASS |
| `stale-token` | PASS |
| `reload-generation` | PASS |
| `malformed-owner` | PASS |
| `manager-unavailable` | PASS |
| `crash-after-dispatch` | PASS |
| `crash-before-bind` | PASS |

Phase2 `phaseVerdict=PASS`, `ciExitCode=0`, `temporaryCleanup=PASS`, `disposition=NO_RETAINED_OWNER`; fixture build/invocation exit `0`. Ограничения отчёта сохранены: `platformReadiness=NOT_CLAIMED`, `productionPackaging=NOT_RUN`, `fullABICompatibility=NOT_CLAIMED`. Это evidence контролируемой fixture на одном exact platform build, не завершение Task5A-M/5B-M/5C-M и не macOS production readiness.

Отдельный artifact `macos-runtime-feasibility-phase1/macos-runtime-feasibility.json` имеет SHA-256 `71dfa1ece5ad0f3c71c838263859b396c860ffaadb82b97ee2039dfca57f734e`: `phaseVerdict=PASS`, `platformReadiness=NOT_CLAIMED`. Public SDK compile действительно `FAIL` (status `1`): SDK не объявляет `proc_uniqidentifierinfo`, `proc_pidcoalitioninfo`, `PROC_PIDUNIQIDENTIFIERINFO`, `PROC_PIDCOALITIONINFO`. SPI compile status `0`/`PASS`; exports, identity reads (`uniqueBytes=56`, `coalitionBytes=40`), task-name/audit-token reads и permissions/cleanup — `PASS`; wrong token result `3` оставил sentinel LIVE, correct token result `0`. Phase1 поля `membership`, `fullScopeStop`, `restart`, `staleAfterExec` остаются `NOT_RUN`; соответствующая lifecycle evidence находится в отдельном Phase2 report, а не переобозначается как Phase1 PASS. Public SDK отсутствие и использование pinned SPI остаются ограничением будущего production design.

Runner OS label floating: каждый run пишет `sw_vers` version/build, arch, SDK/compiler, launchctl/native binary identity. Calibration/parser gates привязаны к exact build; runner update инвалидирует прошлый compatibility claim и требует fresh run. Одного arm64/macOS build недостаточно для all-version/all-arch support. Node24 package gate и Darwin production packaging ещё требуют собственного design/implementation; их отсутствие удерживает Task5A-M открытой.

Production integration отдельно добавляет versioned migration для `macos-resource-coalition-v1` containment и nullable prebinding kernel fields/state/boot/generation/nonce/launch-binding policy. Не менять migration037 in place, не reinterpret Windows/Linux columns, не fabricate Darwin identities/backfill historical owners. Exact migration number/DDL определяется schema owner после architecture/database review. Сохранить все `context_deltas` rows, обе FK targets/delete actions, indexes/root page/diagnostic semantics; не rebuild/copy table. Populated upgrade и fresh DB gates плюс state/CAS/recovery tests обязательны. Этот proposal не выполняет migration и не подтверждает production native support/source snapshot/profile/auth readiness.

## 8. Requested independent review scope

Review только этого revised design и его linkage в Plan20; сравнить B1/B2 с Sections 2–6. Проверить durable authority до dispatch, five crash windows, callback/CAS/EOF, manager parser/result classifier и closed restart routes, previously-bound same-boot absence, token race brackets, prefix ABI ограничения, detached survival и nonvacuous positives, bounded cleanup/UNKNOWN locks. Sections 1/7 проверить на отделение feasibility от production packaging/schema/CI/readiness. Последний bounded re-review фокусируется на §2 NULL artifact identities и committed subsequent PREPARED revision до LAUNCHING, §4 registered-inactive versus post-kickstart readback и redacted domain-health parsing, §§3/6 no-descendants/NEVER_RELEASE pre-ACK versus leaf-LIVE only after ACK. Read-only review не разрешает launchd mutation или implementation. Blocking finding → CHANGES_REQUIRED; approval design отдельно от native PASS и implementation authority.
