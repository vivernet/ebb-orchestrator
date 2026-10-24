# Проверки пакета и границы результата

Проверяется подготовленный пакет предложений, а не реализация Plan26 в настоящем репозитории. План не запускался; GitHub/GHCR публикации, удаления и изменение настроек проекта не выполнялись. Код release CLI, новые manual workflows и Docker support в архив не входят.

| Проверка | Фактический результат / scope |
|---|---|
| Inventory и structural validator | 87 проверок прошли: 22 canonical skills, frontmatter, relative references, сохранность original files, manual-only release metadata, workflow YAML и ограниченный diff, plan/prelaunch paths. См. `evidence/static-validation.json`. |
| Skill creator quick validator | Все 22 `SKILL.md` прошли структурную проверку. Это не behavioral/release acceptance. |
| Сохранение baseline | Сохранены 20 original skills / 42 файла. 15 skills / 28 файлов адресно изменены; 5 skills / 14 файлов byte-identical. Ни один reference не удалён. |
| AGENTS | Sections 1–3, 5–11, 13–14 byte-identical; изменения ограничены Git/workflow, документацией, canonical policy и completion evidence. |
| Workflows | Production gates и CodeQL: только PR target master→develop. Audit failure workflow полностью неизменен. Jobs/permissions/runtime/platforms и audit evidence/failure semantics сохранены. |
| Markdown links | 38 относительных ссылок в 59 исходных Markdown файлах разрешаются; ссылки на этот report/checksum manifest добавлены при сборке. |
| Git snapshot design | Root controller реально выполнил 10 checks в disposable local Git/bare remote: root/one-parent, exact trees, CAS refusal, atomic ref transactions, root removal и сохранение develop. См. `evidence/git-snapshot-proof.json`. |
| Independent whole-package review | Исходные файлы сравнивались с proposals независимо от author conclusions. Review дополнительно выполнил 8 local Git checks. Finding и результат scoped re-review — `evidence/combined-review.md`. |
| Docs author fixture | Provider-free Python fixture: 7 config assertions и 3 scoped commands. Generated-source/links/unchanged checks. См. `evidence/docs-application.md`. |
| Independent docs application | Другой агент применил skill к отдельному Python Cedar fixture: 5/5 first-party targets, 3 адресных edits, accurate files/vendor сохранены; 22 loader/example/CLI case groups и 8 links прошли. Application/Compose source не изменён. См. `evidence/docs-forward-result.md`. |
| Release pressure cases | Два явно simulated skill application traces: absent tooling при срочном root withdrawal и GHCR refusal при verified tooling. Не live provider execution. См. `evidence/combined-review.md`. |
| Whitespace | Выполнен `git diff --cached --check` для локального artifact checkout; ошибки форматирования устранены. Это не Git operation настоящего проекта. |
| Archive integrity | ZIP CRC проверяется при сборке; SHA256SUMS перечисляет hashes файлов, кроме самого SHA256SUMS (self-hash невозможен). Baseline hashes: `evidence/source-sha256.json`. |

Проверки автора и независимые проверки различаются; static retrieval и simulated trace не называются runtime тестом. Baseline gaps были зафиксированы до правок. Отчёты показывают фактически выполненные команды, включая устранённые технические ошибки проверок, и доступный evidence.

**NOT_RUN / UNVERIFIED:** actual Ebb application lint/typecheck/test/build, docs/skills implementation tests настоящего проекта, DB/security/Web/recovery acceptance, Linux/Windows CI/native/keyring/CodeQL runs, future release CLI/adapters/journal/fault injection, Docker/Buildx/Compose runtime, live GitHub/GHCR API/permissions/public visibility/publication/deletion, live staging acceptance. Переданный snapshot не содержал application code, actual README/config loaders, Dockerfiles или implementation docs tooling. В Cedar fixture Docker отсутствовал; Compose mapping проверен только статически.

Поэтому архив означает **«предложения и план подготовлены и проверены в указанном scope»**. Release enablement требует реализации Plan26, финального binding реальных trusted workflows/scripts, actual Docker/runner/provider prerequisites и полного обязательного matrix. Bootstrap config с null/pending bindings не является разрешением на публичные mutations. Никакая зелёная проверка архива не снимает эти blockers.

Следующий шаг пользователя: [BEFORE-PLAN.md](BEFORE-PLAN.md), затем source-based review и отдельно авторизованное исполнение плана. Archive README не заменяет project README; применять через merge целевых изменений, а не слепое копирование.
