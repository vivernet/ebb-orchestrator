---
id: ledger-07
kind: ledger
status: current
title: Сверка незавершённых планов и требований
created: 2026-09-28
updated: 2026-09-29
---

# Сверка незавершённых планов и требований

Дата среза: 2026-09-29. Проверены все `kind: plan` в `docs/architecture/plans/`, их открытые обязательства и указанные ими последующие evidence. Статус `superseded` не считается завершением. Кодовое наличие, исторические чекбоксы и старые отчёты сами по себе не подтверждают актуальный запуск или внешнее acceptance.

## Текущее решение по Plan lifecycle

Ни один план не отмечается `completed`, если у него остаётся load-bearing проверка, внешний acceptance или scope decision. По результатам этой сверки и текущей работы точный список Plan, не имеющих статуса `completed`:

| Plan | Статус | Незакрытое обязательство / причина |
|---|---|---|
| `plan-01` | `in_progress` | Большинство persistence компонентов и unit/integration tests есть. Строгий критерий одновременно ожидающих outbox event + retryable job с реальным остановом и повторным startup не подтверждён одним process-level recovery acceptance; текущая synthetic crash matrix не моделирует production queue state. Исторические процедурные checkbox не отмечаются задним числом. |
| `plan-04` | `blocked` | Реализован ограниченный SecretStore bridge для OpenAI-compatible API key, но выбранный default provider `openai-codex` использует OAuth и не поддерживается этим bridge. Разрешённый provider-backed acceptance дошёл до запуска Hermes, но завершился timeout за 180 секунд без подтверждения одной роли; `hermes --version`, `hermes chat --help` и `hermes --help` на установленном локальном бинарнике завершаются кодом 1 без вывода. `pnpm hermes:check` также сообщает FAIL для версии CLI, project trust/discovery, delegation config и provider/model setup. Нужны рабочий поддерживаемый CLI/profile и API-key provider в SecretStore, затем полный Developer → Reviewer → QA → Integration run и review. |
| `plan-05` | `blocked` | Task 8 не доказывает реальный Hermes → Epic и restart/resume: opt-in `v1-epic.test.ts` использует `FakeAgentRuntime`; публичный/application flow не принимает natural-language request и не создаёт Coordinator-reviewed plan, а restart-mid-Epic harness отсутствует. Одного разрешения на provider run недостаточно: требуется решить scope/API/workflow contract или официально заменить acceptance. |
| `plan-06` | `in_progress` | Основные UI/API features реализованы, но Task 8 `GitHubSyncWorker` повторно доставляет feedback без durable cursor/dedup, а default `GitHubSyncService` использует `InMemorySyncState`; Task 9 backup/config migration services не подключены к production startup; Task 10 crash matrix меняет synthetic checkpoint table вместо production recovery paths. Также отсутствуют реальные Windows+Unix keyring acceptance и реальный Hermes Epic run, зависящий от unresolved Plan 05 contract. |
| `plan-07` | `blocked` | Разрешённый Hermes parity runner завершился `HERMES_EXECUTE marker=TIMEOUT exit_code=124`, `cleanup_verified=true`; report parity не создан, успешный run двух read-only subagents не доказан. До этого был HTTP 401. Установленный CLI не проходит даже `hermes --version` (exit 1, пустой вывод); `pnpm hermes:check` сообщает FAIL для CLI, доверия/discovery проекта и delegation config. Нужен работоспособный CLI/profile + настроенный provider либо отдельное решение о замене gate и его доказательстве. |
| `plan-09` | `in_progress` | Route-level 503 regression и local-only production path mapping покрыты; pre-READY signal race исправлен (signal проверяется между startup фазами и при запуске workers, cleanup останавливает workers до DB/lock), focused startup suite 30/30, независимый review этого finding `PASS`. Full gates: Server 872/874 (2 skipped), Web 200/200, contracts 4/4, launcher 19/19; lint/typecheck/build и browser E2E 6/6 прошли. Task 3 всё ещё требует production composition seam для тестирования wiring без listener/spawn; его нет. `pnpm audit --prod` нашёл 0 advisories, но свежего source security scan нет. Предыдущий whole-plan review `CHANGES_REQUESTED`; остаются composition seam, source scan и новый independent review.
| `plan-12` | `in_progress` | Общая startup cancellation race исправлена и покрыта тестами: aborted startup не доходит до READY и останавливает workers. Отдельные migration, policy, run-transition и job tests есть, но runtime DDL всё ещё выполняется в `run-service.ts`, `epic-orchestrator.ts`, `merge-service.ts` и `integration-service.ts`; отсутствуют process-level restart acceptance и полное сравнение policy/worker matrices с задачами плана. Общий suite сам по себе их не закрывает. |
| `plan-14` | `proposed` | Docker runtime — future scope, а не незакрытая v1 реализация. Draft сам фиксирует блокеры для Hermes artifact/version/hash/architectures, provider credential bridge и CI/release scope. Не реализовывать до снятия этих требований и scope approval. |
| `plan-16` | `blocked` | В плане есть явный approval gate до внешнего архивирования и delete/move, включающий точный 97-entry disposition table, archive target и proposed README/`.gitignore`/`AGENTS.md` changes. Текущая общая просьба завершить backlog не одобряет этот конкретный внешний archive/delete пакет; до отдельного письменного одобрения разрушительные шаги запрещены. |

