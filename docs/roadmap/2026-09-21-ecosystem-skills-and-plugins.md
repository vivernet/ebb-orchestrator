# Экосистема skills, providers и plugins для Ebb Orchestrator

**Статус:** рекомендация для эксплуатации продукта после завершения v1.

Этот документ отвечает на вопрос, какие расширения нужны Ebb Orchestrator при
использовании по назначению — для управляемой AI-разработки чужих проектов. Он
не расширяет scope v1 и не является разрешением автоматически подключать
внешние сервисы.

## Принцип отбора

Ebb должен использовать три разных типа возможностей:

1. **Skills** — инструкции для role-based agent runs. Они не выдают права.
2. **Runtime/providers** — выполнение модели и controlled tools.
3. **Plugins/adapters** — связь с внешними системами через отдельные ports.

Workflow state, permissions, budgets, approvals, Git operations и recovery
всегда остаются authoritative внутри Ebb. Внешняя система может давать input,
evidence или notification, но не переводит Task/Epic в terminal state сама.

## Обязательные skill packs

| Pack | Приоритет | Почему нужен |
|---|---:|---|
| **Superpowers** | обязательный | Базовый переносимый development workflow: brainstorming, writing plans, subagent-driven development, TDD, systematic debugging, Git worktrees, code review и verification before completion. |
| **Context7** | обязательный | Получение актуальной первичной документации по library, framework, SDK, API и CLI до реализации или интеграции. |
| **Browser/E2E pack** | обязательный для web-проектов | Playwright плюс browser automation для проверки browser → API → persistence → UI flow. |
| **Security scanning pack** | обязательный | SAST, dependency audit, secret scanning и независимый security review как evidence, а не как разрешение на действие. |
| **Document/data packs** | подключаются по типу задачи | Работа с `.docx`, PDF, spreadsheet и slide artifacts, когда эти форматы являются частью продукта или требований. |
| **Stack-specific packs** | подключаются по manifest проекта | React/Next.js, Node.js, Python, Java, Go, Terraform и другие packs выбираются детерминированно после анализа manifest/lockfile подключённого repository. |

`superpowers` нельзя оставлять только инструментом разработки Ebb. Его
workflow должны быть доступны назначаемым агентам как versioned local skill
templates или как совместимый импортируемый pack. При этом Ebb не делегирует
authority pack-у: plan approval, permissions, budget, Git mutation и final
merge остаются в deterministic core.

Context7 также нужен не как источник policy, а как read-only documentation
adapter. Его результат требует source attribution и не должен автоматически
изменять архитектурные решения или project guidelines.

## Обязательный набор skills

| Skill | Основные роли | Назначение |
|---|---|---|
| `repository-context` | Coordinator, Architect | Загружает инструкции, repository metadata, scope и ограничения подключённого проекта. |
| `requirements-triage` | Product Manager, Coordinator | Преобразует человеческий запрос в Task или Epic с acceptance criteria. |
| `architecture-review` | Architect | Проверяет границы модулей, contracts, persistence, security и scope. |
| `implementation-plan` | Coordinator, Developer | Декомпозирует Epic на зависимости, этапы и допустимый parallelism. |
| `implementation-tdd` | Developer | Выполняет изменение через test-first, focused verification и минимальный diff. |
| `git-worktree` | Developer, Integration | Работает только в назначенном worktree и проверяет фактическое Git state. |
| `code-review` | Reviewer | Выявляет regressions, contract violations и maintainability defects. |
| `qa-acceptance` | QA | Проверяет acceptance criteria и user-facing scenarios независимо от Developer. |
| `security-review` | Reviewer, Security | Проверяет secrets, process execution, path containment, MCP, permissions и Action Gateway. |
| `quality-gates` | QA, Integration | Запускает lint, typecheck, test, build, E2E/security checks и `git diff --check`. |
| `ui-e2e` | QA | Проверяет browser/API/SSE flow через реальный transport. |
| `integration-review` | Integration | Сверяет результат с current target branch до запроса final merge approval. |
| `recovery-reconciliation` | Coordinator, DevOps | Обрабатывает interrupted runs, locks, Git/SQLite divergence и restart recovery. |
| `provider-preflight` | DevOps, Coordinator | Проверяет endpoint, model alias, budget и secret boundary provider без вывода key. |
| `documentation-change` | Developer, Reviewer | Синхронизирует README, API docs, migration и release notes с изменением. |
| `usage-budget-review` | Coordinator | Проверяет usage/cost accounting и блокирует запуск до обращения к модели при нарушении budget. |

### Правило подключения

Skills хранятся как versioned project templates. Для каждого Agent Run Ebb
фиксирует использованные версии skill, role contract, guideline и decision.
Новый skill проходит review, тестовые сценарии и explicit approval до включения
в workflow template.

### Важное уточнение о portability

Ebb не должен зависеть от того, установлен ли конкретный Codex plugin на
машине пользователя. Для `superpowers`, Context7, browser/E2E и других
required packs нужны project-local manifest, version/digest, declared input
and output contract и проверяемый fallback: `BLOCKED_SETUP`, если capability
не установлена. Нельзя подменять отсутствующий skill свободным prompt-ом.

## Обязательный runtime слой

