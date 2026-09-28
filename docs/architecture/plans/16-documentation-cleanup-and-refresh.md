---
id: plan-16
kind: plan
status: completed
created: 2026-09-25
updated: 2026-09-28
title: Очистка и актуализация документации Ebb Orchestrator
depends_on:
  - plan-15-07
  - plan-15-08
specs:
  - ../specs/01-system-design.md
  - ../../development/02-documentation-governance.md
evidence:
  - README.md
  - docs/README.md
  - tools/hermes/README.md
  - package.json
  - apps/server/package.json
  - apps/web/package.json
  - packages/contracts/package.json
  - packages/testing/package.json
  - apps/server/test/e2e/fixtures/health-service/package.json
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - scripts/docs-governance.mjs
  - scripts/roadmap-generator-cli.mjs
  - .gitignore
  - AGENTS.md
  - .hermes.md
  - apps/server/AGENTS.md
  - apps/web/AGENTS.md
  - packages/contracts/AGENTS.md
  - .cuperpowers/sdd/12-401-web-completion/task-5-report.json
  - .superpowers/sdd/2026-09-16-orchestrator-final-v1-audit-hardening/mcp-validation-report.md
  - .superpowers/sdd/2026-09-16-orchestrator-final-v1-audit-hardening/security-remediation-report.md
  - .superpowers/sdd/2026-09-16-orchestrator-final-v1-audit-hardening/ui-api-remediation-report.md
---

# 16. Очистка и актуализация документации Ebb Orchestrator

## Context Brief

На ветке `develop` зафиксирован `HEAD 332668c341337684ba8dfbffe7002cdc941d9e01`. В repository baseline находятся десять активных tracked-планов `15-*`: `15-01`–`15-09` и `15-auth-onboarding-ui-hardening`. Эти файлы являются unrelated active work и не должны изменяться, удаляться, перемещаться или включаться в очистку.

Цель следующей implementation-фазы — привести documentation surface и временные артефакты репозитория к фактическому состоянию проекта, не меняя runtime-код и не удаляя данные до доказуемой проверки их ценности. Проектные README должны быть на русском языке и не содержать YAML/frontmatter-подобных метатегов. Это правило относится к README; настоящий plan обязан сохранить YAML frontmatter, потому что он является частью канонической схемы планов.

Корень содержит исторические материалы в `.cuperpowers/` и `.superpowers/`, generated reports/JSON, `workspace/`, root-level task reports и дублирующиеся security artifacts. `.cuperpowers/` содержит один tracked JSON; `.superpowers/` содержит три tracked audit reports и ignored local state. `scan-manifest.json` сохраняется, потому что используется README и security-audit тестом. `node_modules/`, `dist/`, `build/` и иные regenerable outputs находятся вне Git cleanup scope.

**Deferred evidence inconsistency:** the previously expected `docs/development/jsdoc-style-guide.md` is absent from the repository; the existing `docs/development/07-jsdoc-style-guide.md` is not substituted as an authoritative spec in this plan. Restoring or renaming a JSDoc guide is out of scope and deferred pending a separate repository-backed requirement; no task may depend on that missing path.

## Scope

1. Провести read-only inventory всех кандидатов и расслоить их на tracked/untracked/ignored, active/unrelated, reproducible/non-reproducible и содержащие/не содержащие секреты.
2. Проверить целостность кандидатов: SHA-256 manifest, валидность JSON/UTF-8, diff/path checks, ссылки, tracked-vs-untracked comparison и secret/path scan.
3. Подготовить внешний archive вне repository с повторной проверкой hash; только после этого разрешить удаление/перемещение согласованных кандидатов.
4. Проверить каждую реально существующую `pnpm`-команду по manifests/workspace/lockfile и обновить `README.md` с фактическими командами, ограничениями и expected outputs.
5. Обновить все три project README: `README.md`, `docs/README.md`, `tools/hermes/README.md`; убрать из них frontmatter-подобные блоки, исправить stale paths, язык и ссылки.
6. Оценить и при необходимости добавить в `.gitignore` правила для `temp/` и `test/` только с явным объяснением scope; не игнорировать source/test directories целиком.
7. Оценить добавление в `AGENTS.md` правила для временных файлов и зафиксировать его только если оно однозначно предотвращает повторное загрязнение репозитория.
8. Получить явное подтверждение пользователя после показа полного disposition list и до любой реализации удаления/перемещения/изменения документации.

## Non-scope

- Не изменять production code, package manifests, `pnpm-lock.yaml` или behavior CLI.
- Не изменять и не удалять existing tracked active plans `15-*`.
- Не удалять/перемещать `.cuperpowers` или `.superpowers` без approval gate и внешнего archive.
- Не считать `node_modules/`, `dist/`, `build/`, `coverage/`, `.vite/`, Playwright output и другие regenerable outputs частью Git cleanup.
- Не запускать `git clean`, `reset --hard`, force operations, push или merge.
- Не принимать README, historical audit или report как authority над текущим кодом без проверки evidence.

## File/interface map

