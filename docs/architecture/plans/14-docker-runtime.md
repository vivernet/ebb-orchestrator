---
id: plan-14
kind: plan
roadmap: 01
stage: 12
status: proposed
title: Дополнительный Docker runtime для Ebb Orchestrator
summary: Добавить воспроизводимый Linux-контейнерный режим с одним контейнером Ebb Orchestrator, Git, Node.js 24 и Hermes, сохранив native Windows режим и fail-closed границы секретов, путей и восстановления.
created: 2026-09-24
updated: 2026-09-24
depends_on:
  - plan-09
  - plan-11
specs:
  - ../specs/03-production-readiness-design.md
  - ../specs/04-hermes-development-capabilities.md
evidence:
  - apps/server/src/main.ts
  - apps/server/src/platform/home/orchestrator-home.ts
  - apps/server/src/platform/security/infisical-secret-store.ts
  - apps/server/src/modules/runtime/hermes/hermes-config.ts
  - apps/server/src/modules/runtime/hermes/hermes-profile.ts
  - apps/server/src/modules/runtime/hermes/hermes-cli.ts
  - apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts
  - apps/server/src/modules/projects/repository-discovery.ts
  - apps/server/src/modules/projects/onboarding-service.ts
  - apps/server/src/app/routes/onboarding.ts
  - apps/server/src/modules/git/task-workspace-provisioner.ts
  - apps/server/src/modules/git/worktree-manager.ts
  - apps/server/src/modules/runtime/default-roles.ts
  - apps/server/src/modules/runtime/role-contract.ts
  - apps/server/src/platform/database/sqlite-database.ts
  - apps/server/src/platform/database/backup-service.ts
  - apps/server/test/platform/database/backup.test.ts
  - scripts/hermes-dev.mjs
  - scripts/hermes-provider-smoke.mjs
  - scripts/hermes-provider-smoke.test.mjs
  - scripts/project-env.test.mjs
  - scripts/run-server.js
  - README.md
---

# Дополнительный Docker runtime для Ebb Orchestrator — draft implementation plan

> **Для агентного исполнения:** REQUIRED SKILL: `ebb-execute-plan`.
>
> Это draft. В данном изменении production-код, Docker-файлы, roadmap и тесты не меняются; ниже зафиксирован проверяемый порядок будущей реализации.

**Goal:** Добавить opt-in Docker-режим с одним Linux-контейнером, в котором работают Ebb Orchestrator, Git, Node.js 24 и Hermes, при этом native Windows остаётся default-режимом и все durable данные контейнерного режима живут под `~/.ebb-orchestrator`.

**Architecture:** Режим выбирается явной конфигурацией и не меняет существующую native composition без `EBB_RUNTIME_MODE=docker`. Контейнер запускает один server process и один Hermes runtime по существующему контракту; per-task containers, worker pool и отдельная persistence technology не вводятся. Host Docker Desktop публикует только loopback-порт по умолчанию, а bind-mounted Orchestrator home содержит SQLite, WAL, runtime, artifacts, logs, backups, worktrees и `projects`.

## Native/Docker boundary

| Режим | Вход и процесс | Home/secrets | Что запрещено |
|---|---|---|---|
| Native Windows (default) | Отсутствующий `EBB_RUNTIME_MODE` или `native`; существующие `pnpm start`, `scripts/run-server.js`, Windows process handling и host paths | Platform-native `EBB_ORCHESTRATOR_HOME`/`USERPROFILE`, default OS keyring; Infisical только при явном `EBB_SECRET_BACKEND=infisical` | Нельзя требовать Docker, Linux paths или менять native keyring semantics |
| Docker (opt-in) | Явный Compose запуск; один Linux-контейнер с server, Git, Node.js 24 и Hermes | Host bind mount `${EBB_ORCHESTRATOR_HOME}` (по умолчанию `~/.ebb-orchestrator`) → `/home/ebb/.ebb-orchestrator`; `InfisicalSecretStore` обязателен | Нет keyring fallback, per-task containers, Docker socket, implicit migration или обхода `projects` containment |

Docker mode не является скрытой заменой native mode: его команды, listener binding, home и secret preflight проверяются отдельно. Для Docker canonical project root — `${EBB_ORCHESTRATOR_HOME}/projects` (по умолчанию `~/.ebb-orchestrator/projects`); native absolute repository paths сохраняются только в native mode.

**Tech Stack:** Docker Engine/Docker Desktop, Compose Specification, Linux `node:24.15-bookworm-slim`, Git, Node.js `>=24.15 <25`, pnpm `12.4.2`, TypeScript, Fastify, Vitest, SQLite/WAL, Hermes, Infisical Universal Auth Machine Identity, native Windows process execution.

**Source of Truth:**

- `docs/architecture/specs/03-production-readiness-design.md`
- `docs/architecture/specs/04-hermes-development-capabilities.md`
- `apps/server/src/main.ts`
- `apps/server/src/platform/home/orchestrator-home.ts`
- `apps/server/src/platform/security/secret-store.ts`
- `apps/server/src/platform/security/infisical-secret-store.ts`
- `apps/server/src/modules/runtime/hermes/hermes-config.ts`
- `apps/server/src/modules/runtime/hermes/hermes-profile.ts`
- `apps/server/src/modules/runtime/hermes/hermes-cli.ts`
- `apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts`
- `apps/server/src/modules/projects/repository-discovery.ts`
- `apps/server/src/modules/projects/onboarding-service.ts`
- `apps/server/src/app/routes/onboarding.ts`
- `apps/server/src/modules/git/task-workspace-provisioner.ts`
- `README.md` и `docs/development/05-hermes.md`

## REQUIREMENTS_BLOCKED: load-bearing inputs not yet received

Следующие пункты нельзя закрывать догадкой; до получения решения/артефакта они блокируют соответствующую реализацию, но не меняют `status: proposed`:

1. **Hermes image artifact:** `HERMES_SOURCE`, exact `HERMES_VERSION`, `HERMES_SHA256`, approved `HERMES_ARCHITECTURES` и `HERMES_BINARY_NAME` с владельцем и воспроизводимой fetch-проверкой. Без них Task 4 может проверять контракт, но не заявлять production-reproducible image.
2. **Provider credential bridge:** текущий код подтверждает только два разных уровня evidence: `inception` настроен в `scripts/hermes-dev.mjs`/`scripts/hermes-provider-smoke.mjs` (`api`, `base_url`, `key_env=INCEPTION_API_KEY`, `model=mercury-2.5`, `HERMES_MODEL=inception`), а `local` присутствует как `DefaultModels` provider с моделями `llama-3.1-8b`, `llama-3.1-70b`, `mistral-large`. Текущий `HermesRuntimeAdapter`/`hermes-profile` не содержит provider-secret bridge; provider-specific setting is only the allowlisted `HERMES_MODEL`, а `SecretStore` service/name для LLM не подтверждены. `scripts/project-env.test.mjs` подтверждает только native development dotenv parser и не разрешает переносить `INCEPTION_API_KEY` в Docker host `.env`. Поэтому `inception` — единственный подтверждённый credentialed candidate, `local` — только существующий model identifier без Docker secret contract; `openai`, `anthropic` и любые иные provider contracts здесь не заявляются. Новое remote service/name → child env mapping требует отдельного решения; до него — `REQUIREMENTS_BLOCKED`.
3. **CI/release wiring:** изменение `.github/workflows/production-gates.yml`, registry publishing и production rollout не подтверждены scope этого плана; они остаются отдельным решением, а Task 9 даёт только локальное smoke evidence.

До снятия blocker implementation не должна добавлять URL, model alias, secret name, architecture, image checksum или CI contract по аналогии с другим provider.

**Baseline:** ветка `develop`, HEAD `c674a365408e89f7df5fdd5d0772a08492cbf780` на момент подготовки draft.

## Governance evidence и naming decision

`docs/architecture/plans/governance/00-03-plan-naming-policy.md` требует шаблон `XX-name.md`, YAML frontmatter и регистрацию плана в roadmap. В каталоге уже существуют `plan-09`, `plan-11`, `plan-13`; текущий `14-docker-runtime.md` является незакоммиченным draft, а не зарегистрированным plan. Поэтому выбран следующий основной номер `14`, а предложенный пользователем stage `12` сохранён. Текущий `docs/roadmap/01-roadmap.md` не содержит stage 12 или plan-14. Этот draft остаётся `status: proposed`; после approval parent controller должен зарегистрировать `plan-14` в canonical `docs/roadmap/01-roadmap.md` в Stage 12 и Plan Register. Команда `pnpm docs:roadmap` вызывает `scripts/roadmap-generator-cli.mjs` и по умолчанию пишет `docs/roadmap/generated.md`; она не обновляет canonical `docs/roadmap/01-roadmap.md`, поэтому генерация — отдельная проверка/артефакт, а не молчаливое обновление roadmap.

## Plan lifecycle

- `proposed`: текущий draft после review/fix, до approval; наличие файла не означает регистрацию или completed.
- `planned`: parent controller выставляет этот status только после approval и регистрации `plan-14` в Stage 12/Plan Register canonical `docs/roadmap/01-roadmap.md`.
- `in_progress`: выставляется при фактическом исполнении approved tasks; roadmap registration и plan status обновляются отдельным governance-действием.
- `completed`: допустим только после всех focused/full/recovery/security/docs gates и release decision; review draft или наличие implementation plan не являются completion evidence.

## Acceptance Criteria

