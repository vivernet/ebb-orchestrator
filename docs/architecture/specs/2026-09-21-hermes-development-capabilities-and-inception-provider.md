# Hermes Development Capabilities and Inception Provider

## Цель

Сделать в репозитории единый, проверяемый и воспроизводимый development-контур
для Hermes: канонические skills, реестр capabilities, provider-профиль
Inception Labs и явная документация установки. Секреты и персональные Hermes
настройки не должны становиться частью Git-репозитория.

## Границы

Входит в задачу:

- проектные skills Hermes для планирования, реализации, review, security,
  web E2E, provider-интеграций и финальной проверки;
- декларативный `capabilities.yaml` как перечень разрешённых development
  abilities, их назначение и границы;
- `inception` provider profile с OpenAI-compatible endpoint
  `https://api.inceptionlabs.ai/v1`, model alias и `INCEPTION_API_KEY`;
- команды setup/check/provider в существующем `scripts/hermes-dev.mjs`;
- синхронизация skills и profile в `HERMES_HOME` без записи секретов;
- отдельные записи в `README.md` и development-документации для каждого
  skill/capability/provider.

Не входит:

- автоматическое переключение production runtime на новый provider;
- хранение API key в Git, prompt, логах, artifacts или README;
- установка внешних Codex marketplace plugins в пользовательский профиль;
- удаление `.opencode` до успешного Stage 9 parity-run с рабочим provider;
- изменение domain workflow, permission semantics или v1 product scope.

## Архитектура

Репозиторий является source of truth для skills и provider templates:

```text
tools/hermes/
├── capabilities.yaml
├── providers/inception.yaml
└── skills/<skill-name>/SKILL.md
```

`pnpm hermes:setup` копирует skills и provider template в изолированный
`HERMES_HOME` и настраивает только non-secret Hermes keys. Команда
`pnpm hermes:provider -- inception` явно выбирает alias для development-run;
она не меняет production profile и не печатает значение API key.

`pnpm hermes:check` валидирует source/installed hashes, capability registry,
provider template и отсутствие секретных значений в tracked files. Проверка
не выполняет сетевой запрос и не утверждает, что внешний credential действителен.

## Канонический набор skills

Уже существующие skills сохраняются:

- `ebb-execute-plan` — координация implementation plan и ограниченное
  делегирование;
- `ebb-implement-task` — выполнение одной изолированной задачи с TDD;
- `ebb-review-task` — review конкретной задачи до принятия результата;
- `ebb-final-review` — итоговая проверка ветки и quality gates.

Добавляются:

- `ebb-security-review` — security/architecture review с учётом trust
  boundaries, secrets и Action Gateway;
- `ebb-web-e2e` — browser/API E2E для Web UI с проверкой реального transport;
- `ebb-provider-integration` — проверка provider profile, env boundary и
  OpenAI-compatible contract без вывода secrets;
- `ebb-repository-context` — порядок чтения canonical specs, AGENTS и plans;
- `ebb-quality-gates` — единый evidence-first набор lint/typecheck/test/build,
  diff и security checks.

Каждый skill остаётся узко scoped и не получает права обходить проектные
permission или Git policy.

## Provider contract

Канонический development profile:

```yaml
name: inception
provider: custom:inception
api: https://api.inceptionlabs.ai/v1
model: mercury-2
key_env: INCEPTION_API_KEY
```

Profile использует Hermes-supported `providers.<name>.api` и `key_env`.
Значение `INCEPTION_API_KEY` читается только из локального environment/Hermes
secret boundary. Неавторизованный или неверный ключ является внешней
конфигурационной ошибкой; локальные checks должны сообщать её без раскрытия
значения.

## Приёмка

1. `pnpm hermes:setup` synchronizes all canonical skills and the Inception
   template into the selected `HERMES_HOME`.
2. `pnpm hermes:check` passes with a clean isolated setup and fails when a
   source or installed skill hash differs.
3. `pnpm hermes:provider -- inception` writes only supported non-secret config
   keys and leaves the API key external.
4. Invalid provider names and paths outside the worktree fail closed.
5. Existing setup remains backward-compatible when no provider command is run.
6. README lists every skill, capability and provider profile with installation
   location and command.
7. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm server:build`,
   `pnpm web:build` and `git diff --check` pass.

## Источники контракта

- Hermes provider configuration: official Hermes documentation queried through
  Context7 (`/nousresearch/hermes-agent`), including `providers.<name>.api`,
  `key_env`, `model_aliases` and `custom:<name>`.
- Inception Labs endpoint and model availability: official provider
  documentation linked from the project README; no credential is committed.
