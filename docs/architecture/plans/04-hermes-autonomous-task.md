---
id: plan-04
kind: plan
status: completed
title: План реализации среды выполнения Orchestrator Hermes и автономной задачи
created: 2026-09-23
updated: 2026-10-21
depends_on: []
specs:
  - ../specs/01-system-design.md
evidence:
  - https://github.com/ebb-orchestrator/ebb-orchestrator/commit/6908acd
  - https://github.com/ebb-orchestrator/ebb-orchestrator/commit/c18264e
  - https://github.com/ebb-orchestrator/ebb-orchestrator/commit/b9441ad
  - apps/server/test/modules/runtime/output-validator.test.ts
  - docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md
  - docs/architecture/plans/04-hermes-autonomous-task.md
  - apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts
  - apps/server/test/modules/runtime/hermes-executable-resolver.test.ts
  - apps/server/test/e2e/v1-autonomous-task.test.ts
---
# План реализации среды выполнения Orchestrator Hermes и автономной задачи

> **Для агентного исполнения:** REQUIRED SKILL: `ebb-execute-plan`. План выполняется по задачам; для отслеживания шагов используется синтаксис флажков (`- [ ]`).

**Цель:** Подключить Hermes как единственный реальный AgentRuntime v1 и довести вручную созданную автономную Task через Developer → Reviewer → QA → Integration → ручное финальное слияние.

**Архитектура:** Orchestrator запускает установленный Hermes через уже настроенный пользователем root/profile и provider/auth, назначает ему управляемый worktree и предоставляет только Orchestrator MCP tools. Per-Run профиль и конфигурационный overlay не создаются. Hermes завершает run через `submit_result`; backend не парсит свободный финальный текст как результат домена.

## Superseded historical record: provider credential bridge proposal (2026-09-28)

> This proposal is superseded by the user-approved Proposal09 direction (2026-10-02); it is not current setup guidance. Earlier drafts required a separate Ebb SecretStore entry and provider-key environment injection. Production Runs reuse the provider/auth and root/profile already configured through Hermes-native mechanisms; Ebb does not create a per-Run profile or config overlay. The old note describing `openai-codex` OAuth was a dated observation, not confirmation of current selection. Hermes owns provider/model/auth selection; Ebb does not inspect or override it.

**Provider/auth documentation owner:** Plan20 Task7 owns `README.md` and `docs/development/05-hermes.md` as the single source for end-to-end setup. Those instructions must explain that Hermes provider/model and native authentication are configured once through Hermes, Orchestrator Runs reuse that configured selection/auth, root `.env` contains only Ebb settings, and no duplicate Ebb SecretStore credential or provider key is required. Plan04 acceptance consumes that documented flow; it must not introduce a competing setup path.
**Технологический стек:** Hermes CLI; stdio MCP; TypeScript/Zod контракты; Node process adapter; существующие модули Action Gateway/Git/Workflow.

**Спецификация:** `docs/architecture/specs/01-system-design.md`

## Глобальные ограничения

- Не использовать Hermes `--worktree`; worktree создаёт Orchestrator.
- Не использовать `--yolo` как способ авторизации действий.
- Hermes использует уже настроенный пользователем root/profile; Ebb не создаёт отдельный `HERMES_HOME`, профиль или config overlay. Repository `AGENTS.md`/rules/memory не инжектируются автоматически.
- Hermes получает только `mcp-ebb-orchestrator` набор инструментов, соответствующий RoleContract.
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

Результаты Developer: `COMPLETED|BLOCKED`. `COMPLETED` требует непустой `commitSha`; `BLOCKED` может не содержать `commitSha`. Условие должно присутствовать и в канонической Zod-схеме, и в опубликованном MCP JSON Schema.
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

Snapshot Reviewer не должен содержать `workspace.patch`, `git.add`, `git.commit`, `git.head`, `command.shell`. Developer получает `workspace.search`, `git.add`, `git.commit` и read-only `git.head`, но не должен иметь `git.push`, `слияния.default` или изменение разрешений/конфигурации.

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
- Тест: `apps/server/test/modules/execution/mcp/mcp-server.test.ts`

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
git add apps/server/src/modules/execution/mcp apps/server/src/bin/ebb-orchestrator-mcp.ts apps/server/test/modules/execution/mcp/mcp-server.test.ts
git commit -m "feat: expose capability-bound orchestrator mcp"
```

---

### Задача 4: Запуск Hermes через существующую пользовательскую конфигурацию

**Файлы:**
- Реализация: `apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts`
- Реализация: `apps/server/src/modules/runtime/hermes/hermes-cli.ts`
- Тесты: `apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts` и `apps/server/test/modules/runtime/hermes-executable-resolver.test.ts`

**Интерфейсы:**
- Адаптер запускает поддерживаемый Hermes CLI с существующим пользовательским root/profile и provider/auth, связывает процесс с durable Run owner и регистрирует разрешённые Ebb MCP tools в памяти.

- [ ] **Шаг 1: Проверить запуск без отдельного профиля и overlay**

Проверить сгенерированное окружение:

```text
existing user-configured Hermes root/profile and provider/auth
no per-Run HERMES_HOME or config overlay
no Ebb provider key or duplicate provider credential
GitHub credentials remain available only to GitHubAdapter
```

Ebb не генерирует и не изменяет Hermes `config.yaml`; MCP tools регистрируются только в памяти поддерживаемым Hermes API. Provider/model/auth выбираются и разрешаются Hermes.

- [ ] **Шаг 2: Проверить ожидаемое падение**

```bash
pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/runtime/hermes-runtime-adapter.test.ts test/modules/runtime/hermes-executable-resolver.test.ts
```

- [ ] **Шаг 3: Подключить существующую Hermes конфигурацию без профиля/overlay**

Не читать, не копировать и не передавать provider credentials от имени Ebb. Hermes использует уже настроенную пользователем provider/auth конфигурацию; Ebb не блокирует запуск из-за невозможности проецировать provider selection.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/runtime/hermes-runtime-adapter.test.ts test/modules/runtime/hermes-executable-resolver.test.ts
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/src/modules/runtime/hermes apps/server/test/modules/runtime
git commit -m "feat: запускать настроенный Hermes runtime"
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
  --toolsets mcp-ebb-orchestrator
  --in <managed-worktree>
  --ignore-rules
  --source ebb-run:<run-id>
  --format stream-json
  --max-turns <role-limit>
```