- [ ] Docker-режим запускается одной Compose-службой и содержит Ebb Orchestrator, Git, Node.js 24 и Hermes; per-task containers отсутствуют.
- [ ] Native Windows запуск без `EBB_RUNTIME_MODE=docker` продолжает использовать существующие Windows paths, process handling и default native keyring.
- [ ] В контейнере `EBB_ORCHESTRATOR_HOME=/home/ebb/.ebb-orchestrator`; на Windows host этот путь bind-mounted из `${EBB_ORCHESTRATOR_HOME}` по умолчанию `%USERPROFILE%\\.ebb-orchestrator`.
- [ ] `projects`, SQLite, WAL sidecars, runtime, artifacts, logs, backups и worktrees persistent и не находятся в image layer или ephemeral container filesystem.
- [ ] Docker mode rejects an absolute project path outside the resolved `${EBB_ORCHESTRATOR_HOME}/projects` (default `~/.ebb-orchestrator/projects`); native mode сохраняет совместимость с существующими absolute repository paths.
- [ ] При `EBB_SECRET_BACKEND=infisical` неполная Machine Identity configuration останавливает startup до открытия listener; fallback на keyring в Docker mode отсутствует.
- [ ] LLM provider credentials читаются только из Infisical через narrow allowlist, попадают только в child Hermes environment на время запуска, не попадают в logs, SQLite, UI/API, artifacts, image layers или diagnostics.
- [ ] Provider и model выбираются отдельными non-secret settings; model не может выбрать secret key вне allowlist и `HERMES_MODEL` передаётся только целевому Hermes child process.
- [ ] Healthcheck доказывает реальный HTTP backend, shutdown обрабатывает `SIGTERM`/`SIGINT`, а default host binding — loopback на host и `0.0.0.0` только внутри контейнера.
- [ ] Документация содержит native и Docker команды, назначение команд, volume map, lifecycle, health, backup/recovery, `.env`, Infisical Machine Identity, запись/выбор LLM provider/model и troubleshooting без real secrets.
- [ ] Focused tests, Docker build/smoke, security scan и project quality gates имеют воспроизводимые команды и acceptance evidence.

## Global Constraints

- Не изменять workflow, approval semantics, Git merge policy или AgentRuntime contract.
- Не добавлять per-task containers, distributed workers, Kubernetes, alternate secret backend или вторую persistence technology.
- Docker — дополнительный opt-in режим; native Windows — default и обязательный supported path.
- `EBB_SECRET_BACKEND=infisical` остаётся explicit selection; native mode без этого флага сохраняет default keyring.
- Production Docker startup никогда не принимает fake/test SecretStore или alternate backend через environment; fake runtime допускается только через явный DI test harness, который не импортирует production `main.ts`.
- `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_PROJECT_ID`, `INFISICAL_ENVIRONMENT` обязательны для Infisical; `INFISICAL_SECRET_PATH` и `INFISICAL_SITE_URL` остаются optional согласно существующему adapter contract.
- Local `~/.ebb-orchestrator/.env` разрешён только для bootstrap credentials и runtime settings. В Git хранится только `.env.example`; real `.env` не создаётся, не копируется в image и не попадает в diagnostics.
- LLM provider API keys и другие provider credentials не разрешается помещать в `.env`; они создаются/хранятся в Infisical.
- SQLite остаётся authoritative persistence; plaintext secret values не записываются в SQLite, logs, artifacts, repositories, UI/API responses или generated image.
- Git и process invocation используют существующие typed `shell:false` границы; Docker entrypoint не выполняет repository-controlled shell scripts.
- Пути проекта и worktree проходят canonicalization, containment и symlink/junction policy до открытия или удаления.
- Комментарии, JSDoc и пользовательская документация — на русском; технические identifiers, env names и commands сохраняются дословно.
- В этом draft нельзя выполнять `pnpm docs:roadmap`, тесты, Docker build или `git commit`; реализацию и quality gates выполняет parent controller после review.

## Review Focus

1. Native launch без Docker variables не меняет `USERPROFILE`/keyring semantics и не принимает Linux-only paths.
2. Docker launch с отсутствующим `.env` или неполной Infisical configuration завершается до listener и не создаёт ложные secret metadata rows.
3. Project onboarding с `C:\outside`, `/tmp/outside` или symlink из `projects` наружу отклоняется в Docker mode, но существующий native absolute-path contract не ломается.
4. Provider evidence is tested without invention: `inception` may use only the separately approved `INCEPTION_API_KEY` mapping; `local` has no confirmed secret contract and must not be turned into one. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and other unconfirmed names are rejected; `PATH`, `HOME`, runtime settings и unrelated provider credentials не становятся неограниченным passthrough.
5. Ошибка Infisical, child-process failure или shutdown не выводит credential в thrown error, log line, SQLite row, HTTP response или artifact.
6. Удаление/restart container не удаляет bind-mounted durable data; WAL checkpoint и restore не принимают одиночную копию live `.db` как валидный backup.
7. Порт по умолчанию доступен только через `127.0.0.1`; `0.0.0.0` требует явного operator choice и документированного security warning.
8. Health endpoint действительно обслуживает запущенный backend: connection refusal и unhealthy status делают smoke job красной.

## File / Interface Map

| Область | Create | Modify | Planned contract |
|---|---|---|---|
| Runtime mode | `apps/server/src/platform/runtime/runtime-mode.ts`, `apps/server/test/platform/runtime/runtime-mode.test.ts` | `apps/server/src/main.ts`, `apps/server/src/platform/process/server-startup.ts`, `apps/server/test/platform/process/server-startup.test.ts` | `RuntimeMode = "native" | "docker"`; native default; validated Docker-only host/home policy; startup is callable without import-time side effects |
| Home paths | — | `apps/server/src/platform/home/orchestrator-home.ts`, its tests | `OrchestratorHomePaths.projects`; all durable paths derive from `root` |
| Project containment | — | `apps/server/src/modules/projects/repository-discovery.ts`, `onboarding-service.ts`, `app/routes/onboarding.ts`, `modules/git/task-workspace-provisioner.ts`, `modules/git/worktree-manager.ts` | One shared canonical containment policy is applied at onboarding, startup reconciliation, persisted consumers, workspace provisioning, delete/cleanup; native compatibility path remains explicit |
| Secret bridge | `apps/server/src/modules/runtime/hermes/hermes-provider-registry.ts`, `apps/server/src/modules/runtime/hermes/hermes-secret-resolver.ts`, focused tests | `hermes-config.ts`, `hermes-profile.ts`, `hermes-runtime-adapter.ts`, `modules/execution/mcp/submit-result-tool.ts`, `main.ts` | Evidence-closed registry (`inception` candidate, `local` non-credentialed identifier); exact Infisical→child mapping is `REQUIREMENTS_BLOCKED` until approved; mandatory `SecretRedactor` boundary |
| Startup test seam | `apps/server/src/test-support/create-test-server.ts`, `apps/server/test/platform/process/server-startup.test.ts` | `apps/server/src/main.ts` | Only non-production DI harness may inject fake `SecretStore`/fake runtime; production composition always selects Infisical in Docker |
| Docker image | `docker/Dockerfile`, `docker/install-hermes.sh`, `docker/entrypoint.sh`, `docker/healthcheck.sh`, `docker/.dockerignore`, `docker/Dockerfile.test` only for the isolated harness | — | Node/pnpm are pinned by repository inputs; Hermes artifact coordinates/checksum/architectures come from an approved pinned input, never invented in this plan |
| Compose | `docker/compose.yml`, `.env.example` | — | one service, loopback publish default, bind-mounted home, healthcheck, restart policy, explicit env file |
| Persistence | `docker/backup.sh`, `docker/restore.sh`, focused persistence tests | `apps/server/src/platform/database/backup-service.ts`, `apps/server/src/platform/database/sqlite-database.ts`, `orchestrator-home.ts` | Explicit online/offline algorithm, lock/stop/checkpoint, staged manifest/checksum/`quick_check`, original preservation |
| Native compatibility | — | `scripts/run-server.js`, `scripts/hermes-dev.mjs` only where mode dispatch is required | existing native commands remain valid; Docker commands are explicit and separate; full migration tooling is deferred |
| Documentation | `docs/development/08-docker-runtime.md` | `README.md`, `docs/development/05-hermes.md` | operator runbook with commands, lifecycle, recovery, secrets, troubleshooting |
| Docker image contract evidence | `scripts/docker-image-contract.test.mjs` | — | static Dockerfile/artifact contract only; the executable local smoke remains Task 9 and uses an isolated test-only DI harness; no CI workflow or production alternate backend change in this plan |

## Dependency Graph

```text
Task 1 runtime/config/startup contract
  ├── Task 2 home + all persisted project/worktree containment
  ├── Task 3 Infisical → Hermes provider registry, preflight and redaction
  │     └── Task 4 Docker image, Hermes artifact precondition and entrypoint
  └── Task 5 Compose lifecycle, host binding and signals
Task 2 + Task 5
  └── Task 6 SQLite WAL, backup and recovery
Task 1 + Task 2 + Task 5 + Task 6
  └── Task 7 native compatibility; migration tooling deferred
Task 1 + Task 2 + Task 3 + Task 4 + Task 5 + Task 6 + Task 7
  └── Task 8 documentation and operator runbook
Task 1 + Task 2 + Task 3 + Task 4 + Task 5 + Task 6 + Task 7 + Task 8
  └── Task 9 isolated local Docker smoke evidence (CI workflow deferred)
Task 1–9
  └── Task 10 final gates, rollback rehearsal and release decision
```

## Task 1: Зафиксировать mode/config contract и startup boundary

**Purpose:** Ввести typed distinction между native и Docker режимами, не меняя default native behavior, и сделать host binding, home, port и no-open-ui policy явными до создания listener.

**Depends on:** нет; baseline composition в `apps/server/src/main.ts`.

**Files:**

