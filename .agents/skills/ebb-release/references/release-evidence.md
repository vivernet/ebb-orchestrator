# Fresh gates и конкретное подтверждение

## Ready package

Для publication до финального вопроса собрать единый evidence record, hash которого tool привязывает к approval:

| Объект | Обязательное доказательство |
|---|---|
| Source | Full source SHA/tree, source ref, repository ID, approved PR/review, version manifest |
| History | Old master SHA/ABSENT, candidate SHA/tree, 0 или ровно 1 parent, exact tree equality, surviving release metadata |
| Version | SemVer пользователя, merged reservation PR/remote develop SHA, unique operation ID, неизменность append-only истории |
| Local gates | Полная mandatory suite из pinned `.ebb/release-policy.json`: commands, SHA/tree, platform, exits, counts, logs; `git diff --check` и чистый worktree |
| CI gates | Required workflow/check IDs и все обязательные платформы/architectures, exact candidate SHA/tree, conclusion, event/ref, immutable run URLs/IDs; no skipped/missing/stale runs |
| Specialist | Applicable DB fresh/upgrade/schema/data; security; Web/E2E; docs и migrations по project policy; N/A только с обоснованием scope |
| Images | Все packages/platforms, tested OCI digests/index, labels source/version/candidate, smoke tests; публикация version-only; проверяемая PUBLIC visibility |
| Review | `ebb-final-review` PASS, нет unresolved BLOCKER/IMPORTANT; scope/secret scan |
| Remote preflight | Git/GitHub/GHCR exact inventories, permissions/rulesets, default develop, lock capability, known deletion constraints, count если реально доступен, explicit unknown eligibility и shared-digest ownership для rollback |
| Recovery | Operation checkpoint/backup integrity, authoritative identities, CAS expectations и final verification plan |

Для rollback использовать отдельный полный configured withdrawal safety набор: exact identities и parent provenance, permissions/known download/deletion constraints/shared ownership и disclosed unknown eligibility, tool regression и актуальные local/CI safety checks. Product tests дефектного target могут быть красными и не запрещают отзыв публикаций; rollback не deployment/data change. Root case не имеет surviving parent image; later case проверяет surviving parent artifacts. Этот набор всё равно обязателен до final rollback confirmation.

`ebb-quality-gates` задаёт freshness discipline; config задаёт exact mandatory platform matrix. Если tool/config/workflow ещё не существует, это BLOCKED, а не N/A. CI candidate validation runs **до** publication, через reviewed validation workflow на pinned source/candidate либо authorized temporary operation ref; `push master` tests после публикации не заменяют pre-release evidence.

Каждый fresh gate связан с source SHA/tree, candidate SHA/tree, old master, policy hash и target inventory. Ранний тест development HEAD, old CI run или отдельный зелёный lint не доказывает release readiness. При ref/inventory/policy drift все связанные результаты и approval становятся invalid; обновить preparation и повторить mandatory gates до нового решения.

## Final release confirmation

Показать пользователю одну reviewable карточку: version; full source SHA/tree; old master/ABSENT; candidate SHA/parent/tree; tag name/object; GitHub repository/Release/assets plan; PUBLIC GHCR packages/version tags/OCI digests/platforms; gate results/CI links; reservation proof; operation ID; action hash; exact side effects, recovery caveat. Затем спросить «Подтверждаете публикацию этого пакета?» Указание только версии или «готово?» недостаточно. Не спрашивать до полной подготовки/gates.

## Final rollback confirmation

Показать target version/full candidate/source, current master и next parent/ABSENT, exact Release/assets/tag/GHCR deletion IDs, shared digests/owners surviving releases, known deletion constraints/explicit unknown GHCR eligibility и first-deletion API refusal/partial consequences, fresh withdrawal safety results, consumed reservation, operation/action hashes и deletion consequences. Затем спросить «Подтверждаете удаление этих публикаций и изменение master?» Root case прямо говорит «master будет удалён»; не обещать восстановление deleted version.

## Terminal claims

- PUBLISHED: readback exact Git refs, annotated tag/metadata, Release/assets checksum, every tested PUBLIC image/version/platform, default develop; authorized temporary candidate ref удалён.
- ROLLED_BACK: target tag/Release/assets/version publications отсутствуют; master=parent или ABSENT; surviving public images/releases intact; reservation retained; temporary operation ref удалён.
- PARTIAL: перечислить completed steps и exact leftovers, checkpoint/backup location без secrets, conflict/gates/approval validity и command intent для resume. Нельзя скрыть partial failure общим PASS.
- BLOCKED: named missing contract/capability/gate/permission/deletion constraint и action для Plan26/пользователя/GitHub Support. Read-only status не означает готовность публикации.
