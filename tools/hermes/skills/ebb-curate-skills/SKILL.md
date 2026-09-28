---
name: ebb-curate-skills
description: Используй, когда нужно оценить новые, автоматически созданные или часто использованные skills вокруг Ebb Orchestrator и решить merge/create/remove для канонического ebb-* набора.
metadata:
  project: "ebb-orchestrator"
  version: "1.0.0"
---

# Ebb Curate Skills

Цель — поддерживать один канонический набор Ebb skills без накопления дубликатов и случайных self-improvement patches.

**Required authoring companion:** Superpowers `writing-skills`. Используй его TDD/trigger-testing подход для фактического создания или переписывания skill, когда runtime позволяет pressure tests.

## Workflow

1. Source of truth — repository `.agents/skills/`. Runtime-installed/copied skills и автоматически созданные skills являются evidence/candidates, но не каноническим источником.
2. Инвентаризируй canonical `ebb-*`, candidate skills, references и реальное usage evidence. Сравни name/description/ownership, а не только похожие слова.
3. Для каждого candidate/pattern вынеси verdict: `KEEP_EXTERNAL`, `MERGE`, `NEW_EBB`, `REPLACE`, `REJECT` или `NEEDS_EVIDENCE`; обоснуй устойчивой project-specific ценностью.
4. Общие техники (TDD, debugging, planning, generic code review/verification) предпочитай переиспользовать из Superpowers вместо копирования в Ebb. В Ebb хранится project overlay: contracts, governance, orchestration и specialist policy.
5. Перед `NEW_EBB` докажи отдельный trigger/zone of responsibility и отсутствие опасного overlap. Перед `MERGE` укажи target skill и конкретный reusable pattern.
6. Изменения authoring выполняй через Superpowers `writing-skills`; descriptions тестируй на implicit routing и держи concise. Large/rare detail выноси в `references/`.
7. Валидируй Agent Skills standard, relative references, cross-runtime compatibility (Codex + Hermes), forbidden stale paths и token footprint.
8. Выпусти review/migration map: added/changed/removed skills, imported patterns, deliberately external patterns, trigger tests и limitations.

Никогда не продвигай self-improvement skill в canonical set только потому, что он часто загружался или был автоматически patched.

См. [references/decision-matrix.md](references/decision-matrix.md).
