---
id: plan-28
kind: plan
status: proposed
title: Обязательный OpenSpec для разработки Ebb Orchestrator
summary: Полная миграция процесса разработки Ebb Orchestrator на OpenSpec-only, обязательное использование 12 workflow из ebb-skills, fail-closed проверки Codex/Hermes, интеграция governance, CI и миграция активной работы.
created: 2026-10-30
updated: 2026-11-06
---

# Plan 28 — Mandatory OpenSpec Development Workflow

> **Полностью новый план.** Заменяет прежний проект `28-openspec-development-workflow.md` как предложение; старый файл не следует применять. Статус `proposed`: это спецификация предстоящей работы, не свидетельство установки или завершения тестов. Перед реализацией — независимый `ebb-review-plan`, утверждение и повторная проверка актуального `develop`.
>
> **Метод:** Superpowers `writing-plans`: явные границы, file/interface map, малые зависимые задачи, RED→GREEN, независимый review, исполнимые проверки. Исполнение — через субагентов Ebb. Superpowers не устанавливается и не становится частью runtime; требования к OpenSpec — обязательные, не рекомендательные.

## 0. Решение, которое нельзя переинтерпретировать

**Пользователь утвердил исключительно OpenSpec Mode.** Никакого `Standalone Mode`, `legacy mode`, `fallback`, `optional`, `best effort`, «при отсутствии OpenSpec использовать прежний `ebb-*` workflow», автоматического переключения в Ebb-only или `skip-open-spec` не существует.

**Результат:** ВСЕ применимые операции разработки **самого репозитория** Ebb Orchestrator, запущенные через `ebb-*`, обязаны проходить соответствующие **реальные OpenSpec skills** и работать с OpenSpec change artifacts. `ebb-*` не дублируют реализацию OpenSpec, а вызывают/применяют его workflow и сохраняют Ebb-специфичные оркестрацию, субагентов, безопасность, review, TDD, Git и release policy. При недоступности нужного OpenSpec skill, CLI, change или обязательного artifact — **BLOCKED**, без самостоятельной реализации. Исправление отсутствующей инфраструктуры — разрешённый bootstrap/recovery шаг, а не альтернативный режим разработки.

**Область:** процесс разработки репозитория. **НЕ** интегрировать OpenSpec в production runtime Ebb Orchestrator, `AgentRuntime`, `SpecificationProvider`, runtime API, UI, БД или проектные workflow конечных пользователей. Это отдельный будущий product milestone, не включённый здесь.

**Scope изменения старой политики:** прежнее требование «`ebb-*` skills автономны и не имеют runtime dependency от внешних skills» **целенаправленно отменяется только для development-time OpenSpec**. Новое правило: OpenSpec — единственная разрешённая обязательная внешняя зависимость `ebb-*` процесса разработки; Superpowers/прочие внешние skills всё ещё не могут быть обязательными. Правило должно быть одинаково изменено в `AGENTS.md`, `ebb-curate-skills`, `ebb-orchestrate-work`, tests и остальных затронутых entrypoints; нельзя оставить старую policy, блокирующую новую.

**Никаких ложных гарантий:** инструкции и статические тесты сами по себе не могут физически запретить любой ручной `git commit` или обход через произвольный prompt. Требуется максимальная практическая защита: агентные контракты + детерминированный preflight/CI + фактические E2E проверки вызовов skills и evidence. Не заявлять, что text-only rule даёт OS-level enforcement.

## 1. Контекст репозитория (подтверждён на `develop` 2026-10-30)

- Репозиторий: `vivernet/ebb-orchestrator`; default branch `develop`; pinned полный SHA **получить заново в Task 00**, не копировать SHA из старых планов.
- `AGENTS.md`: deterministic-first, modular monolith, Git/worktrees, source-gates, 2 concurrent subagents max; до первого production release validated fast-forward в `develop`, после — squash PR. `master` исключительно published release snapshots и отсутствует при zero published releases после разрешённого перехода.
- `.hermes.md` **содержит устаревшее утверждение, что primary branch = `master`**. Привести к каноническому `AGENTS.md`.
- `.agents/skills/` — канонические навыки Ebb; несколько skills и `references` **ещё содержат PR/squash-only формулировки**, противоречащие актуальному pre-first-release исключению. Исправить при миграции по фактической веточной политике, не механическим search/replace.
- `docs/architecture/specs/01-system-design.md` — утверждённый architectural contract; `docs/architecture/plans/` — история и ранее принятые plans; `docs/roadmap/generated.md` — generated, руками не править.
- Исходная система: Node >=24.15, pnpm >=12; реальные `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm skills:test`, `pnpm skills:dependencies:test`, `pnpm docs:check`, `pnpm docs:roadmap`, `pnpm docs:test` и domain-specific gates.
- В `develop` **не обнаружен** `openspec/config.yaml` (проверить снова до изменений). Действующие тесты skills проверяют запрет обязательных внешних зависимостей — их нужно **осознанно перенастроить**, а не отключить.
- Plan 20 и Plan 26 имеют незавершённые работы; выпуск/withdrawal по-прежнему только по явному запросу через `ebb-release`. Никакого автоматического релиза при архивации OpenSpec.

**Единственный authoritative Git contract:** актуальный `AGENTS.md` и `docs/architecture/policies/branch-and-release-policy.md`, а не устаревший README/skill. Перед write ещё раз выяснить текущие status/release/ref/policies.

## 2. Стек, версии и инварианты

**Предлагаемый pin для первого внедрения:** `@fission-ai/openspec` **exact `1.16.0`** (последний официальный релиз, опубликованный 2026-10-30); npm-установка требует Node.js `>=22.12.0`, что покрывается целевой версией репозитория `>=24.15`. Это кандидат, который Task 00 обязан повторно сверить с официальными релизами, поддерживаемыми ОС и нужными CLI-флагами/семантикой до любых dependency changes. Если pin меняется, синхронно обновить все version-bound контракты ниже и повторно пройти review плана. В `devDependencies` фиксировать точную версию без `^`/`~` в `pnpm-lock.yaml`; CLI запускать **через `pnpm exec openspec`**. Не полагаться на `openspec` из global `PATH`; недопустим silent update в CI. Последующие обновления закреплённого pin — отдельный OpenSpec change с регенерацией файлов, тестами и review.

OpenSpec schema — `spec-driven`. Все 12 workflows `propose`, `explore`, `new`, `continue`, `apply`, `update`, `ff`, `sync`, `archive`, `bulk-archive`, `verify`, `onboard`. Delivery — skills. Targets: `codex`, `hermes`. Codex: `.agents/skills/openspec-*/SKILL.md`, invocation `$openspec-*`; Hermes: `.hermes/skills/openspec-*/SKILL.md`, invocation `/openspec-*`, плюс настройка `skills.external_dirs` на машине. Наличие файлов **не доказывает** фактическое обнаружение в Hermes — отдельный smoke обязателен.

**Важная особенность CLI:** выбранный профиль 12 workflow хранится **в user/global OpenSpec config**, а не в `openspec/config.yaml` проекта. Для воспроизводимости создать **repo-owned manifest + hermetic generator**, поднимающий временный `XDG_CONFIG_HOME` с фиксированным JSON `profile=custom, delivery=skills, workflows=[12 IDs]`, без изменения пользовательского global config. `openspec init --tools codex,hermes --profile custom` запускать в disposable fixture. В проект переносить только проверенные generated files. `openspec update` без hermetic profile в рабочем проекте запрещён: он может перезаписать набор по пользовательскому профилю.

