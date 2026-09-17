# План реализации Git, Execution и Security Orchestrator

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ SUB-SKILL: Использовать superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans для реализации этого плана по задачам. Для отслеживания шаги используют синтаксис флажков (`- [ ]`).

**Цель:** Добавить реальные Git/worktree operations, controlled execution, Permission Engine и security boundaries так, чтобы deterministic workflow мог безопасно работать с локальным repository без Hermes.

**Архитектура:** Git Manager и Local Execution являются adapters за typed services. Любое действие агента в будущем проходит `RunCapability → ActionGateway → PermissionEngine → controlled executor`; GitHub credentials и SecretStore не доступны через этот путь.

**Технологический стек:** Node.js 24 `child_process.spawn`; native Git CLI; TypeScript; Vitest; SQLite.

**Спецификация:** `docs/superpowers/specs/2026-09-16-ebb-orchestrator-design.md`

## Глобальные ограничения

- Никогда не выполнять Git/command через `shell: true` по умолчанию.
- Worktree path всегда назначается Orchestrator, не передаётся агентом.
- `master` — ветвь fixture по умолчанию, но production branch берётся из конфигурации Project.
- Final merge выполняется только Merge Service после approval.
- Git hooks отключены для managed Git operations по умолчанию.
- Local Mode — изоляция policy, а не OS sandbox; это должно быть отражено в API/UI metadata.
- Plan 2 уже должен быть слит в текущую base, а исходное дерево должно пройти `pnpm lint`, `pnpm typecheck` и `pnpm test`.
- Действия Git/filesystem/command для agent-facing проходят через Action Gateway; детерминированные core services Orchestrator могут напрямую использовать внутренние Git services.
- Reconciliation не должна выполнять неявный доступ к сети (`git fetch`, push, remote auth). Remote state означает известные на данный момент remote-tracking refs, пока явная hosting/sync operation не обновит их.

---

### Задача 1: Безопасный process executor и Git command adapter

****Файлы:****
- Создать: `apps/server/src/platform/process/process-executor.ts`
- Создать: `apps/server/src/modules/git/git-cli.ts`
- Тест: `apps/server/test/modules/git/git-cli.test.ts`

****Интерфейсы:****
- Создаёт: `ProcessExecutor.exec(file, args, options)`.
- Создаёт: `GitCli.run(repoPath, args)` с `shell:false`, timeout и захватом stdout/stderr.

- [ ] **Шаг 1: Написать тесты безопасности executor**

Напрямую протестировать `ProcessExecutor` с безопасным fixture process и literal argument, содержащим shell metacharacters; проверить, что аргумент достигает child без изменений и побочная command/file не выполняется.

Также покрыть timeout, cancellation через `AbortSignal`, захват ненулевого exit и ограниченное поведение stdout/stderr. Тесты `GitCli` должны доказать делегирование через `shell:false`.

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- git-cli.test.ts
```

- [ ] **Шаг 3: Реализовать executor**

Использовать `spawn(file, args, { shell: false, cwd, env, windowsHide: true })`, ограниченные буферы вывода и явную cancellation через `AbortSignal`.

- [ ] **Шаг 4: Запустить тесты на текущей платформе**

```bash
pnpm --filter @ebb-orchestrator/server test -- git-cli.test.ts
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/platform/process/process-executor.ts apps/server/src/modules/git/git-cli.ts apps/server/test/modules/git
git commit -m "feat: add safe process and git executor"
```

---

### Задача 2: Discovery репозитория и onboarding facts

****Файлы:****
- Создать: `apps/server/src/modules/projects/repository-discovery.ts`
- Создать: `apps/server/src/modules/projects/onboarding-service.ts`
- Тест: `apps/server/test/modules/projects/repository-discovery.test.ts`

****Интерфейсы:****
- Создаёт: `RepositoryFacts { root, defaultBranch, remotes, packageManager, languageHints, testCommands }`.
- Создаёт: обнаруженные facts отдельно от предлагаемых policy fields.

- [ ] **Шаг 1: Написать тест discovery на fixture**

Создать временный repo с `master`, `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, GitHub remote. Проверить, что все они имеют статус DETECTED, а рекомендации workflow/permission отсутствуют в facts.

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- repository-discovery.test.ts
```

- [ ] **Шаг 3: Реализовать deterministic discovery**

Использовать только Git commands и filesystem checks. Не запускать package scripts. Существующий `.orchestrator/` помечается как `untrustedExistingConfig` до явного approval импорта.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- repository-discovery.test.ts
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/projects apps/server/test/modules/projects
git commit -m "feat: add deterministic repository discovery"
```

---

### Задача 3: Менеджер branch/worktree и журнал GitOperation

