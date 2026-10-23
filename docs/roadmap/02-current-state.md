---
id: roadmap-02
status: current
kind: roadmap
title: Текущая сверка и последовательность закрытия работ
created: 2026-09-28
updated: 2026-10-14
---

# Текущая сверка и последовательность закрытия работ

Этот документ фиксирует фактическую последовательность закрытия уже принятых обязательств и проверки evidence. Он не создаёт продуктовый scope. Идентификаторы, статусы и зависимости планов авторитетно публикуются в [сгенерированном реестре](generated.md); подробная доказательная сверка находится в [ledger-07](../architecture/plans/governance/evidence/07-current-plan-reconciliation.md).

Сверка на `83bb8926be7841fb365332650340d326d7c0175e` и последующие hosted checkpoints ниже сохранены как исторические snapshots. Самые поздние записи по текущим обязательствам находятся в append-only [ledger-07](../architecture/plans/governance/evidence/07-current-plan-reconciliation.md); более ранние dated notes не считать актуальным read-back, если их явно не подтверждает поздняя запись.

## Текущие статусы планов в аудите (включая закрытые по whole-plan review)

| Plan | Статус | Следующее условие закрытия |
|---|---|---|
| `plan-01` | `completed` | Whole-plan re-review APPROVED (2026-10-16): shutdown fix + graceful-run-shutdown acceptance PASS, plan01:acceptance PASS, полные gates зелёные (полный pnpm test exit 0). План закрыт 2026-10-23. |
| `plan-02` | `completed` | Task5 (aging/critical-path, migration 043), Task6 (durable RunRequest, migration 044–046, READY-gated worker), Task7 (recovery policy integration, эскалация в senior_dev), Task8 (epic fake-runtime) реализованы; независимый whole-plan review APPROVED 2026-10-23; focused 197/197, полный pnpm test exit 0. План закрыт. |
| `plan-04` | `completed` | Live acceptance Plan04 (реальный Hermes Developer → Reviewer → QA → Integration) пройдена 2026-10-14 на HEAD 089def63 с exit 0; свежий независимый whole-plan review 2026-10-21 — verdict PASS. План закрыт; production Hermes path остаётся предметом Plan20 acceptance (не является gate Plan04). |
| `plan-05` | `completed` | Whole-plan review PASS 2026-10-21 (критерии 403-405/407-409 выполнены; 406 деферрален на Plan20 с зафиксированным решением пользователя; producer/acceptance 8/8/API/UI реализованы в Plan20). План закрыт. |
| `plan-06` | `completed` | Repeated whole-plan review PASS 2026-10-22 (HEAD 89daeb6): quality-security ubuntu SUCCESS, keyring ubuntu SUCCESS (real OS keyring + POSIX Project Config), keyring windows/macOS SUCCESS, process-scope linux/hermes SUCCESS; красный только quality-security macos (открытый gate Plan20). План закрыт. |
| `plan-07` | `completed` | Whole-plan review PASS 2026-10-21: wrapper `pnpm hermes:execute` COMPLETED exit 0 (HEAD 977dfd5), пара schema-valid read-only детей выполнена, parity Task7 PASS, gates зелёные, 16 критериев закрыты (superseded-оговорки задокументированы); detached OS descendants остаются `NOT VERIFIED` по принятой v1 политике. План закрыт. |
| `plan-09` | `completed` | CodeQL source scan закрыт на финальном develop HEAD `32285e4255d348d0f1a848cc5771d5aa994652eb` (run `39648628981` success, analysis присутствует, `open=[]`, 12 alerts dismissed). Полный `pnpm test` на HEAD `bf0d465` — exit 0. Независимый whole-plan review 2026-10-21 — verdict PASS. План закрыт. |
| `plan-14` | `proposed` | Исключён из closure scope Plan19; Docker artifacts/version/hash/architectures, credential bridge и CI/release scope остаются будущим направлением без разрешения на реализацию. |
| `plan-16` | `completed` | Независимый whole-plan review APPROVED 2026-10-23; удаления восьми целей подтверждены, 14 preservation paths сохранены, README/docs обновлены, матрица покрывает все манифесты; deferral на Plan20 Task7 (provider/auth/Run consistency + финальная сверка матрицы) зафиксирован по образцу Plan05 criterion 406. План закрыт. |
| `plan-19` | `completed` | Независимый whole-plan review PASS 2026-10-22: планы 04/05/06/07/09 completed, Task8 CodeQL evidence получен (39648628981 @ 32285e4), сверка с generated.md согласована, полный pnpm test exit 0. План закрыт; Plan20 остаётся in_progress. |
| `plan-20` | `in_progress` | Windows Task5B real-provider acceptance 3/3 (один provider request) и Windows Task5C same-Run/session restart 9/9 (один real provider request, 2026-10-14) подтверждают только Windows slices. Свежие Task5C recovery/migration/Scheduler focused groups прошли; Task7 UI/full-plan evidence и Linux/macOS gates остаются открытыми. Linux hosted provider-free Task5A можно запустить только через push-triggered `process-scope-linux-acceptance`; это не Task5B/5C. Пользователь выбрал macOS v1: обычные Runs на Apple Silicon 13.5+, без automatic same-Run resume после сбоя; восстановление Hermes вручную вне Ebb не заменяет authoritative STOPPED proof. При отсутствии proof старый Run остаётся UNKNOWN, а конфликтующий запуск/cleanup fail-closed. Per-Run VM/manager не входит в v1. macOS Darwin implementation и 13.5+ native/provider acceptance остаются открыты. Остались platform-specific Task5A/B/C acceptance, Task7 complete acceptance и fresh whole-change/whole-plan review. |
| `plan-21` | `completed` | Историческая запись; заменён Proposal16 (Option C); v1 AppArmor-парсинг не использует; реализация и acceptance не требуются. План закрыт 2026-10-23. |

