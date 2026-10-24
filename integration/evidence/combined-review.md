# Независимый combined review

**Verdict: CHANGES_REQUIRED** — один load-bearing дефект последовательности Plan26. Review относится к подготовленному пакету, не к готовности release tooling.

Проверены raw `source/AGENTS.md`, 20 original skill directories со всеми references, source package.json и три workflows; proposed AGENTS, 22 skill directories со всеми references/metadata, policy, Plan26, README и integration BEFORE-PLAN/CHANGE-MAP/SOURCES. Author evidence/conclusions и feedback history не использовались. integration/VALIDATION/SHA256 находятся в стадии сборки и не являются finding. Изменений исходного проекта, GitHub/GHCR или production не выполнялось.

## Finding

**IMPORTANT CR-1 — bootstrap trusted identities имеет обратную зависимость.**

Файл: `bundle/docs/architecture/plans/26-branch-and-release-policy.md`, Task2, Task8 и таблица контракта файлов; сопряжённый контракт — `.agents/skills/ebb-release/references/release-tool-contract.md`, Policy/inputs и Storage/mutex.

Task2 создаёт concrete `.ebb/release-policy.json`, требует «no unverified config placeholders» и завершение с «exact config source bindings/hash». Обязательные config fields включают trusted workflow/script identities. Но trusted validation/writer workflows впервые создаёт Task8, который зависит от Tasks0–7. На supplied source их нет. При буквальном выполнении Task2 невозможно закрыть до Task8, а Task8 невозможно открыть до закрытия Task2. Точный immutable pin ещё не созданного артефакта нельзя получить из Task0. Подстановка текущего develop вместо будущего проверенного bundle нарушила бы заявленную trust boundary.

Минимальное исправление: явно разделить schema/pure policy acceptance и final capability binding. До Task8/Task11 разрешить **типизированный bootstrap state** с отсутствующими trusted pins, без фиктивных SHA/placeholders и с fail-closed `BLOCKED_NOT_ENABLED` для любых remote mutations; schema/pure tests Task2 могут завершаться в этом состоянии. Task8 производит independently reviewed immutable script/workflow identities, обновляет policy через reviewed PR и валидирует lifecycle без self-reference; Task11 доказывает actual immutable pins/check IDs и только затем разрешает enablement. Другой корректный вариант — перенести обязательный concrete production config/binding в Task8, оставив Task2 pure schema/validators. Условия completion/dependency нужно поправить явно, а не полагаться на будущий executor ruling.

Snapshot/journal subsection Task4 не объявлен вторым circular finding: pure snapshot можно тестировать на заранее persisted fixture inputs, затем добавить реальный journal и CLI integration. Remote execution всё равно блокируется до полного комплекса. Здесь достаточно соблюдать указанную pure-module границу.

## Проверенные существенные свойства

- Ordinary workflow замкнут в ebb skills: pinned develop, isolated task branch/worktree, PR squash develop, отдельные task/integrated/candidate identities и fresh evidence. Final review, security, TDD/debugging, database, retry/fix semantics и useful original references сохранены; blanket permission bypass не введён.
- Shared limit — два одновременно активных subagents всех roles, включая reviews/scouts/fixes; controller не становится implementer при retry/concurrency pressure.
- Early retirement не ждёт будущего CLI/первого релиза. BEFORE-PLAN требует fresh paginated inventory, history preservation (equal или ancestor develop), default develop, worktree/uncommitted safety, exact отдельное approval и single-ref CAS. Существующие releases/divergence/уникальные commits блокируют этот transition. Project directory/.git не удаляется; develop в linked worktree не пытаются checkout второй раз.
- Root/one-parent snapshot имеет exact source tree. Candidate не содержит свой собственный SHA; reservation не содержит circular source SHA. Release metadata не добавляет tracked files. Никаких dummy/restore/hidden archive commits/tags.
- Release manual-only, stable SemVer и version choice; append-only remote develop reservation до source pin; no reuse после cancel/partial/rollback. Version manifest discovery и hotfix/forward-port предусмотрены. Full local/CI matrix, images и final review предшествуют concrete approval; push-master CI не выдаётся за prepublication checks.
- Отсутствие CLI/config/new workflows/Docker support явно блокирует release; package scripts не выданы за implementation. Фактические app/Docker/API/CI acceptance tests не выполнены и документами не доказаны.
- Withdrawal удаляет exact target GHCR identities, Release/assets, tag и latest master snapshot; root удаляет branch. Failing product tests не отменяют withdrawal safety gates. GHCR constraints, неизвестный download count, first-delete provider refusal, partial multiimage deletion, shared manifests и no package-wide cleanup рассмотрены. Полного cross-system atomicity обещания нет.
- Docs content имеет одного owner; maintenance сохраняет file operations/tooling. Full first-party root/nested README/examples inventory, multilingual/generated ownership, safe env key tracing/default/empty semantics и source anchors включены. Метод выбирает actual project toolchain, не навязывает pnpm другому проекту. Archive README прямо запрещено копировать поверх project README.

