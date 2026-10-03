---
id: roadmap-02
status: current
kind: roadmap
title: Текущая сверка и последовательность закрытия работ
created: 2026-09-28
updated: 2026-10-03
---

# Текущая сверка и последовательность закрытия работ

Этот документ фиксирует фактическую последовательность закрытия уже принятых обязательств и проверки evidence. Он не создаёт продуктовый scope. Идентификаторы, статусы и зависимости планов авторитетно публикуются в [сгенерированном реестре](generated.md); подробная доказательная сверка находится в [ledger-07](../architecture/plans/governance/evidence/07-current-plan-reconciliation.md).

## Текущие статусы, отличные от `completed`

| Plan | Статус | Следующее условие закрытия |
|---|---|---|
| `plan-04` | `blocked` | Developer readiness подтверждена повторно 2026-10-03: unsandboxed `pnpm hermes:check` прошёл 8/8; provider/auth/network не проверялись. `hermes:check` не снимает runtime gate. После безопасного Hermes-native per-Run профиля/auth path по Plan20 нужны реальный provider-backed Developer → Reviewer → QA → Integration acceptance и whole-plan review. |
| `plan-05` | `blocked` | Request API/UI, durable request/plan linkage, approval gate, startup resume реализованы; `pnpm plan05:epic-restart:acceptance` PASS на production `dist/main.js` recovery: 12 Runs/12 phases preserved, `FINAL_APPROVAL`, control plan `PENDING`, cleanup PASS. Этот seeded-checkpoint harness не заменяет same-request restart и real Hermes request → Epic. Production ContextManifest producer отсутствует; Proposal 08 принят 2026-09-30, implementation plan проходит независимое review. Решение о PM/Architect summary до materialization покрыто принятым Proposal 06 A; остаются real Hermes acceptance и whole-plan review. |
| `plan-06` | `in_progress` | Production GitHub inbox и Project Config services/UI wired. По решению пользователя capture на Windows fail closed с HTTP 503 до safe-handle verification; Windows happy-path недоступен. Ранее пройденные rollback/restart acceptances предшествуют этому fail-closed revision. Run artifacts показывают только metadata, Settings/Usage read-only projections добавлены; persisted task-bound ContextManifest acceptance остаётся открытым до реализации и acceptance по принятому Proposal 08. Schema v1 — первая поддерживаемая версия без predecessor migration. Остаются supported-platform acceptance, hosted Ubuntu keyring result и whole-plan review. |
| `plan-07` | `blocked` | Актуальный `tools/hermes/fixtures/parity-plan.md` подготовлен. Developer readiness подтверждена 2026-10-03, но это не provider acceptance. Реальный parity run, два параллельных read-only subagents, provider-backed evidence и teardown report не подтверждены; запуск ждёт безопасный native provider/profile path и отдельный parity acceptance. |
| `plan-09` | `in_progress` | После окончательных code/UI правок нужен свежий independent source security scan, disposition findings и whole-plan review. Успешный hosted CodeQL run `36944963382` относится только к `master` SHA `6eb51ae1ee11c37b851cf2fc492f49d8ad738844`, а не к текущему HEAD `48936ee` или последующим source edits. Локальных CodeQL/Semgrep нет; поддерживаемый путь — обычный push финального SHA на `master` (`workflow_dispatch` отсутствует). Current-revision scan/SARIF не подтверждён; dependency audit отдельно не заменяет source scan. |
| `plan-14` | `proposed` | Оставить вне v1 закрытия до подтверждения Docker artifacts/version/hash/architectures, credential bridge и CI/release scope. |
| `plan-16` | `blocked` | Восемь точных tracked delete targets удалены после 97-path rebaseline в commit `966f1ec`; ещё 75 путей уже отсутствовали, 14 preservation paths сохранены. Дополнительных delete targets в inventory нет. Остальные README, command-matrix и governance acceptance criteria открыты; статус плана не менялся. |
| `plan-19` | `in_progress` | Plan review `APPROVED`; Tasks 0/1/2 закрыты. Unsandboxed `pnpm hermes:check` прошёл 8/8 2026-10-03, без provider/API вызова; provider acceptance остаётся отдельным gate. Tasks 4/7 ждут безопасный Hermes-native profile/auth path и runtime acceptance; Task 5 recovery harness подтверждает только ограниченный seeded-checkpoint scope, остаются same-request restart, real Hermes и whole-plan review. Task 6 включает fail-closed Windows capture; остаются supported-platform acceptance, реализация/acceptance Proposal 08 и Ubuntu keyring evidence. Полные quality gates последовательно прошли на HEAD `5423594`; после последующих source edits их нужно повторить. Current-SHA CodeQL, whole-plan reviews и полная all-plan reconciliation ещё впереди; статус и checklist не менялись. |
| `plan-20` | `in_progress` | Readiness review плана `APPROVED`, но Task5A current-runtime acceptance остаётся открытым до свежего Linux systemd/cgroup acceptance наряду с уже полученным Windows evidence. Последняя elevated-проверка `wsl --list --verbose` подтвердила ровно один `Ubuntu-26.04 / Installing / WSL2`; обычная проверка ранее вернула `Wsl/EnumerateDistros/Service/E_ACCESSDENIED`. WSL updater/MSI и OldNewExplorer Config/consent процессы живы, но цель consent не установлена; конфигурация OldNewExplorer и Windows не менялись. Пользователь разрешил установку Linux в WSL. Task5B/5C и implementation whole-plan review открыты; lifecycle status не менялся. |