## Очерёдность

1. Закрыть оставшиеся Plan20 platform/native-auth/session/recovery acceptance и whole-plan review по их отдельным gates; старые hosted results и Plan19 Task5 PASS не заменяют Plan20 Task5B/Task5C.
2. Завершить поддерживаемую POSIX Project Config lifecycle acceptance Plan06 и hosted Ubuntu keyring gate при обычном authorized CI event. Реализовать принятый Proposal 08 ContextManifest producer/runtime acceptance для Plans05/06 после выполнения его Plan20 dependencies; не создавать placeholder provenance.
3. Устранить и независимо проверить Plan07 parity runner timeout/termination gap, затем получить provider-backed report, ровно два read-only child результата и доказанный teardown. Плановая Task5 Request→Epic acceptance уже PASS, но whole-plan Plan05 review и ContextManifest gate остаются.
4. После готовности безопасного Hermes-native production path выполнить отдельную полную Plan04 acceptance и whole-plan review; `hermes:check` и Plan19 Task5 не заменяют этот gate.
5. После завершения Tasks4–7 получить CodeQL analysis на точном финальном source SHA, прочитать findings и disposition/fix/re-scan их до закрытия Plan09.
6. Провести all-plan closure audit, исключая только Plan14 и включая Plan16 и `superseded` plans с отдельной disposition-проверкой; завершить whole-plan reviews Plans04/05/06/07/09 и выполнить их required final gates.
7. После evidence обновить только подтверждённые lifecycle/checklist данные, синхронизировать current-state и ledger, затем штатно перегенерировать [Plan Register](generated.md). Не менять статусы без PASS evidence.

## Исторический hosted checkpoint от 2026-10-09 (`83bb892`)