| Область | Файлы/интерфейсы | Назначение и проверка |
|---|---|---|
| Project entrypoint | `README.md` | Установка, commands, architecture claims, runtime prerequisites; обновить только после command audit. |
| Documentation index | `docs/README.md` | Навигация и governance; сверить с фактическими `docs/` paths и README policy. |
| Hermes tooling docs | `tools/hermes/README.md` | Source/installed skills workflow; сверить с фактическими directories и scripts. |
| Command authority | `package.json`, workspace manifests, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | Канонический список `pnpm` scripts, packages, package manager и dependency graph. |
| Documentation validators | `scripts/docs-governance.mjs`, `scripts/roadmap-generator-cli.mjs` | Метаданные, plan parsing, inventory/check/roadmap behavior; команды запускать с dry-run там, где возможно. |
| Repository policy | `.gitignore`, `AGENTS.md`, `.hermes.md`, scoped `AGENTS.md` | Правила временных файлов, language, cleanup, gates и ownership boundaries. |
| Active plans | `docs/architecture/plans/15-01...15-09`, `15-auth-onboarding-ui-hardening` | Preserve unchanged; compare only for duplicate paths/claims. |
| Historical work | `.cuperpowers/**`, `.superpowers/**` | Inventory, hash, archive and disposition; no assumption that historical means disposable. |
| Reports/artifacts | root reports/JSON/TXT/HTML, `workspace/**`, `artifacts/**`, `docs/review/**` | Deduplicate and classify by provenance, references, reproducibility and secret risk. |

### Dependency graph

`inventory and authority check → integrity/secret/path verification → complete disposition list → explicit user approval → external archive and re-hash → approved delete/move and README/.gitignore/AGENTS updates → command/docs validation → links/status verification → final diff/status review`.

README editing depends on the verified command matrix. Any deletion/move depends on both the approval gate and successful external archive verification. No implementation task may depend on or modify the active `15-*` plans.

## Complete candidate disposition table

The following is the initial complete list derived from the current repository state. `inspect` means preserve pending evidence; it is not permission to delete. `State` is the observed Git/filesystem classification at draft time: `tracked`, `untracked`, `ignored`, or `mixed` (a directory whose descendants have more than one state). The implementation phase must re-enumerate paths and stop if the list or any state differs.

**Fail-closed state gate (before implementation):** after Task 1 inventory and again immediately before Task 5–9 side effects, compare the exact `(path, state)` set below with a fresh filesystem/Git inventory. For files, classify `tracked` from `git ls-files`, `ignored` from `git check-ignore`, and otherwise `untracked`; for directories, classify from the union of descendant states and use `mixed` when that union has more than one member. Exit non-zero and stop before approval packaging or implementation if the count is not exactly `97`, any path is missing or extra, any state is `unknown` or changed, any duplicate path exists, or any active `15-*` plan is absent from the tracked preservation set. Continue only when the exact 97-entry path/state set matches; do not coerce mismatches or infer a replacement state.

