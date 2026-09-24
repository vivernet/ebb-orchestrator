---
id: plan-04
kind: plan
roadmap: 01
stage: 04
status: completed
title: Plan Document
created: 2026-09-23
updated: 2026-09-24
depends_on: []
specs:
  - ../specs/01-system-design.md
evidence:
  - https://github.com/ebb-orchestrator/ebb-orchestrator/commit/6908acd
  - https://github.com/ebb-orchestrator/ebb-orchestrator/commit/c18264e
  - https://github.com/ebb-orchestrator/ebb-orchestrator/commit/b9441ad
  - apps/server/test/modules/runtime/output-validator.test.ts
  - tools/hermes/
---
# План реализации среды выполнения Orchestrator Hermes и автономной задачи

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ SUB-SKILL: используйте superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans для реализации этого плана по задачам. Для отслеживания шаги используют синтаксис флажков (`- [ ]`).

**Цель:** Подключить Hermes как единственный реальный AgentRuntime v1 и довести вручную созданную автономную Task через Developer → Reviewer → QA → Integration → ручное финальное слияние.

**Архитектура:** Orchestrator создаёт изолированный `HERMES_HOME`, запускает Hermes в назначенном worktree и предоставляет единственный Orchestrator MCP набор инструментов. Hermes завершает run через `submit_result`; backend не парсит свободный финальный текст как результат домена.

**Технологический стек:** Hermes CLI; stdio MCP; TypeScript/Zod контракты; Node process adapter; существующие модули Action Gateway/Git/Workflow.

**Спецификация:** `docs/architecture/specs/01-system-design.md`

## Глобальные ограничения

- Не использовать Hermes `--worktree`; worktree создаёт Orchestrator.
- Не использовать `--yolo` как способ авторизации действий.
- Hermes profile изолирован через `HERMES_HOME`; repository `AGENTS.md`/rules/memory не инжектируются автоматически.
- Hermes получает только `mcp-orchestrator` набор инструментов, соответствующий RoleContract.
- `submit_result` — один финальный допустимый результат на Run.
- Reviewer получает новую сессию; Developer возобновляет ту же сессию задачи для доработки; QA independent; Integration собственную сессию.
- GitHub учётные данные и реальные учётные данные HOME пользователя не передаются Hermes подпроцесс.

---

### Задача 1: Общие контракты ролей/вывода и семантические валидаторы

**Файлы:**
- Создать: `packages/contracts/src/roles/common.ts`
- Создать: `packages/contracts/src/roles/developer.ts`
- Создать: `packages/contracts/src/roles/reviewer.ts`
- Создать: `packages/contracts/src/roles/qa.ts`
- Создать: `packages/contracts/src/roles/integration.ts`
- Создать: `apps/server/src/modules/runtime/output-validator.ts`
- Тест: `apps/server/test/modules/runtime/output-validator.test.ts`

**Интерфейсы:**
- Создаёт: Zod schemas `DeveloperOutputSchema`, `ReviewerOutputSchema`, `QaOutputSchema`, `IntegrationOutputSchema`.
- Создаёт: `validateRoleOutput(role, value): ValidatedRoleOutput`.

- [ ] **Шаг 1: Написать тесты схемы и семантически некорректных данных**

Примеры, которые должны завершаться ошибкой:

```ts
validateRoleOutput("reviewer", {
  schema_version: 1,
  outcome: "PASS",
  findings: [{ ref: "finding_1", severity: "MAJOR", blocking: true, category: "CORRECTNESS", title: "x", description: "x", evidence: [] }],
  summary: "pass"
});
```

QA `PASS` при обязательном AC `FAIL` также должен завершаться ошибкой.

- [ ] **Шаг 2: Проверить падение тестов**

```bash
pnpm --filter @ebb-orchestrator/server test -- output-validator.test.ts
```

- [ ] **Шаг 3: Реализовать компактные версионированные схемы**

Результаты Developer: `COMPLETED|BLOCKED`.
Reviewer: `PASS|CHANGES_REQUESTED|BLOCKED`.
QA: `PASS|FAIL|BLOCKED`.
Integration: `PASS|BLOCKED`.

Не требовать taskId/runId/model в выводе модели; backend уже владеет метаданные.

- [ ] **Шаг 4: Запустить тесты и проверку типов**

