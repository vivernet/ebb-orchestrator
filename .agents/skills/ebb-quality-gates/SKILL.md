---
name: ebb-quality-gates
description: Используй перед любым утверждением PASS/DONE/fixed/ready по Ebb Orchestrator и для выполнения свежих verification gates текущего HEAD.
metadata:
  project: "ebb-orchestrator"
  version: "5.2.0"
---

# Ebb Quality Gates

Core law: **никакого completion claim без свежего evidence на текущем tree.**

## Gate function

Перед каждым статусным утверждением:

1. **Identify:** какая exact command/inspection доказывает claim?
2. **Run:** выполни её полностью и свежо.
3. **Read:** прочитай output, exit code, failure counts/warnings.
4. **Verify:** output действительно подтверждает claim? Если нет — сообщи фактический статус и blocker.
5. **Claim:** только теперь сформулируй PASS/DONE/fixed и приложи evidence.

## Scope ladder

Сначала focused test/reproduction, затем neighboring suite, затем mandatory repository gates по изменённому scope/plan: lint, typecheck, tests, build, docs и applicable specialist gates. Для database-contract changes используй required fresh/upgrade/schema/data evidence из `ebb-database-engineering`; для Web/security — соответствующие E2E/review evidence. `git diff --check` применим всегда. Full suite обязателен перед branch integration, если repository policy не определяет эквивалентный полный gate.

Agent report, старый CI run, «должно работать», зелёный lint вместо build или partial suite не заменяют нужную проверку. Broader failure классифицируй по ownership; подтверждённый pre-existing/dependency blocker сохраняется как blocker и не превращается в общий PASS.

Перед завершением также проверь requirements checklist, diff на unrelated/generated files/secrets и worktree status. Формат evidence: [references/completion-evidence.md](references/completion-evidence.md).

## Identity / operation scope

- **Task:** pinned `develop_base_sha` + exact reviewed task SHA/tree. Для docs-worthy changes required prerequisite — changed-scope sync `ebb-maintain-project-docs` по affected owners/consumers, включая root/nested README и `.env.example`; full audit только explicit. Task PASS разрешает finish handoff, не release.
- **Integrated source:** authorized PR squash в `develop`; зафиксируй actual integrated SHA/tree и выполни полный mandatory post-integration local/CI gate set. Evidence task SHA не переносится на squash source автоматически; missing/failed/skipped required gate блокирует verified integration.
- **Release publication:** только explicit `ebb-release`; release owner задаёт source/candidate/old-master/version/inventory identities и полный publication gate set. Source tree должен совпадать с candidate tree; metadata вне source tree. Completion не запускает publication/tag/rollback.
- **Release withdrawal / resume:** `ebb-release` задаёт полный applicable safety gate set для exact withdrawn identities: parent/source provenance, permissions/deletability, supported tools, regression/local/CI safety checks и удаление exact remote objects. Не требуй, чтобы failing application suite отзываемого defective release стала зелёной; failed/missing withdrawal safety check блокирует операцию. Publication withdrawal не означает deployment/data/migration rollback.

Drift source/task/candidate/old-master/inventory инвалидирует привязанное evidence и applicable approval. Не обходи branch protections, не force-push и не меняй permissions для получения PASS. Нет реализованных verified release tools — BLOCKED, не ad-hoc обход.
