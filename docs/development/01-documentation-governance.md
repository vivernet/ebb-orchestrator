---
id: guideline-02
kind: development
title: Documentation Governance — Naming Policy & Glossary
created: 2026-09-23
updated: 2026-09-23
status: in_progress
---

# Documentation Governance — Naming Policy & Glossary

**Версия:** 1.0  
**Дата утверждения:** 2026-09-23

---

## 1. Glossary терминов

| Term | Значение | Разрешённое расположение | Запрещённое использование |
|------|----------|--------------------------|----------------------------|
| **Stage** | Глобальный исполняемый этап разработки | Заголовки документов, metadata `stage` | Phase, буквенные Stage A–F |
| **Plan** | Конкретный исполняемый документ | `docs/architecture/plans/` | В specs/roadmap без metadata |
| **Spec** | Утверждённая архитектурная спецификация (source of truth) | `docs/architecture/specs/` | В plans/ без решения |
| **Roadmap** | Единый агрегатор циклов планирования | `docs/roadmap/01-roadmap.md` | Отдельные v1-roadmap, post-v1.md |
| **Audit** | Инстинный snapshot состояния проекта | `docs/audit/` | Как источник текущего статуса |
| **Proposal** | Неутверждённое направление работы | `docs/roadmap/` или `docs/architecture/plans/` | Как активный план |
| **Guideline** | Правило процесса или кодирования | `docs/development/` | В specs/ |
| **Ledger** | Фактографическая запись выполнения | `docs/development/` или `docs/audit/` | Как план реализации |
| **Reference** | Справочный/визуальный материал | `docs/architecture/reference/ui/` | Как source of truth |

---

## 2. Правила нумерации filenames

### 2.1 Структура filename

```
{NUMERO}_{DESCRIPTION}.md
```

- **NUMERO**: фиксированная ширина 2 цифры (`00`, `01`, `02`, …)
- **DESCRIPTION**: kebab-case, описывает суть документа

### 2.2 Основные правила

| № | Правило | Пример ✓ | Пример ✗ |
|---|---------|----------|----------|
| 1 | **Stage не сбрасывается** — глобальная нумерация | `01-foundation.md`, `02-workflow.md` | `01-*.`, `01-...` (в новом цикле) |
| 2 | **Plan может быть дочерним** | `08-01-web-ui-foundation.md` | `08_w_ui.md` |
| 3 | **Roadmap — один файл** | `01-roadmap.md` | `v1-roadmap.md`, `post-v1.md` |
| 4 | **Phase не используется** | `Stage 01` в заголовках | `Phase 1` |
| 5 | **v1/post-v1/next/current запрещены в filename** | `01-roadmap.md` | `post-v1.md`, `next-stages.md` |
| 6 | **Дата только в metadata** | `created: 2026-09-16` в YAML | `2026-09-16-foundation.md` |
| 7 | **Historical audit — номер каталога** | `01-full-audit.md` | `2026-09-18-audit.md` |
| 8 | **00 — только governance/meta** | `00-01-documentation-governance.md` | `01-foundation.md` |
| 9 | **POSIX-relative ссылки** | `../specs/01-system-design.md` | `docs/architecture/specs/01-system-design.md` |
| 10 | **Один тип = один canonical source** | `docs/roadmap/01-roadmap.md` | Дубликаты в specs/ и plans/ |

### 2.3 Примеры правильных/неправильных filenames

**✓ Правильно:**
- `docs/architecture/plans/00-01-documentation-governance.md`
- `docs/architecture/plans/01-foundation-persistence.md`
- `docs/architecture/specs/01-system-design.md`
- `docs/roadmap/01-roadmap.md`
- `docs/audit/01-full-audit.md`