| Path | State | Action | Target/archive | Reason |
|---|---|---|---|---|
| `.cuperpowers/` | tracked | mixed directory (tracked descendant) | archive outside repo → verify preservation → delete root directory only after approval | Root action is atomic only after every listed descendant is archived and re-hashed. |
| `.cuperpowers/sdd/` | tracked | directory | archive as part of root snapshot; preserve relative path | Exact directory entry; no wildcard substitution. |
| `.cuperpowers/sdd/12-401-web-completion/` | tracked | directory | archive as part of root snapshot; preserve relative path | Exact directory entry. |
| `.cuperpowers/sdd/12-401-web-completion/task-5-report.json` | tracked | tracked file | archive as part of root snapshot; delete only with approved root action | Tracked historical report; JSON/secret/reference checks required. |
| `.superpowers/` | mixed | mixed directory (3 tracked, remaining ignored descendants) | archive outside repo → verify preservation → delete root directory only after approval | Root action is atomic only after every listed descendant is archived and re-hashed. |
| `.superpowers/sdd/` | mixed | mixed directory | archive as part of root snapshot; preserve relative path | Exact directory entry. |
| `.superpowers/sdd/.gitignore` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored local-state policy. |
| `.superpowers/sdd/12-401-web-completion/` | ignored | ignored directory | archive as part of root snapshot; preserve relative path | Exact directory entry. |
| `.superpowers/sdd/12-401-web-completion/progress.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored progress state. |
| `.superpowers/sdd/12-401-web-completion/task-1-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/12-401-web-completion/task-1-fix-review.diff` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored review diff. |
| `.superpowers/sdd/12-401-web-completion/task-1-report.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task report. |
| `.superpowers/sdd/12-401-web-completion/task-1-review.diff` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored review diff. |
| `.superpowers/sdd/12-401-web-completion/task-10-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/12-401-web-completion/task-11-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/12-401-web-completion/task-2-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/12-401-web-completion/task-2-fix-review.diff` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored review diff. |
| `.superpowers/sdd/12-401-web-completion/task-2-report.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task report. |
| `.superpowers/sdd/12-401-web-completion/task-2-review.diff` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored review diff. |
| `.superpowers/sdd/12-401-web-completion/task-3-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/12-401-web-completion/task-3-report.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task report. |
| `.superpowers/sdd/12-401-web-completion/task-3-review.diff` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored review diff. |
| `.superpowers/sdd/12-401-web-completion/task-4-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/12-401-web-completion/task-4-report.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task report. |
| `.superpowers/sdd/12-401-web-completion/task-4-review.diff` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored review diff. |
| `.superpowers/sdd/12-401-web-completion/task-5-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/12-401-web-completion/task-5-report.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task report. |
| `.superpowers/sdd/12-401-web-completion/task-5-review.diff` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored review diff. |
| `.superpowers/sdd/12-401-web-completion/task-6-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/12-401-web-completion/task-7-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/12-401-web-completion/task-8-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/12-401-web-completion/task-9-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/2026-09-16-orchestrator-final-v1-audit-hardening/` | tracked | directory | archive as part of root snapshot; preserve relative path | Exact directory entry. |
| `.superpowers/sdd/2026-09-16-orchestrator-final-v1-audit-hardening/mcp-validation-report.md` | tracked | tracked file | archive as part of root snapshot; delete only with approved root action | Tracked audit evidence. |
| `.superpowers/sdd/2026-09-16-orchestrator-final-v1-audit-hardening/security-remediation-report.md` | tracked | tracked file | archive as part of root snapshot; delete only with approved root action | Tracked security evidence; secret scan required. |
| `.superpowers/sdd/2026-09-16-orchestrator-final-v1-audit-hardening/ui-api-remediation-report.md` | tracked | tracked file | archive as part of root snapshot; delete only with approved root action | Tracked UI/API evidence. |
| `.superpowers/sdd/2026-09-18-web-ui-audit-and-recovery-design/` | ignored | ignored directory | archive as part of root snapshot; preserve relative path | Exact directory entry. |
| `.superpowers/sdd/2026-09-18-web-ui-audit-and-recovery-design/progress.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored progress state. |
| `.superpowers/sdd/2026-09-20-production-readiness-hardening/` | ignored | ignored directory | archive as part of root snapshot; preserve relative path | Exact directory entry. |
| `.superpowers/sdd/2026-09-20-production-readiness-hardening/plan-path` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored plan pointer. |
| `.superpowers/sdd/2026-09-20-production-readiness-hardening/progress.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored progress state. |
| `.superpowers/sdd/2026-09-22-web-ui-recovery-stage-a/` | ignored | ignored directory | archive as part of root snapshot; preserve relative path | Exact directory entry. |
| `.superpowers/sdd/2026-09-22-web-ui-recovery-stage-a/progress.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored progress state. |
| `.superpowers/sdd/2026-09-22-web-ui-recovery-stage-a/task-1-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/2026-09-22-web-ui-recovery-stage-a/task-1-report.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task report. |
| `.superpowers/sdd/2026-09-22-web-ui-recovery-stage-a/task-1-review-package.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored review package. |
| `.superpowers/sdd/2026-09-22-web-ui-recovery-stage-a/task-2-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/2026-09-22-web-ui-recovery-stage-a/task-2-report.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task report. |
| `.superpowers/sdd/2026-09-22-web-ui-recovery-stage-a/task-2-review-package.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored review package. |
| `.superpowers/sdd/2026-09-22-web-ui-recovery-stage-a/task-3-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/2026-09-22-web-ui-recovery-stage-a/task-3-report.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task report. |
| `.superpowers/sdd/2026-09-22-web-ui-recovery-stage-a/task-3-review-report.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored review package. |
| `.superpowers/sdd/2026-09-22-web-ui-recovery-stage-a/task-4-brief.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task input. |
| `.superpowers/sdd/2026-09-22-web-ui-recovery-stage-a/task-4-report.md` | ignored | ignored file | archive as part of root snapshot; delete only with approved root action | Ignored task report. |
| `workspace/` | tracked | tracked directory | archive outside repo → verify preservation → delete root directory only after approval | Root action is atomic only after every listed descendant is archived and re-hashed. |
| `workspace/link_analysis.json` | tracked | tracked file | archive as part of root snapshot; delete only with approved root action | Reference evidence. |
| `workspace/task-3-report.txt` | tracked | tracked file | archive as part of root snapshot; delete only with approved root action | Historical report. |
| `workspace/task-4-report.txt` | tracked | tracked file | archive as part of root snapshot; delete only with approved root action | Historical report. |
| `workspace/task-5-report.txt` | tracked | tracked file | archive as part of root snapshot; delete only with approved root action | Historical report. |
| `workspace/task-7-report.txt` | tracked | tracked file | archive as part of root snapshot; delete only with approved root action | Historical report. |
| `artifacts/security/pnpm-audit-prod-2026-09-21.json` | tracked | inspect/deduplicate | retain one canonical archive copy | Audit artifact dated by run; compare content and provenance. |
| `artifacts/security/pnpm-audit-prod-a0f18b3cfd8e8b3ae3139c9c9973ae2e2ebd81d8.json` | tracked | inspect/deduplicate | retain canonical hash-verified copy | Candidate duplicate security report. |
| `artifacts/security/pnpm-audit-prod-b3b66154729ca2b373e0424dbab96b4435ec2c11.json` | tracked | inspect/deduplicate | retain canonical hash-verified copy | Candidate duplicate security report. |
| `artifacts/task-10-fix-report.md` | tracked | inspect | archive/delete only after references | Historical task artifact; classify before removal. |
| `docs/review/final-report.json` | tracked | inspect/preserve unless superseded | archive if stale and redundant | Tracked review evidence; check current references. |
| `docs/review/findings.json` | tracked | inspect/preserve unless superseded | archive if stale and redundant | Tracked findings; do not remove load-bearing evidence. |
| `docs/99-plan-analysis-report.md` | tracked | inspect/preserve unless superseded | archive if stale and redundant | Tracked documentation report; verify links and uniqueness. |
| `docs/audit/02-audit-report.md` | tracked | inspect/preserve unless superseded | archive if stale and redundant | Tracked audit evidence. |
| `evidence_report.md` | tracked | archive/delete after verification | external archive `2026-09-28-root-artifacts` → delete | Stale root quality-gates report; superseded by current gates and not referenced by runtime/tooling. |
| `inventory.txt` | tracked | archive/delete after verification | external archive `2026-09-28-root-artifacts` → delete | Empty root inventory artifact. |
| `plan_summary.json` | tracked | archive/delete after verification | external archive `2026-09-28-root-artifacts` → delete | Stale historical plan summary; not a current authority. |
| `plan_verification_status.json` | tracked | archive/delete after verification | external archive `2026-09-28-root-artifacts` → delete | Stale historical verification artifact; current plan metadata/validators are authoritative. |
| `stage-a-implementation.json` | tracked | archive/delete after verification | external archive `2026-09-28-root-artifacts` → delete | Historical implementation report with no current consumer. |
| `summary.json` | tracked | archive/delete after verification | external archive `2026-09-28-root-artifacts` → delete | Stale task summary with no current consumer. |
| `task10-summary.json` | tracked | archive/delete after verification | external archive `2026-09-28-root-artifacts` → delete | Historical task summary with no current consumer. |
| `task-1-report.txt` | tracked | archive/delete after verification | external archive `2026-09-28-root-artifacts` → delete | Historical task report with no current consumer. |
| `task-5-report.txt` | tracked | archive/delete after verification | external archive `2026-09-28-root-artifacts` → delete | Historical task report with no current consumer. |
| `task7-completion.json` | tracked | archive/delete after verification | external archive `2026-09-28-root-artifacts` → delete | Historical task completion artifact with no current consumer. |
| `task-7-report.txt` | tracked | archive/delete after verification | external archive `2026-09-28-root-artifacts` → delete | Historical task report with no current consumer. |
| `task9-10-completion.json` | tracked | archive/delete after verification | external archive `2026-09-28-root-artifacts` → delete | Historical task completion artifact with no current consumer. |
| `task-report.md` | tracked | archive/delete after verification | external archive `2026-09-28-root-artifacts` → delete | Historical task report with no current consumer. |
| `start.bat` | tracked | archive/delete after verification | external archive `2026-09-28-root-artifacts` → delete | Obsolete Windows-only launcher; cross-platform project uses `pnpm start`. |
| `README.md` | tracked | update in implementation phase | repository | Correct command matrix, claims and language; remove frontmatter-like metadata. |
| `docs/README.md` | tracked | update in implementation phase | repository | Reconcile index/paths and remove frontmatter-like metadata. |
| `tools/hermes/README.md` | tracked | update in implementation phase | repository | Reconcile skills/scripts and remove frontmatter-like metadata. |
| `.gitignore` | tracked | inspect/update only if justified | repository | Evaluate narrow `temp/`/generated test output rules; never ignore source tests. |
| `AGENTS.md` | tracked | inspect/update only if justified | repository | Add explicit temporary-file placement/cleanup rule only if needed. |
| `docs/architecture/plans/15-01-auth-contract-and-crypto.md` | tracked | preserve unchanged | repository | Unrelated active plan; byte-for-byte preservation baseline. |
| `docs/architecture/plans/15-02-auth-persistence-and-repository.md` | tracked | preserve unchanged | repository | Unrelated active plan; byte-for-byte preservation baseline. |
| `docs/architecture/plans/15-03-auth-cli-and-startup.md` | tracked | preserve unchanged | repository | Unrelated active plan; byte-for-byte preservation baseline. |
| `docs/architecture/plans/15-04-server-security-boundary.md` | tracked | preserve unchanged | repository | Unrelated active plan; byte-for-byte preservation baseline. |
| `docs/architecture/plans/15-05-web-auth-and-sse.md` | tracked | preserve unchanged | repository | Unrelated active plan; byte-for-byte preservation baseline. |
| `docs/architecture/plans/15-06-onboarding-draft-and-scheduler-guard.md` | tracked | preserve unchanged | repository | Unrelated active plan; byte-for-byte preservation baseline. |
| `docs/architecture/plans/15-07-russian-ui-and-artifact-cleanup.md` | tracked | preserve unchanged | repository | Unrelated active plan; byte-for-byte preservation baseline. |
| `docs/architecture/plans/15-08-verification-and-review.md` | tracked | preserve unchanged | repository | Unrelated active plan; byte-for-byte preservation baseline. |
| `docs/architecture/plans/15-09-atomic-auth-v2-remediation.md` | tracked | preserve unchanged | repository | Unrelated active plan; byte-for-byte preservation baseline. |
| `docs/architecture/plans/15-auth-onboarding-ui-hardening.md` | tracked | preserve unchanged | repository | Unrelated active plan; byte-for-byte preservation baseline. |

