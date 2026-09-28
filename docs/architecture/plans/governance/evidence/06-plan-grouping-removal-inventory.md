---
id: ledger-06
kind: ledger
status: complete
title: Полный inventory упоминаний плановой группировки
created: 2026-09-27
updated: 2026-09-27
---

# Plan-grouping removal: baseline and current inventory

## Исходный baseline (Task 1)

Ниже сохранены все 99 исходных уникальных путей и точные baseline `path:line`. Номера строк относятся к снимку до правок и **не являются координатами текущих патчей**. Классы взаимоисключающие по пути.

| Baseline class | Пути | Совпадения |
|---|---:|---:|
| Historical grouping/tooling | 60 | 424 |
| Runtime workflow | 32 | 185 |
| Unrelated / false positive | 7 | 27 |
| **Baseline total** | **99** | **636** |

Historical grouping/tooling объединены в исходном baseline-классе: 60 путей / 424 совпадения. Точный baseline content query (tracked files):

```sh
git grep -inE '[sS][tT][aA][gG][eE]|roadmap[Ss][tT][aA][gG][eE]|grouped[Bb]y[Ss][tT][aA][gG][eE]|groupInto[Ss][tT][aA][gG][eE]|render[Ss]Register|groupBy[Ss][tT][aA][gG][eE]|[sS][tT][aA][gG][eE]sMap' -- . ':(exclude)docs/architecture/plans/17-ci-runtime-home-and-env-hardening.md' ':(exclude)docs/architecture/plans/governance/00-05-governance-integration.md' ':(exclude)docs/architecture/plans/governance/evidence/06-plan-grouping-removal-inventory.md'
```

## Точные baseline записи

`Baseline lines` перечисляет все исходные номера строк данного пути; Hits равен числу перечисленных номеров.