**✗ Неправильно:**
- `docs/architecture/plans/2026-09-16-foundation.md` (дата в filename)
- `docs/architecture/specs/01-system-design.md` (дата в filename)
- `docs/architecture/plans/01-v1-roadmap.md` (v1 в filename)
- `docs/roadmap/post-v1.md` (post-v1 как отдельный файл)
- `docs/architecture/plans/Phase-1-foundation.md` (Phase в filename)

---

## 3. Metadata Schema

### 3.1 Обязательные поля

```yaml
---
id: plan-01
kind: plan
roadmap: 01
stage: 01
status: completed
title: Foundation & Persistence
created: 2026-09-16
updated: 2026-09-23
---
```

### 3.2 Допустимые значения

| Поле | Допустимые значения |
|------|---------------------|
| `id` | `^(roadmap|spec|plan|audit|proposal|guideline|ledger|reference|index)-[0-9]{2}(-[0-9]{2})?$` |
| `kind` | `roadmap`, `spec`, `plan`, `audit`, `proposal`, `guideline`, `ledger`, `reference`, `index` |
| `status` | `proposed`, `planned`, `in_progress`, `blocked`, `completed`, `superseded`, `cancelled` |
| `roadmap` | `01`, `02`, … (две цифры) |
| `stage` | `01`, `02`, … (две цифры) |
| `created`/`updated` | ISO format `YYYY-MM-DD` |

### 3.3 Опциональные поля

```yaml
depends_on:
  - plan-01
  - spec-02
specs:
  - ../specs/01-system-design.md
evidence:
  - ../audit/01-full-audit.md
summary: Краткое описание результата документа
```

---

## 4. Validator Rules

### 4.1 Проверки `docs:check`

| Правило | Ошибка |
|---------|--------|
| Filename без числового prefix | `✗ Missing numeric prefix in filename` |
| Prefix не фиксированной ширины | `✗ Invalid prefix width (must be 2 digits)` |
| Дата в filename | `✗ Date found in filename (use metadata instead)` |
| `v1`, `post-v1`, `next` в filename | `✗ Forbidden term in filename` |
| `Phase` в заголовках | `✗ Use 'Stage' instead of 'Phase'` |
| Буквенные Stage A–F | `✗ Use numeric Stage (01, 02, …)` |
| Дубликаты roadmap | `✗ Multiple active roadmap files found` |
| Ссылки на несуществующие файлы | `✗ Broken link: {path}` |
| ID не соответствует схеме | `✗ Invalid ID format: {id}` |
| Kind не в enum | `✗ Invalid kind: {kind}` |
| Статус не в enum | `✗ Invalid status: {status}` |

### 4.2 Правила миграции

| Старый паттерн | Новый canonical |
|----------------|-----------------|
| `01-system-design.md` | `01-system-design.md` |
| `2026-09-16-v1-roadmap.md` | мигрирует в `docs/roadmap/01-roadmap.md` |
| `post-v1.md` | мигрирует в разделы roadmap/proposals |
| `next-stages-roadmap.md` | мигрирует в разделы roadmap/proposals |
| `2026-09-18-audit.md` | `01-full-audit.md` |

---

## 5. Интеграция с рабочим процессом

### 5.1 Создание нового документа

1. Определить тип документа (Plan/Spec/Audit и т.д.)
2. Выбрать свободный номер в соответствующей директории
3. Создать файл с правильным prefix
4. Добавить metadata block
5. Обновить `docs/roadmap/01-roadmap.md` (автоматически или вручную)
6. Запустить `pnpm docs:check` для валидации

### 5.2 Проверка перед коммитом

```bash
pnpm docs:test
pnpm docs:check
git diff --check
```

### 5.3 Обновление статусов

Статусы управляются через metadata:
- `execute` план → установить `status: in_progress`
- Успешное завершение → `status: completed` + evidence
- Блок → `status: blocked` + причина в evidence

---

## 6. История версий

| Версия | Дата | Изменения |
|--------|------|-----------|
| 1.0 | 2026-09-23 | Первоначальное утверждение правил |

```