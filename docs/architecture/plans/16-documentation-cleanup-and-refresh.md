---
id: plan-16
kind: plan
status: blocked
created: 2026-09-25
updated: 2026-10-03
title: Очистка и актуализация документации Ebb Orchestrator
depends_on:
  - plan-15-07
  - plan-15-08
specs:
  - ../specs/01-system-design.md
  - ../../development/02-documentation-governance.md
evidence:
  - README.md
  - docs/README.md
  - docs/development/05-hermes.md
  - package.json
  - apps/server/package.json
  - apps/web/package.json
  - packages/contracts/package.json
  - packages/testing/package.json
  - apps/server/test/e2e/fixtures/health-service/package.json
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - scripts/docs-governance.mjs
  - scripts/roadmap-generator-cli.mjs
  - .gitignore
  - AGENTS.md
  - .hermes.md
  - apps/server/AGENTS.md
  - apps/web/AGENTS.md
  - packages/contracts/AGENTS.md
  - .cuperpowers/sdd/12-401-web-completion/task-5-report.json
  - .superpowers/sdd/2026-09-16-orchestrator-final-v1-audit-hardening/mcp-validation-report.md
  - .superpowers/sdd/2026-09-16-orchestrator-final-v1-audit-hardening/security-remediation-report.md
  - .superpowers/sdd/2026-09-16-orchestrator-final-v1-audit-hardening/ui-api-remediation-report.md
---

# 16. Очистка и актуализация документации Ebb Orchestrator

## Context Brief

Rebaseline выполнен на develop, HEAD 7d2e8a3, 2026-10-02. Повторная проверка 97 ранее перечисленных candidate paths показала: 75 отсутствуют, 14 существующих путей сохраняются, 8 существующих tracked-файлов являются точными целями удаления. Десять tracked-планов 15-* относятся к 14 preservation paths и остаются неизменными.

Цель следующей implementation-фазы — привести documentation surface и временные артефакты репозитория к фактическому состоянию проекта, не меняя runtime-код и сохраняя актуальные исходники, инструкции и активные планы. Проектные README должны быть на русском языке и не содержать YAML/frontmatter-подобных метатегов. Это правило относится к README; настоящий plan обязан сохранить YAML frontmatter, потому что он является частью канонической схемы планов.

Большинство ранее перечисленных исторических путей, включая .cuperpowers/, .superpowers/ и workspace/, уже отсутствуют; повторно их не создавать, не искать для удаления и не архивировать. Пользователь прямо распорядился удалить оставшиеся исторические материалы. Для этой ограниченной очистки архив не создаётся. scan-manifest.json, workflows, scripts, tests, актуальные README и планы не входят в цели удаления и сохраняются.

**Deferred evidence inconsistency:** the previously expected `docs/development/jsdoc-style-guide.md` is absent from the repository; the existing `docs/development/07-jsdoc-style-guide.md` is not substituted as an authoritative spec in this plan. Restoring or renaming a JSDoc guide is out of scope and deferred pending a separate repository-backed requirement; no task may depend on that missing path.

**Hermes documentation path correction (2026-10-03):** `tools/hermes/README.md` was intentionally deleted in commit `1b2155e` on 2026-09-28. Its user-facing Hermes setup and skills guidance was migrated to the existing canonical `docs/development/05-hermes.md`, which is linked from the root README. Do not recreate the absent tooling README; the current README targets are `README.md` and `docs/README.md`, with `docs/development/05-hermes.md` audited as a separate canonical guide.

## Scope

1. Провести read-only inventory всех кандидатов и расслоить их на tracked/untracked/ignored, active/unrelated, reproducible/non-reproducible и содержащие/не содержащие секреты.
2. Проверить целостность кандидатов: SHA-256 manifest, валидность JSON/UTF-8, diff/path checks, ссылки, tracked-vs-untracked comparison и secret/path scan.
3. Сверить существование, tracked-состояние и SHA-256 каждого из восьми точных targets с rebaseline; удалить только их индивидуальными операциями. Archive не создавать.
4. Проверить каждую реально существующую `pnpm`-команду по manifests/workspace/lockfile и обновить `README.md` с фактическими командами, ограничениями и expected outputs.
5. Обновить существующие project README: `README.md` и `docs/README.md`; убрать из них frontmatter-подобные блоки, исправить stale paths, язык и ссылки. Сверить команды и ссылки Hermes в существующем каноническом guide `docs/development/05-hermes.md`; не создавать `tools/hermes/README.md`.
6. Оценить и при необходимости добавить в `.gitignore` правила для `temp/` и `test/` только с явным объяснением scope; не игнорировать source/test directories целиком.
7. Оценить добавление в `AGENTS.md` правила для временных файлов и зафиксировать его только если оно однозначно предотвращает повторное загрязнение репозитория.
8. Выполнить прямо разрешённое пользователем удаление только восьми перечисленных tracked-файлов; дополнительное подтверждение и archive не требуются. Другие Plan16 задачи и изменения README/policy этим разрешением не считаются выполненными.

## Non-scope

- Не изменять production code, package manifests, `pnpm-lock.yaml` или behavior CLI.
- Не изменять и не удалять existing tracked active plans `15-*`.
- .cuperpowers/, .superpowers/ и workspace/ отсутствуют по rebaseline; не создавать для них archive и не выполнять повторных файловых операций.
- Не считать `node_modules/`, `dist/`, `build/`, `coverage/`, `.vite/`, Playwright output и другие regenerable outputs частью Git cleanup.
- Не запускать `git clean`, `reset --hard`, force operations, push или merge.
- Не принимать README, historical audit или report как authority над текущим кодом без проверки evidence.

## File/interface map

| Область | Файлы/интерфейсы | Назначение и проверка |
|---|---|---|
| Project entrypoint | `README.md` | Установка, commands, architecture claims, runtime prerequisites; обновить только после command audit. |
| Documentation index | `docs/README.md` | Навигация и governance; сверить с фактическими `docs/` paths и README policy. |
| Hermes development guide | `docs/development/05-hermes.md` | Каноническое руководство по source/installed skills; сверить с фактическими каталогами и scripts, сохраняя его корректные metadata не-README документа. |
| Command authority | `package.json`, workspace manifests, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | Канонический список `pnpm` scripts, packages, package manager и dependency graph. |
| Documentation validators | `scripts/docs-governance.mjs`, `scripts/roadmap-generator-cli.mjs` | Метаданные, plan parsing, inventory/check/roadmap behavior; команды запускать с dry-run там, где возможно. |
| Repository policy | `.gitignore`, `AGENTS.md`, `.hermes.md`, scoped `AGENTS.md` | Правила временных файлов, language, cleanup, gates и ownership boundaries. |
| Active plans | `docs/architecture/plans/15-01...15-09`, `15-auth-onboarding-ui-hardening` | Preserve unchanged; compare only for duplicate paths/claims. |
| Historical work | `.cuperpowers/**`, `.superpowers/**`, `workspace/**` | These trees are absent in the 2026-10-02 rebaseline; no further file operation is needed. |
| Reports/artifacts | root reports/JSON/TXT/HTML, `workspace/**`, `artifacts/**`, `docs/review/**` | Deduplicate and classify by provenance, references, reproducibility and secret risk. |

