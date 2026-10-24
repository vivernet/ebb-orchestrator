# Ebb skill authoring protocol

## Discovery

- `name`: lowercase letters/numbers/hyphens, один semantic action/domain.
- `description`: только observable trigger (`Используй, когда...`), без краткого пересказа workflow; иначе агент может не открыть body.
- Добавляй searchable symptoms/commands/domain terms в body, а не перегружай description.

## Skill TDD

### Discipline skill
1. 3+ pressure scenarios: time pressure, sunk cost, authority, context loss.
2. Baseline без изменения: запиши, где агент нарушает rule/rationalizes.
3. Минимальная guidance, закрывающая конкретный failure.
4. Повтори те же scenarios; добавляй explicit counters только для реально наблюдавшихся loopholes.

### Technique/pattern skill
- recognition scenario;
- application scenario;
- counter-example / when-not-to-use;
- missing-information scenario.

### Reference skill
- retrieval question;
- application task;
- gap test на common case.

## Token discipline

- Frequently routed `SKILL.md` держи коротким; rare detail → `references/`.
- Не повторяй целые workflows между skills: owner skill хранит rule, callers называют его по `ebb-*` имени.
- Один хороший example лучше нескольких длинных variants.

## Deployment gate

Для каждого changed/new skill: frontmatter → links → cross-skill refs → autonomy scan → trigger matrix → relevant pressure/application scenarios → package manifest. Не называй skill ready только потому, что markdown выглядит убедительно.

## Branch / release / docs trigger controls

Record trigger positive, negative and authority cases: ordinary task completion → finish/PR squash develop, never release; explicit user ebb-release → operation owner; affected setup/config/API → changed-scope docs sync even without a separate docs request; unrelated task → no full docs audit. Root/nested README/.env.example content and file operations must have different named owners. Verify task approved SHA, integrated source and release candidate are not conflated. Scan for local task merge, master target, force/permission bypass and implicit publication/rollback/tag. Legacy master transition is separate Plan26, no dummy/baseline/restore/archive commit retained.

Autonomy test: proceed inside already approved scope; stop only for actual named unresolved authority/destructive/external side effect. Record static checks as static, dynamic scenarios as executed only with actual observations. Preserve technical retry/fix rules and approved shared implementer/reviewer concurrency policy; controller coordination does not authorize implementation.
