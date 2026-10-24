---
id: plan-23
kind: plan
status: completed
title: "Web UI: настройка ИИ-провайдеров и моделей (IN-005)"
summary: Перенос владения настройкой ИИ-провайдеров/моделей Orchestrator Runs в Ebb (built-in провайдеры Hermes, ключи в EBB_ORCHESTRATOR_HOME/.env) и read-only отображение в Web UI.
created: 2026-10-23
updated: 2026-10-23
depends_on:
  - plan-22
specs:
  - ../specs/01-system-design.md
proposals:
  - ../proposals/18-ebb-owned-provider-config.md
---

# Web UI: Настройка ИИ-провайдеров и моделей (IN-005) — Implementation Plan

**Goal:** Перенести владение настройкой ИИ-провайдеров и моделей Orchestrator Runs в Ebb (built-in провайдеры Hermes, API-ключи в `EBB_ORCHESTRATOR_HOME/.env`) и отобразить это в Web UI (read-only проекция выбора/статуса без значений ключей).

**Architecture:** Ebb хранит статический реестр built-in провайдеров/моделей Hermes (provider → стандартная env-переменная) и дефолтную модель. При явном выборе модели пользователем (Run API) Ebb запускает Hermes с `--provider <P> -m <M> --oneshot --ignore-user-config` и передаёт ключ провайдера в child-окружение (расширение существующего allowlist ровно для выбранной env-переменной). `model=default` без явного выбора сохраняет текущее поведение (legacy-путь без флагов). Ключи никогда не попадают в SQLite/логи/артефакты/UI; пользовательский Hermes profile/config/auth не читается, не копируется и не изменяется.

**Authority:** Proposal 18 (`accepted` 2026-10-23); spec-01 §10.2/§13.1 (амендированы); Plan20 (Task5B/5C амендированы); Plan22 (provider-errors/usage/agent-events — неизменны).

**Global Constraints:**

- Git — источник истины для кода; SQLite — для оркестрации. Не менять пользовательский Hermes config/profile/auth и не читать `~/.hermes/.env`, `auth.json`.
- Запрещено: запись ключей в SQLite/логи/артефакты/UI; использование `--raw`, `hermes model`, `hermes auth` в автоматизации; чтение/.env пользователя Hermes.
- `model=default` без явного выбора не должен менять текущее поведение (обратная совместимость).
- Комментарии/JSDoc в production-коде — на русском; UI-тексты — на русском, полное имя «Ebb Orchestrator».

**Specialist Constraints:** Security (триггер при изменении env-allowlist/секретов): строго scoped env-инъекция; обязательный тест отсутствия утечки. Web (триггер при изменении UI): русские тексты, read-only блоки, e2e. Database: миграции не требуются (схема `scheduler_run_requests.model`/`agent_runs.model` уже существует; реестр — статический код).

**Review Focus:** (1) env-allowlist расширяется ровно для выбранной built-in модели, без утечки в логи/артефакты; (2) отмена `HERMES_MODEL_OVERRIDE_UNSUPPORTED` не ломает legacy `model=default`; (3) resume передаёт тот же выбор; (4) fingerprint включает имена provider/model без секретов и сохраняет dual-version decode.

## File / interface map

