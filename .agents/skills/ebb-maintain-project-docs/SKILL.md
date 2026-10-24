---
name: ebb-maintain-project-docs
description: Используй, когда нужно создать, актуализировать или проверить first-party README и .env.example, либо изменение setup, команд, API или конфигурации затрагивает эти файлы.
metadata:
  project: "ebb-orchestrator"
  version: "1.0.0"
---

# Ebb Maintain Project Docs

Владелец **содержания** README и `.env.example` во всём first-party проекте. Работай автономно в разрешённом scope, опираясь на текущие code/manifests/config loaders. Метод применим к разным языкам и типам проектов; название Ebb не задаёт команды целевого проекта.

1. Используй актуальный brief из `ebb-repository-context`, применимые `AGENTS.md`, file scopes и защищённые pre-existing changes. Уже доказанные facts переиспользуй; дополнительное чтение ограничивай пробелами.
2. Выбери режим: **changed-scope sync** — обычная задача, только затронутые owners и consumers; **full audit** — явный запрос аудита всех first-party README/examples. Построй ownership map по [scope mapping](references/scope-mapping.md), включая multilingual variants, существующие examples и missing files обоснованных owners.
3. Для каждого README свяжи claims, links, команды и examples с актуальным source. Root описывает проект; nested README — свой package/service/folder. Применяй [README recipe](references/readme-recipe.md), сохраняя точные applicable instructions. Уже точный файл получает `unchanged`, а не rewrite.
4. Для каждого config owner синхронизируй `.env.example` по [env sync](references/env-sync.md): required/default/type, режимы, file loading и namespace. Настоящие `.env`, credentials и secrets не читай. Не меняй config behavior, чтобы оправдать написанную документацию.
5. Generated README/example обновляй через canonical template/schema/generator и regeneration. Если это невозможно в разрешённом scope, зафиксируй blocker; hand-edit output не заменяет source. Rename/move/delete/cleanup, documentation restructuring и command-tooling changes маршрутизируй в `ebb-repository-maintenance`; этот skill их не присваивает.
6. Сделай минимальные содержательные edits и выполни [verification](references/verification.md). Выбирай существующие repository checks по реальному manifest/implementation; не создавай дублирующий docs tool. Unsafe/external/secret-dependent проверки пропускай с точным `unverified` evidence.
7. Передай compact evidence в `ebb-quality-gates` и текущий implementation/finish/release flow: режим, coverage/dispositions, source anchors, executed checks/results, unverified claims и blockers. Не объявляй «все docs актуальны» по changed-scope sync. Отсутствие project files означает отсутствие project audit, а не PASS.

Language follows local policy: для Ebb по умолчанию русский; сохраняй существующие языковые варианты. В README не добавляй numeric filename prefix или служебный metadata header. Не описывай roadmap/proposal как существующую возможность.
