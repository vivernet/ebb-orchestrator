---
id: roadmap-02
status: current
kind: roadmap
title: Текущая сверка и последовательность закрытия работ
created: 2026-09-28
updated: 2026-10-07
---

# Текущая сверка и последовательность закрытия работ

Этот документ фиксирует фактическую последовательность закрытия уже принятых обязательств и проверки evidence. Он не создаёт продуктовый scope. Идентификаторы, статусы и зависимости планов авторитетно публикуются в [сгенерированном реестре](generated.md); подробная доказательная сверка находится в [ledger-07](../architecture/plans/governance/evidence/07-current-plan-reconciliation.md).

## Текущие статусы, отличные от `completed`

| Plan | Статус | Следующее условие закрытия |
|---|---|---|
| `plan-01` | `in_progress` | Fresh whole-plan review `CHANGES_REQUIRED`: shutdown не останавливает активные Run process scopes до закрытия БД/освобождения lock. Нужны fix, regression acceptance, свежие broad gates, disposition исторических checkboxes и повторный review. |
| `plan-02` | `in_progress` | Пользователь одобрил durable Task-bound `RunRequest` A с сохранением `taskId`/`role`/`model`/idempotency key и ожиданием capacity/restart. Queue policy реализации ещё нет; остаются production failure → Recovery → Scheduler wiring, exact acceptance и ожидаемое cross-lifecycle решение о request для Epic-owned Task; fresh review `CHANGES_REQUIRED`. |
| `plan-04` | `blocked` | Developer readiness подтверждена повторно 2026-10-03: unsandboxed `pnpm hermes:check` прошёл 8/8; provider/auth/network не проверялись. `hermes:check` не снимает runtime gate. После безопасного Hermes-native per-Run профиля/auth path по Plan20 нужны реальный provider-backed Developer → Reviewer → QA → Integration acceptance и whole-plan review. |
| `plan-05` | `blocked` | Request API/UI, durable request/plan linkage, approval gate, startup resume реализованы; `pnpm plan05:epic-restart:acceptance` PASS на production `dist/main.js` recovery: 12 Runs/12 phases preserved, `FINAL_APPROVAL`, control plan `PENDING`, cleanup PASS. Этот seeded-checkpoint harness не заменяет same-request restart и real Hermes request → Epic. Production ContextManifest producer отсутствует; Proposal 08 принят 2026-09-30, implementation plan проходит независимое review. Решение о PM/Architect summary до materialization покрыто принятым Proposal 06 A; остаются real Hermes acceptance и whole-plan review. |
| `plan-06` | `in_progress` | Production GitHub inbox и Project Config services/UI wired. Свежая `pnpm plan06:github-inbox:acceptance` на production server прошла: одна inbox row и `DELIVERED` receipt сохранились после restart, workflow tables unchanged; test-only keyring shim не является OS-keyring evidence. `pnpm plan06:project-config:acceptance` на Windows подтвердила ожидаемый `WAIVED / NOT RUN`: HTTP `PROJECT_CONFIG_UNSUPPORTED_PLATFORM`, candidate не persisted. Остаются supported POSIX lifecycle acceptance, hosted Ubuntu keyring result, persisted task-bound ContextManifest/Proposal 08 acceptance и whole-plan review. |
| `plan-07` | `blocked` | Актуальный parity fixture подготовлен; developer readiness и repository gates прошли. Реальный Hermes parity run, два параллельных read-only subagents, provider-backed evidence и teardown report не подтверждены. Попытка через `pnpm hermes:execute` отклонена auto-review, потому что она может передать parity-plan и прочитанные worktree-файлы во внешний OpenAI provider; точное разрешение пользователя на эту передачу ожидается. |
| `plan-09` | `in_progress` | Для текущего локального `develop` source tree CodeQL evidence отсутствует. Успешный hosted CodeQL run `37288692311` анализировал `b6a55f10` (`origin/master`), загрузил SARIF и сообщил 403 TypeScript, 56 JavaScript, 11 HTML, 3 Actions-файла; этот SHA/tree не совпадают с локальным source. Локальных CodeQL/Semgrep нет, workflow не поддерживает `workflow_dispatch`, а `pnpm audit` не заменяет source scan. Нужен успешный scan и findings disposition на финальном source SHA после source freeze; push не выполнялся. |
| `plan-14` | `proposed` | Оставить вне v1 закрытия до подтверждения Docker artifacts/version/hash/architectures, credential bridge и CI/release scope. |
| `plan-16` | `blocked` | Восемь точных tracked delete targets удалены после 97-path rebaseline в commit `966f1ec`; ещё 75 путей отсутствовали, 14 preservation paths сохранены. Дополнительных file-operation targets нет. На `8e6092b` Plan16 Task1 date snippet прошёл, `docs:inventory` показал 76 files, roadmap dry-run — 34 Plans, артефактов не появилось; evidence portion criterion 407 есть, но checklist/status не менялись. Criteria 404–408 и final whole-plan review остаются открытыми, включая README/command-matrix consistency после Plan20 Task7. |
| `plan-19` | `in_progress` | На одном source tree, записанном в `510881e`/`1d8004e`, `pnpm lint`, `pnpm typecheck`, полный `pnpm test` (151 passed files, 3 skipped; 1,445 passed tests, 29 skipped), `pnpm build`, `pnpm server:build`, `pnpm web:build`, Web E2E 6/6, `docs:check`, `docs:test` 20/20, `docs:rename:check`, roadmap generation и `git diff --check` прошли. Свежие Plan06 inbox acceptance PASS; Project Config Windows gate корректно `WAIVED / NOT RUN`. Остаются Plan04/05/07 provider-backed acceptances, Plan06 supported POSIX/keyring/ContextManifest gates, Plan09 exact-final-SHA CodeQL, Plan20 5B/5C and whole-plan review, затем final Plan19/all-plan audit и lifecycle reconciliation. |
| `plan-20` | `in_progress` | Task5A baseline acceptance остаётся принятой только для своего checkpoint; Task5B/5C всё ещё не приняты. Полный `pnpm test` вне sandbox прошёл, а четыре `native-helper-integrity` теста тоже прошли 4/4 вне sandbox; restricted executor не мог открыть ancestor helper path (`parent-directory-open-index-1-win32-5`). Однако присланная пользователем обычная PowerShell path-chain acceptance отказала на ACL stage 5: effective foreign FullControl (`0x001F01FF`) на `%USERPROFILE%`, `AppData`, `Local`; production supervisor/provider не запускались. Пользователь одобрил только bounded read-only права `FILE_LIST_DIRECTORY` и `FILE_READ_EA` для предков выше Hermes auth-root; наблюдавшийся FullControl включает запись/удаление/изменение ACL и этим разрешением не покрывается. ACL и Hermes profile не менялись. Независимый security review не нашёл безопасного code-only обхода, сохраняющего утверждённый fail-closed контракт и существующий auth root. Нужна уже доступная безопасная Hermes auth-root ancestry либо отдельное конкретное решение об изменении trust boundary; менять ACL или допускать mutation rights из общего разрешения «всё необходимое» нельзя выводить. WSL/Linux выполнение остановлено по указанию пользователя; live provider capture, Task5C recovery и whole-plan review остаются открытыми. |