**Candidate count in this table is 97 atomic entries.** The implementation inventory must print exactly `97` entries (including directory entries and tracked/ignored state) and fail closed if any path, state or count differs unexpectedly.

## Implementation tasks

### Task 1 — Freeze context and reproduce the initial inventory

Files: repository root, `docs/architecture/plans/`, candidate paths above. Symbols/interfaces: Git index/worktree state, path classification, plan filenames.

- Run `git branch --show-current`, `git rev-parse HEAD`, `git status --short --untracked-files=all`, `git ls-files`, and path enumeration without `git clean`.
- Confirm `develop` and expected HEAD; record all ten tracked `15-*` plans as preserved unrelated work.
- Re-enumerate hidden, tracked, untracked and ignored candidate files and directories. Produce a machine-readable inventory outside the repository or in an explicitly temporary review location, not as a new repository artifact.
- Run the governance structure check `pnpm docs:check` from the repository root; record its exit code/output and confirm it does not validate date values.
- Run this separate deterministic metadata/date validator from the repository root (it validates the exact frontmatter fields and ISO calendar dates for plan-16 without writing files):
  ```bash
  node --input-type=module -e "import {readFileSync} from 'node:fs'; const p='docs/architecture/plans/16-documentation-cleanup-and-refresh.md'; const text=readFileSync(p,'utf8'); const fm=text.match(/^---\r?\n([\s\S]*?)\r?\n---/); if(!fm) throw new Error('missing frontmatter'); const required={id:'plan-16',kind:'plan',status:'in_progress',created:'2026-09-25',updated:'2026-09-27',title:'Очистка и актуализация документации Ebb Orchestrator'}; for(const [key,value] of Object.entries(required)){const m=fm[1].match(new RegExp('^'+key+':\\s*(.+)$','m')); if(!m||m[1].trim()!==value) throw new Error(key+' mismatch'); if((key==='created'||key==='updated')&&!/^\d{4}-\d{2}-\d{2}$/.test(m[1].trim())) throw new Error(key+' is not ISO date');} console.log('plan-16 metadata/date validation passed: created=2026-09-25 updated=2026-09-27');"
  ```
