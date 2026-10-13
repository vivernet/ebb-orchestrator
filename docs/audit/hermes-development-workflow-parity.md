---
id: audit-hermes-development-workflow-parity-current
kind: audit
status: proposed
title: Текущая проверка Hermes development workflow parity
date: 2026-10-08
---

# Hermes development workflow parity — текущая попытка

## Снимок и границы свидетельств

- Дата составления: 2026-10-08, Europe/Moscow (UTC+03:00).
- Ветка: `develop`.
- HEAD при составлении отчёта: `7722c3f2cee0099d0177a95b19488fb9e7b516cf`.
- `git status --short` до создания отчёта: чистый.
- Итоговый `git status --short` после финализации этого отчёта:
  `?? docs/audit/hermes-development-workflow-parity.md`.
- Единственный изменённый файл: `docs/audit/hermes-development-workflow-parity.md`.
- Источник результата попытки: сводка текущего execution и fixture
  `scripts/fixtures/hermes-development-workflow-parity-plan.md`. В
  `temp/plan19-plan20-recovery-ledger.md` нет записи с командой и результатом
  Task 7; поэтому точные временные метки запуска/завершения, сырые логи и
  post-run Git status в ledger отсутствуют и здесь отмечены как `NOT VERIFIED`.
- Существующий
  `docs/audit/05-hermes-development-workflow-parity.md` — явно исторический
  снимок от 2026-09-22; он не является evidence этой попытки.

## Делегирование

В подготовке участвовали два Codex prep агента: `/root/plan07_repo_rules_check`
и `/root/plan07_skill_contract_check`. По сводке execution они выполняли
независимые read-only проверки параллельно и завершились без дочерних агентов.
Их точные start/end timestamps и отдельные persistent agent IDs в ledger не
зафиксированы (`NOT VERIFIED`).

Эти Codex prep агенты не являются Hermes child agents. Выполнение требования
fixture о двух внутренних Hermes subagents **не подтверждено**: Hermes
execution завершился до получения проверяемых Hermes child IDs или результатов.
Число и дерево внутренних Hermes процессов — `NOT VERIFIED`.

## Команды и результаты

| Команда / проверка | Результат | Evidence и ограничения |
|---|---|---|
| `pnpm hermes:check` | PASS, exit 0 | По сводке execution: проверены CLI, `.hermes.md`, 20 canonical skills, project trust, discovery и delegation settings. Сырые строки вывода и timestamp в recovery ledger не сохранены. |
| `HERMES_EXECUTE_TIMEOUT_MS=900000 pnpm hermes:execute -- scripts/fixtures/hermes-development-workflow-parity-plan.md` | **FAIL**, завершение `TERMINATION_FAILED`, exit 125 | Hermes parity run не завершился; provider-backed результат и Hermes child IDs не получены. Маркер завершения приведён в сводке execution, но отдельная запись отсутствует в recovery ledger. |
| `pnpm lint` | PASS, exit 0 | Общий свежий quality gate из recovery ledger; он не доказывает parity. |
| `pnpm typecheck` | PASS, exit 0 | Общий свежий quality gate из recovery ledger; он не доказывает parity. |
| `pnpm test` — elevated full run непосредственно перед checkpoint commit `7722c3f` | PASS, exit 0 | Запуск был на том же tracked tree content, который вошёл в `7722c3f`; между запуском и commit tracked-файлы не менялись. Server 153 files passed / 2 skipped, 1,527 passed / 31 skipped; web 219/219; contracts 4/4; root acceptance/smoke 28/28. Это общий quality gate, не Hermes provider acceptance. |
| `pnpm test` — предыдущий restricted-executor run | FAIL, exit 1 | Семь ошибок в трёх Windows native suites остановились на отказе доступа к родительскому каталогу (`parent-directory-open-index-1-win32-5`, exit 126). Этот запуск не является последним пригодным результатом полного gate; последующий elevated full run прошёл. |
| `pnpm docs:check` | PASS | Recovery ledger отмечает успешную проверку; для требуемого точного имени этого audit-файла есть предупреждение о числовом имени файла. |
| `pnpm docs:test` | PASS, 20/20 | Общая документационная проверка из recovery ledger; не доказывает parity. |
| `git diff --check` | PASS, exit 0 | Выполнен после создания отчёта; whitespace errors отсутствуют. |

## Требуемые parity evidence