### Dependency graph

97-path rebaseline → verify exact target existence + Git tracking + inventory SHA-256 → annotate the two historical evidence references → individually delete only the 8 approved targets (destination: none; no archive) → verify target absence, preservation paths and surviving links → relevant docs checks → final diff/status review.

Пользователь прямо распорядился удалить старые материалы; дополнительное approval и внешний archive не являются prerequisites для перечисленных восьми файлов. Никакая другая deletion/move, README/policy edit или изменение active 15-* plans этим разрешением не охватывается. README editing в остальной части Plan16 по-прежнему зависит от проверенной command matrix.

## Rebaseline and exact cleanup disposition

Rebaseline at develop HEAD 7d2e8a3 on 2026-10-02: 97 listed: 75 missing, 14 existing preservation paths, 8 exact delete targets. This reclassifies the prior inventory; it does not authorize substitute paths or broader cleanup.

The 75 missing paths require no action. Do not recreate, archive, move, or retry deletion for them.

### Existing preservation paths (14)

| Path | Disposition |
|---|---|
| README.md | preserve |
| docs/README.md | preserve |
| .gitignore | preserve |
| AGENTS.md | preserve |
| docs/architecture/plans/15-01-auth-contract-and-crypto.md | preserve unchanged |
| docs/architecture/plans/15-02-auth-persistence-and-repository.md | preserve unchanged |
| docs/architecture/plans/15-03-auth-cli-and-startup.md | preserve unchanged |
| docs/architecture/plans/15-04-server-security-boundary.md | preserve unchanged |
| docs/architecture/plans/15-05-web-auth-and-sse.md | preserve unchanged |
| docs/architecture/plans/15-06-onboarding-draft-and-scheduler-guard.md | preserve unchanged |
| docs/architecture/plans/15-07-russian-ui-and-artifact-cleanup.md | preserve unchanged |
| docs/architecture/plans/15-08-verification-and-review.md | preserve unchanged |
| docs/architecture/plans/15-09-atomic-auth-v2-remediation.md | preserve unchanged |
| docs/architecture/plans/15-auth-onboarding-ui-hardening.md | preserve unchanged |

### Exact delete targets (8)

Пользователь прямо распорядился удалить старые материалы. Archive не создаётся (destination: none); удаление разрешено только при повторном совпадении существования, Git tracking и SHA-256 непосредственно перед каждой операцией. Любое несовпадение останавливает удаление соответствующего файла.

| Path | Expected SHA-256 | Destination | Disposition |
|---|---|---|---|
| artifacts/security/pnpm-audit-prod-2026-09-21.json | 8447f4373d97d220c7a78a148e455aa23b472793403a47dbcf5febceac49c5ef | none | delete exact file |
| artifacts/security/pnpm-audit-prod-a0f18b3cfd8e8b3ae3139c9c9973ae2e2ebd81d8.json | dff8095a1e0e7b08832a7349fe54fa2e151d456949b2269cde70d4046465dbf4 | none | delete exact file |
| artifacts/security/pnpm-audit-prod-b3b66154729ca2b373e0424dbab96b4435ec2c11.json | 298748970c310a84ff5c63082cfa8e2713f38b8fe7e38f01a62bd7c09a62776b | none | delete exact file |
| artifacts/task-10-fix-report.md | f7419f134b18d6bb52acef8ccc60adff4d4e37848a350047e0dccae9110860b9 | none | delete exact file |
| docs/99-plan-analysis-report.md | c2024bddc23bb433d5ce7a4a1b1daf9eece90055fb4c7213d48bca3e057d3b6f | none | delete exact file |
| docs/audit/02-audit-report.md | 331c0c864127170639d3ef6a80fc00dec4c86e0b94c8e2924b148aa5c2acaf54 | none | delete exact file |
| docs/review/final-report.json | 16d4c6f7cc35551a472e0153b1e70b4e05976c83bc4dbc614e48dbc6cb16dfb4 | none | delete exact file |
| docs/review/findings.json | be649c91edbcbfbbeef4e4dd93a5a60795b5a35b420d20824e88d10e6559a4f3 | none | delete exact file |

scan-manifest.json, workflows, scripts, tests, directories/root paths, current README files and active plans are outside this delete table and must remain untouched.

Fail-closed recheck: immediately before removing each row, require Test-Path -LiteralPath, exact git ls-files --error-unmatch -- <path>, and Get-FileHash -Algorithm SHA256 equal to the listed value. Delete that one file using Remove-Item -LiteralPath; never recurse or substitute another path. Afterward confirm the exact path is absent and the other targets still match their manifest until processed.

## Implementation tasks

### Task 1 — Freeze context and record the 2026-10-02 rebaseline

Files: repository root, `docs/architecture/plans/`, candidate paths above. Symbols/interfaces: Git index/worktree state, path classification, plan filenames.

- Run `git branch --show-current`, `git rev-parse HEAD`, `git status --short --untracked-files=all`, `git ls-files`, and path enumeration without `git clean`.
- Confirm `develop` and expected HEAD; record all ten tracked `15-*` plans as preserved unrelated work.
- Rebaseline the existing 97 listed entries against the current filesystem and Git index; record exactly 75 missing, 14 preservation paths and 8 delete targets. Do not discover substitute targets or generate an in-repository inventory artifact.
- Run the governance structure check `pnpm docs:check` from the repository root; record its exit code/output and confirm it does not validate date values.
- Validate the exact Plan16 frontmatter dates with this read-only PowerShell snippet from the repository root:
  ```powershell
  $planPath = 'docs/architecture/plans/16-documentation-cleanup-and-refresh.md'
  $content = Get-Content -LiteralPath $planPath -Raw
  $frontMatterResult = [regex]::Match($content, '(?s)\A---\r?\n(?<yaml>.*?)\r?\n---')
  if (-not $frontMatterResult.Success) { throw 'Plan16 YAML frontmatter is missing.' }
  $yaml = $frontMatterResult.Groups['yaml'].Value
  $expectedDates = [ordered]@{ created = '2026-09-25'; updated = '2026-10-03' }
  foreach ($entry in $expectedDates.GetEnumerator()) {
    if ($yaml -notmatch "(?m)^$($entry.Key):\s+$([regex]::Escape($entry.Value))\s*$") {
      throw "Plan16 $($entry.Key) does not match the expected date."
    }
    $parsedDate = [datetime]::MinValue
    $isValidDate = [datetime]::TryParseExact(
      [string]$entry.Value,
      'yyyy-MM-dd',
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::None,
      [ref]$parsedDate
    )
    if (-not $isValidDate) { throw "Plan16 $($entry.Key) is not a valid ISO calendar date." }
  }
  'Plan16 frontmatter dates passed: created=2026-09-25 updated=2026-10-03'
  ```