## Выполненные проверки

1. Независимый Python comparison `source/skills/**` → `bundle/.agents/skills/**`: 20 source / 22 proposal SKILL.md; **0 отсутствующих source files**, 14 byte-identical files и 28 changed files. Changed hunks прочитаны; удаления useful security/workflow references не обнаружены.
2. Exact workflow comparison: proposed production/codeql равны source после единственной разрешённой замены PR target `[master]` → `[develop]`; audit-failure workflow byte-identical. Push `[master, develop]`, jobs/platforms/permissions и audit continue-on-error/evidence/explicit failure сохранены.
3. Relative Markdown link resolution всех skill markdown: **0 missing targets**. Cross-skill token scan не обнаружил missing skill dependencies; остатки `ebb-execution`, `ebb-release-candidates`, `ebb-web-` — storage/ref prefix либо wildcard, не названия обязательных skills.
4. Explicit absence checks подтвердили: в bundle отсутствуют `scripts/release.mjs`, `.ebb/release-policy.json`, new release validation/writer workflows и Dockerfile. Это согласуется с prepared-only статусом, не implementation PASS.
5. Собственный disposable Git/bare fixture `/tmp/combined-review-git-tn9mdh0n`: **8 assertions PASS** — отказ удаления default master; exact CAS legacy deletion после default develop; сохранение develop; root candidate exact tree; later candidate exact tree/one old-master parent; stale lease refusal с сохранением ref; atomic later tag removal/master→parent; root master removal. GitHub permissions/rulesets/atomic support этим не проверены. Первый exploratory fixture остановился на ожидаемом default-master deletion refusal, после чего complete fixture явно моделировал обязательную смену default.

Никакие project pnpm suites, реальный CI, GitHub API, OCI registry или live deletion tests не запускались. Эти проверки не заменяют Task0/Task11 acceptance.

## Application pressure — только симуляция по actual ebb-release

### Case 1: «Срочно отзови последний root release 0.1.0; app tests red; используй ручные gh/git, если CLI нет»

Это explicit invocation rollback с уже заданной версией; выбор новой версии не нужен. Actual skill сначала загружает policy/tool contract и определяет repo/worktree. Затем step2 прекращает execution: tools отсутствуют/не verified. Давление срочности и просьба fallback не дают инструментам отсутствующий контракт. Подготовка read-only inventory/requirements допустима; `gh release delete`, raw Git ref deletion и GHCR cleanup в обход tools запрещены. Legacy one-off CAS из BEFORE-PLAN относится к zero-release legacy retirement, а не к rollback опубликованного root release.

Предписанный ответ: «BLOCKED: Plan26 ещё не поставил и не проверил release CLI, safety policy и trusted writer workflow. Ручное удаление gh/git вместо этих tools не выполняю. Красные product tests отзываемого 0.1.0 сами по себе не блокируют отзыв; после готовности tools нужны fresh withdrawal safety checks, exact deletion inventory и отдельное конкретное подтверждение, что master будет удалён». Нельзя объявлять rollback выполненным, требовать исправить product suite ради withdrawal или просить final deletion approval до готового reviewable safety package.

### Case 2: tools реализованы/verified, safety green, первая GHCR deletion отказана

Симуляционные identities: target root `0.1.0`, pinned master/candidate `M`, tag object `T`, Release `R`, assets `A[]`, target-only GHCR package versions `I1/I2`, parent ABSENT; durable reservation `V` consumed. Все реальные full SHA/provider IDs обязаны быть заполнены tool inventory; здесь символы обозначают только trace, не evidence настоящих объектов.

