---
id: proposal-17
kind: proposal
title: Прямой macOS host runtime для обычных Hermes Run
status: accepted
created: 2026-10-16
updated: 2026-10-16
tags: [macos, hermes, process-scope, recovery, v1]
---

# Proposal 17 — Прямой macOS host runtime для обычных Hermes Run

> **Статус:** контракт принят пользователем 2026-10-16, а независимый архитектурный/security review завершён `APPROVED`. Proposal задаёт разрешённую архитектуру для синхронизации spec-01 и Plan20; сам по себе не заменяет независимо проверенный implementation plan и не объявляет реализацию готовой.

## 1. Цель и запрашиваемое решение

Поддержать обычные локальные Hermes Run на macOS 13.5+ с Apple Silicon (`arm64`) в простом local-first приложении. Ebb запускает уже установленный пользователем Hermes через его существующий root/profile и native authentication. Не нужны VM, отдельный Hermes profile, второй provider setup или управление credentials.

Этот вариант заменяет VM feasibility-кандидата Plan20 прямым запуском на host и ослабляет прежнее требование доказать остановку всех OS descendants. Контролируемая граница — точный first-party anchor и процессы в его исходной process group. Процесс, который намеренно покинул process group, может продолжить работу вне наблюдаемой Ebb границы.

**Принятое продуктовое решение (2026-10-16):** пользователь подтвердил: «Да — принять прямой запуск и ограниченную гарантию». Для macOS v1 применяется этот bounded process-group contract вместо прежнего whole-scope STOPPED. Умышленно detached descendants находятся вне гарантии и могут пережить завершение/остановку управляемой группы. При потере Ebb anchor сам закрывает gate и пытается остановить bounded group; если anchor тоже погиб/завис и остановку нельзя доказать, Run остаётся `UNKNOWN` до подтверждённого естественного выхода процессов либо reboot со сменой boot session. Это намеренная цена отказа от reconnect daemon и внешнего небезопасного сигналинга; в редком таком случае reboot — честный крайний шаг восстановления, а не скрытое снятие lock. Автоматический same-Run resume запрещён. Не добавляются отдельный Coordinator override, новые Run business states или пользовательское заявление об остановке.

## 2. Утверждённые ограничения и scope

- Поддержка: физический host macOS 13.5+ и Apple Silicon `arm64`; Intel вне scope.
- Один обычный Hermes Run использует текущую установку Hermes и существующие пользовательские настройки Hermes. Ebb не читает, копирует, хэширует, экспортирует или меняет Hermes auth/config и не подменяет provider/model.
- Нет VM, отдельного Hermes profile/HOME, config overlay, новых provider credentials, host ACL/owner/mode/foreign-grant inventory или remediation.
- На macOS нет автоматического повторного dispatch/resume прежнего logical Run после сбоя Ebb или Hermes. Пользовательское восстановление Hermes выполняется вне Ebb и не является OS evidence.
- Windows/Linux lifecycle не меняется этим proposal.
- Spec-01 §10.2/§13.1 и Plan20 синхронизированы с принятым Mac process containment/recovery contract; Windows/Linux контракты сохраняются. Это не отменяет Hermes ownership, Scheduler/Coordinator CAS и startup preflight.

## 3. Lifecycle прямого host запуска

### До dispatch и ACK

