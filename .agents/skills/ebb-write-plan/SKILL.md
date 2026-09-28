---
name: ebb-write-plan
description: Используй, когда утверждённые требования или design Ebb Orchestrator нужно превратить в исполнимый dependency-ordered implementation plan перед многошаговой или рискованной реализацией.
metadata:
  project: "ebb-orchestrator"
  version: "5.0.0"
---

# Ebb Write Plan

План — набор решений, которые implementer не должен угадывать. Не начинай implementation во время authoring plan.

1. Получи `ebb-repository-context` и authoritative requirements/design. Если load-bearing design ещё не утверждён, вернись в `ebb-design-change`.
2. Проверь существующую plan directory/naming/lifecycle convention в репозитории; project convention имеет приоритет над шаблоном.
3. Для независимых исследований используй `ebb-dispatch-agents` с узкими read-only scopes; synthesis делает plan author.
4. Составь file/interface map до задач: создаваемые/изменяемые файлы, owner каждого нового файла, producer/consumer seams.
5. Разбей работу на dependency DAG. Task — минимальная единица, имеющая собственный RED→GREEN цикл, acceptance и осмысленный review boundary.
6. Каждая task содержит exact paths, interfaces, dependencies, test/reproduction first, конкретные `Run`/`Expected`, neighboring gates, completion evidence и Review Focus.
7. Для cleanup/move/setup/docs применяй требования `ebb-repository-maintenance`; для security/Web scope включи specialist evidence.
8. Выполни self-review: requirement coverage, task granularity, interface consistency, commands, Review Focus, proportion. Исправь gaps до передачи reviewer.
9. Передай актуальный plan в свежий `ebb-review-plan`; после правок нужен новый verdict. Исполняемый status появляется только после `APPROVED`.
10. Commit plan/generated outputs выполняй только по repository governance; unrelated changes, push и merge не допускаются по умолчанию.

Полный формат: [references/plan-format.md](references/plan-format.md).
