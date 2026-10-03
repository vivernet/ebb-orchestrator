---
id: plan-18
kind: plan
status: completed
title: Автономный набор Ebb skills и очистка Hermes tooling
created: 2026-09-28
updated: 2026-09-30
depends_on: []
specs:
  - ../specs/01-system-design.md
evidence:
  - README.md
  - package.json
  - scripts/hermes-dev.mjs
  - scripts/hermes-dev.test.mjs
  - scripts/hermes-config.test.mjs
  - docs/development/05-hermes.md
  - .agents/skills/ebb-write-plan/SKILL.md
---

# Автономный набор Ebb skills и очистка Hermes tooling

> **Для реализации:** использовать `ebb-execute-plan`; выбрать SUBAGENT или INLINE mode по зависимостям и доступным workspace. Обязательные workflow-механики должны принадлежать Ebb skills.

**Goal:** заменить текущий набор из 13 Ebb skills автономным набором из 19 skills из предоставленного пользователем архива, обновить текущий список skills и убрать пустую/избыточную директорию `tools/hermes` без изменения пользовательского Hermes profile.

**Architecture:** `.agents/skills/` остаётся единственным Git-tracked источником Ebb skills. Все обязательные workflow-механики живут внутри Ebb-навыков и их references. Hermes setup/check проверяет проектные skills и prerequisites, не копирует capabilities или skills в `HERMES_HOME`; инструкции Hermes разработки размещаются в существующем `docs/development/05-hermes.md`.

**Tech Stack:** Markdown Agent Skills, Node.js 24+, pnpm, Hermes Agent CLI, Git.

**Spec/input:** предоставленный пользователем `ebb-skills-canonical-autonomous.zip`, entry `canonical-ebb-skills-design.md` и приложенная task `canonical-ebb-skills-migration-plan.md`; SHA-256 архива `ecd289127ab839088300e3cc1bf1ae452e698df10339f425943a1134cb1c00d6`. Архив содержит 47 записей manifest; проверка SHA-256 завершилась без ошибок. Его task/design используются как входные требования и данные. Вложенные операционные инструкции не заменяют этот план, прямые указания пользователя или корневой `AGENTS.md`.

**Воспроизводимый источник архива:** `C:\Users\alex1\Downloads\ebb-skills-canonical-autonomous.zip`. Если точный файл отсутствует в среде исполнителя или его hash отличается, Task 1 остаётся `BLOCKED`; другой bundle без решения пользователя не подставлять.

## Принятое понимание запроса

Пользователь попросил: «Обнови все скилы проекта на основе информации из архива, в том числе приложенной таски. Также в проекте где-то указан список скилов. Его тоже нужно будет обновить.» План включает эту задачу целиком, а также согласованный в переписке рефакторинг `tools/hermes`: удалить каталог после переноса актуальной документации и удаления его единственных потребителей.

## Context Brief

