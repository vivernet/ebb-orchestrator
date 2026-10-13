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

Перед началом работы создать `todo_list` с обязательным непустым полем
`content`, содержащим последовательность этих задач и их текущие состояния.
Использовать точную схему инструмента; не отправлять вызов без `content` и не
считать ошибочный вызов выполненным.

Если проверка ведётся по plan-owned execution ledger, соблюдать правило
append-only ledger:
сначала прочитать существующее содержимое, но в этой задаче не изменять его:
не перезаписывать, не обнулять, не пересоздавать и не дописывать ledger даже при
наличии другого разрешения на его обновление. Все новые сведения сохранять
только в разрешённом итоговом отчёте.

Разрешено создать или обновить только итоговый отчёт
`docs/audit/hermes-development-workflow-parity.md`. Не менять product code,
tests, scripts, конфигурацию, skills и другие файлы. Не создавать worktree и
ветку. Не выполнять commit автоматически, merge, push, tag или release.
Не запускать команды, которые исправляют или удаляют файлы рабочего дерева.

## Задача 1. Два независимых context checks

Запустить **ровно двух** субагентов одновременно и дождаться обоих результатов
перед переходом к следующей задаче. Поручения ниже только для чтения: обоим
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

Перед запуском долгого `pnpm test` использовать поддерживаемый process/session
инструмент в background-режиме (background process/session). Сохранить точный
handle именно этого запуска (exact current-run handle) и
дождаться его терминального состояния через этот handle; не запускать suite в
foreground terminal с коротким фиксированным лимитом ожидания и не угадывать
состояние по отсутствию вывода. Выполнять команды по одной в поддерживаемом
режиме оболочки: не использовать `bash -e/-c`, `sh -e/-c` и POSIX-специфичную
форму `ps -o` на Windows. Для Windows использовать доступный на этой платформе
способ проверки процесса. Если инструмент не позволяет получить нужное
свидетельство, указать `NOT VERIFIED`, не подменяя проверку предположением.

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