```bash
pnpm --filter @ebb-orchestrator/server test -- output-validator.test.ts
pnpm typecheck
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add packages/contracts/src/roles apps/server/src/modules/runtime/output-validator.ts apps/server/test/modules/runtime/output-validator.test.ts
git commit -m "feat: add structured role output contracts"
```

---

### Задача 2: Реестр RoleContract с инструментами, моделями, сессиями и разрешениями

**Файлы:**
- Создать: `apps/server/src/modules/runtime/role-contract.ts`
- Создать: `apps/server/src/modules/runtime/role-registry.ts`
- Создать: `apps/server/src/modules/runtime/default-roles.ts`
- Тест: `apps/server/test/modules/runtime/role-registry.test.ts`

**Интерфейсы:**
- Создаёт: `RoleContract` для всех 9 ролей; в этом плане выполняются только Developer/Reviewer/QA/Integration.

- [ ] **Шаг 1: Написать snapshot-тесты контрактов**

Snapshot Reviewer не должен содержать `workspace.patch`, `git.commit`, `command.shell`. Developer не должен содержать `git.push`, `слияния.default`, изменение разрешений/конфигурации.

- [ ] **Шаг 2: Проверить ожидаемое падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- role-registry.test.ts
```

- [ ] **Шаг 3: Реализовать определения ролей**

Пример:

```ts
{
  id: "reviewer",
  runtime: "hermes",
  modelConfigKey: "roles.reviewer.model",
  sessionPolicy: "fresh_per_task",
  tools: ["workspace.read", "workspace.search", "git.diff", "project.test", "submit_result"],
  outputSchema: ReviewerOutputSchema,
}
```

Не зашивать реальные имена моделей в доменный код; разрешать их через конфигурацию проекта/глобальную конфигурацию.

- [ ] **Шаг 4: Запустить snapshot-тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- role-registry.test.ts
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/src/modules/runtime apps/server/test/modules/runtime/role-registry.test.ts
git commit -m "feat: define role contracts and tool surfaces"
```

---

### Задача 3: MCP stdio-сервер Orchestrator и жизненный цикл submit_result

**Файлы:**
- Создать: `apps/server/src/modules/execution/mcp/mcp-server.ts`
- Создать: `apps/server/src/modules/execution/mcp/tool-registry.ts`
- Создать: `apps/server/src/modules/execution/mcp/submit-result-tool.ts`
- Создать: `apps/server/src/bin/ebb-orchestrator-mcp.ts`
- Тест: `apps/server/test/modules/execution/mcp-server.test.ts`

**Интерфейсы:**
- Создаёт инструменты MCP, сопоставленные с Action Gateway по capability ID из окружения/argv процесса.
- `submit_result(payload)` проверяет схему роли и атомарно переводит run в `COMPLETING`.

- [ ] **Шаг 1: Написать тесты фильтрации MCP-инструментов**

Создать MCP-сервер для capability Reviewer; проверить, что список инструментов содержит только read/search/diff/test/submit. Вызвать `submit_result` дважды; второй вызов должен завершиться ошибкой `RUN_ALREADY_COMPLETING`.

- [ ] **Шаг 2: Проверить ожидаемое падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- mcp-server.test.ts
```

- [ ] **Шаг 3: Реализовать stdio-мост MCP**

Обработчик MCP никогда не должен доверять task/workspace ID из полезной нагрузки модели. Он разрешает capability на стороне сервера и передаёт типизированные вызовы в ActionGateway.

После корректного `submit_result` блокировать новые вызовы инструментов, способных выполнять запись, для этого Run.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- mcp-server.test.ts
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/src/modules/execution/mcp apps/server/src/bin/ebb-orchestrator-mcp.ts apps/server/test/modules/execution/mcp-server.test.ts
git commit -m "feat: expose capability-bound orchestrator mcp"
```

---

### Задача 4: Изолированный построитель профиля Hermes

**Файлы:**
- Создать: `apps/server/src/modules/runtime/hermes/hermes-profile.ts`
- Создать: `apps/server/src/modules/runtime/hermes/hermes-config.ts`
- Тест: `apps/server/test/modules/runtime/hermes-profile.test.ts`

**Интерфейсы:**
- Создаёт: `prepareHermesProfile(run): HermesLaunchProfile { hermesHome, env, набор инструментовName }`.

- [ ] **Шаг 1: Написать тест изоляции профиля**