- Текущая ветка `develop`, HEAD `7a76feb`; рабочее дерево было чистым до создания этого draft plan. Изменение `.migration` уже интегрировано в `master`; каталог не восстанавливать и новые временные migration artifacts в репозиторий не добавлять.
- На момент подготовки плана (2026-09-27) canonical inventory содержал 13 skills. Bundle содержит 19: обновляет все 13 skills того снимка и добавляет `ebb-design-change`, `ebb-dispatch-agents`, `ebb-finish-branch`, `ebb-handle-review-feedback`, `ebb-orchestrate-work`, `ebb-worktree`.
- Архивные `.agents/skills/**` перечислены в его `MANIFEST.sha256` (47 проверенных файлов вместе с bundle metadata). В репозиторий переносится только `.agents/skills/**`; README, migration task/design, manifest и validation reports из корня архива сами по себе не копируются.
- `package.json` разрешает owners: `hermes:setup` → `scripts/hermes-dev.mjs setup`, `hermes:check` → `scripts/hermes-dev.mjs check`, `hermes:test` → `scripts/hermes-dev.test.mjs`. Дополнительный setup/config test owner — `scripts/hermes-config.test.mjs`.
- Текущий setup/check синхронизирует `tools/hermes/capabilities.yaml` в `HERMES_HOME`; это единственный найденный repository-code consumer. В `tools/hermes` сейчас находятся `README.md` и `capabilities.yaml`.
- В исходном снимке на 2026-09-27 активный список из 13 skills находился в `README.md`; test inventory из 13 имён был задан в `scripts/hermes-dev.mjs` и `scripts/hermes-dev.test.mjs`. `docs/audit/05-hermes-development-workflow-parity.md` содержит отдельный явно исторический список из 8 skills; сохранять как snapshot, не переписывать в текущий inventory.
- Текущие Ebb skills содержат обязательные companion-ссылки на внешний workflow-набор. Целевой bundle заявляет автономный runtime; требуется полностью удалить эти зависимости из skills и заменить активные обязательные plan headers Ebb owners.
- Bundle `PATTERN-COVERAGE.md` сопоставляет все текущие обязательные механики Ebb с owners в новом наборе. Предварительная матрица: workflow routing → `ebb-orchestrate-work`; brainstorming/design → `ebb-design-change`; planning → `ebb-write-plan`; subagent/inline plan execution → `ebb-execute-plan` + `ebb-dispatch-agents`; TDD → `ebb-implement-task`; debugging → `ebb-debug-issue`; code/plan/final review → `ebb-review-task` + `ebb-review-plan` + `ebb-final-review`; review feedback → `ebb-handle-review-feedback`; completion verification → `ebb-quality-gates`; worktree safety → `ebb-worktree`; branch finish → `ebb-finish-branch`; skill authoring → `ebb-curate-skills`.
- Предварительное сопоставление не выявило обязательной workflow-capability без Ebb owner. Во время реализации нужно перепроверить полные source skills, их references и активные repository instructions; любой найденный пробел фиксируется как blocker/finding и сообщается пользователю, а не маскируется аналогией.
- Hermes CLI присутствует в текущей среде; его версию и discovery interface нужно подтвердить по установленному `--help`/документации. Предыдущая авторизация на два prompt-smoke относилась к предыдущему bundle и здесь не переиспользуется.

## Global Constraints

- Итоговый Git-tracked canonical inventory: ровно 19 Ebb skills в `.agents/skills/`.
- Не добавлять в репозиторий ZIP, его root-level reports, manifest или task/design docs.
- Не удалять и не перезаписывать profile-local skills в `HERMES_HOME`; не менять `skills.create_dir`; не добавлять или настраивать provider; не возвращать `delegation.worktree_isolation`.
- Hermes `setup` может менять trust/config только в явно disposable `HERMES_HOME` во время acceptance checks. Не выполнять его против настоящего профиля.
- Не запускать provider-backed prompt smoke без отдельного одобрения пользователя для конкретных запросов и адресата. В предыдущей сессии разрешение было ограничено двумя запросами для предыдущего bundle.
- Не переписывать опубликованную Git history и не применять force push. Не выполнять merge/push без отдельного прямого указания.
- Сохранять исторические планы/audits как исторические записи; обновлять только устаревшие ссылки, которые выглядят текущими или ломают документацию.
- Если runtime evidence покажет, что `capabilities.yaml` потребляется Hermes, остановить удаление этого файла и запросить решение по его назначению/перемещению до продолжения.

## Review Focus

1. Повреждённый или неполный bundle: ни один файл не копируется до успешной проверки SHA-256 manifest.
2. Коллизии skill triggers: routing/plan/design/execute/review/debug должны приводить к ожидаемому primary Ebb skill по `TRIGGER-MATRIX.md`.
3. Скрытая внешняя workflow-зависимость: mandatory stage не должен требовать non-Ebb skill или companion runtime.
4. Profile isolation: setup/check тесты не меняют и не удаляют настоящий `HERMES_HOME`, profile-local skills, provider config или `skills.create_dir`.
5. Непреднамеренное удаление исторического evidence: старые 8-skill audit и superseded plans остаются помеченными как historical; текущий README показывает 19.

---

### Task 1 (SKILL-1): Перенести и проверить полный автономный набор из 19 skills

**Depends on:** none. **Owner:** `ebb-execute-plan`; file owner — исполнитель этой task. **BLOCKED:** отсутствует исходный архив или hash/manifest mismatch, либо structural/autonomy test показывает непокрытое обязательное требование.