- Expected: `pnpm docs:check` exits `0` for frontmatter/id/filename checks and the PowerShell snippet exits `0` with the stated message; neither command changes files. No candidate is silently omitted; any inventory mismatch blocks further work; inventory/validation leaves no `docs/roadmap/generated.md` or other new artifact.

### Task 2 — Establish authority and references

Files: `.hermes.md`, `AGENTS.md`, scoped `AGENTS.md`, canonical specs, all plans, `README.md`, `docs/README.md`, `docs/development/05-hermes.md`, scripts.

- Search references to every candidate path, report filename, plan ID and generated artifact name.
- Treat current user requirements first, then approved specs/instructions, then current code as evidence; treat historical reports as evidence only.
- Build a reference matrix showing source path, referring path, link type, and whether the link is load-bearing.
- Expected: active plans remain untouched and every deletion/move candidate has an explicit reference disposition.

### Task 3 — Verify exact deletion targets immediately before cleanup

Files: the eight exact delete targets in the rebaseline table.

- For each target individually, recheck `Test-Path -LiteralPath`, exact tracked status via `git ls-files --error-unmatch`, and SHA-256 against the table immediately before removal.
- Stop on any missing, untracked or hash-mismatched path; do not substitute or expand the target set.
- Preserve the 14 listed paths and all paths outside the 8-row delete table.
- Expected: all eight targets match their recorded hashes before removal; no archive or secret-bearing report is created.

### Task 4 — Apply the existing user instruction to the exact rebaseline

Files: the eight exact delete targets and the two historical governance evidence files.

- Record the exact eight paths and expected hashes; destination is none because the user directed deletion without an archive.
- Mark only the historical references to `artifacts/task-10-fix-report.md` and `docs/audit/02-audit-report.md` in their governance evidence files; retain all other evidence.
- Do not create an archive or request another approval for these exact removals. This task does not authorize changes to other README, policy, plan or candidate paths.
- Expected: the table and two evidence notes match the rebaseline before the individually verified deletes.

### Task 5 — Audit every pnpm command from real manifests

Files: `package.json`, `apps/server/package.json`, `apps/web/package.json`, `packages/contracts/package.json`, `packages/testing/package.json`, `apps/server/test/e2e/fixtures/health-service/package.json`, `README.md`, `docs/README.md`, canonical Hermes guide `docs/development/05-hermes.md`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, referenced scripts.

Сначала зафиксировать этот deterministic matrix как проверяемый набор строк; после каждого запуска сохранить `cwd`, prerequisites, классификацию `read-only`/`side-effect`, exact invocation, exit code и ожидаемый результат. Значения в `Expected exit/output` — это ожидаемое поведение, а не подтверждение запуска. Если строка не содержит явно помеченного фактического evidence, её статус — `NOT RUN / NOT VERIFIED`. Историческое evidence ниже не считается свежим запуском после оставшихся изменений документации. Для `pnpm docs:inventory` и `pnpm docs:roadmap -- --dry-run` есть один общий post-run status snapshot, не отдельный snapshot для каждой команды: он показал только ожидаемое изменение файла Plan16 и не обнаружил generated или untracked artifacts. `pnpm docs:roadmap` по умолчанию записывает `docs/roadmap/generated.md`, поэтому для audit использовать только isolated copy рабочего дерева либо поддержанный dry-run, а затем проверять, что в исходном и isolated repo не появились неожиданные artifacts.