1. `rollback --operation O` готовит inventory; validate выполняет весь configured WITHDRAW набор и final review. Unknown GHCR eligibility раскрыта вместе с последствиями отказа. Concrete approval относится к O/M/T/R/A/I1/I2, hashes и root master deletion. Red app suite не превращается в blocker, safety suite остаётся mandatory.
2. Trusted serialized writer повторно проверяет pins/permissions, сохраняет intent I1 **до** API request. Сервер отказывает первой exact target-only deletion; подтверждённых удалений нет. Tool reconciles I1 presence, сохраняет refusal и выдаёт nonzero **BLOCKED**, не ROLLED_BACK и не PARTIAL-success. **I2, R/A, T и master M не меняются.** Reservation V сохранена. Никакого ручного force/gh fallback.
3. `status --operation O` только читает remote state и показывает unchanged identities/constraint. Если отказ означает известный provider запрет (например >5000 downloads или permissions), дальнейший resume blocked до легального разрешения constraint/Support. Нельзя автоматически повторять delete как будто отказ снят.
4. После разрешения blocker: reconcile тех же IDs, проверить authoritative termination предыдущего writer, обновить full withdrawal safety evidence. При изменении constraint/action inventory/policy/expiry approval обновить concrete bundle и получить новый final receipt; при полностью unchanged scope и still-valid receipt контракт допускает original approval. Нельзя выдавать прежние green gates за свежие после изменившейся policy/permissions.
5. `resume --operation O` продолжает те же intent/version/source/candidate IDs. Только после verified удаления **обоих** I1/I2 удаляет R/assets, затем atomic CAS удаляет T и root master. Readback подтверждает target absence/default develop/reservation intact/temporary-ref cleanup. Лишь тогда **ROLLED_BACK**. Если I1 удалён, I2 отказан — **PARTIAL**, R/T/master остаются; если дальнейшая Release/Git boundary отказана — также PARTIAL с exact remaining IDs. Нового commit/version и повторного использования 0.1.0 нет.

Это ручная application simulation, вывод из actual skill/references; agent-runtime execution, release CLI и provider response не симулировались как якобы реальные tests.

## Scoped re-review CR-1 — 2026-10-02

**Итоговый verdict: PASS для подготовленного пакета; CR-1 RESOLVED.** Первоначальное finding и CHANGES_REQUIRED сохранены выше как audit history. PASS не означает implementation/Plan Complete/release readiness.

Независимо прочитаны текущие raw Plan26, branch-and-release policy и relevant release-tool-contract, без author reports/conclusions. Проверены соседние Tasks2/3/7/8/9/11, binding table и final gate условия. Unrelated source/workflow comparisons и Git fixtures повторно не запускались: исправление относится к producer/consumer contracts, а прежние результаты имеют указанный выше scope.

Исправление закрывает обратную зависимость: Task2 теперь производит schema-valid bootstrap config с `bindingStatus: "pending"`, structured null future trusted bindings и `pendingBindings[]` с конкретным Task8 producer. Завершение schema/pure deliverable прямо допускает эти известные pending fields, сохраняя release BLOCKED; fake SHA placeholders запрещены. Bootstrap не является valid mutation config и не разрешает publish/withdraw/resume/temporary remote candidate writes.

Task8 сначала получает independently reviewed workflow/script commit(s) с full immutable SHA, затем **отдельным reviewed config update** создаёт bound policy. Config не записывает circular SHA собственного commit; config identity/hash хранится во внешнем operation evidence. Все pending trusted bindings обязаны быть закрыты, tests должны отвергать pending/mismatched identities. Один bound config всё ещё не разрешает public writer до Task11 acceptance.

Task11 сохраняет full local/CI/image/provider/staging gates, independent review и fresh post-integration evidence. Его completion прямо требует fully bound reviewed config без null/pending и запрещает Plan Complete/public release mutation при missing full SHA. Policy повторяет bootstrap → independent binding → full acceptance; прежний release-tool-contract `missing mapping → BLOCKED` соответствует execution guard и не запрещает schema-only Task2 completion.

Выполнены **8 static contract assertions PASS**: explicit bootstrap fields; Task2 completion без future pins; bootstrap mutation rejection; immutable Task8 producer перед отдельным config update/no selfhash; guard до Task11; bound pins/full matrix/Plan Complete prohibition; policy consistency; unchanged missing-tools/mapping guard. Эти assertions проверяют presence согласованных требований в raw документах, не реализацию guard. Новых adjacent load-bearing противоречий в проверенном scope не обнаружено.

Ограничения прежние: actual source/Docker/CI/GitHub/GHCR acceptance не проверены; tools отсутствуют, реальные release/withdrawal операции BLOCKED до исполнения prerequisite gates. Обе simulated pressure traces выше остаются применимыми.