Проверить сгенерированное окружение:

```text
HERMES_HOME=<EBB_ORCHESTRATOR_HOME>/runtime/hermes
HOME=<HERMES_HOME>/home for tool subprocess isolation
no GITHUB_TOKEN
no SSH_AUTH_SOCK
no inherited personal Hermes profile
```

Сгенерированный `config.yaml` содержит только настройки под управлением Orchestrator и описание MCP-сервера, команда которого запускает `ebb-orchestrator-mcp` с capability ref. `terminal.home_mode: profile`.

- [ ] **Шаг 2: Проверить ожидаемое падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- hermes-profile.test.ts
```

- [ ] **Шаг 3: Реализовать построитель профиля**

Не сохранять API-ключи провайдера в prompts. Если самому Hermes требуется credential провайдера, передавать из заглушки интеграции SecureStore только credential, необходимый процессу Hermes, и никогда не передавать его дочерним инструментам MCP.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- hermes-profile.test.ts
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/src/modules/runtime/hermes apps/server/test/modules/runtime/hermes-profile.test.ts
git commit -m "feat: isolate hermes runtime profile"
```

---

### Задача 5: HermesRuntimeAdapter: запуск/возобновление/отмена/сбор результата

**Файлы:**
- Создать: `apps/server/src/modules/runtime/hermes/hermes-cli.ts`
- Создать: `apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts`
- Создать: `apps/server/src/modules/runtime/hermes/hermes-session-parser.ts`
- Тест: `apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts`

**Интерфейсы:**
- Реализует `AgentRuntime`.
- Форма команды запуска нового run:

```text
hermes chat
  --query-file <prompt-file>
  --model <resolved-model>
  --toolsets mcp-orchestrator
  --in <managed-worktree>
  --ignore-rules
  --source tool
  --max-turns <role-limit>
```

- При возобновлении добавляется `--resume <session-id>`, а `--in <managed-worktree>` сохраняется.

- [ ] **Шаг 1: Написать тесты аргументов запуска с поддельным исполнителем процессов**

Проверить, что адаптер никогда не добавляет `--worktree` или `--yolo`; тело prompt записывается в файл и передаётся через `--query-file`, а не интерполируется в shell-команду.

- [ ] **Шаг 2: Проверить ожидаемое падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- hermes-runtime-adapter.test.ts
```

- [ ] **Шаг 3: Реализовать адаптер**

Сохранять ID сессии, PID процесса, артефакты stdout/stderr и код завершения. Завершение процесса без корректно отправленного результата — это `AGENT_OUTPUT_MISSING`, а не успех. При отмене сначала отправлять graceful signal/checkpoint path, затем выполнять hard kill после настроенного тайм-аута.

- [ ] **Шаг 4: Запустить набор контрактных тестов адаптера на fake CLI**

```bash
pnpm --filter @ebb-orchestrator/server test -- hermes-runtime-adapter.test.ts
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/src/modules/runtime/hermes apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts
git commit -m "feat: add hermes runtime adapter"
```

---

### Задача 6: Базовый ContextPackage и построитель prompt для ролей выполнения

**Файлы:**
- Создать: `apps/server/src/modules/context/context-types.ts`
- Создать: `apps/server/src/modules/context/context-builder.ts`
- Создать: `apps/server/src/modules/context/context-manifest.ts`
- Создать: `apps/server/src/modules/runtime/prompt-builder.ts`
- Тест: `apps/server/test/modules/context/context-builder.test.ts`

**Интерфейсы:**
- Создаёт: `ContextPackage` и `ContextManifest`.
- Пакет Developer: Task Contract, релевантные активные findings/defects, метаданные target/workspace, сводка контракта роли, инструкции вывода.
- Пакет Reviewer: Task Contract, Git diff, проверки, релевантные ограничения; без разговора с Developer.

- [ ] **Шаг 1: Написать тесты разделения ролей**

Контекст Reviewer не должен содержать стенограмму сессии Developer. Решённый finding исключается. P0 Task Contract никогда нельзя удалять при сокращении.

- [ ] **Шаг 2: Проверить ожидаемое падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- context-builder.test.ts
```

- [ ] **Шаг 3: Реализовать сокращение бюджета P0–P3**

