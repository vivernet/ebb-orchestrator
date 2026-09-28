---
id: plan-17
kind: plan
status: in_progress
title: Надёжность CI evidence и единая конфигурация Ebb Orchestrator
created: 2026-09-27
updated: 2026-09-28
depends_on: []
specs:
  - ../specs/01-system-design.md
evidence:
  - .github/workflows/production-gates.yml
  - package.json
  - packages/contracts/package.json
  - apps/server/package.json
  - apps/server/src/main.ts
  - apps/server/src/platform/process/single-instance-lock.ts
  - apps/server/test/platform/process/startup.test.ts
  - apps/server/src/platform/process/startup-boundary.ts
  - apps/server/src/platform/security/local-user-wizard.ts
  - apps/server/src/platform/security/auth-repository.ts
  - apps/server/src/platform/database/migrations/026_local_auth.sql
  - apps/server/src/platform/home/orchestrator-home.ts
  - apps/server/src/platform/config/app-config.ts
  - apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts
  - apps/server/test/platform/home/orchestrator-home.test.ts
  - apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts
  - apps/server/test/e2e/v1-autonomous-task.test.ts
  - scripts/project-env.mjs
  - scripts/project-env.test.mjs
  - scripts/hermes-dev.mjs
  - scripts/security-audit-evidence.mjs
  - scripts/security-audit-evidence.test.mjs
  - scripts/security-audit-failure-path-check.mjs
  - .github/workflows/security-audit-failure-paths.yml
  - scripts/run-server.js
  - scripts/run-server.test.mjs
  - README.md
  - .gitignore
  - pnpm-lock.yaml
  - apps/web/test/e2e/run-e2e.mjs
  - apps/web/test/e2e/web-e2e-server.mjs
  - apps/web/test/e2e/child-lifecycle.mjs
  - apps/web/test/e2e/credential-handoff.test.mjs
  - apps/web/test/launcher-lifecycle.test.mjs
---

# Надёжность CI evidence и единая конфигурация Ebb Orchestrator

## Goal

Устранить подтверждённые источники отсутствующего audit artifact и каталога `~/.orchestrator`, обеспечить загрузку пользовательского `.env` всеми штатными server-командами, дать безопасный проверяемый пример `.env`, убрать предупреждение `DEP0040` обновлением GitHub Action с подтверждённым исправлением, закрыть TOCTOU при stale-lock recovery fail-closed ручной очисткой и добавить явно opt-in cross-platform headless bootstrap локального пользователя через stdin без ослабления штатного TTY wizard.

План ограничен изменениями тестового запуска, CI, домашнего каталога runtime, локальной конфигурации запуска, fail-closed stale-lock recovery из Task 4 и узкого явно одобренного first-run auth bootstrap из Task 5. Он не переименовывает проектную конфигурацию `repo/.orchestrator/` и не меняет её trust model.

## Context Brief и установленные факты