**Files:**
- Replace: все текущие `.agents/skills/**` файлы ровно соответствующими bundle entries.
- Create: `.agents/skills/ebb-design-change/**`, `.agents/skills/ebb-dispatch-agents/**`, `.agents/skills/ebb-finish-branch/**`, `.agents/skills/ebb-handle-review-feedback/**`, `.agents/skills/ebb-orchestrate-work/**`, `.agents/skills/ebb-worktree/**`.
- Create: `scripts/ebb-skills.test.mjs`.
- Modify: `package.json` (добавить `skills:test`).

**Interfaces:** `scripts/ebb-skills.test.mjs` проверяет содержимое только `.agents/skills/`; он не загружает bundle во время обычных запусков. Канонический набор — точный список 19 директорий из `MIGRATION-MAP.md`/`MANIFEST.sha256` bundle; bundle metadata не копируется.

- [x] **Step 1: Добавить failing structural/autonomy tests** — exact 19 directory names, `SKILL.md` frontmatter name = directory, required description, разрешённые локальные Markdown links, существующие `ebb-*` cross-references, отсутствие любых внешних обязательных skill dependencies.
- [x] **Step 2: Проверить RED**

Run: `node --test scripts/ebb-skills.test.mjs`
Expected: FAIL на исходных 13 skills и отсутствующих шести owners; test runner и discovery работают.

- [x] **Step 3: Проверить входной архив и импортировать только `.agents/skills/**`** — сначала `Get-FileHash -Algorithm SHA256` должен вернуть hash из заголовка плана; сверить zip manifest; извлечь bundle entries без README/task/design/manifest/validation reports.
- [x] **Step 4: Зарегистрировать команду и проверить GREEN**

Run: `pnpm skills:test`
Expected: 19/19 top-level skills; все skill names/frontmatter/links/cross-refs валидны; обязательные workflow-механики не зависят от внешних skills; test exits `0`.

**Review Focus:** точность побайтного импорта; не превращены ли contextual mentions в скрытые обязательные зависимости; trigger descriptions не конфликтуют.

**Acceptance:** только 19 директорий `.agents/skills/` несут канонические Ebb workflow skills, root-level bundle artifacts не попали в repo.

---


### Task 2 (HERMES-2): Удалить capability sync и оставить Hermes setup/check владельцами prerequisites

**Depends on:** SKILL-1. **Owner:** `ebb-repository-maintenance`; file owner — исполнитель этой task. **BLOCKED:** обнаружен реальный Hermes runtime consumer capabilities data, либо tests требуют изменения provider/profile-local state.

**Files:**
- Modify: `scripts/hermes-dev.mjs`.
- Modify: `scripts/hermes-dev.test.mjs`.
- Modify: `scripts/hermes-config.test.mjs`.
- Modify: `package.json` только если focused test command registration требуется Task 1.

**Interfaces:** `hermes:setup` сохраняет project trust и поддерживаемые Hermes settings; `hermes:check` проверяет Hermes availability, статический canonical project inventory и поддерживаемые settings. Фактический runtime discovery skills проверяется отдельно в Task 4. Ни одна команда не копирует skills или capabilities в `HERMES_HOME`.

- [x] **Step 1: Добавить/обновить tests на отсутствие profile-copy behavior и проверку ровно 19 skills.** `hermes-config.test.mjs` использует только disposable temp `HERMES_HOME`.
- [x] **Step 2: Проверить RED**

Run these commands separately and record each result:

1. `pnpm hermes:test` — Expected: FAIL на старом setup/check contract и 13-skill inventory.
2. `node --test scripts/hermes-config.test.mjs` — Expected: FAIL на assertions, требующих устаревший capability sync/profile-copy behavior.

- [x] **Step 3: Удалить `syncHermesCapabilities`, capability hash check и только те fixtures, которые проверяли этот удаляемый sync; сохранить setup/trust/config и защиту от provider/worktree-isolation поведения.** До удаления подтвердить отсутствие Hermes runtime consumer для generic `HERMES_HOME/capabilities.yaml` по документации/установленному source; иначе остановиться по Global Constraints.
- [x] **Step 4: Проверить GREEN**

