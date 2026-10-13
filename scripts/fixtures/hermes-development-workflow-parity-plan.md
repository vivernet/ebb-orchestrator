---
id: fixture-hermes-development-workflow-parity
kind: plan
status: proposed
title: Fixture плана для проверки Hermes development workflow parity
created: 2026-10-08
updated: 2026-10-08
---

# План проверки Hermes development workflow

## Цель и границы

Проверить на текущем worktree, что Hermes исполняет план с каноническими
проектными навыками `.agents/skills/`, запускает ровно двух параллельных
read-only субагентов и возвращает проверяемые результаты. Это проверка процесса
разработки, а не задача по изменению продукта.

До начала зафиксировать дату, branch, HEAD и `git status --short`. Сохранить
все существующие изменения. Следовать применимому `AGENTS.md` и текущим
`.agents/skills/ebb-orchestrate-work/SKILL.md`,
`.agents/skills/ebb-repository-context/SKILL.md` и
`.agents/skills/ebb-quality-gates/SKILL.md`. Не использовать исторические
предположения о других источниках навыков.

Не предполагать наличие необязательного инструмента списка задач. Для
plan-owned execution ledger следовать Markdown-формату из
`.agents/skills/ebb-execute-plan/references/ledger-format.md` и состояниям из
`.agents/skills/ebb-execute-plan/references/execution-state-machine.md`. Найти
существующий ledger по plan-owned Git metadata scratch path; для этой проверки
это путь, возвращённый `git rev-parse --git-path ebb-execution/hermes-development-workflow-parity`.
Перед продолжением прочитать весь ledger и сохранить его прежние записи.

Обновлять ledger только append-only Markdown: в `## Tasks` добавлять новую
строку состояния для возобновлённой задачи с `Task`, текущим состоянием из
execution-state machine, `BASE`, краткой ссылкой на evidence и номером `attempt`.
При новых переходах добавлять новую строку, не редактируя прежние состояния и
evidence. Никогда не обнулять, не заменять, не усекать и не пересоздавать ledger.
Ledger хранится вне отслеживаемых файлов репозитория; среди tracked repository
files разрешено менять только итоговый отчёт
`docs/audit/hermes-development-workflow-parity.md`.

Разрешено создать или обновить только итоговый отчёт
`docs/audit/hermes-development-workflow-parity.md`. Не менять product code,
tests, scripts, конфигурацию, skills и другие файлы. Не создавать worktree и
ветку. Не выполнять commit автоматически, merge, push, tag или release.
Не запускать команды, которые исправляют или удаляют файлы рабочего дерева.

## Задача 1. Два независимых context checks

Передать поручения A и B одним-единственным параллельным batch-вызовом
delegation tool, чтобы оба child были созданы и запущены в рамках одного
вызова. Не отправлять A и B двумя отдельными вызовами — ни последовательно, ни
как повторный вызов после частичного отказа. Если единый вызов не создаёт обоих
child или отклоняет хотя бы одного, зафиксировать `FAIL` и остановиться; второй
вызов для создания недостающего child запрещён.

Дождаться результатов ровно двух одновременно запущенных субагентов перед
переходом к следующей задаче. Поручения ниже только для чтения: обоим
запрещены правки, Git mutation, запуск собственных субагентов и nested
delegation. Третий дочерний агент не допускается. Если параллельный запуск
невозможен, остановиться и указать `FAIL` с причиной; последовательный запуск
не подтверждает этот contract.

- **Субагент A — правила репозитория.** Прочитать применимый `AGENTS.md`,
  `docs/architecture/plans/19-unfinished-plan-closure.md` (Task 7) и
  `.agents/skills/ebb-orchestrate-work/SKILL.md`. Вернуть пути и точные
  выдержки/номера строк, подтверждающие основную ветку, ограничения на
  субагентов, запрет nested delegation, требуемые gates и границы изменений.
- **Субагент B — актуальные skills.** Проверить наличие и содержание
  `.agents/skills/ebb-dispatch-agents/SKILL.md`,
  `.agents/skills/ebb-review-task/SKILL.md`,
  `.agents/skills/ebb-final-review/SKILL.md` и
  `.agents/skills/ebb-quality-gates/SKILL.md`. Вернуть пути и точные
  выдержки/номера строк о read-only review, независимой проверке,
  ограничениях leaf-agent и доказательствах completion.