| Path | Baseline class | Hits | Baseline lines |
|---|---|---:|---|
| `apps/server/src/app/read-models/epic-projection.ts` | runtime | 6 | 19, 30, 38, 39, 43, 48 |
| `apps/server/src/app/read-models/task-projection.ts` | runtime | 1 | 30 |
| `apps/server/src/app/routes/work.ts` | runtime | 2 | 54, 55 |
| `apps/server/src/modules/execution/git-tools.ts` | runtime | 1 | 36 |
| `apps/server/src/modules/planning/epic-orchestrator.ts` | runtime | 21 | 34, 100, 138, 140, 156, 157, 158, 159, 160, 161, 162, 197, 207, 208, 209, 214, 219, 220, 228, 230, 282 |
| `apps/server/src/modules/recovery/progress-fingerprint.ts` | runtime | 7 | 59, 73, 87, 97, 102, 112, 116 |
| `apps/server/src/modules/recovery/recovery-policy.ts` | runtime | 10 | 25, 30, 39, 43, 51, 66, 68, 91, 92, 109 |
| `apps/server/src/modules/recovery/recovery-types.ts` | runtime | 4 | 16, 20, 103, 104 |
| `apps/server/src/modules/runtime/prompt-builder.ts` | runtime | 5 | 33, 88, 204, 262, 306 |
| `apps/server/src/modules/runtime/run-event-handlers.ts` | runtime | 15 | 153, 154, 159, 163, 164, 166, 188, 193, 197, 199, 201, 259, 260, 261, 297 |
| `apps/server/src/modules/runtime/run-orchestrator.ts` | runtime | 1 | 23 |
| `apps/server/src/modules/workflow/templates.ts` | runtime | 7 | 4, 23, 134, 170, 176, 277, 323 |
| `apps/server/src/modules/workflow/workflow-engine.ts` | runtime | 5 | 138, 140, 184, 186, 187 |
| `apps/server/src/modules/workflow/workflow-types.ts` | runtime | 2 | 35, 36 |
| `apps/server/src/platform/database/migrations/011_epic_orchestration.sql` | runtime | 1 | 7 |
| `apps/server/test/e2e/autonomous-task.hermes.test.ts` | runtime | 1 | 50 |
| `apps/server/test/e2e/epic.fake-runtime.test.ts` | runtime | 1 | 189 |
| `apps/server/test/e2e/v1-autonomous-task.test.ts` | runtime | 5 | 381, 419, 421, 442, 477 |
| `apps/server/test/e2e/v1-epic.test.ts` | runtime | 6 | 392, 393, 396, 439, 440, 443 |
| `apps/server/test/modules/context/context-builder.test.ts` | runtime | 4 | 361, 373, 377, 378 |
| `apps/server/test/modules/execution/git-tools.test.ts` | runtime | 4 | 59, 73, 82, 83 |
| `apps/server/test/modules/recovery/recovery.test.ts` | runtime | 5 | 51, 59, 249, 261, 273 |
| `apps/server/test/modules/workflow/workflow-engine.test.ts` | runtime | 15 | 256, 258, 261, 266, 338, 341, 344, 348, 351, 354, 358, 361, 364, 374, 385 |
| `apps/server/test/scenarios/standalone-task.fake-runtime.test.ts` | runtime | 9 | 270, 284, 288, 291, 301, 303, 307, 323, 327 |
| `apps/web/src/components/WorkflowTimeline.tsx` | runtime | 18 | 4, 5, 9, 16, 28, 44, 45, 46, 47, 48, 49, 50, 51, 56, 57, 61, 62, 66 |
| `apps/web/src/features/epics/EpicPage.tsx` | runtime | 2 | 7, 34 |
| `apps/web/src/features/tasks/TaskPage.tsx` | runtime | 2 | 6, 36 |
| `apps/web/src/i18n/ru.ts` | runtime | 3 | 71, 105, 107 |
| `apps/web/test/core-views.test.tsx` | runtime | 17 | 12, 33, 34, 37, 38, 168, 184, 200, 217, 346, 349, 370, 385, 400, 403, 415, 416 |
| `apps/web/test/localization-accessibility.test.tsx` | runtime | 1 | 85 |
| `artifacts/task-10-fix-report.md` | unrelated | 1 | 23 |
| `docs/README.md` | historical language | 3 | 103, 104, 105 |
| `docs/architecture/plans/01-foundation-persistence.md` | historical language | 1 | 5 |
| `docs/architecture/plans/02-domain-workflow-scheduler.md` | historical language | 3 | 5, 37, 184 |
| `docs/architecture/plans/03-git-execution-security.md` | historical language | 1 | 5 |
| `docs/architecture/plans/04-hermes-autonomous-task.md` | historical language | 1 | 5 |
| `docs/architecture/plans/05-planning-epics-context-knowledge.md` | historical language | 1 | 5 |
| `docs/architecture/plans/06-web-github-release.md` | historical language | 1 | 5 |
| `docs/architecture/plans/07-hermes-development-workflow.md` | historical language | 3 | 5, 997, 1208 |
| `docs/architecture/plans/08-01-web-ui-foundation.md` | historical language | 8 | 4, 9, 22, 28, 97, 101, 104, 110 |
| `docs/architecture/plans/08-02-web-ui-core-functional.md` | historical language | 5 | 9, 23, 44, 219, 241 |
| `docs/architecture/plans/08-03-web-ui-operational-and-e2e.md` | historical language | 3 | 9, 20, 71 |
| `docs/architecture/plans/08-04-web-ui-audit-and-recovery-design.md` | historical language | 7 | 9, 21, 363, 427, 440, 489, 498 |
| `docs/architecture/plans/09-production-readiness.md` | historical language | 1 | 5 |
| `docs/architecture/plans/10-final-audit-hardening.md` | historical language | 1 | 5 |
| `docs/architecture/plans/11-hermes-development-capabilities.md` | historical language | 1 | 5 |
| `docs/architecture/plans/12-401-web-completion.md` | historical language | 1 | 5 |
| `docs/architecture/plans/13-roadmap-generator.md` | historical language | 7 | 5, 30, 32, 74, 89, 94, 105 |
| `docs/architecture/plans/14-docker-runtime.md` | historical language | 12 | 5, 96, 101, 157, 354, 466, 468, 477, 483, 487, 709, 712 |
| `docs/architecture/plans/15-01-auth-contract-and-crypto.md` | historical language | 1 | 5 |
| `docs/architecture/plans/15-02-auth-persistence-and-repository.md` | historical language | 1 | 5 |
| `docs/architecture/plans/15-03-auth-cli-and-startup.md` | historical language | 1 | 5 |
| `docs/architecture/plans/15-04-server-security-boundary.md` | historical language | 1 | 5 |
| `docs/architecture/plans/15-05-web-auth-and-sse.md` | historical language | 1 | 5 |
| `docs/architecture/plans/15-06-onboarding-draft-and-scheduler-guard.md` | historical language | 1 | 5 |
| `docs/architecture/plans/15-07-russian-ui-and-artifact-cleanup.md` | historical language | 3 | 5, 91, 105 |
| `docs/architecture/plans/15-08-verification-and-review.md` | historical language | 10 | 5, 48, 68, 77, 83, 87, 88, 93, 103, 104 |
| `docs/architecture/plans/15-09-atomic-auth-v2-remediation.md` | historical language | 1 | 5 |
| `docs/architecture/plans/15-auth-onboarding-ui-hardening.md` | historical language | 2 | 5, 91 |
| `docs/architecture/plans/16-documentation-cleanup-and-refresh.md` | historical language | 15 | 5, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 199 |
| `docs/architecture/plans/governance/00-01-documentation-governance.md` | historical language | 49 | 5, 18, 29, 30, 32, 82, 83, 86, 121, 167, 252, 255, 274, 275, 312, 322, 379, 386, 391, 396, 407, 409, 459, 476, 494, 523, 531, 564, 575, 576, 587, 602, 618, 680, 712, 815, 853, 868, 869, 870, 871, 872, 873, 874, 965, 978, 1022, 1041, 1042 |
| `docs/architecture/plans/governance/00-03-plan-naming-policy.md` | historical language | 5 | 5, 27, 42, 59, 68 |
| `docs/architecture/plans/governance/08-stage-01-merge-decisions.md` | historical language | 17 | 4, 10, 14, 21, 24, 25, 27, 30, 31, 32, 33, 40, 41, 47, 53, 54, 55 |
| `docs/architecture/plans/governance/evidence/01-baseline.md` | historical language | 3 | 52, 53, 76 |
| `docs/architecture/plans/governance/evidence/02-progress-ledger.md` | historical language | 1 | 33 |
| `docs/architecture/plans/governance/evidence/03-document-migration-map.md` | historical language | 57 | 13, 20, 25, 29, 30, 32, 35, 40, 45, 47, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 99, 100, 102, 105, 107, 109, 110, 112, 115, 117, 120, 125, 130, 135, 140, 145, 150, 155, 160, 165, 170, 175, 180, 185, 190, 195, 200, 205, 210, 215, 220, 225, 230, 238, 255, 256, 265 |
| `docs/architecture/plans/governance/evidence/05-plan-15-roadmap-reconciliation.md` | historical language | 18 | 18, 20, 56, 90, 93, 123, 160, 221, 259, 303, 359, 395, 432, 469, 515, 613, 647, 652 |
| `docs/architecture/reference-ui/02-task-view-concept.html` | unrelated | 7 | 34, 35, 104, 105, 106, 107, 108 |
| `docs/architecture/reference-ui/03-epic-view-concept.html` | unrelated | 8 | 34, 35, 111, 112, 113, 114, 115, 116 |
| `docs/architecture/specs/01-system-design.md` | historical language | 13 | 6, 469, 1608, 1612, 1616, 1620, 1624, 1628, 1632, 1645, 1649, 1653, 1721 |
| `docs/architecture/specs/02-web-ui-recovery-design.md` | historical language | 5 | 6, 18, 153, 249, 301 |
| `docs/architecture/specs/03-production-readiness-design.md` | historical language | 1 | 6 |
| `docs/architecture/specs/04-hermes-development-capabilities.md` | historical language | 2 | 6, 33 |
| `docs/audit/01-full-audit.md` | historical language | 7 | 16, 36, 507, 509, 516, 1147, 1243 |
| `docs/audit/04-final-audit.md` | historical language | 3 | 495, 1315, 1317 |
| `docs/audit/07-project-state.md` | historical language | 7 | 141, 151, 153, 164, 200, 217, 218 |
| `docs/audit/09-web-ui-gap-analysis.md` | historical language | 3 | 13, 131, 155 |
| `docs/audit/12-plan-status.md` | historical language | 1 | 5 |
| `docs/development/02-documentation-governance.md` | historical language | 1 | 124 |
| `docs/issues/01-server-exits-immediately.md` | unrelated | 1 | 5 |
| `docs/roadmap/01-roadmap.md` | historical language | 8 | 6, 24, 33, 37, 39, 58, 61, 83 |
| `docs/roadmap/generated.md` | historical language | 8 | 6, 24, 33, 37, 39, 58, 61, 82 |
| `packages/contracts/src/api.ts` | runtime | 3 | 58, 59, 60 |
| `packages/contracts/test/scheduler-projection-contract.test.ts` | runtime | 1 | 14 |
| `plan_verification_status.json` | unrelated | 1 | 42 |
| `scripts/docs-governance-lib.mjs` | tooling | 14 | 117, 214, 216, 217, 218, 220, 228, 232, 242, 253, 254, 255, 271, 274 |
| `scripts/docs-governance.mjs` | tooling | 17 | 207, 209, 213, 214, 215, 217, 285, 289, 290, 292, 295, 296, 297, 298, 300, 306, 310 |
| `scripts/docs-governance.test.mjs` | tooling | 10 | 57, 60, 61, 62, 65, 66, 67, 74, 75, 77 |
| `scripts/plan-collector.test.ts` | tooling | 13 | 6, 31, 42, 44, 49, 50, 51, 52, 53, 55, 57, 62, 63 |
| `scripts/plan-collector.ts` | tooling | 7 | 50, 52, 54, 58, 59, 60, 62 |
| `scripts/plan-parser.integration.test.ts` | tooling | 1 | 16 |
| `scripts/plan-parser.test.ts` | tooling | 1 | 12 |
| `scripts/plan-parser.ts` | tooling | 1 | 8 |
| `scripts/roadmap-generator-cli.mjs` | tooling | 15 | 74, 92, 103, 106, 109, 112, 114, 115, 116, 118, 123, 125, 127, 136, 140 |
| `scripts/roadmap-generator.integration.test.ts` | tooling | 1 | 20 |
| `scripts/roadmap-generator.test.ts` | tooling | 11 | 2, 10, 23, 36, 51, 62, 63, 64, 69, 70, 97 |
| `scripts/roadmap-generator.ts` | tooling | 27 | 10, 27, 34, 35, 61, 98, 102, 103, 104, 106, 109, 110, 111, 112, 114, 116, 120, 126, 127, 132, 136, 137, 138, 153, 158, 223, 227 |
| `workspace/link_analysis.json` | unrelated | 7 | 89, 90, 114, 115, 124, 125, 210 |
| `workspace/task-3-report.txt` | unrelated | 2 | 14, 29 |