**Безопасность:** generated OpenSpec skill инструкции — dependency от reviewable pinned CLI, но они не могут отменять `AGENTS.md` security rules. No secrets in prompts/change artifacts/logs; no unauthorized push, integrations, destructive Git; `shell:false` в новых Node wrapper scripts; temp outside repo; no silent remote network access; никаких массированных изменений source вне approved scope.

## 3. После внедрения: один обязательный процесс

```text
Запрос на изменение самого Ebb Orchestrator
  └─ ebb-orchestrate-work → validate mandatory OpenSpec preflight
      ├─ explore / triage [read-only] → openspec-explore
      ├─ подготовка change:
      │     openspec-propose
      │       ИЛИ openspec-new-change → openspec-continue-change
      │       ИЛИ openspec-ff-change
      │     └─ openspec-update-change при корректировке
      ├─ approved proposal + specs + design + tasks
      │     └─ ebb-review-plan → APPROVED (fresh independent review)
      ├─ ebb-worktree от pinned develop
      │     └─ ebb-execute-plan → openspec-apply-change
      │            ├─ task subagent → ebb-implement-task → RED/GREEN
      │            ├─ fresh ebb-review-task → fix/review cycle
      │            └─ tasks.md checklist + stable evidence
      ├─ openspec-verify-change + ebb-quality-gates + ebb-final-review
      ├─ approved Git integration → ebb-finish-branch → post-integration gates
      └─ openspec-sync-specs → openspec-archive-change
          (bulk-archive только explicit batch, каждый change проходит свои gates)
```

**Критически важный ordering:** Архивирование — после доказанной интеграции и post-integration tests; OpenSpec skill `archive` не заменяет Ebb release или Git integration. `sync` не может изменять утверждённую архитектуру без отдельного design approval. Если редактирование уже существующего `openspec/specs/` должно попасть в тот же merge, применить sync в интегрируемой задаче с последующим verification, но **архивацию выполнять в разрешённой post-integration lifecycle-ветке/worktree того же `changeId`**, затем интегрировать её отдельно согласно Git policy. Это этап закрытия уже существующего change, а не создание нового OpenSpec change, которое вызвало бы рекурсивную цепочку. Не допускать рассинхронизации source vs develop. Это не разрешение мутировать `develop` напрямую в обход контролируемого процесса.

**Read-only pre-change:** `ebb-repository-context`, поиск, предварительный issue triage и изучение документации могут читать репозиторий без change, но **не могут изменять tracked files**. Как только появляется намерение мутации (включая bugfix, README, тесты, infra) — mandatory OpenSpec change. Исключение ровно одно: первоначальная техническая установка OpenSpec в рамках утверждённого bootstrap Task 01–02, после которого change создаётся до любых массовых правок skills/политик. Это не «второй режим».

## 4. Ownership и запрет двух конкурирующих workflow

| Ресурс | Единственный владелец | Правило |
|---|---|---|
| `openspec/changes/<id>/.openspec.yaml`, `proposal.md`, `design.md`, `specs/**`, `tasks.md` | OpenSpec workflows | Канонический change artifact; `ebb-*` читает и уточняет через OpenSpec, не создаёт отдельный самостоятельный план тех же задач. |
| `openspec/specs/<capability>/spec.md` | `openspec-sync-specs` / `openspec-archive-change` | Canonical принятого **поведенческого** контракта; до merge main specs не считать delta уже принятой. |
| `docs/architecture/specs/01-system-design.md`, policies | Ebb architecture/governance | Higher-level architectural invariants; OpenSpec не меняет без approval и явного follow-up. |
| `docs/architecture/plans/` | Исторические одобренные планы + **этот одноразовый bootstrap Plan 28** | **Не создавать второй параллельный implementation plan для новых changes**. Для новых работ единственный task ledger — `openspec/changes/<id>/tasks.md`. |
| `docs/roadmap/generated.md` | Existing roadmap generator | Обновлять через generator; добавить OpenSpec changes как derived projection, а не второй источник истины. |
| `.agents/skills/ebb-*` | Ebb skill maintainers/`ebb-curate-skills` | Адаптеры/оркестрация на OpenSpec, fail closed; не копировать contents generated OpenSpec skills. |
| `.agents/skills/openspec-*`, `.hermes/skills/openspec-*` | OpenSpec pinned generator | **Никогда не редактировать вручную**: только regenerate + diff + review. |
| `.hermes.md`, `AGENTS.md`, `openspec/config.yaml` | Проектная governance | Политики, instruction hierarchy, boundaries; краткие ссылки вместо дублирования десятков страниц. |
| Git/CI/gates, evidence, worktrees, release | Ebb policies/skills | OpenSpec не принимает решения о merge, approval, security или release. |

**Миграция действующих plans:** активные approved legacy plans остаются evidence, но продолжить их **в Ebb-only нельзя**. До следующей мутации для такого плана создать отдельный OpenSpec change, импортировать только ещё актуальные/incomplete tasks с точными ссылками и approval, проверить дубли и пересечения, затем применять через OpenSpec. Completed plans не переписывать и не импортировать массово. Bootstrap Plan 28 после установки имеет собственный OpenSpec change.

## 5. Реестр 12 skills и вызывающий Ebb owner

Имена workflow идентичны официальной OpenSpec 1.16.0 схеме; generated skill names должны быть **точно** следующими:

| OpenSpec skill | Как используется в Ebb | Trigger / Gate |
|---|---|---|
| `openspec-explore` | `ebb-orchestrate-work`, `ebb-design-change`, `ebb-debug-issue` | Исследование, выбор решений до изменения кода; read-only. |
| `openspec-propose` | `ebb-orchestrate-work`, `ebb-design-change` | Основной путь создания всех planning artifacts после достаточного контекста. |
| `openspec-new-change` | `ebb-design-change`, `ebb-write-plan` | Начать сложную/пошаговую работу с change scaffold. |
| `openspec-continue-change` | `ebb-design-change`, `ebb-write-plan` | Создать следующий artifact в последовательности dependency DAG. |
| `openspec-ff-change` | `ebb-design-change`, `ebb-write-plan` | Быстро собрать **planning artifacts**, не выполнять код. |
| `openspec-update-change` | `ebb-design-change`, `ebb-write-plan`, `ebb-handle-review-feedback` | Изменившиеся требования/ревью; после существенной правки design → re-approval. |
| `openspec-apply-change` | `ebb-execute-plan`, `ebb-implement-task`, `ebb-debug-issue` | Обязательный task execution workflow с scoped briefs; **не разрешение OpenSpec работать поверх Ebb review/concurrency**. |
| `openspec-verify-change` | `ebb-review-task`, `ebb-quality-gates`, `ebb-final-review`, domain overlays | Проверка фактической реализации против specs/design/tasks; evidence не равен автоматическому PASS. |
| `openspec-sync-specs` | `ebb-finish-branch`, `ebb-maintain-project-docs` | Merge spec deltas в canonical specs после разрешённой проверки; порядок Git как в §3. |
| `openspec-archive-change` | `ebb-finish-branch`, `ebb-final-review` | Только после integrated SHA + post-integration gates + review; archiving не делает релиз. |
| `openspec-bulk-archive-change` | `ebb-orchestrate-work` + `ebb-finish-branch` | Отдельное явное batch-задание после индивидуальной проверки каждого change; никакой auto-bulk. |
| `openspec-onboard` | `ebb-orchestrate-work`, development onboarding docs | Учебный walkthrough **на реальном безопасном change** с теми же approvals/gates; не считается PASS установки без E2E. |