- Create: `apps/server/src/platform/runtime/runtime-mode.ts` — `RuntimeMode`, `RuntimeModeConfig`, `resolveRuntimeMode`, `validateRuntimeModeConfig`.
- Create: `apps/server/src/platform/process/server-startup.ts` — `ServerStartupDeps`, `createProductionServer`, `startServer`; owns composition/startup cleanup and accepts only explicit test DI.
- Create: `apps/server/test/platform/runtime/runtime-mode.test.ts` — pure config contract tests.
- Create: `apps/server/test/platform/process/server-startup.test.ts` — startup harness tests for import side effects, readiness and signal cleanup; this is the replacement for the absent main-module side-effect test.
- Create: `apps/server/src/test-support/create-test-server.ts` — non-production harness that injects fake `SecretStore`, fake runtime and fake listener through `ServerStartupDeps`; it must never be imported by production `main.ts`.
- Modify: `apps/server/src/main.ts` — reduce import-time work to invoking `startServer` from `server-startup.ts`; no database, lock, listener or signal side effect may happen merely by importing the module.
- Do not modify `apps/server/src/platform/config/app-config.ts` for this contract: the existing file exports only `Platform`; runtime mode owns its own exact types.

**Interfaces:**

- `runtime-mode.ts` consumes only the explicitly typed subset of `process.env` and produces `RuntimeModeConfig` with `mode`, `bindHost`, `port`, `noOpenUi`, `projectsRoot`, `orchestratorHome` and the validated secret-backend selection.
- `server-startup.ts` consumes `RuntimeModeConfig`, the existing `OrchestratorHomePaths`, selected `SecretStore`, existing `startSystem`/`shutdownSystem` dependencies and an injected `listen` function; it produces an owned `ServerHandle` with `ready`, `abortStartup` and `shutdown` for `main.ts` and the test harness.
- `create-test-server.ts` is the sole consumer of test DI and is compiled/started only by `Dockerfile.test`/tests; it may inject `InMemorySecretStore`, but production `main.ts` rejects any test seam.
- Invariant: absent `EBB_RUNTIME_MODE` resolves to `native`; `docker` requires `EBB_SECRET_BACKEND=infisical`, `EBB_ORCHESTRATOR_HOME` and `EBB_ORCHESTRATOR_NO_OPEN_UI=1`; Docker binds internally to `0.0.0.0`, while Compose host publishing remains loopback by default.
- Signal contract: `SIGINT`/`SIGTERM` before readiness set one idempotent abort flag, prevent `listen`, stop any started workers, close DB and release the lock, then exit with a non-zero startup-aborted result; after readiness they call the existing `shutdownSystem` once. Signals arriving during reconciliation are not ignored and never leave a held lock or open database.

**Acceptance for this task:**

- Native defaults are byte-for-byte compatible for host selection, home resolution and keyring selection.
- Invalid mode, port, host or partial Docker/Infisical configuration fails with a generic configuration error before lock/listener side effects.
- `EBB_ORCHESTRATOR_NO_OPEN_UI=1` is honored and no browser launch is attempted in either headless mode.
- Importing `main.ts` in a test does not create a database, acquire a lock, register signal handlers or open a listener.
- A signal before readiness and a signal during reconciliation are each tested for idempotent cleanup; no listener starts after abort.

- [ ] Step 1: RED — add tests for native default, Docker validation, invalid port/host, no-open-ui, import-without-side-effects, pre-listener failure, signal during reconciliation and cleanup after abort.
- [ ] Step 2: Run RED
  Run: `pnpm --filter @ebb-orchestrator/server test -- test/platform/runtime/runtime-mode.test.ts test/platform/process/server-startup.test.ts`
  Expected: FAIL because runtime mode, the side-effect-free startup seam and abort cleanup do not exist.
- [ ] Step 3: minimal implementation
  - Add only the typed mode/config parser and inject it through `main.ts`.
  - Keep native keyring default and existing `127.0.0.1` native default.
  - Do not add a new secret backend or per-task container path.
- [ ] Step 4: Run GREEN
  Run: `pnpm --filter @ebb-orchestrator/server test -- test/platform/runtime/runtime-mode.test.ts test/platform/process/server-startup.test.ts`
  Expected: PASS; invalid Docker configuration fails before listener creation.
- [ ] Step 5: neighboring checks
  Run: `pnpm --filter @ebb-orchestrator/server typecheck`
  Expected: exit 0 with no new TypeScript diagnostics.
- [ ] Step 6: `git diff --check`
  Expected: exit 0, empty output.

## Task 2: Расширить Orchestrator home и закрыть Docker project root

**Purpose:** Сделать `~/.ebb-orchestrator/projects` canonical root для Docker projects и сохранить native support для существующих absolute repository paths.

**Depends on:** Task 1.

**Files:**

- Modify: `apps/server/src/platform/home/orchestrator-home.ts` — `OrchestratorHomePaths`, `resolveOrchestratorHome`.
- Modify: `apps/server/test/platform/home/orchestrator-home.test.ts` — `projects` path for POSIX and Windows.
- Modify: `apps/server/src/modules/projects/repository-discovery.ts` — Docker root policy, canonical path and symlink/junction containment helper.
- Modify: `apps/server/src/modules/projects/onboarding-service.ts` — import/copy/clone destination under projects root in Docker mode.
- Modify: `apps/server/src/app/routes/onboarding.ts` — map containment failure to safe client error without host path leakage.
- Modify: `apps/server/src/main.ts` — startup reconciliation of persisted repository records before listener readiness; validate every stored repository path against the resolved mode/root and mark/reject unsafe records without creating workspaces.
- Modify: persisted repository consumers that read or mutate `repository_path` (repository discovery/onboarding, task dispatch/reconciliation and cleanup/delete services) — route every read, worktree creation and deletion through the shared policy, not only the HTTP onboarding route.
- Modify: `apps/server/src/modules/git/task-workspace-provisioner.ts` — use the resolved `projects`/worktree root and reject an out-of-root repository before creating a worktree.
- Modify: `apps/server/src/modules/git/worktree-manager.ts` and repository/task delete and cleanup paths — canonicalize and contain before remove/recursive cleanup; never follow a symlink/junction outside the root.
- Create: `apps/server/test/modules/projects/onboarding-service.test.ts`, `apps/server/test/app/onboarding.test.ts` — Docker import/containment regressions.
- Modify: `apps/server/test/modules/projects/repository-discovery.test.ts`, `apps/server/test/modules/git/task-workspace-provisioner.test.ts`, `apps/server/test/modules/git/worktree-manager.test.ts` — Docker root, canonicalization and cleanup regressions. The canonical task-workspace test path is exactly `apps/server/test/modules/git/task-workspace-provisioner.test.ts`; startup reconciliation assertions live in `apps/server/test/platform/process/server-startup.test.ts`.

**Interfaces:**

- Consumes: `RuntimeModeConfig`, `OrchestratorHomePaths`, existing `repository_path` onboarding input and persisted repository/task rows.
- Produces: `OrchestratorHomePaths.projects = join(root, "projects")`; `isPathContainedByRoot(candidate, root)` with canonicalization and symlink/junction rejection; Docker onboarding and startup reconciliation results whose usable `repository_path` is below `projects`.
- Startup reconciliation contract: `main.ts` calls the shared policy before opening the listener; each persisted repository is checked, unsafe/missing paths produce a safe diagnostic and no workspace/delete side effect, and reconciliation is complete before readiness.
- Consumer contract: repository discovery, persisted task/repository consumers, `TaskWorkspaceProvisioner`, worktree manager, delete and cleanup paths all consume the same containment result. No caller may join/delete a stored path directly.
- Invariant: native mode keeps existing absolute path behavior; Docker mode never reads or writes a repository outside `projects` unless a separately approved import operation first materializes it inside that root.

**Acceptance for this task:**

- `projects`, `artifacts`, `runtime`, `logs`, `backups`, `worktrees` and database all derive from one resolved root.
- `..`, alternate separators, case/drive edge cases, symlink and junction escapes are rejected in Docker mode.
- Startup reconciliation is tested with safe, missing and outside persisted repository rows and completes before the listener can report ready.
- `TaskWorkspaceProvisioner`, worktree creation, repository deletion and cleanup each reject outside/symlink escape paths and do not partially delete.
- Existing native repository discovery tests for absolute Windows paths remain green.

- [ ] Step 1: RED — add POSIX/Windows home path tests; Docker containment cases for outside path, traversal, symlink and valid nested repository; startup persisted-row reconciliation; `TaskWorkspaceProvisioner`, worktree, delete and cleanup escape tests.
- [ ] Step 2: Run RED
  Run: `pnpm --filter @ebb-orchestrator/server test -- test/platform/home/orchestrator-home.test.ts test/modules/projects/repository-discovery.test.ts test/modules/projects/onboarding-service.test.ts test/app/onboarding.test.ts test/modules/git/task-workspace-provisioner.test.ts test/modules/git/worktree-manager.test.ts test/platform/process/server-startup.test.ts`
  Expected: FAIL because `projects` is not part of home paths and the shared Docker containment policy is not applied to startup reconciliation or persisted consumers.
- [ ] Step 3: minimal implementation
  - Add `projects` without moving native data.
  - Apply canonical containment only when `mode === "docker"` and call it from startup reconciliation, persisted consumers, `TaskWorkspaceProvisioner`, worktree, delete and cleanup paths.
  - Keep database-stored paths absolute and preserve existing schema contracts.
- [ ] Step 4: Run GREEN
  Run: `pnpm --filter @ebb-orchestrator/server test -- test/platform/home/orchestrator-home.test.ts test/modules/projects/repository-discovery.test.ts test/modules/projects/onboarding-service.test.ts test/app/onboarding.test.ts test/modules/git/task-workspace-provisioner.test.ts test/modules/git/worktree-manager.test.ts test/platform/process/server-startup.test.ts`
  Expected: PASS; Docker escape attempts fail, persisted unsafe rows cause no side effects and native absolute paths remain supported.