- Expected: `pnpm docs:check` exits `0` for frontmatter/id/filename checks, the inline validator exits `0` and prints `plan-16 metadata/date validation passed: created=2026-09-25 updated=2026-09-27`; neither command changes files. No candidate is silently omitted; any inventory mismatch blocks further work; inventory/validation leaves no `docs/roadmap/generated.md` or other new artifact.

### Task 2 — Establish authority and references

Files: `.hermes.md`, `AGENTS.md`, scoped `AGENTS.md`, canonical specs, all plans, README files, scripts.

- Search references to every candidate path, report filename, plan ID and generated artifact name.
- Treat current user requirements first, then approved specs/instructions, then current code as evidence; treat historical reports as evidence only.
- Build a reference matrix showing source path, referring path, link type, and whether the link is load-bearing.
- Expected: active plans remain untouched and every deletion/move candidate has an explicit reference disposition.

### Task 3 — Prove integrity and safety before any destructive operation

Files: all candidate files; generated manifest must stay outside repository until approval.

- Create a SHA-256 manifest with normalized relative paths, byte size, mode/type and hash.
- Validate JSON syntax/UTF-8 for every JSON candidate; validate Markdown/HTML/TXT UTF-8; run `git diff --check` on the pre-existing state without modifying it.
- Compare `git ls-files` against filesystem inventory and `git status --short --untracked-files=all`; detect tracked/untracked duplicates by normalized content hash.
- Scan candidate contents and paths for secrets, credentials, tokens, private keys, absolute local paths and unsafe symlink/junction traversal. Redact findings from reports.
- Expected: manifest is complete, hashes are reproducible, no archive includes secrets, and any invalid/ambiguous item is `preserve/blocked`, never deleted.

### Task 4 — Verify external archive and define approval package

Files: external archive directory chosen outside repository; disposition report; SHA-256 manifest.

- Copy only approved-to-archive candidates while preserving relative paths and metadata needed for restore.
- Hash the archive and each archived file again; compare with the pre-archive manifest; test extraction/listing and path containment.
- Prepare the complete user-facing disposition list: `path → action → target/archive → reason`, including all `preserve`, `inspect`, `move` and `delete` rows and unresolved findings.
- **Explicit approval checkpoint:** stop and request the user's written approval of the exact list, archive location and any README/`.gitignore`/`AGENTS.md` changes. No delete, move or content update occurs before approval.
- Expected: approval package is reproducible and a missing/changed approval means stop without side effects.

### Task 5 — Audit every pnpm command from real manifests

Files: `package.json`, `apps/server/package.json`, `apps/web/package.json`, `packages/contracts/package.json`, `packages/testing/package.json`, `apps/server/test/e2e/fixtures/health-service/package.json`, all three README files, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, referenced scripts.

Сначала зафиксировать этот deterministic matrix как проверяемый набор строк; после каждого запуска сохранить `cwd`, prerequisites, классификацию `read-only`/`side-effect`, exact invocation, exit code и ожидаемый результат. `pnpm docs:roadmap` по умолчанию записывает `docs/roadmap/generated.md`, поэтому для audit использовать только isolated copy рабочего дерева либо поддержанный dry-run, а затем проверять, что в исходном и isolated repo не появились неожиданные artifacts.