****Файлы:****
- Создать: `apps/server/src/modules/git/git-types.ts`
- Создать: `apps/server/src/modules/git/git-operation-repository.ts`
- Создать: `apps/server/src/modules/git/worktree-manager.ts`
- Создать: `apps/server/src/modules/git/branch-manager.ts`
- Создать: `apps/server/src/platform/database/migrations/007_git.sql`
- Тест: `apps/server/test/modules/git/worktree-manager.test.ts`

****Интерфейсы:****
- Создаёт: `createTaskWorkspace(task, targetRef)`, `createEpicBranch(epic, baseRef)`, `removeWorkspace(worktreeId)`.
- Persists GitOperation `STARTED → VERIFIED`.
- Migration `007_git.sql` также создаёт persistence для first-class records `MergeConflict`, используемых в Задача 4.

- [ ] **Шаг 1: Написать тесты на реальном временном репозитории**

Проверить:

```text
standalone task branches from current master
Epic child branches from current epic branch
managed worktree appears outside source repo in ORCHESTRATOR_HOME/worktrees
failed verification leaves GitOperation STARTED for reconciliation
```

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- worktree-manager.test.ts
```

- [ ] **Шаг 3: Реализовать журналируемые операции**

Перед изменением Git вставить строку операции; после команды проверить фактическое состояние Git и только затем пометить её как `VERIFIED`.

Отключать hooks repository для каждого managed Git invocation (например, через `git -c core.hooksPath=<managed-empty-hooks-dir> ...`), а не навсегда переписывать config repository пользователя. Добавить fixture hook, который создаёт marker file, и доказать, что managed commit/worktree operations его не выполняют.

После сбоя повторные попытки должны согласовать существующую операцию STARTED, а не вслепую создавать дублирующиеся branches/worktrees.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- worktree-manager.test.ts
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/git apps/server/src/platform/database/migrations/007_git.sql apps/server/test/modules/git
git commit -m "feat: add managed branches and worktrees"
```

---

### Задача 4: Integration workspace, merge с текущей целью и Merge Service

****Файлы:****
- Создать: `apps/server/src/modules/git/integration-service.ts`
- Создать: `apps/server/src/modules/git/merge-service.ts`
- Создать: `apps/server/src/modules/git/merge-conflict-repository.ts`
- Тест: `apps/server/test/modules/git/integration-service.test.ts`
- Тест: `apps/server/test/modules/git/merge-service.test.ts`

****Интерфейсы:****
- Создаёт: `prepareIntegration(sourceBranch, currentTargetBranch): IntegrationAttempt`.
- Создаёт: `MergeService.mergeApproved(subjectId, approvalId)`.

- [ ] **Шаг 1: Написать тест moving-target**

Создать Task-2 из Epic SHA A, интегрировать Task-1, чтобы Epic стал B, затем подготовить интеграцию Task-2. Проверить, что базой интеграции является B, а не A.

Также проверить Проверить, что MergeService отказывает, если approval отсутствует, отклонён, имеет неправильный тип или относится к другому Task/Epic. Одобренный `FINAL_MERGE` действителен только для точного subject, который сливается.

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- integration-service.test.ts merge-service.test.ts
```

- [ ] **Шаг 3: Реализовать integration branch/worktree**

Использовать временные branch/worktree интеграции, принадлежащие integration attempt. Никогда не экспериментировать в worktree Задача или `master`.

Сохранять каждый merge conflict как first-class record с source, target, files, status и nullable/pending classification. Детерминированная классификация может разрешать только доказуемые случаи; семантическая классификация остаётся для последующей роли Integration.

`MergeService.mergeApproved(subjectId, approvalId)` должен сам загрузить approval и проверить: `type=FINAL_MERGE`, `status=APPROVED`, и `subjectId` совпадает точно. После merge он проверяет итоговый target SHA перед записью завершения.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- integration-service.test.ts merge-service.test.ts
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/git apps/server/test/modules/git
git commit -m "feat: add isolated integration and merge service"
```

---

### Задача 5: Permission Engine и композиция policy

****Файлы:****
- Создать: `apps/server/src/modules/permissions/permission-types.ts`
- Создать: `apps/server/src/modules/permissions/permission-policy.ts`
- Создать: `apps/server/src/modules/permissions/permission-engine.ts`
- Тест: `apps/server/test/modules/permissions/permission-engine.test.ts`

****Интерфейсы:****
- Создаёт: `PermissionDecision = ALLOW | ASK | DENY | ABSOLUTE_DENY`.
- Создаёт типизированный/канонический набор `ActionId`, общий для Permission Engine и Action Gateway (включая actions workspace, Git, command, merge и mutation permission/config).
- Создаёт: `evaluate({ capability, action, globalPolicy, projectPolicy, rolePolicy, taskPolicy })`.