1. В одной SQLite transaction Ebb создаёт owner generation со стабильными `run_id`, `generation`, `attempt`, случайными `containment_id` и `launch_nonce`, состоянием `PREPARED` и выбранным Darwin containment kind. Запись commit происходит до запуска любого OS process.
2. RunService переводит generation в `LAUNCHING` CAS-ом и запускает минимальный first-party anchor typed invocation (`shell:false`) из установленного Ebb package через существующую process-supervisor boundary. Anchor создаёт новую OS session/process group и остаётся её живым лидером на всём протяжении Run. Это не launchd/VM management subsystem.
3. Anchor поднимает private IPC channel, привязанный к точным Run/generation/attempt, случайному nonce и kernel-authenticated peer identity; это одно соединение без listener/reconnect service. Он возвращает ограниченный READY frame с этими полями, PID, точным OS start identity, SID/PGID и текущим boot-session UUID. Ebb независимо сверяет peer и OS identity. PID без start identity, неверный peer/nonce, лишний frame, timeout или недоступная identity API дают `UNKNOWN`.
4. Ebb CAS-публикует verified binding, переводит owner в `LIVE` и отправляет ACK по тому же exact authenticated channel. До ACK anchor держит spawn barrier и не исполняет Hermes. Потерянный/неоднозначный ACK не приводит к повторному launch; generation остаётся `UNKNOWN`, пока её состояние не установлено допустимым OS evidence.
5. После ACK anchor запускает существующую поддерживаемую Hermes CLI в своей process group с тем же пользовательским root/profile. Anchor контролирует только spawn gate и process-group stop; Hermes выбирает provider/model/auth как обычно. Ebb не передаёт secrets и не создаёт новый Hermes config.

Публичная Darwin identity API, её доступность на всём заявленном deployment target и package integration должны быть выбраны и подтверждены в implementation plan. Нельзя подменять их PID-only/process-name эвристикой или private SPI. Если exact start identity нельзя достоверно получить и повторно прочитать, macOS production implementation не проходит gate.

**Boot-session evidence после перезапуска.** При создании generation Ebb сохраняет текущий kernel boot-session UUID, прочитанный через `sysctlbyname("kern.bootsessionuuid")`, рядом с anchor start identity. XNU source объявляет этот selector read-only; комментарий Apple к `BootSessionUUID` говорит, что UUID уникально идентифицирует boot cycle, появляется при boot, остаётся до shutdown и сохраняется через sleep/wake/hibernate. Поэтому различный UUID — кандидат на доказательство, что старый boot завершён и процессы той boot session не существуют. Sleep/wake не меняет значение.

Этот selector не найден в публичной macOS API availability guarantee. Apple документирует общий `sysctlbyname`, но конкретный `kern.bootsessionuuid` не является гарантированной app API; Apple отдельно отмечает его недоступность приложениям на iOS 18+, что подчёркивает необходимость target verification. Разрешено полагаться на UUID только после реального package acceptance на macOS 13.5 и актуальной hosted macOS arm64 CI. Runtime failure, permission denial, отсутствующий/невалидный UUID или generation без сохранённого UUID означают UNKNOWN и провал Mac release gate; нельзя выпускать Mac recovery с неустранимым неизвестным состоянием или подменять UUID временем, uptime, marker-файлом, user assertion или PID scan. Вариант решения при недоступности потребует отдельного design review.

### Штатное завершение и Stop

При штатном завершении anchor получает от Hermes ожидаемый close/result и закрывает spawn gate. При cancel, timeout или shutdown Ebb сначала CAS-ом фиксирует `STOPPING`, чтобы запретить новые dispatch для этой generation, затем отправляет STOP по точному generation-bound channel. Anchor проверяет точные Run/generation/attempt/nonce, закрывает собственный spawn gate и подтверждает его закрытие по тому же channel. При EOF или потере исходного channel (в том числе при аварийном завершении Ebb) anchor необратимо закрывает spawn gate и запускает тот же bounded stop path самостоятельно; channel никогда не восстанавливается, а новый Ebb не может послать ACK, возобновить generation или снова запустить Hermes. Для STOP по живому channel anchor отправляет gate-closed ACK до сигналов; при EOF закрытый локальный gate сам служит барьером, ACK не ожидается. Если Ebb доступен, но gate closure/stop evidence не подтверждено, Ebb хранит `UNKNOWN`. Только после соответствующего барьера anchor отправляет `SIGTERM` своей собственной process group через `kill(0, SIGTERM)`, заранее установив игнорирование SIGTERM только для самого anchor. Он остаётся живым group leader во время ограниченного grace period. Затем anchor вызывает `kill(0, SIGKILL)` для своей группы, включая себя; после возврата из системного вызова anchor завершится. Ebb не посылает ни `kill(-pgid, …)`, ни другой сигнал с внешним числовым PGID. Запрещены negative-PGID kill fallback и signal после свежего внешнего PGID observation.

