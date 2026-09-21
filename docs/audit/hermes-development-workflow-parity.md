# Hermes Development Workflow Parity Report

**Дата:** 2026-09-21
**Ветка:** develop
**HEAD:** b3b6615

Документ фиксирует фактическую проверку parity workflow разработки Hermes после синхронизации project-local skills.

## Контекст и делегирование

| Проверка | Результат | Evidence |
|---|---|---|
| `.hermes.md` существует и прочитан | PASS | Hermes parity run |
| `master` указан основной веткой | PASS | `.hermes.md` |
| Russian JSDoc rule | PASS | `.hermes.md` |
| Не более двух concurrent subagents | PASS | `.hermes.md`, Hermes config |
| `delegation.max_concurrent_children` | PASS | `2` |
| `delegation.max_spawn_depth` | PASS | `1` |
| `delegation.orchestrator_enabled` | PASS | `false` |
| `delegation.worktree_isolation` | PASS | `false` |

## Project-local installation

`pnpm hermes:check` после `pnpm hermes:setup` завершился PASS:

- 9 skills: `ebb-execute-plan`, `ebb-final-review`, `ebb-implement-task`, `ebb-provider-integration`, `ebb-quality-gates`, `ebb-repository-context`, `ebb-review-task`, `ebb-security-review`, `ebb-web-e2e`;
- `tools/hermes/capabilities.yaml` совпадает с установленным registry;
- `tools/hermes/providers/inception.yaml` совпадает с установленным provider template;
- hashes всех 9 target skills совпадают с source.

## Repository gates

The table below is the latest evidence from the current dirty checkout at
`b3b66154729ca2b373e0424dbab96b4435ec2c11`; it does not authorize merge or
publication.

| Команда | Результат | Evidence |
|---|---|---|
| `pnpm lint` | PASS | ESLint завершился с exit code 0 |
| `pnpm typecheck` | PASS | contracts, testing, server завершились успешно |
| `pnpm test` | PASS | contracts 3; server 687 passed/2 skipped; web 127 passed |
| `pnpm server:build` | PASS | production server build завершён |
| `pnpm web:build` | PASS | Vite production build завершён |
| `pnpm --filter @ebb-orchestrator/web test:e2e` | PASS | 3 passed; launcher exit code 0; teardown artifact отсутствует |
| `pnpm hermes:test` | PASS | 6 tests passed |
| `pnpm hermes:setup` | PASS | `HERMES_CONFIG marker=SETUP_SYNCED verified=true redacted=true`; canonical skills/provider/capabilities hashes verified |
| `pnpm hermes:check` | PASS | bounded serial run after setup; `resolveHermesHome` uses `%LOCALAPPDATA%\\hermes` on Windows; all registry, provider, target and delegation checks passed |
| Hermes config/execute supervision tests | PASS | bounded config/execute timeout handling, fixed redacted markers, cleanup and Windows process-tree termination via `taskkill.exe /PID /T /F` |
| `pnpm hermes:smoke` harness tests | PASS | 6 focused tests; harness contract is redacted and isolated |
| `pnpm hermes:smoke` current live run | MODEL_FAILED | exit 1 with documented `mercury-2` mapping; `redacted=true`; `cleanup_verified=true`; synthetic prompt/empty workspace; raw output withheld |
| `pnpm hermes:smoke` previous live run (superseded) | MODEL_FAILED | exit 1 with old `mercury-2.5` mapping; synthetic prompt/empty workspace; raw output withheld |
| `node --test scripts/security-audit-evidence.test.mjs` | PASS | 5 tests passed |
| Escalated `pnpm audit --prod --json` | PASS | 0 vulnerabilities; `artifacts/security/pnpm-audit-prod-b3b66154729ca2b373e0424dbab96b4435ec2c11.json` binds revision, branch and lockfile |
| `git diff --check` | PASS | только environment-level Git ignore permission warnings |

## Историческая попытка provider-backed parity run

Запуск `pnpm hermes:execute -- tools/hermes/fixtures/parity-plan.md` был выполнен с двумя concurrent delegation attempts. Hermes загрузил `.hermes.md`, `ebb-execute-plan` и план; один subagent завершился с HTTP 401 от Inception provider. Исторический запуск также использовал устаревшее ожидание `4` skills и получил `FAIL` до текущей синхронизации и исправления repository gates; это не текущий результат локальных gates.

`pnpm hermes:smoke` проверяет безопасную форму synthetic provider transport. Текущий
live run после correction на documented `mercury-2` завершился `MODEL_FAILED`, exit
code `1`, с `redacted=true` и `cleanup_verified=true`; raw provider/Hermes output
намеренно не сохраняется. Предыдущий live run с `mercury-2.5` остаётся явно
superseded. Smoke не доказывает parity.

Config/execute timeout handling: **IMPLEMENTED/VERIFIED** by the bounded runners
and focused tests; Windows process trees are terminated with `taskkill.exe /PID /T /F`.
The historical slow `hermes:check` observation is not attributed to a separate
provider timeout root cause.

Таким образом, локальная parity-инфраструктура и все project-controlled gates подтверждены, но end-to-end provider-backed subagent execution остаётся отдельным внешним approval boundary: требуется явное разрешение на передачу repository-derived context внешнему Inception endpoint и рабочая provider authorization. Значение ключа не читалось и не записывалось в repository, logs или artifacts.

## Итоговый verdict

**BLOCKED — local Hermes workflow parity PASS, provider-backed delegation не подтверждён из-за HTTP 401; текущий synthetic smoke также завершился `MODEL_FAILED`.**

Это не baseline failure исходного проекта: локальные ошибки lint/test, выявленные первым запуском, исправлены regression-тестами и повторно проверены. `.opencode` dependency пока не удаляется до успешного provider-backed parity run.
