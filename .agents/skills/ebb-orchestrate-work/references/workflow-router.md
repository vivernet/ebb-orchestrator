# Ebb workflow router

| Сигнал | Основной skill | Следующая стадия |
|---|---|---|
| Неясные требования / новая архитектура | `ebb-design-change` | approved design → `ebb-write-plan` |
| Approved multi-task change | `ebb-write-plan` | `ebb-review-plan` |
| Approved executable plan | `ebb-execute-plan` | gates → final review |
| Одна bounded task | `ebb-implement-task` | task review |
| Ошибка / failing test / build | `ebb-debug-issue` | bounded fix или plan |
| Несколько независимых доменов | `ebb-dispatch-agents` | synthesis / execute |
| Cleanup/move/rename/docs structure/setup tooling | `ebb-repository-maintenance` | plan или focused implementation |
| Root/nested README/.env.example content; affected setup/config/API/commands | `ebb-maintain-project-docs` | changed-scope sync evidence → task/gates/finish/release prerequisites |
| Schema/migrations/persisted data/transactions/DB lifecycle | `ebb-database-engineering` | domain constraints → primary workflow/gates |
| Trust boundary/auth/secrets/process | `ebb-security-review` | finding fixes / gates |
| Browser-visible HTTP/session/SSE | `ebb-web-e2e` | gates |
| Completion claim | `ebb-quality-gates` | final review / report |
| Whole-change readiness | `ebb-final-review` | fix or finish branch |
| Branch/PR integration | `ebb-finish-branch` | authorized PR squash develop → post-integration gates |
| Explicit user invocation ebb-release (release/hotfix/rollback/resume/status) | `ebb-release` | exact operation policy/tools/evidence → concrete confirmation |
| Заметки/предложения пользователя | `ebb-notes` | планирование / регистрация |
| Skill authoring/curation | `ebb-curate-skills` | validation + migration map |

Database/security/Web rows — domain overlays: они не заменяют design/plan/implementation workflow, а добавляют specialist invariants/evidence к нему.

Docs content overlay автоматически работает на affected owner/consumer closure и не становится full audit без явного запроса. File restructuring/move/delete остаётся в maintenance. Release — manual-only route; completion, PR/merge/CI никогда не запускают его. Ordinary task base/target — develop, integration — PR squash; master — только release commits и absent при zero releases. Existing legacy master transition отдельно в Plan26 после preservation/default-branch checks; запрещены baseline/dummy/restore/archive commits. Task approved SHA, integrated source SHA и candidate metadata — разные identity roles.

## Stop conditions

Остановись и запроси решение только когда дальнейший шаг требует: необратимого destructive action; security-sensitive policy choice; push/merge/publish/другого side effect за пределами рабочего scope; либо plan/design настолько противоречив, что любой путь — догадка.