## Текущая сверка после правок

Current scan исключает только этот план и сам evidence-файл. `plan-17` включён как обычный Plan; устаревшие `roadmap`/`stage` metadata удалены. Текущая классификация сопоставлена с исходным классом каждого baseline path.

```sh
git grep -inE '[sS][tT][aA][gG][eE]|roadmap[Ss][tT][aA][gG][eE]|grouped[Bb]y[Ss][tT][aA][gG][eE]|groupInto[Ss][tT][aA][gG][eE]|render[Ss]Register|groupBy[Ss][tT][aA][gG][eE]|[sS][tT][aA][gG][eE]sMap' -- . ':(exclude)docs/architecture/plans/governance/00-05-governance-integration.md' ':(exclude)docs/architecture/plans/governance/evidence/06-plan-grouping-removal-inventory.md'
git grep --no-index -inE '[sS][tT][aA][gG][eE]|roadmap[Ss][tT][aA][gG][eE]|grouped[Bb]y[Ss][tT][aA][gG][eE]|groupInto[Ss][tT][aA][gG][eE]|render[Ss]Register|groupBy[Ss][tT][aA][gG][eE]|[sS][tT][aA][gG][eE]sMap' -- scripts/roadmap-generator-cli.test.mjs docs/architecture/plans/governance/merge-decisions.md
```

