# Deterministic release tools — контракт Plan26

## Статус и граница

Это требования к будущей реализации, **не доступный tool**. Пока Plan26 не реализовал все операции, policy, schema и fault-injection tests ниже, `ebb-release` сообщает BLOCKED. Не создавай временные scripts и не подменяй отсутствующую операцию ручным `git push --force`, `gh release delete`, `curl` или registry cleanup.

Proposed entrypoint: `node scripts/release.mjs prepare|validate|publish|rollback|resume|status`. Реализация portable: Node runner, Windows/Linux/macOS paths, stable UTF-8 JSON, argv без shell interpolation. Допустим read-only `--help` только после появления файла; его наличие не доказывает соответствие контракту.

## Policy и inputs

Reviewed repository config `.ebb/release-policy.json` задаёт remote GitHub repository ID/owner/name, exact Git remote identity, default branch `develop`, release branch `master`, SemVer policy, canonical version manifest, GitHub Release/assets layout, GHCR packages/version encoding, required local gates и CI workflow/platform/check identities, timeout/lock policy, trusted workflow/script identities. Config pin/hash входит в evidence и approval; отсутствие mapping → BLOCKED, не выдумывать gates.

При Task0 обнаружить настоящий manifest версии; если отсутствует, Plan26 принимает canonical root `release.json` с `{ "version": "<SemVer>" }`. Обновить его через reviewed develop PR до source pin (hotfix — через reviewed fix source PR). Версия manifest, reservation, tag, Release и image labels обязана совпадать. Не требовать синхронизации private/public repository visibility: PUBLIC относится к GHCR packages; `package.json private: true` относится к npm.

Tool получает mode, exact version, source full SHA и source ref, approved reservation operation ID, authoritative repository identity; для hotfix base version/source и forward-port status. Для resume/rollback — existing operation ID/target release identity. Mutation принимает конкретный approval receipt, bound к hash пакета действий; пользовательское «да» сохраняется без secrets как explicit receipt. Никакие prompts CLI не должны сами считать approval данным.

## Output schema

Каждая команда возвращает UTF-8 JSON с `schemaVersion`, `operationId`, `mode`, `status`, `stage`, `repositoryId`, `version`, `sourceRef`, `sourceSha`, `sourceTree`, `oldMaster` (full SHA или ABSENT), `candidateSha`, `candidateTree`, `policyHash`, `reservationProof`, `inventoryHash`, `gateEvidenceHash`, `confirmationHash`, `remoteIdentities`, `blockers`, `nextAction`. Недоступные поля явно null; успех нельзя вывести из пустого output.

Statuses: `PREPARED`, `VALIDATED`, `AWAITING_CONFIRMATION`, `PUBLISHING`, `PUBLISHED`, `ROLLBACK_PREPARED`, `ROLLING_BACK`, `ROLLED_BACK`, `PARTIAL`, `BLOCKED`, `CONFLICT`. Exit 0 только для завершённой заявленной read/preparation/mutation стадии с проверенными постусловиями; неполная публикация/удаление имеет ненулевой exit и PARTIAL. Все evidence records содержат command/test identity, exit/conclusion, SHA/tree, platform, timestamp, log digest и scope; CI также immutable run/check ID и exact event/ref/head SHA.

## Storage и mutex