- Fixture перед запуском требовал ровно двух параллельных read-only context
  checks, затем repository gates, фактическое обнаружение canonical skills,
  Hermes provider-backed выполнение, проверку child processes и cleanup.
- Два Codex prep агента проверили repo rules и skill contracts, но не заменяют
  Hermes delegation.
- Provider-backed выполнение Hermes: **NOT VERIFIED**. Успешная команда
  `pnpm hermes:check` означает только readiness/check, а не выполнение parity
  плана через провайдера.
- Доступность итогового parity report от Hermes: **нет**. Запрошенный здесь
  файл — FAIL-отчёт координатора; он не является report от Hermes.
- После timeout выполнена ограниченная проверка процессов/артефактов: Hermes-
  named process и parity command не обнаружены, wrapper shell завершился,
  prompt temp-файл не найден. Это точечные наблюдения после завершения, а не
  доказательство очистки всего дерева Hermes children: точные child IDs и
  результаты недоступны. Поэтому остановка/завершение всего Hermes child tree
  и cleanup остаются **NOT VERIFIED**. Отсутствие этих доказательств не
  трактуется как доказательство оставшегося процесса или артефакта.
- Baseline Git status до отчёта был чистым. Post-run `git status --short` для
  самой попытки Hermes не записан (`NOT VERIFIED`). После финализации отчёта
  точный status — `?? docs/audit/hermes-development-workflow-parity.md`; в
  worktree изменён только этот файл.

## Verdict

**FAIL.** Hermes parity execution завершился `TERMINATION_FAILED` / exit 125;
provider-backed evidence, проверяемые Hermes child IDs/results и cleanup
evidence отсутствуют. Общие lint/typecheck/test PASS не закрывают эти пробелы.
Статус `completed` в историческом аудите не меняет этот результат.

## Повторная попытка на `3ba97b6` — 2026-10-12

- Ветка `develop`, HEAD до запуска `3ba97b6` (`Упростить запуск Hermes и закрыть проверенные пробелы`). До запуска в Git был только ожидающий этот отчёт untracked-файл; остальной рабочий код был в контрольном коммите. `pnpm hermes:check` в обычном ограниченном executor завершился FAIL: `hermes --version` exit 1 без diagnostic output, остальные проверки были пропущены. Тот же `pnpm hermes:check` в обычной Windows-среде вне ограниченного executor завершился PASS: 8/8, включая CLI, canonical skills, project trust, discovery и delegation settings. Никакие Hermes settings не менялись.
- Запущено `HERMES_EXECUTE_TIMEOUT_MS=900000 pnpm hermes:execute -- scripts/fixtures/hermes-development-workflow-parity-plan.md` вне ограниченного executor около 23:18:57 MSK. Почти 15 минут команда не предоставляла stdout/stderr или итог. Запуск был вручную прерван около границы заданного лимита; shell завершился с exit 1 без diagnostic output/marker. Поэтому нельзя утверждать, сработал ли внутренний timeout wrapper. Результат — **FAIL / NOT VERIFIED**, а не timeout PASS или provider acceptance.
- До остановки snapshot процесса показывал `hermes.exe` PID 8932, `python.exe` PID 24416 и запускавшие их Node/pnpm процессы. После Ctrl+C повторный inventory не нашёл Hermes/Python или запускного Node/pnpm с временем старта этого прогона. Остался Node PID 16080, но его parent/executable подтвердили Adobe `CCXProcess.exe`; он не относился к parity-run. Это не даёт установить внутреннее количество Hermes subagents или доказать отсутствие всех detached children.
- Проверка `%TEMP%` обнаружила после старта 160 `git-integration-*`, 27 `git-merge-*`, 9 `git-wt-*`, 17 `repo-discovery-test*` каталогов и один `hermes-prompt-*` файл. Их имена сверены с `mkdtemp` в соответствующих repository tests и wrapper; CreationTime был внутри интервала запуска. Все 213 каталогов и файл находились непосредственно внутри системного Temp, top-level reparse point отсутствовал; prompt content не читался. После завершения процессов удалены только эти точные test fixtures и wrapper prompt file; повторная проверка показала `remaining=0`. Это подтверждает cleanup известных нам temp artifacts, но не доказывает отсутствия неизвестных detached Hermes children без их IDs. Worktree-файлы проекта не менялись; новый root artifact всё ещё только этот отчёт.
- Провайдерский ответ, Hermes child IDs/results ровно двух внутренних read-only subagents и их параллельность не получены. Wrapper exit 1/отсутствие диагностического вывода, присутствие одного Hermes process или свежие локальные quality gates не заменяют эти требования. Повторять команду без root-cause для зависания и процесса cleanup нельзя считать выполнением Task7.
- Read-only code review `scripts/hermes-dev.mjs` объясняет отсутствие промежуточного вывода: wrapper намеренно отбрасывает каждый stdout/stderr chunk, а единственный marker печатает только после завершения Hermes. Его timeout path отправляет запрос `taskkill /T /F`, немедленно завершает Promise без ожидания process `close` и без подтверждения всего tree; обработчика SIGINT/SIGTERM нет, поэтому ручное прерывание могло обойти `finally`. Это выявленный пробел наблюдаемости/подтверждения cleanup, но он не доказывает, что именно произошло в остановленном запуске. В рамках разрешённого scope текущего parity-run runner не менялся.