| Tracked current class, по исходной path-level классификации | Пути | Совпадения |
|---|---:|---:|
| Runtime workflow | 32 | 185 |
| Unrelated | 7 | 25 |
| Historical language | 24 | 165 |
| Tooling (tracked) | 7 | 16 |
| **Historical language + tooling (tracked)** | **31** | **181** |
| **Tracked scan total** | **70** | **391** |

Числа описывают два среза: baseline **636/99**, current tracked scan **391/70**; это не конфликт. Дополнительно проверены новые файлы worktree: в untracked CLI test обнаружены 2 ожидаемых tooling-совпадения, в переименованном `merge-decisions.md` — 0. Полный current worktree snapshot: **393 совпадения / 71 путь**. В нём нет активного дублирующего Plan grouping contract; исторические и tooling-совпадения перечислены ниже по точным текущим строкам.

### Current execution map

Классы у tracked paths унаследованы из baseline path-level inventory выше; `tooling (new)` — regression test из Task 3. `Current lines` получены после регенерации roadmap, исправления Plan 15 и архивного уточнения evidence 05. Трекнутые совпадения воспроизводятся командой на строке 140; untracked файлы проверяются отдельным `git grep --no-index`.

| Path | Class | Hits | Current lines |
|---|---|---:|---|
| `apps/server/src/app/read-models/epic-projection.ts` | runtime | 6 | 19, 30, 38, 39, 43, 48 |
| `apps/server/src/app/read-models/task-projection.ts` | runtime | 1 | 30 |
| `apps/server/src/app/routes/work.ts` | runtime | 2 | 54, 55 |
| `apps/server/src/modules/execution/git-tools.ts` | runtime | 1 | 36 |
| `apps/server/src/modules/planning/epic-orchestrator.ts` | runtime | 21 | 34, 100, 138, 140, 156, 157, 158, 159, 160, 161, 162, 197, 207, 208, 209, 214, 219, 220, 228, 230, 282 |
| `apps/server/src/modules/recovery/progress-fingerprint.ts` | runtime | 7 | 59, 73, 87, 97, 102, 112, 116 |
| `apps/server/src/modules/recovery/recovery-policy.ts` | runtime | 10 | 25, 30, 39, 43, 51, 66, 68, 91, 92, 109 |
| `apps/server/src/modules/recovery/recovery-types.ts` | runtime | 4 | 16, 20, 103, 104 |
| `apps/server/src/modules/runtime/prompt-builder.ts` | runtime | 5 | 33, 88, 204, 262, 306 |
| `apps/server/src/modules/runtime/run-event-handlers.ts` | runtime | 15 | 153, 154, 159, 163, 164, 166, 188, 193, 197, 199, 201, 259, 260, 261, 297 |
| `apps/server/src/modules/runtime/run-orchestrator.ts` | runtime | 1 | 23 |
| `apps/server/src/modules/workflow/templates.ts` | runtime | 7 | 4, 23, 134, 170, 176, 277, 323 |
| `apps/server/src/modules/workflow/workflow-engine.ts` | runtime | 5 | 138, 140, 184, 186, 187 |
| `apps/server/src/modules/workflow/workflow-types.ts` | runtime | 2 | 35, 36 |
| `apps/server/src/platform/database/migrations/011_epic_orchestration.sql` | runtime | 1 | 7 |
| `apps/server/test/e2e/autonomous-task.hermes.test.ts` | runtime | 1 | 50 |
| `apps/server/test/e2e/epic.fake-runtime.test.ts` | runtime | 1 | 189 |
| `apps/server/test/e2e/v1-autonomous-task.test.ts` | runtime | 5 | 381, 419, 421, 442, 477 |
| `apps/server/test/e2e/v1-epic.test.ts` | runtime | 6 | 392, 393, 396, 439, 440, 443 |
| `apps/server/test/modules/context/context-builder.test.ts` | runtime | 4 | 361, 373, 377, 378 |
| `apps/server/test/modules/execution/git-tools.test.ts` | runtime | 4 | 59, 73, 82, 83 |
| `apps/server/test/modules/recovery/recovery.test.ts` | runtime | 5 | 51, 59, 249, 261, 273 |
| `apps/server/test/modules/workflow/workflow-engine.test.ts` | runtime | 15 | 256, 258, 261, 266, 338, 341, 344, 348, 351, 354, 358, 361, 364, 374, 385 |
| `apps/server/test/scenarios/standalone-task.fake-runtime.test.ts` | runtime | 9 | 270, 284, 288, 291, 301, 303, 307, 323, 327 |
| `apps/web/src/components/WorkflowTimeline.tsx` | runtime | 18 | 4, 5, 9, 16, 28, 44, 45, 46, 47, 48, 49, 50, 51, 56, 57, 61, 62, 66 |
| `apps/web/src/features/epics/EpicPage.tsx` | runtime | 2 | 7, 34 |
| `apps/web/src/features/tasks/TaskPage.tsx` | runtime | 2 | 6, 36 |
| `apps/web/src/i18n/ru.ts` | runtime | 3 | 71, 105, 107 |
| `apps/web/test/core-views.test.tsx` | runtime | 17 | 12, 33, 34, 37, 38, 168, 184, 200, 217, 346, 349, 370, 385, 400, 403, 415, 416 |
| `apps/web/test/localization-accessibility.test.tsx` | runtime | 1 | 85 |
| `artifacts/task-10-fix-report.md` | unrelated | 1 | 23 |
| `docs/architecture/plans/02-domain-workflow-scheduler.md` | historical language | 2 | 35, 182 |
| `docs/architecture/plans/07-hermes-development-workflow.md` | historical language | 2 | 995, 1206 |
| `docs/architecture/plans/08-01-web-ui-foundation.md` | historical language | 7 | 21, 23, 29, 98, 102, 105, 111 |
| `docs/architecture/plans/08-02-web-ui-core-functional.md` | historical language | 2 | 20, 45 |
| `docs/architecture/plans/08-03-web-ui-operational-and-e2e.md` | historical language | 3 | 19, 21, 72 |
| `docs/architecture/plans/08-04-web-ui-audit-and-recovery-design.md` | historical language | 7 | 18, 22, 364, 428, 441, 490, 499 |
| `docs/architecture/plans/13-roadmap-generator.md` | historical language | 1 | 17 |
| `docs/architecture/plans/14-docker-runtime.md` | historical language | 11 | 94, 99, 155, 352, 464, 466, 475, 481, 485, 707, 710 |
| `docs/architecture/plans/15-07-russian-ui-and-artifact-cleanup.md` | historical language | 2 | 89, 103 |
| `docs/architecture/plans/15-08-verification-and-review.md` | historical language | 9 | 46, 66, 75, 81, 85, 86, 91, 101, 102 |
| `docs/architecture/plans/16-documentation-cleanup-and-refresh.md` | historical language | 13 | 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153 |
| `docs/architecture/plans/governance/00-01-documentation-governance.md` | historical language | 45 | 16, 79, 80, 83, 93, 97, 173, 258, 261, 280, 281, 318, 328, 387, 394, 399, 414, 416, 466, 483, 501, 530, 538, 571, 582, 583, 594, 609, 625, 687, 719, 822, 860, 875, 876, 877, 878, 879, 880, 881, 972, 985, 1029, 1048, 1049 |
| `docs/architecture/plans/governance/evidence/01-baseline.md` | historical language | 3 | 52, 53, 76 |
| `docs/architecture/plans/governance/evidence/02-progress-ledger.md` | historical language | 1 | 33 |
| `docs/architecture/plans/governance/evidence/03-document-migration-map.md` | historical language | 6 | 32, 102, 112, 238, 255, 256 |
| `docs/architecture/plans/governance/evidence/05-plan-15-roadmap-reconciliation.md` | historical language | 13 | 20, 116, 127, 225, 263, 307, 399, 436, 473, 519, 617, 651, 656 |
| `docs/architecture/reference-ui/02-task-view-concept.html` | unrelated | 7 | 34, 35, 104, 105, 106, 107, 108 |
| `docs/architecture/reference-ui/03-epic-view-concept.html` | unrelated | 8 | 34, 35, 111, 112, 113, 114, 115, 116 |
| `docs/architecture/specs/01-system-design.md` | historical language | 12 | 468, 1609, 1613, 1617, 1621, 1625, 1629, 1633, 1646, 1650, 1654, 1722 |
| `docs/architecture/specs/02-web-ui-recovery-design.md` | historical language | 3 | 17, 152, 302 |
| `docs/architecture/specs/04-hermes-development-capabilities.md` | historical language | 1 | 32 |
| `docs/audit/01-full-audit.md` | historical language | 7 | 16, 36, 507, 509, 516, 1147, 1243 |
| `docs/audit/04-final-audit.md` | historical language | 3 | 495, 1315, 1317 |
| `docs/audit/07-project-state.md` | historical language | 7 | 141, 151, 153, 164, 200, 217, 218 |
| `docs/audit/09-web-ui-gap-analysis.md` | historical language | 3 | 13, 131, 155 |
| `docs/development/02-documentation-governance.md` | historical language | 2 | 23, 50 |
| `docs/issues/01-server-exits-immediately.md` | unrelated | 1 | 5 |
| `packages/contracts/src/api.ts` | runtime | 3 | 58, 59, 60 |
| `packages/contracts/test/scheduler-projection-contract.test.ts` | runtime | 1 | 14 |
| `plan_verification_status.json` | unrelated | 1 | 42 |
| `scripts/docs-governance-lib.mjs` | tooling | 1 | 108 |
| `scripts/docs-governance.test.mjs` | tooling | 7 | 44, 49, 62, 97, 106, 145, 175 |
| `scripts/plan-collector.test.ts` | tooling | 2 | 24, 25 |
| `scripts/plan-parser.integration.test.ts` | tooling | 1 | 35 |
| `scripts/plan-parser.test.ts` | tooling | 1 | 51 |
| `scripts/roadmap-generator.integration.test.ts` | tooling | 2 | 42, 53 |
| `scripts/roadmap-generator.test.ts` | tooling | 2 | 47, 92 |
| `workspace/link_analysis.json` | unrelated | 5 | 89, 90, 114, 115, 124 |
| `workspace/task-3-report.txt` | unrelated | 2 | 14, 29 |
| `scripts/roadmap-generator-cli.test.mjs` | tooling (new, untracked) | 2 | 36, 62 |