Использование `kill(0, …)` из ещё живого anchor устраняет reuse window между внешней проверкой PGID и сигналом: anchor остаётся участником группы и удерживает её идентичность до собственного self-inclusive SIGKILL. Если anchor погиб, стал недоступен по IPC, не подтвердил закрытие spawn gate либо остановка прервалась до его собственного `kill(0, SIGKILL)`, Ebb ничего не сигналит извне; owner остаётся `UNKNOWN` и ресурсы удерживаются.

После exact anchor PID/start-identity close Ebb получает fresh process-membership evidence для исходной session/group в том же boot. STOP proof требует durable закрытый dispatch/spawn gate, подтверждённое завершение exact anchor и подтверждённую пустоту исходной group. Если membership observation недоступна, неполна или показывает процессы с неоднозначной identity, результат `UNKNOWN`. Реализация обязана выбрать и проверить supported public macOS API для process identity/group membership; пока API и его полнота не установлены на macOS 13.5+, это открытый implementation gate. Process listing используется только для доказательства состояния, никогда для последующего числового PGID signaling.

При штатном завершении валидный Hermes result плюс подтверждённая пустота исходной group дают `COMPLETED` и bounded `STOPPED`. Специально detached descendant, который вызвал `setsid` или перешёл в другую process group, явно вне bounded scope: он может пережить completion/stop, не блокирует normal completion и не включается в claim полного process-tree cleanup.

### Crash/restart и существующая ручная recovery policy

При старте Ebb сначала читает durable owner generations до recovery callbacks и новых conflicting dispatch. Для generation `LAUNCHING`, `LIVE` или `STOPPING` он сравнивает сохранённый UUID с текущим kernel boot-session UUID. Новый экземпляр Ebb никогда не reconnect-ится к старому anchor и не отправляет ему ACK/STOP; он только применяет сохранённую owner identity и разрешённые OS observations.

- Если оба значения валидны и различаются, kernel evidence подтверждает завершение предыдущей boot session. Ebb сохраняет для exact generation stop evidence с причиной `BOOT_SESSION_CHANGED`; только после durable CAS существующая recovery/reconciliation policy может terminalize interrupted Run как unsuccessful и освободить связанные ресурсы. Это не same-Run resume и не user attestation.
- Если значения совпадают, Ebb проверяет исходные anchor/group identity и требует достоверного bounded group stop evidence. EOF обычно заставляет живой anchor закрыть gate и выполнить self-stop; если anchor умер/завис до завершения cleanup, а процессная группа ещё существует или membership proof неоднозначен, owner остаётся `UNKNOWN`, capability/reservation/resource locks удерживаются, а conflicting dispatch блокируется. Ebb не освобождает их из-за отсутствия anchor PID и не сигналит группу извне. В таком редком случае, если процессы не завершаются естественно и доказательство остановки недоступно, reboot со сменой boot session остаётся документированным recovery шагом.
- Если UUID отсутствует, недоступен, невалиден или не был сохранён до dispatch, generation остаётся `UNKNOWN`; никаких inferred values или wall-clock fallback нет. Действующая ручная Hermes recovery policy остаётся без изменений: пользователь может восстанавливать Hermes вне Ebb, но его заявление не является STOPPED evidence и не разблокирует Ebb.

Новый Coordinator override не вводится. В том же boot Ebb не может обещать, что detached process уже исчез; пока authoritative evidence ограниченного scope не получено, предусмотренный путь выхода из UNKNOWN — реальный reboot с подтверждаемой сменой boot session либо существующая OS/process stop evidence. Если ни один путь не доступен, lock сохраняется fail-closed, без ложного STOPPED.

### Различие статусов

