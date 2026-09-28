---
name: ebb-curate-skills
description: Используй, когда нужно создать, изменить или оценить новые/автоматически созданные/часто использованные skills вокруг Ebb Orchestrator и сохранить один автономный канонический ebb-* набор.
metadata:
  project: "ebb-orchestrator"
  version: "5.0.0"
---

# Ebb Curate Skills

Source of truth — repository `.agents/skills/`. Полезная обязательная методология должна быть **встроена в `ebb-*`**, а не оставлена runtime dependency другого skill set.

## RED → GREEN → REFACTOR для skills

1. Инвентаризируй canonical `ebb-*`, candidate skills/references и usage evidence. Сначала опиши baseline failure/pressure scenario **без предлагаемого изменения**.
2. **RED:** докажи, что текущий набор пропускает нужный trigger, допускает ошибочный workflow или не содержит capability. Для discipline rules используй pressure scenarios; для references — retrieval/application tests.
3. Выбери verdict: `MERGE_PATTERN`, `NEW_EBB`, `REPLACE_EBB`, `REJECT`, `NEEDS_EVIDENCE`. Если reusable pattern полезен для обязательного Ebb workflow, он должен быть MERGE/NEW, а не runtime dependency.
4. **GREEN:** внеси минимальный skill/reference change, закрывающий доказанный failure. Description описывает только trigger, а не сокращённую версию workflow.
5. **REFACTOR:** тестируй overlap, rationalizations, wrong routing, token footprint; heavy/rare detail выноси в `references/`.
6. Каждый новый skill имеет уникальную responsibility/trigger. Один и тот же workflow не дублируется под разными именами.
7. Валидируй frontmatter, relative links, cross-skill references, отсутствие host-specific runtime dependencies, Codex/Hermes discovery layout и stale paths.
8. Выпусти review + migration map + trigger/pressure matrix + limitations. Candidate, созданный self-improvement механизмом, не становится canonical без этого процесса.

См. [decision matrix](references/decision-matrix.md) и [authoring protocol](references/skill-authoring-protocol.md).