**«Все 12» означает:** все установлены, discovery и вызовы проверены, каждому присвоен owner; не требуется бессмысленно запускать `bulk-archive`, `onboard`, `new`, `ff`, `propose` на каждом bugfix. Они вызываются при подходящем событии. **Нет ни одной ветки разработки, обходящей OpenSpec.**

## 6. Полный audit/migration map ВСЕХ 23 текущих `ebb-*` навыков

> Конкретные файлы необходимо сверить с текущим `develop` в Task 00. Указаны как прямые edits, так и проверки на отсутствие bypass. Не придумывать несуществующие skills.

| `ebb-*` | Обязательное изменение/проверка |
|---|---|
| `ebb-orchestrate-work` | **Переписать router**: OpenSpec preflight mandatory; 12 workflow dispatch; запрет Ebb-only, strict stop conditions. |
| `ebb-repository-context` | Регистрировать current `changeId`/schema/status/paths, pinned source, OpenSpec availability; read-only inventory допускается до change, mutation нет. |
| `ebb-design-change` | Прямые handoffs `explore/propose/new/continue/ff/update`; approval для load-bearing design сохраняется. |
| `ebb-write-plan` | Убрать независимую генерацию новых `docs/architecture/plans` как альтернативу; применять OpenSpec `design.md` + `tasks.md`, структуру RED/GREEN, interface map и acceptance внутри этих artifacts; `update/continue`. |
| `ebb-review-plan` | Ревью OpenSpec `proposal/specs/design/tasks` и `openspec status/validate`; запрет «APPROVED» при missing change. |
| `ebb-execute-plan` | Input = `changeId` (не самостоятельный plan path); `openspec-apply-change` + `instructions apply` + subagent task dispatch, progress checklist, retries и evidence. |
| `ebb-implement-task` | Работает только с однозначным `changeId/taskId`, применяет OpenSpec apply под Ebb ownership, TDD, не закрывает task без tests/review. |
| `ebb-review-task` | Проверяет конкретный task + spec scenarios и вызывает OpenSpec verify в scoped context; fresh reviewer, read-only. |
| `ebb-final-review` | OpenSpec verify обязательный поверх Ebb independent review + security/CI. |
| `ebb-quality-gates` | `openspec validate --all --strict` + targeted status + проверка actual verification evidence; не заменяет lint/test/build. |
| `ebb-finish-branch` | Sync/archive protocol и текущая conditional develop integration policy; атомарность не утверждать. |
| `ebb-handle-review-feedback` | Если правка меняет requirements/design/tasks — `openspec-update-change` до fix, затем new approval/verify. |
| `ebb-debug-issue` | Read-only triage/explore → обязательный change до bugfix; apply/regression test через OpenSpec. |
| `ebb-dispatch-agents` | Каждый implementing subagent получает changeId/taskId/artifact refs; общий лимит два, контроль доступа к mutable scope, отсутствие agent-inline bypass. |
| `ebb-worktree` | Не создавать mutating task workspace до approved OpenSpec artifacts (кроме bootstrap/diagnostic readonly); pinned develop/isolated branch. |
| `ebb-security-review` | Кросс-проверка security scenarios OpenSpec, trust boundary, approve requirement и secret handling. |
| `ebb-web-e2e` | Привязка E2E к requirement/scenario IDs, results → verify evidence. |
| `ebb-database-engineering` | Migration/rollback invariants добавлять в OpenSpec design/tasks/specs; TDD/schema gates. |
| `ebb-repository-maintenance` | Любая docs/tooling/refactor mutation требует OpenSpec change; не обходить через «maintenance»; генерируемые files обновлять безопасно. |
| `ebb-maintain-project-docs` | README/.env.example/docs меняются в change, affected-owner closure; отражать commands/version; spec sync только authorized. |
| `ebb-curate-skills` | Изменить autonomy invariant: OpenSpec — обязательное **разрешённое** внешнее skill-семейство; другие external skills запрещены; RED/GREEN/pressure tests. |
| `ebb-notes` | Read-only сбор заметок возможен; превращение заметки в implementation → OpenSpec `propose/new`; без скрытого кодового пути. |
| `ebb-release` | Release **только explicit-user**; OpenSpec не триггерит release, но изменение самого release tooling требует change. Проверка отсутствие обхода archive→release. |

Требуется проверить и обновить `SKILL.md`, локальные `references/*`, routing cues, descriptions, docs и `agents/openai.yaml` у affected skills; **не переписывать неизменные файлы только для галочки**. Не создавать 23 дублированных OpenSpec orchestrator. Ownership routing остается однозначным.

## 7. Project files — file/interface map до начала реализации

| Create/Modify | Owner / точный контракт |
|---|---|
| `package.json`, `pnpm-lock.yaml` | exact dependency `@fission-ai/openspec: 1.16.0`; scripts ниже, existing deps untouched. |
| `scripts/openspec/profile.json` **new** | `{ "version":"1.16.0", "tools":["codex","hermes"], "delivery":"skills", "workflows":[12 exact ids] }`; single repo-owned profile source. |
| `scripts/openspec/setup.mjs` **new** | `--write`, `--check` (default --check); hermetic `XDG_CONFIG_HOME`, temp fixture, pinned CLI, exact deterministic generation, compare/write only allowlisted generated paths. |
| `scripts/openspec/setup.test.mjs` **new** | Test profiles, generated trees, extra/missing/corrupt skill, no global-config mutation, malicious paths and version mismatch. |
| `openspec/config.yaml` **new** | `schema`, `context`, `rules` for proposal/specs/design/tasks, `operations.apply/archive.guidance` (only documented fields). |
| `.agents/skills/openspec-*/SKILL.md`, `.hermes/skills/openspec-*/SKILL.md` **new generated** | 12 each, exact pinned OpenSpec output; no manual edits. |
| `AGENTS.md`, `.hermes.md` **modify** | Mandatory OpenSpec policy, fail-closed, branch alignment, permission/security precedence. |
| `.agents/skills/ebb-*/SKILL.md`, affected `references/*` **modify** | 23-skill audit matrix §6; accurate owner invocations, no alternate route. |
| `scripts/ebb-skills.test.mjs`, `scripts/ebb-skill-dependencies.test.mjs` **modify** | Permit **only** named OpenSpec required dependency, disallow others and bypass, assert all owners/skills. |
| `scripts/openspec/governance.mjs` **new** | CLI `--check --change=<id>` / `--check-all` / `--report-json`; deterministic statuses/blockers; no simulated execution claim. |
| `scripts/openspec/governance.test.mjs` **new** | Missing skill, corrupt config, no change, missing artifacts, tasks no checkboxes, archive-before-gates, stale mappings, conflicts, failure exits. |
| `scripts/openspec/pressure.test.mjs` **new** | Trigger/route negative and positive tests for 23 Ebb owners / 12 OpenSpec workflows; dynamic session smoke separately. |
| `docs/development/08-openspec-mandatory-workflow.md` **new** | Setup Windows/Codex/Hermes, use cases, migration, owner matrix, failure recovery; проверить свободный номер/metadata. |
| `docs/architecture/plans/28-openspec-mandatory-development-plan.md` **existing** | Этот документ — сам bootstrap plan; не создавать его дубликат и не хранить в нём будущий task ledger. |
| `docs/roadmap/generated.md` **generated only** | Обновлять через `pnpm docs:roadmap`; если понадобится — отдельно расширить `scripts/roadmap-generator-cli.mjs` и tests. |
| `.github/workflows/production-gates.yml` **modify** | OpenSpec setup/check, governance, tests, strict validate; update existing jobs carefully, no weaken/fail-open. |
| `README.md` и затронутые docs | `ebb-maintain-project-docs`: команды/constraints, без ложного статуса E2E. |
| `openspec/changes/mandatory-openspec-development/` **new** | Bootstrap change: `.openspec.yaml`, `proposal.md`, `design.md`, `specs/`, `tasks.md`. Начать ДО mass edits `ebb-*`. |