- [ ] Step 5: neighboring checks
  Run: `pnpm --filter @ebb-orchestrator/server test -- test/platform/security/path-resolver.test.ts test/platform/security/environment-builder.test.ts`
  Expected: PASS with no broadened path or environment capabilities.
- [ ] Step 6: `git diff --check`
  Expected: exit 0, empty output.

## Task 3: Реализовать Infisical → Hermes narrow credential resolution

**Purpose:** Подготовить узкий Infisical → Hermes bridge без передачи всего `process.env` и без сохранения plaintext secret вне краткоживущего child environment; не объявлять новый provider contract существующим.

**Depends on:** Task 1; existing `SecretStore` and `InfisicalSecretStore` contracts from plan-09.

**Files:**

- Create: `apps/server/src/modules/runtime/hermes/hermes-provider-registry.ts` — closed `HermesProviderRegistry` supporting multiple provider entries, starting with Inception Labs.
- Create: `apps/server/src/modules/runtime/hermes/hermes-secret-resolver.ts` — `HermesSecretResolver`, `HermesProviderCredentialPolicy`, `SecretRedactor` boundary and `ALLOWED_HERMES_PROVIDER_ENV_KEYS`.
- Create: `apps/server/test/modules/runtime/hermes/hermes-secret-resolver.test.ts` — registry, allowlist, missing secret, error redaction, no-provider and provider/model tests.
- Create: `apps/server/test/modules/runtime/hermes/hermes-secret-leak.test.ts` — child stdout/stderr containing a sentinel credential is redacted before `ArtifactStore`, diagnostics, `RunOutcome` or SQLite consumers.
- Modify: `apps/server/src/platform/security/secret-store.ts` only if a typed non-secret resolution error is required; preserve the existing interface.
- Modify: `apps/server/src/modules/runtime/hermes/hermes-config.ts` — define non-secret `HermesRuntimeSettings` and typed provider/model inputs; it must not hold credential values.
- Modify: `apps/server/src/modules/runtime/hermes/hermes-profile.ts` — generate an isolated Hermes config/profile from approved non-secret mapping and merge only generated allowlisted child env values.
- Modify: `apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts` and `hermes-cli.ts` — consume `HermesLaunchContract`, resolve immediately before spawn, redact child stdout/stderr, and remove credential values after child exit.
- Modify: `apps/server/src/modules/runtime/hermes/hermes-config.ts`/`hermes-runtime-adapter.ts` — owner is the Hermes runtime adapter; the child-process launcher is the only consumer of the resolved credential map.
- Modify: `apps/server/src/platform/diagnostics/*`, `apps/server/src/platform/artifacts/*`, run-outcome persistence and `apps/server/src/main.ts` — apply the redactor before every ArtifactStore, diagnostics, `RunOutcome` or SQLite boundary and inject the selected production `SecretStore`.
- Modify: `apps/server/test/modules/runtime/hermes/hermes-profile.test.ts`, `hermes-runtime-adapter.test.ts`, `apps/server/test/platform/diagnostics/diagnostics.test.ts`, `apps/server/test/platform/artifacts/artifact-store.test.ts` — integration assertions.

**Interfaces:**

- The planned registry must distinguish observed identifiers from supported runtime contracts. Current evidence is: `inception` is configured by `scripts/hermes-dev.mjs` and `scripts/hermes-provider-smoke.mjs` with API `https://api.inceptionlabs.ai/v1`, `key_env=INCEPTION_API_KEY`, model `mercury-2.5`, and launch alias `HERMES_MODEL=inception`; `local` is present only in `DefaultModels` with the three model identifiers recorded in the blocker section. The current server adapter does not resolve either provider through `SecretStore`; it only allowlists `HERMES_MODEL` and rejects supplied credential names.
- `inception` is the first credentialed provider entry. The approved `SecretStore` mapping is `service=hermes`, `name=INCEPTION_API_KEY`. This exact service/name pair binds to `SecretStore.resolveForService("hermes", "INCEPTION_API_KEY")` and injects the resolved value as the child env key. Until its tests and validation exist, additional providers remain `REQUIREMENTS_BLOCKED`.
- `local` remains a non-credentialed existing model identifier only. It may be retained for fake/test or existing role metadata paths, but this plan must not invent an endpoint, API key, model alias or Infisical mapping for it. `openai`, `anthropic` and every other unobserved provider are rejected as `REQUIREMENTS_BLOCKED`.
- `HermesRuntimeSettings` contains only non-secret provider/model input, `hermesHome`, `hermesConfigPath` and runtime settings. An absent provider is valid for health/startup and fake/test runs that do not launch an LLM; no provider preflight or child credential is created in that case. A selected credentialed provider requires a supported model and an approved service/name mapping before readiness.
- `HermesProviderConfig` is proposed non-secret metadata with only evidence-backed fields; `secretService`, `secretName` and `childEnvName` are unresolved decision fields until the mapping above is approved. It never carries a resolved value.
- `HermesLaunchContract` is `{ settings: HermesRuntimeSettings, providerConfig?: HermesProviderConfig, childEnv: Readonly<Record<string, string>>, isolatedConfigPath: string, owner: "hermes-runtime-adapter" }`. Only `childEnv` is passed to the child; its provider credential mapping is populated only after the approved decision and never by arbitrary `*_API_KEY` names.
- `HermesSecretResolver.resolve(settings)` calls `SecretStore.resolveForService` only for the selected, approved registry entry; unknown provider/model, unresolved mapping, missing/empty secret and unexpected env names reject without returning a value. It never accepts arbitrary `*_API_KEY` names or whole-process passthrough.
- Bootstrap syntax validation happens before lock/listener creation: validate the selected provider/model names and Infisical environment syntax without remote calls. Readiness then performs remote Infisical reachability/authentication and selected-provider-secret preflight only when a provider is configured. The production Docker composition always uses `InfisicalSecretStore`; fake/in-memory stores are permitted only through the explicit non-production DI harness and are rejected by production `main.ts`.
- `SecretRedactor` is constructed with the transient resolved values and runs before child stdout/stderr enters `ArtifactStore`, diagnostics, `RunOutcome` or SQLite. It also redacts thrown errors and sanitized logs; the sentinel child stdout/stderr test must prove the credential never reaches any of those sinks.

**Acceptance for this task:**

- The observed `inception` configuration is preserved exactly, but its server-side credential mapping is not marked executable until the service/name decision is approved; unresolved or unsupported providers return `REQUIREMENTS_BLOCKED` rather than silently using guessed contracts.
- Fake `SecretStore` proves that only the selected, approved `inception` mapping is resolved and injected; `local` and no-provider paths perform no provider-secret lookup and create no secret metadata row.
- Bootstrap syntax failure occurs before listener; remote Infisical unavailability and selected-secret failure occur as readiness failures with no false secret metadata rows.
- Unrelated `process.env` keys and credentials for other providers are absent from the Hermes child environment.
- Isolated Hermes config is generated under the runtime home, with owner/consumer recorded in the launch contract and no credential value written to config/profile files.
- Resolver, spawn, child stdout/stderr, diagnostics, artifact, outcome and persistence tests contain no resolved secret value after redaction.
- Existing Hermes profile setup remains valid when no provider credential is needed by a fake/test runtime.

- [ ] Step 1: RED — add tests for the evidence matrix (`inception` candidate, `local` non-credentialed identifier), unresolved service/name blocker, `REQUIREMENTS_BLOCKED` unknown provider, syntax/remote/selected-secret preflight ordering, no-provider behavior, unrelated env exclusion, isolated config generation, redacted error and child stdout/stderr cleanup.
- [ ] Step 2: Run RED
  Run: `pnpm --filter @ebb-orchestrator/server test -- test/modules/runtime/hermes/hermes-secret-resolver.test.ts test/modules/runtime/hermes/hermes-secret-leak.test.ts test/modules/runtime/hermes/hermes-profile.test.ts test/modules/runtime/hermes/hermes-runtime-adapter.test.ts test/platform/security/infisical-secret-store.test.ts`
  Expected: FAIL because the closed registry, typed launch contract, preflight ordering and redaction boundary do not exist.
- [ ] Step 3: minimal implementation
  - Preserve only the confirmed `inception` script configuration and the observed `local` identifier; do not implement a secret bridge until the exact service/name mapping is approved. Make all other providers `REQUIREMENTS_BLOCKED`.
  - Resolve with `SecretStore` immediately before child spawn and keep values in local memory only.
  - Generate isolated Hermes config without credentials; apply `SecretRedactor` before every durable or diagnostic boundary and redact child stdout/stderr.
  - Preserve existing `shell:false`, minimal env and isolated `HERMES_HOME`/`HOME`/`HERMES_CONFIG` behavior.
- [ ] Step 4: Run GREEN
  Run: `pnpm --filter @ebb-orchestrator/server test -- test/modules/runtime/hermes/hermes-secret-resolver.test.ts test/modules/runtime/hermes/hermes-secret-leak.test.ts test/modules/runtime/hermes/hermes-profile.test.ts test/modules/runtime/hermes/hermes-runtime-adapter.test.ts test/platform/security/infisical-secret-store.test.ts`
  Expected: PASS; only the approved provider key reaches Hermes and no test output, artifact, diagnostic, outcome or SQLite row contains a secret value.
- [ ] Step 5: neighboring checks
  Run: `pnpm --filter @ebb-orchestrator/server test -- test/platform/security/secret-store.test.ts test/platform/security/redaction.test.ts test/platform/diagnostics/diagnostics.test.ts test/platform/artifacts/artifact-store.test.ts test/app/security.test.ts`
  Expected: PASS; Infisical metadata remains metadata-only and safe HTTP/child errors contain no plaintext.
- [ ] Step 6: `git diff --check`
  Expected: exit 0, empty output.

## Task 4: Собрать минимальный Linux image с Node.js 24, Git и Hermes

**Purpose:** Создать reproducible image для одного Orchestrator process без credentials, project data или host-specific state в слоях image.