**Итоговый verdict остаётся FAIL.** Известные test fixtures и prompt-файл очищены после STOPPED процесса; provider-backed результат, точное Hermes delegation evidence и завершение всех потенциальных detached children остаются `NOT VERIFIED`.

## Повторная попытка после checkpoint `3ba97b6` — 2026-10-13

- Запуск: `HERMES_EXECUTE_TIMEOUT_MS=1200000 pnpm hermes:execute -- scripts/fixtures/hermes-development-workflow-parity-plan.md`. Wrapper prompt-файл создан в `%TEMP%` в 23:42:17 MSK; завершение произошло примерно через 20 минут. Итоговый marker: `HERMES_EXECUTE marker=TERMINATION_FAILED exit_code=125 redacted=true cleanup_verified=true`. Provider-backed result и отчёт parity отсутствуют; это **FAIL / NOT VERIFIED**.
- До timeout были видны `hermes.exe` PID 6304 и принадлежащий этому запуску Python PID 28372. После завершения оба отсутствовали; оставшийся Python PID 6568 стартовал 2026-10-11 и к запуску не относится. Wrapper prompt-файл после завершения отсутствовал. Это подтверждает отсутствие этих проверенных процессов и файла, но не доказывает child delegation structure/results.
- Проверка системного Temp нашла 306 прямых test-fixture каталогов, созданных в интервале запуска (`git-integration-*` 200, `git-merge-*` 54, `git-wt-*` 18, `repo-discovery-test-*` 34). Все были непосредственными дочерними каталогами `%TEMP%`, без reparse points в деревьях; процессы Hermes/Python запуска уже отсутствовали. Удалены только эти каталоги; повторная проверка: `remaining=0`. Имена соответствуют repository test fixture categories. Prompt content не читался.
- Runner timeout завершился именно `TERMINATION_FAILED` (exit 125), а не PASS. В выводе `cleanup_verified=true` относится к удалению wrapper prompt-файла; оно не является подтверждением provider acceptance или Hermes subagent cleanup. Точное число Hermes subagents и результаты двух обязательных read-only checks отсутствуют.

**Итоговый verdict остаётся FAIL / NOT VERIFIED.** Этот повтор не закрыл Task7 и не даёт основания повторять запуск без изменения причины timeout/termination и безопасного подтверждения полного process teardown.

## Повторная попытка по fixture после восстановления сессии — 2026-10-13

### Снимок и границы

- Дата завершения проверки: 2026-10-13, Europe/Moscow (RTZ, UTC+03:00); final snapshot получен в 02:42:40.
- Ветка: `develop`. Начальный HEAD этой попытки: `cd7d525ffc53ec277502644f927ef0527f037ff4`. Финальный HEAD: `c0695a6c7e69b9b8221393c9e48cfcfad72d8fd8`.
- Между начальным и финальным HEAD появились только изменения в `docs/architecture/plans/19-unfinished-plan-closure.md` и этом audit-файле; `git diff --name-only cd7d525..c0695a6` подтвердил doc-only изменения. Поэтому успешные `pnpm lint` и `pnpm typecheck`, выполненные на начальном code tree, применимы к неизменившемуся коду текущего HEAD.
- Начальный `git status --short`: только `?? "Сравнение Ebb Orchestrator и OpenAI Symphony.md"`; этот посторонний untracked-файл не менялся. Fixture frontmatter остаётся `status: proposed`; прямое указание пользователя исполнять именно этот ограниченный audit трактовано как разрешение на запуск, не как разрешение менять статус или расширять scope.
- В рабочем дереве разрешено менять только `docs/audit/hermes-development-workflow-parity.md`. Не изменялись product code, tests, scripts, config или skills; commit/merge/push/tag/release не выполнялись.