**Допустимые будущие script commands после Task 03:**

```json
{
  "openspec:setup": "node scripts/openspec/setup.mjs --write",
  "openspec:setup:check": "node scripts/openspec/setup.mjs --check",
  "openspec:check": "node scripts/openspec/governance.mjs --check-all",
  "openspec:test": "node --test scripts/openspec/*.test.mjs"
}
```

`pnpm exec openspec validate --all --strict` и `pnpm exec openspec status --all --json` используются как отдельные source commands. `--check-all` — флаг нашего будущего script, **не** встроенный OpenSpec.

## 8. План задач: зависимости, RED → GREEN и evidence

Каждая task реализуется отдельным implementation subagent и независимо reviewed; controller только orchestrates. Общий лимит **2** активных subagents (implementer/reviewer/scout/fix вместе). Начальные Task 00–02 — **bootstrap** создания обязательного OpenSpec состояния, а не разрешение создавать Ebb-only функциональность. После Task 02 никакой tracked source mutation без `changeId`.

### Task 00 — Preflight, source identity, доказательство конфликтов

**Depends on:** none. **Deliverable:** `docs/architecture/plans/evidence/28-00-baseline.md` (или путь, одобренный действующим docs governance; предварительно проверить правила). Read-only inventory, затем write только как часть approved bootstrap.

- [ ] Зафиксировать full `develop` SHA и upstream/ref ancestry; `git status --short`, `git worktree list --porcelain`, `git branch --show-current`, `git log -1 --oneline`; подтвердить release state и актуальную pre/post-first-release policy.
- [ ] Прочитать все **23** `.agents/skills/ebb-*/SKILL.md`, их затронутые references и `AGENTS.md`, `.hermes.md`, `.gitignore`, `package.json`, skill/docs/governance tests. Подтвердить точный список; newly added/removed owners вне этого snapshot включить в matrix.
- [ ] Найти все самостоятельные Ebb-only exit/entry paths, старыe `master`/PR-only assumptions, references к `docs/architecture/plans/` как active new-plan requirement, запреты external skills, conflict with CodeX/Hermes discovery.
- [ ] Проверить существующий OpenSpec (`openspec/`, пользовательский global settings) без изменения global settings, Node/pnpm versions; проверить real generated skill paths и CLI flags в pinned docs.
- [ ] Повторно проверить официальный latest release и кандидатный pin OpenSpec по ОС, Node/runtime, доступным профилям и version-specific CLI flags/семантике (`init`, `status`, `instructions`, `validate`). v1.16.0 от 2026-10-30 требует Node.js >=22.12 для npm-install; целевой Node проекта >=24.15. Зафиксировать exact `--version`, `--help` и совместимость. Если кандидатный pin изменился или не покрывает обязательные пути, обновить все version-bound места в этом плане и получить свежий `ebb-review-plan` до Task 01; silent upgrade запрещён.
- [ ] Снять test baseline `pnpm skills:test`, `pnpm skills:dependencies:test`, `pnpm docs:check`; failures от текущего HEAD отделить от regression.

**RED:** отсутствие `openspec/config.yaml`, версионного профиля или хотя бы одного `openspec-*` / found Ebb-only mutation path фиксируется как expected baseline failure. **Expected:** конкретный список gap с file:line/owner и SHA. **Review Focus:** отсутствие невидимой разрушительной операции; старые права не заменены гипотезой. **BLOCKED:** dirty/unrelated modifications с overlap или неизвестные refs/release state.

### Task 01 — Hermetic pinned CLI и генерация ровно 24 skills

**Depends on:** 00. **Create:** `scripts/openspec/profile.json`, `setup.mjs`, `setup.test.mjs`; **Modify:** `package.json`, `pnpm-lock.yaml`; **Generate:** `.agents/skills/openspec-*`, `.hermes/skills/openspec-*`.

- [ ] RED test: отсутствует `1.16.0`, профиль изменён, workflow missing/duplicate, tool extra, навыков 11/12, generated byte drift, mutation user's `%APPDATA%`, отсутствие CLI, fake `$PATH` binary — `--check` возвращает non-zero с диагностикой.
- [ ] Реализовать `profile.json` с exact IDs и типами; strict JSON parser и immutable expected set, reject unknown keys/duplicates.
- [ ] Добавить pinned dependency; изолированный child process с `XDG_CONFIG_HOME=<system temp>/config`, содержащим generated `openspec/config.json` с `profile: custom`, `delivery: skills`, `workflows: [12]`. Команда child: `pnpm exec openspec init <temp-project> --tools codex,hermes --profile custom --no-animation`. Проверить пути в фактической `--help` 1.16.0 и binary source.
- [ ] `--write`: сравнить 24 skills с temp output и перенести только canonical OpenSpec managed paths; не касаться `.agents/skills/ebb-*` и иных файлов, не чистить user directories. `--check`: сгенерировать temp output, сделать byte-for-byte compare, вернуть non-zero при расхождении; очистить temp в `finally` без `git clean`.
- [ ] Проверить no network during generation после локального install; не делать silent dependency install/version upgrade; unknown changes требуют explicit upgrade change.
- [ ] GREEN: `pnpm openspec:setup:check` (после появления script) PASS, ровно 12 Codex и 12 Hermes directories; повторное `--write` idempotent (zero diff). Доказать что пользовательский global OpenSpec config не поменялся.

**Interfaces:** `profile.json` → temp CLI generator → managed file snapshot; script outputs stable status `{status,version,tools,workflows,drift}` через CLI для machine audit (не добавлять output parsing без теста). **Review Focus:** supply chain, env override, path traversal, no collateral deletion. **BLOCKED:** pinned CLI не умеет hermetic config/targets; выбрать корректную официальную CLI настройку в рамках того же OpenSpec-only решения, но не отключать требование 12 workflows.

### Task 02 — Создание первого обязательного OpenSpec change и проектного config

**Depends on:** 01. **Create:** `openspec/config.yaml`, `openspec/changes/mandatory-openspec-development/{.openspec.yaml,proposal.md,design.md,tasks.md,specs/...}`.

