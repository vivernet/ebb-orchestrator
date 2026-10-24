---
id: branch-and-release-policy
kind: policy
title: Политика веток и публикаций Ebb
---

# Политика веток и публикаций Ebb

Статус: согласованный целевой контракт; переход и release tooling ещё должны быть реализованы и проверены по [Plan26](../plans/26-branch-and-release-policy.md). Наличие этого документа и skill не разрешает отсутствующим инструментам выполнять публикацию.

## 1. Ветки и identities

`develop` — default branch, integration и источник обычных задач. Обычная task branch начинается от полного pinned SHA актуального `develop` в отдельном worktree; PR проходит review и squash merge в `develop`. Review evidence связан с task SHA; интеграция порождает другой integrated SHA; release snapshot — третий candidate SHA. Evidence не переносится между ними только по совпадению имени ветки.

`master` — только последовательность surviving production release snapshots. До первого релиза ветка отсутствует; legacy master удаляется при подтверждённом переходе, а не сохраняется до первой публикации. GitHub default branch предварительно переводится на develop. Проверяются текущие refs/history, отсутствие релизов/unique master commits/не сохранённых данных, protections и worktrees. Историческое утверждение master==develop не заменяет доказательство. Dummy baseline, restore, archive commits/tags и скрытые backup refs запрещены.

Первый candidate имеет 0 parents; его tree точно равен pinned approved source tree. Каждый следующий имеет ровно 1 parent — pinned предыдущий master — и tree точно равен новому source tree. Release commit metadata фиксирует source SHA/tree, previous master/ABSENT, version и operation identity, не меняя source files. Annotated tag указывает на candidate. Обновление Git refs использует exact compare-and-swap и atomic transaction там, где она поддерживается; отказ protections — BLOCKED, не повод отключать правила.

## 2. Scope публикации

Пользователь вручную вызывает `ebb-release`; другие skills не запускают его по completion. При отсутствии версии skill предлагает обоснованный SemVer и получает выбор. PUBLISH включает master commit, annotated version tag, GitHub Release/assets/checksums и протестированные PUBLIC GHCR Docker images. Deployment, production/staging runtime, переключение трафика и миграции БД не входят в release.

Version source обнаруживается в реальном репозитории. Если канонической версии нет, root `release.json` с единственным `version` становится reviewed contract; изменение версии проходит source PR до pin. `package.json` с `private: true` запрещает npm publication, не делает GitHub repo приватным и не запрещает PUBLIC GHCR. Repo visibility не меняется для image publication. Owner/package namespaces определяются из actual GitHub repository и подтверждённой политики, не из примеров.

По умолчанию разрешены только version tags, без `latest` и mutable aliases. OCI labels, digests, platform manifests/index, version encoding (initial stable MAJOR.MINOR.PATCH only, без prerelease/build metadata), visibility и image tests проверяются до публикации. Неизвестные image layout/ownership, недоступные Docker artifacts или непроверенные platform requirements блокируют release enablement.

## 3. Reservation, approval и orchestration

`docs/releases/version-reservations.json` — durable append-only no-reuse ledger на защищённой develop. Schema и CI контролируют уникальность версии/operationId, timestamp, неизменность старых records. Reservation проходит reviewed develop PR **до** source pin. Не записывать circular self SourceSHA: source pin происходит после commit reservation. Удалённый/cancelled/partial релиз потребляет версию навсегда; master/tags/Release inventory не является полным ledger.

Journal/checkpoints находятся в `git-common-dir/ebb-release/`, вне release tree, с validated UUID paths, integrity checks, atomic file writes и без secrets. Перед каждым remote side effect persist intent и immutable IDs, после — reconciliation/result. Resume сохраняет original operation/version/source/candidate/tag object; не генерирует новый commit. Потеря cache требует verified backup или однозначного восстановления из remote metadata/reservations; ambiguity — BLOCKED.

Local mutex защищает checkpoint. Все public mutations PUBLISH/WITHDRAW/RESUME делегируются единственному trusted manual `.github/workflows/release-operations.yml`, с общей repository concurrency group, `cancel-in-progress: false` и конечными wait/job timeouts. Queue policy определяется по актуальным GitHub capabilities в Task0; pending replacement/cancellation наблюдаются, FIFO/persistent queue не обещаются. Task2 может завершить только schema/bootstrap config с явно null/pending будущими trusted bindings и blockers; это не valid mutation config. Task8 после independent review bind реальные workflow/script full commit SHAs отдельным reviewed config update, а Task11 завершает full gate acceptance. До final binding и acceptance все public release mutations fail closed; fake placeholder pins запрещены. Workflow/script/config identities pin и проверяются; inputs недоверенные, вызовы через validated argv и `shell:false`. Не обещать API fencing token или межсистемную атомарность. Второй writer и продолжение потерянного job запрещены до доказанного завершения owner и reconciliation.