| Компонент | Статус | Назначение |
|---|---|---|
| Hermes Runtime | v1 | Единственный real Agent Runtime с controlled tools, session lifecycle и structured result boundary. |
| FakeAgentRuntime | v1 | Детерминированные CI/scenario tests без AI token usage. |
| Ebb MCP server | v1 | Capability-bound tools и `submit_result`; stdout/stderr не являются source of truth. |
| Inception Labs profile | development/provider profile | OpenAI-compatible provider profile; endpoint/model/key name versioned, credential остаётся вне Git. |
| SecretStore / Infisical | v1 optional | Хранение credential metadata и secrets вне prompts, logs и repository. |

Inception Labs — provider, а не plugin. Он подключается per-runtime profile,
не является неявным fallback и не даёт агенту доступ к SecretStore.

## Внешние adapters: приоритеты

### Подключать после стабилизации v1

| Adapter | Приоритет | Разрешённое назначение | Ограничение |
|---|---:|---|---|
| GitHub App | высокий | Issue import, PR/review/comment sync, ручная синхронизация состояния. | GitHub не является source of truth; final merge требует human approval. |
| OS Keyring / Infisical | высокий | Secret storage для provider/SCM credentials. | Агентские prompts и runtime environment не получают чужие secrets. |
| Slack **или** Teams | средний | Уведомления о approval, blocker, recovery failure и готовности merge. | Выбрать один первый канал; notification не равен approval. |
| OpenTelemetry-compatible observability | средний | Traces, error correlation, usage, latency и audit evidence. | Не экспортировать prompts или secrets в telemetry. |
| GitHub Actions CI status | средний | Получение CI evidence для QA/Integration. | Успешный CI не завершает workflow автоматически. |

Для GitHub следует использовать собственный GitHub App с installation token и
минимальным набором repository permissions, а не personal access token.
Официальная документация GitHub прямо рекомендует Apps из-за fine-grained
permissions, repository scoping и short-lived tokens:

- <https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app>
- <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app>

### Подключать только отдельным post-v1 milestone

| Adapter | Когда нужен | Boundary |
|---|---|---|
| Linear **или** Jira | Внешняя PM-система уже является входным каналом команды. | Импорт/синхронизация, но не замена Workflow Engine. |
| GitLab **или** Bitbucket | Исходный код реально размещён у этого Git hosting provider. | Один adapter на выбранный hosting; не подключать все заранее. |
| OpenSpec | Нужен lifecycle proposal/spec/tasks/approval/archive и drift detection. | Specification layer, не второй workflow engine. |
| Sentry | Появились production incidents и нужна evidence-based triage. | Сначала read-only diagnostics; mutations только по отдельной policy. |
| OCI/Docker, npm или PyPI registry | Ebb управляет выпуском build artifacts. | Требует отдельного release/deployment security design. |
| Figma | UI-задачи требуют проверяемого design context. | Read-only design input, не authority на code changes. |
| Notion, Google Drive, SharePoint, Dropbox или Box | В них находятся утверждённые требования, ADR или runbooks. | Read-only context source; imported text не становится policy автоматически. |

## Оценка доступных marketplace plugins

| Plugin | Решение | Причина |
|---|---|---|
| Codex Security | Не включать в продуктовую зависимость. | Полезен как независимый внешний reviewer при разработке Ebb, но Ebb должен иметь собственный security-review workflow. |
| Slack / Teams | Выбрать один post-v1. | Нужны notifications и human approval links; не нужно дублирование каналов. |
| Figma | По запросу. | Уместен для UI/design задач, не для core workflow. |
| Notion / Google Drive / SharePoint / Dropbox / Box | По реальному источнику документации. | Не подключать заранее: каждый создаёт отдельную trust boundary. |
| Gmail / Outlook Email | Не для core. | Допустимы позднее для уведомлений, но не для workflow transitions. |
| Google Calendar / Outlook Calendar | Не подключать. | Scheduler Ebb является authoritative; календарь не должен управлять запуском Task/Epic. |

Отдельно от marketplace plugins Ebb должен иметь capabilities для `superpowers`,
Context7, browser/E2E и security scan. Их нельзя заменять каталогом SaaS
connectors: это базовые способы выполнения и проверки разработки.

Для простых уведомлений Slack incoming webhooks достаточно как отдельный
notification adapter; interactive workflow должен использовать signed links
назад в Ebb UI, а не Slack action как источник решения. См. официальную
документацию: <https://api.slack.com/messaging/webhooks>.

## Запрещённые сокращения

- Не давать LLM прямой доступ к GitHub, SecretStore, unrestricted filesystem,
  deploy credentials или final merge authority.
- Не делать внешний Issue tracker, chat, calendar или документ authoritative
  источником workflow state.
- Не подключать dynamic provider fallback без policy-based routing, budget и
  recovery design.
- Не запускать real-provider tests в обычном deterministic CI.
- Не превращать plugin marketplace в runtime dependency продукта.

## Рекомендуемый порядок внедрения

1. Довести и принять v1: skills, role contracts, recovery, Web UI и реальные
   acceptance flows.
2. Проверить Hermes/Inception profile и SecretStore boundary отдельной
   controlled acceptance проверкой.
3. Включить optional GitHub App и CI evidence flow.
4. Добавить один notification channel: Slack или Teams.
5. В отдельном design cycle выбрать один PM adapter: Linear или Jira.
6. После стабилизации integration framework рассматривать SCM, OpenSpec,
   observability, artifact registry и document adapters.

## Связь с roadmap

Этот список согласован с `docs/roadmap/post-v1.md`: дополнительные runtimes,
усиленная isolation, team mode, Git hosting, issue systems, OpenSpec,
observability, autonomous deployment, advanced routing и plugin ecosystem
требуют отдельного design/proposal/approval цикла.