Production run `37862703264` завершился `FAILURE`, несмотря на PASS отдельных quality-security, audit, browser и Windows/Ubuntu keyring steps. Windows native process-scope/frame-ACK/profile-target прошли, но profile path-chain упал на external setup-python tool-cache ACL marker `INDEX0`/stage 5; fixture-only recovery в работе. Linux namespace acceptance остановилась на `unshare` до child marker, errno неизвестен; ограниченный prerequisite patch ожидает independent review и hosted PASS. Эти platform gates нельзя подменять друг другом. CodeQL run `37862703303` успешно просканировал/загрузил analysis на точный SHA `83bb8926be7841fb365332650340d326d7c0175e`; finding read-back/disposition остаётся обязательным. Hermes production resolver пока fail-closed `HERMES_PATH_UNSAFE`, несмотря на прошедшую native Windows PowerShell acceptance; provider не запускался, host ACL не менялся. Решением пользователя от 2026-10-09 удаление ACL ACE и снятие доступа запрещены; ACL требуется сохранять. Предыдущая Proposal12 operator remediation отозвана/`superseded`; read-only architecture investigation рассматривает gate как несовместимость текущего Ebb contract с host path, а revised contract требует independent design review до кода. Эти данные и границы записаны также в [Plan19](../architecture/plans/19-unfinished-plan-closure.md) и [ledger-07](../architecture/plans/governance/evidence/07-current-plan-reconciliation.md). Изменения после `83bb892` принадлежат активным owners и не входят в перечисленные результаты.

## Текущий hosted checkpoint от 2026-10-09 (`4e87d26`)

Этот checkpoint обновляет hosted evidence после `83bb892`; прежняя запись остаётся исторической. Lifecycle статусы и plan checklists не меняются.

- Linux source acceptance run `37864962696` на `8c44de6` остановился до child marker: `unshare` вернул `ERRNO 1` до и после применения AppArmor profile. Source acceptance — `NOT RUN`.
- Production gates run `37880160803` на `b2fbb25` завершился `FAIL`: Node 24/26 quality-security показал по одному source-contract failure (1,749 passed, 41 skipped в каждой матрице); web — 219/219 и keyring gates прошли. Windows fixture — 32 passed, 2 failed на private `FILE_DACL` и cleanup `STOP_UNPROVEN`.
- Diagnostics и source-contract assertion fix прошли independent review и вошли в `4e87d261d48552aefbf30886cf5ab8ee3dd13e7a`. Fresh Production gates run `37880854058` и CodeQL `37880854063` на этом SHA ещё `in_progress`; их результат ожидается.
- Reviewed Proposal13/Plan20 amendment разрешает только bounded Task5B-H Windows/Linux implementation, которую начали соответствующие native и TypeScript owners. Это не acceptance PASS. Это исторический checkpoint до решения пользователя от 2026-10-14: macOS v1 теперь ограничен обычными Runs и ручным восстановлением Hermes вне Ebb; автоматическое same-Run resume исключено, а STOPPED proof остаётся обязательным для нового конфликтующего Run/cleanup. Darwin implementation и native/provider acceptance остаются открытыми. Proposal15/coalition feasibility не является production readiness или VM implementation approval.
- Host ACL inventory, mutation и remediation запрещены; текущие ACL сохраняются. Proposal12 остаётся `superseded`. Требования private Run/source state, no-follow, identity/source integrity и STOPPED-gated cleanup сохраняются. Hermes/provider capture и provider-backed acceptance — `NOT RUN`.

## Открытые evidence-reconciliation записи

Планы `11` и `13` содержат незакрытые исторические execution marks при metadata `completed`; это не само по себе свидетельство отсутствующего runtime behavior. Plan02 повторно открыт как `in_progress` после независимого review `CHANGES_REQUIRED` от 2026-10-03; его конкретные gaps и следующий шаг приведены в таблице выше и в самом плане. Предварительная whole-plan сверка также обнаружила отдельные незакрытые evidence gaps для `00-01`, `08-01`, `08-03` и `10` — они перечислены в ledger-07 как пробелы подтверждения, а не runtime defects. Глобальную сверку нельзя считать завершённой до закрытия Plan20/Plan19 gates и повторного аудита. `plan-01` и `plan-12` имеют предыдущие closeout evidence в register/ledger, но это не закрывает текущую повторную reconciliation. Plan16 остаётся blocked по оставшимся README, command-matrix и governance obligations.

План `00-02` закрыт по отдельному AGENTS review; его closeout `AGENTS_POLICY_APPROVED`, перечень проверенных инструкций, результат `git diff --check` и факт отсутствия отдельного коммита записаны в самом плане (2026-09-28). Устаревшее утверждение о предстоящем closeout снято.

## Вопросы, требующие scope/governance решения

