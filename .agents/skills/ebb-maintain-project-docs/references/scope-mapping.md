# Scope и ownership

## Два режима

| Режим | Обход | Claim |
|---|---|---|
| Changed-scope sync, по умолчанию | Из changed paths и task intent найди affected package/service/config owners; добавь root/consumer README, если изменились их публичные setup/commands/API/config instructions, и соответствующие examples/языковые варианты. | Только покрытые owner contracts актуализированы; остальные файлы не проверялись. |
| Full audit, по явному запросу | Перечисли **все** first-party README и `.env.example` в repository/workspaces, включая вложенные packages/services/tools и language variants; проверь ожидаемые missing files у реальных владельцев. | Полнота относительно записанного inventory и исключений, с отдельными unverified claims. |

Начни с tracked/workspace inventory (`rg --files`, Git paths, workspace manifests), затем учти относящиеся untracked first-party files. Поиск не ограничивай корнем, extension filter или случайным default ignore: hidden `.env.example` и поддерживаемые multilingual README должны попасть в inventory. Не проходи symlink за repository boundary. Не открывай реальные `.env*`, кроме явно identified example/template files; не печатай содержимое секретов.

Исключи third-party/vendor/dependency caches, build outputs, чужие submodules и архивы с evidence ownership. Generated first-party README/examples остаются в coverage, но получают generator/source owner, а не direct-edit action. Ignore rule сама по себе не доказывает third-party ownership. Если граница неясна, запиши unresolved scope и продолжай независимые owners.

## Compact map

Достаточно строк `path | owner/purpose | language | mode/env namespace | canonical sources | action | check` в текущем task evidence. Actions: `update`, `create`, `unchanged`, `generated via source`, `excluded(reason)`, `blocked(reason)`. Не создавай постоянный registry, если в проекте его нет.

| Owner | Что проверять |
|---|---|
| Repository root | Назначение реализованного проекта, ecosystem entrypoints, общий quick start, service/package map и links к scoped instructions. |
| Package/library/CLI | Public entrypoint/API или CLI flags, actual examples, install/build/test в нужном cwd; package README не наследует автоматически root commands. |
| Application/service | Dev/build/run/deploy contracts, поддерживаемые environments, dependencies и свои config files/runtime namespace. |
| Tool/example/folder с документированным contract | Назначение и границы, actual invocation и outputs, links к owner; наличие папки само по себе не требует README. |

Отсутствующий root README создавай по actual project identity. Nested README создавай там, где самостоятельный owner/entrypoint нуждается в scoped instructions; не создавай README в каждом каталоге. `.env.example` создавай у тех owners/environments, где фактический loader/setup использует такой file contract; отсутствие env-file loading не даёт оснований изобретать его. Для env-only deployment зафиксируй поддерживаемый convention или gap.

File relocation, изменение структуры docs и удаления файлов требуют `ebb-repository-maintenance`. Этот owner обновляет содержание и ссылки вслед за уже согласованной структурой. Удаление устаревшего раздела/ключа внутри файла допустимо только после проверки consumers и применимости; conflicting source/docs — finding с anchors, не молчаливое изменение продукта.