**Depends on:** Tasks 1 and 3.

**Files:**

- Create: `docker/hermes-artifact.env.example` — tracked non-secret approval input with exact required fields `HERMES_SOURCE`, `HERMES_VERSION`, `HERMES_SHA256`, `HERMES_ARCHITECTURES` and `HERMES_BINARY_NAME`; all values remain explicit placeholders until artifact coordinates are approved.
- Create: `scripts/docker-image-contract.test.mjs` — static assertions for the Dockerfile, `.dockerignore` and the Hermes artifact input schema; it must reject missing fields, placeholder checksums in a release build and unapproved architectures.
- Create: `docker/Dockerfile` — multi-stage or single runtime image based on `node:24.15-bookworm-slim`, pinned pnpm `12.4.2`, Git, CA certificates, curl and non-root `ebb` user.
- Create: `docker/install-hermes.sh` — deterministic Linux Hermes installation/verifier using the approved `docker/hermes-artifact.env` input and checksum; it must fail closed if the expected binary/version/architecture is unavailable.
- Create: `docker/artifact-gate.sh` — separate artifact gate that validates `docker/hermes-artifact.env` content and checksum before the Docker build proceeds.
- Create: `docker/entrypoint.sh` — `exec`-based startup, directory preflight and signal-safe handoff to server.
- Create: `docker/healthcheck.sh` — local health request with bounded timeout and no secret output.
- Create: `docker/.dockerignore` — excludes `.env`, `.env.*` except tracked example policy where needed, `.git`, local home, `node_modules`, artifacts, logs, databases and worktrees.
- Create: `docker/Dockerfile.test` only if build-time smoke needs a separate non-release fixture; otherwise keep one production Dockerfile.
- Modify: `scripts/hermes-dev.mjs` only if the existing setup/check command needs an explicit Linux container path; do not duplicate Hermes installation logic.

**Interfaces:**

- Consumes: repository source and lockfile plus the approved non-secret Hermes artifact input. The input is an implementation precondition, not a URL/checksum invented by this plan: `HERMES_SOURCE` must identify the approved source, `HERMES_VERSION` the exact version, `HERMES_SHA256` the exact checksum and `HERMES_ARCHITECTURES` the approved architecture set.
- Produces: image with `node --version` in `>=24.15 <25`, `git --version`, `pnpm --version` equal to `12.4.2`, and the approved Hermes CLI available to the existing adapter. Artifact gate must pass before build.
- Image invariant: no `INFISICAL_*` values, LLM keys, `.env`, SQLite, projects, logs, artifacts or worktrees are copied into any layer; runtime writes only to `/home/ebb/.ebb-orchestrator`.
- Approval gate: implementation is `REQUIREMENTS_BLOCKED` until a named owner supplies and approves `docker/hermes-artifact.env` (or an equivalent reviewed non-secret input) with all five exact fields, source/version/checksum/architecture acceptance evidence and a reproducible fetch. The plan must not fill in a URL, version, checksum or architecture by guesswork.

**Acceptance for this task:**

- Build succeeds from a clean checkout only after the approved artifact coordinates are present, with `pnpm install --frozen-lockfile` and no network credential.
- Container runs as non-root and can create only the mounted Orchestrator home paths.
- Version and checksum checks are deterministic and image fails rather than silently using an incompatible or unverified Hermes binary.
- Without approved artifact coordinates, the contract test fails with `REQUIREMENTS_BLOCKED`; no implementation may claim a production image is reproducible.

- [ ] Step 1: RED — add `scripts/docker-image-contract.test.mjs` assertions for required labels, non-root user, absent secret copy patterns, tool versions and the approved Hermes artifact input contract.
- [ ] Step 2: Run RED
  Run: `node --test scripts/docker-image-contract.test.mjs`
  Expected: FAIL because Docker artifacts and the approved Hermes coordinates do not exist.
- [ ] Step 3: minimal implementation
  - Install only OS packages required by existing runtime (`git`, `curl`, CA certificates and signal/init support).
  - Pin Node/pnpm and consume only the approved Hermes source/version/checksum/architectures; verify all during build.
  - Copy application source and production dependencies only after `.dockerignore` exclusion; never use secret build args or `RUN` lines that print env.
- [ ] Step 4: Run GREEN
  Run: `docker build --pull --tag ebb-orchestrator:plan-14 --file docker/Dockerfile .`
  Expected: exit 0 only with approved artifact coordinates; resulting image has required versions, non-root default user and no secret/state files.
- [ ] Step 5: neighboring checks
  Run: `docker run --rm --entrypoint sh ebb-orchestrator:plan-14 -c 'node --version && git --version && pnpm --version && command -v hermes && test "$(id -u)" != "0"'`
  Expected: exit 0; Node satisfies `>=24.15 <25`, pnpm is `12.4.2`, Hermes is present and UID is non-root.
- [ ] Step 6: `git diff --check`
  Expected: exit 0, empty output.

## Task 5: Добавить Compose lifecycle, volumes, health, bind host и signals

**Purpose:** Описать единственный service и безопасный operator lifecycle на Docker Desktop и Linux, с durable bind mount и loopback publish default.

**Depends on:** Tasks 1 and 4.

**Files:**

- Create: `docker/compose.yml` — exactly one `ebb-orchestrator` service, image/build, explicit `env_file`, environment, volume, port, healthcheck, restart and stop grace period.
- Modify: `docker/entrypoint.sh`, `docker/healthcheck.sh` — `exec`, `SIGTERM`/`SIGINT` propagation and bounded health request.
- Create: `.env.example` — names only, safe placeholders/comments, no real credentials; includes `EBB_RUNTIME_MODE=docker`, `EBB_SECRET_BACKEND=infisical`, home/env-file hints, port, model/provider and Infisical non-secret names.
- Create: `scripts/docker-compose-contract.test.mjs` — parse/check one service, volume, health and no hard-coded secret.
- Modify: `package.json` — add explicit `docker:build`, `docker:up`, `docker:down`, `docker:logs`, `docker:health`, `docker:backup`, `docker:restore` wrappers only if they remain cross-platform and do not hide Compose arguments.

**Interfaces:**

- Compose interpolation contract: `.env.example` is tracked template text only and is never auto-loaded or used as the service environment. The operator must export `EBB_ORCHESTRATOR_HOME` as an absolute host path and `EBB_ORCHESTRATOR_ENV_FILE` as an absolute, readable path to host `~/.ebb-orchestrator/.env`; `EBB_ORCHESTRATOR_ENV_FILE` is a launcher-side pointer, not a provider secret and not a container home setting. Compose is always invoked with explicit `--env-file "$EBB_ORCHESTRATOR_ENV_FILE"` (or the PowerShell equivalent). A repository `.env` is not read implicitly.
- Service environment contract: `docker/compose.yml` has exactly `env_file: ["${EBB_ORCHESTRATOR_ENV_FILE:?EBB_ORCHESTRATOR_ENV_FILE must point to a readable host .env}"]`; its `environment` section explicitly sets container `HOME=/home/ebb`, `EBB_ORCHESTRATOR_HOME=/home/ebb/.ebb-orchestrator`, `EBB_ORCHESTRATOR_NO_OPEN_UI=1`, `EBB_RUNTIME_MODE=docker` and `EBB_SECRET_BACKEND=infisical`. The host variable is used only as the mount source `${EBB_ORCHESTRATOR_HOME:?EBB_ORCHESTRATOR_HOME must be absolute}:/home/ebb/.ebb-orchestrator`; it is never passed as the container home.
- `.env.example` contains safe placeholders/comments for bootstrap/runtime names only. The host `~/.ebb-orchestrator/.env` is the service env file and may contain Infisical bootstrap values; the launcher exports `EBB_ORCHESTRATOR_ENV_FILE` separately and must not copy that host path into the image or use it as the container home. The host `.env` must not contain an LLM provider key; provider keys remain Infisical data resolved by the application.
- Preflight contract: Bash runs `export EBB_ORCHESTRATOR_HOME="$HOME/.ebb-orchestrator"; export EBB_ORCHESTRATOR_ENV_FILE="$EBB_ORCHESTRATOR_HOME/.env"; mkdir -p "$EBB_ORCHESTRATOR_HOME"; test -r "$EBB_ORCHESTRATOR_ENV_FILE" && test -d "$EBB_ORCHESTRATOR_HOME" && test -w "$EBB_ORCHESTRATOR_HOME"` before Compose. PowerShell runs `$env:EBB_ORCHESTRATOR_HOME = Join-Path $HOME ".ebb-orchestrator"; $env:EBB_ORCHESTRATOR_ENV_FILE = Join-Path $env:EBB_ORCHESTRATOR_HOME ".env"; New-Item -ItemType Directory -Force $env:EBB_ORCHESTRATOR_HOME | Out-Null; if (!(Test-Path -LiteralPath $env:EBB_ORCHESTRATOR_ENV_FILE -PathType Leaf)) { throw "EBB_ORCHESTRATOR_ENV_FILE is missing" }` and equivalent home checks. Missing/unreadable env file or home fails before `up`; Compose contract tests cover the `:?` guards.
- Produces: container env `HOME=/home/ebb`, `EBB_ORCHESTRATOR_HOME=/home/ebb/.ebb-orchestrator`, `EBB_ORCHESTRATOR_NO_OPEN_UI=1`, `EBB_RUNTIME_MODE=docker`, `EBB_SECRET_BACKEND=infisical`; one bind mount `${EBB_ORCHESTRATOR_HOME}:/home/ebb/.ebb-orchestrator`.
- Publish contract: `${EBB_DOCKER_BIND_ADDR:-127.0.0.1}:${EBB_PORT:-3000}:3000`; internal server binds `0.0.0.0:3000`; changing bind address is explicit and documented as a network exposure.
- Lifecycle contract: `docker compose up -d`, `ps`, `logs`, `exec`, `stop`, `down`, restart and removal of container do not remove bind-mounted home.
- Signal test contract: send `SIGTERM` and `SIGINT` both during pre-readiness startup/reconciliation and after readiness; assert abort flag, no listener after pre-readiness signal, idempotent worker/database/lock cleanup, one post-readiness shutdown and no leaked lock or database handle.