| Файл | Ответственность |
|---|---|
| `apps/server/src/modules/runtime/hermes/hermes-provider-registry.ts` (new) | Статический реестр built-in: `ProviderRegistryEntry { model, provider, envKey }`, `listSupportedModels()`, `resolveProviderForModel(model)`, `assertSupportedModel(model)`. Без секретов. |
| `apps/server/src/platform/config/orchestrator-env-loader.ts` (new) | Чтение `EBB_ORCHESTRATOR_HOME/.env` строго по allowlist имён из реестра; отсутствующий файл ок; приоритет: процессный env > `.env`; игнорирует неизвестные ключи. |
| `apps/server/src/modules/runtime/hermes/hermes-run-selection.ts` | Удалить `HERMES_MODEL_OVERRIDE_UNSUPPORTED`; валидация модели через реестр; legacy `default` без проверки. |
| `apps/server/src/modules/runtime/run-service.ts` | Проброс выбора модели в launch; отмена hold; resume использует сохранённую `agent_runs.model`. |
| `apps/server/src/app/routes/runs.ts` | `parseDispatchBody` валидирует модель через реестр (кроме `default`); ошибка 400 `RUN_REQUEST_MODEL_UNSUPPORTED`. |
| `apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts` | `configuredEnvironment()` — расширение allowlist ровно для `envKey` выбранной модели (без `*TOKEN/*SECRET`-суффиксов обхода); args: `--provider`, `-m`, `--oneshot`, `--ignore-user-config` (только при явном выборе); resume — тот же выбор. |
| `apps/server/src/modules/runtime/hermes/hermes-cli.ts` | Формирование CLI-args с учётом явного выбора (см. выше). |
| `apps/server/src/modules/context/context-provenance.ts` | `ContextFingerprintInputV1` + `providerName`/`model` (имена) с версионированием. |
| `apps/server/src/modules/context/resume-eligibility.ts` | Dual-version decode: старая v1-baseline без новых полей остаётся валидной. |
| `apps/server/src/app/routes/settings.ts` | Read-only `SettingsProjection` + `providerSelection: { defaultModel, models: [{model, provider, keyConfigured}] }` без значений ключей. |
| `apps/server/src/app/routes/hermes-status.ts` (new) | Read-only `GET /api/v1/hermes/status`: версия Hermes, дефолт провайдер/модель, `keyConfigured` (bool), без секретов/endpoint URL. |
| `packages/contracts/src/api.ts` | Типы `SettingsProjection.providerSelection`, `HermesStatusProjection`, `RUN_REQUEST_MODEL_UNSUPPORTED`. |
| `apps/web/src/features/settings/SettingsPage.tsx` | Блок «ИИ-провайдеры и модели»: read-only список моделей/провайдеров, отметка ключа (настроен/не настроен), дефолт. |
| `apps/web/src/features/runs/AgentRunPage.tsx` | Подпись «Модель: X» + «Провайдер: Y» (по `run.model` и реестру), пояснение «Выбирается в Ebb». |
| `README.md`, `docs/development/05-hermes.md`, `docs/architecture/.../02-current-state.md` | Обновить контракт: явный выбор провайдера/модели в Ebb; `.env` только в `EBB_ORCHESTRATOR_HOME/.env`; запреты чтения пользовательских Hermes secrets сохраняются. |
| Тесты | Новые/изменённые unit + acceptance (в каждой task). |

## Task contract

### Task 1 — Spike: CLI-контракт установленного Hermes (read-only)

**Depends on:** —

**Create:** `apps/server/test/e2e/hermes-provider-selection-spike.acceptance.test.ts` (marker-gated, read-only; не вызывает provider API).

**Interfaces:** Верифицирует на установленном Hermes: (а) `hermes chat --help` содержит `--provider`, `-m/--model`, `--oneshot`, `--ignore-user-config`, `--format stream-json`; (б) `hermes config get model.provider/model.default` маскирует credentials; (в) для перечня built-in моделей реестра — подтверждение стандартного env-имени (`<NAME>_API_KEY`) без чтения `.env`; (г) при `--ignore-user-config` — фиксируется политика предотвращения затенения: пользовательский `~/.hermes/.env` НЕ читается (запрет), фактический приоритет источника ключа определяется поведенчески (через CLI/наблюдение, без чтения файлов) и документируется; если пользовательский `.env` перекрывает переданный env — применяются уникальные имена в `.env` Ebb, либо документированная политика приоритета.

**RED:** Marker-тест падает, пока не выполнен с `EBB_RUN_PROVIDER_SPIKE_ACCEPTANCE='I_UNDERSTAND_THIS_IS_A_READ_ONLY_PROBE'` (guard), и не собран контракт.