## Очерёдность

1. Сохранить принятую Task5A baseline acceptance (`b6a55f10`, hosted run `37162376745`) как завершённое историческое evidence. Отдельно получить current-tree source-snapshot/native integration evidence на поддерживаемых hosted runners; локальную Linux/WSL установку пользователь остановил. Не считать Task5B fixtures/частичную реализацию заменой этого revalidation или provider-backed acceptance.
2. Продолжить независимые от Linux обязательства Plan16: evidence-bound command matrix, README/docs проверка и финальные documentation/governance gates; не выполнять новые удаления/перемещения/архивирование.
3. После разрешения Plan20 platform gate завершить Task5B/5C, real provider acceptance и independent recovery/architecture review. Только затем обновлять связанные обязательства Plan05/06/19 по их собственным gates.
4. После готовности безопасного Hermes-native profile/auth path выполнить реальный Plan04 acceptance и Plan07 parity; developer `hermes:check` сам по себе эти gates не закрывает.
5. После завершения source changes подготовить свежий Plan09 source security scan на том же revision, который прошёл финальные gates; сохранить фактический hosted/local evidence и findings disposition, не подменять их dependency audit.
6. Провести closure audit всех планов, кроме Plan14, затем общие quality/build/browser gates, independent whole-plan reviews, reconciliation и lifecycle updates по evidence.
7. Перегенерировать [Plan Register](generated.md) после подтверждённых lifecycle изменений; не проставлять статусы или чекбоксы без evidence.

