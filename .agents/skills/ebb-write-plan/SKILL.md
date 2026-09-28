---
name: ebb-write-plan
description: Используй, когда утверждённые требования Ebb Orchestrator нужно превратить в implementation plan перед многошаговой, рискованной или cross-component реализацией.
metadata:
  project: "ebb-orchestrator"
  version: "4.0.0"
---

# Ebb Write Plan

**Companion:** используй Superpowers `writing-plans` как основной planning workflow. Если требования ещё требуют проектных решений, сначала используй Superpowers `brainstorming`; plan не должен скрыто заменять design/spec.

Ebb-правила ниже являются project overlay и имеют приоритет над generic defaults Superpowers для путей, naming, worktree, commits и repository governance.

## Workflow

1. Получи `ebb-repository-context` и утверждённые требования/spec. Не начинай implementation.
2. Проверь фактическую plan directory/naming convention в репозитории до создания файла. Не применяй автоматически generic Superpowers plan directory или date-based naming, если проект использует другое правило.
3. Для независимых больших исследований используй ограниченное число scouts с непересекающимися вопросами; результат возвращай кратким summary + artifact path, а не полным логом.
4. Зафиксируй все открытые product/API/security решения. Не угадывай значения, меняющие публичный contract или threat model.
5. Разбей работу на dependency-ordered tasks. Каждая task должна иметь точные `Create`/`Modify` paths, owner, interfaces, dependencies, RED→GREEN evidence, `Run` + конкретный `Expected`, acceptance criteria и `Review Focus`.
6. Для cleanup/move/rename/docs/setup-script scope загрузи `ebb-repository-maintenance` и включи его disposition/command-audit requirements.
7. Выполни self-review из Superpowers `writing-plans`, затем передай полный актуальный plan независимому `ebb-review-plan`. После любых правок нужен свежий verdict.
8. План получает executable status только после `APPROVED`. Commit plan/generated outputs выполняй только по актуальной repository governance; никогда не включай unrelated changes и не push/merge.

Используй [references/plan-format.md](references/plan-format.md) как Ebb-specific overlay к Superpowers plan format, а не как второй конкурирующий формат.