| Source | cwd | Prerequisites | Class | Exact invocation | Expected exit/output |
|---|---|---|---|---|---|
| root `package.json` | repo root | Node `>=24.15 <25`, pnpm `12.4.2`, lockfile | read-only | `pnpm typecheck` | `0`; recursive workspace typecheck passes |
| root `package.json` | repo root | dependencies installed | read-only | `pnpm test` | `0`; recursive workspace tests pass |
| root `package.json` | repo root | dependencies installed | read-only | `pnpm lint` | `0`; ESLint reports no errors |
| root `package.json` | repo root | dependencies installed | side-effect (build outputs) | `pnpm build` | `0`; workspace builds complete; record generated outputs |
| root `package.json` | repo root | contracts workspace available | side-effect (build output) | `pnpm server:build` | `0`; `apps/server/dist/main.js` exists |
| root `package.json` | repo root | dependencies installed | side-effect (build output) | `pnpm web:build` | `0`; Vite build completes |
| root `package.json` | repo root | Node and scripts present | side-effect (HERMES_HOME) | `pnpm hermes:setup` | run only in isolated copy; `0` and setup report |
| root `package.json` | repo root | setup completed | read-only | `pnpm hermes:check` | `0`; installation check passes |
| root `package.json` | repo root | Node | read-only | `pnpm hermes:test` | `0`; Node test summary passes |
| root `package.json` | repo root | explicit execute fixture/capability approval | side-effect | `pnpm hermes:execute -- <plan>` | do not run during audit; document blocked prerequisite and exact command |
| root `package.json` | repo root | Node | read-only | `pnpm docs:inventory` | `0`; inventory printed; assert no new artifact |
| root `package.json` | repo root | Node | read-only | `pnpm docs:check` | `0`; valid metadata/naming; assert no new artifact |
| root `package.json` | repo root | Node | read-only (supported dry-run) | `pnpm docs:roadmap -- --dry-run` | `0`; preview is printed, `docs/roadmap/generated.md` is not written, source repo unchanged; do not probe unsupported `--help` because the CLI has no help handler and may generate the default output file |
| root `package.json` | repo root | Node | read-only (implemented behavior) | `pnpm docs:rename:check` | `0`; exact stdout is `Rename check not yet implemented`; no artifact |
| root `package.json` | repo root | Node; command dispatcher has no `link:sync` implementation | unsupported/side-effecting request (not verified read-only) | `pnpm docs:link:sync` | `1`; exact stdout is `Usage: node docs-governance.mjs <command> [options]`, `Commands: inventory, check, roadmap, rename:check`, `Roadmap options: --dry-run, --output=<path>`; pnpm adds `[ELIFECYCLE] Command failed with exit code 1`; no sync is performed |
| root `package.json` | repo root | Node | read-only | `pnpm docs:test` | `0`; governance tests pass; no artifact |
| root `package.json` | repo root | built server and writable `EBB_ORCHESTRATOR_HOME` | side-effect (server state) | `pnpm start` | long-running server; audit only via isolated home and health probe |
| root `package.json` | repo root | dependencies installed | side-effect (server process) | `pnpm server:dev` | long-running `tsx watch`; not a read-only audit command |
| root `package.json` | repo root | dependencies installed | side-effect (Vite process) | `pnpm web:dev` | long-running Vite server; not a read-only audit command |
| `apps/server/package.json` | `apps/server` | dependencies, Node | side-effect (server process) | `pnpm dev` | long-running `tsx watch src/main.ts` |
| `apps/server/package.json` | `apps/server` | contracts, TypeScript | side-effect (dist cleanup/build) | `pnpm build` | `0`; server dist generated |
| `apps/server/package.json` | `apps/server` | built dist, writable home | side-effect (server state) | `pnpm start` | long-running `node dist/main.js` |
| `apps/server/package.json` | `apps/server` | TypeScript | read-only | `pnpm typecheck` | `0`; no emit |
| `apps/server/package.json` | `apps/server` | Vitest | read-only | `pnpm test` | `0`; Vitest summary |
| `apps/web/package.json` | `apps/web` | dependencies, Vite | side-effect (dist) | `pnpm build` | `0`; Vite output recorded |
| `apps/web/package.json` | `apps/web` | Vitest | read-only | `pnpm test` | `0`; Vitest summary |
| `apps/web/package.json` | `apps/web` | Vitest | read-only | `pnpm test:watch` | long-running watch; do not use for audit |
| `apps/web/package.json` | `apps/web` | Node, server fixture as required | side-effect (browser/e2e artifacts) | `pnpm test:e2e` | run only isolated; `0` and no source artifacts |
| `packages/contracts/package.json` | `packages/contracts` | TypeScript | side-effect (dist cleanup/build) | `pnpm build` | `0`; dist generated |
| `packages/contracts/package.json` | `packages/contracts` | TypeScript | read-only | `pnpm typecheck` | `0`; no emit |
| `packages/contracts/package.json` | `packages/contracts` | Vitest | read-only | `pnpm test` | `0`; pass-with-no-tests allowed |
| `packages/testing/package.json` | `packages/testing` | TypeScript | read-only | `pnpm typecheck` | `0`; no emit |
| `packages/testing/package.json` | `packages/testing` | Vitest | read-only | `pnpm test` | `0`; pass-with-no-tests allowed |
| fixture `package.json` | `apps/server/test/e2e/fixtures/health-service` | Node | side-effect (server process) | `pnpm start` | long-running fixture server; isolated E2E only |
| fixture `package.json` | `apps/server/test/e2e/fixtures/health-service` | Node | read-only | `pnpm test` | `0`; smoke test output |
| `README.md` | repo root | listed Node/pnpm/Git prerequisites | read-only | `node --version`; `pnpm --version`; `git --version` | `0`; versions satisfy documented constraints |
| `README.md` | repo root | frozen lockfile | side-effect (node_modules) | `pnpm install --frozen-lockfile` | `0`; lockfile unchanged |
| `README.md` | repo root | dependencies | read-only | `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm server:build`; `pnpm --filter @ebb-orchestrator/web build`; `git diff --check` | each exact command runs in isolated copy where build outputs are possible; expected documented exit/output recorded |
| `README.md` | repo root | dependencies | side-effect/process | `pnpm --filter @ebb-orchestrator/server dev`; `pnpm --filter @ebb-orchestrator/web dev`; `pnpm server:dev`; `pnpm web:dev`; `pnpm start` | classify as long-running and do not count as read-only validation |
| `README.md` | repo root | dependencies | side-effect (build) | `pnpm server:build`; `pnpm web:build` | `0`; exact outputs recorded and cleaned only in isolated copy |
| `README.md` | repo root | Node | read-only | `pnpm docs:inventory`; `pnpm docs:check`; `pnpm docs:test`; `pnpm hermes:check` | each exits `0` with the command's exact success output and no artifact; `pnpm hermes:setup` is excluded from this read-only set and is a separate side-effecting isolated-copy check |
| `README.md` | repo root | Node; setup requires isolated `HERMES_HOME` | side-effect (HERMES_HOME/setup state) | `pnpm hermes:setup` | `0`; setup output includes `HERMES_CONFIG marker=SETUP_SYNCED verified=true redacted=true` and `Setup complete.`; run only in isolated copy |
| `docs/README.md` | repo root | documentation paths | read-only | navigation links and referenced paths | no shell command; validate every listed path exists or is explicitly marked stale |
| `tools/hermes/README.md` | repo root | Node, installed skills only for execution | side-effect/process | `pnpm hermes:setup`; `pnpm hermes:check`; `pnpm hermes:execute -- <plan>` | setup changes HERMES_HOME; check is read-only; execute requires explicit approval and isolated plan |