### Filename reconciliation

Baseline tracked-path scan: `docs/architecture/plans/governance/08-stage-01-merge-decisions.md` and the historical root artifact `stage-a-implementation.json`. The root artifact was archived and removed by Plan-16 because it had no current consumer; the canonical governance evidence remains under `docs/architecture/plans/governance/evidence/`. Plan 17 is included as a normal Plan and has no retired grouping metadata.

## Классификация и rationale

- **Historical language:** плановые/roadmap упоминания и дублирующая grouping-формулировка; сохранение дат, статусов и результатов защищает исторический контекст. Task 4 — только исходная baseline-классификация, не открытое действие; current итог приведён выше и в reconciliation.
- **Tooling:** прежние parser/collector/governance/roadmap grouping contracts и тесты, не runtime state. Исходное ownership: Task 2 — metadata/parser/collector; Task 3 — governance и roadmap tooling.
- **Runtime:** lifecycle/workflow/recovery state, UI, контракты и тесты; не относить к plan grouping.
- **Unrelated:** regexp false positives; без независимого подтверждения связи не менять.

## Сохраняемое evidence Task 1

- `pnpm docs:inventory`: 67 файлов до создания этого evidence; 68 после создания.
- Baseline арифметика: 60 historical/tooling + 32 runtime + 7 unrelated = 99 путей; 424 + 185 + 27 = 636 совпадений. Точные записи приведены полностью выше.
- Schema-named database migrations/runtime schema относятся к runtime database, не к плановой metadata schema.
- README skills baseline: перечислено 8 из 11 embedded requirements; отсутствовали `ebb-write-plan`, `ebb-review-plan`, `ebb-debug-issue`. Это историческая заметка, не действие этой сверки.