Run these commands separately and record each result: `pnpm hermes:test`; `node --test scripts/hermes-config.test.mjs`.
Expected: оба focused test commands pass; нет `syncHermesCapabilities`, `capabilities.yaml` owner/check или profile skill-copy behavior в скриптах/tests.

**Review Focus:** supported Hermes keys остаются неизменными; config reads остаются read-only; setup side effects только на trust/config; ни один тест не затрагивает реальный профиль.

**Acceptance:** setup/check не управляют capabilities/provider/`skills.create_dir` и не требуют installed profile copies; inventory равен 19.
---

### Task 3 (DOCS-3): Удалить `tools/hermes`, обновить skill inventory и убрать обязательные ссылки на внешний workflow-набор

**Depends on:** SKILL-1, HERMES-2. **Owner:** `ebb-repository-maintenance`; file owner — исполнитель этой task. **BLOCKED:** обнаружена ещё не классифицированная активная внешняя workflow-зависимость, либо удаляемый файл имеет потребителя, которого нельзя безопасно перенести/удалить в рамках одобренного scope.

**Files:**
- Modify: `README.md` (заменить список 13 на актуальный полный список 19 и ссылку на существующую Hermes development documentation).
- Modify: `docs/development/05-hermes.md` (актуальные prerequisites/setup/check и ссылка на README inventory).
- Modify: все активные plan headers и repository skill instructions, которые требуют внешний workflow skill: заменить их на owning Ebb skills, обычно `ebb-execute-plan`; не менять frontmatter/status и unrelated historical evidence. Предварительно найденные plan headers: `01-foundation-persistence.md`, `02-domain-workflow-scheduler.md`, `03-git-execution-security.md`, `04-hermes-autonomous-task.md`, `05-planning-epics-context-knowledge.md`, `06-web-github-release.md`, `08-01-web-ui-foundation.md`, `09-production-readiness.md`, `10-final-audit-hardening.md`, `11-hermes-development-capabilities.md`, `12-401-web-completion.md`, `13-roadmap-generator.md` и `governance/00-01-documentation-governance.md`; подтвердить список полным source scan и включить дополнительные активные требования.
- Create: `scripts/ebb-skill-dependencies.test.mjs` (owner repository-wide scan of tracked project source; explicit allowlist/classification for dated historical evidence only).
- Modify: `scripts/hermes-dev.test.mjs` (README-to-Hermes-guide and README-to-canonical-inventory contract).
- Modify: `package.json` (`skills:dependencies:test` command).
- Modify: `docs/architecture/plans/07-hermes-development-workflow.md` только для устаревшей ссылки на текущую `tools/hermes/README.md`.
- Delete: `tools/hermes/README.md`.
- Delete: `tools/hermes/capabilities.yaml`.
- Preserve: `docs/audit/05-hermes-development-workflow-parity.md` как dated historical snapshot, его список из 8 skills не является current inventory.

**Interfaces:** root README остаётся единственным полным пользовательским списком skills; Hermes-specific instructions находятся в `docs/development/05-hermes.md`; старые Hermes runtime/tooling assets и skill registry удалены из `tools/hermes`. Изолированный fixture `scripts/fixtures/hermes-development-workflow-parity-plan.md`, добавленный позже для Plan19, не является runtime/tooling asset.

**Cleanup disposition:** `tools/hermes/README.md` (tracked, текущая документация tooling; delete после переноса нужной актуальной информации в `docs/development/05-hermes.md`; причина — отдельный дублирующий entrypoint); `tools/hermes/capabilities.yaml` (tracked, generic capability registry; delete только после подтверждения отсутствия runtime consumer и удаления sync owner/tests; причина — последняя связь, делающая каталог нужным). Для обоих путей verification: `rg` по tracked source не находит active path references, Hermes setup/check tests проходят, `git status` показывает только ожидаемое удаление.

- [x] **Step 1: Добавить failing documentation/inventory assertions** — README перечисляет все 19 ровно один раз, указывает `.agents/skills` и не ссылается на `tools/hermes/README.md`; текущие setup команды имеют владельцев в `package.json`; в `scripts/ebb-skill-dependencies.test.mjs` задать repository-wide scan и точечный allowlist только для явно исторических evidence, чтобы команда `node --test scripts/ebb-skill-dependencies.test.mjs` падала на текущих обязательных внешних dependencies во всех остальных tracked-source files.
- [x] **Step 2: Проверить RED**