## Очерёдность

1. Plan20 readiness review и baseline Tasks 0–4/6 подтверждены; повторно проверить текущее состояние WSL после последней установки/обновления и выполнить открытое Task5A Linux acceptance на текущем runtime source.
2. После Task5A acceptance завершить требуемые Plan20 Task5B/5C, provider acceptance и independent recovery/architecture review. Только затем обновлять связанные обязательства Plan05/06/19, и только после их собственных gates.
3. После готовности Hermes-native profile/auth path выполнить реальный Plan04 acceptance и Plan07 parity; developer `hermes:check` сам по себе эти gates не закрывает.
4. Для Plan16 использовать выполненный rebaseline и удаление восьми точных исторических файлов без архива; завершить оставшиеся README, command-matrix и governance obligations. Не расширять удаление за пределы зафиксированного inventory без отдельного точного disposition.
5. После завершения source changes подготовить свежий Plan09 source security scan на том же revision, который прошёл финальные gates; для hosted CI нужен разрешённый publication path.
6. Провести closure audit всех планов, кроме Plan14, затем общие quality/build/browser gates, independent whole-plan reviews, reconciliation и lifecycle updates по evidence.
7. Перегенерировать [Plan Register](generated.md) после подтверждённых lifecycle изменений; не проставлять статусы или чекбоксы без evidence.

## Открытые evidence-reconciliation записи

Планы `02`, `11` и `13` содержат незакрытые исторические execution marks при metadata `completed`; это не само по себе свидетельство отсутствующего runtime behavior. Предварительная whole-plan сверка обнаружила отдельные незакрытые evidence gaps для `00-01`, `02`, `08-01`, `08-03` и `10` — они перечислены в ledger-07 как пробелы подтверждения, а не runtime defects. Глобальную сверку нельзя считать завершённой до закрытия Plan20/Plan19 gates и повторного аудита. `plan-01` и `plan-12` имеют предыдущие closeout evidence в register/ledger, но это не закрывает текущую повторную reconciliation. Plan16 остаётся blocked по оставшимся README, command-matrix и governance obligations.

План `00-02` закрыт по отдельному AGENTS review; его closeout `AGENTS_POLICY_APPROVED`, перечень проверенных инструкций, результат `git diff --check` и факт отсутствия отдельного коммита записаны в самом плане (2026-09-28). Устаревшее утверждение о предстоящем closeout снято.

## Вопросы, требующие scope/governance решения

- Спецификации `spec-01`–`spec-03` теперь имеют metadata `current`, согласованную с их активным использованием как design contracts; исторические implementation sequence не тождественны статусу самих contracts.
- `docs/reference/ui/01-03-ui-spec.md`, `02-03-ui-spec.md` и `03-03-ui-spec.md` — пустые placeholders со статусом `planned`. Их заполнение создаст/уточнит UI scope и требует отдельного решения; до него они остаются явно неразрешённым disposition, а не завершёнными задачами.
- Docker runtime в `plan-14` — будущий scope. Наличие draft не является разрешением на реализацию.
- Proposals `05` и `06` приняты пользователем 2026-09-29: Project-scoped inbox с retention до явного удаления и обязательным UI; project-scoped request API, обязательный minimal UI и resume одобренных Epic до `READY`. Основная implementation и production acceptance для inbox завершены; остаются исходные UI-обязательства Plan 06 и process/provider acceptance Plan 05.
- Project Config path `.ebb-orchestrator/`, запрет автоматического применения repo-authored config и полный lifecycle Proposal 07 приняты после независимого design review PASS. Production store/routes/UI и restart/rollback acceptance реализованы. По решению пользователя Windows capture теперь fail closed до safe-handle verification; schema v1 является первой поддерживаемой версией без predecessor migration. Supported-platform acceptance остаётся открытым. PM/Architect approval summary timing уже определён принятым Proposal 06 вариантом A.
- Свежий source security scan для `plan-09` отсутствует. CodeQL route требует подтвердить доступность Code Scanning для repository; dependency audit остаётся отдельным контролем.
- Реальные Hermes acceptance `plan-04/05/07` требуют безопасного Hermes-native per-Run profile/auth path и provider. `pnpm hermes:check` прошёл 8/8 2026-10-03, но не проверяет credentials/auth/network/model и не запускает provider; поэтому эти runtime gates остаются открытыми.