**GREEN:** `EBB_RUN_PROVIDER_SPIKE_ACCEPTANCE='I_UNDERSTAND_THIS_IS_A_READ_ONLY_PROBE' pnpm --filter @ebb-orchestrator/server exec vitest run test/e2e/hermes-provider-selection-spike.acceptance.test.ts` → PASS; контракт CLI-семантики зафиксирован в комментариях теста (русские).

**Review Focus:** Никаких запросов к провайдеру; никакого чтения/вывода секретов; результат не «доказывает» provider acceptance.

### Task 2 — Реестр built-in провайдеров/моделей

**Depends on:** Task 1.

**Create:** `apps/server/src/modules/runtime/hermes/hermes-provider-registry.ts`; `apps/server/test/modules/runtime/hermes-provider-registry.test.ts`.

**Interfaces:** `ProviderRegistryEntry { model: string; provider: string; envKey: string }`; `listSupportedModels(): ProviderRegistryEntry[]`; `resolveProviderForModel(model): ProviderRegistryEntry | undefined`; `assertSupportedModel(model): void` (бросает `RUN_REQUEST_MODEL_UNSUPPORTED` для неизвестных, `default` не бросает). Env-имя — стандартное для built-in (например `openai-api` → `OPENAI_API_KEY`); никаких `EBB_*`-отображений здесь.

**RED:** Тест: `assertSupportedModel("nonexistent-model")` падает с `RUN_REQUEST_MODEL_UNSUPPORTED`; `resolveProviderForModel("default")` — undefined; `resolveProviderForModel` возвращает корректную запись для built-in.

**GREEN:** Реализация (статический список — фиксируется из контракта Hermes, см. Task 1); тест PASS.

**Review Focus:** Реестр — без секретов; отсутствие кастомных провайдеров (v1).

### Task 3 — Loader `.env` Ebb (`EBB_ORCHESTRATOR_HOME/.env`)

**Depends on:** Task 2.

**Create:** `apps/server/src/platform/config/orchestrator-env-loader.ts`; `apps/server/test/platform/config/orchestrator-env-loader.test.ts`.

**Interfaces:** `loadOrchestratorEnv(envKeyNames: string[]): { [name: string]: string }`; путь — `EBB_ORCHESTRATOR_HOME` (через существующий `orchestrator-home.ts`) + `.env`; отсутствующий файл → `{}`; читает только имена из переданного списка (allowlist); процессный env имеет приоритет (если переменная уже есть в process.env — не перезаписывать); неизвестные ключи игнорируются; ошибки парсинга — fail-closed (бросок).

**RED:** Тест: файл содержит `OPENAI_API_KEY=secret` и `OTHER=ignored`; loader возвращает только `OPENAI_API_KEY`; при `process.env.OPENAI_API_KEY` заданной — приоритет у process.env.

**GREEN:** Реализация; тест PASS.

**Review Focus:** Нет обхода allowlist; нет вывода секретов; не читается `~/.hermes/.env`.

### Task 4 — Отмена `HERMES_MODEL_OVERRIDE_UNSUPPORTED` и валидация модели через реестр

**Depends on:** Task 2.

**Modify:** `apps/server/src/modules/runtime/hermes/hermes-run-selection.ts`; `apps/server/src/modules/runtime/run-service.ts`; `apps/server/src/app/routes/runs.ts`; тесты `apps/server/test/modules/runtime/run-service.test.ts`, `apps/server/test/modules/runtime/hermes-managed-run-selection.test.ts`, `apps/server/test/app/runs-dispatch.test.ts`; fixture `apps/server/test/e2e/fixtures/task5c-safe-diagnostic.mjs`; `apps/server/test/e2e/hermes-session-handoff.acceptance.test.ts` (удалить устаревшее упоминание `HERMES_MODEL_OVERRIDE_UNSUPPORTED`).

**Interfaces:** Удалить бросок `HERMES_MODEL_OVERRIDE_UNSUPPORTED`; `validateTaskRequestModel(model)` теперь: `model === "default"` → без проверки; иначе `assertSupportedModel(model)` (бросает `RUN_REQUEST_MODEL_UNSUPPORTED` → route 400 с русским сообщением «Неизвестная модель. Доступные модели указаны в настройках.»).