### Task 1 — два параллельных read-only context checks

Вызов `delegate_19742488` вернул ровно два задания: `deleg_19742488/task-0` (A) и `deleg_19742488/task-1` (B), оба `completed`, model metadata `gpt-6-luna`. Это безопасное provider-backed evidence из Hermes delegation result/tool traces; credentials не читались и в отчёт не включались.

| Child | Наблюдаемые времена (+03:00) | Проверенный результат |
|---|---|---|
| `deleg_19742488/task-0` — A, repo rules | старт 02:00:37; final 02:01:17; 39.72 s | Прочитал `AGENTS.md`, Plan19 и `ebb-orchestrate-work`. Подтвердил primary branch `master` (`AGENTS.md:71-75`), required gates (`AGENTS.md:91-108`) и Task7 evidence/ограничения (`docs/architecture/plans/19-unfinished-plan-closure.md:319-337`). |
| `deleg_19742488/task-1` — B, skill rules | старт 02:00:37; результат 02:01:04; 27.44 s; transcript закрыт dispatcher в 02:01:17 | Trace подтверждает чтение всех четырёх назначенных skill-файлов. Финальная сводка агента вернула требования fixture, а не запрошенные выдержки skills; поэтому точные skill claims ниже независимо проверены контроллером по файлам на диске. |

Оба child стартовали одновременно. Суммарная длительность child runs — 67.16 s, aggregate dispatch duration — 39.97 s; наблюдаемое перекрытие составляет не менее 27.19 s. У A в trace только `read_file`/`search_files`, у B — только `read_file`; ни один trace не содержит вызова delegation или записи файлов. Dispatcher вернул ровно два task records, дополнительных child в этом вызове нет.

Фактически проверенные canonical `.agents/skills/` evidence:

- `.agents/skills/ebb-orchestrate-work/SKILL.md:11-20` — canonical workflow внутри `ebb-*` skills, независимые исследования идут через `ebb-dispatch-agents`.
- `.agents/skills/ebb-dispatch-agents/SKILL.md:15-20` — self-contained brief, отсутствие конфликта mutable scope, leaf-agent не создаёт каскад delegation; controller сверяет trace/results.
- `.agents/skills/ebb-review-task/SKILL.md:11,19` — свежий независимый контекст и read-only review.
- `.agents/skills/ebb-final-review/SKILL.md:11-18` — независимая whole-change проверка без истории implementer и evidence-backed verdict.
- `.agents/skills/ebb-quality-gates/SKILL.md:15-29` — свежий run/read/verify, gates по scope, diff/status перед завершением.
- Fixture `scripts/fixtures/hermes-development-workflow-parity-plan.md:34-58,95-99` задаёт ровно двух параллельных read-only агентов и запрещает считать полный process tree проверенным без наблюдаемого evidence.

Ограничение: tool traces подтверждают отсутствие nested delegation calls и отсутствие третьей задачи в Hermes dispatcher result, но доступные инструменты не показывают полный OS-level process tree дочерних агентов. Требование полного дерева процессов не считаю подтверждённым.

### Task 2 — repository gates

| Команда | Результат | Evidence |
|---|---|---|
| `pnpm lint` | PASS, exit 0 | Вывод `$ eslint .`; запуск на `cd7d525`, код затем не менялся. |
| `pnpm typecheck` | PASS, exit 0 | `packages/testing`, `packages/contracts`, `apps/server` завершили `tsc -p tsconfig.json --noEmit`; запуск на `cd7d525`, код затем не менялся. |
| `pnpm test` — первый foreground run | TIMEOUT | Terminal достиг лимита 420 s без финального exit code. Промежуточный web результат не использовался как полный PASS. Старая session `proc_bacc2fda5455` стала недоступна (`not_found`), поэтому её результат не приписывается gate. |
| `pnpm test` — свежий background run | PASS, exit 0 | Точная session `proc_d020b0142daf`, PID 30692, `process_manage wait` вернул `exited`, exit code 0. Contracts: 4 files/7 tests passed; web: 22 files/219 passed; server: 151 files passed, 3 skipped, 1,842 tests passed, 29 skipped; root Node suites: 64/64 passed; `packages/testing` сообщил, что test files отсутствуют. Полный output сохранён process manager session. |
| `git diff --check` | PASS, final exit 0 | После промежуточного exit 2 (`new blank line at EOF`, строка 180) удалена только лишняя пустая строка; повторная проверка после финального текста завершилась exit 0. |