| Source | cwd | Prerequisites | Class | Exact invocation | Expected exit/output |
|---|---|---|---|---|---|
| root `package.json` | repo root | Node `>=24.15` (README/CI currently cover 24.x and 26.x), pnpm `>=12.0.0` per root `engines`; lockfile importer records pnpm `12.4.2`; root has no `packageManager` pin | read-only | `pnpm typecheck` | Expected `0`; recursive workspace typecheck passes; `NOT RUN / NOT VERIFIED` in this matrix |
| root `package.json` | repo root | dependencies; on a clean checkout run `pnpm server:build` first to produce `apps/server/dist` and contracts `dist` | side-effect (contracts `dist` cleanup/build outputs and test artifacts) | `pnpm test` | Root script itself builds contracts (and its `prebuild` removes `packages/contracts/dist`) before workspace tests, but does not build server; full server tests launch production subprocesses and require `apps/server/dist`. `pnpm test` result remains `NOT RUN / NOT VERIFIED` in this matrix |
| root `package.json` | repo root | dependencies installed | read-only | `pnpm lint` | `0`; ESLint reports no errors |
| root `package.json` | repo root | dependencies installed | side-effect (build outputs) | `pnpm build` | `0`; workspace builds complete; record generated outputs |
| root `package.json` | repo root | contracts workspace; on Windows x64, Visual Studio C++ Build Tools initialized so `cl.exe` is on `PATH` or `VCToolsInstallDir` is set | side-effect (build output) | `pnpm server:build` | Observed 2026-10-03: ordinary PowerShell without MSVC environment failed exit `1` in `14.98s` with `WINDOWS_PROCESS_SCOPE_BUILD_TOOLS_UNAVAILABLE`; after x64 VS 2019 BuildTools `VsDevCmd` initialization, exit `0` in `14.87s`, including `Built provider-free Windows process-scope helper`. Generated outputs were removed after test acceptance. |
| root `package.json` | repo root | dependencies installed | side-effect (build output) | `pnpm web:build` | `0`; Vite build completes |
| root `package.json` | repo root | Node and scripts present; isolated `HERMES_HOME` | side-effect (HERMES_HOME) | `pnpm hermes:setup` | Run only in isolated copy; successful setup emits `HERMES_CONFIG marker=SETUP_CONFIGURED trusted=true redacted=true` and `Setup complete.`; `NOT RUN / NOT VERIFIED` in this matrix |
| root `package.json` | repo root | setup completed | read-only | `pnpm hermes:check` | Expected: exit `0`, all Hermes checks pass. Observed 2026-10-03 in an unsandboxed TTY: exit `0`, all 8 checks `PASS`, `All checks passed.` Read-only scope: CLI version, filesystem/inventory, and configuration checks; no provider/API invocation occurred. In sandboxed PowerShell, both `hermes --version` and `pnpm hermes:check` exited `1` without diagnostics. Unsandboxed direct `hermes --version` resolved `C:\Users\alex1\AppData\Local\hermes\bin\hermes.exe` and reported `Hermes Agent v0.21.5+5778.g0a374d1 (2026.9.24)`, Python `3.14.7`, `Up to date`. This is environment/sandbox-specific evidence, not a repository defect. |
| `README.md`; `docs/development/05-hermes.md` | repo root | Hermes installed and available in `PATH` | read-only | `hermes --version` | Observed 2026-10-03 outside the sandbox: exit `0`, `Hermes Agent v0.21.5+5778.g0a374d1 (2026.9.24)`, up to date. This reports CLI version only; no provider/auth state was read. |
| `README.md`; `docs/development/05-hermes.md` | repo root | Hermes installed and available in `PATH` | read-only | `hermes model --help` | Observed 2026-10-03: exit `0`; help describes an interactive inference-provider/default-model selection and lists supported options. Help only; the wizard was not run and no provider setup was verified. |
| `README.md`; `docs/development/05-hermes.md` | repo root | Hermes installed and available in `PATH` | read-only | `hermes auth --help` | Observed 2026-10-03: exit `0`; help lists `add`, `list`, `remove`, `reset`, `priority`, `refresh`, `status`, `logout`, and `upgrade` subcommands (also `spotify`). Help only; no auth status, profile, or credential data was read. |
| `README.md`; `docs/development/05-hermes.md` | repo root | Hermes installed; user-selected native provider/model/auth flow | side-effect (Hermes provider/model/auth configuration; possible provider interaction) | `hermes model` | Interactive command; do not run during this audit. `NOT RUN / NOT VERIFIED`: wizard and provider authentication were not executed, no provider request was made, and no real provider-backed Run was accepted. |
| root `package.json` | repo root | Node | read-only | `pnpm hermes:test` | Expected: exit `0`, Node test summary passes. Observed 2026-10-03 from repo root: exit `0`, 28/28 tests passed. |
| root `package.json` | repo root | explicit execute fixture/capability approval | side-effect | `pnpm hermes:execute -- <plan>` | do not run during audit; document blocked prerequisite and exact command |
| root `package.json` | repo root | Node | read-only | `pnpm docs:inventory` | Expected: exit `0`, inventory printed. Observed 2026-10-03: exit `0`, output included `Total files: 76`. |
| root `package.json` | repo root | Node | read-only | `pnpm docs:check` | Expected: exit `0`, valid metadata/naming. Observed 2026-10-03 from repo root: exit `0`, `All documentation files pass checks.` |
| root `package.json` | repo root | Node | read-only (supported dry-run) | `pnpm docs:roadmap -- --dry-run` | Expected: exit `0`, preview only, no write to `docs/roadmap/generated.md`. Observed 2026-10-03: exit `0`; output included `DRY RUN MODE` and `Plans collected: 34`; preview only; tracked `generated.md` LastWriteTime `09:16:16` predated these commands. Do not probe unsupported `--help`: the CLI has no help handler and may write the default output file. |
| root `package.json` | repo root | Node | read-only | `pnpm docs:rename:check` | Expected: exit `0`, rename map and links pass. Observed 2026-10-03 from repo root: exit `0`; exact output `Rename check passed: 43 migration entries, no retained legacy sources or broken relative links.` |
| root `package.json` | repo root | Node; command dispatcher has no `link:sync` implementation | unsupported/side-effecting request (not verified read-only) | `pnpm docs:link:sync` | `1`; exact stdout is `Usage: node docs-governance.mjs <command> [options]`, `Commands: inventory, check, roadmap, rename:check`, `Roadmap options: --dry-run, --output=<path>`; pnpm adds `[ELIFECYCLE] Command failed with exit code 1`; no sync is performed |
| root `package.json` | repo root | Node | read-only | `pnpm docs:test` | Expected: exit `0`, governance tests pass. Observed 2026-10-03 from repo root: exit `0`, 20/20 tests passed. |
| root `package.json` | repo root | server build toolchain/dependencies; acceptance starts disposable server processes and uses temporary test state | side-effect (build outputs, processes, temporary state) | `pnpm plan01:acceptance` | Expected `0` after process-recovery acceptance; `NOT RUN / NOT VERIFIED` in this matrix |
| root `package.json` | repo root | server build toolchain/dependencies; acceptance runs isolated production restart test | side-effect (build outputs, processes, temporary state) | `pnpm plan05:epic-restart:acceptance` | Expected `0` after Vitest acceptance; `NOT RUN / NOT VERIFIED` in this matrix |
| root `package.json` | repo root | server build toolchain/dependencies; acceptance uses disposable home/database and starts local processes | side-effect (build outputs, processes, temporary state) | `pnpm plan06:project-config:acceptance` | Expected `0` on supported acceptance platform; Windows intentionally reports `WAIVED / NOT RUN`; `NOT RUN / NOT VERIFIED` in this matrix |
| root `package.json` | repo root | server build toolchain/dependencies; acceptance uses a local GitHub HTTP fixture and disposable state | side-effect (build outputs, processes, temporary state) | `pnpm plan06:github-inbox:acceptance` | Expected `0` after local-fixture/restart acceptance; `NOT RUN / NOT VERIFIED` in this matrix |
| root `package.json` | repo root | Node, configured Hermes provider, and explicit `EBB_RUN_HERMES_SESSION_TAG_ACCEPTANCE=1` authorization | side-effect (provider-backed acceptance) | `pnpm hermes:session-tag:acceptance` | Expected: without authorization the wrapper exits `2` with `HERMES_SESSION_TAG_ACCEPTANCE=NOT RUN`; provider-backed success is not inferred; `NOT RUN / NOT VERIFIED` in this matrix |
| root `package.json` | repo root | built server and writable `EBB_ORCHESTRATOR_HOME` | side-effect (server state) | `pnpm start` | long-running server; audit only via isolated home and health probe |
| root `package.json` | repo root | dependencies installed | side-effect (server process) | `pnpm server:dev` | long-running `tsx watch`; not a read-only audit command |
| root `package.json` | repo root | dependencies installed | side-effect (Vite process) | `pnpm web:dev` | long-running Vite server; not a read-only audit command |
| `apps/server/package.json` | `apps/server` | dependencies, Node | side-effect (server process) | `pnpm dev` | long-running `tsx watch src/main.ts` |
| `apps/server/package.json` | `apps/server` | contracts, TypeScript | side-effect (dist cleanup/build) | `pnpm build` | `0`; server dist generated |
| `apps/server/package.json` | `apps/server` | built dist, writable home | side-effect (server state) | `pnpm start` | long-running `node dist/main.js` |
| `apps/server/package.json` | `apps/server` | TypeScript | read-only | `pnpm typecheck` | `0`; no emit |
| `apps/server/package.json` | `apps/server` | dependencies and `pnpm server:build` outputs: `packages/contracts/dist` (runtime package export used by `auth-repository.concurrency.test.ts`) and `apps/server/dist` (production subprocess entrypoint used by `epic-restart-production.acceptance.test.ts` and `v1-crash-matrix.test.ts`) | side-effect (temporary test files/processes) | `pnpm test` | Bare filtered run without build preparation: **FAIL**, observed 2026-10-03, exit `1` after `264.93s` (3 files failed/120 passed/1 skipped; 7 tests failed/1134 passed/21 skipped/10 unhandled; missing generated `contracts/dist/index.js` and `apps/server/dist/main.js`). Run `pnpm server:build` first; post-build full-suite result is `NOT RUN / NOT VERIFIED`. Fixtures cited elsewhere in this row clean up through `finally`/`afterEach`. |
| `apps/server/package.json` | `apps/server` | Windows x64 and MSVC `cl.exe` / Visual Studio C++ build tools; source file exists | side-effect (writes `.obj` and `.exe` under `apps/server/dist/native/windows-run-supervisor`) | `pnpm build:windows-run-supervisor` | Expected successful helper build on supported Windows toolchain; `NOT RUN / NOT VERIFIED` in this matrix |
| `apps/server/package.json` | `apps/server` | installed dependencies; Vitest | read-only | `pnpm test:auth-contract` | Expected `0`; runs the two auth onboarding/password-hash contract suites; `NOT RUN / NOT VERIFIED` in this matrix |
| `apps/web/package.json` | `apps/web` | dependencies, Vite | side-effect (dist) | `pnpm build` | `0`; Vite output recorded |
| `apps/web/package.json` | `apps/web` | Vitest | read-only | `pnpm test` | `0`; Vitest summary |
| `apps/web/package.json` | `apps/web` | Vitest | read-only | `pnpm test:watch` | long-running watch; do not use for audit |
| `apps/web/package.json` | `apps/web` | Node, server fixture as required | side-effect (browser/e2e artifacts) | `pnpm test:e2e` | run only isolated; `0` and no source artifacts |
| `packages/contracts/package.json` | `packages/contracts` | TypeScript | side-effect (dist cleanup/build) | `pnpm build` | `0`; dist generated |
| `packages/contracts/package.json` | `packages/contracts` | TypeScript | read-only | `pnpm typecheck` | `0`; no emit |
| `packages/contracts/package.json` | `packages/contracts` | Vitest | read-only | `pnpm test` | `0`; pass-with-no-tests allowed |
| `apps/server/package.json` (`prebuild`) | repo root | Node; generated `apps/server/dist` may exist | side-effect (recursive generated-dist cleanup) | `pnpm --filter @ebb-orchestrator/server prebuild` | `scripts/clean-dist.mjs` removes `apps/server/dist`; source-derived behavior, `NOT RUN / NOT VERIFIED`; do not invoke as part of documentation audit |
| `packages/contracts/package.json` (`prebuild`) | repo root | Node; generated `packages/contracts/dist` may exist | side-effect (recursive generated-dist cleanup) | `pnpm --filter @ebb-orchestrator/contracts prebuild` | `scripts/clean-dist.mjs` removes `packages/contracts/dist`; source-derived behavior, `NOT RUN / NOT VERIFIED`; do not invoke as part of documentation audit |
| `packages/testing/package.json` | `packages/testing` | TypeScript | read-only | `pnpm typecheck` | `0`; no emit |
| `packages/testing/package.json` | `packages/testing` | Vitest | read-only | `pnpm test` | `0`; pass-with-no-tests allowed |
| fixture `package.json` | `apps/server/test/e2e/fixtures/health-service` | Node | side-effect (server process) | `pnpm start` | long-running fixture server; isolated E2E only |
| fixture `package.json` | `apps/server/test/e2e/fixtures/health-service` | Node | read-only | `pnpm test` | `0`; smoke test output |
| `README.md` | repo root | listed Node/pnpm/Git prerequisites | read-only | `node --version`; `pnpm --version`; `git --version` | `0`; versions satisfy documented constraints |
| `README.md` | repo root | frozen lockfile | side-effect (node_modules) | `pnpm install --frozen-lockfile` | `0`; lockfile unchanged |
| `README.md:595` | repo root | dependencies installed | read-only | `pnpm lint` | Expected `0`; ESLint reports no errors; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:596` | repo root | dependencies installed | read-only | `pnpm typecheck` | Expected `0`; recursive workspace typecheck passes without emit; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:598` | repo root | dependencies; on a clean checkout run `pnpm server:build` first (x64 Developer shell on Windows) | side-effect (contracts `dist` cleanup/build outputs and test artifacts) | `pnpm test` | Root script builds contracts but not server; full root test remains `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:597` | repo root | contracts and server build toolchain/dependencies; on Windows x64, initialized Visual Studio C++ Build Tools | side-effect (dist cleanup/build outputs) | `pnpm server:build` | Same observed build evidence as the root manifest row above: initial ordinary-shell FAIL, then exit `0` in `14.87s` after x64 VS 2019 BuildTools `VsDevCmd` initialization; native helper built |
| `README.md:599` | repo root | dependencies installed | side-effect (dist/build outputs) | `pnpm --filter @ebb-orchestrator/web build` | Expected `0`; Vite build output generated; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:600` | repo root | Git worktree | read-only | `git diff --check` | Expected `0`; no whitespace errors; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md` | repo root | dependencies | side-effect/process | `pnpm --filter @ebb-orchestrator/server dev`; `pnpm --filter @ebb-orchestrator/web dev`; `pnpm server:dev`; `pnpm web:dev`; `pnpm start` | classify as long-running and do not count as read-only validation |
| `README.md:477,506` | repo root | contracts and server build toolchain/dependencies; on Windows x64, initialized Visual Studio C++ Build Tools | side-effect (dist cleanup/build outputs) | `pnpm server:build` | Same observed build evidence as the root manifest row above |
| `README.md:478` | repo root | dependencies installed | side-effect (dist/build outputs) | `pnpm web:build` | Expected `0`; Vite build output generated; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md` | repo root | Node | read-only | `pnpm docs:inventory`; `pnpm docs:check`; `pnpm docs:test`; `pnpm hermes:check` | Expected: each listed read-only command exits `0`; `pnpm hermes:setup` is excluded and is a separate side-effecting isolated-copy check. Observed 2026-10-03 from repo root: `docs:check` exit `0`, `All documentation files pass checks.`; `docs:test` exit `0`, 20/20 passed; `hermes:check` unsandboxed TTY exit `0`, 8 checks `PASS`, `All checks passed.` Hermes check scope was CLI version, filesystem/inventory and configuration checks only, with no provider/API invocation. Sandbox-specific command/version evidence is in the root `pnpm hermes:check` row above. |
| `README.md` | repo root | Node; setup requires isolated `HERMES_HOME` | side-effect (HERMES_HOME/setup state) | `pnpm hermes:setup` | Run only in isolated copy; successful setup emits `HERMES_CONFIG marker=SETUP_CONFIGURED trusted=true redacted=true` and `Setup complete.`; `NOT RUN / NOT VERIFIED` in this matrix |
| `docs/README.md` | repo root | documentation paths | read-only | navigation links and referenced paths | no shell command; validate every listed path exists or is explicitly marked stale |
| `docs/development/05-hermes.md` | repo root | Node; installed Hermes for setup/check/interactive use; explicit execution approval for plan execution | side-effect (Hermes home) | `pnpm hermes:setup` | setup changes selected `HERMES_HOME`; run only in an isolated copy and record its observed output |
| `docs/development/05-hermes.md` | repo root | Node; configured Hermes installation | read-only | `pnpm hermes:check` | Expected: exit `0` when prerequisites and project trust pass. Observed 2026-10-03 in an unsandboxed TTY: exit `0`, 8 checks `PASS`, `All checks passed.` Read-only scope is CLI version, filesystem/inventory and configuration checks; no provider/API invocation occurred. Sandbox-specific failure/version evidence is recorded in the root command row above; it is not a repository defect. |
| `docs/development/05-hermes.md` | repo root | Node | read-only | `pnpm hermes:test` | Expected: exit `0`, Node test summary passes. Observed 2026-10-03 from repo root: exit `0`, 28/28 tests passed. |
| `docs/development/05-hermes.md` | repo root | Node | read-only | `pnpm skills:test` | Expected: exit `0`, canonical skills tests pass. Observed 2026-10-03 from repo root: exit `0`, 30/30 tests passed. |
| `docs/development/05-hermes.md` | repo root | Node | read-only | `pnpm skills:dependencies:test` | Expected: exit `0`, skill dependency tests pass. Observed 2026-10-03 from repo root: exit `0`, 7/7 passed; `Dependency scan: 658 paths, 658 text files, 0 historical exceptions.` |
| `docs/development/05-hermes.md` | repo root | Node; explicit execution approval, approved plan and capabilities | side-effect/process | `pnpm hermes:execute -- docs/architecture/plans/<file>.md` | do not run during audit; record exact blocked prerequisite and command |
| `docs/development/05-hermes.md` | repo root | Hermes installed; selected worktree | side-effect/process | `hermes --in "<worktree>" --tui` | long-running interactive process; classify as runtime launch, not read-only validation |
| `docs/development/05-hermes.md` | repo root | Hermes installed; selected profile/configuration; repository path to trust | side-effect (Hermes trust configuration) | `hermes skills trust <repo-root>` | Expected: command changes Hermes trust configuration; output depends on Hermes version; `NOT RUN / NOT VERIFIED` in this matrix |

Успешный `pnpm hermes:setup` печатает marker `HERMES_CONFIG marker=SETUP_CONFIGURED trusted=true redacted=true` только после успешного project trust и конфигурации. Ветви ошибки из `scripts/hermes-dev.mjs` печатают один из failure markers `FAILED`, `TIMEOUT` или `TERMINATION_FAILED`, а `exit_code` равен `error.exitCode`, если это integer; иначе используется `125` для termination failure, `124` для timeout и `1` для прочих failures. Эти ветви не являются successful output. Только setup marker и эти failure branches остаются `NOT RUN / NOT VERIFIED`; это не отменяет датированное observed evidence в строках выше. Краткие строки `Observed` ссылаются на task-specific evidence, которое controller внёс в Plan16 scratch ledger с cwd, exit code и полным выводом.

Точные package-filter invocations, приведённые в корневом README, учитываются отдельно от вызовов из каталога каждого пакета: наличие manifest script само по себе не подтверждает, что конкретная команда с `--filter` запускалась.

| Source | cwd | Prerequisites | Class | Exact invocation | Expected exit/output |
|---|---|---|---|---|---|
| `README.md:122` | repo root | dependencies installed | side-effect/process | `pnpm --filter @ebb-orchestrator/server dev` | Expected long-running server development process; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:128,368` | repo root | dependencies installed | side-effect/process | `pnpm --filter @ebb-orchestrator/web dev` | Expected long-running Vite process; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:168` | repo root | contracts and server build toolchain/dependencies | side-effect (dist cleanup/build outputs) | `pnpm --filter @ebb-orchestrator/server build` | Expected `0`; server dist generated; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:174,507,599` | repo root | dependencies installed | side-effect (dist/build outputs) | `pnpm --filter @ebb-orchestrator/web build` | Expected `0`; Vite build output generated; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:364` | repo root | dependencies installed | read-only | `pnpm --filter @ebb-orchestrator/server typecheck` | Expected `0`; no emit; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:365` | repo root | dependencies and successful `pnpm server:build` outputs (`packages/contracts/dist`, `apps/server/dist`); on Windows x64, build from an initialized Visual Studio Developer shell | side-effect (temporary test files/processes) | `pnpm --filter @ebb-orchestrator/server test` | Bare invocation without build preparation: **FAIL**, observed 2026-10-03, exit `1` after `264.93s` (3 files failed/120 passed/1 skipped; 7 tests failed/1134 passed/21 skipped/10 unhandled), due to missing generated `contracts/dist/index.js` and `apps/server/dist/main.js`. After successful build, exact command passed 2026-10-03: exit `0`, `222.56s`; Vitest `123 passed / 1 skipped` files (124), `1141 passed / 21 skipped` tests (1162), duration `221.01s`. Outputs were removed after verification; fixtures clean up through `finally`/`afterEach`. |
| `README.md:366` | repo root | dependencies installed | read-only | `pnpm --filter @ebb-orchestrator/server test:auth-contract` | Expected `0`; auth contract suites pass; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:367,508` | repo root | built server and writable `EBB_ORCHESTRATOR_HOME` | side-effect/process | `pnpm --filter @ebb-orchestrator/server start` | Expected long-running server process; audit only with isolated home and health probe; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:369` | repo root | dependencies installed | read-only | `pnpm --filter @ebb-orchestrator/web test` | Expected `0`; Vitest summary; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:370` | repo root | dependencies installed | side-effect/process | `pnpm --filter @ebb-orchestrator/web test:watch` | Expected long-running Vitest watch; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:371` | repo root | dependencies, browser runtime and E2E prerequisites | side-effect (browser/process/test artifacts) | `pnpm --filter @ebb-orchestrator/web test:e2e` | Expected `0`; run only with isolated E2E environment; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:372` | repo root | TypeScript/dependencies | side-effect (contracts dist cleanup/build) | `pnpm --filter @ebb-orchestrator/contracts build` | Expected `0`; `dist` generated; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:373` | repo root | TypeScript/dependencies | read-only | `pnpm --filter @ebb-orchestrator/contracts typecheck` | Expected `0`; no emit; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:374` | repo root | Vitest/dependencies | read-only | `pnpm --filter @ebb-orchestrator/contracts test` | Expected `0`; `--passWithNoTests` is enabled; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:375` | repo root | TypeScript/dependencies | read-only | `pnpm --filter @ebb-orchestrator/testing typecheck` | Expected `0`; no emit; `NOT RUN / NOT VERIFIED` in this matrix |
| `README.md:376` | repo root | Vitest/dependencies | read-only | `pnpm --filter @ebb-orchestrator/testing test` | Expected `0`; `--passWithNoTests` is enabled; `NOT RUN / NOT VERIFIED` in this matrix |

