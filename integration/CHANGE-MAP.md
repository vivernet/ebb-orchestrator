# Карта изменений и безопасное применение

Это reviewable proposals, не применённые изменения настоящего проекта. Original snapshot содержит root AGENTS, manifest, три workflows и двадцать ebb skills с references. Actual app/Docker/config loaders/README/governance implementation не предоставлены.

| Область | Изменение / обоснование | Как применить |
|---|---|---|
| `AGENTS.md` | Section4: develop integration, release-only absent-before-first master, root/one-parent snapshots, mode-specific gates, reservations/manual release/withdrawal. Section12: README/example content owner. Section15: policy link. Section16: truthful identity/state evidence. Default max2 task/review subagents. | Merge hunks с current AGENTS; sections1–3,5–11,13–14 сохраняют original текст/смысл. |
| Existing preserved 20 `.agents/skills/ebb-*` (15 updated, 5 unchanged) | В 15 skills изменены 28 файлов; пять skill directories сохранены целиком без изменений. Целевые изменения: удаление master как обычного PR target и release-by-completion assumptions; routing нового docs owner/manual release, pinned identities/isolated worktrees и default max2 там, где relevant. Detailed changes сохраняют specialist responsibilities. | Сравнивать каждый skill/reference с current revision; не bulk overwrite чужих updates. |
| New `ebb-release` | Полный ручной publish/hotfix/withdraw/resume contract, provider limits, immutable IDs/journal/approval и future-tool BLOCKED. | Добавить directory; не считать CLI установленным. |
| New `ebb-maintain-project-docs` | First-party README/examples ownership, changed-scope vs full audit, code-grounded config/commands, generators и existing governance. | Добавить directory; current docs audit ещё предстоит по Task0/Task10. |
| `production-gates.yml`, `codeql.yml` | Только `pull_request.branches: [master]` → `[develop]`. Push `[master, develop]`, platform/runtime/job/permissions/steps/audit unchanged. | Verify only this diff against supplied source; current project unrelated workflow edits preserve. |
| `security-audit-failure-paths.yml` | Без изменений, review copy для сохранения audit failure semantics. | Не заменять current file, если оно изменилось; compare и сохранять семантику. |
| `docs/architecture/policies/branch-and-release-policy.md` | Единый confirmed target contract и BLOCKED boundaries. | Добавить по actual docs governance; canonical spec не переписывать. |
| `docs/architecture/plans/26-branch-and-release-policy.md` | Один numbered executable plan с Task0 actual bindings, tests-first, max2 task agents, independent review, Docker prerequisite, no live production operations. | Preflight/review до implementation, exact bindings заполнить source facts. |
| `integration/*` и root archive README | Человеческая инструкция/prelaunch, provenance, validation, checksum inventory. | Это companion files пакета; project README не заменять archive README. |
| `package.json` | Не поставляется как replacement. Будущие scripts регистрации после real implementation. | Executor делает minimal merge в actual manifest, сохраняет unrelated fields/scripts и `private:true`. |
| Future release CLI/config/reservations/Docker/new manual workflows | В архиве не реализованы; Plan26 назначает producers/tests/consumers. | Не запускать ручные substitute publish/cleanup commands; prerequisites BLOCKED until tested. |

Initial legacy transition — отдельный proof+confirmation+native CAS до нового release tooling, см. BEFORE-PLAN. Политика не оставляет синхронный master до первой публикации. Master namespace ruleset может существовать по имени при absent branch; provider protection rights нельзя обходить.

Сверьте новый target contract с актуальным spec/roadmap/scoped instructions и docs naming tools. Если текущие docs governance требуют регистрацию/metadata для policy/plan, executor применяет canonical mechanism; на README служебный header/numeric prefix не добавляется. Не создавать второй inventory/link checker.

Проверки пакета и их ограничения приведены в VALIDATION.md: static/local fixtures не равны app tests/CI/API/Docker acceptance. SHA256SUMS контролирует целостность archive содержимого, не безопасность/implementation readiness.
