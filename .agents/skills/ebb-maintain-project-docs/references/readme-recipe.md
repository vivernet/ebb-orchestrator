# README recipe

## Evidence перед текстом

Для каждой factual change найди source anchor: manifest/workspace scripts и lockfile/runtime requirements; actual entrypoint/CLI parser/public exports; dispatcher и config loader; tests, поддерживаемые examples и deployment definition. Предыдущий README, badge или roadmap не подтверждает behavior. При расхождении docs и реализации документируй реализованное и зафиксируй load-bearing gap; не исправляй implementation скрыто. Незавершённые possibilities явно отделяй от текущих capabilities либо оставляй вне README.

Commands записывай с cwd, prerequisites, выбранным environment и назначением. Проверь, что script действительно существует, flags принимаются, command chain не является exit-0 stub, указанные ports/paths/outputs соответствуют source. API examples используй с реально exported symbols и актуальными request/response/CLI shapes. Пример из чужой ecosystem не переносится по аналогии.

## Рецепт по аудитории и проекту

Сначала определи читателя: user/operator, library consumer или contributor. Дальше выбери только полезные sections; универсальное оглавление не является обязательным.

| Контекст | Полезное содержание |
|---|---|
| Root | Короткое назначение и реализованные возможности; requirements; минимальный рабочий путь до first useful result; map packages/services и scoped setup links. |
| App/service | Development setup и production build/start раздельно; local dependencies; configuration/example path; наблюдаемый результат запуска и shutdown, если это существенный contract. |
| Library | Installation/import с actual package name, минимальный public API example, compatibility/limitations; contributor build/test отдельно от consumer usage. |
| CLI/tool | Installation/invocation, inputs/flags, useful output example, exit/failure semantics и side effects по actual parser/runner. |
| Contributor scope | Точные test/lint/build commands, cwd и supported workflow; ссылки на canonical architecture/policy вместо копирования больших разделов. |

Quick start — кратчайший подтверждённый путь. Если dev и production различаются install flags, build artifacts, ports или env files, покажи два отдельных paths; не объединяй их в misleading chain. Optional integrations вынеси из обязательного setup и поясни opt-in prerequisites. Если запуск требует внешний provider/secret, опиши подготовку и честную границу проверки.

Сохраняй работающие relevant instructions, выбранный тон и языковую структуру. В Ebb human-facing prose по умолчанию русский; code fences, identifiers, paths, package names и protocol literals не переводятся. Обновляй applicable language variants вместе либо фиксируй translation gap. Не вставляй YAML frontmatter/version/date служебного skill в README и не перенумеровывай его имя.

## Review результата

Проверь promises по source, пригодность commands/examples для указанного owner, relative links/anchors с точки расположения файла и поддерживаемые external links. Новые cross-file links должны вести в actual targets. Не используй массовое format-only rewriting: точные sections сохраняют содержание, а точный README остаётся `unchanged`.
