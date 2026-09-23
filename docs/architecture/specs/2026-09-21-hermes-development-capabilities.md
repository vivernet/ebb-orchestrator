# Hermes Development Capabilities

## Цель

Сделать в репозитории единый, проверяемый и воспроизводимый development-контур для Hermes: канонические skills, реестр capabilities и явная документация установки. Секреты и персональные Hermes настройки не должны становиться частью Git-репозитория.

## Границы

Входит в задачу:

- проектные skills Hermes для планирования, реализации, review, security, web E2E, repository-context и финальной проверки;
- декларативный `capabilities.yaml` как перечень разрешённых development abilities, их назначение и границы;
- команды setup/check в существующем `scripts/hermes-dev.mjs`;
- синхронизация skills в `HERMES_HOME` без записи секретов;
- отдельные записи в `README.md` и development-документации для каждого skill/capability.

Не входит:

- автоматическое переключение production runtime;
- хранение API key в Git, prompt, логах, artifacts или README;
- установка внешних Codex marketplace plugins в пользовательский профиль;
- удаление `.opencode` до успешного Stage 9 parity-run;
- изменение domain workflow, permission semantics или v1 product scope.

## Архитектура

Репозиторий является source of truth для skills:

```text
tools/hermes/
├── capabilities.yaml
└── skills/<skill-name>/SKILL.md
```

`pnpm hermes:setup` копирует skills в изолированный `HERMES_HOME` и настраивает только non-secret Hermes keys.

`pnpm hermes:check` валидирует source/installed hashes, capability registry и отсутствие секретных значений в tracked files. Проверка не выполняет сетевой запрос.

## Канонический набор skills

Уже существующие skills сохраняются:

- `ebb-execute-plan` — координация implementation plan и ограниченное делегирование;
- `ebb-implement-task` — выполнение одной изолированной задачи с TDD;
- `ebb-review-task` — review конкретной задачи до принятия результата;
- `ebb-final-review` — итоговая проверка ветки и quality gates.

Добавляются:

- `ebb-security-review` — security/architecture review с учётом trust boundaries, secrets и Action Gateway;
- `ebb-web-e2e` — browser/API E2E для Web UI с проверкой реального transport;
- `ebb-repository-context` — порядок чтения canonical specs, AGENTS и plans;
- `ebb-quality-gates` — единый evidence-first набор lint/typecheck/test/build, diff и security checks.

Каждый skill остаётся узко scoped и не получает права обходить проектные permission или Git policy.

## Приёмка

1. `pnpm hermes:setup` synchronizes all canonical skills into the selected `HERMES_HOME`.
2. `pnpm hermes:check` passes with a clean isolated setup and fails when a source or installed skill hash differs.
3. Invalid paths outside the worktree fail closed.
4. Existing setup remains backward-compatible.
5. README lists every skill and capability with installation location and command.
6. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm server:build`, `pnpm web:build` and `git diff --check` pass.

## Источники контракта

- Hermes provider configuration: official Hermes documentation queried through Context7 (`/nousresearch/hermes-agent`), including `providers.<name>.api`, `key_env`, `model_aliases` and `custom:<name>`.