### Provider и cleanup evidence

- Provider-backed evidence доступно: delegation result содержит provider model metadata `gpt-6-luna`, статусы обоих child и реальные read/search traces. Это не вывод wrapper-маркера `COMPLETED`.
- После test run `process_manage list` показывает завершённую session `proc_d020b0142daf` с exit code 0; `tasklist /FI "PID eq 30692"` не находит wrapper PID. Это подтверждает завершение известного root process/session, но не отсутствие всех detached descendants.
- PowerShell `Get-CimInstance` query был заблокирован terminal safety policy; обход блокировки не предпринимался. Полный OS child tree и исчерпывающая проверка временных артефактов поэтому **NOT VERIFIED**. Логи теста подтверждают создание native build outputs в ignored `apps/server/dist/native/`; эти build outputs не удалялись.
- Отдельный read-only inventory `%TEMP%` по известным префиксам и временному окну именно этого `pnpm test` запуска обнаружил 203 оставшихся каталога: `git-integration-*` — 100, `git-merge-*` — 27, `git-wt-*` — 9, `repo-discovery-test-*` — 17, `hermes-prompt-*` — 50. Перед удалением для каждого точного пути проверены принадлежность `%TEMP%`, время создания, отсутствие reparse points у каталога и потомков; после проверки удалены только эти 203 каталога вне рабочего дерева. Повторный inventory по тем же префиксам и временному окну показал `remaining=0`. Это подтверждает cleanup известных test fixtures, но не исчерпывающую проверку всех возможных временных артефактов.
- Все 50 `hermes-prompt-*` каталогов были созданы около 02:40:35–02:40:36. В `apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts:988-999` `writePromptFile()` создаёт отдельный temp directory и prompt file; в `apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts:1546-1559` один прямой тест удаляет каталог в `finally`. Остальные совпавшие test artifacts удалены после подтверждения, что они относятся к этому запуску; production lifecycle/retention поведение не менялось и этой проверкой не принималось.
- Не заявляю, что все возможные временные артефакты удалены или что полное process-tree teardown доказано. Подтверждено удаление только 203 известных test-fixture каталогов и отсутствие совпадений по тем же префиксам/временному окну. Подтверждено также завершение известной root process session; проверенные процессы Hermes предыдущей попытки не обнаружены, а оставшиеся процессы Node/Python не приписываются этому запуску без доказанного parent/command-line evidence.

### Финальный статус и verdict

Финальный snapshot до обновления этого отчёта: branch `develop`, HEAD `c0695a6c7e69b9b8221393c9e48cfcfad72d8fd8`; `git status --short` содержал только исходный untracked-файл сравнения. Во время fixture session изменялся только audit-файл; после её завершения краткая запись результатов синхронизирована в Plan19. Текущее состояние подтверждается `git diff --check` и `git status --short`.

**Итоговый verdict: FAIL / NOT VERIFIED.** `lint`, `typecheck`, свежий background `test`, provider-backed параллельное выполнение и cleanup 203 известных test fixtures подтверждены. PASS запрещён, поскольку полный child process tree не подтверждён; исчерпывающий inventory всех возможных временных артефактов не выполнялся. Кроме того, финальная сводка child B не включила запрошенные skill excerpts, хотя чтение файлов видно в trace и их содержание проверено контроллером. Во время fixture session изменялся только audit report; после её завершения изменена соответствующая запись Plan19. Commit не выполнялся.

## Повторная попытка после lifecycle fix `cd7d525` — 2026-10-13