- Матрица должна содержать также любой новый script, найденный в перечисленных manifests; отсутствие script в текущей версии фиксируется как mismatch, а не исправляется догадкой. Команды и ссылки из обоих существующих README и канонического Hermes guide, не являющиеся manifest scripts (например `node --version`, `git diff --check`, `hermes --version`, `hermes model`, `hermes auth --help`, `hermes --in` и ссылки), остаются отдельными строками с теми же колонками.
- **Manifest coverage reconciliation (2026-10-03):** read-only сверка шести перечисленных manifests обнаружила 47 script keys: root `26`, server `8`, web `5`, contracts `4`, testing `2`, health-service fixture `2`. Все user-facing `pnpm` invocations из `README.md`, `docs/README.md` и `docs/development/05-hermes.md` сопоставлены с этими manifests и workspace names либо отдельно отмечены как unsupported (`docs:link:sync`). Единственным пропуском в самой matrix были два package `prebuild` cleanup hooks; они добавлены как отдельные side-effecting, `NOT RUN / NOT VERIFIED` строки выше. Установка, запуск и Hermes/provider acceptance ради этого inventory не выполнялись.
- **Review correction (2026-10-03):** independent review found that the full server Vitest suite creates disposable filesystem fixtures and exercises bounded child-process behavior, so its matrix entries are `side-effect` rather than `read-only`; exact affected README invocation is classified the same way. The cited fixtures use cleanup in `finally`/`afterEach`.
- **Build prerequisite correction and fresh acceptance (2026-10-03):** the bare filtered server test first failed because generated outputs were absent: `auth-repository.concurrency.test.ts` imports runtime exports through contracts `./dist/index.js`, while `epic-restart-production.acceptance.test.ts` and `v1-crash-matrix.test.ts` launch `crash-recovery-server.mjs`, which imports `apps/server/dist/main.js`. Root `pnpm test` builds contracts but not server. An ordinary PowerShell `pnpm server:build` failed because `VCToolsInstallDir` and `cl.exe` were unavailable; after transient x64 VS 2019 BuildTools `VsDevCmd` initialization, the build passed (exit `0`, `14.87s`; native helper built). Then the exact filtered server test passed (exit `0`, `222.56s`; 123/124 files passed with 1 skipped; 1141/1162 tests passed with 21 skipped; Vitest duration `221.01s`). Only the two new, untracked output directories were removed after path/tracked/reparse checks; both are absent. Root `pnpm test` remains unrun.
- Проверить package filters (`@ebb-orchestrator/server`, `@ebb-orchestrator/web`) по фактическим workspace names, `packageManager`/Node engine по `package.json` и `pnpm-lock.yaml`, а также prerequisites каждого скрипта.
- README-команды governance/Hermes разделить по фактическому риску: `pnpm docs:inventory`, `pnpm docs:check`, `pnpm docs:test` и `pnpm hermes:check` входят в read-only verified set с exact exit/output и artifact absence check; `pnpm hermes:setup` отдельно классифицируется как side-effecting (`HERMES_HOME`/setup state) и запускается только в изолированной копии; `pnpm docs:rename:check` — реализованная read-only проверка migration map и ссылок (на correction checkpoint: exit `0`, 43 entries, no retained legacy sources or broken relative links); `pnpm docs:link:sync` остаётся unsupported (`1`, dispatcher usage output) и не считается проверенной read-only командой.
- Expected: детерминированная матрица покрывает каждый script и каждую команду `README.md`, `docs/README.md` и `docs/development/05-hermes.md`; README обновляются только по строкам с подтверждённым exit/output, а Hermes guide сверяется с теми же evidence; после inventory/validation, включая roadmap audit, отсутствуют `docs/roadmap/generated.md` и любые другие новые artifacts в исходном repo.