`plan-14` приведён к `proposed`, потому что его собственное lifecycle описание определяет этот статус для draft до approval. Его прежний `planned` расходился с телом документа. `plan-00-02` переведён из `superseded` в `completed`: его review проведён, и его отдельные обязанности не были закрыты `plan-00-05`.

Для точного списка в таблице выше учитываются только планы со статусом, отличным от `completed`; `plan-00-02`, `plan-03` и `plan-08-02` завершены и поэтому в неё не входят.

## Прочие планы и открытые чекбоксы

- `plan-02`, `plan-03`, `plan-08-01` и другие планы со статусом `completed` содержат старые незачёркнутые procedural marks; текущие источники и тесты подтверждают существенные обязанности, но не доказывают задним числом исторические RED/GREEN и commit steps. `plan-01` и `plan-06` остаются `in_progress` из-за открытых acceptance criteria; `plan-16` заблокирован собственным approval gate.
- `plan-03` закрыт после замены сетевого fallback в `RepositoryDiscovery` на local-only lookup, regression, прошедших gates и независимого review `PASS`; review оставил только minor coverage note для detached local refs.
- `plan-13` явно исторический и заменён текущим Plan-only roadmap generator/governance pipeline. Его старые задачи не являются активными; текущий `docs/roadmap/generated.md` должен быть обновлён генератором после этого изменения метаданных.
- `plan-11` заменён Plan 18: старый `tools/hermes` registry/asset-sync workflow выведен из употребления, текущий canonical source — `.agents/skills/`, а setup/check тесты проверяют актуальный контракт. Остаётся одна неоднозначность формулировки Plan 11 Task 2 Step 5: `hermes:execute` проверяет containment и существование файла, но не валидирует Plan frontmatter/lifecycle перед запуском. До уточнения исходного смысла это не считается подтверждённым дефектом и не меняет `completed`.
- `plan-13` намеренно superseded как исторический план; parser/collector/generator/CLI, dry-run/output и проверки зависимостей подтверждены текущими реализациями и тестами, а последующий governance plan закрепляет актуальный контракт. Его старые RED/GREEN/commit marks не являются незавершёнными текущими обязательствами.
- `plan-08-03` имеет completion note и актуальное browser evidence для onboarding/approval/activation; открытых load-bearing обязательств не выявлено. Его overlapping Dashboard/Project tests не заменяют собственный Activity/Events критерий `plan-08-02`.
- Плановые статусы относятся только к документам с `kind: plan`. Статусы `in_progress`, `planned` или `draft` в ledger, guide, snapshot и reference не были автоматически превращены в Plan obligations.

## Сверка `plan-00-02`: AGENTS_POLICY_APPROVED

Проверены `/AGENTS.md`, `apps/server/AGENTS.md`, `apps/web/AGENTS.md`, `packages/contracts/AGENTS.md`, README и текущий generated roadmap.