Принимать результат B только после того, как delegation tool вернул успешный,
schema-valid завершённый ответ child B. Ответ должен отдельно содержать все
четыре пути, skill excerpts и citations с номерами строк, а также пояснение,
какое требование каждая выдержка подтверждает. Если поле отсутствует, формат
невалиден, ответ обрезан или нет выдержек/цитат хотя бы для одного навыка,
результат B неполон: не реконструировать его самостоятельно и не считать
задание принятым.

В отчёте указать идентификаторы обоих запусков, время старта и завершения,
наблюдаемое перекрытие их работы, результаты каждого и подтверждение, что
каждый остался read-only и не породил children. Если доступные инструменты не
дают подтвердить число и дерево дочерних процессов, не объявлять этот пункт
пройденным.

## Задача 2. Repository gates

После завершения обоих субагентов выполнить в корне репозитория:

```text
pnpm lint
pnpm typecheck
pnpm test
git diff --check
git status --short
```

Для каждой команды записать exit code и краткое проверяемое свидетельство из
вывода. При ошибке сохранить исходный вывод или его безопасную выдержку в
отчёте, установить, относится ли она к текущей проверке либо существовала в
baseline, и не менять файлы ради зелёного результата. Любой обязательный gate
с ненулевым exit code означает `FAIL`.

Перед запуском долгого `pnpm test` использовать поддерживаемый в текущем
исполнительном окружении механизм process/session и сохранить точный handle
этого запуска. Дождаться терминального состояния через этот handle и записать
фактический exit code; не угадывать состояние по отсутствию вывода. Если
доступный механизм не позволяет получить handle, терминальное состояние или
exit code, указать соответствующее свидетельство как `NOT VERIFIED`, не
подменяя проверку предположением. Использовать команды и средства наблюдения,
поддерживаемые текущей платформой и оболочкой.

## Задача 3. Отчёт и verdict

Создать `docs/audit/hermes-development-workflow-parity.md` с полями:

- дата и часовой пояс, branch, HEAD, baseline `git status --short`;
- использованные команды, exit codes и ссылки на конкретные evidence;
- идентификаторы и раздельные результаты двух субагентов, доказательство их
  параллельной работы, отсутствия третьего child и nested delegation;
- фактическое обнаружение канонических `.agents/skills/` и применённых skills;
- безопасное свидетельство provider-backed выполнения Hermes, если оно
  доступно, без значений credentials; один лишь успешный exit code обёртки
  не является таким свидетельством;
- реальные результаты two schema-valid, completed Hermes child sessions,
  условие no nested/third child и точные source excerpts/citations из обоих
  ответов;
- bounded cleanup evidence: exact wrapper child process closed, prompt file
  deletion verified after close; если использовалось timeout termination — успешный вызов
  `taskkill.exe /PID <exact pid> /T /F` и последующий root child close;
- detached OS descendants вне этой проверки пометить `NOT VERIFIED`. В рамках
  принятой v1-политики это ограничение само по себе не мешает PASS Task7, если
  все перечисленные bounded criteria выполнены. Не заявлять full OS
  process-tree cleanup;
- финальный `git status --short`, список изменённых файлов и verdict `PASS`
  или `FAIL` с конкретными причинами.

`PASS` допустим только при наличии двух schema-valid, completed Hermes child
sessions без nested/third child, успешных обязательных gates, provider-backed
evidence, закрытия точного wrapper child process, подтверждённого удаления
prompt file после close и, если применялось timeout termination, успешного
`taskkill.exe /PID <exact pid> /T /F` с последующим root child close. Любой
недостающий критерий из этого списка даёт `FAIL`. Detached OS descendants
вне bounded проверки помечаются `NOT VERIFIED`, но по принятой v1-политике не
блокируют Task7 PASS; не заявлять full OS process-tree cleanup. Не выдавать
`COMPLETED exit_code=0` за parity PASS.
Отчёт оставить для отдельной проверки и отдельного решения о commit.