## Открытые evidence-reconciliation записи

Планы `11` и `13` содержат незакрытые исторические execution marks при metadata `completed`; это не само по себе свидетельство отсутствующего runtime behavior. Plan02 повторно открыт как `in_progress` после независимого review `CHANGES_REQUIRED` от 2026-10-03; его конкретные gaps и следующий шаг приведены в таблице выше и в самом плане. Предварительная whole-plan сверка также обнаружила отдельные незакрытые evidence gaps для `00-01`, `08-01`, `08-03` и `10` — они перечислены в ledger-07 как пробелы подтверждения, а не runtime defects. Глобальную сверку нельзя считать завершённой до закрытия Plan20/Plan19 gates и повторного аудита. `plan-01` и `plan-12` имеют предыдущие closeout evidence в register/ledger, но это не закрывает текущую повторную reconciliation. Plan16 остаётся blocked по оставшимся README, command-matrix и governance obligations.

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

На момент этой dated записи независимый read-only review Plan20 завершился `APPROVED` после закрытия тех reviewer findings. Это было утверждение готовности той версии плана к реализации, не финальный review реализованного изменения; более поздний re-review amended plan и оставшийся finding приведены в текущем checkpoint ниже. Тогдашние проверки: `pnpm docs:check` PASS, `pnpm docs:test` 20/20, `git diff --check` PASS, `run-process-owner.test.ts` 9/9. WSL сведения в этой dated записи отражают прежнее состояние и не являются текущим разрешением продолжать WSL работу.

## Дополнение от 2026-10-03 — исторический checkpoint HEAD 5423594

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
- На момент этого checkpoint пользователь разрешил продолжить диагностику и установку WSL при условии не менять другую пользовательскую конфигурацию; более позднее прямое указание пользователя остановить всю работу по Linux/WSL supersedes это разрешение. WSL/OldNewExplorer больше не трогать. Task5A Linux acceptance остаётся `NOT RUN`; lifecycle status и checklist Plan20 не менялись.

## Дополнение от 2026-10-03 — свежая сверка scout evidence

- Вне sandbox `pnpm hermes:check` завершился exit 0, 8/8 checks PASS. Это не запуск provider/API и не закрывает Plan04/05/07 runtime acceptance.
- Исторический CodeQL run `36944963382` охватывает только SHA `6eb51ae1ee11c37b851cf2fc492f49d8ad738844`. Для HEAD `48936eec0c6d5ee8b8c1c7693bb7778d01c4698c` и последующих source edits scan/SARIF не подтверждены; локальные CodeQL/Semgrep отсутствуют. Поддерживаемый путь — обычный push финального SHA на `master`; ручного workflow dispatch нет. Plan09 security gate остаётся открытым.
- Plan16 точное разрешённое удаление выполнено в `966f1ec`; inventory не содержит иных целей. Оставшиеся Plan16 README, command-matrix и governance acceptance открыты, дальнейшие удаления/перемещения/архивирование не выполняются.
- Полный all-plan audit, исключая Plan14, ещё не завершён: для каждого плана нужна проверяемая сверка requirements, implementation, tests, acceptance, evidence и open checklist. `completed` metadata не считается доказательством. Lifecycle metadata/checklists Plan05/06/19 не менялись.

- `docs/roadmap/generated.md` содержит `plan-19=in_progress` и `plan-20=in_progress`; metadata статусов совпадает, поэтому реестр оставлен без регенерации.