**Acceptance for this task:**

- Compose config has one application service and no task/worker sidecar or privileged mode.
- The explicit host env file and home are validated; missing/unreadable env file, missing home or incomplete Infisical variables causes a clear failure before listener.
- Docker mode requires the host `.env` service env file, but provider key material is still fetched from Infisical and never supplied through `.env`.
- Bash and PowerShell commands work with absolute paths and do not depend on Compose auto-loading a repository `.env`.
- `docker compose stop` allows graceful server shutdown; `docker compose down` leaves host home and SQLite intact.
- Docker Desktop Windows path is documented with absolute path normalization, file sharing/WSL2 prerequisite and PowerShell commands.
- SIGTERM/SIGINT signal tests pass in both pre-readiness and post-readiness phases without abort leaks, duplicate cleanup or held locks.

- [ ] Step 1: RED — add contract tests for one service, required env/mount, loopback port, healthcheck, stop grace, no privileged mode and no per-task service; add signal tests for SIGTERM/SIGINT before readiness, during reconciliation and after readiness.
- [ ] Step 2: Run RED
  Run: `node --test scripts/docker-compose-contract.test.mjs && pnpm --filter @ebb-orchestrator/server test -- test/platform/process/server-startup.test.ts`
  Expected: FAIL because `docker/compose.yml`, `.env.example` and the complete signal/env-file contract do not exist.
- [ ] Step 3: minimal implementation
  - Use one application service and one persistent bind mount; do not introduce named task volumes or Docker socket mounts.
  - Keep `.env` outside repository at `~/.ebb-orchestrator/.env`; Compose receives its absolute path through `EBB_ORCHESTRATOR_ENV_FILE` and explicit `--env-file`, never implicit repository loading.
  - Use `init: true` or an equivalent verified signal strategy and `stop_grace_period`; keep entrypoint `exec` semantics.
  - Add Bash and PowerShell preflight commands and fail closed when the env file is missing/unreadable.
- [ ] Step 4: Run GREEN
  Run: `docker compose --env-file "$EBB_ORCHESTRATOR_ENV_FILE" -f docker/compose.yml config`
  Expected: exit 0 only when the absolute host env file is readable; rendered configuration contains one service, one Orchestrator-home mount, a healthcheck and loopback default without secret values.
- [ ] Step 5: neighboring checks
  Run: `node --test scripts/docker-compose-contract.test.mjs && pnpm --filter @ebb-orchestrator/server test -- test/platform/process/server-startup.test.ts`
  Expected: PASS for explicit env-file failure, fixed container home, and signal abort/cleanup/lock behavior.
- [ ] Step 6: `git diff --check`
  Expected: exit 0, empty output.

## Task 6: Сделать SQLite WAL, backup и recovery restart-safe

**Purpose:** Защитить state при restart/crash и дать operator-процедуру backup/recovery, не считая копию live database без WAL sidecars достаточным backup.

**Depends on:** Tasks 1, 2 and 5.

**Files:**

- Modify: existing SQLite database bootstrap/connection module used by `main.ts` — explicit WAL/synchronous/busy timeout and startup integrity check without destructive auto-restore.
- Create/modify: `apps/server/src/platform/database/backup-service.ts` — exact `BackupService.createBackup`/`restoreBackup` API and locking/staging algorithm.
- Modify: `apps/server/src/platform/home/orchestrator-home.ts` and its test — backup/database paths and directory creation.
- Create: `docker/backup.sh` — strict CLI wrapper for `backup-service`.
- Create: `docker/restore.sh` — strict CLI wrapper for `backup-service`.
- Modify: `apps/server/test/platform/database/backup.test.ts` and create any additional exact SQLite/bootstrap tests — active WAL, manifest/checksum, corruption refusal and original preservation.
- Modify: `README.md` and `docs/development/08-docker-runtime.md` later in Task 8 with exact commands.

**Interfaces:**

- Current evidence: `sqlite-database.ts` already enables `foreign_keys`, `journal_mode=WAL` and `busy_timeout=5000`; `backup-service.ts` currently falls back to `copyFileSync` of the live database when a path is supplied. The latter is explicitly an unsafe baseline, not an accepted backup contract, and Task 6 must replace it without weakening the existing WAL invariant.
- `BackupService.createBackup({ home, output, mode: "online" | "offline" })` is the sole backup API. `docker/backup.sh --home <absolute-home> --output <absolute-backup-dir> --mode online|offline` accepts no positional paths, refuses a missing home/database and writes a staged backup directory containing the SQLite-consistent database and a manifest. `--mode online` uses SQLite online backup while the database is open; `--mode offline` requires the service stopped and obtains the existing process/lock boundary before checkpointing.
- `BackupService.restoreBackup({ home, input, confirm })` is the sole restore API. `docker/restore.sh --home <absolute-home> --input <absolute-backup-dir> --yes` requires the service stopped, an explicit `--yes`, a manifest and checksum, and never treats a bare `.db` file as a backup. Unknown/missing arguments fail without touching the home.
- Algorithm: acquire the application lock or verify offline stop; for online mode run SQLite checkpoint/online-backup so active `-wal` state is included; write database and WAL-consistent manifest to a temporary staging directory; compute and verify checksum/size/schema identity; fsync/close; run `PRAGMA quick_check` against the staged database; atomically promote the staged backup. Restore validates manifest/checksum and `quick_check` in a separate staging target, preserves the original database plus `-wal`/`-shm` before replacement, then atomically replaces only after validation; failed input leaves the original untouched and the rejected stage for operator inspection.
- `copyFileSync` of a live `ebb-orchestrator.db` is explicitly removed/rejected; neither backup nor restore may use it as a consistency mechanism. WAL sidecars are handled by SQLite online backup or the controlled offline checkpoint, not silently ignored.
- Produces: startup PRAGMAs `journal_mode=WAL`, `synchronous=FULL` (or a measured stronger/equivalent setting accepted by the existing SQLite driver), bounded busy timeout, integrity status and backup manifest containing database identity, timestamp, size and checksum. No secret values enter logs or manifests.

**Acceptance for this task:**

- Restart during normal operation preserves projects, task state and secret metadata references.
- Backup with active WAL restores into a disposable home and passes schema/integrity checks.
- Corrupt, checksum-mismatched, bare-copy or mismatched backup is rejected with generic diagnostics and original home remains intact.
- Restore preserves the original database and sidecars until staged validation succeeds; no automatic rollback overwrites operator data.
- CLI argument parsing and stopped/online lock/checkpoint behavior are tested for both scripts and the service.

- [ ] Step 1: RED — add tests for WAL pragma, restart persistence, online backup with active WAL, offline checkpoint, manifest/checksum, corrupt input, `quick_check` failure and preservation of the original database/sidecars.
- [ ] Step 2: Run RED
  Run: `pnpm --filter @ebb-orchestrator/server test -- test/platform/database/backup.test.ts test/platform/database/migrator.test.ts test/platform/home/orchestrator-home.test.ts`
  Expected: FAIL because WAL policy, consistent backup, exact CLI and staged restore contract are not implemented.
- [ ] Step 3: minimal implementation
  - Apply PRAGMAs through the existing database bootstrap, not ad hoc route code.
  - Implement `BackupService` with SQLite online backup or a controlled stopped/offline checkpoint; never copy only `ebb-orchestrator.db` while the process is writing.
  - Validate staged checksum and `PRAGMA quick_check` before replacement; preserve original home and sidecars on every failure.
  - Keep secret values out of backup logs/manifests; backups may contain encrypted/provider metadata only according to current persistence contract.
- [ ] Step 4: Run GREEN
  Run: `pnpm --filter @ebb-orchestrator/server test -- test/platform/database/backup.test.ts test/platform/database/migrator.test.ts test/platform/home/orchestrator-home.test.ts`
  Expected: PASS; active-WAL and recovery scenarios preserve authoritative state and reject invalid input safely.
- [ ] Step 5: neighboring checks
  Run: `docker compose -f docker/compose.yml up -d && docker compose -f docker/compose.yml ps`
  Expected: service reaches healthy state with database and WAL under the mounted home; command is executed only after a real operator `.env` exists.
- [ ] Step 6: `git diff --check`
  Expected: exit 0, empty output.

## Task 7: Сохранить native Windows compatibility и зафиксировать fresh Docker home/manual import boundary

**Purpose:** Сохранить native Windows behavior без добавления в этот план полного home migration tool; Docker получает новый home, а проект переносится оператором явным manual import/copy в `~/.ebb-orchestrator/projects`.

**Depends on:** Tasks 1, 2, 5 and 6. Provider bridge work is not a prerequisite for native compatibility.

**Files:**

- Modify: `scripts/run-server.js` — preserve Windows detached launcher and add no implicit Docker branch; Docker remains explicit Compose command.
- Modify: `scripts/hermes-dev.mjs` — keep native setup/check behavior and document/validate selected Docker `HERMES_HOME` only if required by the existing adapter.
- Modify: `apps/server/test/platform/home/orchestrator-home.test.ts`, `repository-discovery.test.ts`, `apps/server/test/modules/git/task-workspace-provisioner.test.ts`, `apps/server/test/modules/git/worktree-manager.test.ts` and Hermes script tests — native/Docker matrix and manual-import containment.
- Modify: `README.md` and `docs/development/08-docker-runtime.md` in Task 8 — document fresh Docker home and manual project import under `projects`.

**Interfaces:**