- Спецификации `spec-01`–`spec-03` теперь имеют metadata `current`, согласованную с их активным использованием как design contracts; исторические implementation sequence не тождественны статусу самих contracts.
- `docs/reference/ui/01-03-ui-spec.md`, `02-03-ui-spec.md` и `03-03-ui-spec.md` — пустые placeholders со статусом `planned`. Их заполнение создаст/уточнит UI scope и требует отдельного решения; до него они остаются явно неразрешённым disposition, а не завершёнными задачами.
- Docker runtime в `plan-14` — будущий scope. Наличие draft не является разрешением на реализацию.
- Proposals `05` и `06` приняты пользователем 2026-09-29: Project-scoped inbox с retention до явного удаления и обязательным UI; project-scoped request API, обязательный minimal UI и resume одобренных Epic до `READY`. Основная implementation и production acceptance для inbox завершены; остаются исходные UI-обязательства Plan 06 и process/provider acceptance Plan 05.
- Project Config path `.ebb-orchestrator/`, запрет автоматического применения repo-authored config и полный lifecycle Proposal 07 приняты после независимого design review PASS. Production store/routes/UI и restart/rollback acceptance реализованы. По решению пользователя Windows capture теперь fail closed до safe-handle verification; schema v1 является первой поддерживаемой версией без predecessor migration. Supported-platform acceptance остаётся открытым. PM/Architect approval summary timing уже определён принятым Proposal 06 вариантом A.
- CodeQL имеет успешный scan/read-back на SHA `0ec807b678a25ad38d110ee0e670fabd94aab345`, но он не покрывает текущий source HEAD; точный статус и поддерживаемый запуск после source freeze записаны в Plan09 row выше. Dependency audit — отдельный контроль.
- Реальные Hermes acceptance `plan-04/05/07` используют уже настроенные Hermes installation/profile/provider/auth; Ebb не создаёт per-Run profile и не копирует credentials. `pnpm hermes:check` подтверждает developer prerequisites, но не заменяет live provider acceptance; точные оставшиеся gates записаны в ledger.

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

## Дополнение от 2026-10-08 — актуальный Hermes source pin

- Read-only source audit подтверждает установленный Hermes checkout `v0.21.5+9117.g08165d5`, commit `08165d58931841cee713468ae89032af7c57060a`; active Plan20/source-dependent contracts обновляются на этот pin.
- Исторические записи о версиях, фактически установленных ранее, остаются неизменными. Эта сверка не запускала provider и не подтверждает live provider acceptance.

## Дополнение от 2026-10-07 — Plan16 documentation scout

- Read-only review на `a9148f6` проверил `README.md`, `docs/README.md` и `docs/development/05-hermes.md`: документы на русском, без metadata в README, canonical Hermes guide сохраняет guideline metadata; 25 относительных Markdown-ссылок не имеют сломанных целей. Указанные `pnpm` scripts сопоставляются с package manifests; `pnpm docs:link:sync` отдельно обозначена как неподдерживаемая команда, не являющаяся проверкой.
- Review подтверждает, что provider credentials принадлежат Hermes-native auth, запрещены в root `.env` и Ebb SecretStore, а `pnpm hermes:check` не заявлена как provider probe. Критерий 405 не закрыт: `README.md:254–257` и `:322–324` требуют отдельный Hermes home/копию для `pnpm hermes:setup`, что конфликтует с требованием использовать уже настроенный Hermes auth. Plan20 Task7 владеет финальной инструкцией per-Run; до его завершения эти предупреждения требуют согласованного исправления, без копирования credentials или повторной настройки provider.
- Неблокирующее замечание: `docs/development/05-hermes.md` содержит `updated: 2026-09-23`, хотя guide менялся 2026-10-03; проверить/обновить при следующей редакции. Review был read-only: чекбоксы, файлы и lifecycle status Plan16 не менялись.
- После этого review дата Plan16 синхронизирована с последним изменением `2026-10-07`; точный PowerShell snippet, `pnpm docs:check`, `pnpm docs:test` (20/20), `pnpm docs:inventory` (76 файлов), roadmap dry-run (34 Plan), проверки `.gitignore`/source tests и `git diff --check` прошли. По этому evidence отмечены только acceptance criteria 404, 406 и 407; 405 и 408 остаются открытыми, статус `blocked` сохранён.