- Durable no-reuse authoritative source — append-only reservations на remote защищённой develop. Он не checkpoint и не выводится из master/tags. CI append-only/uniqueness контроль обязателен.
- Checkpoints cache + operation journal находятся в разрешённом `git-common-dir/ebb-release/`, вне tracked release tree и общие для linked worktrees. Имена operation файлов — validated UUID, например `operations/<uuid>/state.json`, `events.jsonl`, `inventory.json`, `gates.json`, `approval.json`; запрет user-controlled paths, traversal/symlinks outside root. Atomic temp-write/rename, проверка integrity/schema, conservative permissions. Log append-only, state transitions monotonic; secrets никогда не сохранять.
- Checkpoint persist **до** каждого remote side effect, записать intent/request/idempotency identity; результат persist после reconciliation. Interrupted response → query exact remote IDs before retry. Remote repo/ref/release/package/version/digest identities авторитетнее local cache.
- Bounded mutex: local exclusive lock по repository/operation защищает checkpoint только. Все public mutations выполняет **один trusted manual GitHub workflow** `.github/workflows/release-operations.yml`, CLI делегирует ему intent/approval hash. Общая repository concurrency group для release/rollback/resume, `cancel-in-progress: false`, bounded queue acquisition и job timeout; workflow/script SHA и trusted permissions проверяются. Независимые multi-machine public writers запрещены. Потерявшийся job не продолжать параллельно: проверить authoritative job termination и reconcile до retry; local stale-lock takeover также требует доказанного завершения owner. GHCR API не имеет обещанного fencing token.
- Backup/transfer bundle содержит operation state/journal/inventory/evidence/approval digests и checksum manifest без credentials; importer validates IDs/policy/remote state и сохраняет outside tree. При потере cache rebuild из authoritative remote inventory, reservation и immutable metadata либо BLOCKED при ambiguity; никакой guessed continuation. Для root rollback после tag/Release removal checkpoint/backup обязателен для identities и completion evidence, но no-reuse всё равно доказывает develop reservation.

## prepare

1. Read-only remote preflight: authoritative repo/default branch/ref identities, rulesets/permissions, full release/tag/GHCR inventory, complete reservations history, worktree clean/source object available. Server-side refused permissions/protection не обходить admin toggle/bypass.
2. Zero releases + present master → BLOCKED_LEGACY_MASTER. Предварительный Plan26 transition — отдельная операция с отдельным reviewed design/tool и confirmation; publish никогда его не выполняет.
3. Проверить version manifest/reservation uniqueness/operation ownership; существующий old master должен быть verified complete surviving published snapshot с согласованными tag/Release/PUBLIC images и source metadata, иначе BLOCKED. Pin source ref/SHA/tree, old master/ABSENT. Candidate создаётся локально deterministic tree snapshot: root при ABSENT, иначе ровно один old master parent. Persist exact commit inputs (message/timestamp/identity/parent/tree) и candidate SHA. Resume не генерирует новый timestamp/commit.
4. Candidate reachable remote для CI только через явно описанный временный operation ref после отдельной авторизации этого side effect. Namespace `refs/heads/ebb-release-candidates/<uuid>` валидирован, не archival tag, candidate cleanup указан в final inventory; ref удаляется при terminal success/cancel. Если CI нельзя запустить без remote write и это ещё не разрешено — показать отдельную конкретную authorization потребность, не публиковать master/tag.
5. Создать publication plan: exact annotated tag object/name, Release fields/assets/checksums, GHCR package names/version tags, OCI index/platform manifests/config/layer digests, provenance/source labels, ожидаемый public visibility. Image build/test до approval; local OCI artifact hashes pin. Если remote staging нужен для tests, его exact public/private side effects авторизовать отдельно, inventory сохранить и не выдавать за завершённый релиз.
6. Для rollback prepare read-only target inventory и следующий master/ABSENT; no mutation. Выполнить permissions/known download constraints/shared-digest deletion preflight полностью до первого удаления. REST не документирует download_count; unknown eligibility явно записать и раскрыть в confirmation, не блокировать только из-за unknown. Первый confirmed target-only GHCR deletion проверяет server eligibility; все GHCR target versions удалить до Release/assets и atomic tag/master CAS.

## validate

