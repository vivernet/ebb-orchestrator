# Ebb implementation-plan overlay

Superpowers `writing-plans` задаёт базовую структуру и гранулярность. Этот файл добавляет только Ebb-specific требования.

## Header / authority

- Укажи Goal, Architecture, Tech Stack и путь к approved spec/design, если он существует.
- Перечисли authority sources и project-wide constraints; не копируй большие руководства.
- Используй фактическую repository naming/lifecycle policy. Project convention имеет приоритет над generic именем/директорией Superpowers.

## Task contract

Каждая task обязана содержать:

- `Task ID`, проверяемый результат и `Depends on`;
- точные `Create`/`Modify` paths и owner; новые файлы имеют одного owner;
- `Interfaces`: producer/consumer contracts, DTO/error semantics, transaction/lifecycle boundary на затронутых seams;
- RED: тест/сценарий, точная команда и ожидаемая assertion/failure reason;
- GREEN: минимальное изменение, exact command и ожидаемый результат;
- neighboring/applicable gates и `Review Focus`;
- completion evidence и условия, при которых task остаётся `BLOCKED`.

Не оставляй `TBD`, `or equivalent`, «исправить при необходимости» или будущий artifact в качестве существующего evidence.

## Repository-maintenance tasks

Для move/delete/cleanup/rename добавь атомарный disposition (`path`, current state, action, destination, reason, verification) и отдельный destructive approval gate, если меняются/удаляются пользовательские или runtime данные.

Для setup/dev scripts укажи реальную script owner path, cwd, prerequisites, side effects, cross-platform expectations и команду проверки.