- Provider/model/auth берутся из уже настроенного Hermes root/profile; Ebb не передаёт `--model` и не подменяет выбор пользователя.
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
- `findings[]` Reviewer создаёт новые записи с назначенными Orchestrator ID `FINDING-n`; эвристическое сопоставление с прошлыми finding запрещено.
- Повторная проверка обновляет существующую запись только через явный `finding_updates[{id: FINDING-n, status: RESOLVED | STILL_PRESENT}]`. ID должен относиться к той же Task и присутствовать в active context текущего Reviewer Run. Пропуск ID сохраняет запись без изменений.
- QA `failedCriteria[]` ссылается на `AC-N`, где N — позиция acceptance criterion в Task Contract, нумеруемая с 1. `DefectsService` возвращает имеющуюся запись для `(task_id, acceptance_criterion_ref)` вместо создания новой; повторный FAIL без явного update не меняет существующую запись. Это service-level гарантия, не DB unique constraint. Legacy-дубликаты сохраняются без изменений; новые QA outputs не добавляют строк для уже представленной пары.
- QA обновляет существующий defect только через явный `defect_updates[{id: DEFECT-n, status: RESOLVED | STILL_PRESENT}]`. ID должен относиться к той же Task и присутствовать в active context текущего QA Run. Пропуск ID сохраняет запись без изменений.
- Качество-выводы, workflow completion, reservation release и completion projection фиксируются одной транзакцией; невалидная ссылка откатывает всю проекцию Run.

- [ ] **Шаг 1: Написать тесты жизненного цикла**

Первый вывод Reviewer создаёт запись с `FINDING-1`; повторный Reviewer явно указывает `finding_updates` для ID из своего контекста. Отсутствие update не меняет status. Для QA проверить `DEFECT-n`, уникальность Task+AC-N, явное обновление и отсутствие implicit update.

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
- Проверка: `apps/server/test/e2e/v1-autonomous-task.test.ts`
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
$env:RUN_HERMES_E2E='1'; pnpm --filter @ebb-orchestrator/server exec vitest run test/e2e/v1-autonomous-task.test.ts -t "runs the real Hermes managed-worktree acceptance when opted in"
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

Результат Developer со статусом `COMPLETED` обязан содержать точный SHA этого commit из `git rev-parse HEAD`; `submit_result` отклоняет отсутствующий или пустой `commitSha`. Результат `BLOCKED` может не содержать SHA, если commit не создан.

Developer получает `workspace.search` для чтения по запросу, а для завершения использует capability-bound `git.add` с явными относительными путями, `git.commit` и read-only `git.head` (фиксированный `git rev-parse HEAD`). `COMPLETED.commitSha` должен быть в точности значением `git.head`; Developer не получает push/merge tools.

Слияние пока не выполняется.

- [ ] **Шаг 4: Одобрить финальное слияние через ApprovalService и проверить master**

Тест программно действует как одобряющий пользователь, вызывает MergeService, затем проверяет `master` содержит `/health`, Task имеет состояние `DONE`, политика очистки worktree сработала, заглушки Audit/Usage записаны.

- [ ] **Шаг 5: Закоммитить**

Hermes CLI `--max-turns` ограничивает число tool-calling iterations внутри conversation turn. Adapter по умолчанию передаёт поддерживаемый CLI default `500`; явный `roleLimit` остаётся override. Это снижает риск преждевременного завершения длинной Developer работы до обязательного `submit_result`, но не гарантирует завершение и не меняет fail-closed проверку результата.

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
$env:RUN_HERMES_E2E='1'; pnpm --filter @ebb-orchestrator/server exec vitest run test/e2e/v1-autonomous-task.test.ts -t "runs the real Hermes managed-worktree acceptance when opted in"
```

Live Run должен доказать, что Hermes использует управляемый worktree и MCP-инструменты Orchestrator при уже настроенном пользователем Hermes root/profile/provider/auth, правила репозитория не инжектируются автоматически, GitHub credentials доступны только GitHubAdapter, а финальное слияние невозможно до явного одобрения. Acceptance не создаёт тестовую копию Hermes profile и не требует изменения host ACL.
