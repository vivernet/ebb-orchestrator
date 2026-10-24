# Docs skill: application и ограничения

Дата: 2026-10-02. Проверяемый пакет: `bundle/.agents/skills/ebb-maintain-project-docs`, version `1.0.0`. Author inline application assessment + исполняемые synthetic fixtures; это не независимый behavioral trial. Baseline до draft: `docs-baseline.md`.

## Application трёх baseline scenarios

| Сценарий | Применение нового contract | Результат / evidence |
|---|---|---|
| Root/package/service, dev versus production | Scope map различает root purpose и nested owners. Python-only fixture Atlas использует `Makefile`, `atlas_api` argparse, client CLI; README links ведут в scoped files, не копируют Ebb/pnpm commands. API dev и production представлены отдельно с service cwd. | Три actual provider-free commands выполнены в временном fixture с synthetic env: `python3 -m atlas_api --mode dev`, `python3 -m atlas_api --mode production`, `python3 -m atlas_client --help`; все exit 0 и expected outputs. Root Make target inspected only, не объявлен executed. |
| Required/default/type, dynamic key, Compose/app boundary | `API_TOKEN` required; omitted `PORT` получает 4100, empty fails, `CACHE_ENABLED` принимает только true/false. `STORAGE_TOKEN` выведен по registry prefix binding. Optional keys commented. `HOST_PORT` принадлежит Compose host interpolation; runtime app `PORT` задан отдельно; `env_file` service-owned. | 7 loader assertions PASS. Не читались настоящие `.env` или secret stores; placeholders и synthetic values. Compose mapping source-inspected, engine validation **unverified**. Для dynamic prefix без registry skill требует unresolved gap; такой путь не выдаётся за exhaustive audit. |
| Generated/accurate, changed scope/full audit | Generated target обновляется через fixture template + regeneration; accurate client README сохраняет hash. Changed server-config sync покрывает API README/example и root/consumer инструкции только при затронутом contract. Full audit inventory включает root/API/client/generated READMEs и оба owner examples с generated source. | Source/regenerated-output equality и unchanged client hash PASS. Scope-mode distinctions проверены inline по reference; independent agent compliance ещё не доказана. Generation fixture — минимальный source-copy contract, не тест реального project's generator. |

Runnable fixture: `python3 evidence/docs-application-check.py` из `release-policy-kit`; stdlib, временный каталог автоматически удаляется. Результат: `status: PASS`, configuration assertions 7, commands 3, local link targets PASS, source regeneration PASS, accurate file unchanged PASS. Это проверяет underlying synthetic contracts и приложенный inline application, не показывает, что будущий агент всегда правильно применит skill.

## Package checks

- `python3 /root/.codex/skills/oai/skill-creator/scripts/quick_validate.py bundle/.agents/skills/ebb-maintain-project-docs`: `Skill is valid!`.
- Проверка всех 5 Markdown files: relative links существуют; external runtime skill dependencies отсутствуют. Main `SKILL.md`: 328 whitespace-separated words; rare detail вынесен в 4 references.
- Fresh static checks: metadata `project=ebb-orchestrator`, `version=1.0.0`; canonical owner names существуют в source; trailing whitespace и host/session paths отсутствуют. `agents/openai.yaml` создан canonical generator; short description 25–64 символа, default prompt содержит `$ebb-maintain-project-docs`, icons/colors/tool dependencies отсутствуют. Итого пакет содержит 6 файлов.
- Source-baseline и author output имеют разные paths; изменение source skills не выполнялось. Только новый owner skill и evidence созданы данным worker.
- Попытка `git status --short` в workspace вернула exit 128: workspace не является Git repository. Поэтому repository diff/status check здесь **недоступен**, синхронизация/упаковка находится у controller. Validator до этой команды завершился успешно; combined shell exit 128 не выдается за package failure или общий PASS.

## Границы результата

Actual project README/config loaders/`.env.example` не предоставлены, поэтому реальный project documentation audit, runtime setup и full Ebb gates не выполнялись. Docs governance implementation отсутствует в source snapshot; объявленные package scripts только discovery evidence. External links/network, Docker engine и real provider/deployment не проверялись. Independent fresh-agent application/trigger validation выполняет controller отдельно; текущий отчёт не подменяет этот результат.

Skill не требует обращения к external/readme candidate skills или интернету; весь runtime methodology находится в его файлах либо в canonical `ebb-*` owners. User-requested repository archive layout соблюдён, personal skill installation не выполнялась.