## Завершённые проверки этой сверки

- Свежий `pnpm docs:roadmap` сформировал 34 записи; [generated register](generated.md) содержит `plan-16=blocked`, `plan-19=in_progress`, `plan-20=in_progress`. `docs:check` и `git diff --check` прошли; повторная генерация не изменила `generated.md`.
- Полный локальный suite и documentation gates записаны в `ledger-07`; они не заменяют provider acceptance, fresh security scan или оставшиеся independent reviews.
- Никакие внешние изменения, commit, push или merge этим roadmap не разрешаются.

## Дополнение по evidence от 2026-10-02

Таблица и dated notes выше сохранены как снимок предыдущей сверки. Следующие факты относятся к текущему checkout и уточняют более ранние environment-dependent наблюдения, не удаляя их исторический контекст.

- Refs сейчас: `develop=4336b95`, `master=d74a784`, `origin/master=6eb51ae`; более ранняя запись, что обе локальные ветки указывали на `6eb51ae`, отражает промежуточный post-merge checkpoint.
- Вне sandbox `hermes --version` и `pnpm hermes:check` прошли для Hermes `v0.21.5+4831.g02e4118`; sandbox-side failure был связан с denied access к bundled Python в ограниченной среде. Wrapper tests прошли 28/28, scoped ESLint и независимый scoped review PASS. Это не provider-backed acceptance: его не запускали, поэтому runtime/provider acceptance остаётся открытым. Пользовательский профиль и credentials не читались и не менялись.
- Для Plan09 настроен hosted CodeQL workflow на push `master`/`develop`, PR в `master` и weekly schedule. CodeQL run/result или SARIF для текущей revision `4336b95` отсутствует. `pnpm audit` dependency artifacts не являются source scan evidence.
- Plan16 остаётся `blocked`; на момент этой сверки не было одобренного rebaseline, точного external destination и письменного approval полного disposition package. Архивирование, удаление и перемещение файлов были запрещены до получения этих решений.
- All-plan audit ещё не является полной матрицей проверки требований и checklist items. Ранее зафиксированные 525 исторических unchecked procedural marks требуют индивидуального evidence disposition; они не равны 525 доказанным дефектам.
- `docs/roadmap/generated.md` сейчас содержит 34 Plan и совпадает с Plan frontmatter по ID/title/status. Указание выше о 33 записях относится к предыдущему snapshot. Статусы не менялись и реестр не перегенерировался.

## Дополнение от 2026-10-03 — решение по старым материалам Plan16

- Пользователь подтвердил, что старые материалы являются мусором и должны удаляться, а не архивироваться. В рамках точного Plan16 rebaseline восемь tracked historical targets уже удалены по одному после проверки path, Git tracking и SHA-256; коммит `966f1ec` содержит эти удаления.
- Остальные 75/97 inventory entries уже отсутствовали; 14 существующих путей — актуальные README, инструкции и активные Plan15 документы — сохранены. В этом inventory новых исторических delete targets нет, и broader filesystem cleanup не выполнялся.
- Старые формулировки о необходимости внешнего archive target и approval rebaseline больше не являются текущими prerequisites. Plan16 остаётся `blocked` по независимым незавершённым README, command-matrix и governance acceptance criteria; статус не менялся.

## Дополнение от 2026-10-03 — повторный Plan20 readiness review

Новый независимый read-only review Plan20 завершился `APPROVED` после закрытия reviewer findings. Это утверждение готовности плана к реализации, не финальный review реализованного изменения. Свежие проверки: `pnpm docs:check` PASS, `pnpm docs:test` 20/20, `git diff --check` PASS, `run-process-owner.test.ts` 9/9. Статус Plan20 остаётся `in_progress`; сгенерированный реестр уже содержит эту запись. WSL сведения в этой dated записи отражают прежнее состояние до разрешённого unregister; последующее состояние приведено в более свежем дополнении ниже.

## Дополнение от 2026-10-03 — сверка HEAD 5423594 и текущее состояние evidence

