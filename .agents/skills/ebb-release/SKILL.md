---
name: ebb-release
description: Используй только при явном вызове пользователем ebb-release для подготовки, публикации, отката или восстановления прерванного релиза Ebb Orchestrator.
metadata:
  project: "ebb-orchestrator"
  version: "1.0.0"
---

# Ebb Release

Релиз — подтверждённый snapshot в `master`, annotated version tag, GitHub Release и проверенные **PUBLIC GHCR Docker images**. Deployment не входит в релиз. Skill запускается только явным вызовом; завершение задачи, PR, merge, CI или готовность ветки не запускают его автоматически.

## Порядок работы

1. Уточни режим: release, hotfix, rollback, resume или status. Загрузи [release-policy.md](references/release-policy.md) для истории/source/version и [release-tool-contract.md](references/release-tool-contract.md) **до любого действия**. Определи repo/remote/worktree через `ebb-repository-context` и `ebb-worktree`; не создавай случайный worktree.
2. **Если tools отсутствуют или не проверены — исполнение BLOCKED:** необходимые repository tools реализует Plan26. Пока весь контракт не реализован и не проверен, сообщи точный blocker; допустимы только чтение и подготовка reviewable требований. Запрещены ad-hoc Git/GitHub/GHCR shell/API удаления или публикация вместо tools. Имена команд в reference — спецификация, не существующая реализация.
3. После реализации используй только `node scripts/release.mjs` с `prepare|validate|publish|rollback|resume|status` по контракту. `prepare` выполняет read-only preflight и локальную подготовку. Для zero-release legacy `master` требуется отдельный reviewed preflight transition Plan26; готовность релиза не разрешает удаление этой ветки.
4. Для release/hotfix выбери версию: явный стабильный SemVer пользователя либо предложи bump по совокупным изменениям с прошлого surviving release и спроси. Версия должна быть навсегда зарезервирована обычным reviewed PR в `develop` **до** pin. Зафиксируй source SHA/tree, old master или ABSENT и candidate SHA; full SHA обязателен. Первый candidate — root, последующий имеет только old master как родителя. Candidate tree точно совпадает с approved source tree; metadata хранится вне дерева.
5. Для rollback/resume сначала загрузи [rollback-recovery.md](references/rollback-recovery.md). Инвентаризируй точные remote IDs; rollback допускается только для последнего surviving release. Root rollback удаляет `master`, later rollback перемещает его на единственного родителя. Удаляются Release/assets, tag и точные GHCR versions/manifests; версия остаётся consumed навсегда.
6. Для publication выполни полные обязательные local и CI platform gates, `ebb-quality-gates` и `ebb-final-review`. Для rollback выполни полный обязательный набор withdrawal safety checks из policy: identities/parent provenance, permissions/deletability, tool regression и актуальные local/CI safety checks; failing tests отзываемого продукта не блокируют отзыв. Используй [release-evidence.md](references/release-evidence.md). Missing/failed/skipped gate, неполный inventory, доказанный запрет удаления или ref drift → BLOCKED. Неизвестная GHCR deletion eligibility раскрывается в confirmation; проверяется первым подтверждённым target-only GHCR deletion до Release/tag/master. Не заменяй полный набор partial suite.
7. Только после готового evidence покажи конкретный пакет публикации/удаления и получи финальное явное подтверждение пользователя на **эти identities и действия**. Ранний общий запрос «сделай релиз» не заменяет его. Изменение source/old master/candidate/remote inventory/gates аннулирует evidence и подтверждение.
8. Выполни подтверждённую операцию под bounded mutex, затем remote verification. Частичный успех → PARTIAL, persistent checkpoint и resume exact IDs; никогда не новый commit/version или фиктивный общий успех.

Report: operation/status, version, pinned identities, gates, ссылки/IDs публикаций или доказательства удаления, limitations и next action. Secrets/tokens не записывай в metadata, logs, evidence или checkpoints.
