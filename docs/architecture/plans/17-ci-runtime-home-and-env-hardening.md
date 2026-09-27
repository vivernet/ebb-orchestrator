---
id: plan-17
kind: plan
status: planned
title: Надёжность CI evidence и единая конфигурация Ebb Orchestrator
created: 2026-09-27
updated: 2026-09-27
depends_on: []
specs:
  - ../specs/01-system-design.md
evidence:
  - .github/workflows/production-gates.yml
  - package.json
  - packages/contracts/package.json
  - apps/server/package.json
  - apps/server/src/main.ts
  - apps/server/src/platform/home/orchestrator-home.ts
  - apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts
  - apps/server/test/platform/home/orchestrator-home.test.ts
  - apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts
  - apps/server/test/e2e/v1-autonomous-task.test.ts
  - scripts/project-env.mjs
  - scripts/project-env.test.mjs
  - scripts/hermes-dev.mjs
  - scripts/security-audit-evidence.mjs
  - scripts/security-audit-evidence.test.mjs
  - scripts/run-server.js
  - scripts/run-server.test.mjs
  - README.md
  - .gitignore
  - pnpm-lock.yaml
---

# Надёжность CI evidence и единая конфигурация Ebb Orchestrator

## Goal

Устранить подтверждённые источники отсутствующего audit artifact и каталога `~/.orchestrator`, обеспечить загрузку пользовательского `.env` всеми штатными server-командами, дать безопасный проверяемый пример `.env` и убрать предупреждение `DEP0040` обновлением GitHub Action с подтверждённым исправлением.

План ограничен изменениями тестового запуска, CI, домашнего каталога runtime и локальной конфигурации запуска. Он не переименовывает проектную конфигурацию `repo/.orchestrator/` и не меняет её trust model.

## Context Brief и установленные факты

