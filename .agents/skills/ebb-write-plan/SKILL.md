---
name: ebb-write-plan
description: Используй, когда утверждённые требования или design Ebb Orchestrator нужно превратить в исполнимый dependency-ordered implementation plan перед многошаговой или рискованной реализацией.
metadata:
  project: "ebb-orchestrator"
  version: "5.2.0"
---

# Ebb Write Plan

План — набор решений, которые implementer не должен угадывать. Не начинай implementation во время authoring plan.

1. Получи `ebb-repository-context` и authoritative requirements/design. Если load-bearing design ещё не утверждён, вернись в `ebb-design-change`.
2. Проверь существующую plan directory/naming/lifecycle convention в репозитории; project convention имеет приоритет над шаблоном.
3. Для независимых исследований используй `ebb-dispatch-agents` с узкими read-only scopes; synthesis делает plan author.
4. Составь file/interface map до задач: создаваемые/изменяемые файлы, owner каждого нового файла, producer/consumer seams.
5. Разбей работу на dependency DAG. Task — минимальная единица, имеющая собственный RED→GREEN цикл, acceptance и осмысленный review boundary.
6. Каждая task содержит exact paths, interfaces, dependencies, test/reproduction first, конкретные `Run`/`Expected`, neighboring gates, completion evidence и Review Focus.
7. Подключай specialist constraints только по trigger: database-contract scope → `ebb-database-engineering`; cleanup/move/tooling/structure → `ebb-repository-maintenance`; README/.env.example content и affected setup/config/API/commands → changed-scope `ebb-maintain-project-docs`; security/Web → соответствующие specialist evidence. Не копируй их полный workflow в plan skill.
8. Выполни self-review: requirement coverage, task granularity, interface consistency, commands, Review Focus, proportion. Исправь gaps до передачи reviewer.
9. Передай актуальный plan в свежий `ebb-review-plan`; после правок нужен новый verdict. Исполняемый status появляется только после `APPROVED`.
10. Commit plan/generated outputs выполняй только по repository governance; unrelated changes, push и merge не допускаются по умолчанию.

План фиксирует ordinary task source pinned `develop`, PR squash target `develop`, reviewed task SHA и отдельный integrated-source SHA с post-integration gates. `master` имеет только release commits и отсутствует при zero releases; legacy transition — отдельный reviewed Plan26. Completion не вызывает release: `ebb-release` только explicit user invocation. Default max 2 active subagents — общий лимит implementer/fix/reviewer/scout; более узкий plan/runtime limit применяется, превышение двух требует explicit user policy amendment. Controller только координирует. Docs sync входит в affected task/gate/finish prerequisites; full audit — только explicit scope.

Полный формат: [references/plan-format.md](references/plan-format.md).