- Перед запуском checkpoint `cd7d525` содержал lifecycle fix Hermes runner; полный `pnpm test` завершился успешно (server 1842 passed / 29 skipped, web 219/219, contracts 7/7, root Node 64/64), а независимый review последней правки завершился `APPROVED`.
- Запуск: `$env:HERMES_EXECUTE_TIMEOUT_MS='2700000'; pnpm hermes:execute -- scripts/fixtures/hermes-development-workflow-parity-plan.md`. Он был вручную остановлен через Ctrl+C примерно через 20 минут, до внутреннего 45-минутного timeout. Shell завершился с exit 1 без `HERMES_EXECUTE` marker и без диагностического вывода. Это не внутренний timeout и не acceptance result.
- Перед остановкой наблюдались Hermes PID 25392, Node runner PID 30244 и Python PID 30516. После остановки все три проверенных PID отсутствовали. Это подтверждает остановку этих процессов, но не доказывает отсутствие незамеченных/detached Hermes descendants или структуру делегирования.
- После прерывания wrapper prompt `hermes-prompt-1791845875037.txt` оставался в `%TEMP%`. Его содержимое проверено: оно включало только общую инструкцию и путь fixture, без credentials или provider output. После проверки, что указанные процессы остановлены, удалён только этот точный prompt-файл; последующий inventory этого имени его не находит. Широкую уборку `%TEMP%` и удаление иных fixture-каталогов не выполняли.
- В durable execution ledger обнаружен результат Task 1: один parallel dispatch `deleg_19742488`, ровно два завершённых provider-backed read-only child task (`task-0`, `task-1`, оба `gpt-6-luna`); длительности 39.72 s и 27.44 s внутри 39.97 s aggregate подтверждают перекрытие. Traces показывают только read/search для A, read-only для B и отсутствие nested delegation calls. B summary не перечислил требуемые skill evidence, хотя trace подтверждает чтение всех четырёх skills. Доступ к OS-level child process tree отсутствовал. Эти данные подтверждают delegation slice, но не общий PASS.
- Hermes error log для session `20261013_015806_862947` дал причину части задержки и неполного завершения: `terminal` timed out after 420.0 s; отдельные tool failures включают отказ перезаписать уже существующий plan-owned ledger, `process_manage` `not_found`, schema error `todo_list` (нет обязательного `content`), блокировку shell-команды с `-e/-c` в single-query режиме и несовместимую на Windows команду `ps -o`. Свежий локальный root `pnpm test` длился 431.12 s, что согласуется с terminal limit, но не доказывает, что именно эта команда была тем timed-out вызовом. Existing ledger прочитан, сохранён без перезаписи.
- На момент этого checkpoint Task 2 был незавершён и Task 3 не достигнуты. Этот промежуточный статус закрыт в разделе «Завершение после восстановления сессии» ниже; не использовать его как итоговый результат.

## Завершение после восстановления сессии — 2026-10-13

- Работа продолжена по существующему execution ledger; после прямого указания пользователя новые subagents не запускались и Task 1 повторно не выполнялся.
- Task 2 завершён: `pnpm test` запущен в background, session `proc_d020b0142daf` завершилась с exit 0; подробные counts и подтверждение session приведены в разделе «Повторная попытка по fixture после восстановления сессии». `pnpm lint` и `pnpm typecheck` остаются применимыми: между их code checkpoint `cd7d525` и текущим `c0695a6` изменились только документы.
- Task 3 выполнен: добавлена только текущая запись в `docs/audit/hermes-development-workflow-parity.md`; исходный untracked-файл сравнения сохранён. Финальная проверка в 02:44:14: `git diff --check` exit 0; `git status --short` показал ` M docs/audit/hermes-development-workflow-parity.md` и `?? "Сравнение Ebb Orchestrator и OpenAI Symphony.md"`.

- Итоговый verdict остаётся **FAIL / NOT VERIFIED**: подтверждены gates и provider-backed параллельный dispatch, но полный child process tree и отсутствие остаточных temporary artifacts не подтверждены. Commit/merge/push/tag/release не выполнялись.
- Независимый final-review не выполнялся: прямое указание пользователя запрещало запускать новые subagents. Контроллер проверил финальный diff; отдельная независимая проверка отчёта остаётся внешним следующим шагом.

## Дополнение от 2026-10-13 — восстановление evidence существующей Hermes-сессии