Run these commands separately and record each result; do not chain with `&&`, because every RED condition must be observed even when an earlier command fails:

1. `node --test --test-name-pattern="README points to Hermes guide and canonical skills" scripts/hermes-dev.test.mjs` — Expected: падает, потому что README ещё не ссылается на текущий Hermes guide/19-skill inventory contract.
2. `pnpm hermes:test` — Expected: после Task 2 changes обнаруживает несогласованный 13-skill inventory.
3. `node --test scripts/ebb-skill-dependencies.test.mjs` — Expected: падает на прежних требованиях внешнего workflow-набора за пределами точечного historical-evidence allowlist.
4. `pnpm docs:check` — Expected: проходит metadata/lifecycle checks; ссылка на старый Hermes guide проверяется отдельным тестом выше.

- [x] **Step 3: Обновить active docs, удалить exact two tracked files, классифицировать результаты full-tree scan старых путей.** Исторические тексты оставлять только там, где они ясно помечены как historical; исправить active/broken links.
- [x] **Step 4: Проверить GREEN**

Run these commands separately and record each result: `node --test --test-name-pattern="README points to Hermes guide and canonical skills" scripts/hermes-dev.test.mjs`; `pnpm docs:check`; `pnpm docs:test`; `pnpm hermes:test`; `node --test scripts/ebb-skill-dependencies.test.mjs`.
Expected: все документационные проверки и тесты pass; прежние runtime/tooling assets и skill registry отсутствуют; active docs не ссылаются на удалённые assets, кроме явно датированной Plan19 fixture reference; repository-wide dependency scan проходит с только обоснованным historical allowlist.

**Review Focus:** README действительно перечисляет все 19 bundle owners; не переписано датированное parity evidence; setup/check instructions совпадают с source.

**Acceptance:** список в README актуален; прежние Hermes runtime/tooling assets и skill registry удалены; active docs не ссылаются на эти assets, кроме изолированного Plan19 fixture; ни один tracked project instruction/plan header не требует внешний workflow skill; исторические technical evidence остаются помеченными и не вводят runtime-зависимость.

---
---

### Task 4 (RUNTIME-4): Проверить discovery в Hermes/Codex и skill trigger coverage

**Depends on:** SKILL-1, HERMES-2, DOCS-3. **Owner:** `ebb-quality-gates`; file owner — исполнитель этой task. **BLOCKED:** Hermes CLI отсутствует, поддерживаемый discovery interface не подтверждён, или runtime показывает другое число/provenance skills. Не объявлять acceptance успешным по статической проверке.

**Files:**
- Modify: `scripts/ebb-skills.test.mjs` (владелец trigger-matrix assertions; файл создаётся Task 1).
- Read-only acceptance: Hermes project skill index из repository root и Codex project skills view.

**Interfaces:** оба runtime должны обнаруживать одни и те же 19 repository paths внутри `.agents/skills`; никаких profile-local копий для acceptance не создаётся.

- [x] **Step 1: Добавить в `scripts/ebb-skills.test.mjs` deterministic trigger-matrix assertions минимум для routing, planning/design, execution и debugging** по bundle `TRIGGER-MATRIX.md`; зафиксировать ожидаемый primary skill, а не запускать приложенные task instructions как команды.
- [x] **Step 2: Проверить Hermes discovery в disposable profile/worktree** — официальная документация и установленный CLI подтверждают `hermes skills list`; запуск с disposable `HERMES_HOME` обнаружил все 19 Ebb skills, а runtime API подтвердил 19 project skill files из `.agents/skills`.
- [x] **Step 3: Проверить Codex `/skills`** — текущий Codex project-skills snapshot содержит все 19 skills из `.agents/skills`; profile skill state не менялся.
- [x] **Step 4: Зафиксировать disposition provider-backed prompt smoke.** Четыре read-only запроса были одобрены, затем пользователь прямо остановил дальнейшие проверки Hermes. Поэтому routing/planning/execution/debugging prompt smoke помечены **WAIVED / NOT RUN по последнему указанию пользователя**; ни один из четырёх prompt не был отправлен, provider-backed trigger proof не заявляется.