PUBLISH требует полный существующий обязательный local+CI matrix exact source/candidate, Docker build/smoke каждого configured image/platform, final review, readback inventory и финальное конкретное подтверждение пользователя. `.github/workflows/release-validation.yml` обеспечивает exact-SHA CI до approval. Temporary candidate ref разрешается отдельным конкретным scope, имеет named namespace и cleanup; он не является hidden archival tag. Drift policy/source/master/reservations/remote identities отменяет evidence/approval и блокирует изменение.

Approval receipt связан с hash action bundle: mode, repository ID, version, operation ID, source/candidate/tree, old master/ABSENT, exact tag object, Release/assets, image/package/version/digests, gate evidence, side effects, permissions. Пользовательское подтверждение не заменяет server permissions и не разрешает другой пакет действий.

## 4. Withdrawal последнего релиза

WITHDRAW удаляет только последний surviving release. Он не deploy родителя и не меняет БД; failing product tests отзываемого дефектного релиза не препятствуют безопасному удалению. Обязательны withdrawal tool regression, fresh configured local/CI safety checks, target/parent provenance, permissions, ownership, provider restrictions и exact deletion inventory. Root не имеет previous image: не требовать его тестирования.

Порядок после concrete approval и recheck:

1. Удалить exact target-only GHCR package version identities; проверить provider response и доступный readback. Перед первым удалением проверить весь layout/ownership и известные eligibility restrictions. Package целиком не удалять.
2. После подтверждённого удаления target publications удалить GitHub Release по exact ID и assets, проверить отсутствие. Immutable Release блокирует изменение/удаление tag, пока Release существует.
3. Atomic CAS transaction удаляет annotated version tag и перемещает master на pinned parent; для root удаляет сам master ref. Default остаётся develop. Не создавать restore commit.
4. Проверить все target postconditions и сохранность surviving publications; только тогда `ROLLED_BACK`. Reservation сохраняется навсегда.

Если version layout/shared manifests не позволяют удалить target publications, сохранив surviving images, BLOCKED до первого удаления. Shared blobs могут физически сохраняться у provider ради surviving владельца; complete rollback означает удаление exact target version publication, не обещание немедленного GC/caches. Не выдавать сохранённую target version за полный withdrawal.

GitHub обычно запрещает самостоятельное удаление public package version с более чем 5,000 downloads; требуется GitHub Support. Документированный Packages REST version response не обещает download count. Известное ограничение блокирует preflight; недоступный count прямо раскрывается пользователю и не превращается в выдуманный endpoint/гарантию. Provider eligibility оценивается первой подтверждённой target-only GHCR deletion **до** удаления Release/tag/master; server refusal останавливает последующие steps. При нескольких version identities удаление может остановиться после частичного успеха: journal фиксирует удалённые/оставшиеся IDs, state `PARTIAL`, а не completed.

## 5. Partial, resume и hotfix

Git atomic transaction охватывает только refs, а Git/GitHub/GHCR не образуют общую transaction. На любой remote boundary возможен PARTIAL. Status делает read-only reconciliation; resume продолжает те же immutable IDs/stage под still-valid approval и safety gates соответствующего mode. Unexpected artifact или drift — CONFLICT; automatic compensation/republish запрещены. Withdrawal partial publish требует отдельного deletion bundle/approval.

Если develop не готов, hotfix готовится в isolated worktree от source опубликованного релиза, с review, version reservation и full PUBLISH gates. Source branch/fix PR не превращает master в development history. Forward-port fix в develop отслеживается явно; следующий normal release блокируется, пока его disposition не подтверждён.

## 6. Защита и доказательства

Server protections для develop/required checks и master namespace обязательны; machine CI проверки PR targets и master snapshot history дополняют их. Правила для ещё отсутствующего master задаются по имени. Narrow rollback mutation rights согласуются отдельно; не отключать protections и не расширять admin bypass молча.

GHCR public packages бесплатны; container image storage/bandwidth сейчас бесплатны, но Actions compute/artifact quotas — отдельные ограничения. Free registry не означает бесплатность всего CI. Provider capabilities актуализируются в Task0 и перед операции; ссылки и границы сведены в [SOURCES](../../../integration/SOURCES.md).

Текущий архив подтверждает подготовку инструкций. Он не содержит release CLI, новых publisher workflows, реального Docker support и evidence обязательного project matrix. Пока prerequisites отсутствуют — BLOCKED, даже если hermetic tooling tests зелёные.