| Событие | Orchestration Run | Process owner | Capability / reservation |
|---|---|---|---|
| Hermes завершился штатно; application result валиден; исходная group наблюдалась пустой | `COMPLETED` | `STOPPED` только для bound runner/group | штатное завершение и release по действующему flow |
| Ebb/runner аварийно завершился; bounded scope проверенно остановлен либо boot session сменилась | существующий unsuccessful terminal result | `STOPPED` с причиной `GROUP_EMPTY` или `BOOT_SESSION_CHANGED` | release только штатной reconciliation после evidence |
| Состояние неоднозначно в том же boot | существующее interrupted/failed reconciliation не закрывает resource ownership | остаётся `UNKNOWN` | capability/reservation/resource locks удержаны; обычный новый Run блокируется |

Обычный `COMPLETED` никогда не используется для crash/interruption. `STOPPED` и `COMPLETED` в этом контракте относятся к bound process group; intentional detach остаётся вне гарантии.

## 4. Переиспользование принятого решения Plan07 Cleanup B

Пользовательское решение Plan07 Task7, зафиксированное в `docs/audit/13-hermes-development-workflow-parity-current.md` §“Correction — bounded Task7 cleanup policy B” и в `docs/architecture/plans/07-hermes-development-workflow.md`, разрешает для конкретной bounded parity acceptance оставить detached OS descendants как `NOT VERIFIED`; при прохождении остальных критериев это само по себе не блокирует PASS. Там же прямо запрещено заявлять полную очистку process tree.

Это подтверждает приемлемость узкой и честно названной cleanup-гарантии в v1, но не утверждает, что Plan07 уже решил production Run recovery, повторный запуск или scheduler locks. Proposal17 переносит только принцип «ограниченный cleanup допустим, если остаточная неопределённость видна и не выдаётся за доказанную остановку»; process-group semantics должны пройти отдельное продуктовое решение.

## 5. Границы, угрозы и отказные случаи

- `shell:false` и typed argv для runner и Hermes invocation; Hermes CLI выбирает свой provider/model/auth.
- Host/local mode не считается OS sandbox. Hermes и его children могут иметь прямой доступ к текущему workspace в рамках существующего Local Mode.
- Process group не ограничивает специально detached descendants или вредоносный код с достаточными OS правами. Они находятся вне поддержанного bounded scope и могут пережить штатное завершение/остановку группы. Ebb не обещает отмену их прямых host/workspace side effects.
- Ebb никогда не сигналит числовой PGID извне; запрещены `kill(-pgid, signal)` и любые fallback-варианты. Stop может инициировать только живой exact anchor через generation-bound authenticated IPC. Anchor death или channel loss до завершения собственного stop sequence означает `UNKNOWN`, без попытки завершить группу извне.
- PID/process-name совпадение, один PID/PGID snapshot, exit status Hermes/anchor, закрытый pipe, отсутствие launchd job и пользовательское заявление не являются STOPPED evidence.
- Ошибка identity API, PID/group reuse, некорректная или противоречивая boot identity, недоступная/неполная process membership observation, signal error внутри anchor, anchor death до или во время STOP command, race при остановке, потерянный READY/ACK и незакрытый spawn gate — `UNKNOWN`; нельзя переиспользовать owner identity или повторить launch. Исключение: валидные сохранённый и текущий boot-session UUID, которые различаются, обрабатываются по §3 как `BOOT_SESSION_CHANGED` и подтверждённый `STOPPED` после durable reconciliation.
- В рамках одного boot неопределённая generation блокирует conflicting Run и cleanup до достоверного bounded stop evidence или надёжно доказанной смены boot session. Не добавлять override, который выпускает resources из `UNKNOWN`.

## 6. Данные, migration и compatibility