### Task 6 — Refresh current project README files in Russian

Files: `README.md`, `docs/README.md`; review canonical Hermes guide `docs/development/05-hermes.md` for stale paths and commands. Do not recreate `tools/hermes/README.md`.

- Remove YAML/frontmatter-like leading metadata blocks from the two existing README files while retaining factual Markdown content. Preserve the canonical Hermes guide's valid non-README metadata.
- Rewrite stale plan/index references in the two README files to actual paths under `docs/architecture/plans/`, preserving technical identifiers, commands and paths verbatim; keep Hermes guidance in `docs/development/05-hermes.md`.
- Align setup, development, build, docs governance, Hermes skills and quality-gate instructions across the two README files and the canonical Hermes guide with Task 5 evidence.
- Keep provider/model/native-auth setup explicitly `NOT RUN` until Plan20 Task7 supplies pinned-version commands and real provider-backed acceptance. Do not add guessed auth/provider commands or claim that native auth is configured. State that `pnpm hermes:setup` configures project trust/discovery/delegation, `pnpm hermes:check` checks CLI/project prerequisites only, and neither verifies provider authentication or makes a provider/API request. Plan20 Task7 owns the final provider/auth/Run/recovery instructions; after that task, Plan16 performs only a consistency/readback check and preserves its general navigation and command-matrix corrections. This downstream documentation gate does not block Plan20 Task7 or require Plan20 to wait for whole-Plan16 closure.
- Verify that `scripts/hermes-dev.test.mjs` stays synchronized with the current canonical 20-skill registry declared by `scripts/hermes-dev.mjs` and listed in `README.md`; do not regress it to the obsolete 11-skill count. Keep its secret-pattern assertion boundary-aware.
- Mark optional, unavailable or not-yet-verified features explicitly; do not turn historical audit claims into current guarantees.
- Validate links, heading structure, UTF-8 and Russian prose in both README files and the canonical Hermes guide; do not change production source code or active plans.
- Expected: both existing README files are Russian, metadata-free, factually linked and reproducible from the command matrix; the separate canonical Hermes guide has current verified links and commands.

