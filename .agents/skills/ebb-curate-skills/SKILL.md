---
name: ebb-curate-skills
description: Используй, когда нужно создать, изменить, объединить, удалить или оценить skill в каноническом ebb-* наборе Ebb Orchestrator.
metadata:
  project: "ebb-orchestrator"
  version: "5.2.0"
---

# Ebb Curate Skills

Source of truth — repository `.agents/skills/`. Полезная обязательная методология должна быть **встроена в `ebb-*`**, а не оставлена runtime dependency другого skill set.

## RED → GREEN → REFACTOR для skills

1. Инвентаризируй canonical `ebb-*`, candidate skills/references и usage evidence. Сначала опиши baseline failure/pressure scenario **без предлагаемого изменения**.
2. **RED:** докажи, что текущий набор пропускает нужный trigger, допускает ошибочный workflow или не содержит capability. Для discipline rules используй pressure scenarios; для references — retrieval/application tests.
3. Выбери verdict: `MERGE_PATTERN`, `NEW_EBB`, `REPLACE_EBB`, `REJECT`, `NEEDS_EVIDENCE`. Если reusable pattern полезен для обязательного Ebb workflow, он должен быть MERGE/NEW, а не runtime dependency.
4. **GREEN:** внеси минимальный skill/reference change, закрывающий доказанный failure. Description описывает только trigger, а не сокращённую версию workflow.
5. **REFACTOR:** тестируй overlap, rationalizations, wrong routing, token footprint; heavy/rare detail выноси в `references/`.
6. Каждый top-level skill имеет уникальную responsibility/trigger. Domain-specific skill владеет domain policy; generic callers **маршрутизируют к owner по имени**, а не копируют его checklist/workflow.
7. Валидируй frontmatter, relative links, cross-skill references, отсутствие host-specific runtime dependencies, Codex/Hermes discovery layout и stale paths.
8. Выпусти review + migration map + trigger/pressure matrix + limitations. Candidate, созданный self-improvement механизмом, не становится canonical без этого процесса.

## Trigger / autonomy validation

- Ordinary task branch/integration → `ebb-finish-branch` (pinned develop, PR squash develop, distinct task/integrated evidence); completion не запускает release/tag/rollback.
- `ebb-release` имеет только explicit-user trigger; docs owner `ebb-maintain-project-docs` имеет automatic affected setup/config/API/README/example trigger. Full docs audit требует explicit scope; file operations маршрутизируются в maintenance.
- Проверяй autonomy в обоих направлениях: не требуй повторного разрешения уже approved reversible scope и не превращай routing/gate PASS в разрешение внешних публикаций/destructive actions. Concrete final release/withdrawal confirmation определяется owner policy, не generic completion.
- Статическая gap/retrieval проверка и dynamic pressure run — разные evidence. Если dynamic test недоступен, отмечай `NOT_RUN` и ограничения, не выдумывай RED/GREEN наблюдения. Archive-only request не означает personal installation и не разрешает изменение исходного проекта.

См. [decision matrix](references/decision-matrix.md) и [authoring protocol](references/skill-authoring-protocol.md).