Текущий `RunContainmentKind` и storage checks допускают `windows-job` и `systemd-user-service`; migrations 037/041/042 закрепили эти значения и не редактируются. Реализация добавляет только `darwin-process-group` в forward migration 047 по Plan20; это не новая Run business state. Anchor identity сохраняется в существующих `supervisor_pid`/`supervisor_start_identity` как versioned tuple `(bootSessionUUID, pid, startTvsec/usec, pgid, sid)`; Hermes runner identity в `pid`/`platform`/`process_start_identity`/`executable_identity`, включая versioned tuple `(bootSessionUUID, pid, startTvsec/usec, pgid, sid)`. Текущая owner row и generation history используют существующие поля; отдельное boot UUID column не добавляется. Существующие состояния и UNKNOWN reconciliation переиспользуются; нет отдельного override/audit subsystem. Нельзя выдумывать Darwin identity для старых Windows/Linux generations.

Обязательная compatibility-инварианта: сохранить каждую существующую `context_deltas` строку, обе FK targets/delete actions, индексы, root page и diagnostic-only semantics; не rebuild/copy эту таблицу. До migration выполнить текущий verified database backup gate и проверить populated upgrade вместе с fresh database.

Не менять Hermes session capture или `ContextManifest` смысл ради ограниченного process lifecycle. Darwin старый `session_id` не redispatch-ится автоматически; ручная Hermes session recovery остаётся вне Ebb. Новые поколения correlation/owner сохраняются через существующую Run/owner boundary.

## 7. Предлагаемая acceptance matrix

Hosted macOS acceptance и real-provider acceptance — отдельные gates. Успех одного не считается успехом другого. CI должен использовать настоящий macOS arm64 runner; Linux/Windows mock не может закрыть Darwin gate. Hosted image подтверждает только записанную в evidence версию ОС; floor macOS 13.5 отдельно проверяется на физическом поддерживаемом Mac, поскольку floating hosted image не доказывает floor.

| Gate | Platform / setup | Минимальное доказательство | Не доказывает |
|---|---|---|---|
| Native/package CI | Hosted macOS arm64, текущий package build | Anchor включён в app/package, находит exact installed Hermes executable, typed spawn работает; clean install/startup создаёт только ожидаемый local state; no VM/profile/credential/ACL setup | macOS 13.5 floor, process lifecycle или provider readiness |
| READY/ACK boundary | Hosted macOS arm64, provider-free anchor fixture | Durable PREPARED/LAUNCHING до anchor dispatch; private channel authenticates exact anchor/nonce; anchor PID/start identity проверяются; anchor spawn gate блокирует Hermes до ACK; stale nonce/lost ACK не повторяют launch | Реальный Hermes/provider |
| Bounded process-scope acceptance | Hosted macOS arm64, harmless anchor fixture | Anchor is live SID/PGID leader; STOP commands go only over exact authenticated channel; source proves no Ebb `kill(-pgid, …)` path; anchor self-signals via `kill(0, TERM)` then self-inclusive `kill(0, KILL)`; post-close membership read proves group empty. Inject PID/PGID reuse plus anchor death before and during STOP; all ambiguous branches remain UNKNOWN and no external signal occurs. Deliberate detached `setsid` child survives group stop and remains explicitly outside scope/NOT VERIFIED. | Полную очистку OS process tree |
| Ebb crash / no reconnect | Hosted macOS arm64, harmless anchor fixture | Kill Ebb and observe original channel EOF; anchor closes its local spawn gate before cleanup and runs the same bounded TERM/grace/KILL path; fresh Ebb startup does not reconnect, ACK, resume, respawn, or signal by PID/PGID. A spoofed/stale reconnect attempt is rejected. If anchor is separately killed before cleanup and group remains, owner stays UNKNOWN/locks stay held until verified natural group exit or boot UUID mismatch after reboot. | Автоматическое восстановление той же generation или очистку detached descendants |
| Ebb crash/restart | Hosted macOS arm64, отдельные Ebb/runner crash points | Durable exact owner прочитан до callbacks/dispatch; known group не resume-ится; тот же boot + ambiguity остаётся UNKNOWN и держит resources; различный валидный boot UUID переводит только соответствующую generation в STOPPED через `BOOT_SESSION_CHANGED`; новый Run требует обычные gates | Реальное Hermes/provider поведение |
| No automatic same-Run resume | Hosted macOS arm64 | После interruption ни один startup/recovery path не запускает прежний Run/session; callback старой generation не меняет следующую generation или terminal Run | Ручное восстановление Hermes вне Ebb |
| Real Hermes package acceptance | Physical Apple Silicon macOS 13.5+ и отдельно поддерживаемый hosted macOS arm64 при доступном user setup; opt-in, harmless real provider request | Установленная Hermes CLI запускается через существующий root/profile; live structured init/session capture коррелирует Run/owner; credentials/config не читаются и не попадают в artifact; нет автоматического same-Run resume | Все provider/auth конфигурации пользователей или полный process-tree containment |
| Recovery/data migration | Fresh DB и populated upgrade с реальными `context_deltas` fixtures | Только forward migration; preservation каждой строки/FK/index/root page; versioned boot identity round-trip; boot mismatch recovery и same-boot UNKNOWN retention после restart | Provider readiness |