Для release/hotfix run full mandatory local and CI matrix из pinned policy на candidate/source exact tree и required operating systems/runtime/architectures; CI workflow integrity/version pin, no stale successful run или skipped check. `ebb-quality-gates` и `ebb-final-review` дополняют, не заменяют tool evidence. Check lint/type/tests/build/docs, applicable DB/security/Web, release tooling contract, image build/smoke tests каждого image/platform, OCI labels/digests/manifest composition. Локальный успех не заменяет configured CI platforms/architectures. Существующий scope Linux/Windows и Node 24/26 учитывать по фактической policy; macOS/arm64 обязательны только при явном configured release scope. Использовать trusted `.github/workflows/release-validation.yml` для prepublication candidate evidence.

Для rollback validate полный configured withdrawal safety набор: exact target inventory, parent published provenance (для root parent отсутствует), permissions/known deletion constraints/ownership, disclosed unknown eligibility, release-tool regression и актуальные local/CI safety checks. Отзыв публикаций не deployment/data migration: failing product tests defect-target не запрещают rollback. Surviving parent publications проверять только если parent существует; root не требует отсутствующего prior image test.

Refetch authoritative refs и inventories; recheck policy/reservations and exact candidate. Drift → discard gates/approval и BLOCKED/CONFLICT, PARTIAL при уже начатых side effects. Candidate object остаётся pinned; новый source требует нового prepare/evidence. Returning VALIDATED позволяет показать approval bundle, не разрешает публикацию.

## publish

1. Require matching final explicit approval receipt, complete valid evidence, local checkpoint lock и trusted serialized workflow run, policy and all pinned preconditions; recheck immediately before each step.
2. Upload exact tested version-only GHCR objects и verify public visibility/OCI manifests/labels; version names must be new and reservation-owned. Existing matching objects разрешены только exact-operation resume; mismatch → CONFLICT.
3. Update Git master+annotated tag атомарно одной remote ref transaction, когда server поддерживает atomic push, с compare-and-swap leases на old master и отсутствующий tag. Root expects absent master; later expects pinned old master. Atomic unsupported → BLOCKED unless reviewed Plan26 policy explicitly implements a journalled non-atomic sequence with per-ref CAS and recovery; не обещать атомарность.
4. Create matching GitHub Release/assets using pinned candidate/tag and immutable source metadata; verify remote IDs/content/hash. Если repository immutable releases включены, придерживаться их constraints. No deployment.
5. Final readback verifies exact master/tag objects, Release ID/assets, every PUBLIC GHCR package version/digest, annotations, image tests and reservation. Persist PUBLISHED only after all succeed and remove authorized temporary candidate ref.

Git atomic push охватывает только Git refs. Git/GitHub/GHCR не имеют общей transaction: любой шаг может оставить PARTIAL. Последовательность и journal должны делать это явным, не скрывать compensating deletion.

## rollback, resume, status

`rollback --operation <id>` prepares inventory by default. Execution requires exact reviewed deletion bundle + final approval, then uses [rollback-recovery.md](rollback-recovery.md). `resume --operation <id>` reconciles exact IDs and continues original intent/stage; new/changed actions require new concrete approval and gates. `status --operation <id>` read-only reconciles remote state, reports ambiguity and partial leftovers, never repairs implicitly.

## Acceptance before enabling

Plan26 must run hermetic Git fixture and mocked GitHub/GHCR integration tests plus authorized staging tests. Required failures: zero legacy master; absent first master/root candidate/root rollback; later single-parent commit/rollback; ruleset refusal; CAS races and source drift; GHCR-first/Release-before-tag order; known >5000 downloads; unknown count → disclosed approval + server eligibility check; first GHCR refusal leaves Release/Git refs untouched; partial multiimage deletion/journal/resume; missing permissions/public visibility; multiarch shared digest retention; every publication/deletion boundary timeout/crash/retry; stale lock/duplicate workflow run; machine transfer/lost cache; tampered JSON/paths; cancelled/rolled-back reservation reuse; mismatched version manifest/OCI tag encoding; CI missing/skipped/wrong SHA/platform; no token exposure. Archive documentation validation alone cannot enable execution.