- [ ] RED: нет OpenSpec change, не существует requirements/scenarios, отсутствует `tasks.md` с чекбоксами, неверные `operations`/`rules`, `openspec status` not complete → stage fails.
- [ ] Создать `schema: spec-driven`; `context` на русском со ссылками на Ebb architecture/AGENTS, branch/release policy, two-subagent cap, TDD, Russian JSDoc, no secrets.
- [ ] `rules.proposal/specs/design/tasks`: явный goal/non-goals, normative SHALL и WHEN/THEN, approval/recovery, named task IDs, RED/GREEN, file owners, dependencies, evidence, test commands и docs ownership. `operations.apply.guidance` про обязательную Ebb dispatch/subagents/gates; `operations.archive.guidance` про reviewed integrated SHA, post-integration gates, no release and no drift.
- [ ] Вызвать **реальный** OpenSpec `openspec-propose` (или `openspec-new-change` + `openspec-continue-change`) для `mandatory-openspec-development`. В него перенести approved требования этого Plan 28; `tasks.md` становится единственным execution checklist. Не копировать второй независимый plan в `docs/architecture/plans/`.
- [ ] Выполнить `pnpm exec openspec status --change mandatory-openspec-development --json` и `pnpm exec openspec validate mandatory-openspec-development --strict --no-interactive`; независимый `ebb-review-plan` проверяет spec/task completeness до дальнейших implementation задач.
- [ ] GREEN: реальные planning artifacts существуют, содержат тестируемые сценарии запрета Ebb-only, оба CLI PASS, reviewer `APPROVED`.

**Review Focus:** связь решения пользователя и normative scenarios; `opsx:ff` не автоматически одобряет дизайн; архитектурный source-of-truth не переписан без согласования. **BLOCKED:** нельзя сформировать полный change после установки; implementation не стартует.

### Task 03 — Single source of policy: AGENTS + Hermes + route contract

**Depends on:** 02. **Modify:** `AGENTS.md`, `.hermes.md`, `.agents/skills/ebb-orchestrate-work/SKILL.md`, `references/workflow-router.md`; **Create/Modify:** `scripts/openspec/governance.mjs`, `governance.test.mjs` initial gates.

- [ ] RED fixtures: новый bugfix или docs change без `changeId` пытается перейти к write; missing skill; global profile core; stale `master` в Hermes; archive before integration; no approval; refusal fallback. Expected: `BLOCKED_OPENSPEC_REQUIRED` / `BLOCKED_PROFILE_INCOMPLETE` / `BLOCKED_ARTIFACT_INCOMPLETE` / `BLOCKED_APPROVAL_REQUIRED` (новые project-owned reason codes, **не** утверждать, что это коды OpenSpec CLI).
- [ ] Подтвердить и записать precedence `AGENTS.md` → architecture/security/branch policies → OpenSpec workflow → Ebb specialization; OpenSpec skill текст не отменяет approved Ebb safety rules.
- [ ] Rewrite router с формальными states `READ_ONLY_DISCOVERY`, `CHANGE_DRAFT`, `CHANGE_REVIEWED`, `EXECUTING`, `VERIFYING`, `INTEGRATED`, `ARCHIVED`, `BLOCKED`; разрешённые переходы, требуемые artifacts/gates, owner skill. Не создавать второй persistent state machine в продукте.
- [ ] Нормализовать `.hermes.md`: primary=`develop`; ссылки на current policy, mandatory OpenSpec; убрать прямой независимый path→implement.
- [ ] Governance CLI `--check --change=<id>` проверяет существование active change, нормализованный safe ID, four artifact groups, OpenSpec status/validate (вызовы argv без shell), не изменяет файлы; `--check-all` проверяет repo setup/profile/layout/spec validation. Test regex alone insufficient: parse actual CLI JSON and verify errors/exits.
- [ ] GREEN: read-only research разрешён; все мутации без change блокируются; approved change проходит; список 12 flows доступен, no fallback branch. Подтвердить manual repo instructions в новой сессии Codex/Hermes.

**Review Focus:** no hidden mode flag; correct branch semantics; agent mention ≠ actual skill invocation. **BLOCKED:** нет достоверного способа определить active change из переданного ID/worktree или policy contradiction, требующий нового design approval.

### Task 04 — Переписать planning skills под OpenSpec (без дублирования)

**Depends on:** 03. **Modify:** `ebb-design-change`, `ebb-write-plan`, `ebb-review-plan`, `ebb-repository-context`, `ebb-notes`, `ebb-debug-issue`, `ebb-handle-review-feedback`, associated references/tests.

- [ ] RED pressure: `ebb-write-plan` создаёт standalone `docs/architecture/plans/29-...` без change; `ebb-design-change` пишет design вне OpenSpec; bugfix прямо меняет код; ревью одобряет plan без specs/requirements.
- [ ] `ebb-design-change` фиксирует `openspec-explore`, затем выбирает 1 из `propose` ИЛИ `new→continue` ИЛИ `ff`, с критерием выбора; `openspec-update-change` единственный путь ревизии existing artifacts.
- [ ] `ebb-write-plan` расширяет OpenSpec `tasks.md` (не отдельный источник) к строгому task contract: id, dependency, owner, exact file paths, interfaces, test-first RED, GREEN, acceptance/evidence/Review Focus. Если OpenSpec built-in template слишком краток — добавить правила в `openspec/config.yaml` и/или project-local OpenSpec schema **только после proof gap**; не патчить generated skill.
- [ ] `ebb-review-plan`: check proposal/design/specs/tasks coherence, check actual commands exist, security constraints and current branch exception. `APPROVED` требует реальный `changeId` и stable artifact snapshot (SHA/content hash), invalidate on load-bearing update.
- [ ] `ebb-debug-issue`: диагностика read-only, затем change по сложности; даже 1-line fix не Ebb-only. `ebb-handle-review-feedback` → update/review on changed contract.
- [ ] GREEN: для feature, bug, docs-only, infra change 4 positive/negative scenarios + reviewer verdict. Не переписывать completed legacy plans.

**Review Focus:** never create competing new plan; no implicit approval; no bypass by calling bounded-task skill. **BLOCKED:** necessary OpenSpec artifact lacks owner in documented workflow.

### Task 05 — Исполнение, субагенты и task ledger

**Depends on:** 04. **Modify:** `ebb-execute-plan`, `ebb-implement-task`, `ebb-dispatch-agents`, `ebb-worktree`, `ebb-review-task`, `ebb-database-engineering`, `ebb-security-review`, `ebb-web-e2e`; associated references/tests.

- [ ] RED: implementer получает только текст issue, нет `changeId/taskId`; два implementer + reviewer = три active agents; агент закрывает `tasks.md` сам до review; OpenSpec apply пытается исполнить всё change в одном несвязанном context.
- [ ] Новый вход `ebb-execute-plan`: exact `changeId`; task IDs из актуального OpenSpec `tasks.md`; `approvedArtifactHash`, pinned `developBaseSHA`, worktree, dependency DAG; без standalone plan path.
- [ ] Task dispatch вызывает **`openspec-apply-change`** или использует его official instructions в именованном agent context, применительно **только к назначенному taskId**; execution controller остаётся Ebb, не даёт OpenSpec агенту самовольно вести параллельные реализации/merge. Проверить реальную семантику в Codex/Hermes E2E; если skill игнорирует scoping, проектный ограничитель в agent brief и проверка изменённых файлов обязательны.
- [ ] Каждая task: failing reproduction/test → minimal implementation → focused tests → fresh `ebb-review-task` → update checkbox только после usable evidence; failed review → scoped fix (max rounds по Ebb rules); transient failure retry managed by Ebb. Общий предел 2 active subagents включая reviewers.
- [ ] Каждый domain skill добавляет requirements/scenarios и gates к OpenSpec change. Работа без `changeId` заблокирована, даже если вызывается напрямую `ebb-implement-task`/`ebb-repository-maintenance`.
- [ ] GREEN: две независимые tasks допускаются по доказанно disjoint mutable scope; пересекающиеся serial; partially failed task остаётся uncompleted; restart/recovery читает OpenSpec status/task file, ledger и Git, не верит только model claims.