Каждая строка имеет отдельный PASS/FAIL/NOT RUN и exact SHA. Missing host, package, Hermes setup или provider call — `NOT RUN`/`NOT VERIFIED`, не PASS. Логи и artifacts допускают только allowlisted identity/status поля; никаких prompts, provider bodies, auth values, credential hashes, host ACL/user inventory.

## 8. Реализация после принятия

Пользователь принял bounded direct-host контракт 2026-10-16, а independent architecture/security review завершён `APPROVED`. Spec-01 и Plan20 синхронизируются с ним; следующий implementation gate — свежий independent review самого Plan20. После `APPROVED` Plan20 можно исполнять без повторного продуктового решения. Производственный код пока не меняется.

Предварительная карта production changes для будущего плана:

- `apps/server/src/platform/process/`: минимальный Darwin first-party anchor/runner и generation-bound authenticated READY/ACK/STOP IPC в существующей process-supervisor boundary; Ebb никогда не сигналит числовой PGID. Выбрать supported public API для process identity/group membership и fail closed, если он не даёт требуемого exact evidence. Никакого launchd/VM manager subsystem.
- `apps/server/src/platform/home/production-composition.ts` и `apps/server/src/main.ts`: явное Darwin composition/home selection, никакого platform fallback на Linux.
- `apps/server/src/modules/runtime/run-process-owner.ts`, `run-service.ts`, `hermes/hermes-runtime-adapter.ts`: новый containment kind, single source of platform mapping, durable READY/ACK/CAS, boot-session evidence, bounded STOPPED semantics и fail-closed UNKNOWN; использовать существующие Run states и recovery flow.
- SQLite: новый forward migration для Darwin containment kind; не добавлять business state/audit subsystem и не переписывать 037/041/042.
- Coordinator/Scheduler: без нового override API/UI. Существующий recovery/terminal reconciliation потребляет только durable `STOPPED` evidence (`GROUP_EMPTY` или `BOOT_SESSION_CHANGED`); same-boot UNKNOWN продолжает удерживать owner/capability/reservation/locks. Stale callbacks/recovery attempts не могут обойти generation CAS.
- Native packaging/build scripts, smoke/startup fixtures, macOS CI workflow и acceptance tests для каждой строки matrix.
- Spec-01 и Plan20 синхронизируются с принятым контрактом; сохранить все `context_deltas` invariants.

## 9. Оставшиеся технические gates

Продуктовое решение и архитектурный review завершены; повторное подтверждение от пользователя не требуется. Остаётся доказать на целевых сборке и runtime: точные public API для PID/start/group observation, полноту group enumeration, boot-session UUID availability в macOS 13.5+ package, anchor EOF/stop/crash поведение и packaging. Любая недоступность или неоднозначность остаётся `UNKNOWN`; не подменять отсутствующее доказательство эвристикой, user assertion или внешним numeric-PGID сигналом. Эти технические gates закрываются только свежими acceptance evidence по Plan20; Proposal15 и старые VM spike материалы являются историческими.