**RED:** Существующий тест, ожидающий `HERMES_MODEL_OVERRIDE_UNSUPPORTED`, падает после удаления кода; новый тест на `RUN_REQUEST_MODEL_UNSUPPORTED` для неизвестной модели.

**GREEN:** Код+тесты приведены в соответствие; `pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/runtime/run-service.test.ts test/modules/runtime/hermes-managed-run-selection.test.ts test/app/runs-dispatch.test.ts` → PASS.

**Review Focus:** legacy `default` не затронут; сообщения — русские; никаких «тихих» ignore.

### Task 5 — Launch/resume Hermes с выбором провайдера/модели

**Depends on:** Tasks 3, 4.

**Modify:** `apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts`; `apps/server/src/modules/runtime/hermes/hermes-cli.ts`; тесты `apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts`.

**Interfaces:** `configuredEnvironment(modelSelection)` — allowlist расширяется ровно на `envKey` выбранной модели, если модель явная и отлична от `default`; env-значение берётся из `loadOrchestratorEnv`; при `default` — allowlist как сегодня. Args: при явном выборе — `--provider <P> -m <M> --oneshot --ignore-user-config` (плюс `--query-file`/`--format stream-json` как сегодня); при `default` — без изменений. Resume: `buildResumeArgs` использует сохранённую `agent_runs.model` (явную — с флагами, `default` — без).

**RED:** Тест: явная модель не попадает в env/args с `--provider`; `default` — без новых аргументов; resume с явной моделью передаёт те же флаги; env без `TOKEN/SECRET`-суффиксов не пропускается.

**GREEN:** Реализация; тест PASS.

**Review Focus:** allowlist остаётся strict (неизвестные переменные по-прежнему бросаются); отсутствие утечки ключа в stderr/логи/артефакты (тест redaction); legacy-path не меняется.

### Task 6 — Fingerprint: имена provider/model в контекстном hash

**Depends on:** Task 5.

**Modify:** `apps/server/src/modules/context/context-types.ts`; `apps/server/src/modules/context/context-provenance.ts`; `apps/server/src/modules/context/resume-eligibility.ts`; `apps/server/src/modules/runtime/run-service.ts` (поставщик значения `providerName` в контекстный input); тесты `apps/server/test/modules/context/context-provenance.test.ts`, `apps/server/test/modules/context/resume-eligibility.test.ts`.

**Interfaces:** `ContextFingerprintInputV1` дополняется `providerName?`/`model` (имена; `default` → без изменений, `providerName` опускается); версия Context Builder инкрементируется; значение `providerName` приходит из реестра (`resolveProviderForModel(run.model)`) и попадает в fingerprint-input в `run-service.ts`/assembler по production path; `decodeResumeContextBaselineV1` принимает обе схемы (старая v1 без новых полей остаётся валидной — dual-version); старые манифесты не пересчитываются; `assertExactFields` переводится на новую схему с сохранением парсинга старой.

**RED:** Тест: старое baseline без `providerName` декодируется; новое с `providerName` тоже; digest меняется при разных моделях и стабилен при равных.

**GREEN:** Реализация; тест PASS.

**Review Focus:** Только имена, без секретов/endpoint; resume-гейт не ломается для исторических Run.

### Task 7 — Read-only проекции и роут статуса Hermes

**Depends on:** Tasks 2, 3.

**Modify:** `apps/server/src/app/routes/settings.ts`; `packages/contracts/src/api.ts`; создать `apps/server/src/app/routes/hermes-status.ts`; `apps/server/test/app/api.test.ts`; `apps/server/test/app/settings-route.test.ts` (обновить строгие `toEqual` под `providerSelection`).

