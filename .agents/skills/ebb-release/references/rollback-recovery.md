# Rollback и interrupted operation

## Preflight до первого удаления

Rollback только последнего surviving release; удаление более раннего snapshot под surviving descendants → BLOCKED. Target требует exact master/candidate/tag object, GitHub repository/release/asset IDs, GHCR package/version IDs, version tags и OCI digests. Full source SHA/tree/previous master из verified release metadata сопоставить с Git objects и reservation.

Проверить, что target master — root (0 parents) или later snapshot (ровно 1 parent, previous master в metadata). Root terminal rollback удаляет ветку master: не создавать baseline/restore commit, не переключать default branch с develop. Later rollback CAS-перемещает master на parent. Проверить parent как surviving release с его exact publications; inconsistent history → BLOCKED.

Inventory GHCR включает все платформенные manifests/indexes и package-version ownership, также tags/digests surviving releases. Удалять target version(s), assets и release tag. Нельзя удалить package целиком или shared digest/version, нужный surviving releases. Если GitHub API/version layout не позволяет удалить target полностью, одновременно сохранив surviving artifacts, BLOCKED до первого удаления; Plan26 должен определить release-specific layout или escalation. Не выдавать retention target version за полный rollback. Mutable aliases по default отсутствуют; найденные aliases/unknown owners требуют explicit inventory decision.

Public package version с **более чем 5,000 downloads** обычно нельзя удалить. Известное превышение лимита, доказанный permission отказ или иной подтверждённый запрет → BLOCKED до первого удаления и точная GitHub Support escalation. Packages REST не документирует `download_count`: неизвестное число/eligibility не превращать в постоянный blocker и не выдумывать count. Записать `eligibility: unknown`, честно раскрыть это в concrete confirmation; после подтверждения server определяет eligibility при первой exact target-only GHCR deletion. Отказ до любого успешного deletion оставляет GitHub Release/assets/tag/master нетронутыми и BLOCKED; отказ после частичного multiimage удаления → PARTIAL, journal/resume exact IDs, GitHub Release/Git refs ещё нетронуты. Даже final approval не снимает server constraint; не обходить rulesets или package policies. Account admin permission для granular package не является доказательством delete eligibility.

## Concrete confirmation и порядок

После полного configured withdrawal safety набора (identities/parent provenance, permissions/deletability, tool regression, fresh local/CI safety checks) и final review показать target version, full source/candidate/old master, next master/ABSENT, tag object, Release/assets IDs и точные GHCR package/version/digest deletion IDs, shared items retained for surviving releases, no-reuse reservation, known/unknown GHCR eligibility, последствия API refusal/частичного multiimage удаления и inventory hash. Получить финальное подтверждение на этот пакет; любое изменение его identities/preconditions отменяет gates/approval.

После recheck, local checkpoint lock и запуска единственного trusted serialized mutation workflow tool journal выполняет:

1. Удалить exact target-only GHCR package versions/manifests после полного ownership/known-constraints preflight и concrete confirmation. При unknown eligibility первый approved deletion проверяет серверное разрешение; при отказе остановиться до Release/tag/master, не объявлять удаление успешным. Каждый platform/package deletion journal отдельно; частичный multiimage результат → PARTIAL/resume exact IDs. Проверять API removal и unauthenticated version pull/manifest resolution. Immutable digest может оставаться технически referenced surviving release: это разрешено только если target version publication полностью удалена и surviving owner доказан; inventory фиксирует shared digest, не обещает удаление самого shared blob. Provider retention/cache отсутствие нельзя объявлять доказанным немедленно без supported readback.
2. Только после удаления всех exact target GHCR versions удалить GitHub Release по exact ID и проверить Release/assets absence. Immutable GitHub Release запрещает перемещать/удалять его tag, пока Release существует, поэтому tag update не опережает Release deletion.
3. CAS atomic Git ref transaction удаляет target version tag и перемещает master на pinned parent или удаляет root master. Не использовать произвольный force reset. При unsupported atomic — правила contract; при protection refusal остановиться.
4. Проверить remote tag/Release/assets/target GHCR version absence и parent master/ABSENT, default develop, surviving releases/images intact. Persist ROLLED_BACK только при доказанных всех постусловиях. Root не требует prior image, которого нет; для later проверить surviving parent publications. Reservation неизменна; hidden backup tags, retained target Release/version или extra restore-mode запрещены.

Deletion order может оставить частичный публичный state; нельзя гарантировать cross-system atomicity. Если остановка после частичного GHCR deletion или после Release deletion до tag/ref deletion, явно сообщить completed/remaining identities; никогда писать «rollback completed».

## Resume exact operation

Перед каждым retry reconciliation читает remote IDs, Git refs/objects и journal, сравнивает с pinned state. Existing equal artifact = completed step; отсутствующий ожидаемый artifact = verify absence; unexpected/mismatched artifact = CONFLICT. Не создавать новый candidate commit, не менять source/version или operation ID, не использовать удалённую версию для новой операции. Reservation consumed даже при полном удалении.

Resume mutation допускается под still-valid original concrete approval только при неизменном пакете, pins и актуальных обязательных gates соответствующего mode. Изменённый scope/refs/state требует fresh gates и новой final confirmation; конфликт не решать автоматической republish/compensation. Перед rollback частичной publish операции tool строит отдельный deletion inventory/intent и получает финальное подтверждение: публикация не разрешает удаление.

Checkpoint — recoverable cache/log, reservations — durable no-reuse source. Backup переносит safe named state вне release tree, remote IDs остаются authoritative. Если потерян cache и remote metadata недостаточно однозначны, BLOCKED, восстановить из verified backup; нельзя угадывать IDs или стирать весь package.

## Provenance, не runtime зависимости

- GitHub package deletion limits, granular admin permissions и Support: https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package
- Packages REST schema/version delete endpoints (no documented download_count): https://docs.github.com/en/rest/packages/packages
- GitHub immutable release/tag и release deletion constraints: https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository

В Plan26 preflight проверять актуальные provider capabilities. Эти внешние документы объясняют ограничения API; обязательный workflow остаётся внутри `ebb-*`.