- Без нового provider-запуска read-only экспортирована с redaction существующая session `20261013_015806_862947`; из неё и сохранённых delegation transcript восстановлены `manifest.json`, `task-0.log` и `task-1.log` для `deleg_19742488`.
- Hermes session store подтверждает ровно две дочерние Hermes-сессии, запущенные одновременно: A `20261013_020037_cf78fb` и B `20261013_020037_833e53`; обе завершены. `parent_session_id`, manifest и tool inventory подтверждают две прямые задачи и отсутствие вызова nested delegation. Это подтверждает Hermes delegation tree `session → два leaf tasks`, но не OS-level PID/process tree: в session store нет OS PID и parent-process links.
- Raw saved output B действительно содержит требуемые skill-цитаты: `ebb-dispatch-agents/SKILL.md:18` («Leaf-agent не расширяет scope и не создаёт каскад делегирования без явного разрешения controller contract»); `ebb-review-task/SKILL.md:11,19` («Reviewer работает в свежем контексте»; «Review read-only»); `ebb-final-review/SKILL.md:11,13` («В свежем контексте попытайся опровергнуть готовность»; «Не наследуй implementer history»); `ebb-quality-gates/SKILL.md:11,17–21,29` («никакого completion claim без свежего evidence на текущем tree» и последовательность Identify/Run/Read/Verify/Claim). Однако первая сводка B была отклонена validator из-за malformed JSON, а принятая сводка повторно содержит только fixture-level findings и пропускает эти skill-результаты. Контроллер может восстановить содержание из сохранённого ответа, но это не исправляет невалидный/неполный итоговый ответ child.
- Поэтому ожидаемый B result в принятой форме остаётся неполным. Самостоятельная проверка файлов контроллером не превращает невалидную или неполную сводку child в успешный deliverable.
- Повторная сверка не меняет verdict: **FAIL / NOT VERIFIED**. Новая Hermes-сессия не запускалась; credentials, provider settings и ACL не читались и не менялись. Известные 203 test-fixture каталога уже удалены с проверкой повторного inventory; полный inventory иных временных артефактов по-прежнему не заявляется.

## Correction — bounded Task7 cleanup policy B (2026-10-13)

- Пользователь принял вариант B для v1 cleanup acceptance: detached OS descendants остаются `NOT VERIFIED` и сами по себе не блокируют PASS, если выполнены все остальные bounded критерии Task7. Полная очистка OS process tree этим решением не подтверждается и не заявляется.
- Прежний **FAIL / NOT VERIFIED** сохраняется для старого запуска: его принятая сводка child B была неполной, а тот запуск не удовлетворил новому acceptance contract. Plan07 остаётся `NOT VERIFIED` до свежего acceptance по новому контракту и whole-plan review.

## Попытка Task7 с ограниченным executor и обычным Windows Hermes — 2026-10-13

- Снимок: branch `develop`, HEAD `e4ce139`. До и после попытки `git status --short` содержал только посторонний untracked-файл `Сравнение Ebb Orchestrator и OpenAI Symphony.md`; он не менялся. Wrapper timestamps не фиксировал, поэтому указана только дата.
- Restricted executor: точная команда `pnpm hermes:execute -- scripts/fixtures/hermes-development-workflow-parity-plan.md` быстро завершилась `HERMES_EXECUTE marker=FAILED exit_code=1 redacted=true cleanup_verified=true`. В обычном Windows-контексте `hermes --version` завершился с exit 0 и сообщил `v0.21.5+9117.g08165d5`; `hermes chat --help` и `hermes --help` завершились с exit 0 и подтвердили поддержку `--in` и `--query-file`.
- Единственный fresh run в обычном Windows-контексте использовал `$env:HERMES_EXECUTE_TIMEOUT_MS='1800000'` и ту же команду. Результат wrapper: `HERMES_EXECUTE marker=TIMEOUT exit_code=124 redacted=true cleanup_verified=true`; shell exit 1. Согласно текущей реализации `runHermesExecute`/`terminateHermesProcessTree`, на Windows marker `TIMEOUT`/124 выдаётся после успешного `taskkill` и наблюдения `close` дочернего процесса. `cleanup_verified=true` подтверждает удаление точного wrapper prompt-файла; это не подтверждает provider acceptance.
- Точный PID не был выведен; provider/session/child results не surfaced. Поэтому точные PID/session-level evidence, наличие ровно двух schema-valid завершённых child sessions, отсутствие nested/third child и parity result остаются `NOT VERIFIED`. Никакой provider credentials/config/session store/ACL не инспектировались и не изменялись.
- Не выполнялись тесты. Условия Task7 не выполнены; запуск классифицирован **FAIL / NOT VERIFIED**. Он не является PASS и не содержит provider response или child result.

## Прямая диагностическая попытка Hermes query — 2026-10-13