**Interfaces:** `ChangeRef {changeId,taskId,artifactHash,baseSha,worktreePath}` — проектный internal brief, не продуктовый DTO; names/format зафиксировать в `ebb-execute-plan/references` или existing ledger schema; не добавлять в server/core без явного product approval. **Review Focus:** no controller inline coding, no 3+ agents, no secret leakage, correct task status. **BLOCKED:** OpenSpec apply cannot be bounded without writing unrelated files — stop and fix orchestration, never silently switch to Ebb-only.

### Task 06 — Verify, quality-gates, финальная интеграция и lifecycle

**Depends on:** 05. **Modify:** `ebb-quality-gates`, `ebb-final-review`, `ebb-finish-branch`, `ebb-release`, `ebb-maintain-project-docs`, `ebb-repository-maintenance`; tests.

- [ ] RED: all checkboxes checked but behavior violates WHEN/THEN; OpenSpec verify skipped; CI red; source SHA unverified; stale master PR target; sync mutates architecturally protected docs; archive during open task; auto release on archive.
- [ ] `openspec-verify-change` реально invoked как Ebb required gate; зафиксировать requirement/scenario → test → evidence, coverage gaps and NOT_RUN separately. Gate остается failure при load-bearing findings даже если CLI `validate` PASS.
- [ ] Полный `pnpm lint`, `pnpm typecheck`, `pnpm test`, applicable `pnpm build`, E2E/security, `pnpm skills:*`, `pnpm docs:*` + Git diff checks; не ослаблять coverage или CI при fail.
- [ ] `ebb-finish-branch`: интеграция только после approved task SHA, независимого final review и разрешения Git mutation в текущем pre/post-first-release режиме. Отличать task SHA, integrated `develop` SHA, release candidate SHA. After-integrated gates на фактическом SHA.
- [ ] `openspec-sync-specs` выполнять для verified delta с безопасным порядком Git, проверить diff и spec conflicts; `openspec-archive-change` — только после post-integration evidence; archive mutation оформлять в разрешённой lifecycle branch/worktree **того же changeId** и проверять повторно после интеграции; не создавать отдельный OpenSpec change только ради архивирования уже интегрированного change. Не переносить слепо статус checkbox → DONE.
- [ ] `bulk-archive` only explicit request, per-change independent approved evidence. `onboard` не публикует/мерджит без прав. `ebb-release` не вызывается ни автоматически, ни по OpenSpec archive; publication только explicit user release flow.
- [ ] GREEN: PASS only when exact identities and evidence exist; forced archive/skip validate/skip-specs без специального review и case scope запрещены project policy. Проверить negative cases.

**Review Focus:** при split sync/archive нет race или forgotten archive commit; меняющиеся specs не смешаны с release policy. **BLOCKED:** archive/sync conflicts, approved SHA mismatch, missing CI evidence или lack of Git permissions.

### Task 07 — Пересмотреть внешние зависимости и trigger tests всех skills

**Depends on:** 03–06. **Modify:** `ebb-curate-skills`, `ebb-orchestrate-work/references`, `scripts/ebb-skills.test.mjs`, `scripts/ebb-skill-dependencies.test.mjs`; **Create:** `scripts/openspec/pressure.test.mjs`.

- [ ] RED: нынешние `skills:dependencies:test` должны отклонять обязательную внешнюю зависимость — показать failing fixture на разрешённом OpenSpec reference **до** изменения allowlist.
- [ ] Отменить blanket prohibition и реализовать **exact allowlist** `openspec-{12 names}` в dependency validation исключительно для first-party development skills; `superpowers:*`, произвольный MCP/агент, remote external instructions остаются forbidden dependencies; `OpenSpec CLI unavailable` → BLOCKED, не bypass.
- [ ] Тестировать all 23 skills inventory (обновляемый discovered manifest) и all 12 OpenSpec skills: direct/indirect trigger mapping, missing usage, documented `BLOCKED` behavior, no alternative route, no stale PR/master policy.
- [ ] Добавить negative prompts: «это всего одна строчка», «поменяй README», «OpenSpec упал», «выполняй старый plan», «archive вместо merge», «включи 3 subagents», «срочная security fix» — ни один не даёт Ebb-only mutation.
- [ ] GREEN: `pnpm skills:test`, `pnpm skills:dependencies:test`, `pnpm openspec:test`; тесты обязаны падать на удалении любого из 24 generated files и на удалении OpenSpec dependency из entrypoint.

**Review Focus:** слишком широкая allowlist, false positives на quoted/historical text, test disabling. **BLOCKED:** контроль цепочки невозможно доказать статическими тестами — E2E сценарий Task 10 обязателен.

### Task 08 — Миграция незавершённых plans и документации без дублей

**Depends on:** 04–07. **Modify:** roadmap generator (если требуется), related tests, `README.md`, affected reference docs; **Create:** `docs/development/08-openspec-mandatory-workflow.md`, migration mapping evidence.

- [ ] Провести read-only inventory исторических `docs/architecture/plans/`, неполных Plan20/Plan26 и других реально активных планов; для каждого `CONTINUE_WITH_OPENSPEC`, `ALREADY_DONE_ARCHIVE_ONLY`, `BLOCKED_NEEDS_APPROVAL`, без silent auto-import.
- [ ] Преобразовать **только незавершённые** задачи, для которых есть разрешение, в distinct OpenSpec changes с original plan pointers; preserve completed-task evidence; двойное владение файлом/ownership conflict → BLOCKED, manual decision.
- [ ] Записать migrations map `legacy plan → changeId → open tasks → approved artifacts`; новые задачи не начинаются с legacy Ebb-only plan. Для простого исторического документа никаких лишних OpenSpec files не создавать.
- [ ] Обновить docs user guide: как начать change на Windows в Codex/Hermes; как read-only explore без change; как обновлять требования; как перезапускать на новом worktree; версии; как проверить/восстановить generator/CLI; разница `verify`/`validate`; manual `bulk-archive`/`onboard`.
- [ ] Roadmap должен корректно отображать новые active OpenSpec changes как **derived** projection из `status --all --json` и repo evidence; старые plan records не удалять; не писать `docs/roadmap/generated.md` вручную. Если изменение roadmap generator выходит за утверждённый scope, оформить отдельный OpenSpec change до реализации, а не скрытый side effect.
- [ ] GREEN: `pnpm docs:roadmap`, `pnpm docs:check`, `pnpm docs:test`, links valid, sample new task has one canonical ledger. Историческая plan fidelity сохранена.

**Review Focus:** не переписывать историю, не создавать contradictory sources, не терять existing plan status. **BLOCKED:** migration needs new architecture/scope approval.

### Task 09 — CI, Windows/Hermes provisioning, drift и reproducibility

**Depends on:** 01–08. **Modify:** `.github/workflows/production-gates.yml` (или соответствующий текущий mandatory gate), `package.json`, docs; new script tests already named.