**Interfaces:** `SettingsProjection.providerSelection = { defaultModel, models: Array<{ model, provider, keyConfigured: boolean }> }` (ключи НЕ выводятся); `GET /api/v1/hermes/status` → `HermesStatusProjection = { hermesVersion: string | null; defaultProvider: string; defaultModel: string; keyConfigured: boolean; modelSelection: Array<{ model, provider, keyConfigured }> }` (read-only; без secret/endpoint; `hermes --version` — безопасно; при недоступности CLI — `hermesVersion: null`, остальное из реестра).

**RED:** Тест: проекция не содержит значений ключей; `/hermes/status` возвращает ключевые поля без секретов.

**GREEN:** Реализация; `pnpm --filter @ebb-orchestrator/server exec vitest run test/app/api.test.ts test/app/settings-route.test.ts` → PASS.

**Review Focus:** Никаких значений keyEnv/secret в ответе; отсутствие TL-вызова провайдера; `hermes --version` не падает при отсутствии Hermes.

### Task 8 — Web UI: Settings и Run

**Depends on:** Task 7.

**Modify:** `apps/web/src/features/settings/SettingsPage.tsx`; `apps/web/src/features/runs/AgentRunPage.tsx`; тесты компонентов (существующие vitest-наборы web).

**Interfaces:** SettingsPage — блок «ИИ-провайдеры и модели»: список моделей (модель — провайдер), статус ключа (Настроен/Не настроен — через `keyConfigured`), дефолт, пояснение: «Ключи хранятся в EBB_ORCHESTRATOR_HOME/.env и не отображаются. Модель для запуска выбирается в Ebb.». AgentRunPage — подпись «Модель: <model>» + «Провайдер: <provider>» (по run.model через maps клиентского реестра; для `default` — «по умолчанию (Ebb)»).

**RED:** Тест компонента: отсутствие keyConfigured → отображается «Не настроен»; run.model → корректная подпись; никаких упоминаний значений ключей.

**GREEN:** Реализация; web vitest PASS.

**Review Focus:** Read-only (нет редакторов); русский язык; «Ebb Orchestrator» без брендинг-ошибок.

### Task 9 — Документация

**Depends on:** Task 4.

**Modify:** `README.md` (строки ~370–376), `docs/development/05-hermes.md`, `docs/roadmap/02-current-state.md` (~150).

**Interfaces:** Описать: (а) явный выбор провайдера/модели в Ebb (built-in, список моделей в Settings); (б) ключи — только в `EBB_ORCHESTRATOR_HOME/.env`, не в репозиторий/SecretStore; (в) запреты чтения/копирования пользовательских Hermes secrets сохраняются; (г) удалить `HERMES_MODEL_OVERRIDE_UNSUPPORTED`-упоминания.

**GREEN:** `pnpm docs:check` → PASS.

**Review Focus:** Согласованность с Proposal18/Plan20; отсутствие противоречий.

### Task 10 — Финальные gates и security-review

**Depends on:** Tasks 1–9.

**Gates:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `git diff --check`, `pnpm docs:check`, web-e2e (если есть гейт), независимый security-review (esarбагент) по envy-allowlist/секретам.

**GREEN:** Все гейты PASS; security-review без новых HIGH-находок.

**BLOCKED when:** любой из гейтов падает или security-review фиксирует HIGH.

## Self-review

1. Все требования IN-005/Proposal18 имеют task owner: реестр (2), `.env` (3), отмена override (4), launch/resume (5), fingerprint (6), проекции (7), UI (8), документы (9), gates (10), spike (1).
2. DAG ацикличен: 1→2→(3,4)→5→6; 2,3→7→8; 4→9; 1–9→10.
3. Имена/interfaces согласованы: `ProviderRegistryEntry`, `loadOrchestratorEnv`, `RUN_REQUEST_MODEL_UNSUPPORTED`, `providerSelection`, `HermesStatusProjection`.
4. RED падает до изменений (тесты на новые требования), GREEN проверяет production path (адаптер/route/UI).
5. Команды конкретны и соответствуют существующим pnpm-скриптам/фильтрам.
6. High-risk: env-allowlist (Task5+security review), resume (Task5), fingerprint dual-decode (Task6) — покрыты.
7. План не содержит TBD/«при необходимости».