## Дополнение от 2026-10-03 — актуальный checkpoint на HEAD `9a9a8b08d6d5f252bb75d1fb1f65a522143763e0`

- Plan20 остаётся `in_progress` по metadata, но последнее независимое review amended plan — `CHANGES_REQUIRED` только по stable identity custom/private provider endpoint. Четыре исходных blockers Plan20 исправлены в плане; trusted context limit A внесён; новая реализация amended contract не начата. Linux Task5A acceptance — `NOT RUN`; позднее распоряжение пользователя остановить WSL работу сохраняется.
- Hermes developer readiness проверена вне sandbox: `hermes --version` exit 0 (`v0.21.5+5778.g0a374d1`), `pnpm hermes:check` 8/8 PASS. Ни provider/API, ни пользовательские auth credentials/profile этим не проверялись или изменялись; isolated managed `pnpm hermes:setup` ранее остановился до dispatch из-за отсутствующей `ruamel` dependency.
- Plan02: пользователь одобрил durable `RunRequest` для Task dispatch (Task/role/model/idempotency key сохраняются и ожидают capacity/restart). Отдельный выбор поведения Epic-owned Task request ещё ожидается; Task6 остаётся без реализации и independent review всё ещё `CHANGES_REQUIRED`.
- Plan01 status metadata reconciled from `completed` to `in_progress` after the fresh independent whole-plan review `CHANGES_REQUIRED`: shutdown не останавливает активные Run process scopes до закрытия БД/освобождения lock. Hash-mismatch regression test добавлен; broad gates, shutdown fix/recovery acceptance, disposition исторических checkboxes и повторный review остаются открытыми. Ни один procedural checkbox не менялся.
- Plan09: CodeQL run `36944963382` успешно просканировал и загрузил analysis для remote `master` SHA `6eb51ae1ee11c37b851cf2fc492f49d8ad738844` (403 TypeScript, 54 JavaScript, 11 HTML, 3 workflow files), но это не текущий local SHA; current-SHA findings/read-back отсутствует. Plan09 security gate остаётся `NOT VERIFIED`.
- Plan16 bounded README/command-matrix amendment получил scoped `APPROVED`, но весь Plan16 остаётся `blocked`: не reconciled точные README commands, `pnpm docs:link:sync` unsupported, нужен side-effect warning для `pnpm hermes:setup`, открыты остальные docs gates и whole-plan review. Server package suite прошёл после `pnpm server:build`; generated build/test directories удалены.
- Root quality gates and browser E2E ранее прошли на HEAD `5423594`, а не на этом HEAD. На текущем checkout после ledger edits заново прошли только `pnpm docs:check`, `pnpm docs:test` (20/20), dry-run roadmap (34 Plans) и `git diff --check`; это не закрывает Plan19 Task9. Полная all-plan requirement/code/test/acceptance/evidence/checklist matrix, исключая Plan14, остаётся незавершённой. После сверки Plan01 metadata была исправлена `completed` → `in_progress`; `pnpm docs:roadmap` успешно сгенерировал 34 Plans, и read-back подтверждает Plan01, Plan16, Plan19 и Plan20 statuses.

## Дополнение от 2026-10-06 — Hermes source pin

- После предоставленного пользователем вывода завершённого Hermes update source pin в Ebb синхронизирован на `v0.21.5+7357.g9244275` / `9244275491ee0d5bc3481590b041114c4e1d399a`.
- Сравнение старого и нового исходного кода подтвердило прежний `hermes chat --format stream-json`, ранний `system/init.session_id`, Hermes-native root auth fallback и неизменность source provider endpoint/env-name maps. Новая source revision становится endpoint revision; неизвестные custom/private overrides сохраняют fail-closed.
- Это не provider-backed acceptance. Plan20 остаётся `in_progress`; Task5B live auth/session capture и Task5C durable recovery остаются открытыми. Полная матрица всех планов кроме Plan14 и точный current-SHA security scan остаются в ранее указанном порядке.
