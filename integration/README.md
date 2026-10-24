# Пакет политики веток, релизов и проектной документации Ebb

Этот архив содержит reviewable proposals для настоящего репозитория Ebb: обновлённые project skills, proposed AGENTS, минимальные изменения PR triggers и один Plan26. Разработка интегрируется через develop; master появляется только для опубликованных release snapshots. Release вручную публикует Git/GitHub/GHCR artifacts, без deployment. Withdrawal удаляет последний release, включая root master, а consumed version остаётся зарезервированной навсегда.

Plan26 выполняется (`in_progress`): release CLI, модули policy/gates/snapshot/journal/operations и trusted validation/publisher workflows реализованы и прошли review на verified HEAD `f6937f2`. Docker support отсутствует (Task9 BLOCKED), live acceptance Task11 не выполнялась; публичные production release/GHCR operations не выполнялись, публикация выключена до Task11 acceptance и финального approval. Actual app tests/CI/GitHub API/registry acceptance не проверялись; static и disposable local fixture evidence имеет отдельный scope в [VALIDATION.md](integration/VALIDATION.md).

Сначала выполните [BEFORE-PLAN.md](integration/BEFORE-PLAN.md): current worktree/data audit, fresh GitHub inventory/default develop/settings review и отдельное concrete approval на safe legacy master retirement. Синхронный legacy master удаляется после proofs при initial transition, до нового release tooling; не ждёт первого release. Future tool не нужен для этой one-off native Git CAS операции. Историческое равенство master/develop не является разрешением удаления.

Состав архива относительно его корня:

| Путь | Содержание |
|---|---|
| `README.md` | Эта инструкция пакета; **не replacement project README**. |
| `AGENTS.md` | Proposed полный файл с сохранёнными unrelated source sections. |
| `.agents/skills/` | 22 перечисленных ниже project skill directories; каждый содержит `SKILL.md` и свои bundled references/agent metadata. |
| `.github/workflows/production-gates.yml` | Existing workflow proposal: только PR target develop. |
| `.github/workflows/codeql.yml` | Existing workflow proposal: только PR target develop. |
| `.github/workflows/security-audit-failure-paths.yml` | Unchanged supplied audit failure workflow. |
| `docs/architecture/plans/26-branch-and-release-policy.md` | Единый numbered implementation plan, Task0..11. |
| `docs/architecture/policies/branch-and-release-policy.md` | Target branch/release/withdrawal contract. |
| `integration/BEFORE-PLAN.md` | Windows PowerShell preparation и safe initial transition. |
| `integration/CHANGE-MAP.md` | Scope, migration и file application map. |
| `integration/SOURCES.md` | First-party baseline и external provenance/limits. |
| `integration/VALIDATION.md` | Проверки пакета и explicit not-run acceptance. |
| `integration/SHA256SUMS.txt` | Exact file inventory с checksums для содержимого архива. |
| `integration/evidence/` | Concise local/static evidence reports, включая 10 Git/bare-remote checks; exact filenames есть в SHA256SUMS. |

Skill directories:

| Existing preserved (20; 15 updated, 5 unchanged) | Existing preserved (продолжение) |
|---|---|
| `ebb-curate-skills` | `ebb-orchestrate-work` |
| `ebb-database-engineering` | `ebb-quality-gates` |
| `ebb-debug-issue` | `ebb-repository-context` |
| `ebb-design-change` | `ebb-repository-maintenance` |
| `ebb-dispatch-agents` | `ebb-review-plan` |
| `ebb-execute-plan` | `ebb-review-task` |
| `ebb-final-review` | `ebb-security-review` |
| `ebb-finish-branch` | `ebb-web-e2e` |
| `ebb-handle-review-feedback` | `ebb-worktree` |
| `ebb-implement-task` | `ebb-write-plan` |

New directories: `ebb-release`, `ebb-maintain-project-docs`. Personal/global skill installation не требуется; project dirs остаются `.agents/skills/`.

Применяйте архив через сравнение current repository и proposals. Сначала прочитайте [CHANGE-MAP.md](integration/CHANGE-MAP.md), сохраните current intended/unrelated work и merge только целевые hunks. Не копируйте полный AGENTS/skill/workflow поверх изменённого current файла. Добавьте новые dirs/docs, сохранив actual docs naming/governance. Archive README оставьте companion instruction; project README обновит content owner по real source. Source `package.json` не включён как replacement: scripts executor зарегистрирует после реализации и inspection actual manifest. Existing workflows сохраняют push `[master, develop]`, jobs/permissions/platforms и audit `continue-on-error` + evidence + explicit failure; absent master harmless.

Native Codex project-skill invocation:

```text
$ebb-review-plan Проверь docs/architecture/plans/26-branch-and-release-policy.md по настоящему source, scoped AGENTS и current preflight.
$ebb-execute-plan Выполни утверждённый Plan26 task subagents, максимум два subagents всех roles одновременно, с independent review. Не публикуй release.
$ebb-maintain-project-docs Выполни полный first-party README и .env.example audit по manifests/loaders; не читай реальные .env/secrets, используй existing docs governance.
```

`$skill-name` — native Codex syntax. Это **не** существующие repository `/ebb-*` slash commands; на другой платформе используйте её механизм project skills, не переносите синтаксис вслепую. После полного implementation/readiness отдельная ручная invocation `$ebb-release` начнёт prepare/version choice/reservation/gates и запросит final concrete approval; сама строка invocation не означает blanket public mutation permission.

По текущему HEAD Tasks 2–8 реализованы: CLI `node scripts/release.mjs` существует с режимами `prepare|validate|rollback|resume|status` (режима `publish` в CLI нет; публичные мутации — только trusted workflow `.github/workflows/release-operations.yml`), policy-конфигурация `.ebb/release-policy.json`, реестр `docs/releases/version-reservations.json`, `release.json` и workflows `release-validation.yml`/`release-operations.yml`. `resume` пока BLOCKED. Публичных production release/GHCR-операций не выполнялось; публикация остаётся отключённой до Task11 acceptance и финального одобрения. Docker/runner/provider prerequisites и полный exact-SHA matrix блокируют release enablement, пока не доказаны; чек archive их не заменяет.
