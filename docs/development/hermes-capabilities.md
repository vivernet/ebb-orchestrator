# Hermes: skills, capabilities и providers

Репозиторий хранит canonical development support в `tools/hermes/`. Установленная
копия создаётся в `$HERMES_HOME` (по умолчанию `~/.hermes`, на Windows —
`%USERPROFILE%\\.hermes`). Ручное редактирование установленной копии запрещено:
после изменения source нужно выполнить `pnpm hermes:setup`.

## Skills

| Skill | Назначение | Source | Installed |
| --- | --- | --- | --- |
| `ebb-execute-plan` | Координация плана и максимум 2 параллельных subagents | `tools/hermes/skills/ebb-execute-plan/SKILL.md` | `$HERMES_HOME/skills/ebb-orchestrator/ebb-execute-plan/SKILL.md` |
| `ebb-implement-task` | Реализация одной задачи с TDD | `tools/hermes/skills/ebb-implement-task/SKILL.md` | `$HERMES_HOME/skills/ebb-orchestrator/ebb-implement-task/SKILL.md` |
| `ebb-review-task` | Read-only review отдельной задачи | `tools/hermes/skills/ebb-review-task/SKILL.md` | `$HERMES_HOME/skills/ebb-orchestrator/ebb-review-task/SKILL.md` |
| `ebb-final-review` | Финальный review ветки и gates | `tools/hermes/skills/ebb-final-review/SKILL.md` | `$HERMES_HOME/skills/ebb-orchestrator/ebb-final-review/SKILL.md` |
| `ebb-security-review` | Trust boundaries, secrets, permissions, Action Gateway | `tools/hermes/skills/ebb-security-review/SKILL.md` | `$HERMES_HOME/skills/ebb-orchestrator/ebb-security-review/SKILL.md` |
| `ebb-web-e2e` | Browser/API E2E и recovery-синхронизация | `tools/hermes/skills/ebb-web-e2e/SKILL.md` | `$HERMES_HOME/skills/ebb-orchestrator/ebb-web-e2e/SKILL.md` |
| `ebb-provider-integration` | Provider profile и OpenAI-compatible boundary | `tools/hermes/skills/ebb-provider-integration/SKILL.md` | `$HERMES_HOME/skills/ebb-orchestrator/ebb-provider-integration/SKILL.md` |
| `ebb-repository-context` | Canonical specs, AGENTS, plans и scope | `tools/hermes/skills/ebb-repository-context/SKILL.md` | `$HERMES_HOME/skills/ebb-orchestrator/ebb-repository-context/SKILL.md` |
| `ebb-quality-gates` | Evidence-first lint/typecheck/test/build/diff/security | `tools/hermes/skills/ebb-quality-gates/SKILL.md` | `$HERMES_HOME/skills/ebb-orchestrator/ebb-quality-gates/SKILL.md` |

## Capabilities registry

Полный декларативный список находится в `tools/hermes/capabilities.yaml` и
после setup устанавливается как `$HERMES_HOME/capabilities.yaml`. Registry
описывает development scope, но не заменяет backend `Permission Engine`,
`Action Gateway` или persisted run capability.

## Inception Labs provider

Source profile: `tools/hermes/providers/inception.yaml`. Установленная копия:
`$HERMES_HOME/providers/ebb-orchestrator/inception.yaml`.

| Поле | Значение |
| --- | --- |
| Name | `inception` |
| Provider | `custom:inception` |
| Base URL | `https://api.inceptionlabs.ai/v1` |
| Model alias | `mercury-2` |
| Secret env name | `INCEPTION_API_KEY` |

```bash
pnpm hermes:setup
pnpm hermes:provider -- inception
```

Команда записывает только имя environment variable и non-secret config keys.
Значение `INCEPTION_API_KEY` задаётся локально и не появляется в Git, prompt,
logs, UI, artifacts или выводе setup. Provider не является неявным production
fallback.

Официальные источники: [Inception Models](https://www.inceptionlabs.ai/models)
и [Inception API documentation](https://docs.inceptionlabs.ai/resources/cline).

## Проверка

```bash
pnpm hermes:check
```

Проверка сверяет SHA-256 source/installed skills, registry и provider template.
Она не выполняет сетевой запрос и не подтверждает валидность внешнего API key.