- Native mode continues using OS-native path join, `.exe` process handling, existing home and keyring. Docker mode uses a fresh bind-mounted home with fixed container path `/home/ebb/.ebb-orchestrator` and Infisical only.
- A native installation is not automatically copied or rewritten. The supported operator action is to stop/backup as appropriate, create the Docker home, and manually import/copy a project into `<host EBB_ORCHESTRATOR_HOME>/projects/<name>`; onboarding then records the contained path. Full cross-home migration, manifest generation and rollback tooling are out of scope and require a separately approved future plan.
- No command in this task accepts `--source`, `--destination`, `--manifest` or migration flags; no secret extraction or implicit data movement is introduced.

**Acceptance for this task:**

- A native Windows installation keeps running unchanged while Docker is configured separately.
- Fresh Docker home creation and manual project import under `projects` are documented and containment-tested.
- Native absolute repositories are not silently reinterpreted as Linux paths; Docker onboarding rejects outside references.
- Full home migration remains explicitly deferred to a separately approved future plan, not a deliverable or hidden dependency of plan-14.

- [ ] Step 1: RED — add tests for native command preservation, fresh Docker home resolution, manual import destination containment, symlink refusal and no implicit copy.
- [ ] Step 2: Run RED
  Run: `node --test scripts/hermes-dev.test.mjs scripts/hermes-execute.test.mjs scripts/hermes-provider-smoke.test.mjs`
  Expected: FAIL because explicit native/Docker separation and manual-import containment are not implemented.
- [ ] Step 3: minimal implementation
  - Preserve native launch/setup behavior and do not add a migration utility.
  - Require the operator to materialize imported projects inside destination `projects`; reject outside references rather than rewriting silently.
  - Use the backup/recovery contract for any operator backup, not a live database copy.
- [ ] Step 4: Run GREEN
  Run: `node --test scripts/hermes-dev.test.mjs scripts/hermes-execute.test.mjs scripts/hermes-provider-smoke.test.mjs`
  Expected: PASS; native scripts remain valid, Docker home is explicit and manual imports are bounded and secret-free.
- [ ] Step 5: neighboring checks
  Run: `pnpm --filter @ebb-orchestrator/server test -- test/platform/home/orchestrator-home.test.ts test/modules/projects/repository-discovery.test.ts test/modules/git/task-workspace-provisioner.test.ts test/modules/git/worktree-manager.test.ts`
  Expected: PASS for both platform/path matrices.
- [ ] Step 6: `git diff --check`
  Expected: exit 0, empty output.

## Task 8: Написать operator documentation и validate docs

**Purpose:** Сделать документацию достаточной для fresh Windows Docker Desktop и native operator без real secrets и без скрытых lifecycle assumptions.

**Depends on:** Tasks 1–7.

**Files:**

- Create: `docs/development/08-docker-runtime.md` — canonical runbook.
- Modify: `README.md` — requirements, native quick start, Docker quick start and links.
- Modify: `docs/development/05-hermes.md` — provider/model selection, Infisical resolution and isolated Hermes home.
- Modify: `.env.example` — comments/examples stay non-secret and aligned with actual config names.
- Create: `scripts/docker-docs.test.mjs` — command/path/link/env-name validation.

**Interfaces:**

- Documentation must explicitly cover:
  - prerequisites: Docker Desktop with Linux containers/WSL2, Git/Node/pnpm for native mode, Infisical project/environment and Machine Identity Universal Auth;
  - commands and purpose: copy `.env.example` to host `~/.ebb-orchestrator/.env`, explicit `docker compose --env-file`, `config`, `build`, `up -d`, `ps`, `logs`, `exec`, `health`, `stop`, `down`, `backup`, `restore`, manual project import under `projects` and native commands;
  - volume map for `~/.ebb-orchestrator`, database/WAL, `projects`, `runtime`, `artifacts`, `logs`, `backups`, `worktrees` and isolated Hermes home;
  - lifecycle and restart semantics, health endpoint, loopback bind, explicit LAN exposure warning and `EBB_ORCHESTRATOR_NO_OPEN_UI`;
  - `.env` rule: local `~/.ebb-orchestrator/.env` may contain bootstrap/runtime values, only `.env.example` is tracked, no LLM keys in `.env`;
  - Infisical Machine Identity creation, minimum project/environment/path permissions, rotation/revocation and required `INFISICAL_*` names without values;
  - storing/selecting an LLM provider/model: document the confirmed `inception` setup only after its exact Infisical `service/name` mapping is approved; create the provider credential in Infisical, select non-secret provider/model settings at runtime, inject only the allowlisted child key, and never display it in UI/API. Treat `local` as the existing role-model identifier without inventing a Docker credential setup; mark every other provider `REQUIREMENTS_BLOCKED`;
  - backup/recovery including stopped/offline versus online backup and WAL handling;
  - troubleshooting for missing Docker Linux mode, bind permission, port conflict, unhealthy service, Infisical auth/path failure, Hermes missing/model failure, projects containment rejection and recovery from failed restore;
  - native Windows commands and preserved default behavior.

**Acceptance for this task:**

- A reviewer can follow the Docker quick start from a clean Windows Docker Desktop host using placeholders only.
- Every command in documentation has a stated purpose and matches tracked Compose/scripts.
- Documentation never contains a real key, token, client secret, provider credential or generated home data.

- [ ] Step 1: RED — add docs test that all referenced commands/files/env names exist and rejects secret-shaped values.
- [ ] Step 2: Run RED
  Run: `node --test scripts/docker-docs.test.mjs`
  Expected: FAIL because the canonical Docker runbook and complete command matrix do not exist.
- [ ] Step 3: minimal implementation
  - Write the runbook from the implemented Compose/image/backup contracts, not from an unverified command.
  - Include separate Bash and PowerShell snippets, with `EBB_ORCHESTRATOR_ENV_FILE` explicitly pointing to host `~/.ebb-orchestrator/.env`.
  - State that container removal is safe only for the container, while bind-mounted home is the recovery boundary.
- [ ] Step 4: Run GREEN
  Run: `node --test scripts/docker-docs.test.mjs && pnpm docs:check`
  Expected: PASS; links, commands, env names and documentation governance checks are valid.
- [ ] Step 5: neighboring checks
  Run: `pnpm docs:test`
  Expected: exit 0 with no governance or documentation test failure.
- [ ] Step 6: `git diff --check`
  Expected: exit 0, empty output.

## Task 9: Добавить локальное Docker smoke evidence и security checks

**Purpose:** Проверить image/Compose/lifecycle/health/persistence/security локально без Infisical or LLM secrets; изменения `.github/workflows/production-gates.yml` в plan-14 не входят и откладываются в отдельный CI plan.

**Depends on:** Tasks 4–8.

**Files:**

- Create: `scripts/docker-smoke.mjs` — build the isolated test image, create temporary host home and explicit test-only DI/fake SecretStore harness, run Compose, poll real health, exercise one read-only API path, restart and verify persistence, collect sanitized logs, tear down.
- Create: `scripts/docker-smoke.test.mjs` — unit checks for command construction, timeout, cleanup, no-secret output and artifact paths.
- Modify: `package.json` — `docker:smoke` command with explicit test-only fixture/image mode; it must not alter production fail-closed composition.
- Modify: security/audit script or add `scripts/docker-secret-scan.mjs` — scan tracked Docker context/image metadata for `.env`, credential names with values, SQLite, logs, artifacts, worktrees and key-like literals.
- Do not modify: `.github/workflows/production-gates.yml`; CI workflow changes require a separately approved plan.

**Interfaces:**

- The local smoke command consumes no Infisical Machine Identity and no LLM credential. It uses an explicit `Dockerfile.test`/test-only DI harness that does not import production `main.ts` and cannot contact a real provider. Production Docker remains Infisical-only and fail-closed.
- Local evidence includes health/persistence/secret-scan results as sanitized artifacts; failure output contains paths and status only.
- Smoke must fail on `ECONNREFUSED`, unhealthy status, restart data loss, image root, secret-shaped build context or more than one Compose service. It must tear down in `try/finally`.
- Dependency contract: Task 9 depends on every Task 4, 5, 6, 7 and 8 declaration shown in the dependency graph; no undeclared dependency is hidden in the smoke script.

**Acceptance for this task:**

- A local operator can run `pnpm docker:smoke` and obtain build, Compose config, startup, real health, restart persistence, secret scan and clean teardown evidence.
- The explicit test-only harness cannot weaken production fail-closed startup or be selected by production environment variables.
- No CI workflow file is changed by this plan, and no credential is required or printed.

- [ ] Step 1: RED — add script tests for health timeout, restart assertion, sanitized output, image/context secret scan and explicit test-only DI/image selection.
- [ ] Step 2: Run RED
  Run: `node --test scripts/docker-smoke.test.mjs`
  Expected: FAIL because the smoke harness and security scan do not exist.
- [ ] Step 3: minimal implementation
  - Use a temporary host home outside the repository and a disposable Compose project name.
  - Use the explicit test-only DI harness/image for health/read-only behavior; do not create real provider credentials or call Infisical from CI or production.
  - Always tear down via `try/finally`; upload only sanitized logs/manifests.
- [ ] Step 4: Run GREEN
  Run: `pnpm docker:smoke`
  Expected: exit 0; image builds, service becomes healthy, state survives restart, secret scan passes and temporary home is removed after evidence collection.
- [ ] Step 5: neighboring checks
  Run: `docker image inspect ebb-orchestrator:ci --format '{{json .Config}}'`
  Expected: output contains non-root user and no credential values, database, logs or project data.