- Матрица должна содержать также любой новый script, найденный в перечисленных manifests; отсутствие script в текущей версии фиксируется как mismatch, а не исправляется догадкой. README-команды, не являющиеся manifest scripts (например `node --version`, `git diff --check` и ссылки), остаются отдельными строками с теми же колонками.
- Проверить package filters (`@ebb-orchestrator/server`, `@ebb-orchestrator/web`) по фактическим workspace names, `packageManager`/Node engine по `package.json` и `pnpm-lock.yaml`, а также prerequisites каждого скрипта.
- README-команды governance/Hermes разделить по фактическому риску: `pnpm docs:inventory`, `pnpm docs:check`, `pnpm docs:test` и `pnpm hermes:check` входят в read-only verified set с exact exit/output и artifact absence check; `pnpm hermes:setup` отдельно классифицируется как side-effecting (`HERMES_HOME`/setup state) и запускается только в изолированной копии; `pnpm docs:rename:check` фиксируется как implemented-but-unimplemented (`0`, `Rename check not yet implemented`); `pnpm docs:link:sync` фиксируется как unsupported (`1`, dispatcher usage output) и не считается проверенной read-only командой.
- Expected: детерминированная матрица покрывает каждый script и каждую команду трёх README; README обновляется только по строкам с подтверждённым exit/output; после inventory/validation, включая roadmap audit, отсутствуют `docs/roadmap/generated.md` и любые другие новые artifacts в исходном repo.

### Task 6 — Refresh all project README files in Russian

Files: `README.md`, `docs/README.md`, `tools/hermes/README.md`; links to canonical docs and scripts.

- Remove YAML/frontmatter-like leading metadata blocks from all three README files while retaining factual Markdown content.
- Rewrite stale plan/index references to actual paths under `docs/architecture/plans/`, preserving technical identifiers, commands and paths verbatim.
- Align setup, development, build, docs governance, Hermes skills and quality-gate instructions with Task 5 evidence.
- Synchronize `scripts/hermes-dev.test.mjs` with the canonical 11-skill registry and keep its secret-pattern assertion boundary-aware; this is a test-only governance correction required because the existing check was stale and falsely matched ordinary `task-controller` text.
- Mark optional, unavailable or not-yet-verified features explicitly; do not turn historical audit claims into current guarantees.
- Validate links, heading structure, UTF-8 and Russian prose; do not change production source code or active plans.
- Expected: all project README files are Russian, metadata-free, factually linked and reproducible from the command matrix.

### Task 7 — Decide `.gitignore` and `AGENTS.md` policy narrowly

Files: `.gitignore`, `AGENTS.md`, possibly no change if evidence does not justify it.

- Evaluate `temp/` and `test/` names against actual source directories and generated outputs. Prefer specific patterns such as local temporary directories or generated test output; never add broad `test/` that would hide `apps/server/test` or `apps/web/test`.
- Add an `AGENTS.md` rule only if it states where temporary files may be created, requires cleanup or external placement, preserves source/tests and forbids destructive Git cleanup. Keep it consistent with existing instructions.
- Expected: either a minimal justified diff or an explicit no-change decision with evidence.

### Task 8 — Execute approved cleanup and verify links/status

Files: only approved candidate paths, `.gitignore`, `AGENTS.md`, README files.

- After approval and archive re-hash, perform only the approved delete/move operations; preserve unrelated active plans and all non-approved candidates.
- Re-run path/reference scans, `pnpm docs:inventory`, `pnpm docs:check`, `pnpm docs:test`, `pnpm docs:roadmap --dry-run`/canonical roadmap check, and link validation.
- Verify archived items can be restored, deleted/moved paths are absent, no README link points at a removed path, and no new root artifact was generated unintentionally.
- Expected: repository contains only approved changes and all surviving references resolve or are intentionally documented as historical/external.