- Выполнена команда `hermes --in <repo> chat --query-file <temp> --oneshot -Q`. Prompt запросил точный случайный nonce `EBB_RESULT_<8-char nonce>`. Через 45,657 ms результат: `stdoutBytes=21`, `stderrBytes=220`, `timedOut=true`; stdout содержал точный запрошенный nonce. Raw output, фактическое значение nonce и session ID не сохранены.
- `taskkill.exe /PID 31680 /T /F` вернул exit 0; дочерний процесс выдал событие `close` с code 1. Временный prompt-файл подтверждённо удалён.
- Наблюдение подтверждает, что короткий query вернул запрошенный ответ, но CLI не завершился за 45 секунд. Оно не подтверждает выполнение Plan19/Plan07 Task7: отсутствуют evidence ровно двух Hermes child sessions, parity report и прохождения gates. Точную причину незавершения CLI не выводим. Credentials, config, session store и ACL не инспектировались. Lifecycle statuses/checklists и source не менялись.

## Проверка scripted one-shot runner и Task7 повтор — 2026-10-13

- Runner переключён на поддерживаемый top-level `hermes --in <repo> -z <prompt>`: короткий Windows probe на обычном пользовательском контексте ранее завершился с ответом nonce и `exit=0`/`close=0`. Изменение `efeb30b` прошло независимые code/security reviews и узкие проверки: `pnpm hermes:test` 39/39, scoped ESLint и `git diff --check` — PASS.
- Первая acceptance-команда из ограниченного executor завершилась за 5 секунд с `HERMES_EXECUTE marker=FAILED exit_code=1 redacted=true cleanup_verified=true`. Отдельный harmless `hermes.cmd --version` в этом executor вывел `Access is denied`; сам `hermes.exe --version` вернул exit 1 без stdout/stderr. Это ограничение конкретного executor, а не вывод о пользовательской конфигурации Hermes.
- После запуска того же acceptance вне sandbox команда `pnpm hermes:execute -- scripts/fixtures/hermes-development-workflow-parity-plan.md` завершилась с `HERMES_EXECUTE marker=TIMEOUT exit_code=124 redacted=true cleanup_verified=true`; явный timeout override не задавался (runner default — 300 секунд). Это подтверждает завершение wrapper по timeout и удаление его prompt-файла; точный PID в output отсутствует.
- Child session results и отдельный parity report не surfaced. Ровно два schema-valid completed children, отсутствие nested/third child, provider-backed acceptance и точный PID/termination evidence поэтому остаются `NOT VERIFIED`. Короткий probe не заменяет этот результат. Точную причину timeout из доступного вывода установить нельзя.
- После запуска рабочая копия имела только user-owned untracked `Сравнение Ebb Orchestrator и OpenAI Symphony.md`; файл не менялся. Credentials, provider configuration, Hermes session store и ACL не читались и не менялись. Плановый статус не менялся; **Task7 остаётся FAIL / NOT VERIFIED**.

## Task7 повтор с увеличенным wrapper timeout — 2026-10-13

- После первого полного запуска установлен факт, что runner default `300_000 ms` меньше ранее измеренных 431 секунд для обязательного root `pnpm test`. Поэтому выполнен один диагностически обоснованный повтор той же команды с `HERMES_EXECUTE_TIMEOUT_MS=900000`; user profile, provider/auth settings, source plan и acceptance criteria не менялись.
- Вызов в пользовательском Windows-контексте завершился `HERMES_EXECUTE marker=TIMEOUT exit_code=124 redacted=true cleanup_verified=true`; `pnpm` завершился exit 124. Это показывает, что одного увеличения лимита до 15 минут недостаточно. Точный этап выполнения, provider output, child session summaries и exact PID в wrapper output не предоставлены; причину timeout дальше не выводим.
- Wrapper подтвердил timeout termination и prompt-file deletion; отдельные обязательные доказательства Task7 (ровно два schema-valid completed child results, отсутствие nested/third child, provider-backed parity report, exact PID evidence) не получены через разрешённый result channel. Поэтому **FAIL / NOT VERIFIED** сохраняется. Повторные provider runs не запускаются без нового root-cause evidence.
- Lifecycle/checklist/roadmap statuses не изменялись. Credentials, provider configuration, Hermes session store и ACL не читались и не менялись; user-owned untracked Symphony-файл не менялся.