- Plan20 baseline Tasks 0–4/6 и независимый review подтверждены на `e12038c`. Task5A Linux acceptance остаётся `NOT RUN`. По прямому разрешению пользователя Ubuntu-24.04 была штатно unregistered (exit 0). Две попытки установить Ubuntu-26.04 вернули `RPC_S_CALL_FAILED`; текущая регистрация — `Ubuntu-26.04 Installing`, first launch — `WSL_E_DISTRO_NOT_FOUND`.
- С 07:41 живы `wsl.exe --update` PID 24408/20668 и `msiexec` PID 26768; для MSI нет completion/failure event, `wslservice.exe` остаётся версии 2.6.3.0. WER указывает `OldNewExplorer64.dll` v1.1.8.1 и `0xc0000005`; точный loader mechanism не доказан. На момент этого checkpoint пользовательское разрешение ещё ожидалось; позднее пользователь разрешил установку Linux в WSL. Связь процесса consent с конкретной операцией не подтверждена последними read-only проверками.
- Plan19 Task9 local gates на HEAD `542359462c7eb87191c258a7ea06efe5709fe9d2`: `pnpm lint`, `pnpm typecheck`, `pnpm test` PASS (1,143 passed/21 skipped; root scripts 22/22); `pnpm build` exit 0 через установленный VS2019 `VsDevCmd` (contracts/web/server, только bundle-size warning); `pnpm docs:check` PASS; `pnpm docs:test` 20/20; `pnpm docs:rename:check` 43 entries. Повторный Chromium E2E завершился exit 0, 6/6, с подтверждённой остановкой процессов и очисткой temp. Предыдущий обычный E2E exit 1 не считается успешным запуском. Current-SHA CodeQL, independent whole-plan reviews и финальная reconciliation остаются впереди; `plan-19` остаётся `in_progress`.
- Commit `5423594` исправил Plan16 Hermes documentation targets. Свежие docs checks PASS, но `plan-16` остаётся `blocked` из-за оставшихся README/guide, command-matrix и governance criteria.
- Свежий `pnpm docs:roadmap` сформировал 34 записи: `plan-16=blocked`, `plan-19=in_progress`, `plan-20=in_progress`. `docs:check` и `git diff --check` PASS; `docs/roadmap/generated.md` не изменён.
- Предварительная whole-plan audit выявила evidence gaps для Plan00-01, Plan02, Plan08-01, Plan08-03 и Plan10; gaps не утверждают наличие runtime defects. Подробности и следующие evidence steps указаны в ledger-07. Финальный повторный audit остаётся после Plan20/Plan19 gates; lifecycle statuses и plan checkboxes не обновлялись.

## Дополнение от 2026-10-03 — повторная проверка WSL и пределы evidence

- Прямое разрешение пользователя относится к установке последней доступной версии Linux в WSL. Оно не включает изменение конфигурации OldNewExplorer или перезапуск Windows.
- Последняя elevated-проверка `wsl --list --verbose` подтвердила ровно один `Ubuntu-26.04 / Installing / WSL2`; обычная проверка ранее завершилась `Wsl/EnumerateDistros/Service/E_ACCESSDENIED`. `wsl.exe` PID 20668/24408 (`--update`, с 07:41) и `msiexec.exe` PID 26768 были обнаружены живыми.
- `OldNewExplorerCfg_RUS.exe` PID 3160 и `consent.exe` PID 24792 были обнаружены живыми. Эта проверка не устанавливает, к какому действию относится consent, и не подтверждает, что он всё ещё ожидает ввода. Изменение конфигурации OldNewExplorer и перезапуск Windows не выполнялись.
- Продолжать разрешённую диагностику и установку WSL без изменения другой пользовательской конфигурации. Если исправление потребует изменения OldNewExplorer или перезагрузки Windows, сначала получить отдельное прямое разрешение. Task5A Linux acceptance остаётся `NOT RUN`; lifecycle status и checklist Plan20 не менялись.

## Дополнение от 2026-10-03 — свежая сверка scout evidence

- Вне sandbox `pnpm hermes:check` завершился exit 0, 8/8 checks PASS. Это не запуск provider/API и не закрывает Plan04/05/07 runtime acceptance.
- Исторический CodeQL run `36944963382` охватывает только SHA `6eb51ae1ee11c37b851cf2fc492f49d8ad738844`. Для HEAD `48936eec0c6d5ee8b8c1c7693bb7778d01c4698c` и последующих source edits scan/SARIF не подтверждены; локальные CodeQL/Semgrep отсутствуют. Поддерживаемый путь — обычный push финального SHA на `master`; ручного workflow dispatch нет. Plan09 security gate остаётся открытым.
- Plan16 точное разрешённое удаление выполнено в `966f1ec`; inventory не содержит иных целей. Оставшиеся Plan16 README, command-matrix и governance acceptance открыты, дальнейшие удаления/перемещения/архивирование не выполняются.
- Полный all-plan audit, исключая Plan14, ещё не завершён: для каждого плана нужна проверяемая сверка requirements, implementation, tests, acceptance, evidence и open checklist. `completed` metadata не считается доказательством. Lifecycle metadata/checklists Plan05/06/19 не менялись.
- `docs/roadmap/generated.md` содержит `plan-19=in_progress` и `plan-20=in_progress`; metadata статусов совпадает, поэтому реестр оставлен без регенерации.
