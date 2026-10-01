# Ebb workflow router

| Сигнал | Основной skill | Следующая стадия |
|---|---|---|
| Неясные требования / новая архитектура | `ebb-design-change` | approved design → `ebb-write-plan` |
| Approved multi-task change | `ebb-write-plan` | `ebb-review-plan` |
| Approved executable plan | `ebb-execute-plan` | gates → final review |
| Одна bounded task | `ebb-implement-task` | task review |
| Ошибка / failing test / build | `ebb-debug-issue` | bounded fix или plan |
| Несколько независимых доменов | `ebb-dispatch-agents` | synthesis / execute |
| Cleanup/move/setup/docs | `ebb-repository-maintenance` | plan или focused implementation |
| Schema/migrations/persisted data/transactions/DB lifecycle | `ebb-database-engineering` | domain constraints → primary workflow/gates |
| Trust boundary/auth/secrets/process | `ebb-security-review` | finding fixes / gates |
| Browser-visible HTTP/session/SSE | `ebb-web-e2e` | gates |
| Completion claim | `ebb-quality-gates` | final review / report |
| Whole-change readiness | `ebb-final-review` | fix or finish branch |
| Branch/PR integration | `ebb-finish-branch` | user/pipeline decision |
| Skill authoring/curation | `ebb-curate-skills` | validation + migration map |

Database/security/Web rows — domain overlays: они не заменяют design/plan/implementation workflow, а добавляют specialist invariants/evidence к нему.

## Stop conditions

Остановись и запроси решение только когда дальнейший шаг требует: необратимого destructive action; security-sensitive policy choice; push/merge/publish/другого side effect за пределами рабочего scope; либо plan/design настолько противоречив, что любой путь — догадка.