### Task 7 — Decide `.gitignore` and `AGENTS.md` policy narrowly

Files: `.gitignore`, `AGENTS.md`, possibly no change if evidence does not justify it.

- Evaluate `temp/` and `test/` names against actual source directories and generated outputs. Prefer specific patterns such as local temporary directories or generated test output; never add broad `test/` that would hide `apps/server/test` or `apps/web/test`.
- Add an `AGENTS.md` rule only if it states where temporary files may be created, requires cleanup or external placement, preserves source/tests and forbids destructive Git cleanup. Keep it consistent with existing instructions.
- Expected: either a minimal justified diff or an explicit no-change decision with evidence.

**No-change disposition (2026-10-03):** `.gitignore` already limits repository-local temporary ignores to `/temp/` and generated test output (`playwright-report/`, `test-results/`); it has no broad `test/` rule. `git check-ignore --no-index apps/server/test apps/web/test` matched no rule, while `git check-ignore --no-index temp` matched `.gitignore:15:/temp/`. `AGENTS.md` §14 already directs one-off artifacts to the system temp directory or the root `temp/` with cleanup. No concrete defect justifies editing either policy file.

### Task 8 — Execute the exact cleanup and verify links/status

Files: only the eight exact target files and the two named governance evidence files.

- Recheck each path, tracked state and exact SHA-256 immediately before its individual `Remove-Item -LiteralPath` operation; do not archive, recurse, move or delete directories.
- Update only the two historical governance evidence references named in Task 4, preserving their surrounding evidence.
- Verify all eight paths are absent, all 14 preservation paths remain, no protected path changed, and no surviving link points to a removed target.
- Run relevant documentation checks after deletion; do not regenerate the canonical roadmap or change plan statuses.
- Expected: exactly the eight listed files are deleted and only the targeted Plan16/governance documentation changes accompany them.

