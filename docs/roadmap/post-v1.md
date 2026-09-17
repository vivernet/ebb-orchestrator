# Ebb Orchestrator — Post-v1 Roadmap

Этот документ фиксирует направления, которые были сознательно оставлены за пределами первой версии Ebb Orchestrator.

Он не является разрешением реализовывать перечисленные возможности без отдельного design/proposal/approval.

## Статус документа

- v1 scope уже определён отдельной design specification и implementation plans.
- Пункты ниже — кандидаты для следующих milestones.
- Приоритет и точный порядок должны определяться отдельным planning cycle после стабилизации v1.

## 1. Дополнительные Agent Runtime

v1 использует Hermes Runtime.

После v1 могут быть добавлены дополнительные adapters:

- Codex Runtime;
- OpenCode Runtime;
- другие совместимые agent runtimes.

Core domain не должен становиться зависимым от конкретного runtime.

## 2. Усиленная execution isolation

Local Mode остаётся policy isolation и не является OS sandbox.

Post-v1 направление:

- Container Mode;
- изоляция filesystem/process/network;
- resource quotas;
- sandbox lifecycle;
- per-run container policies.

## 3. Распределённое выполнение

v1 local-first и single-machine.

Возможные следующие этапы:

- remote workers;
- distributed scheduler;
- durable worker leases;
- remote execution pools;
- horizontal scaling.

## 4. Multi-user / Team mode

Возможные направления:

- несколько пользователей;
- RBAC;
- shared projects;
- team approvals;
- audit identities;
- organization-level policies.

## 5. Дополнительные Git hosting providers

Помимо GitHub:

- GitLab;
- Bitbucket;
- другие providers через GitHosting port.

## 6. Внешние planning / issue systems

Возможные integrations:

- Linear;
- Jira;
- другие project-management systems.

Они не должны становиться authoritative workflow engine вместо Ebb Orchestrator.

## 7. Расширенная knowledge/context система

Возможные направления:

- full semantic project index;
- vector search;
- richer retrieval;
- cross-project knowledge;
- более развитая долгосрочная context model.

При этом deterministic context selection должен сохраняться там, где возможен.

## 8. Nested planning structures

v1 ограничивается Project → Epic → Task.

Post-v1 можно отдельно рассмотреть:

- nested Epics;
- дополнительные planning levels;
- cross-project dependency graphs.

Это требует отдельного domain design.

## 9. Расширенные workflow templates

После стабилизации v1:

- дополнительные workflow types;
- configurable organization policies;
- reusable workflow packs;
- более гибкие approval matrices.

Нельзя превращать configurable workflow в произвольное выполнение без deterministic validation.

## 10. OpenSpec integration

Отдельный возможный milestone:

- `SpecificationProvider` port;
- OpenSpec adapter;
- proposal/spec/design/tasks import;
- mapping spec tasks → Orchestrator Tasks;
- validation gate;
- approval integration;
- QA mapping к scenarios;
- archive after merge;
- drift detection.

OpenSpec должен быть specification layer, а не вторым workflow engine.

Распределение ответственности:

```text
OpenSpec:
WHAT / WHY / design-level HOW

Ebb Orchestrator:
WHO / WHEN / STATE / EXECUTION / RECOVERY / PERMISSIONS
```

## 11. Enterprise observability

Возможные направления:

- advanced usage analytics;
- monitoring;
- traces;
- operational dashboards;
- policy analytics;
- organization-level budgets;
- configurable routing policies.

## 12. Autonomous deployment / production operations

Не входит в v1.

Перед добавлением потребуется отдельный security/design cycle для:

- deployment approvals;
- environment boundaries;
- secret management;
- rollback;
- production access;
- blast-radius controls.

## 13. Advanced model/runtime routing

v1 не использует dynamic autonomous model router.

После v1 можно рассмотреть:

- policy-based model selection;
- task complexity classification;
- cost/latency/quality routing;
- provider/runtime fallback.

Deterministic budget/security rules должны иметь приоритет над model-driven routing.

## 14. Extended integrations

После появления стабильного integration framework могут рассматриваться:

- additional SCM;
- chat/notification systems;
- CI/CD systems;
- artifact registries;
- enterprise identity systems.

## 15. Productization

После стабилизации core:

- installer/distribution;
- update channel;
- migration/upgrade UX;
- richer onboarding;
- diagnostics bundle;
- plugin ecosystem.

## Правило изменения roadmap

Любой пункт из этого документа перед реализацией проходит:

1. отдельное уточнение цели;
2. design;
3. impact analysis;
4. пользовательское approval;
5. implementation plan;
6. isolated implementation branch/worktree;
7. quality/review gates.

Roadmap не имеет права сам по себе расширять активный scope.