| Область исходного review | Результат |
|---|---|
| Иерархия и области файлов | Четыре файла существуют; scoped инструкции дополняют root и не меняют его глобальные границы. |
| Имя проекта и legacy identifiers | Текущее имя — Ebb Orchestrator; устаревшие строки встречаются в историческом плане как объекты самого поиска, не как активное имя. |
| Git/worktree и destructive actions | Основная ветка — `master`; правила запрещают несанкционированные push/merge/reset/clean и потерю незакоммиченного worktree. |
| Quality gates | Корневые `lint`, `typecheck`, `test` существуют; server/web имеют собственные package scripts, web build включает TypeScript compilation. |
| Architecture и security | Deterministic-first, modular monolith, trust boundaries, отсутствие OS sandbox в Local Mode и authority Action Gateway согласуются с `01-system-design.md` и кодом. |
| Backend, Web и contracts boundaries | Scoped правила согласуются с фактическими пакетами и не дают contracts зависеть от server implementation. |
| Roadmap link | Исторического `docs/roadmap/post-v1.md` нет; текущий источник — `docs/roadmap/generated.md`. Root AGENTS ссылается на действующий путь. |
| Объём root instructions | Файл подробный, но его конкретные ограничения относятся к общим safety, scope, git и evidence; однозначного безопасного переноса правил в scoped файлы не выявлено. |
| Итог | `AGENTS_POLICY_APPROVED`; правки AGENTS по этому review не требуются. Обязательный `git diff --check` будет зафиксирован в общем closeout, поскольку текущая сверка включает и другие изменения. |

`spec-01`–`spec-03` имеют `status: current`, соответствующий их активному использованию как нормативных design contracts в root AGENTS, docs index и in-progress plans. Исторические implementation sequences остаются историческими; исправление metadata не меняет архитектуру. Датированные audit baselines помечены как snapshots там, где их claims об implementation устарели.

## Статусы документов вне Plan lifecycle

- Спецификации `01-system-design.md`, `02-web-ui-recovery-design.md` и `03-production-readiness-design.md` имеют `status: current` и продолжают служить design contracts; их исторические implementation sequences не являются незавершёнными планами сами по себе.
- `docs/architecture/specs/04-hermes-development-capabilities.md` действительно мигрирована в `.agents/skills/` и `docs/development/05-hermes.md` по Plan 18. Provider-backed Hermes smoke остаётся невыполненным и не эквивалентен inventory проверке.
- `docs/development/02-documentation-governance.md` — действующая политика, а не выполняемая задача. Указанный ею отдельный отсутствующий `01-documentation-governance.md` удалён из формулировки; руководство прямо указывает, что само является canonical source. `docs/development/03-russian-jsdoc-readme.md` — historical duplicate: its JSDoc requirements are replaced by `07-jsdoc-style-guide.md`, while the Russian README requirement is now explicit in guideline-01 and checked against both current README files.
- `docs/development/04-architecture-review.md`, `06-jsdoc-execution-ledger.md`, governance ledgers и старые audit reports — датированные snapshots; их старые состояния не являются текущими задачами.
- `docs/reference/ui/01-03-ui-spec.md`, `02-03-ui-spec.md`, `03-03-ui-spec.md` — пустые placeholder-документы без текущих ссылок/обязательств. Их удаление или заполнение требует отдельного disposition; они не дают основания расширять v1 UI scope.
- `docs/audit/09-web-ui-gap-analysis.md` — исторический snapshot. Его старые claims об onboarding, approvals, run panels, projects, SSE cleanup и query cache опровергаются текущим кодом; подтверждённые остатки (approval evidence/note, live logs, action coverage, settings/budget decisions, responsive evidence) требуют продуктовых контрактов и не реализуются этим audit автоматически.

## Запуски и evidence, полученные во время сверки