- [ ] Step 6: local quality verification
  Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm server:build && pnpm web:build`
  Expected: exit 0; existing quality gates remain green alongside local Docker smoke.
- [ ] Step 7: `git diff --check`
  Expected: exit 0, empty output.

## Task 10: Final gates, recovery rehearsal, rollback and release decision

**Purpose:** Доказать, что режим можно принять или безопасно откатить без влияния на native users.

**Depends on:** Tasks 1–9.

**Files:**

- Modify: `docs/development/08-docker-runtime.md` only for verified corrections found in rehearsal.
- Modify: `README.md` only for verified command/link corrections.
- Modify: `docs/roadmap/01-roadmap.md` and governance evidence only after plan review/approval and only through the repository’s documented generator flow; not part of this draft authoring task.

**Interfaces:**

- Release evidence includes exact image digest, Compose config output, tool versions, health result, backup/restore result, native compatibility result, secret scan result and quality gate results.
- Rollback contract: stop/remove Docker container, retain host `~/.ebb-orchestrator`, restore prior native process/config and use only a validated BackupService backup when recovery is needed; no `git reset --hard`, forced cleanup or automatic data deletion.

**Acceptance for this task:**

- Native startup works before and after Docker smoke with unchanged default environment.
- Docker restart and backup/restore rehearsal passes with disposable data and no real secrets.
- A reviewer can identify exactly which files are durable, which are rebuildable, which are sensitive and which rollback step preserves each.
- Release is rejected if any security, recovery, health, path containment, native compatibility or quality gate has unresolved load-bearing failure.

- [ ] Step 1: RED — create a checklist/evidence fixture that requires every acceptance item and detects missing evidence rather than treating a partial smoke as success.
- [ ] Step 2: Run RED
  Run: `node --test scripts/docker-smoke.test.mjs scripts/docker-docs.test.mjs`
  Expected: FAIL until the complete evidence bundle and recovery rehearsal are present.
- [ ] Step 3: minimal implementation
  - Run the full Docker rehearsal with disposable home, controlled shutdown, restart, online/offline backup and restore into a second disposable home.
  - Run native Windows-oriented script tests without changing native home or keyring.
  - Record failures as blocking findings; do not weaken assertions to obtain green output.
- [ ] Step 4: Run GREEN
  Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm server:build && pnpm web:build && pnpm docs:test && pnpm docs:check && pnpm docker:smoke`
  Expected: all commands exit 0; Docker smoke and docs checks are real, not mocked transport success.
- [ ] Step 5: Security and repository checks
  Run: `git diff --check && git status --short`
  Expected: diff check exits 0; status contains only intended implementation/documentation changes and no `.env`, database, logs, artifacts, worktrees or generated secrets.
- [ ] Step 6: Release/rollback decision
  Expected: reviewer records approve or reject with image digest and evidence paths; rejection leaves native mode supported and no destructive cleanup is performed.

## Docker Desktop Windows behavior

Implementation and documentation must make this operational contract explicit:

1. Docker Desktop must use Linux containers; WSL2 backend and file sharing/allowed-drive access must permit the selected `EBB_ORCHESTRATOR_HOME` bind mount.
2. Bash setup uses `export EBB_ORCHESTRATOR_HOME="$HOME/.ebb-orchestrator"; export EBB_ORCHESTRATOR_ENV_FILE="$EBB_ORCHESTRATOR_HOME/.env"; mkdir -p "$EBB_ORCHESTRATOR_HOME"; test ! -f "$EBB_ORCHESTRATOR_ENV_FILE" && cp .env.example "$EBB_ORCHESTRATOR_ENV_FILE"; test -r "$EBB_ORCHESTRATOR_ENV_FILE"`; PowerShell setup uses `$env:EBB_ORCHESTRATOR_HOME = Join-Path $HOME ".ebb-orchestrator"; $env:EBB_ORCHESTRATOR_ENV_FILE = Join-Path $env:EBB_ORCHESTRATOR_HOME ".env"; New-Item -ItemType Directory -Force $env:EBB_ORCHESTRATOR_HOME | Out-Null; if (!(Test-Path -LiteralPath $env:EBB_ORCHESTRATOR_ENV_FILE -PathType Leaf)) { Copy-Item -LiteralPath .env.example -Destination $env:EBB_ORCHESTRATOR_ENV_FILE }; if (!(Test-Path -LiteralPath $env:EBB_ORCHESTRATOR_ENV_FILE -PathType Leaf)) { throw "EBB_ORCHESTRATOR_ENV_FILE is missing" }`. Both then invoke `docker compose --env-file "$EBB_ORCHESTRATOR_ENV_FILE" -f docker/compose.yml config` (PowerShell uses `--env-file $env:EBB_ORCHESTRATOR_ENV_FILE`); neither relies on a Linux `~` being understood by Compose on Windows.
3. The tracked `.env.example` is only a template; the host copies it to the untracked home `.env`, which is the service env file. The container sees it only through Compose environment loading and never through image build context.
4. Compose publishes `127.0.0.1:${EBB_PORT}:3000` by default. Docker’s internal server listens on `0.0.0.0:3000` because `127.0.0.1` inside a container is not the Windows host.
5. `docker compose down` removes the container/network but not the bind-mounted host home. Recreating the container reuses SQLite, WAL, projects, runtime, artifacts, logs, backups and worktrees.
6. Native `pnpm start`, `node scripts/run-server.js`, `pnpm hermes:setup`, `pnpm hermes:check` and existing Windows keyring behavior remain documented separately; Docker commands never silently replace them.

## Secret and credential contract

- Bootstrap/runtime host `~/.ebb-orchestrator/.env` may contain mode, port and the Infisical client ID/secret, project ID, environment, secret path and site URL required by the existing `InfisicalSecretStore`; `EBB_ORCHESTRATOR_ENV_FILE` remains a launcher-side absolute pointer to that file. The file is local-only, permission-restricted and never tracked or copied into the image.
- Provider API keys are written to the selected Infisical project/environment/path only after an exact provider mapping is approved. The current repository confirms the `inception` key env name and `local` role identifiers, but does not confirm an LLM `SecretStore` service/name pair; no remote name or extra provider may be invented here. Keys are not copied into `.env`, `config.yaml`, Hermes profile files, prompts, task metadata, SQLite, logs, artifacts, UI/API responses, Dockerfile `ARG`/`ENV`, image history or backups as plaintext.
- `SecretStore.resolveForService` is the only application resolution boundary. `HermesSecretResolver` maps a selected provider to one approved secret name and one approved child env name; arbitrary environment passthrough is forbidden.
- Provider/model selection is non-secret. The operator selects only an evidence-backed provider/model through documented runtime settings; `inception` remains a candidate pending the exact Infisical service/name decision, while `local` has no confirmed credential contract. Only an approved Hermes model alias may be passed as `HERMES_MODEL`, and only the selected provider credential may be injected for the child invocation.
- Infisical Universal Auth Machine Identity is least-privilege, scoped to the required project/environment/path, rotated independently and revoked on incident. Startup fails closed when required values are missing or the remote backend is unavailable.

## Risks, rollback and mitigations

| Risk | Detection | Mitigation / rollback |
|---|---|---|
| Docker Desktop bind mount is unavailable or slow | Compose mount preflight, health timeout, smoke failure | Keep native mode; correct file sharing/WSL2 path; do not fall back to ephemeral container paths |
| Host port is exposed beyond loopback | Compose config assertion and operator review | Default `127.0.0.1`; stop stack and restore explicit bind address before restart |
| Native path is sent to Linux container | Docker project containment tests and manual-import destination checks | Reject path; manually import/copy into `projects`; native path remains untouched |
| Symlink/junction escapes project root | canonical realpath/containment test | Reject onboarding and preserve source; never recursively delete outside root |
| Infisical outage or bad Machine Identity | pre-listener startup test and health failure | No keyring fallback in Docker; fix/rotate identity or roll back to native mode |
| Secret leaks through env/log/error/image | resolver redaction tests, image/config scan, local smoke | Remove offending path and invalidate credential; fail release; never print debug env |
| WAL-only or live-file backup is inconsistent | restore `quick_check`, checksum/manifest and restart rehearsal | Keep original home, restore only validated staged backup; no automatic overwrite |
| Hermes binary/version incompatibility | build version check and provider smoke | Pin verified release/checksum or reject image; use native Hermes until fixed |
| Container removal loses state | restart/down smoke and volume mapping inspection | Stop rollout; recover from host home/backup; never accept anonymous volume or image-layer state |
| Manual project import collision or partial copy | destination containment check, staged operator backup and cleanup test | Preserve source/destination, abort before replacement, retry only after explicit operator decision |
| New Docker config changes native startup | native test matrix and before/after smoke | Revert only Docker mode/config dispatch; retain native paths and keyring |
| CI falsely passes because transport is mocked | real health/read request and failure-on-connection-refused assertion | Fail job; no blanket API fulfillment in Docker smoke |

## Final gates

Implementation is complete only when all named evidence is available:

1. Focused RED/GREEN tests for runtime mode, home/projects containment, Hermes secret resolver, native compatibility, persistence, Compose contract and docs.
2. `docker build` succeeds from clean context with pinned Node/pnpm/Hermes, non-root runtime and no secret/state in image.
3. Compose smoke proves one service, loopback publish default, real health, graceful signal handling, restart persistence and cleanup.
4. Backup/restore rehearsal proves WAL-consistent recovery and preserves the original home on invalid restore.
5. Native Windows test matrix proves default keyring, paths, `.exe` handling and existing commands remain available.
6. Secret scan proves no `.env`, real credentials, plaintext provider keys, SQLite, logs, artifacts or worktrees enter Git/image/CI artifacts.
7. Documentation validation proves every command, path, env name, volume and troubleshooting procedure matches implementation.
8. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm server:build`, `pnpm web:build`, `pnpm docs:test`, `pnpm docs:check`, Docker smoke and `git diff --check` pass.
9. Release review records image digest, evidence locations, rollback command and explicit approval; no commit, roadmap generation or production rollout is implied by this draft.
