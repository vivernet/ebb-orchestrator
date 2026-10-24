# История, source и версии

## Ветки и snapshot

- Git default branch — `develop`; development и task branches исходят из `develop`. Task PR интегрируются squash merge в `develop` после gates/review. Этот workflow не публикует релиз.
- `master` содержит только уже опубликованные release snapshots. До первого релиза ветка отсутствует. Никаких baseline/dummy commits, legacy development history или скрытых archival tags.
- Если релизов ноль, но `master` существует (включая `master = develop`), `prepare` возвращает `BLOCKED_LEGACY_MASTER`. Plan26 отдельно реализует reviewed preflight transition: доказать отсутствие всех релизов/публикаций, перевести default branch на `develop`, проверить rulesets/worktrees/remote refs, составить inventory и получить точное отдельное подтверждение удаления старого `master`. Этот skill сам не выполняет переход и не сохраняет legacy master как release parent.
- Первый candidate commit — root без родителей; его tree равен pinned approved source tree. Позднейший candidate имеет ровно одного родителя — pinned old master — и то же точное дерево source. Candidate не merge commit, development ancestry не переносится в master.
- Metadata не добавляет файл в source tree. Immutable commit message включает full source SHA/tree, previous master/ABSENT, version, operation ID и repository identity; annotated tag и GitHub Release дополнительно включают вычисленный candidate SHA. Не записывать candidate SHA в собственный commit message: это self-hash circularity. Object SHA вычисляются deterministic tools; abbreviated SHA недостаточно.
- Source normal release — approved `develop` после reservation PR. Все три refs/objects pin до gates. Перед подтверждением и каждой remote mutation проверять drift; изменённый develop tip/source ref, old master, tag или candidate отменяет evidence/approval. Partial operation при drift останавливается для согласования, не начинает новую публикацию.
- Не merge snapshot `master` обратно в `develop`: он имеет искусственную release ancestry. Изменения переносить по исходному source/fix history через reviewed PR.

## Durable no-reuse

Предлагаемый обязательный source of truth — append-only `docs/releases/version-reservations.json` на защищённой `develop`, отдельный от master/tags и local checkpoint. Схему и контроль append-only реализует Plan26.

1. Явная версия — стабильный SemVer `MAJOR.MINOR.PATCH` без prerelease/build suffix; расширение диапазона требует отдельного reviewed policy change. Версия без автоматического угадывания; если версии нет, предложить SemVer bump по aggregate diff с full source SHA последнего surviving release до current approved source. Для первого релиза предложить initial version и спросить. Breaking/public compatibility changes → major, backward-compatible feature → minor, fixes → patch; окончательное значение выбирает пользователь.
2. Обычный reviewed PR на `develop` добавляет запись `{version, operationId, intent, reservedAt}`; существующие записи нельзя удалять/менять. `intent` = release или hotfix. Reservation навсегда потребляет версию, даже при отмене, failure или rollback. CI проверяет schema, uniqueness и append-only diff относительно merge base; branch protection обязательна, bypass запрещён.
3. PR должен быть merged и remote develop reservation подтверждён **до** pin source. Подготовка reservation через `ebb-write-plan`/`ebb-implement-task`/`ebb-finish-branch` — обычный integration workflow, не permission на publish.
4. Наличие свободного tag имени, отсутствие GitHub Release или удалённый image не означает свободную версию. Если reservation history недоступна/повреждена или authorization operation ID не совпадает → BLOCKED. Разрешён только resume исходной операции с той же записью.
5. Reservation файл находится в source tree для обычного release; candidate tree остаётся exact source tree. Runtime checkpoints находятся вне tree. GHCR path нормализует SemVer по единому проверенному encoding, инъективному для разрешённых stable version tags; collisions/unsupported version → BLOCKED, никогда silently overwrite.

## Hotfix

- Начать fix branch от full source SHA опубликованной surviving версии, указанного в её verified metadata; записать base version и base source SHA. Не исходить из искусственного snapshot ancestry.
- Версию всё равно reserve reviewed PR в `develop`; release source затем pin на approved hotfix SHA/tree, а reservation proof — на актуальном develop SHA. Candidate parent = current surviving master, даже если base fix более ранняя версия.
- Выполнить полный local/CI release gate набор на hotfix candidate и reviewed forward-port fix в `develop`. Записать exact forward-port PR/commit. Пока forward-port не verified merged, нормальный следующий релиз BLOCKED. Rollback не отменяет обязательство forward-port; отмена/новая политика требует отдельного решения.
- Hotfix source tree не дополнять reservation или metadata файлами вне approved source: соблюсти exact tree.

## Публикации

Git refs + annotated version tag + GitHub Release/assets + tested PUBLIC GHCR image versions по exact version. Deployment отсутствует. Mutable aliases (`latest`, `stable`, rolling minor) по умолчанию запрещены; их нельзя silently создать или переместить. Public visibility должна быть remote verified; unsupported permissions/private-only publication → BLOCKED.
