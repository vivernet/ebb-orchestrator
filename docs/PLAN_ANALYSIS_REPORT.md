# Анализ планов и исправлений

## Идентификация проблем

### 1. Дубликаты в нумерации

| Файл | ID | Stage | Проблема |
|------|-----|-------|----------|
| `docs/architecture/plans/03-git-execution-security.md` | `plan-03` | `03` | Базовый план 03 |
| `docs/architecture/plans/03-russian-jsdoc-readme.md` | `plan-03-jsdoc` | `03` | **Дубликат номера** |
| `docs/architecture/plans/04-hermes-autonomous-task.md` | `plan-04` | `04` | Базовый план 04 |
| `docs/architecture/plans/04-next-stages-roadmap.md` | `plan-04-next` | `04` | **Дубликат номера** |
| `docs/architecture/plans/07-hermes-development-workflow.md` | `plan-07` | `07` | Базовый план 07 |
| `docs/architecture/plans/07-web-ui-recovery-task-ledger.md` | `plan-07-ledger` | `07` | **Дубликат номера** |
| `docs/architecture/plans/08-01-web-ui-foundation.md` | `plan-08-01` | `08` | Подплан 08-01 |
| `docs/architecture/plans/08-02-web-ui-core-functional.md` | `plan-08-02` | `08` | Подплан 08-02 |
| `docs/architecture/plans/08-03-web-ui-operational-and-e2e.md` | `plan-08-03` | `08` | Подплан 08-03 |
| `docs/architecture/plans/08-04-web-ui-audit-and-recovery-design.md` | `plan-08-04` | `08` | Подплан 08-04 |

### 2. Планам, которые должны быть завершены но имеют `status=in_progress`

| Файл | Текущий статус | Ожидаемый статус | Примечание |
|------|----------------|------------------|------------|
| `docs/architecture/plans/01-foundation-persistence.md` | `in_progress` | `completed` | Стартовый план, вероятно завершён |
| `docs/architecture/plans/02-domain-workflow-scheduler.md` | `in_progress` | `completed` | План 02 |
| `docs/architecture/plans/03-git-execution-security.md` | `in_progress` | `completed` | План 03 |
| `docs/architecture/plans/04-hermes-autonomous-task.md` | `in_progress` | `completed` | План 04 |
| `docs/architecture/plans/05-planning-epics-context-knowledge.md` | `in_progress` | `completed` | План 05 |
| `docs/architecture/plans/06-web-github-release.md` | `in_progress` | `completed` | План 06 |
| `docs/architecture/plans/07-hermes-development-workflow.md` | `in_progress` | `completed` | План 07 |
| `docs/architecture/plans/09-production-readiness.md` | `in_progress` | `completed` | План 09 |
| `docs/architecture/plans/11-hermes-development-capabilities.md` | `in_progress` | `completed` | План 11 |

### 3. Superseded планы, которые стоит удалить или переместить

| Файл | ID | Статус | Действие |
|------|-----|--------|----------|
| `docs/architecture/plans/03-russian-jsdoc-readme.md` | `plan-03-jsdoc` | `superseded` | Удалить |
| `docs/architecture/plans/04-next-stages-roadmap.md` | `plan-04-next` | `superseded` | Удалить |
| `docs/architecture/plans/07-web-ui-recovery-task-ledger.md` | `plan-07-ledger` | `superseded` | Удалить |
| `docs/architecture/plans/08-01-web-ui-foundation.md` | `plan-08-01` | `superseded` | Удалить |
| `docs/architecture/plans/08-02-web-ui-core-functional.md` | `plan-08-02` | `superseded` | Удалить |
| `docs/architecture/plans/08-03-web-ui-operational-and-e2e.md` | `plan-08-03` | `superseded` | Удалить |
| `docs/architecture/plans/08-04-web-ui-audit-and-recovery-design.md` | `plan-08-04` | `superseded` | Удалить |
| `docs/architecture/plans/10-final-audit-hardening.md` | `plan-10` | `superseded` | Удалить |
| `docs/architecture/plans/12-hermes-development-workflow-parity.md` | `plan-12` | `superseded` | Удалить (переместить в `docs/audit/`) |

### 4. Непоследовательность в frontmatter

| Файл | Проблема |
|------|----------|
| `docs/architecture/plans/03-russian-jsdoc-readme.md` | Отсутствуют `kind`, `roadmap`, `stage` в frontmatter |
| `docs/architecture/plans/04-next-stages-roadmap.md` | Отсутствуют `kind`, `roadmap`, `stage` |
| `docs/architecture/plans/07-web-ui-recovery-task-ledger.md` | Отсутствуют `kind`, `roadmap`, `stage` |
| `docs/architecture/plans/08-01-web-ui-foundation.md` | Отсутствуют `kind`, `roadmap`, `stage` |
| `docs/architecture/plans/08-02-web-ui-core-functional.md` | Отсутствуют `kind`, `roadmap`, `stage` |
| `docs/architecture/plans/08-03-web-ui-operational-and-e2e.md` | Отсутствуют `kind`, `roadmap`, `stage` |
| `docs/architecture/plans/08-04-web-ui-audit-and-recovery-design.md` | Отсутствуют `kind`, `roadmap`, `stage` |
| `docs/architecture/plans/10-final-audit-hardening.md` | Отсутствуют `kind`, `roadmap`, `stage` |
| `docs/architecture/plans/12-hermes-development-workflow-parity.md` | Отсутствуют `kind`, `roadmap`, `stage`, `id` |

