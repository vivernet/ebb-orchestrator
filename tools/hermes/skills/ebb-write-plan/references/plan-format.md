# Implementation plan format

## Header

Название и цель. Frontmatter соответствует `governance/plan-naming-and-lifecycle-policy.md`. `evidence` содержит только существующие файлы. Будущие файлы объявляются в task scope.

## Global Constraints

Укажи утверждённые источники, invariants, границы scope, запрещённые изменения и общие gates. Не копируй целые руководства.

## Review Focus

Перечисли конкретные риски и места, которые должен опровергнуть reviewer: ownership, compatibility, failure paths, persistence/concurrency, permissions, lifecycle, migrations и т. п. Только применимое.

## Tasks

Каждая task включает:

- `Task ID`, короткую цель и проверяемый результат;
- `Depends on` с существующими task IDs;
- `Create` и `Modify` точных путей, owner и важные symbols;
- `Interfaces`/DTO/error semantics/transaction boundary на каждом затронутом seam;
- RED: тест/сценарий, точная команда и ожидаемый провал;
- GREEN: минимальное изменение, команда и ожидаемый результат;
- соседние проверки и `Review Focus`;
- критерии завершения и evidence.

Задача должна иметь один логический owner и быть достаточно узкой для одного свежего implementer. Разделяй tasks по зависимостям и ownership, а не по произвольному количеству файлов. Не оставляй placeholders, альтернативы без решения (`or equivalent`, `fix later`) или неуказанных владельцев.