- [ ] **Шаг 1: Написать табличные тесты**

Как минимум:

```text
Developer workspace.read ALLOW
Developer git.commit ALLOW
Developer git.push DENY
Developer merge.default ABSOLUTE_DENY
Developer permission.modify ABSOLUTE_DENY
Developer config.security.modify ABSOLUTE_DENY
Reviewer workspace.write DENY
DevOps publish ASK
Global DENY + Task ALLOW => DENY
ABSOLUTE_DENY cannot be weakened by more specific scope
```

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- permission-engine.test.ts
```

- [ ] **Шаг 3: Реализовать композицию с наиболее строгим правилом**

Encode ordering:

```ts
const rank = { ALLOW: 0, ASK: 1, DENY: 2, ABSOLUTE_DENY: 3 } as const;
```

Возвращать reason и matched policy refs для UI/Audit. Неизвестные/незарегистрированные Action IDs должны завершаться отказом, а не молча получать значение ALLOW.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- permission-engine.test.ts
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/permissions apps/server/test/modules/permissions
git commit -m "feat: add composable permission engine"
```

---

### Задача 6: RunCapability и Action Gateway с ограничением путей

****Файлы:****
- Создать: `apps/server/src/modules/execution/run-capability.ts`
- Создать: `apps/server/src/modules/execution/action-gateway.ts`
- Создать: `apps/server/src/modules/execution/workspace-tools.ts`
- Создать: `apps/server/src/modules/execution/git-tools.ts`
- Создать: `apps/server/src/platform/security/path-resolver.ts`
- Тест: `apps/server/test/modules/execution/action-gateway.test.ts`
- Тест: `apps/server/test/modules/execution/git-tools.test.ts`
- Тест: `apps/server/test/platform/security/path-resolver.test.ts`

****Интерфейсы:****
- Создаёт: capability-bound `workspace.read/search/patch`.
- Создаёт agent-facing `git.status`, `git.diff` и `git.commit`, всегда ограниченные worktree, назначенным capability.
- `git.push`, final merge, permission mutation и security/config mutation запрещены/не предоставляются capability Developer.
- Запрос agent-facing никогда не принимает произвольный workspace root.

- [ ] **Шаг 1: Написать тесты traversal и symlink/junction**

Проверить, что `../`, абсолютный внешний путь и platform-appropriate link escape отклоняются до доступа к файлам: directory junction на Windows, symlink на Unix. Тесты не должны требовать Windows Developer Mode только для создания symlink.

Также проверить, что agent-facing Git requests не могут передать другой repository/worktree path и что Developer не может выполнить push/final merge/policy mutation через Action Gateway.

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- action-gateway.test.ts git-tools.test.ts path-resolver.test.ts
```

- [ ] **Шаг 3: Реализовать каноническую проверку containment**

Разрешить realpaths существующих предков и target path; сравнивать сегменты пути, а не строковый prefix. Аудировать каждый DENY/ASK без хранения содержимого файлов.

`git.status/diff/commit` определяют repository из `RunCapability`, а не из model input, и используют внутренний Git adapter с отключёнными managed hooks.

- [ ] **Шаг 4: Запустить переносимые security-тесты на текущей платформе**

```bash
pnpm --filter @ebb-orchestrator/server test -- action-gateway.test.ts git-tools.test.ts path-resolver.test.ts
```

Набор должен содержать ветви для Windows junction и Unix symlink, чтобы те же тесты проверяли подходящую реализацию после добавления CI для другой ОС. Отсутствие Unix CI в Plan 3 не должно блокировать локальное завершение; CI Plan 6 должен запускать этот набор как минимум на Windows и одном Unix runner до релиза v1.

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/execution apps/server/src/platform/security apps/server/test/modules/execution apps/server/test/platform/security
git commit -m "feat: add capability-bound action gateway"
```

---

### Задача 7: Контролируемые command/project actions и изоляция окружения

****Файлы:****
- Создать: `apps/server/src/modules/execution/command-tools.ts`
- Создать: `apps/server/src/modules/execution/project-actions.ts`
- Создать: `apps/server/src/platform/security/environment-builder.ts`
- Тест: `apps/server/test/modules/execution/command-tools.test.ts`
- Тест: `apps/server/test/platform/security/environment-builder.test.ts`

****Интерфейсы:****
- Создаёт: `command.exec({ executable, args })`; без raw shell syntax.
- Создаёт: типизированное отображение `project.test/lint/typecheck/build` из approved project config.