- В Buildkite build 31 `pnpm test` завершился ошибкой из-за отсутствующего `apps/server/node_modules/@ebb-orchestrator/contracts/dist/index.js`. В тестовом CI-порядке `contracts` сначала тестируется, но не собирается; пакетный build выполняется после тестов. Корневой `pnpm test` сейчас запускает только `pnpm -r --if-present test`.
- В `.github/workflows/production-gates.yml` шаги `Dependency audit` и `Upload dependency audit evidence` расположены после lint/typecheck/test/build. Upload имеет `if: always()` и `if-no-files-found: error`, но audit не имеет условия `always`; при провале раннего gate audit пропускается, а upload всё равно может завершиться ошибкой из-за отсутствующего JSON. `scripts/security-audit-evidence.mjs` сохраняет JSON с exit status аудита до возврата ненулевого кода, если сам запуск audit дошёл до записи.
- `HermesRuntimeAdapter` содержит fallback `os.homedir()/.orchestrator/checkpoints` (`apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts:120`), а `getCheckpointPath()` создаёт этот каталог (`:518-521`). В штатном server composition `apps/server/src/main.ts:71-73,114-117` передаёт `home.runtime/checkpoints`, поэтому этот fallback не должен срабатывать в этой композиции. Подтверждённый локальный источник побочного создания при тестах — `apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts:86-91`: `beforeEach` создаёт adapter без `checkpointDirectory`; вызовы `startRun` проходят через `getCheckpointPath`. Resolver при отсутствии override использует Windows `%USERPROFILE%/.ebb-orchestrator` и POSIX `$HOME/.ebb-orchestrator` (`apps/server/src/platform/home/orchestrator-home.ts:55-68`).
- `repo/.orchestrator/` — отдельная обнаруживаемая конфигурация управляемого репозитория, описанная в `docs/architecture/specs/01-system-design.md:256-282`; её нельзя путать с пользовательским state directory.
- `pnpm server:dev` → `apps/server/package.json:9` запускает `tsx watch src/main.ts`, но server bootstrap не загружает `.env`. Имеющийся `scripts/project-env.mjs` вызывается Hermes development/smoke scripts, не server bootstrap. Значит, `EBB_ORCHESTRATOR_HOME` из корневого `.env` сейчас не повлияет на `resolveOrchestratorHome`, если переменная не унаследована процессом.
- Текущий `.gitignore` уже игнорирует `.env`. README перечисляет runtime env variables, но не описывает обязательность/необязательность локального `.env`, его загрузку и безопасный шаблон.
- Lockfile содержит транзитивный npm-пакет `punycode@2.3.1` через `tr46`/`whatwg-url` и `uri-js`; эти workspace paths не доказывают источник предупреждения в GitHub Action. В inspected `actions/upload-artifact@v4` bundle есть Node core `require("punycode")`. Официальный релиз `actions/upload-artifact@v6.0.0` перешёл на Node 24 и прямо включает исправление punycode deprecation; план выбирает этот документированно исправленный major. На дату плана существует более новый v7.0.1, но переход на него не нужен для устранения подтверждённого warning и требует отдельного compatibility evidence. Ссылки: [v6.0.0 release notes](https://github.com/actions/upload-artifact/releases/tag/v6.0.0), [latest release](https://github.com/actions/upload-artifact/releases/latest).
- Выполнен `pnpm test`: 113 файлов, 1 033 passed, 2 skipped. После исключения документационно-ориентированных сценариев отдельные Node tests прошли: 32 теста и 3 теста в отфильтрованном suite Hermes dev.
- `apps/server/src/platform/process/single-instance-lock.ts:34-63` (`SingleInstanceLock.acquire`) автоматически удаляет stale lock до exclusive create, что допускает TOCTOU; `release():74-88` сравнивает только PID, поэтому может удалить lock замещающего владельца в том же процессе. Утверждённая политика: любой существующий lock — fail closed; автоматического stale unlink нет, а ручное удаление разрешено только после подтверждения, что никакой Ebb Orchestrator process не использует этот home. `main.ts:71-88` сейчас открывает SQLite до `lock.acquire()`, значит Task 4 должен переставить startup.
- Stdin protocol Task 5 требует строго две newline-terminated записи: обе заканчиваются LF или CRLF; EOF может завершить протокол только после второго разделителя, и после него запрещены любые байты. Input deadline начинается до настройки stream/listeners/resume, очищается при каждом исходе, а после EOF снимается до sync validation/hash/DB persistence; он ограничивает только ожидание ввода.
- Проверочный `pnpm server:dev` с `EBB_ORCHESTRATOR_HOME=C:/Users/alex1/.ebb-orchestrator-dev` выполнился и создал этот каталог/SQLite, но остановился на интерактивном запросе создания локального пароля до открытия listener. Health check не прошёл, потому что сервер не дошёл до READY. Проверка в момент запуска подтвердила отсутствие `C:/Users/alex1/.orchestrator`.
- `apps/server/src/platform/config/app-config.ts` объявляет только `Platform = "linux" | "darwin" | "win32"`; поиск `apps/server/src` не обнаружил `validatePlatform`. Task 2 требует извлечённый валидатор, поэтому его конкретное место уточняется как существующий `app-config.ts`; это scope clarification, не изменение утверждённого поведения.

## Global Constraints

- Сохранять `repo/.orchestrator/` как project-local конфигурацию; пользовательское долговременное состояние должно находиться только под `EBB_ORCHESTRATOR_HOME` или штатным `~/.ebb-orchestrator`.
- Один авторитетный resolver home. Не добавлять второй независимый default path для Hermes checkpoints.
- Корневой `.env` — необязательная локальная конфигурация, не обязательная для production deployment; существующие process environment values должны иметь приоритет над файлом, а файл — над defaults. Не выводить значения `.env` в логи.
- `.env` остаётся ignored; добавляемый `.env.example` не содержит действительных секретов. Production credentials продолжают задаваться через защищённое окружение/secret manager.
- Не менять `pnpm-lock.yaml` только из-за имени транзитивного npm-пакета `punycode`: предупреждение из Node core внутри action не устанавливает, что workspace package вызвал тот же warning.
- Не удалять `if-no-files-found: error` для реально запущенного audit: отсутствие обязательного evidence после выполнения producer должно по-прежнему быть явной ошибкой.
- Не менять исторические миграции; не расширять runtime trust boundary за пределами явно одобренного opt-in stdin bootstrap из Task 5 и его описанных ниже ограничений.
- Любой существующий lock (stale, malformed, unreadable, legacy/unknown format либо любой конфликт `EEXIST`) считать конфликтом и fail closed: не читать PID для диагностики, не вызывать `process.kill`, не удалять и не перезаписывать. Ошибка на русском указывает точный путь и требует проверить отсутствие процесса до ручной очистки. Ручное удаление или внешняя подмена lock-файла при работающем Ebb Orchestrator process, использующем этот home, запрещены и находятся вне модели угроз; никакой Ebb process code не меняет lock при `EEXIST`. Fresh lock захватывается только атомарным `open(path, "wx")`; не добавлять dependency или lockfile изменения.
- Новый lock record строго `v1:<canonical-positive-pid>:<32-lowercase-hex-owner-token>\n`; PID — каноническое положительное десятичное число, токен генерируется встроенным `crypto.randomBytes(16)`. Состояние одной instance сериализуется: acquire/release не перекрываются; acquire во время acquiring/held/releasing отклоняется; только instance с удерживаемым in-memory ownership вправе release. Конкурентные вызовы release разделяют один in-flight release, исключая независимые unlink. Release удаляет файл только при точном совпадении прочитанных полных байтов с record acquisition; mismatch/read error сохраняет файл. Compare-then-unlink не защищает от внешней подмены пути между операциями: такая подмена при активном владельце запрещена принятой границей доверия. Если запись owner record после успешного exclusive open завершается ошибкой — закрыть handle, прекратить startup до DB и не пытаться очищать путь; сохранить partial/malformed lock для ручного удаления только после подтверждения отсутствия процессов, использующих home, и выдать точное безопасное русское remediation без содержимого record.
- Сохранить штатный интерактивный first-run wizard как default. Headless bootstrap разрешён только явным `--bootstrap-local-user-stdin`, принимает ровно две записи stdin (пароль и подтверждение), не принимает пароль через argv/env/files/logs и не требует ConPTY; без флага non-TTY first-run продолжает fail closed. Если учётная запись уже существует, bootstrap flag не читает stdin и не меняет её; reset и auth bypass не добавлять.
- Headless bootstrap остаётся одинаковым на Windows/macOS/Linux и использует обычный subprocess stdin/stdout без TTY/ConPTY-инфраструктуры. Проверять эту новую trust boundary отдельным обязательным `ebb-security-review` после реализации.
- Не запускать `pnpm docs:*`, `scripts/docs-governance.mjs` или документационные тесты в рамках выполнения этого плана без отдельного разрешения пользователя.

## Review Focus

- Доказать, что clean `pnpm test` формирует `contracts/dist` до потребляющих его тестов, а решение работает и в GitHub Actions, и в Buildkite, если тот вызывает корневой `pnpm test`.
- Убедиться, что dependency audit выполняется после падения lint/typecheck/test/build, когда успешна установка зависимостей, и его failure status всё ещё завершает job после попытки загрузки evidence.
- Не допустить вторичную ошибку upload при skipped audit из-за неуспешной установки зависимостей; не скрывать отсутствующий файл, если audit был запущен.
- Проверить, что переход `upload-artifact` на v6 сохраняет имя, путь, архивный default и текущую семантику `if-no-files-found`; подтверждать отсутствие `DEP0040` на реальном hosted runner, не по локальному lockfile.
- Удалить каждую production fallback-ветку, создающую user-home `.orchestrator`; tests должны использовать временный каталог, а не писать в настоящий профиль.
- Проверить precedence `.env`/process env и одинаковое поведение `pnpm server:dev`, root `pnpm start`, package `start` и поддерживаемого `scripts/run-server.js`.
- Проверить, что exclusive create — единственная acquisition диагностика: любой `EEXIST` даёт общий русскоязычный конфликт с точным lock path и ручной проверкой процесса; нет PID parsing, `process.kill`, stale auto-recovery либо unlink/overwrite.
- Проверить строгий v1 owner record и точное сравнение полного record на release; замена тем же PID, но другим token, уже существующая до release, сохраняется. Детерминированно проверить, что конкурентные release выполняют не более одного unlink, acquire во время ожидающего release отклоняется и старый async release не удаляет lock после последовательного reacquire. Внешняя подмена между compare и unlink явно вне доверенной модели.
- Проверить ошибку owner-record write: handle закрыт, DB startup не происходит, partial lock сохранён без pathname cleanup, последующий acquire fail closed; операторская инструкция не раскрывает record.
- Проверить, что lock acquisition и запись owner record предшествуют открытию SQLite, миграциям и auth composition; startup smoke доказывает отсутствие DB/listener/READY на конфликте.
- Проверить Task5 framing/deadline: обе записи имеют LF/CRLF, EOF допускается только после второго terminator, лишние байты запрещены; input timer стартует до stream setup и очищается на всех исходах, а persistence идёт вне deadline.
- Проверить, что opt-in headless режим нельзя активировать неявно, читает секрет только при отсутствии пользователя, принимает две согласованные записи и не раскрывает секрет через stdout/stderr, application logs, process argv или environment; дефолтный non-TTY путь по-прежнему отказывает.
- Не смешать изменения с параллельной работой над документацией; `.env.example` и точечный README раздел должны принадлежать только Task 3.

## Tasks

### Task 1 — Сделать CI test graph воспроизводимым и сохранить audit evidence

**Depends on:** none.

**Owner:** CI/workspace scripts.

**Files:**

- Modify: `package.json` — только Task 1: задать промежуточную команду `test` ровно как `pnpm --filter @ebb-orchestrator/contracts build && pnpm -r --if-present test`; не добавлять сюда launcher tests.
- Modify: `.github/workflows/production-gates.yml` — присвоить install step `id: install-dependencies`, сохранить audit evidence после раннего quality-gate failure, условно пропускать upload только когда audit не запускался; перейти на `actions/upload-artifact@v6`.
- Modify: `scripts/security-audit-evidence.test.mjs` — покрыть промежуточный порядок contracts build/workspace tests, полные audit/upload/final-gate expressions, cancellation semantics, artifact path/name, отсутствие upload при skipped producer и выбранный action major.
- Create: `.github/workflows/security-audit-failure-paths.yml` — отдельный `workflow_dispatch` harness для fault-injection сценариев без изменения push/PR поведения production workflow.
- Create: `scripts/security-audit-failure-path-check.mjs` — проверка фактических GitHub step outcomes и наличия/exitCode audit evidence в трёх завершаемых сценариях.
- Modify: `scripts/run-server.test.mjs` — только если CI-условия или команды требуют корректировки общего test harness; не добавлять документационные проверки.

**Interfaces and semantics:**

- Root test ownership/order: Task 1 единолично задаёт промежуточную команду `test` как `pnpm --filter @ebb-orchestrator/contracts build && pnpm -r --if-present test`. Task 3 зависит от Task 1 и задаёт команду `pnpm --filter @ebb-orchestrator/contracts build && pnpm -r --if-present test && node --test scripts/server-env.test.mjs scripts/run-server.test.mjs`. Task 5 последовательно добавляет `scripts/local-user-stdin-smoke.test.mjs` в Node test этап; итоговая команда: `pnpm --filter @ebb-orchestrator/contracts build && pnpm -r --if-present test && node --test scripts/server-env.test.mjs scripts/run-server.test.mjs scripts/local-user-stdin-smoke.test.mjs`. На этапе Task 3 graph состоит из contracts build → workspace tests → launcher/env Node tests; после Task 5 к последнему этапу добавлен bootstrap smoke test. Любой неуспешный этап блокирует следующие через `&&`.
- Граница Task 1 RED/GREEN — только contracts build prefix и порядок workspace tests; launcher tests и финальная root command принадлежат Task 3. Task 1 не заявляет проверку полного Task 3 graph.
- Установочному шагу присвоить `id: install-dependencies`. У audit step установить полный `if: ${{ !cancelled() && steps.install-dependencies.outcome == 'success' }}`: он запускается после upstream quality-gate failure, если зависимости установлены, и пропускается при install failure или отмене workflow.
- Upload step установить полный `if: ${{ !cancelled() && steps.dependency-audit.outcome != 'skipped' }}`. Сохранить `if-no-files-found: error`: если producer был запущен, но evidence не создал, workflow обязан явно упасть; при skipped audit upload не запускается. Отмена workflow не запускает upload.
- Audit failure остаётся `continue-on-error: true` только до upload. Final audit failure-gate установить полный `if: ${{ !cancelled() && steps.dependency-audit.outcome == 'failure' }}` и завершать job ненулевым результатом. При отмене gate не запускается; при ранее проваленном lint/typecheck/test/build, но успешном audit, исходная неуспешность job сохраняется стандартной семантикой GitHub Actions и не маскируется.
- Обновить `actions/upload-artifact` до v6 major: его официальный changelog прямо указывает Node 24 и исправление Node punycode deprecation. Проверить hosted runner compatibility (для self-hosted минимальная версия runner из release notes) и текущие `path`/`name`/missing-file semantics; `archive: false` не включать.
- Fault-injection проверки запускать отдельным workflow, доступным только через `workflow_dispatch`: ранний quality-gate failure, отказ audit, ошибка установки и отмена до audit. Для трёх неотменённых случаев отдельный verifier сверяет все step outcomes и audit evidence; cancellation подтверждать по hosted job conclusions, так как последующие шаги отменённого job не исполняются. Production workflow triggers не менять.
- Не менять workspace `punycode`/`tr46`/`uri-js` overrides без отдельного воспроизведения deprecation из процесса workspace.

**RED:**

- На чистой установке без существующего `packages/contracts/dist` выполнить `pnpm test`; до изменения потребительские server tests должны показать, что отсутствует `@ebb-orchestrator/contracts/dist/index.js`.
- `node --test scripts/security-audit-evidence.test.mjs` должен краснеть на проверках текущего workflow: install не имеет стабильного `id`, три полных `if` expressions отсутствуют/не соответствуют контракту, upload не различает skipped producer, cancellation не специфицирована, а action остаётся v4.

**GREEN:**

- Использовать существующую CI matrix `node-version: 24.x` и `26.x` в `.github/workflows/production-gates.yml:20-23` без добавления новых runtime versions; в обоих clean jobs выполнить `pnpm test`. Ожидание: `contracts/dist` создан до server tests, все не-документационные workspace suites завершаются без `ERR_MODULE_NOT_FOUND`.
- Выполнить `node --test scripts/security-audit-evidence.test.mjs`; ожидание: все workflow/evidence assertions проходят.
- Контрактные assertions должны проверять три полных выражения посимвольно: audit `!cancelled() && steps.install-dependencies.outcome == 'success'`; upload `!cancelled() && steps.dependency-audit.outcome != 'skipped'`; final failure gate `!cancelled() && steps.dependency-audit.outcome == 'failure'` (в YAML каждое выражение обёрнуто `${{ ... }}`). На test-only workflow отдельно запустить fault injection раннего gate failure, самого audit и install; verifier обязан подтвердить соответствующие outcomes, наличие evidence после audit и его `exitCode`. Отдельно отменить workflow во время ожидания до audit и подтвердить через GitHub job/step conclusions, что audit/upload/final gate пропущены, а run отменён.
- На GitHub-hosted runner повторить upload и проверить, что artifact читается под прежним именем и warning `DEP0040` отсутствует.

**Соседние проверки:** `pnpm --filter @ebb-orchestrator/contracts build`; `pnpm test`; `pnpm lint`; `pnpm typecheck`; `git diff --check` для затронутых файлов. Документационные tests/commands не запускать.

**Review Focus:** step conditions GitHub Actions, сохранение исходного fail status, чистая workspace dependency order, точная причина/исчезновение deprecation warning, отсутствие ложного зелёного результата.

**Acceptance:** missing contracts artifact устранён в чистом CI; после раннего fail evidence загружается, если audit действительно исполнился; пропущенный producer не вызывает вторичную upload-ошибку; `DEP0040` отсутствует при upload; workspace punycode dependency graph не менялся без доказательств.

### Task 2 — Удалить устаревший user-home fallback checkpoints

**Depends on:** none.

**Owner:** server Hermes runtime adapter.

**Files:**

- Modify: `apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts` — заменить fallback `os.homedir()/.orchestrator/checkpoints` вычислением `resolveOrchestratorHome(homeEnvironment ?? process.env, resolvedPlatform).runtime/checkpoints`; сохранить явный `checkpointDirectory` override. Существующая `environment?: Record<string, string>` остаётся только источником Hermes child-process environment и проходит `buildEnvironment()` allowlist; не помещать туда `EBB_ORCHESTRATOR_HOME`. Добавить отдельную constructor config опцию `homeEnvironment?: HomeEnv` (импортировать `HomeEnv` из `../../../platform/home/orchestrator-home.js`, тот же тип, что принимает `resolveOrchestratorHome`); default — `process.env`. Добавить `platform?: Platform`, импортируя экспортированный тип `Platform` из `apps/server/src/platform/config/app-config.ts` через существующий module specifier `../../../platform/config/app-config.js`. При отсутствии injection сузить `process.platform` через `validatePlatform(value: string): Platform` из этого же модуля; для любого неподдерживаемого значения валидатор немедленно выбрасывает descriptive error на русском до вызова resolver. Явно переданное `platform?: Platform` уже ограничено статическим union и передаётся напрямую; runtime validation применяется только к строковому default `process.platform`. Не приводить тип cast-ом и не использовать `NodeJS.Platform`; сохранять выбранную платформу и передавать её в resolver. Не читать глобальные значения вместо переданных опций, кроме указанного default `process.env`.
- Modify: `apps/server/src/platform/config/app-config.ts` — рядом с существующим `Platform` union экспортировать `validatePlatform(value: string): Platform`; добавить русскую JSDoc. Возвращать значение только для `linux`, `darwin` или `win32`, иначе выбрасывать descriptive error на русском. Не использовать type cast или `NodeJS.Platform`.
- Modify: `apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts` — импортировать `validatePlatform` из `../../../src/platform/config/app-config.js`; исправить общий `beforeEach`, который сейчас создаёт adapter без `checkpointDirectory`; передавать изолированный temporary path и чистить его через teardown. В этом файле проверить каждый поддерживаемый validator value, unsupported string с descriptive error и отказ adapter при unsupported default platform до вызова resolver. Filesystem regression test создаёт adapter без checkpoint override с `homeEnvironment: { EBB_ORCHESTRATOR_HOME: <temp> }`; `environment` оставить отсутствующим или задать только допустимые child-process allowlist значения, не передавать в него `EBB_ORCHESTRATOR_HOME`. Передать `platform: validatePlatform(process.platform)` (без cast), выполнить операцию, создающую checkpoint, и проверить точный host path `<temp>/runtime/checkpoints`; доказать отсутствие записей в настоящие `USERPROFILE/.orchestrator/checkpoints` и legacy home path. Windows platform selection/path behavior проверять отдельно без filesystem writes, чтобы POSIX test run не передавал win32 resolver-у при записи на POSIX temp path.
- Modify: `apps/server/test/e2e/v1-autonomous-task.test.ts` — передать временный checkpoint path в Hermes adapter test harness.
- Verify only: `apps/server/src/main.ts` — уже передаёт `home.runtime/checkpoints`; менять только если focused test выявит несовпадение.

**Interfaces and semantics:**

- Все production вызовы `HermesRuntimeAdapter` получают checkpoint path из `OrchestratorHomePaths.runtime/checkpoints`; если опция не передана, adapter вычисляет default через тот же `resolveOrchestratorHome`, а не отдельный `os.homedir()` path. Явный override сохраняет приоритет.
- Если `checkpointDirectory` задан, он имеет приоритет. Иначе resolver получает отдельную config option `homeEnvironment?: HomeEnv` (`process.env` по умолчанию), которая типизирована совместимо с аргументом `env` у `resolveOrchestratorHome`; она отвечает только за вычисление home и никак не меняет Hermes child-process environment. Существующая `environment?: Record<string, string>` по-прежнему передаётся только в `buildEnvironment()` и обязана удовлетворять его allowlist; `EBB_ORCHESTRATOR_HOME` задаётся через `homeEnvironment`, а не через `environment`. Resolver также получает `resolvedPlatform`: явно инжектированное `platform?: Platform` передаётся напрямую (тип уже ограничен union `linux | darwin | win32`); только при отсутствии injection строковый `process.platform` проверяется извлечённым валидатором `validatePlatform(value: string): Platform`, иначе выбрасывается descriptive error до любого вызова resolver. Unit/e2e tests обязаны передавать temp path и удалять его через существующий teardown. Filesystem regression использует только host-supported platform через `validatePlatform(process.platform)` без cast; platform selection/path checks для всех значений выполняются отдельно и не пишут в файловую систему. Regression test запрещено направлять на настоящий user profile или legacy path.
- `repo/.orchestrator/` discovery/import contract остаётся без изменений.

**RED:** выполнить `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/home/orchestrator-home.test.ts test/modules/runtime/hermes-runtime-adapter.test.ts` и убедиться, что тесты красные до реализации. Добавить filesystem regression test с `homeEnvironment: { EBB_ORCHESTRATOR_HOME: <temp> }` и `platform: validatePlatform(process.platform)` (без cast): создать adapter без `checkpointDirectory`, запустить операцию, создающую checkpoint, и ожидать запись строго в host-native `<temp>/runtime/checkpoints`; `environment` не содержит `EBB_ORCHESTRATOR_HOME` и остаётся отсутствующим либо включает только allowlist child env; доказать, что реальные `USERPROFILE/.orchestrator/checkpoints` и legacy path не созданы/не изменены. В `hermes-runtime-adapter.test.ts` импортировать валидатор из `../../../src/platform/config/app-config.js` и проверить каждый supported value (`"linux"`, `"darwin"`, `"win32"`) с точным возвращаемым значением и как минимум один unsupported string с descriptive error. Отдельно проверить поддерживаемый явно инжектированный `platform` передаётся adapter-ом resolver-у и выбирает соответствующий platform path без runtime validation; unsupported default `process.platform` приводит к ошибке adapter до вызова resolver. Для этого случая в точном файле `apps/server/test/modules/runtime/hermes-runtime-adapter.test.ts` добавить namespace import `import * as orchestratorHomeModule from "../../../src/platform/home/orchestrator-home.js"` и в Vitest Node runner создать `const resolverSpy = vi.spyOn(orchestratorHomeModule, "resolveOrchestratorHome")` для подсчёта вызовов — это именно spy на export модуля, не Vitest mock-module API. До подмены сохранить `const originalProcess = process`, затем вызвать `vi.stubGlobal("process", new Proxy(originalProcess, { get(target, property, receiver) { return property === "platform" ? "freebsd" : Reflect.get(target, property, receiver); } }))`; Proxy меняет только чтение `platform`, остальные свойства делегирует исходному process. Создать adapter без явного `platform`, ожидать descriptive validation error и проверить `expect(resolverSpy).not.toHaveBeenCalled()`. В `finally` обязательно вызвать `resolverSpy.mockRestore()` и `vi.unstubAllGlobals()`, чтобы оба восстановления произошли и при падении assertions. Не использовать casts, менять global env или писать в filesystem. Все platform selection/path tests не выполняют filesystem writes; глобальные env не менять.

**GREEN:** выполнить `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/home/orchestrator-home.test.ts test/modules/runtime/hermes-runtime-adapter.test.ts` — запускаются именно два указанных файла, включая валидатор из `app-config.ts`, проверяемый в `hermes-runtime-adapter.test.ts`, и все тесты проходят. Mandatory validator tests pass for `linux`, `darwin`, `win32` and unsupported string; a separate selection test confirms a supported explicit `platform` reaches the resolver and selects its platform path without runtime validation, while unsupported default selection throws before the resolver is called. The filesystem regression passes `homeEnvironment: { EBB_ORCHESTRATOR_HOME: <temp> }` and `platform: validatePlatform(process.platform)` without a cast; child-process `environment` excludes the home override and remains allowlisted. The test writes checkpoints only under injected `<temp>/runtime/checkpoints` and confirms no `USERPROFILE/.orchestrator/checkpoints` writes. The unsupported-default test uses the namespace import `orchestratorHomeModule` and `vi.spyOn(orchestratorHomeModule, "resolveOrchestratorHome")` in the Vitest Node runner. It saves `originalProcess = process`, stubs global `process` with `new Proxy(originalProcess, { get(target, property, receiver) { return property === "platform" ? "freebsd" : Reflect.get(target, property, receiver); } })`, then creates the adapter without explicit `platform`, verifies the descriptive validation error and `expect(resolverSpy).not.toHaveBeenCalled()`. In `finally`, it calls `resolverSpy.mockRestore()` and `vi.unstubAllGlobals()`; this is an export spy, not Vitest mock-module API. It changes no global env and performs no filesystem writes. Platform selection/path cases perform no filesystem writes.

**Соседние проверки:** `pnpm --filter @ebb-orchestrator/server typecheck`; `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/home/orchestrator-home.test.ts test/modules/runtime/hermes-runtime-adapter.test.ts`; `git diff --check` по серверным файлам.

**Review Focus:** каждый constructor call site найден; production paths совпадают с home resolver; тесты не пишут в настоящий user profile; `.orchestrator/` остаётся только конфигурацией внутри подключаемого репозитория.

**Acceptance:** и переданный, и default checkpoint path принадлежат общему home resolver; явный home override через `homeEnvironment` соблюдается независимо от child-process `environment`; все тестовые adapters — disposable temp paths; тестовый запуск не создаёт `USERPROFILE/.orchestrator/checkpoints`.

### Task 3 — Загрузить `.env` до разрешения home и документировать безопасный local setup

**Depends on:** Tasks 1 and 2 (в частности, последовательное редактирование root `package.json`).

**Owner:** server launch/configuration and operator setup.

**Files:**

- Modify: `apps/server/package.json` — направить `dev` и package `start` на `node ../../scripts/run-server.js [dev]`.
- Modify: `package.json` — Task 3 единолично направляет root `start` и `server:dev` на `node scripts/run-server.js` и `node scripts/run-server.js dev` соответственно; обновляет `test` с промежуточной Task 1 команды на `pnpm --filter @ebb-orchestrator/contracts build && pnpm -r --if-present test && node --test scripts/server-env.test.mjs scripts/run-server.test.mjs`. Task 5 затем добавляет `scripts/local-user-stdin-smoke.test.mjs` в root Node test этап.
- Modify: `scripts/run-server.js` и `scripts/run-server.test.mjs` — launcher вычисляет абсолютный repo root от `import.meta.url`, передаёт Node `--env-file-if-exists=<absolute repo root>/.env`, поддерживает production/dev режимы с явным executable и args, сохраняет `shell:false` и задаёт child cwd равным repo root независимо от cwd родителя.
- Create: `.env.example` — безопасный шаблон с `EBB_ORCHESTRATOR_HOME` (пояснение об абсолютном platform-specific path) и `PORT`; только safe placeholders, без действительных credentials.
- Verify only / modify only if needed: `.gitignore` — `.env` остаётся ignored, `.env.example` не игнорируется.
- Modify: `README.md` — короткая точная инструкция для optional root `.env`, copy/setup, запуска Windows PowerShell и POSIX shell, env precedence, значения defaults и различия project `.orchestrator/` vs user state `.ebb-orchestrator/`.
- Create: `scripts/server-env.test.mjs` — изолированные tests команд launchers, абсолютного пути `--env-file`, env precedence и ignore/template behavior; добавить этот тест в root `pnpm test` script, чтобы он исполнялся в CI; не запускать документационные checks.
- Modify: `scripts/project-env.test.mjs` only if shared env helper is deliberately reused; предпочесть Node built-in parser over a second parser.

**Interfaces and semantics:**

- Штатные server launch paths (`pnpm server:dev`, root `pnpm start`, `pnpm --filter @ebb-orchestrator/server start`, `node scripts/run-server.js`) используют один launcher. Он вычисляет repository root через `fileURLToPath(new URL("..", import.meta.url))`, передаёт в Node CLI `--env-file-if-exists=<absolute repository root>/.env` до `resolveOrchestratorHome` и задаёт child `cwd` равным repository root; результат не зависит от вызывающего `process.cwd()`. Отсутствующий `.env` не блокирует запуск.
- Launcher contract: production запускает executable `node` с args `['--env-file-if-exists=<root>/.env', '<root>/apps/server/dist/main.js', ...forwardedArgs]`; dev запускает executable `node` с args `['--env-file-if-exists=<root>/.env', '<root>/node_modules/tsx/dist/cli.mjs', 'watch', '<root>/apps/server/src/main.ts', ...forwardedArgs]` и `cwd: <root>`. `<root>/node_modules/tsx/package.json` объявляет `bin: "./dist/cli.mjs"`; запускать JS entrypoint напрямую, не `node_modules/.bin/tsx` (на Windows это `.cmd` shim) и не передавать Node option после entrypoint/как аргумент tsx. Оба режима используют `spawn(..., { shell: false, cwd: root })` и передают исходный process environment без предварительного .env merge. Аргументный порядок проверяется точным equality assertion.

- Priority is process environment > root `.env` > resolver default. Prove this with an actual spawned child Node process, not only launcher argument inspection: conflicting values in parent process and root `.env` must yield the process value; with the parent key absent the child must observe the `.env` value; with both absent, resolver must yield its platform default. The test uses isolated temporary repo-root fixture/home and restores any modified env in `try/finally`; assert no writes to real `USERPROFILE` or legacy path. Do not reuse `loadProjectEnv` unless its merge direction is corrected and the same child-process precedence test proves the contract.
- Использовать поддерживаемый текущим Node engine встроенный `--env-file-if-exists`; не добавлять npm dotenv dependency и не загружать file contents в stdout/stderr.
- `.env.example` — шаблон для копирования, необязательный для запуска при использовании defaults. Включать только не-секретные настройки; actual secrets остаются в защищённом deployment environment/secret manager.
- Не путать `repo/.orchestrator/` (project config) с `~/.ebb-orchestrator/` (local durable app state).

**RED:** добавить isolated `scripts/server-env.test.mjs` cases: проверять production/dev executable, точные args и root cwd; для dev на Windows реально вызвать launcher и проверить `spawn` получил executable `node`, `{ shell: false, cwd: <root> }` и args `['--env-file-if-exists=<root>/.env', '<root>/node_modules/tsx/dist/cli.mjs', 'watch', '<root>/apps/server/src/main.ts', ...forwardedArgs]` без `.cmd`/shell shim; тестом child процесса подтвердить, что Node потребил env-file option до tsx entrypoint. Реально spawn-ить оба режима из cwd repo и `apps/server` и доказывать, что дочерний Node получает тот же абсолютный root `.env`; child-process tests проверяют process > file > resolver default; запуск без `.env` сохраняет default и не падает; `.env.example` содержит только разрешённые имена, а `.env` исключён из Git. Подключить новый тест к root test script. Ожидание: тесты падают на текущих отдельных launcher commands/отсутствующем example.


**GREEN:** выполнить `pnpm test` и `node --test scripts/server-env.test.mjs scripts/run-server.test.mjs`; ожидание: на этапе Task 3 root graph выполняет contracts build → workspace tests → launcher/env tests; дочерний Node действительно наблюдает process > `.env` > resolver default; production/dev spawn используют заданные executable/args и root cwd даже при запуске из различных cwd; отсутствие `.env` не мешает запуску. Bootstrap smoke test `scripts/local-user-stdin-smoke.test.mjs` добавляется в root graph только Task 5. Тесты используют временный fixture/home и фиктивные значения.

**Runtime smoke:** проверить штатный запуск сервера с отдельными disposable, non-production home и database fixtures, заданными через process environment и отдельно через root `.env`; использовать только disposable fixture с уже созданной локальной учётной записью. Подтверждение first-run учётной записи через headless stdin end-to-end smoke принадлежит Task 5. Для каждого запуска проверить `GET /api/v1/health` с bounded polling не более 60 секунд и коротким request timeout, записать HTTP status/body, READY/listener address и абсолютные paths DB/checkpoints/artifacts; все paths должны быть под disposable home и ни один не должен попадать в `USERPROFILE/.orchestrator`. Остановить launcher и проверить завершение child/listener за ограниченный timeout; при timeout сообщить PID/status, не убивать посторонние процессы. Не использовать реальные provider/Infisical credentials. Не требовать ConPTY или интерактивного TTY как инфраструктурного условия плана.

**Соседние проверки:** `pnpm server:build`; `pnpm --filter @ebb-orchestrator/server typecheck`; `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/home/orchestrator-home.test.ts test/modules/runtime/hermes-runtime-adapter.test.ts`; `pnpm lint`; `pnpm typecheck`; `pnpm test`; `git diff --check` по затронутым файлам. Не запускать `pnpm docs:*`, docs-governance scripts или документационные tests без отдельного разрешения.

**Review Focus:** env-file path одинаково разрешается при разных cwd и Windows path syntax; процессные значения сохраняют приоритет; no-secret logging; `.env` ignored; `.env.example` safe; все поддерживаемые launchers согласованы; first-run auth остаётся обязательной, default interactive flow не меняется, а opt-in stdin flow не создаёт reset/bypass и не раскрывает пароль.

**Acceptance:** пользовательский `.env` реально задаёт `EBB_ORCHESTRATOR_HOME` до bootstrap; явное переменное окружение имеет приоритет; README и пример точно описывают необязательность файла и безопасное использование; user data path никогда не падает обратно на `.orchestrator`.

### Task 4 — Fail closed lock ownership и документировать ручную очистку

**Depends on:** Task 3 (Task 3 единолично меняет README для `.env`; Task 4 затем добавляет stale-lock operator guidance без параллельного владельца README).

**Owner:** server process lock and operator guidance.

**Files:**

- Modify: `apps/server/src/platform/process/single-instance-lock.ts` — использовать exclusive create, строгий v1 owner record и guarded release.
- Modify: `apps/server/src/main.ts` — перенести DB open/migrations/auth composition после успешного lock acquire.
- Modify: `apps/server/test/platform/process/startup.test.ts` — покрыть lock conflict/preservation, owner replacement, конкурентный acquire и write failure.
- Create: `scripts/verify-lock-startup.mjs` — disposable cross-platform startup conflict smoke harness.
- Modify: `README.md` — точная инструкция ручной очистки lock, включая запрет ручной подмены активного lock и точное remediation для partial record.

**Interfaces and semantics:**

- Fresh acquisition атомарно создаёт lock через `open(path, "wx")`. Record: `v1:<canonical-positive-pid>:<32-lowercase-hex-owner-token>\n`; token — `crypto.randomBytes(16)`. Любой `EEXIST` — общий fail-closed conflict: не читать PID, не вызывать `process.kill`, не переписывать/удалять содержимое. Ошибка на русском указывает точный lock path и требует проверить процесс перед ручной очисткой. Для write failure использовать точное remediation: `Не удалось записать lock-файл «<точный путь>». Проверьте, что ни один процесс Ebb Orchestrator не использует этот home; только после подтверждения отсутствия таких процессов вручную удалите lock-файл и повторите запуск.`
- Состояния acquisition/release одной instance сериализованы: запрещать acquire в acquiring/held/releasing; только instance с held in-memory ownership имеет право release; конкурентные release callers ожидают одну общую операцию. Это исключает старый release после последовательного reacquire. До unlink сравнить полный record; mismatch/read error сохраняет lock. Тестировать same-PID/different-token replacement, уже существующую перед release. Compare-then-unlink не обеспечивает защиту от произвольной внешней замены пути между шагами: операторская граница запрещает внешнюю подмену lock при активном сервере.
- Если запись owner record после `open("wx")` завершается ошибкой: закрыть handle, остановить startup до DB, не пытаться очищать pathname и сохранить partial/malformed lock. Сообщить без содержимого записи: `Не удалось записать lock-файл «<точный путь>». Проверьте, что ни один процесс Ebb Orchestrator не использует этот home; только после подтверждения отсутствия таких процессов вручную удалите lock-файл и повторите запуск.` Последующий acquire должен fail closed.
- Перенести `main.ts` DB open, migrations и auth construction за успешный lock acquire. Smoke команда: `pnpm server:build && node scripts/verify-lock-startup.mjs`; harness создаёт existing fixture lock в disposable home, запускает server с `shell:false`, проверяет nonzero exit, неизменность lock, отсутствие DB/listener/READY и bounded cleanup только своего child.
- README указывает точный target `<resolved home>/orchestrator.lock`, default POSIX `~/.ebb-orchestrator/orchestrator.lock` и Windows `%USERPROFILE%/.ebb-orchestrator/orchestrator.lock`. Ручное удаление при работающем Ebb Orchestrator process, использующем home, запрещено; сначала подтвердить отсутствие такого процесса.
- Не добавлять dependency/lockfile изменения. Существующая атомарная вставка auth singleton (`id = 1`) в транзакции остаётся дополнительным fail-closed барьером для первой локальной учётной записи; не считать её заменой process lock.
- Все новые/изменённые production comments и JSDoc — на русском.

- **RED:** existing stale-recovery test becomes fail-closed preservation for stale/malformed/legacy existing files. Add deterministic same-PID/different-token replacement release test, exclusive-create contenders with exactly one winner, concurrent release (at most one unlink), acquire rejection during pending release, sequential reacquire safety, and injected record-write failure test proving handle close, no DB startup, preserved partial file and subsequent fail-closed acquisition. Assert acquisition does not inspect PID or call `process.kill`.

- **GREEN:** выполнить `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/process/startup.test.ts`; проверить conflicts/preservation, exactly-one contender, serialized exact-owner release and replacement preservation, deterministic write failure preservation/no DB. Выполнить `pnpm --filter @ebb-orchestrator/server typecheck` и ровно `pnpm server:build && node scripts/verify-lock-startup.mjs`; smoke подтверждает nonzero exit, unchanged lock, no DB/listener/READY. Затем `git diff --check`.

**Соседние проверки:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/process/startup.test.ts`; `pnpm --filter @ebb-orchestrator/server typecheck`; `git diff --check`.

- **Review Focus:** EEXIST без parsing/process liveness и без изменения существующего lock; ownership state serialization, single in-flight release, точный owner record, no unlink on mismatch/read failure; явно принятая trusted-operator boundary запрещает ручную/внешнюю подмену активного lock, без ложного утверждения об atomic protection от неё; DB strictly after lock; write failure closes handle, preserves partial path/no DB; bounded shell:false smoke; русское remediation без содержимого record и ручная очистка лишь после подтверждения отсутствия процессов.

- **Acceptance:** every existing lock blocks unchanged; owner-token check preserves a replacement present before release; instance transitions serialize and stale release cannot unlink a reacquired lock; exactly one contender wins; partial write remains fail-closed and DB untouched; operator guidance prohibits active external replacement and permits manual cleanup only after confirming no process uses the home; security review checks this explicit trust boundary and recovery behavior.

### Task 5 — Добавить opt-in cross-platform stdin bootstrap локального пользователя

**Depends on:** Tasks 3 and 4 (launcher должен прозрачно передавать аргументы; README ownership последовательно проходит Task 3, затем Task 4).

**Owner:** server first-run authentication and headless smoke.

**Files:**

- Modify: `apps/server/src/platform/security/local-user-wizard.ts` — сохранить текущий TTY wizard без изменений для обычного запуска; добавить отдельную функцию/режим чтения двух newline records для явно выбранного headless flow, используя текущие правила проверки и `AuthRepository.createLocalUser`.
- Modify: `apps/server/src/main.ts` — распознать только точный `--bootstrap-local-user-stdin` в `process.argv`; передать выбор в first-run boundary до workers/listener/READY, не менять lifecycle и fail-closed поведение.
- Modify: `apps/server/test/platform/security/local-user-wizard.test.ts` — покрыть headless input, validation, user-exists/no-read, ошибки и секретное содержимое.
- Modify: `apps/server/test/platform/process/startup.test.ts` — проверить интеграцию bootstrap mode с startup ordering и сохранение fail-closed default.
- Create: `scripts/local-user-stdin-smoke.mjs` — cross-platform subprocess smoke harness с disposable `EBB_ORCHESTRATOR_HOME`/database и pipe stdin; valid fake password генерируется runtime криптографической случайностью в памяти, дочерний launcher/server получает только флаг, никогда пароль в argv/env/file/log/output.
- Create: `scripts/local-user-stdin-smoke.test.mjs` — проверка smoke harness argument/env/stdin wiring, secret absence и bounded child cleanup без реального пользовательского home.
- Modify: `package.json` — последовательно после Task 3 и Task 4 добавить `scripts/local-user-stdin-smoke.test.mjs` в root `test` node-test этап, сохранив contracts build → workspace tests → root Node tests порядок.
- Modify: `README.md` — описать только opt-in headless режим, формат двух строк, безопасное формирование pipe из secret manager/CI input без сохранения в файл/командную историю и ограничения; не предлагать пароль как CLI argument или environment variable.

**Interfaces and semantics:**

- Default invocation остаётся существующим `ensureLocalUser(authRepository, process.stdin, process.stdout)`: при первом запуске требует TTY на stdin/stdout и использует существующий raw-mode wizard. Неподдерживаемые/неявные non-TTY варианты по-прежнему завершаются fail closed.
- Единственный opt-in — точный аргумент `--bootstrap-local-user-stdin`. Только этот режим разрешает stdin pipe. Launcher Task 3 должен пересылать его к server entrypoint в прежнем порядке аргументов; неизвестные параметры не должны неявно включать bootstrap.
- Для явного выбора расширить `LocalUserWizardOptions` полем `mode?: "tty" | "stdin"` с default `"tty"`; `ensureLocalUser` сначала проверяет `hasLocalUser()`, затем вызывает неизменённый `runLocalUserWizard` либо отдельный headless reader. `main.ts` выбирает `"stdin"` только при точном `process.argv.includes("--bootstrap-local-user-stdin")`; неизвестные аргументы не меняют режим. Сохранить полезную русскую JSDoc для изменённых exported interfaces/functions.
- До чтения stdin проверяется `authRepository.hasLocalUser()`. Если пользователь уже существует, возврат `EXISTING` без чтения/ожидания/потребления stdin; флаг не предоставляет reset, замену пароля, пропуск auth или дополнительную учётную запись.
- При отсутствии пользователя headless reader получает ровно две записи; каждая обязана завершаться LF или CRLF. Протокол завершается EOF только после второго terminator; любые байты после него отвергаются. 60-секундный input deadline запускается до stream setup/listeners/resume и снимается при каждом settlement (success, EOF, malformed, oversized, error, timeout). На EOF disarm timer перед sync validation/Argon2id/DB transaction; deadline ограничивает только ожидание ввода. Timer/listeners очищаются при каждом исходе; на timeout/error input ставится на паузу и reader buffers обнуляются. Парсер сырых bytes, лимит 4096 bytes на запись, validation/constant-time comparison, secret handling и persistence сохраняются.
- Один процесс на общем home защищён существующим `SingleInstanceLock`, который `main.ts` получает до DB open, миграций и auth bootstrap; fresh lock-файл создаётся эксклюзивно (`open(..., "wx")`), а конфликт приводит к отказу до любого DB доступа. Существующие lock files никогда не auto-takeover. Дополнительный fail-closed барьер — атомарное создание singleton auth-записи (`id = 1`) в транзакции (`apps/server/src/platform/security/auth-repository.ts`, `apps/server/src/platform/database/migrations/026_local_auth.sql`).
- Ни production secret, ни smoke fake password не допускаются в argv/env/file/fixture/log/output; smoke password генерируется при каждом запуске из криптографической случайности только в памяти, stdin payload передаётся только pipe bytes, сравнение выполняется только in-memory. Проверять отсутствие сгенерированного значения в argv/env/files и captured stdout/stderr/logs; по возможности обнулять mutable buffers. Промпты/вывод содержат только status/errors без секретных байтов. Ошибки остаются fail closed до старта worker/listener/READY.
- Smoke harness запускает отдельный disposable server subprocess с `shell:false`, disposable home/database, explicit opt-in flag и stdin pipe; генерирует корректный фиктивный пароль из криптографической случайности только в памяти при запуске, передаёт его байтами только через stdin pipe и сравнивает только в памяти. Значение не хранится в checked-in literal/fixture, argv, env, файле, stdout/stderr или logs; тест проверяет его отсутствие во всех этих местах и по возможности обнуляет mutable buffers. Затем harness подтверждает health `GET /api/v1/health`, готовность, расположение DB/checkpoints/artifacts и bounded graceful shutdown. В `finally` удаляются только disposable home/database. Harness не требует TTY/ConPTY.
- Smoke harness всегда завершает stdin через `end()` и ограничивает ожидание/teardown/остановку child. Добавить тест pipe, который отправляет две записи, но оставляет pipe открытым дольше deadline: bootstrap завершается timeout, пользователь не создан, listeners/input/buffers очищены. Harness не должен оставлять незавершённый child или открытые handles при timeout.

**RED:** focused tests prove each record without LF/CRLF is rejected even if EOF follows; EOF after exactly the second terminated record completes successfully, while any byte after that second terminator is rejected. Cover existing-user/no-read, default non-TTY and validation. Inject short deadline: send both terminated records but leave pipe open; expect timeout before persistence. Assert timer/listener cleanup on success, EOF, malformed, oversized, stream error and timeout, and input pause/buffer zeroing on error/timeout. Harness tests runtime-generated valid fake secret (no checked-in secret literal), stdin.end, and absence of the exact generated value from argv/env/files/captured output/logs, plus bounded cleanup.

**GREEN:** выполнить `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/security/local-user-wizard.test.ts test/platform/process/startup.test.ts`; выполнить `node --test scripts/local-user-stdin-smoke.test.mjs`; выполнить `pnpm server:build && node scripts/local-user-stdin-smoke.mjs` на Windows и хотя бы одном POSIX CI runner (macOS или Linux). Ожидание: tests проверяют LF/CRLF terminators и rejection EOF-before-terminator/bytes-after-second-record; timeout при двух записях и открытом pipe происходит до persistence, timer/listeners очищены на каждом error path; subprocess health/shutdown успешны, секрет отсутствует в capture/log/argv/env. Root test graph по-прежнему включает `scripts/local-user-stdin-smoke.test.mjs` после contracts/workspace tests.

**Соседние проверки:** `pnpm --filter @ebb-orchestrator/server typecheck`; `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/security/local-user-wizard.test.ts test/platform/process/startup.test.ts`; `node scripts/local-user-stdin-smoke.mjs`; `pnpm test`; `git diff --check` по затронутым файлам. После реализации обязателен независимый `ebb-security-review` с фокусом на stdin parsing, secret handling, argument gating, existing-user behavior и fail-closed lifecycle.

**Review Focus:** сравнение argv точное и opt-in; отсутствие чтения pipe при existing user; двухстрочный parser ограничен 4096 байтами на запись и отвергает truncation/лишний ввод/oversized input; default TTY wizard/raw mode неизменён; невозможно получить reset/bypass; корректный fake secret создаётся runtime из crypto randomness только in-memory, передаётся лишь pipe bytes и отсутствует в argv/env/files/captured stdout/stderr/logs; реальные persistence/hash APIs сохраняют только допустимый hash; buffers zeroed where practical; cleanup только disposable home/database в finally; smoke harness не требует ConPTY.

**Acceptance:** first-run остаётся обязательным; обычный запуск сохраняет интерактивный wizard и fail-closed non-TTY; только точный opt-in принимает две согласованные stdin записи при отсутствии пользователя; существующий пользователь не вызывает чтения stdin; smoke runtime-генерирует валидный fake password из криптографической случайности исключительно в памяти, проверяет его отсутствие в argv/env/files/output/logs, подтверждает создание auth record, health/readiness, isolated home и graceful stop на Windows и хотя бы одном POSIX runner без ConPTY; `ebb-security-review` завершён.

## Plan-wide verification

- Для изменения root test graph и action: чистая установка/CI evidence, Node 24 + 26, focused security-audit workflow contract test и hosted выполнение всех четырёх manual failure-path сценариев.
- Для runtime path: focused resolver/adapter tests и controlled smoke с подтверждённым home, health endpoint, graceful stop и отсутствием второго `.orchestrator` каталога.
- Для `.env`: isolated env-file tests плюс проверка каждого штатного server launcher и process-vs-file precedence.
- Для lock policy: focused startup tests, server typecheck, `pnpm server:build && node scripts/verify-lock-startup.mjs`, README operator guidance review; выполнить независимый обязательный `ebb-security-review` после реализации с фокусом на serialized ownership/release, exact record preservation, partial-write fail-closed behavior, DB startup order и явно принятую trusted-operator boundary (без обещания защиты от произвольной внешней подмены между compare/unlink).
- Для opt-in stdin bootstrap: focused auth/startup tests и subprocess pipe smoke на Windows и хотя бы одном POSIX runner (macOS или Linux); явно проверить LF/CRLF termination, EOF framing, open-pipe timeout до persistence и timer/listener cleanup; выполнить независимый обязательный `ebb-security-review` после реализации.
- Repository gates после реализации: `pnpm lint`, `pnpm typecheck`, `pnpm test`, затронутые builds и `git diff --check`; не запускать документационные проверки без отдельного разрешения пользователя.
- Финальный whole-bug review должен отдельно подтвердить шесть результатов: чистый CI test dependency order, audit artifact при upstream gate failure, отсутствие `DEP0040` на hosted runner, единый `.ebb-orchestrator` home с явной `.env` поддержкой, fail-closed lock с owner-token release и DB startup ordering, безопасный opt-in cross-platform stdin bootstrap при неизменном TTY default.

## Текущий результат исполнения

- Изменения кода на commit `f3f658211609c6b74c5748b66f24d1e983bb42e4` (`fix: await graceful E2E backend shutdown`) опубликованы в `master` fast-forward-ом из `develop`.
- GitHub Actions run `36358730911` для этого commit завершился `success` на `ubuntu-latest`; jobs Node 24 и Node 26 прошли. В обоих jobs Browser E2E завершился `6 passed`, а Node harness/security tests — `24 passed`.
- В каждом GitHub Actions job шаги `Dependency audit` и `Upload dependency audit evidence` завершились `success`; artifact с прежним именем `pnpm-audit-prod-f3f658211609c6b74c5748b66f24d1e983bb42e4` загружен. Содержимое обоих JSON artifacts проверено: `exitCode: 0`, advisories пусты, все уровни vulnerabilities равны нулю. Поиск в hosted logs не нашёл `DEP0040` или `punycode`.
- Buildkite #34 для того же commit также завершился `passed` на Node 24/26. Workflow запускает POSIX stdin bootstrap smoke после server build.
- На Windows прошли `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `node scripts/local-user-stdin-smoke.mjs`, `node scripts/verify-lock-startup.mjs`, `node scripts/verify-local-startup.mjs`, `pnpm --filter @ebb-orchestrator/web test:e2e` и `git diff --check`.
- Добавлен dispatch-only workflow `.github/workflows/security-audit-failure-paths.yml`; production workflow triggers не менялись. `scripts/security-audit-failure-path-check.mjs` сверяет outcomes upstream/audit/install сценариев и проверяет наличие audit evidence с ожидаемым `exitCode`.
- `node --test scripts/security-audit-evidence.test.mjs` прошёл: 9/9; contract test проверяет YAML workflow/условия, а helper получает позитивные фикстуры для трёх failure сценариев и отрицательную фикстуру с неверным upload outcome. Независимый read-only review harness получил `PASS`.
- **Остаётся обязательный hosted acceptance:** запустить все четыре сценария через GitHub Actions; подтвердить загрузку artifact при upstream/audit failure, пропуск audit/upload при install failure и фактическую отмену до audit с соответствующими step conclusions. Статус плана остаётся `in_progress` до проверки этих результатов.
