# Документация Ebb Orchestrator

## Назначение

Этот файл — навигация по документации проекта. Краткое описание продукта,
установка и рабочие команды находятся в [корневом README](../README.md).

## Каталоги

| Каталог | Назначение |
|---|---|
| `architecture/specs/` | Архитектурные спецификации и основной источник истины |
| `architecture/plans/` | Канонические планы реализации и governance-планы |
| `architecture/reference-ui/` | Концепты интерфейса |
| `audit/` | Аудиты, проверочные отчёты и снимки состояния |
| `development/` | Правила разработки, документации и JSDoc |
| `issues/` | Зафиксированные проблемы и их контекст |
| `roadmap/` | Сгенерированная карта зависимостей и исторические снимки |

## Архитектура и планы

- [Системный дизайн](architecture/specs/01-system-design.md) — основная
  архитектурная спецификация.
- [Каталог планов](architecture/plans/) — актуальные и исторические планы.
- [План governance документации](architecture/plans/governance/00-01-documentation-governance.md).
- [Интеграция governance](architecture/plans/governance/00-05-governance-integration.md).
- [План CI и runtime home](architecture/plans/17-ci-runtime-home-and-env-hardening.md).

Текущие статусы и зависимости планов публикуются в
[сгенерированном roadmap](roadmap/generated.md). Файл
[roadmap/01-roadmap.md](roadmap/01-roadmap.md) сохранён как исторический снимок
и не является текущим реестром.

## Governance и разработка

- [Правила документации](development/02-documentation-governance.md) — имена,
  метаданные и проверка документов.
- [Русский JSDoc и README](development/03-russian-jsdoc-readme.md).
- [Стиль JSDoc](development/07-jsdoc-style-guide.md).
- [Каталог UI-концептов](architecture/reference-ui/).

Проверки документации запускаются из корня репозитория:

```bash
pnpm docs:inventory
pnpm docs:check
pnpm docs:test
```

`pnpm docs:rename:check` сейчас возвращает успешный код, но сообщает
`Rename check not yet implemented`. `pnpm docs:link:sync` зарегистрирована в
`package.json`, однако текущий диспетчер её не поддерживает и завершает работу
с кодом `1`; не используйте её как успешную проверку.

## Аудит и справочные материалы

- [Аудит рабочего процесса разработки Hermes](audit/05-hermes-development-workflow-parity.md).
- [Инвентаризация перехода на Hermes](audit/06-opencode-to-hermes-inventory.md).
- [Текущий статус проекта](audit/07-project-state.md).
- [Концепты интерфейса](architecture/reference-ui/).

Документы с YAML-метаданными в начале файла проверяются governance-скриптами.
README являются исключением из этого требования и содержат обычный Markdown без
метаданных в начале файла.

## Канонические правила

- Архитектурный источник истины: `architecture/specs/01-system-design.md`.
- Канонический roadmap: `roadmap/generated.md`.
- Правила JSDoc: `development/07-jsdoc-style-guide.md`.
- Общие инструкции для агентов: [корневой `AGENTS.md`](../AGENTS.md).
- Обязательные quality gates описаны в корневом README и `AGENTS.md`.