- [ ] CI устанавливает lockfile dependency `pnpm install --frozen-lockfile`, проверяет pinned CLI exact version, executes `pnpm openspec:setup:check`, `pnpm openspec:check`, `pnpm exec openspec validate --all --strict`, `pnpm openspec:test`, existing Ebb skill/docs gates. Игнорировать `openspec validate` success для пустой root: отдельно проверить minimum expected manifests/skills.
- [ ] POSIX и Windows локальная проверка Node wrapper; none of checks silently invoke global CLI, chmod/shell assumptions or mutate global profile. Add Windows runner если current CI supports this within approved budget; минимум reproducible local Windows smoke + Linux CI.
- [ ] Hermes guide/diagnostic `~/.hermes/config.yaml`:

  ```yaml
  skills:
    external_dirs:
      - C:/path/to/ebb-orchestrator/.hermes/skills
  ```

  Это иллюстрация с локальным путём пользователя, не hardcode и не коммит в repo. Проверить фактический discovery через Hermes skill listing и invocation; одинаковые навыки из глобального каталога не должны shadow проектные.
- [ ] CI gate compare generated outputs against pinned exact version, missing `ebb-*` refs, stale global-profile assumptions, working tree drift after dry-run setup. `pnpm openspec:setup` разрешается только для явного maintenance change; не делать авто-rewrite generated skills в CI.
- [ ] GREEN: Linux CI + Windows local check (и Windows CI где доступно) PASS, negative test demonstrates missing skill or global profile drift => FAIL; no success despite unknown E2E.

**Review Focus:** CI security contexts and permissions; forbidden global writes; setup non-destructive. **BLOCKED:** platform/tool unavailable — сохранить `NOT_RUN/BLOCKED`, не выдавать green completion.

### Task 10 — Реальный 12/12 acceptance и end-to-end stress matrix

**Depends on:** 01–09. **Deliverable:** evidence `docs/architecture/plans/evidence/28-10-e2e-acceptance.md` и тесты in `scripts/openspec/`.

- [ ] **Discovery 12/12 Codex + Hermes**: показать фактическое skill listing и invocation/skill prompt response для всех 12, не только наличие файлов. Проверять на реальных supported host sessions; при недоступном host записать `NOT_RUN`, нельзя объявлять интеграцию завершённой.
- [ ] **Main E2E** в disposable test repo/worktree: read-only explore → propose (или new/continue) → review → apply scoped tasks → verify → Ebb QA → authorized simulated Git integration → sync/archive. Ветку и remote mutations не выполнять на реальном develop в test fixture.
- [ ] **Alt paths**: `new + continue`, `ff`, `update` вызываются реально и дают валидные artifacts; `onboard` на контролируемом безопасном fixture со всеми confirmations, `bulk-archive` на 2 заведомо готовых независимых fixture changes. Применить только если disposable environment доказан (onboard может писать код).
- [ ] **24+ negative cases**: no CLI, wrong version, core profile only, missing one skill, corrupt config, invalid spec, zero checkbox, unavailable agent, no reviewer, failed tests, overlapping subagent scopes, 3 active agents, stale approve hash, changed design w/o re-review, archived prematurely, missing integrated evidence, wrong `master` target, unauthorized release, CI missing, secret-like tokens, wrong worktree, unapproved migration, manual generated file edit, partial sync conflict, script refusal to use fallback. Каждому дать expected blocker and assertion.
- [ ] **State resumption**: killed implementer and restarted controller recovers `changeId/taskId`, ledger, worktree, reviewed SHA without marking DONE; retry policy follows Ebb. Demo must work in separate fresh agent context.
- [ ] GREEN: evidence includes command, host, version, SHA, artifact links, gate results, reviewer verdict, limitations; 12/12 discovery and 12/12 invocation PASS **на обоих hosts**, at least one realistic full lifecycle PASS. `NOT_RUN` != PASS.

**Review Focus:** test simulation masquerading as real workflow, skip approval, unchecked artifact drift; preservation of unrelated changes.

### Task 11 — Independent final review, zero bypass, handoff and release isolation

**Depends on:** 00–10. **Owners:** fresh `ebb-final-review`, security reviewer where applicable, `ebb-quality-gates`, `ebb-finish-branch`.

- [ ] Сверить spec scenario coverage, scripts/codepaths, 23-skill migration, 12/12 per-host tests, every direct entrypoint, no fallback references, current source/ref/status.
- [ ] Выполнить `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm skills:test`, `pnpm skills:dependencies:test`, `pnpm openspec:setup:check`, `pnpm openspec:check`, `pnpm openspec:test`, `pnpm docs:check`, `pnpm docs:test`, `pnpm exec openspec validate --all --strict`, `git diff --check`, `git status --short` плюс affected E2E/security suites.
- [ ] Independent reviewer verdict `APPROVED` или `CHANGES_REQUIRED` со ссылками на exact artifacts/SHAs. `CHANGES_REQUIRED` → scoped subagent fix, repeat review; не назначать автору свой же независимый review.
- [ ] Только authorized Git integration через актуальную `develop` policy и post-integration verification on integrated source SHA. `master`, publication, tags, GHCR не трогать. OpenSpec specs sync/archive по §3/Task06 с отдельной reviewed lifecycle branch того же changeId, если требуется; никаких новых nested changes только ради archive.
- [ ] Final report: reviewed task SHA, actual integrated SHA (если интегрирован), change ID + archive ID (если реально archived), 12/12×2 host invocations, CI evidence, deviations/limitations, actual branch/worktree state. No misleading `done` from checkbox or doc existence.

**STOP / BLOCKED:** любой mandatory gate красный, отсутствует actual host smoke или нет verified change→task→review→integration→archive evidence. Не заменять OpenSpec собственным Ebb workflow ради «закончить быстрее».

## 9. Target `openspec/config.yaml` (пример — использовать после проверки schema 1.16.0)

```yaml
schema: spec-driven
context: |
  Это репозиторий Ebb Orchestrator. OpenSpec ОБЯЗАТЕЛЕН для изменений самого проекта.
  Процесс разработки запускается из ebb-orchestrate-work и использует все применимые OpenSpec skills.
  Нет Ebb-only fallback; отсутствие OpenSpec/change/artifacts приводит к BLOCKED.
  Архитектура: docs/architecture/specs/01-system-design.md и AGENTS.md.
  Git/release: docs/architecture/policies/branch-and-release-policy.md.
  Integration branch: develop; master только для published release snapshots.
  До первого production release действует approved temporary fast-forward policy; после — reviewed squash PR.
  В Ebb controller только координирует, implementation и review делают независимые task subagents.
  Одновременно максимум два активных субагента любых ролей.
  Русский язык в проектной документации и JSDoc; соблюдай deterministic-first и security boundary.
  Не публиковать секреты, не запускать release без прямого запроса пользователя.
rules:
  proposal:
    - "Опиши WHAT/WHY, scope/non-goals, user-visible behavior и критерии приёмки."
    - "При изменении security/architecture/lifecycle фиксируй approval requirement."
  specs:
    - "Каждое нормативное требование должно иметь однозначные WHEN/THEN scenarios."
    - "Указывай failure/recovery/permissions и отсутствие обхода OpenSpec, если применимо."
  design:
    - "Опиши ownership, interfaces, trust boundaries, Git/worktree, recovery, migration, alternatives."
    - "Не меняй утверждённую архитектуру без отдельного approval."
  tasks:
    - "Используй checkbox задачи с ID, dependencies, exact file paths и owner."
    - "Каждая implementation task содержит RED, GREEN, Run/Expected, Review Focus и evidence."
    - "Никаких самостоятельных дублей tasks.md в docs/architecture/plans/."
operations:
  apply:
    guidance:
      - "Работай только по approved OpenSpec change и выделенному taskId через Ebb subagents."
      - "Соблюдай TDD, отдельный reviewer, не более 2 active subagents суммарно."
      - "Не интегрируй Git и не запускай release автоматически."
  archive:
    guidance:
      - "Не архивируй до validated integrated SHA и post-integration gates."
      - "Сначала проверь spec sync, migration conflicts, security и independent review."
      - "Архивация не является релизом; master/tags/GHCR не трогать."
```