- В Buildkite build 31 `pnpm test` завершился ошибкой из-за отсутствующего `apps/server/node_modules/@ebb-orchestrator/contracts/dist/index.js`. В тестовом CI-порядке `contracts` сначала тестируется, но не собирается; пакетный build выполняется после тестов. Корневой `pnpm test` сейчас запускает только `pnpm -r --if-present test`.
- В `.github/workflows/production-gates.yml` шаги `Dependency audit` и `Upload dependency audit evidence` расположены после lint/typecheck/test/build. Upload имеет `if: always()` и `if-no-files-found: error`, но audit не имеет условия `always`; при провале раннего gate audit пропускается, а upload всё равно может завершиться ошибкой из-за отсутствующего JSON. `scripts/security-audit-evidence.mjs` сохраняет JSON с exit status аудита до возврата ненулевого кода, если сам запуск audit дошёл до записи.
- `HermesRuntimeAdapter` содержит fallback `os.homedir()/.orchestrator/checkpoints` (`apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts:120`), а `getCheckpointPath()` создаёт этот каталог (`:518-521`). В штатном server composition `apps/server/src/main.ts:71-73,114-117` передаёт `home.runtime/checkpoints`, поэтому этот fallback не должен срабатывать в этой композиции. Подтверждённый локальный источник побочного создания при тестах — `apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts:86-91`: `beforeEach` создаёт adapter без `checkpointDirectory`; вызовы `startRun` проходят через `getCheckpointPath`. Resolver при отсутствии override использует Windows `%USERPROFILE%/.ebb-orchestrator` и POSIX `$HOME/.ebb-orchestrator` (`apps/server/src/platform/home/orchestrator-home.ts:55-68`).
- `repo/.orchestrator/` — отдельная обнаруживаемая конфигурация управляемого репозитория, описанная в `docs/architecture/specs/01-system-design.md:256-282`; её нельзя путать с пользовательским state directory.
- `pnpm server:dev` → `apps/server/package.json:9` запускает `tsx watch src/main.ts`, но server bootstrap не загружает `.env`. Имеющийся `scripts/project-env.mjs` вызывается Hermes development/smoke scripts, не server bootstrap. Значит, `EBB_ORCHESTRATOR_HOME` из корневого `.env` сейчас не повлияет на `resolveOrchestratorHome`, если переменная не унаследована процессом.
- Текущий `.gitignore` уже игнорирует `.env`. README перечисляет runtime env variables, но не описывает обязательность/необязательность локального `.env`, его загрузку и безопасный шаблон.
- Lockfile содержит транзитивный npm-пакет `punycode@2.3.1` через `tr46`/`whatwg-url` и `uri-js`; эти workspace paths не доказывают источник предупреждения в GitHub Action. В inspected `actions/upload-artifact@v4` bundle есть Node core `require("punycode")`. Официальный релиз `actions/upload-artifact@v6.0.0` перешёл на Node 24 и прямо включает исправление punycode deprecation; план выбирает этот документированно исправленный major. На дату плана существует более новый v7.0.1, но переход на него не нужен для устранения подтверждённого warning и требует отдельного compatibility evidence. Ссылки: [v6.0.0 release notes](https://github.com/actions/upload-artifact/releases/tag/v6.0.0), [latest release](https://github.com/actions/upload-artifact/releases/latest).
- Выполнен `pnpm test`: 113 файлов, 1 033 passed, 2 skipped. После исключения документационно-ориентированных сценариев отдельные Node tests прошли: 32 теста и 3 теста в отфильтрованном suite Hermes dev.
- Проверочный `pnpm server:dev` с `EBB_ORCHESTRATOR_HOME=C:/Users/alex1/.ebb-orchestrator-dev` выполнился и создал этот каталог/SQLite, но остановился на интерактивном запросе создания локального пароля до открытия listener. Health check не прошёл, потому что сервер не дошёл до READY. Проверка в момент запуска подтвердила отсутствие `C:/Users/alex1/.orchestrator`.

## Global Constraints

- Сохранять `repo/.orchestrator/` как project-local конфигурацию; пользовательское долговременное состояние должно находиться только под `EBB_ORCHESTRATOR_HOME` или штатным `~/.ebb-orchestrator`.
- Один авторитетный resolver home. Не добавлять второй независимый default path для Hermes checkpoints.
- Корневой `.env` — необязательная локальная конфигурация, не обязательная для production deployment; существующие process environment values должны иметь приоритет над файлом, а файл — над defaults. Не выводить значения `.env` в логи.
- `.env` остаётся ignored; добавляемый `.env.example` не содержит действительных секретов. Production credentials продолжают задаваться через защищённое окружение/secret manager.
- Не менять `pnpm-lock.yaml` только из-за имени транзитивного npm-пакета `punycode`: предупреждение из Node core внутри action не устанавливает, что workspace package вызвал тот же warning.
- Не удалять `if-no-files-found: error` для реально запущенного audit: отсутствие обязательного evidence после выполнения producer должно по-прежнему быть явной ошибкой.
- Не менять исторические миграции и не расширять runtime trust boundary.
- Не запускать `pnpm docs:*`, `scripts/docs-governance.mjs` или документационные тесты в рамках выполнения этого плана без отдельного разрешения пользователя.

## Review Focus

- Доказать, что clean `pnpm test` формирует `contracts/dist` до потребляющих его тестов, а решение работает и в GitHub Actions, и в Buildkite, если тот вызывает корневой `pnpm test`.
- Убедиться, что dependency audit выполняется после падения lint/typecheck/test/build, когда успешна установка зависимостей, и его failure status всё ещё завершает job после попытки загрузки evidence.
- Не допустить вторичную ошибку upload при skipped audit из-за неуспешной установки зависимостей; не скрывать отсутствующий файл, если audit был запущен.
- Проверить, что переход `upload-artifact` на v6 сохраняет имя, путь, архивный default и текущую семантику `if-no-files-found`; подтверждать отсутствие `DEP0040` на реальном hosted runner, не по локальному lockfile.
- Удалить каждую production fallback-ветку, создающую user-home `.orchestrator`; tests должны использовать временный каталог, а не писать в настоящий профиль.
- Проверить precedence `.env`/process env и одинаковое поведение `pnpm server:dev`, root `pnpm start`, package `start` и поддерживаемого `scripts/run-server.js`.
- Не смешать изменения с параллельной работой над документацией; `.env.example` и точечный README раздел должны принадлежать только Task 3.

## Tasks

### Task 1 — Сделать CI test graph воспроизводимым и сохранить audit evidence

**Depends on:** none.

**Owner:** CI/workspace scripts.

**Files:**

- Modify: `package.json` — изменить root `test`, чтобы сначала собрать workspace dependency `@ebb-orchestrator/contracts`, затем запускать существующие workspace tests.
- Modify: `.github/workflows/production-gates.yml` — присвоить install step `id: install-dependencies`, сохранить audit evidence после раннего quality-gate failure, условно пропускать upload только когда audit не запускался; перейти на `actions/upload-artifact@v6`.
- Modify: `scripts/security-audit-evidence.test.mjs` — покрыть порядок build/test, exact audit/upload/final-failure conditions, artifact path/name, отсутствие upload при skipped producer и выбранный action major.
- Modify: `scripts/run-server.test.mjs` — только если CI-условия или команды требуют корректировки общего test harness; не добавлять документационные проверки.

**Interfaces and semantics:**

- Root test contract after Tasks 1 and 3: `pnpm --filter @ebb-orchestrator/contracts build && pnpm -r --if-present test && node --test scripts/server-env.test.mjs scripts/run-server.test.mjs`; package dependency builds before workspace tests, then launcher tests join the CI gate.
- Установочному шагу присвоить `id: install-dependencies`. Audit step выполняется при `always()` только если `steps.install-dependencies.outcome == 'success'`, чтобы он не пропускался из-за lint/typecheck/test/build failure, но не запускался при неготовом checkout/dependencies.
- Upload выполняется через `always()` только когда `steps.dependency-audit.outcome != 'skipped'`. Сохранить `if-no-files-found: error`: если producer был запущен, но evidence не создал, workflow обязан явно упасть.
- Audit failure остаётся `continue-on-error: true` только до upload; после upload существующий fail-gate явно проверяет `steps.dependency-audit.outcome == 'failure'` и завершает job ненулевым результатом. `always()` не заменяет и не скрывает failed status более раннего lint/typecheck/test/build gate.
- Обновить `actions/upload-artifact` до v6 major: его официальный changelog прямо указывает Node 24 и исправление Node punycode deprecation. Проверить hosted runner compatibility (для self-hosted минимальная версия runner из release notes) и текущие `path`/`name`/missing-file semantics; `archive: false` не включать.
- Не менять workspace `punycode`/`tr46`/`uri-js` overrides без отдельного воспроизведения deprecation из процесса workspace.

**RED:**

- На чистой установке без существующего `packages/contracts/dist` выполнить `pnpm test`; до изменения потребительские server tests должны показать, что отсутствует `@ebb-orchestrator/contracts/dist/index.js`.
- `node --test scripts/security-audit-evidence.test.mjs` должен краснеть на проверках текущего workflow: install не имеет стабильного `id`, audit может быть skipped после upstream failure, upload не различает skipped producer, а action остаётся v4.

**GREEN:**

- Использовать существующую CI matrix `node-version: 24.x` и `26.x` в `.github/workflows/production-gates.yml:20-23` без добавления новых runtime versions; в обоих clean jobs выполнить `pnpm test`. Ожидание: `contracts/dist` создан до server tests, все не-документационные workspace suites завершаются без `ERR_MODULE_NOT_FOUND`.
- Выполнить `node --test scripts/security-audit-evidence.test.mjs`; ожидание: все workflow/evidence assertions проходят.
- На тестовых CI-runs раздельно искусственно провалить один quality gate после install, сам audit и install. Ожидание: при раннем gate failure audit создаёт JSON и upload публикует artifact, job сохраняет исходный failed conclusion; при audit failure JSON загружается и финальный audit gate завершает job failure; при install failure audit/upload пропускаются без вторичной ошибки отсутствующего файла.
- На GitHub-hosted runner повторить upload и проверить, что artifact читается под прежним именем и warning `DEP0040` отсутствует.

**Соседние проверки:** `pnpm --filter @ebb-orchestrator/contracts build`; `pnpm test`; `pnpm lint`; `pnpm typecheck`; `git diff --check` для затронутых файлов. Документационные tests/commands не запускать.

**Review Focus:** step conditions GitHub Actions, сохранение исходного fail status, чистая workspace dependency order, точная причина/исчезновение deprecation warning, отсутствие ложного зелёного результата.

**Acceptance:** missing contracts artifact устранён в чистом CI; после раннего fail evidence загружается, если audit действительно исполнился; пропущенный producer не вызывает вторичную upload-ошибку; `DEP0040` отсутствует при upload; workspace punycode dependency graph не менялся без доказательств.

### Task 2 — Удалить устаревший user-home fallback checkpoints

**Depends on:** none.

**Owner:** server Hermes runtime adapter.

**Files:**

- Modify: `apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts` — заменить fallback `os.homedir()/.orchestrator/checkpoints` вычислением `resolveOrchestratorHome(process.env, currentPlatform).runtime/checkpoints`; сохранить явный `checkpointDirectory` override.
- Modify: `apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts` — исправить общий `beforeEach`, который сейчас создаёт adapter без `checkpointDirectory`; передавать изолированный temporary path и чистить его через teardown; добавить regression test общего resolver fallback с явным `EBB_ORCHESTRATOR_HOME`.
- Modify: `apps/server/test/e2e/v1-autonomous-task.test.ts` — передать временный checkpoint path в Hermes adapter test harness.
- Verify only: `apps/server/src/main.ts` — уже передаёт `home.runtime/checkpoints`; менять только если focused test выявит несовпадение.

**Interfaces and semantics:**

- Все production вызовы `HermesRuntimeAdapter` получают checkpoint path из `OrchestratorHomePaths.runtime/checkpoints`; если опция не передана, adapter вычисляет default через тот же `resolveOrchestratorHome`, а не отдельный `os.homedir()` path. Явный override сохраняет приоритет.
- Unit/e2e tests обязаны передавать temp path и удалять его через существующий teardown.
- `repo/.orchestrator/` discovery/import contract остаётся без изменений.

**RED:** добавить тест: временно задать `EBB_ORCHESTRATOR_HOME` на temp path, создать adapter без `checkpointDirectory` и ожидать `<temp>/runtime/checkpoints`; выполнить focused suite. До изменения adapter выбирает `~/.orchestrator/checkpoints`, поэтому test assertion падает. Одновременно общий `beforeEach` и e2e harness используют собственные temp checkpoint paths, чтобы сами тесты не писали в профиль пользователя.

**GREEN:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/runtime/hermes-runtime-adapter.test.ts test/e2e/v1-autonomous-task.test.ts` — запускаются именно два указанных файла и все тесты проходят; отдельный test создаёт checkpoint только под injected `EBB_ORCHESTRATOR_HOME/runtime/checkpoints`/temp path и подтверждает отсутствие `USERPROFILE/.orchestrator/checkpoints`.

**Соседние проверки:** `pnpm --filter @ebb-orchestrator/server typecheck`; `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/home/orchestrator-home.test.ts test/modules/runtime/hermes-runtime-adapter.test.ts`; `git diff --check` по серверным файлам.

**Review Focus:** каждый constructor call site найден; production paths совпадают с home resolver; тесты не пишут в настоящий user profile; `.orchestrator/` остаётся только конфигурацией внутри подключаемого репозитория.

**Acceptance:** и переданный, и default checkpoint path принадлежат общему home resolver; явный `EBB_ORCHESTRATOR_HOME` соблюдается; все тестовые adapters — disposable temp paths; тестовый запуск не создаёт `USERPROFILE/.orchestrator/checkpoints`.

### Task 3 — Загрузить `.env` до разрешения home и документировать безопасный local setup

**Depends on:** Tasks 1 and 2 (в частности, последовательное редактирование root `package.json`).

**Owner:** server launch/configuration and operator setup.

**Files:**

- Modify: `apps/server/package.json` — направить `dev` и package `start` на `node ../../scripts/run-server.js [dev]`.
- Modify: root `package.json` — направить root `start` и `server:dev` на `node scripts/run-server.js [dev]` и включить launcher tests в root test command после contracts build/workspace tests.
- Modify: `scripts/run-server.js` и `scripts/run-server.test.mjs` — launcher вычисляет абсолютный repo root от `import.meta.url`, передаёт Node `--env-file-if-exists=<absolute repo root>/.env`, поддерживает production и dev режимы, сохраняет `shell:false` и корректно работает из разного cwd.
- Create: `.env.example` — безопасный шаблон с `EBB_ORCHESTRATOR_HOME` (пояснение об абсолютном platform-specific path) и `PORT`; только safe placeholders, без действительных credentials.
- Verify only / modify only if needed: `.gitignore` — `.env` остаётся ignored, `.env.example` не игнорируется.
- Modify: `README.md` — короткая точная инструкция для optional root `.env`, copy/setup, запуска Windows PowerShell и POSIX shell, env precedence, значения defaults и различия project `.orchestrator/` vs user state `.ebb-orchestrator/`.
- Create: `scripts/server-env.test.mjs` — изолированные tests команд launchers, абсолютного пути `--env-file`, env precedence и ignore/template behavior; добавить этот тест в root `pnpm test` script, чтобы он исполнялся в CI; не запускать документационные checks.
- Modify: `scripts/project-env.test.mjs` only if shared env helper is deliberately reused; предпочесть Node built-in parser over a second parser.

**Interfaces and semantics:**

- Штатные server launch paths (`pnpm server:dev`, root `pnpm start`, `pnpm --filter @ebb-orchestrator/server start`, `node scripts/run-server.js`) используют один launcher. Он вычисляет repository root через `fileURLToPath(new URL("..", import.meta.url))`, передаёт в Node CLI `--env-file-if-exists=<absolute repository root>/.env` до `resolveOrchestratorHome` и задаёт child `cwd` равным repository root; результат не зависит от вызывающего `process.cwd()`. Отсутствующий `.env` не блокирует запуск.
- Priority is process environment > root `.env` > resolver default. Поэтому пример `$env:EBB_ORCHESTRATOR_HOME = "$HOME\.ebb-orchestrator-dev"` сохраняет приоритет над `.env`; если process env не задан, путь из `.env` используется; если нет ни того, ни другого — `%USERPROFILE%\.ebb-orchestrator`/`$HOME/.ebb-orchestrator`.
- Использовать поддерживаемый текущим Node engine встроенный `--env-file-if-exists`; не добавлять npm dotenv dependency и не загружать file contents в stdout/stderr.
- `.env.example` — шаблон для копирования, необязательный для запуска при использовании defaults. Включать только не-секретные настройки; actual secrets остаются в защищённом deployment environment/secret manager.
- Не путать `repo/.orchestrator/` (project config) с `~/.ebb-orchestrator/` (local durable app state).

**RED:** добавить isolated `scripts/server-env.test.mjs` cases: launchers не передают абсолютный root `--env-file-if-exists`; вызов из cwd репозитория и из `apps/server` выбирает разные/неверные `.env`; process override конфликтует с file; запуск без `.env` сохраняет default path и не падает; `.env.example` содержит только разрешённые имена, а `.env` исключён из Git. Подключить новый тест к root test script. Ожидание: тесты падают на текущих отдельных launcher commands/отсутствующем example.

**GREEN:** выполнить `pnpm test` и `node --test scripts/server-env.test.mjs scripts/run-server.test.mjs`; ожидание: root test graph включает env-launcher test; Node опционально загружает существующий root `.env` через абсолютный path до запуска приложения из любого cwd, запуск работает и когда файла нет, shell-provided override не затирается, тесты используют временные каталоги и фиктивные значения.

**Runtime smoke:** на Windows в выделенном disposable home выполнить `$env:EBB_ORCHESTRATOR_HOME = "$HOME\.ebb-orchestrator-dev"; pnpm server:dev`; пройти предусмотренный first-run auth setup локально, проверить `GET /api/v1/health`, подтвердить, что DB/checkpoints/artifacts остаются в указанном home и `~\.orchestrator` не создаётся; штатно остановить процесс. Отдельно повторить запуск только с `.env`, где задан `EBB_ORCHESTRATOR_HOME`, и подтвердить то же. Не использовать реальные provider/Infisical credentials в fixture.

**Соседние проверки:** `pnpm server:build`; `pnpm --filter @ebb-orchestrator/server typecheck`; `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/home/orchestrator-home.test.ts test/modules/runtime/hermes-runtime-adapter.test.ts`; `pnpm lint`; `pnpm typecheck`; `pnpm test`; `git diff --check` по затронутым файлам. Не запускать `pnpm docs:*`, docs-governance scripts или документационные tests без отдельного разрешения.

**Review Focus:** env-file path одинаково разрешается при разных cwd и Windows path syntax; процессные значения сохраняют приоритет; no-secret logging; `.env` ignored; `.env.example` safe; все поддерживаемые launchers согласованы; first-run interactive auth остаётся обязательной и не обходится.

**Acceptance:** пользовательский `.env` реально задаёт `EBB_ORCHESTRATOR_HOME` до bootstrap; явное переменное окружение имеет приоритет; README и пример точно описывают необязательность файла и безопасное использование; user data path никогда не падает обратно на `.orchestrator`.

## Plan-wide verification

- Для изменения root test graph и action: чистая установка/CI evidence, Node 24 + 26, focused security-audit workflow contract test.
- Для runtime path: focused resolver/adapter tests и controlled Windows smoke с подтверждённым home, health endpoint, graceful stop и отсутствием второго `.orchestrator` каталога.
- Для `.env`: isolated env-file tests плюс проверка каждого штатного server launcher и process-vs-file precedence.
- Repository gates после реализации: `pnpm lint`, `pnpm typecheck`, `pnpm test`, затронутые builds и `git diff --check`; не запускать документационные проверки без отдельного разрешения пользователя.
- Финальный whole-bug review должен отдельно подтвердить четыре результата: чистый CI test dependency order, audit artifact при upstream gate failure, отсутствие `DEP0040` на hosted runner, единый `.ebb-orchestrator` home с явной `.env` поддержкой.