- `pnpm --filter @ebb-orchestrator/server exec vitest run test/app/security.test.ts --pool=forks --maxWorkers=1`: PASS, 8/8. Добавлен тест на authenticated route, generic secret-free 503 и отсутствие metadata при недоступном keyring.
- `pnpm --filter @ebb-orchestrator/server exec vitest run test/main.test.ts`: PASS, 1/1. `main.ts` использует чистую `createProductionPaths(home)` для worktree и Hermes путей.
- Разрешённый пользователем `pnpm audit --prod --json`: 164 dependency entries; 0 advisories, 0 vulnerabilities.
- `HermesRuntimeAdapter` теперь разрешает значение только из `SecretStore(service=hermes-provider, name=...)` непосредственно перед subprocess; provider YAML содержит только non-secret endpoint/key environment-variable/model. Отсутствующий ключ прекращает run до process spawn; stdout/stderr очищаются от literal key перед state/artifact сохранением. Focused Hermes bridge/profile/adapter suites: PASS, 53 passed + 1 intentionally skipped.
- `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/security/auth-repository.concurrency.test.ts --pool=forks --maxWorkers=1`: PASS, 5/5 вне sandbox. Это изолированное подтверждение теста и не заменяет полный `pnpm test`.
- `pnpm --filter @ebb-orchestrator/web test:e2e`: PASS, 6/6, teardown clean. UI malformed-response test намеренно возвращает объект вместо списка проектов; ожидаемый error boundary виден, но console error `projects.map is not a function` остаётся шумом в логе.
- Первый sandbox `pnpm test` в этой сверке FAIL на readiness acknowledgement и `uv_os_get_passwd ENOMEM`; повтор вне ограниченного sandbox: PASS; Server 870/872 (2 skipped), Web 199/199, contracts 4/4, Node launcher tests 19/19. Root suite serialized workspace packages, assertions не ослаблены.
- `plan-08-02` закрыт после исправления stale route-ID closure и отображения Activity/Events; review `PASS`, focused suite 58/58, gates прошли: lint, typecheck, test (Server 872/874, 2 skipped; Web 200/200; contracts 4/4; launcher 19/19), build и browser E2E 6/6 с clean teardown.
- `plan-03` закрыт после замены сетевого fallback в `RepositoryDiscovery` на local-only lookup; focused suite 17/17, independent review `PASS`, full gates Server 872/874 (2 skipped), Web 200/200, contracts 4/4, launcher 19/19, lint/typecheck/build, browser E2E 6/6.
- Повторная разрешённая Plan 04 provider-backed acceptance после исправления тестового `InMemorySecretStore` setup достигла Hermes subprocess, но завершилась timeout 180000ms; provider result и acceptance proof отсутствуют. CLI diagnostics: `hermes --version`, `hermes chat --help`, `hermes --help` завершились exit 1 без stdout/stderr; `pnpm hermes:check` вернул `CHECK_FAILED` с FAIL для CLI version, project trust/discovery и delegation configuration. Новые provider-запросы не повторялись.
- Свежий verification текущего дерева: `pnpm lint` и `pnpm typecheck` PASS; `pnpm test` вне sandbox PASS (Server 872/874, 2 skipped; Web 200/200; contracts 4/4; launcher 19/19). Первый sandbox run дал только известный `uv_os_get_passwd ENOMEM` в auth concurrency subprocess; elevated повтор прошёл.
- `pnpm build` PASS. Browser E2E вне sandbox PASS 6/6 и завершил teardown; sandbox run также дал 6/6 assertions, но `taskkill` был запрещён sandbox, поэтому тот запуск не засчитан как teardown PASS. `pnpm docs:roadmap`, `pnpm docs:check`, `pnpm docs:test` PASS (17/17), `git diff --check` PASS.
- `pnpm docs:check` и `pnpm docs:test`: PASS, 17/17 после текущих metadata updates. Roadmap сгенерирован через `pnpm docs:roadmap` (32 Plan); generated register имеет 9 статусов, отличных от `completed`. `pnpm lint`, `pnpm typecheck`, `pnpm build`, full `pnpm test` и browser E2E также прошли на текущем исходном коде.

## Требуемые решения для полного завершения

1. Доступ к реальному Hermes/provider environment для Plan 04/05/07 либо явное изменение их external acceptance; статические и fake-runtime тесты не заменяют эти runs.
2. Подтвердить, допустимо ли закрывать Docker plan 14 после снятия зафиксированных artifact/credentials/CI блокеров; текущий scope v1 не разрешает реализовать его догадкой.
3. Завершить локальные test/evidence gaps `plan-09` и `plan-12`, пройти необходимые gates и свежий independent review.
4. Отдельно решить disposition пустых UI placeholders; их заполнение расширит UI scope. Metadata статусов spec-01–03 согласованы с текущими нормативными ссылками без изменения контрактов.
