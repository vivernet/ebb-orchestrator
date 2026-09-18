# Ebb Orchestrator — Documentation

## Структура документации

### Архитектура (`architecture/`)

#### **specs/** — Официальные спецификации
- [ebb-orchestrator-design.md](architecture/specs/2026-09-16-ebb-orchestrator-design.md) — Основная архитектурная спецификация (source of truth)
- [foundation-persistence.md](architecture/specs/2026-09-16-ebb-orchestrator-foundation-persistence.md) — Persistence и migrations
- [git-execution-security.md](architecture/specs/2026-09-16-ebb-orchestrator-git-execution-security.md) — Git и security
- [domain-workflow-scheduler.md](architecture/specs/2026-09-16-ebb-orchestrator-domain-workflow-scheduler.md) — Workflow и Scheduler
- [planning-epics-context-knowledge.md](architecture/specs/2026-09-16-ebb-orchestrator-planning-epics-context-knowledge.md) — Planning и Epic semantics
- [web-github-release.md](architecture/specs/2026-09-16-ebb-orchestrator-web-github-release.md) — Web UI и GitHub integration
- [v1-roadmap.md](architecture/specs/2026-09-16-ebb-orchestrator-v1-roadmap.md) — V1 roadmap
- [final-v1-audit-hardening.md](architecture/specs/2026-09-16-ebb-orchestrator-final-v1-audit-hardening.md) — Audit hardening plan

#### **plans/** — Планы реализации
- [v1-roadmap.md](architecture/plans/2026-09-16-ebb-orchestrator-v1-roadmap.md) — V1 roadmap (дубликат из specs)
- [domain-workflow-scheduler.md](architecture/plans/2026-09-16-ebb-orchestrator-domain-workflow-scheduler.md)
- [foundation-persistence.md](architecture/plans/2026-09-16-ebb-orchestrator-foundation-persistence.md)
- [git-execution-security.md](architecture/plans/2026-09-16-ebb-orchestrator-git-execution-security.md)
- [hermes-autonomous-task.md](architecture/plans/2026-09-16-ebb-orchestrator-hermes-autonomous-task.md)
- [planning-epics-context-knowledge.md](architecture/plans/2026-09-16-ebb-orchestrator-planning-epics-context-knowledge.md)
- [web-github-release.md](architecture/plans/2026-09-16-ebb-orchestrator-web-github-release.md)
- [final-v1-audit-hardening.md](architecture/plans/2026-09-16-ebb-orchestrator-final-v1-audit-hardening.md)
- [agents-policy-review.md](architecture/plans/2026-09-17-ebb-orchestrator-agents-policy-review.md)
- [russian-jsdoc-readme.md](architecture/plans/2026-09-17-ebb-orchestrator-russian-jsdoc-readme.md)

#### **reference-ui/** — Концепты интерфейса
- dashboard-concept.html
- task-view-concept.html
- epic-view-concept.html
- approval-inbox-concept.html
- execution-queue-concept.html
- project-view-concept.html
- project-onboarding-concept.html
- settings-concept.html
- usage-budget-concept.html
- agent-run-detail-concept.html

### Аудит (`audit/`)

- [2026-09-18-audit-report.md](audit/2026-09-18-audit-report.md) — Финальный отчёт аудита
- [2026-09-18-audit-guidelines.md](audit/2026-09-18-audit-guidelines.md) — Руководство по аудиту
- [2026-09-18-full-audit.md](audit/2026-09-18-full-audit.md) — Полное руководство по аудиту
- [final-audit.md](audit/final-audit.md) — Execution план финального аудита
- [PROJECT_STATE.md](audit/PROJECT_STATE.md) — Текущее состояние проекта

### Разработка (`development/`)

- [jsdoc-style-guide.md](development/jsdoc-style-guide.md) — Gайдлайн JSDoc комментариев
- [jsdoc-execution-ledger.md](development/jsdoc-execution-ledger.md) — Ledger выполнения JSDoc требований
- [architecture-review-2026-09-18.md](development/architecture-review-2026-09-18.md) — Review архитектуры

### Дорожная карта (`roadmap/`)

- [post-v1.md](roadmap/post-v1.md) — Планы после v1

---

## Важные примечания

1. **Архитектурный source of truth** — `architecture/specs/2026-09-16-ebb-orchestrator-design.md`
2. **JSDoc политика** — Все production комментарии на русском языке согласно `development/jsdoc-style-guide.md`
3. **Git policy** — Master ветка, feature work в отдельных worktrees
4. **Quality gate** — Обязательный lint, typecheck, test перед commit