**`operations` — guidance, не техническое enforcement.** Строгие правила обеспечивают Ebb owner skills, reviewed source code, scripts и CI. Проверить inject через `pnpm exec openspec instructions tasks --change mandatory-openspec-development --json` и `pnpm exec openspec instructions apply --change mandatory-openspec-development --json`: ожидаемый контекст должен реально появляться, не считать config достаточным по факту его существования.

## 10. Acceptance matrix и definition of done

| ID | Проверка | Доказательство |
|---|---|---|
| A01 | Нет Ebb-only / fallback / optional bypass | 23-skill audit, route pressure fixtures, negative agent E2E |
| A02 | Exact CLI v1.16.0 and lockfile | `pnpm exec openspec --version`, lockfile, setup check |
| A03 | Все 12 OpenSpec workflows | 12 skills on Codex + 12 on Hermes, correct names/hash |
| A04 | Реальный skill discovery и invocation | 12/12 each host session, not just filesystem |
| A05 | Mandatory change before tracked mutation | preflight negative tests, independent artifact checks |
| A06 | Planning uses OpenSpec only | `proposal/specs/design/tasks` as sole execution plan |
| A07 | `ebb-*` use real OpenSpec workflows | mapping + dynamic invocation/evidence; no dual workflows |
| A08 | Two-subagent ceiling & independent review | contention/retry tests and observed orchestration |
| A09 | Full Ebb security, Git and release invariants | owner reviews, negative protected operations |
| A10 | `validate`, `verify`, full quality gates pass | strict CLI, real tests/evidence, independent final review |
| A11 | Reproducible on Windows and Linux | deterministic generator, hermetic global profile, platform tests |
| A12 | Existing active plans cannot bypass | migration map + blocked old-plan execution |
| A13 | Sync/archive safe and not release | workflow tests with actual integrated SHA |
| A14 | Docs/CI green and not contradictory | docs check/roadmap generator, skills test, CI |
| A15 | Approved task/integrated SHA separated | Git evidence, post-integration gates |

**Definition of done = A01–A15 PASS.** Любой `FAIL`, `NOT_RUN` или критический `BLOCKED` означает, что процесс внедрён не полностью. Документ/тестовая фикстура не является доказательством реального использования skill агентом.

## 11. Основные риски и предупреждения

1. **Generated OpenSpec apply может попытаться выполнить весь change самостоятельно.** Ограничивать Ebb controller task-level briefs и diff ownership; dynamic test обязательно подтверждает исполнение через subagents, не inline controller.
2. **Глобальный профиль OpenSpec в `config.json`.** Не мутировать user config при CI или bootstrap проекта; использовать hermetic profile manifest и compare-generated. `--profile custom` без установленного `workflows` массива не гарантирует 12 навыков.
3. **Hermes discovery.** `.hermes/skills` сами по себе не видны без `skills.external_dirs` в пользовательском конфиге. Тестировать настоящую конфигурацию и при конфликте shadowing сообщать BLOCKED.
4. **Несогласованность Git политики.** Не копировать старые `master` или PR-only инструкции; текущий `AGENTS.md` и branch/release policy выше.
5. **Отмена автономности Ebb — сознательное решение.** Старые guards отвергают external dependencies; обновить их тестируемо, разрешая только OpenSpec.
6. **Self-hosting bootstrap.** Первые setup files нужны, чтобы начать OpenSpec; это одноразовая техническая зависимость для самого Plan 28, не отдельный пользовательский режим работы. Следующие исправления и migrations требуют change.
7. **Исторические планы и schema drift.** Не переименовывать/удалять `docs/architecture/plans` ради нового модного процесса; при продолжении старого плана — обязательный OpenSpec change. Main architecture spec выше частных delta spec.
8. **`sync` и `archive` могут мутировать tracked specs.** Они не допускаются без Git branch/worktree/policy и послефактум gates; Ebb release не вызывается.
9. **Никакой бесшумной «пометки готово».** `tasks.md` checkboxes, `openspec validate --strict` и generated readmes не равны full E2E verification.

## 12. Рабочие примеры после внедрения

**Новая функция:** `ebb-orchestrate-work` → `$openspec-explore` при неясности → `$openspec-propose <change>` → Ebb independent `ebb-review-plan` → `ebb-execute-plan <change>` + `$openspec-apply-change` в scoped subagents → `$openspec-verify-change` + Ebb gates/review → Git integration → `$openspec-sync-specs`/`$openspec-archive-change` по governance.

**Сложная архитектура:** `$openspec-new-change <change>` → `$openspec-continue-change <change>` пошагово → `$openspec-update-change <change>` при правках → approval → apply/verify/review/finish. `$openspec-ff-change` — **альтернативный planning fast-forward**, а не shortcut вокруг approvals.

**Баг:** read-only `ebb-debug-issue` + `$openspec-explore` при необходимости → обязательное OpenSpec change → regression test → scoped apply/review/verify. Нет специального «малого» режима без спецификации; небольшой change может иметь краткий, но полноценный пакет artifacts.

**Массовое завершение:** explicit request → `$openspec-bulk-archive-change` после индивидуальных verified integrations, safety review и conflict checks. Никакого auto-archive или release по факту завершения CI.

**На Hermes:** те же names со slash-формой `/openspec-propose`, `/openspec-apply-change`, etc., после настройки `skills.external_dirs` и реального discovery.

## 13. Источники для реализации (проверены 2026-10-30)

- OpenSpec setup, generated skills: https://openspec.dev/docs/setup
- OpenSpec profiles (all 12): https://openspec.dev/docs/profiles
- CLI, `init --tools`, `status`, `validate`, `instructions`, `update --dry-run`: https://openspec.dev/docs/cli
- Project configuration, valid YAML keys: https://openspec.dev/docs/configuration/config-yaml
- Global config and machine profile: https://openspec.dev/docs/configuration/config-json
- Codex / Hermes paths and invocation: https://openspec.dev/docs/supported-tools
- OpenSpec 1.16.0 release: https://github.com/Fission-AI/OpenSpec/releases/tag/v1.16.0
- Hermes `skills.external_dirs`: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- Superpowers writing-plans methodology: https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md
- Ebb repo: https://github.com/vivernet/ebb-orchestrator (branch `develop`; recheck source SHA during Task00).

## 14. Execution policy / границы текущего задания

Этот файл — **новый проект плана**, не результат выполнения задач. Пользователь сейчас поручил **подготовить план**, поэтому никакие файлы в GitHub, Git branches, global OpenSpec/Hermes config, workflows или releases не изменены. Для старта реализации — fresh `develop` audit, `ebb-review-plan`, явное подтверждение implementation scope; Git/remote mutations только согласно существующей политике.

**Приоритет в случае разногласий:** это новое explicit решение пользователя об обязательном OpenSpec-only development workflow. Оно **заменяет** старую автономность навыков Ebb для development-time OpenSpec, но **не** ослабляет безопасность, independent review, approvals, deterministic-first, two-subagent ceiling или release boundary.
