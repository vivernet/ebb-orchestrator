---
kind: audit
title: Audit Guidelines
date: 2026-09-23
---

Проведи максимально глубокий и строгий финальный аудит текущего проекта: исходного кода, архитектуры, интеграций, persistence-слоя, runtime-поведения, тестов, конфигурации, документации и фактической возможности запустить систему.

Твоя задача — не просто написать review-отчёт. Ты должен самостоятельно исследовать проект, воспроизвести реальные проблемы, исправить подтверждённые дефекты и довести проект до максимально целостного, корректного и проверенного состояния.

## Главный принцип

Не запускай работать одновременно более 2-х субагентов!

Не доверяй тому, что код выглядит правильно, что предыдущие агенты сообщили о PASS, или что отдельные тесты уже проходили.

Проверяй всё по фактическому состоянию текущего checkout.

Источниками истины являются:

1. текущий код;
2. Git history и diff;
3. `AGENTS.md` и другие repository instructions;
4. актуальные specs и implementation plans;
5. migrations и persisted schema;
6. реальные тесты;
7. реальный запуск приложения;
8. фактическое runtime-поведение.

Если документация, план, тесты и реализация противоречат друг другу — установи правильное ожидаемое поведение на основании архитектурных инвариантов и наиболее авторитетной актуальной спецификации. Не маскируй противоречие.

---

# ОБЯЗАТЕЛЬНОЕ ИСПОЛЬЗОВАНИЕ СУБАГЕНТОВ

Не выполняй весь аудит самостоятельно.

Создай несколько (не более 2-х одновременно) независимых субагентов и делегируй им разные направления проверки.

Минимально используй следующие роли:

### 1. Architecture Reviewer
Проверяет:

- соответствие фактической архитектуры specs;
- dependency boundaries;
- единственность authoritative services;
- отсутствие обходных execution paths;
- lifecycle и state-machine invariants;
- scheduler;
- approvals;
- permissions;
- Action Gateway;
- runtime abstraction;
- recovery/reconciliation;
- worker ownership;
- outbox;
- idempotency;
- restart safety;
- Git authority;
- merge/release authority;
- отсутствие нескольких конкурирующих источников истины.

Особенно ищет архитектурные нарушения, которые могут быть незаметны unit-тестам.

### 2. Code Correctness Reviewer
Проверяет:

- неправильную бизнес-логику;
- race conditions;
- ошибки обработки состояний;
- некорректные assumptions;
- unreachable/dead code;
- неиспользуемые abstractions;
- плохую обработку ошибок;
- unsafe fallback;
- silent failure;
- неправильные default values;
- TypeScript correctness;
- API contracts;
- неправильную композицию зависимостей.

### 3. Persistence / Migration / Recovery Reviewer
Проверяет:

- все migrations;
- upgrade-path существующей базы;
- bootstrap новой базы;
- migration ordering;
- schema constraints;
- transaction boundaries;
- atomic state + outbox + audit;
- restart reconciliation;
- stale reservations/locks;
- ownership;
- duplicate execution;
- partial failure;
- crash recovery;
- rollback/fail-closed semantics;
- migration compatibility и integrity.

Особенно проверяет сценарии с уже существующими данными, а не только создание новой БД с нуля.

### 4. Test & Runtime Reviewer
Должен реально попытаться:

- установить зависимости;
- собрать проект;
- запустить приложение;
- выполнить предусмотренный startup flow;
- выполнить smoke tests;
- выполнить unit tests;
- integration tests;
- e2e tests;
- тесты отдельных packages;
- проверить shutdown/restart там, где это возможно.

Он не должен ограничиваться чтением тестового кода.

### 5. Security Reviewer
Проверяет:

- permissions;
- authentication/authorization;
- privilege boundaries;
- command execution;
- shell invocation;
- path traversal;
- unsafe filesystem operations;
- Git operations;
- secret handling;
- API validation;
- unsafe input propagation;
- SQL safety;
- process spawning;
- внешние интеграции;
- fail-open поведение.

### 6. Quality / Maintainability Reviewer
Проверяет:

- чрезмерно сложный код;
- дублирование;
- слишком большие модули;
- неправильные abstractions;
- ненужные compatibility layers;
- технический долг, реально повышающий вероятность ошибок;
- несогласованность naming/contracts;
- участки, которые можно существенно упростить без изменения поведения.

Не выполняй косметический refactoring ради самого refactoring.

### 7. Integration Reviewer
Проверяет систему целиком:

- согласованность компонентов;
- end-to-end flows;
- реальные composition roots;
- wiring;
- startup;
- shutdown;
- error propagation;
- API → domain → scheduler → runtime → persistence → recovery;
- Epic/Task lifecycle;
- final merge/release flow.

---

# ЭТАП 1 — ИССЛЕДОВАНИЕ БЕЗ ИЗМЕНЕНИЙ

Сначала запрещено изменять код.

Основной агент и субагенты должны независимо исследовать проект.

Изучи как минимум:

- repository instructions;
- `AGENTS.md`;
- specs;
- implementation plans;
- package scripts;
- workspace configuration;
- application entrypoints;
- composition roots;
- database layer;
- migrations;
- scheduler;
- workflow engine;
- runtime;
- approvals;
- permissions;
- Action Gateway;
- Git services;
- merge services;
- recovery/reconciliation;
- outbox/workers;
- HTTP/API layer;
- tests;
- CI configuration;
- README и эксплуатационную документацию.

Посмотри Git history и недавние изменения там, где это помогает понять архитектурные решения.

Не делай вывод о корректности только потому, что присутствует тест с подходящим названием.

---

# ЭТАП 2 — ФАКТИЧЕСКИЙ ЗАПУСК И ПРОВЕРКА

Определи реальные canonical команды проекта из `package.json`, workspace configuration, README и CI.

После этого реально выполни доступные проверки.

Минимально должны быть выполнены эквиваленты:

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
git diff --check
git status --short
```

Если в проекте существуют отдельные:

- build;
- integration;
- e2e;
- migration;
- security;
- smoke;
- server;
- web;
- package-level test scripts,

выполни их тоже.

Не предполагая название команды, сначала изучи scripts и используй реально существующие команды проекта.

Обязательно попытайся **реально собрать и запустить проект**.

Недостаточно увидеть, что unit-тесты проходят.

Проверь:

1. application startup;
2. создание/открытие базы;
3. migrations;
4. startup reconciliation;
5. инициализацию сервисов;
6. worker startup;
7. HTTP/API startup, если он является частью проекта;
8. graceful shutdown;
9. отсутствие непосредственных startup exceptions.

Если полноценный runtime требует внешних credentials или сервисов, выполни максимально полный локальный запуск без них и чётко отдели:

- подтверждённые ошибки проекта;
- ограничения текущей среды;
- непроверенные внешние зависимости.

Не объявляй PASS для того, что фактически не удалось проверить.

---

# ЭТАП 3 — СОБЕРИ ЕДИНЫЙ РЕЕСТР ПРОБЛЕМ

После завершения независимых проверок собери находки всех субагентов.

Для каждой потенциальной проблемы установи:

- severity;
- точный файл;
- строки или symbol;
- фактическое доказательство;
- reproduction, если возможно;
- нарушенный invariant/spec;
- реальное влияние;
- root cause;
- является ли finding дубликатом другой проблемы.

Классифицируй находки:

- CRITICAL;
- HIGH;
- MEDIUM;
- LOW;
- FALSE POSITIVE;
- DOCUMENTATION / FOLLOW-UP.

Не исправляй speculative findings без доказательств.

При конфликте выводов двух субагентов основной агент обязан самостоятельно проверить доказательства и определить фактическое состояние.

---

# ЭТАП 4 — ИСПРАВЛЕНИЕ ROOT CAUSES

После консолидации находок исправь все подтверждённые проблемы, которые относятся к корректности, архитектуре, безопасности, reliability, persistence, recovery, integration или существенной maintainability.

Не ограничивайся минимальным patch поверх симптома.

Исправляй root cause.

Перед исправлением каждого дефекта:

1. воспроизведи проблему либо докажи её статически;
2. добавь или обнови regression test, если проблема тестируема;
3. убедись, что test до исправления действительно выявляет проблему, когда это практически возможно;
4. внеси минимальное архитектурно правильное исправление;
5. запусти focused tests;
6. только затем переходи дальше.

Не ослабляй существующие проверки.

Запрещено исправлять failures следующими способами без объективного основания:

- удалением тестов;
- `.skip`;
- `.only`;
- ослаблением assertions;
- отключением lint rules;
- ухудшением TypeScript strictness;
- подавлением ошибок;
- catch-and-ignore;
- fake success;
- hardcoded test-specific branches;
- обходом security checks;
- созданием второго authoritative execution path;
- отключением validation;
- удалением fail-closed поведения.

---

# КОНФЛИКТЫ И ПРОТИВОРЕЧИЯ

Разреши найденные:

- Git conflicts;
- architectural conflicts;
- incompatible interfaces;
- duplicated authorities;
- conflicting ownership;
- несовместимые assumptions;
- schema/code inconsistencies;
- test/spec inconsistencies;
- startup/runtime inconsistencies.

Не выбирай случайно одну сторону конфликта.

Сначала установи правильный архитектурный invariant, затем приведи код, тесты и документацию к единому согласованному состоянию.

Не изменяй исторические migrations, которые уже должны считаться immutable, если это не является явно допустимым правилом проекта. Для исправлений используй новые forward migrations.

---

# ОПТИМИЗАЦИЯ

После исправления correctness-проблем выполни отдельный проход по оптимизации.

Оптимизируй только там, где есть фактическая причина:

- ненужная сложность;
- дублирование;
- очевидно лишние запросы;
- неправильная lifecycle ownership;
- неоправданное создание тяжёлых объектов;
- ненужные последовательные операции;
- чрезмерная coupling;
- плохие module boundaries;
- код, создающий существенный maintenance risk.

Не выполняй speculative micro-optimizations.

Не меняй корректную архитектуру только ради уменьшения количества строк.

Сохраняй существующее публичное поведение, если изменение контракта не требуется для исправления подтверждённой проблемы.

---

# ОСОБЫЕ АРХИТЕКТУРНЫЕ ПРОВЕРКИ

Отдельно проверь следующие свойства.

## Authoritative execution

Для каждой критической операции должен существовать ровно один authoritative path.

Ищи:

- прямые обходы domain services;
- создание дополнительных Scheduler/Runtime/Git authorities;
- duplicate composition;
- fallback instances;
- test-only architecture, случайно попавшую в production.

## Durable execution

Проверь:

- intent persisted before execution;
- state transitions;
- outbox;
- audit;
- retries;
- idempotency;
- crash boundaries;
- recovery after restart.

## Scheduler

Проверь:

- capacity;
- role limits;
- reservations;
- locks;
- owner identity;
- release;
- terminal reclaim;
- stale state;
- fail-closed configuration.

## Git

Проверь:

- source SHA;
- target SHA;
- branch ownership;
- merge verification;
- conflict handling;
- отсутствие фиктивного VERIFIED;
- отсутствие release до фактически подтверждённого merge.

## Epic / Task lifecycle

Проверь реальные positive и negative flows целиком, включая restart boundaries.

## Persistence

Проверь как fresh database, так и upgrade существующей базы.

---

# ЭТАП 5 — ПОВТОРНАЯ ПОЛНАЯ ВЕРИФИКАЦИЯ

Когда исправления закончены, перестань считать результаты предыдущих запусков актуальными.

Запусти проверки заново с текущего HEAD.

Обязательно:

```text
pnpm lint
pnpm typecheck
pnpm test
git diff --check
git status --short
```

Плюс все обнаруженные ранее:

- build;
- e2e;
- integration;
- migrations;
- smoke;
- package-specific suites.

Снова попытайся запустить систему.

Проверь, что исправления не создали новые startup/runtime failures.

---

# ЭТАП 6 — НЕЗАВИСИМЫЙ ФИНАЛЬНЫЙ REVIEW

После всех исправлений создай **нового независимого review-субагента**, который ранее не участвовал в реализации исправлений.

Не сообщай ему, какие участки ты считаешь уже правильными.

Передай ему:

- текущий repository state;
- specs;
- полный diff;
- результаты tests;
- задачу найти load-bearing defects.

Он должен независимо проверить архитектуру и код и попытаться опровергнуть готовность проекта.

Если он находит реальный blocker:

1. воспроизведи/подтверди finding;
2. исправь root cause;
3. добавь regression coverage;
4. повтори необходимые gates;
5. выполни ещё один независимый final review.

Не запускай бесконечный цикл косметических review-fixes. Повторный цикл оправдан только для реальных load-bearing defects.

---

# GIT SAFETY

Работай только в текущей рабочей ветке/worktree.

До начала изменений выполни:

```text
git branch --show-current
git status --short
git log -1 --oneline
```

Не выполняй без явного разрешения пользователя:

- push;
- force push;
- merge в `master`;
- rebase опубликованной истории;
- reset --hard;
- git clean;
- удаление веток;
- удаление worktree;
- создание release/tag.

Не переписывай существующие commits через amend/rebase, если для этого нет отдельного явного требования.

Изменения дели на логические commits с понятными сообщениями.

---

# КРИТЕРИЙ ГОТОВНОСТИ

Нельзя объявлять проект готовым только потому, что тесты зелёные.

Финальный PASS допустим только если одновременно подтверждено:

- архитектурные invariants соблюдаются;
- нет известных load-bearing correctness defects;
- нет известных security blockers;
- migrations корректны;
- fresh bootstrap проверен;
- upgrade path проверен настолько полно, насколько позволяет проект;
- recovery/restart semantics проверены;
- application реально удалось запустить либо точно задокументирована внешняя причина, почему это невозможно;
- build проходит;
- lint проходит;
- typecheck проходит;
- полный test suite проходит;
- integration/e2e проходят, если существуют;
- `git diff --check` проходит;
- рабочее дерево находится в ожидаемом состоянии;
- независимый финальный reviewer не нашёл blocker.

---

# ФИНАЛЬНЫЙ ОТЧЁТ

В конце предоставь компактный, но точный отчёт:

## Verdict

Один из:

```text
PASS
PASS_WITH_LIMITATIONS
CHANGES_REQUIRED
```

## Environment
Что фактически удалось установить, собрать и запустить.

## Verification
Все реально выполненные команды и их результаты.

## Findings
Подтверждённые проблемы, которые были обнаружены.

## Fixes
Что было исправлено и почему.

## Architecture
Ключевые проверенные invariants.

## Tests Added
Какие regression/integration/e2e tests были добавлены.

## Remaining Limitations
Только реальные непроверенные или сознательно отложенные ограничения.

## Git State
Текущая ветка, HEAD и состояние working tree.

## Final Reviewer
Итог независимого финального review.

Не скрывай failures и не заменяй фактическую проверку предположением.

Главная цель — не получить зелёный статус любой ценой, а оставить после себя проект, который действительно согласован архитектурно, запускается, проходит проверки и не содержит известных критичных или load-bearing дефектов.