- [ ] **Шаг 1: Написать тест утечки окружения**

Задать в env родительского процесса `TEST_SECRET_SUPER_UNIQUE_123`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`; проверить, что env дочернего процесса не содержит их, если не настроена конкретная scoped injection.

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- command-tools.test.ts environment-builder.test.ts
```

- [ ] **Шаг 3: Реализовать минимального allowlisted env и классификации shell**

Собирать окружения дочерних процессов из небольшого platform baseline/allowlist плюс явно scoped injected variables; не клонировать `process.env` с последующей блокировкой нескольких известных имён. Сохранять только переменные, необходимые для поиска/запуска одобренных executables на текущей платформе (например, PATH и требуемые Windows runtime variables), плюс явные scoped additions.

Рассматривать executables `bash`, `sh`, `zsh`, `cmd`, `powershell`, `pwsh` как `SHELL_EXECUTION`, требующие отдельного разрешения. Известные project actions известны policy, но не являются автоматически безопасными.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- command-tools.test.ts environment-builder.test.ts
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/execution apps/server/src/platform/security apps/server/test/modules/execution apps/server/test/platform/security
git commit -m "feat: add controlled local command execution"
```

---

### Задача 8: Git reconciliation, drift-состояния и восстановление при запуске

****Файлы:****
- Создать: `apps/server/src/modules/git/git-reconciler.ts`
- Изменить: `apps/server/src/platform/process/startup-reconciler.ts`
- Тест: `apps/server/test/modules/git/git-reconciler.test.ts`

****Интерфейсы:****
- Создаёт: `IN_SYNC | LOCAL_AHEAD | REMOTE_AHEAD | DIVERGED | BRANCH_MISSING | WORKTREE_MISSING | UNCOMMITTED_CHANGES`.

- [ ] **Шаг 1: Написать тесты drift/restart**

Создать незавершённую `GitOperation`, вручную изменить HEAD/удалить worktree, перезапустить reconciler и проверить, что наблюдаемое состояние записано без слепого изменения Git.

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- git-reconciler.test.ts
```

- [ ] **Шаг 3: Реализовать reconciliation**

Recovery может завершить операцию только если фактическое состояние Git подтверждает выполнение требуемого эффекта. Неоднозначное состояние создаёт `GIT_STATE_DRIFT` и блокирует соответствующую работу.

Reconciliation выполняется только локально: может проверять существующие remote-tracking refs, но не должна неявно выполнять `fetch`, push, authenticate или обращаться к remote. Внешнее обновление относится к последующей подсистеме GitHosting/Sync.

- [ ] **Шаг 4: Запустить pre-commit проверки качества**

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Перед коммитом Задача 8 все три команды должны завершиться успешно.

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/git apps/server/src/platform/process/startup-reconciler.ts apps/server/test/modules/git
git commit -m "feat: reconcile git state after interruptions"
```

- [ ] **Шаг 6: Запустить финальную проверку чистого дерева**

```bash
pnpm lint
pnpm typecheck
pnpm test
git status --short
```

Все команды проверки качества должны завершиться успешно, а `git status --short` должен быть пустым. Сгенерированные artifacts `.js`/`.tsbuildinfo` недопустимы.

## Plan 3 критерии приёмки

Перед объявлением Plan 3 завершённым:

```bash
pnpm lint
pnpm typecheck
pnpm test
git status --short
```

Все команды проверки качества должны завершиться успешно, а working tree должен быть чистым.

Используя временный repository с `master`:

- создать branches и worktrees Epic/Задача из правильных текущих целей;
- доказать, что управляемые Git operations по умолчанию не выполняют hooks repository;
- выполнять действия **agent-facing** с filesystem, Git (`status/diff/commit`) и commands только через Action Gateway;
- запрещать выход за пределы путей и внедрение alternate worktree;
- запрещать raw final merge, push, изменение permissions и security/config policy для capability Developer;
- сохранять конфликты слияния как first-class records;
- final Merge Service отказывает при absent/rejected/wrong-subject/wrong-type approvals и успешно выполняется только с соответствующим approved `FINAL_MERGE`;
- сбой между изменением Git и проверкой БД можно восстановить без дублирующихся branches/worktrees;
- reconciliation никогда не выполняет неявный доступ к сети;
- построение окружения основано на allowlist и не раскрывает secrets родительского процесса/возможности SSH-agent;
- вредоносный текст/scripts repository не предоставляют полномочий; предупреждение Local Mode остаётся актуальным, поскольку произвольные одобренные project processes всё ещё имеют привилегии OS-пользователя.

Перед началом Plan 4, ожидаемый инструмент `git.diff` уже должен быть реализован этим планом через Action Gateway.
