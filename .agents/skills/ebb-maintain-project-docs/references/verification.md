# Проверка и completion evidence

## Выбор checks

Обнаружь package/build manifests, existing docs inventories/validators и их implementations. Выбирай фактический toolchain проекта: repository scripts, Make tasks, language-native commands или targeted manual inspection. Название Ebb не предписывает `pnpm` иному проекту.

При работе с Ebb ищи в actual manifest `docs:inventory`, `docs:check`, `docs:rename:check`, `docs:link:sync`, `docs:test`. Это discovery hints, не гарантия доступности implementation. Сначала проверь files/scripts и scope; применяй inventory/check/test где доступны. `link:sync` может менять files — прочитай его contract и review diff. Rename gate относится к согласованной relocation через `ebb-repository-maintenance`. Не создавай второй governance tool и не генерируй docs tree ради skill.

## Evidence по claim

| Claim | Минимальная проверка |
|---|---|
| Coverage | Fresh inventory с dispositions; full audit учитывает каждый first-party target/justified missing owner и exclusions. Changed mode показывает affected closure. |
| README facts/examples | Source anchors и actual exports/parser/manifest; focused code or command check доказывает сформулированный behavior. |
| Setup command | Exact cwd/prerequisites, safe isolated execution и exit/output. Static script presence подтверждает лишь наличие команды, не successful runtime setup. |
| Links | Local targets/anchors и относительное разрешение из README; existing link tooling если есть. External links, требующие network/auth, получают отдельно checked/unverified. |
| Env example | Key-to-loader map и isolated safe validation required/default/type/empty/namespace semantics. Simple regex key count не доказывает completeness. |
| Generated result | Template/schema source change, successful regeneration и expected output diff; blocked generator оставляет target unresolved. |
| Minimal safe diff | Fresh changed-file inventory, diff review на unrelated/secret/generated writes, `git diff --check` и `git status --short`, если repository — Git. |

## Safe execution

Изучи side effects commands до запуска. Используй temporary isolated paths, synthetic configuration и existing provider-free tests; отключённые optional providers должны быть подтверждены actual config. Не выполняй deployments, destructive setup, production migrations, network provider calls или secret-dependent actions как docs smoke test. Для непройденной проверки запиши exact command/claim, почему она unsafe/unavailable, static evidence и остаточную неопределённость. Не называй skip PASS.

Отсутствующий actual loader/README/manifest в переданном snapshot — конкретный limitation. Не выдумывай commands, values или успешно пройденный project audit. Разделяй «файл обновлён», «source inspected», «safe command executed» и «runtime behavior unverified».

## Compact handoff

В task evidence передай: режим и observed revision/tree; targets/dispositions; существенные source anchors; commands с cwd/exit/result; coverage/translation gaps; unverified claims и blockers. Этого достаточно для `ebb-quality-gates` и integration caller; не копируй весь проект или секретные данные. Freshness теряется при изменении затронутого source/tree — перепроверь соответствующий claim.

Для обычной implementation-задачи setup/API/config/commands changes вызывают этот owner на affected closure. Для finish/release это prerequisite при документационно значимых изменениях, а не повод запускать полный аудит при каждом task. Общие mandatory integration gates остаются у `ebb-quality-gates`; успешный docs check их не заменяет.