### Task 9 — Final documentation and repository gates

Files: final diff and status only; no code files expected to change.

- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm server:build`, `pnpm web:build`, relevant docs tests and `git diff --check`; use exact commands that Task 5 proves valid.
- Review `git diff -- README.md docs/README.md tools/hermes/README.md .gitignore AGENTS.md` and `git status --short --untracked-files=all`.
- Verify no secrets, no active-plan changes, no unapproved deletes/moves and no generated cleanup artifacts remain.
- Expected: all required gates are green or documented as an environment blocker; no claim of completion is made while a required gate is red.

## RED → GREEN evidence

Behavior changes are documentation/governance behavior rather than runtime behavior. Where a validator or script is changed (only if separately approved), first add or identify a failing test for the intended rule (for example: README frontmatter rejection, narrow temporary path ignore, stale-link detection), run the focused test to show RED, then make the smallest change and rerun to show GREEN. For README-only changes, use before/after command and link checks as the RED/GREEN evidence; do not fabricate a test requirement for prose.

## Acceptance criteria

- [x] New plan is the only file created in this draft phase; no code, existing plan, archive, delete or move was performed.
- [x] Следующие десять pre-existing tracked `15-*` plans остаются byte-for-byte immutable и не входят в cleanup: `docs/architecture/plans/15-01-auth-contract-and-crypto.md`, `docs/architecture/plans/15-02-auth-persistence-and-repository.md`, `docs/architecture/plans/15-03-auth-cli-and-startup.md`, `docs/architecture/plans/15-04-server-security-boundary.md`, `docs/architecture/plans/15-05-web-auth-and-sse.md`, `docs/architecture/plans/15-06-onboarding-draft-and-scheduler-guard.md`, `docs/architecture/plans/15-07-russian-ui-and-artifact-cleanup.md`, `docs/architecture/plans/15-08-verification-and-review.md`, `docs/architecture/plans/15-09-atomic-auth-v2-remediation.md`, `docs/architecture/plans/15-auth-onboarding-ui-hardening.md`.
- [x] `docs/architecture/plans/16-documentation-cleanup-and-refresh.md` явно исключён из preservation baseline: его targeted edit является единственным изменением draft phase и не считается pre-existing immutable plan.
- [x] Final implementation inventory exactly matches the approved 97-entry candidate list, including every listed directory/file and tracked/ignored state, or has a documented user-approved amendment.
- [x] Every candidate has a disposition and reason; `preserve/inspect` items are not treated as deletion permission; for `.cuperpowers/`, `.superpowers/` and `workspace/`, archive outside repo, verify preservation, then delete only the root directory after approval.
- [x] SHA-256 manifest, JSON/UTF-8 validation, tracked-vs-untracked comparison, path/diff checks, reference scan and secret scan pass.
- [x] External archive is outside repository, path-safe, restorable and re-hashed successfully before cleanup.
- [x] Explicit user approval is recorded before any delete/move/README/policy implementation.
- [x] `README.md`, `docs/README.md` and `tools/hermes/README.md` are Russian, metadata-free and link to real current paths.
- [x] README documents only verified `pnpm` commands and states prerequisites/environment-dependent behavior.
- [x] `.gitignore` changes, if any, are narrow and do not hide source tests; `AGENTS.md` changes, if any, define safe temporary-file handling.
- [x] `pnpm docs:check` validates frontmatter/id/filename structure; the separate deterministic metadata/date validator validates plan-16 `created: 2026-09-25` and `updated: 2026-09-28` as ISO dates; inventory, validation and roadmap audit leave neither `docs/roadmap/generated.md` nor any other new artifact.
- [x] Documentation validators, quality gates, link/status checks and `git diff --check` pass; no unrelated changes remain.

## Risks and rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Historical evidence is deleted as “generated” | Hash/reference/provenance inventory and explicit `preserve/inspect` disposition | Restore exact archived paths after verifying hashes; revert only approved deletion commit/diff. |
| Archive is incomplete or modified | Per-file and archive SHA-256 before/after, extraction/path test | Stop cleanup; recreate archive; do not delete source candidates. |
| Secret or absolute path leaks into archive/report | Secret/path scan with fail-closed disposition and redacted evidence | Destroy unsafe archive through approved secure process; preserve source and report blocker. |
| Broad `.gitignore` hides source tests | Test against actual `apps/*/test` paths and `git check-ignore -v` | Remove narrow rule and restore tracking; never use `git clean`. |
| README advertises stale/nonexistent command | Manifest-driven command enumeration and real exit-code log | Revert only incorrect prose and rerun docs checks. |
| Link removal breaks active plans or docs | Reference matrix and post-cleanup link scan | Restore archived path or update only approved links. |
| User approval becomes ambiguous after inventory changes | Freeze manifest and require written amendment for any path/hash/action change | Stop and request a new approval; no partial cleanup. |

Rollback is restoration from the verified external archive plus reverting approved documentation/policy diffs. Never roll back with `git reset --hard`, `git clean`, or unreviewed bulk deletion.

## Approval gate and completion rule

This plan is a draft until the user explicitly approves the complete disposition table, archive target, and proposed README/`.gitignore`/`AGENTS.md` changes. Approval must occur after Task 1–4 evidence and before Task 5–9 implementation side effects. If the user rejects or changes any row, update the inventory/disposition package and obtain approval again. Only after all acceptance criteria and gates pass may the implementation be reported complete.
