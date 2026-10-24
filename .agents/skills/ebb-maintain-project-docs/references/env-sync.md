# Синхронизация .env.example

## Source-to-key contract

Читай schema/loader/validation и путь запуска **до** заполнения example. По actual source установи: ключ, owner и consumer, mode/namespace, required condition, default при отсутствии, type/allowed values, отличие omitted/empty, env-file name/cwd и precedence. Schema — сильный источник, но wrappers/entrypoint могут изменять loading/override semantics. Tests подтверждают неоднозначные conversions; имя переменной не определяет тип.

Поиск literal env reads — подсказка для трассировки, а не готовый список `.env.example`. Исключай платформенные `PATH`, `HOME`, runtime/CI-injected env и third-party internals, пока явный first-party config contract не делает их пользовательским setup. Dynamic accesses (`env[key]`, prefix/namespace expansion, binding tables) проследи до конечных keys по config/schema/registry/declared plugins; отсутствие списка зафиксируй как unresolved gap, не выдумывай exhaustive keys.

Используй compact evidence `example path | key | owner/mode | source anchor | required/default/type | representation | verification`. Не помещай secret values в evidence. Реальные `.env`, credentials, shell environment dumps и production secret stores для этой работы не нужны; не читай и не копируй их.

## File и namespace

| Источник | Что означает | Куда документировать |
|---|---|---|
| App dotenv/config loader | File path, cwd и precedence определяют runtime config процесса. | Example, принадлежащий этому app/service/environment, плюс scoped README. |
| Compose `${VAR...}` interpolation | Переменная подставляется Compose на host; это ещё не означает передачу контейнеру. | Host/Compose example согласно actual `--env-file` или project convention. |
| Compose `environment` / `env_file` | Значения и files передаются runtime service с собственным precedence. | Соответствующий service example; объясни отличие от host interpolation. |
| Separate worker/web/server namespaces | Каждый процесс может иметь разные keys, requirements и env files. | Сохраняй owner boundaries; не сливай всё в root file без loader evidence. |

Не заставляй все environments читать `.env`: обнаружь существующий loader/deployment contract. Проверь browser-public variable prefixes отдельно от server-only secrets. Не добавляй production значения в client-visible example. Создай missing example только при подтверждённом file contract/convention; если filename/loading нужно изменить, передай эту часть в `ebb-repository-maintenance`.

## Как записывать значения

- Required keys включай с безопасным переносимым placeholder и комментарием назначения/типа; placeholder не является credential или обещанием готового production setup. Для local-only URL/path/port используй подтверждённый development contract; machine-specific absolute paths не переносимы.
- Optional с loader default оставляй omitted или commented (`# PORT=4100`) и объясняй default. Active empty assignment может подавить default или не пройти validation: `PORT=` не равен отсутствующему `PORT`. Активируй optional key только при source-backed причине и валидном значении.
- Opt-in integrations оформляй commented sections; их conditional required keys активны только для соответствующего режима. Не включай fake enabled provider по умолчанию.
- Enum/boolean/number/duration formats указывай по parser, а не предположению. Quoting/escaping должен поддерживать actual env-file parser. Optional secret placeholder держи commented; required secret обозначай явно с настройкой пользователя.
- Deprecated key удаляй только при evidence отсутствия поддерживаемых consumers/modes; migration instructions сохраняй, пока применимы. При unknown consumer оставь finding. Не меняй loader/default/schema ради красивого example.

Generator-owned example обновляется через schema/template/generator. Не редактируй одновременно output вручную и его source как две независимые истины.

## Проверка

В isolated provider-free context проверь loader на безопасных synthetic values: required missing/invalid, default при omission, empty behavior, валидные types и disabled opt-in. Проверяй только существующие safe paths; dotenv parse success без actual loader не доказывает configuration semantics. Required credentials placeholders обычно проверяются на понятную validation failure или подменённом чистом config unit path; не запускай real provider. Для Compose проверяй effective interpolation/runtime mapping только с synthetic env и доступной isolated validation command, не выводя реальные credentials.
