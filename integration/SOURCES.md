# Источники и происхождение

## 1. First-party baseline

Основной источник — предоставленный пользователем Ebb snapshot: `AGENTS.md`, root `package.json`, production-gates/codeql/security-audit-failure-paths workflows и двадцать `.agents/skills/ebb-*` с references. Он задаёт project identity, deterministic-first/security/module policies, engines, declared commands и actual CI scopes. Source snapshot сохранён отдельно у автора; он не означает наличие полноценного репозитория, config loaders, Dockerfiles или исполнения declared tests.

Confirmed user decisions задают develop default/integration, task worktrees/squash PR, release-only master absent before first prod, initial legacy retirement, root/one-parent exact trees, PUBLIC GHCR images, manual explicit approval, full PUBLISH gates, safety-only withdrawal, no deployment и permanent consumed versions. External sources не заменяют эти решения и first-party authority.

## 2. Provider/Git/version references

Проверено автором пакета 2026-10-02; executor актуализирует capabilities/permissions до live operation. Использованы paraphrases/contract conclusions, не скопированный foreign runtime workflow.

| Источник | Что обосновывает / граница |
|---|---|
| [GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages) | Public packages бесплатны; container registry image storage/bandwidth сейчас бесплатны. Actions compute/artifact quotas отдельны; нельзя обещать весь CI бесплатно. |
| [Deleting/restoring package](https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package) | Public package/version >5,000 downloads обычно нельзя удалить самостоятельно, требуется Support; permissions/visibility имеют значение. Unknown count не доказывает eligibility. |
| [Packages REST API](https://docs.github.com/en/rest/packages/packages) | Документированные exact package/version identity/deletion APIs; нет обещанного `download_count` в version response. Не invent endpoint/preflight guarantee. Provider refusal первой approved GHCR deletion останавливает later Release/ref deletes. |
| [Managing GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) | Release deletion/assets и immutable Release tag ограничения. GHCR first, Release next, Git refs last для withdrawal; cross-system atomicity отсутствует. |
| [Git commit-tree](https://git-scm.com/docs/git-commit-tree) | Commit из exact tree с 0/1 parent, stable inputs; commit metadata не изменяет tracked tree. |
| [Git push](https://git-scm.com/docs/git-push) | Atomic ref update при support и explicit compare-and-swap leases. Git transaction не распространяется на GitHub/GHCR APIs; permissions/ref refusal сохраняются. |
| [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) | Proposal version logic; initial Ebb contract ограничен stable MAJOR.MINOR.PATCH, prerelease/build suffixes запрещены до отдельного reviewed change. |
| [GitHub Actions workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) | Один trusted manual workflow shared repository group/cancel-in-progress false; не API fencing и не абсолютная межсистемная transaction. Default pending queue может replace/cancel queued run; порядок не гарантирован. Queue policy выбирается в Task0, отмена/timeout наблюдаются и не считаются mutation success. |

GHCR physical blob retention/cache и shared blobs не равны target version publication retention. Root withdrawal не имеет prior image. Packages public visibility не требует менять repository visibility; root package `private:true` относится к npm.

## 3. Обобщённые documentation patterns

Для нового first-party docs owner рассмотрены generic patterns: [softaworks/agent-toolkit](https://github.com/softaworks/agent-toolkit) (`crafting-effective-readmes`), [adewale/good-readme](https://github.com/adewale/good-readme), [cyanheads/git-mcp-server](https://github.com/cyanheads/git-mcp-server) (`polish-docs-meta`). Применены идеи root/nested ownership, reader-purpose/install/examples/verification и source-grounded minimal docs updates. Формулировки и runnable contract написаны для Ebb; foreign skill runtime, slash commands, API authority или обязательные plugins не импортированы. Provenance не означает dependency или необходимость обращаться к этим проектам при применении skill.

## 4. Evidence scope

Десять local Git/bare-remote checks подтверждают только осуществимость root/one-parent/tree/CAS/root-delete design; synthetic docs fixtures проверяют отдельные loader/examples/generation contracts. Они не тестируют future CLI, live GitHub/GHCR, actual project commands, Docker/Buildx или full runner matrix. VALIDATION.md отделяет executed checks от unavailable/not-run acceptance. План остаётся prepared for repository preflight.