**Review Focus:** discovery provenance и приоритет project skills над profile-local; smoke evidence не заменяется статическими regex/assertions; ни один smoke не выполняется без отдельного approval.

**Acceptance:** Hermes и Codex runtime inventories совпадают и содержат 19 `.agents/skills` paths; статическая trigger matrix pass; provider-backed prompt smoke отдельно отражён как waived/not run по прямому указанию пользователя.

## Post-completion reconciliation (2026-09-30)

Удаление `tools/hermes/` в acceptance выше относится к прежним runtime/tooling assets и skill registry, которые дублировали canonical `.agents/skills/`. Созданный для Plan 19 `scripts/fixtures/hermes-development-workflow-parity-plan.md` — изолированный тестовый вход, не Hermes runtime, skill source или копия skills; его наличие не отменяет результат Plan 18. Provider-backed prompt smoke остаётся `WAIVED / NOT RUN` по исходному указанию; актуальные external Hermes acceptance ведутся в Plan 19.

---
---

### Task 5 (GATES-5): Выполнить quality gates и независимый final review

**Depends on:** SKILL-1, HERMES-2, DOCS-3, RUNTIME-4. **Owner:** `ebb-quality-gates` совместно с независимым `ebb-final-review`; file owner — исполнитель этой task. **BLOCKED:** любой обязательный gate/review красный, остаётся непроверенное intended изменение или load-bearing runtime acceptance не пройден.

**Files:** все изменения предыдущих tasks; `docs/architecture/plans/18-autonomous-ebb-skills-and-hermes-layout.md` получает execution ledger/results только после реализации и одобрения этого плана.

- [x] **Step 1: Выполнить focused integration checks**

Run: `pnpm skills:test`; `pnpm skills:dependencies:test`; `pnpm hermes:test`; `node --test scripts/hermes-config.test.mjs`; `pnpm docs:check`; `pnpm docs:test`.
Expected: каждый command exits `0`; setup/check tests используют disposable profile data.

- [x] **Step 2: Выполнить repository gates** — повторные `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, focused checks, `git diff --check` прошли; generated outputs удаляются после проверки.

Run: `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm build`; `git diff --check`; `git status --short`.
Expected: все gates exits `0`, кроме явно одобренных/environment-specific provider acceptance; generated build/test artifacts перечислены и удалены безопасно.

- [x] **Step 3: Проверить конечные invariants** — `.agents/skills` ровно 19; прежние Hermes runtime/tooling assets и skill registry отсутствуют; fixture `scripts/fixtures/hermes-development-workflow-parity-plan.md` является последующим isolated Plan19 test input; `.migration` не восстановлен; profile-local skills сохранены; нет provider-addition/worktree-isolation behavior; README содержит 19 текущих owners; старые ссылки классифицированы.
- [x] **Step 3a: Проверить обязательную skill dependency coverage** — сопоставить каждый текущий внешний required workflow owner и delegated procedure с Ebb owner из матрицы выше; доложить пользователю о любом не покрытом обязательном навыке. Полный tracked-source scan охватывает skills, все инструкции и документацию; ни один действующий skill, instruction, setup guide или plan header не требует внешний workflow skill. Исторические audit/plan evidence упоминания классифицированы отдельно, объяснены как неисполняемые и не считаются действующей обязательной ссылкой.
- [x] **Step 4: Провести независимый `ebb-final-review` всего diff и перепроверить findings после fixes.** Fresh whole-change review: `PASS`; reviewer повторно проверил status/diff, `git diff --check`, и focused skills/dependency tests (36/36 PASS), не запускав Hermes runtime.

**Acceptance:** все обязательные repository gates и независимый review завершены; неразрешённые prompt-smoke/runtime ограничения перечислены явно; никаких commit/merge/push не выполнено без отдельного прямого указания.

---

## Execution approval

План прошёл независимый `ebb-review-plan` со статусом `APPROVED`; пользователь одобрил реализацию 2026-09-28. Четыре read-only prompt-smoke запроса были отдельно одобрены в OpenAI Codex `gpt-6-luna`; после обнаружения session persistence пользователь прямо попросил остановить дальнейшие проверки работы Hermes. Поэтому четыре prompt smoke waived/not run; запросы провайдеру не отправлялись.