### Task 9 — Final documentation and repository gates

Files: final diff and status only; no code files expected to change.

- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm server:build`, `pnpm web:build`, relevant docs tests and `git diff --check`; use exact commands that Task 5 proves valid.
- Review `git diff -- README.md docs/README.md docs/development/05-hermes.md .gitignore AGENTS.md` and `git status --short --untracked-files=all`.
- Verify no secrets, no active-plan changes, no unapproved deletes/moves and no generated cleanup artifacts remain.
- Expected: all required gates are green or documented as an environment blocker; no claim of completion is made while a required gate is red.

## RED → GREEN evidence

Behavior changes are documentation/governance behavior rather than runtime behavior. Where a validator or script is changed (only if separately approved), first add or identify a failing test for the intended rule (for example: README frontmatter rejection, narrow temporary path ignore, stale-link detection), run the focused test to show RED, then make the smallest change and rerun to show GREEN. For README-only changes, use before/after command and link checks as the RED/GREEN evidence; do not fabricate a test requirement for prose.

## Acceptance criteria

**Reconciliation 2026-10-02:** The rebaseline is 97 listed paths: 75 missing, 14 existing preservation paths and 8 exact delete targets. The user's direct instruction authorizes deleting those eight historical files with no archive or additional approval. Plan16 remains blocked because its independent README, command-audit and governance work is incomplete; this targeted cleanup does not change lifecycle status.

- [x] Rebaseline records the current 97-path inventory: 75 absent paths, 14 preserved paths and 8 exact tracked delete targets.
- [x] The 14 existing preservation paths are enumerated and protected; active 15-* plans remain outside cleanup.
- [x] The user directly instructed deletion of old materials; no external archive or additional approval is required for the exact eight targets.
- [x] Immediately before each deletion, existence, tracked state and SHA-256 matched the exact rebaseline row.
- [x] Deleted only the eight exact files individually; verified each is absent and all 14 preservation paths remain.
- [x] Marked the two specified historical evidence references as deleted by this rebaseline while preserving all remaining evidence.
- [ ] README.md and docs/README.md are Russian, metadata-free and link to real current paths; docs/development/05-hermes.md remains the canonical Hermes guide and preserves its guideline metadata.
- [ ] Both README files and the canonical Hermes guide document only verified pnpm commands and state prerequisites/environment-dependent behavior.
- [ ] .gitignore changes, if any, are narrow and do not hide source tests; AGENTS.md changes, if any, define safe temporary-file handling.
- [ ] pnpm docs:check validates frontmatter/id/filename structure; the read-only PowerShell snippet validates plan-16 created: 2026-09-25 and updated: 2026-10-03 as ISO dates; inventory and validation leave neither docs/roadmap/generated.md nor any other new artifact.
- [ ] Documentation validators, quality gates, link/status checks and git diff --check pass; no unrelated changes remain.

## Risks and rollback

| Risk | Mitigation | Recovery |
|---|---|---|
| Rebaseline drift or a file changes before deletion | Recheck exact path, tracked state and SHA-256 immediately before each individual removal; stop on mismatch. | Do not delete that path; refresh evidence and disposition before any further action. |
| A historical reference appears to be a live dependency | Search and classify the exact references; update only the two named governance evidence rows as historical. | Restore the path from Git history only if a verified active consumer is found; reassess deletion scope. |
| Cleanup reaches an unlisted path | Use individual `-LiteralPath` operations, no recursion and no wildcard expansion. | Stop immediately and preserve all unrelated paths. |

No archive is created by direct user instruction. These deletions are recoverable from Git history; never use `git reset --hard`, `git clean`, recursive removal, or unreviewed bulk deletion.

## Approval gate and completion rule

The user has directly instructed deletion of the eight exact files in the 2026-10-02 rebaseline. For those files, no archive or additional approval is required; immediately recheck exact path, tracked state and SHA-256, then delete individually. This does not authorize other deletion/move operations or README/policy edits. Plan16 remains blocked until its remaining acceptance criteria and required gates pass; do not change its status or generated roadmap as part of this targeted cleanup.

## Дополнение от 2026-10-03 — Hermes provider setup review

Независимый review вернул `CHANGES_REQUIRED`; оба замечания классифицированы как `VALID / IMPORTANT`.

- `hermes model` и `hermes auth --help` ранее стояли в actionable setup-инструкциях, хотя были проверены только соответствующие help/version output; interactive wizard, native auth и provider request не выполнялись. Исправлено: README и Hermes guide больше не предписывают эти команды как setup flow. Matrix rows для `hermes model --help` и `hermes auth --help` остаются только read-only evidence; сам wizard/native-auth flow явно `NOT RUN / NOT VERIFIED`.
- Полный clean-checkout walkthrough — install, pinned Hermes-native auth и безвредный real provider Run — пока не доказан. `pnpm hermes:setup` настраивает project trust/discovery/delegation, а `pnpm hermes:check` проверяет CLI/project prerequisites, но не provider authentication и не является provider acceptance. README и guide теперь явно называют это незакрытым ограничением.
- Production per-Run auth/session acceptance остаётся `NOT RUN / NOT VERIFIED` и gated на Plan20 Task5A → Task5B → Task5C. Linux/WSL и provider/profile не запускались и не изменялись ради исправления документации.
- Task6 и Plan16 остаются открытыми (`status: blocked`); status/frontmatter и acceptance checkboxes этим review disposition не менялись. Документирование acceptance и полный walkthrough не объявляются завершёнными до выполнения допустимых Plan20 gates и fresh evidence.