Не выполнять суммаризацию LLM. Исходный код не загружается целиком; Developer/Reviewer читают его по запросу через инструменты. Сохранять ID/версии манифеста, а не секреты.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- context-builder.test.ts
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/src/modules/context apps/server/src/modules/runtime/prompt-builder.ts apps/server/test/modules/context
git commit -m "feat: build role-specific run context"
```

---

### Задача 7: Стабильные findings Reviewer и defects QA между повторными запусками

**Файлы:**
- Создать: `apps/server/src/modules/work/findings-service.ts`
- Создать: `apps/server/src/modules/work/defects-service.ts`
- Создать: `apps/server/src/platform/database/migrations/008_quality.sql`
- Изменить: `apps/server/src/modules/runtime/run-event-handlers.ts`
- Тест: `apps/server/test/modules/work/quality-records.test.ts`

**Интерфейсы:**
- Создаёт стабильные ID БД `FINDING-n` и `DEFECT-n` для проекта.
- Повторная проверка принимает `finding_updates` для существующих ID.

- [ ] **Шаг 1: Написать тесты жизненного цикла**

Первый вывод Reviewer `finding_1` → сохраняется `FINDING-1`. Повторная проверка помечает тот же ID `RESOLVED`; дубликат finding не создаётся. Для дефекта QA требуется аналогичный жизненный цикл.

- [ ] **Шаг 2: Проверить ожидаемое падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- quality-records.test.ts
```

- [ ] **Шаг 3: Реализовать отображение и fingerprints**

Сохранять исходный run, severity, blocking, evidence, ссылку на guideline и status. Генерировать Recovery fingerprint из стабильного ID и текущей сигнатуры evidence.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- quality-records.test.ts recovery.test.ts
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/src/modules/work apps/server/src/modules/runtime/run-event-handlers.ts apps/server/src/platform/database/migrations/008_quality.sql apps/server/test/modules/work
git commit -m "feat: persist stable review findings and qa defects"
```

---

### Задача 8: Первый реальный вертикальный срез Developer → Reviewer → QA → Integration

**Файлы:**
- Создать: `apps/server/test/e2e/fixtures/health-service/`
- Создать: `apps/server/test/e2e/autonomous-task.hermes.test.ts`
- Изменить: обработчики runtime только там, где E2E выявляет отсутствующую связку.

**Интерфейсы:**
- Новый API не добавляется; проверяется вертикальный срез.

- [ ] **Шаг 1: Создать репозиторий fixture и падающий acceptance-тест**

Fixture содержит `master`, небольшой HTTP-сервис на TypeScript, рабочий `pnpm test` и не содержит маршрута `/health`. Тест создаёт Task Contract:

```text
Goal: Add GET /health
AC: returns 200 and JSON {"status":"ok"}
Non-goal: no auth changes
```

- [ ] **Шаг 2: Запустить с реальным Hermes и ожидать первую ошибку связки**

```bash
RUN_HERMES_E2E=1 pnpm --filter @ebb-orchestrator/server test -- autonomous-task.hermes.test.ts
```

Не ослаблять разрешения ради прохождения теста; исправлять связку адаптера, инструментов и контекста.

- [ ] **Шаг 3: Завершить связку реальных этапов**

Ожидаемая последовательность:

```text
managed worktree
→ Developer commit
→ independent Reviewer PASS
→ QA PASS with AC evidence
→ Integration against current master PASS
→ FINAL_MERGE approval pending
```

Слияние пока не выполняется.

- [ ] **Шаг 4: Одобрить финальное слияние через ApprovalService и проверить master**

Тест программно действует как одобряющий пользователь, вызывает MergeService, затем проверяет `master` содержит `/health`, Task имеет состояние `DONE`, политика очистки worktree сработала, заглушки Audit/Usage записаны.

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/test/e2e apps/server/src
git commit -m "feat: complete autonomous task vertical slice"
```

## Критерии приёмки плана 4

Обязательные детерминированные тесты:

```bash
pnpm typecheck
pnpm test
```

Обязательная включаемая вручную проверка реальной среды выполнения:

```bash
RUN_HERMES_E2E=1 pnpm --filter @ebb-orchestrator/server test -- autonomous-task.hermes.test.ts
```

Run должен доказать, что Hermes использует worktree и MCP-инструменты под управлением Orchestrator, правила репозитория не инжектируются автоматически, личные учётные данные GitHub/SSH не наследуются, а финальное слияние невозможно до явного одобрения.