### 5. Дубликаты в `docs/development/`

| Файл | ID | Проблема |
|------|-----|----------|
| `docs/development/01-documentation-governance.md` | `guideline-01` | Дубликат с `docs/development/02-documentation-governance.md` |
| `docs/development/02-documentation-governance.md` | `guideline-02` | Основной файл правил |

### 6. Непоследовательность в `docs/audit/`

| Файл | ID | Статус |
|------|-----|--------|
| `docs/audit/01-full-audit.md` | `audit-01` | `superseded` |
| `docs/audit/02-audit-report.md` | `audit-02` | `superseded` |
| `docs/audit/03-audit-guidelines.md` | - | Нет ID |
| `docs/audit/04-final-audit.md` | - | Нет ID |
| `docs/audit/05-hermes-development-workflow-parity.md` | `audit-05` | `superseded` |
| `docs/audit/06-opencode-to-hermes-inventory.md` | - | Нет ID |
| `docs/audit/07-project-state.md` | `audit-07` | `superseded` |
| `docs/audit/08-web-ui-code-map.md` | - | Нет ID |
| `docs/audit/09-web-ui-gap-analysis.md` | - | Нет ID |

## Исправления

### Шаг 1: Удалить superseded планы из `docs/architecture/plans/`

```bash
# Удалить файлы-дубликаты и superseded планы
rm docs/architecture/plans/03-russian-jsdoc-readme.md
rm docs/architecture/plans/04-next-stages-roadmap.md
rm docs/architecture/plans/07-web-ui-recovery-task-ledger.md
rm docs/architecture/plans/08-01-web-ui-foundation.md
rm docs/architecture/plans/08-02-web-ui-core-functional.md
rm docs/architecture/plans/08-03-web-ui-operational-and-e2e.md
rm docs/architecture/plans/08-04-web-ui-audit-and-recovery-design.md
rm docs/architecture/plans/10-final-audit-hardening.md
```

### Шаг 2: Обновить статусы планов

Для каждого плана `01-09` и `11` установить `status: completed` в frontmatter.

### Шаг 3: Исправить дубликаты в `docs/development/`

Сохранить только `02-documentation-governance.md` (более полный вариант).

### Шаг 4: Добавить пропущенные ID в `docs/audit/`

Добавить пропущенные `id` поля в audit-файлы без ID.

## Список исправлений для каждого файла

| Файл | Действие |
|------|----------|
| `docs/architecture/plans/01-foundation-persistence.md` | Установить `status: completed` |
| `docs/architecture/plans/02-domain-workflow-scheduler.md` | Установить `status: completed` |
| `docs/architecture/plans/03-git-execution-security.md` | Установить `status: completed` |
| `docs/architecture/plans/04-hermes-autonomous-task.md` | Установить `status: completed` |
| `docs/architecture/plans/05-planning-epics-context-knowledge.md` | Установить `status: completed` |
| `docs/architecture/plans/06-web-github-release.md` | Установить `status: completed` |
| `docs/architecture/plans/07-hermes-development-workflow.md` | Установить `status: completed` |
| `docs/architecture/plans/09-production-readiness.md` | Установить `status: completed` |
| `docs/architecture/plans/11-hermes-development-capabilities.md` | Установить `status: completed` |
| `docs/architecture/plans/03-russian-jsdoc-readme.md` | Удалить |
| `docs/architecture/plans/04-next-stages-roadmap.md` | Удалить |
| `docs/architecture/plans/07-web-ui-recovery-task-ledger.md` | Удалить |
| `docs/architecture/plans/08-01-web-ui-foundation.md` | Удалить |
| `docs/architecture/plans/08-02-web-ui-core-functional.md` | Удалить |
| `docs/architecture/plans/08-03-web-ui-operational-and-e2e.md` | Удалить |
| `docs/architecture/plans/08-04-web-ui-audit-and-recovery-design.md` | Удалить |
| `docs/architecture/plans/10-final-audit-hardening.md` | Удалить |
| `docs/architecture/plans/12-hermes-development-workflow-parity.md` | Удалить |
| `docs/development/01-documentation-governance.md` | Удалить (дубликат) |
| `docs/audit/03-audit-guidelines.md` | Добавить `id: audit-03` |
| `docs/audit/04-final-audit.md` | Добавить `id: audit-04` |
| `docs/audit/06-opencode-to-hermes-inventory.md` | Добавить `id: audit-06` |
| `docs/audit/08-web-ui-code-map.md` | Добавить `id: audit-08` |
| `docs/audit/09-web-ui-gap-analysis.md` | Добавить `id: audit-09` |
