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

## Повторная попытка после lifecycle fix `cd7d525` — 2026-10-13

- Перед запуском checkpoint `cd7d525` содержал lifecycle fix Hermes runner; полный `pnpm test` завершился успешно (server 1842 passed / 29 skipped, web 219/219, contracts 7/7, root Node 64/64), а независимый review последней правки завершился `APPROVED`.
- Запуск: `$env:HERMES_EXECUTE_TIMEOUT_MS='2700000'; pnpm hermes:execute -- scripts/fixtures/hermes-development-workflow-parity-plan.md`. Он был вручную остановлен через Ctrl+C примерно через 20 минут, до внутреннего 45-минутного timeout. Shell завершился с exit 1 без `HERMES_EXECUTE` marker и без диагностического вывода. Это не внутренний timeout и не acceptance result.
- Перед остановкой наблюдались Hermes PID 25392, Node runner PID 30244 и Python PID 30516. После остановки все три проверенных PID отсутствовали. Это подтверждает остановку этих процессов, но не доказывает отсутствие незамеченных/detached Hermes descendants или структуру делегирования.
- После прерывания wrapper prompt `hermes-prompt-1791845875037.txt` оставался в `%TEMP%`. Его содержимое проверено: оно включало только общую инструкцию и путь fixture, без credentials или provider output. После проверки, что указанные процессы остановлены, удалён только этот точный prompt-файл; последующий inventory этого имени его не находит. Широкую уборку `%TEMP%` и удаление иных fixture-каталогов не выполняли.
- В durable execution ledger обнаружен результат Task 1: один parallel dispatch `deleg_19742488`, ровно два завершённых provider-backed read-only child task (`task-0`, `task-1`, оба `gpt-6-luna`); длительности 39.72 s и 27.44 s внутри 39.97 s aggregate подтверждают перекрытие. Traces показывают только read/search для A, read-only для B и отсутствие nested delegation calls. B summary не перечислил требуемые skill evidence, хотя trace подтверждает чтение всех четырёх skills. Доступ к OS-level child process tree отсутствовал. Эти данные подтверждают delegation slice, но не общий PASS.
- Hermes error log для session `20261013_015806_862947` дал причину части задержки и неполного завершения: `terminal` timed out after 420.0 s; отдельные tool failures включают отказ перезаписать уже существующий plan-owned ledger, `process_manage` `not_found`, schema error `todo_list` (нет обязательного `content`), блокировку shell-команды с `-e/-c` в single-query режиме и несовместимую на Windows команду `ps -o`. Свежий локальный root `pnpm test` длился 431.12 s, что согласуется с terminal limit, но не доказывает, что именно эта команда была тем timed-out вызовом. Existing ledger прочитан, сохранён без перезаписи.
- Task 2 не завершён, Task 3 отчёта и финальной сверки не достигнуты; поэтому Task7 остаётся **FAIL / NOT VERIFIED**. Итак, это не проблема Hermes provider/auth и не отсутствие запуска Hermes: доказаны Hermes session и две parallel read-only subagents. Главный установленный execution blocker — несовместимость workflow/tool calls с Windows и 420-секундным terminal limit; полного Task7 report и завершённых gate evidence всё ещё нет.
