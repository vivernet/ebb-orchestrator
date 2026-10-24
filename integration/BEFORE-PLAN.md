# Что сделать перед запуском Plan26

Архив — proposals для вашего настоящего репозитория. Он не устанавливает release CLI, Docker support или publisher workflows и не публикует релиз. Подготовка ниже отделяет безопасный initial branch transition от будущей реализации. Синхронный legacy master не нужно держать до первого release; после проверенного перехода master отсутствует. Никогда не удаляйте его по одному старому утверждению о равенстве develop.

## 1. Найдите репозиторий и защитите текущую работу

В Windows PowerShell откройте **существующий main repository**, не linked directory наугад:

```powershell
Set-Location 'C:\путь\к\ebb-orchestrator'
git rev-parse --show-toplevel
git worktree list --porcelain
git status --short
git branch --show-current
node --version
pnpm --version
gh auth status
```

Минимум из supplied manifest: Node >=24.15, pnpm >=12. Git, GitHub CLI и доступ к actual GitHub repository нужны для transition. Для поздних image stages нужны Docker Engine + Buildx и actual approved Docker build support. Native CI требует существующего selfhosted Linux systemd/cgroup-v2 runner с label `ebb-systemd-cgroup-v2`; Windows helper/native tests и Linux/Windows OS keyring scope сохраняются.

Повторите status для каждого worktree, особенно master/develop. Сохраните intended changes отдельным осмысленным commit только в их правильной ветке/задаче; unrelated changes оставьте защищёнными в своём worktree или сделайте проверенную резервную копию без secrets. Решение stash не автоматическое: учитывайте untracked files и секретные .env. Не используйте reset --hard, clean, force removal и не удаляйте repository directory/.git. Не отправляйте tokens, реальные .env или credentials в чат; `gh auth status` достаточно, `gh auth token` не нужен.

## 2. Получите fresh read-only inventory и независимый review

Разрешите агенту scope read-only repository/GitHub preflight и fetch, если ещё не дан. После проверки remote identity (не публикуйте embedded credentials):

```powershell
git fetch origin
git rev-parse origin/develop
git rev-parse origin/master
git log --oneline origin/develop..origin/master
git diff --stat origin/master origin/develop
gh repo view --json nameWithOwner,id,isPrivate,defaultBranchRef
```

Агент фиксирует full SHAs/tree IDs, ref ownership, protected settings, **полный** paginated Release/tag/GHCR inventory и отсутствие уникальных master commits/неинтегрированных данных. Пустая первая страница не является полным inventory. При исходном равенстве master/develop зафиксировать exact равенство. Если после reviewed policy changes develop уже продвинулся, master должен быть доказанным ancestor develop с сохранённой историей/данными и без unique commits; SHA equality искусственно восстанавливать нельзя. Divergence/существующие release snapshots требуют другого transition design и блокируют удаление.

Проверить main+linked worktrees и local branches: чистые intended changes, master не содержит незакоммиченной/неинтегрированной работы, GitHub repo действительно выбран верно. Независимый reviewer проверяет proposed deletion inventory, proof сохранения и permissions. Read-only Task0 Plan26 можно выполнить уже здесь; он не требует будущего release CLI.

## 3. Согласуйте settings отдельно и освободите master checkout

Агент показывает конкретный settings bundle: repository ID, default develop, squash integration и required checks на develop, master namespace ruleset для future absent branch, точные candidate/workflow permissions позже. Не давайте broad release/rollback permission заранее. Для удаления legacy master отдельно требуется narrow разрешённый способ удаления в существующих protections; отказ сервера — BLOCKED, никаких скрытых отключений/bypass.

После согласования переведите GitHub default branch на develop через repository Settings или конкретную reviewed команду:

```powershell
gh repo edit --default-branch develop
gh repo view --json id,nameWithOwner,defaultBranchRef
```

Агент проверяет readback и required checks; не hardcode check names до real workflow inspection. Сначала смена default, потом удаление master. Если master checkout занят main worktree, после clean/synced proof используйте новую одобренную обычную branch от pinned origin/develop:

```powershell
git switch --create chore/plan26 origin/develop
git status --short
git worktree list --porcelain
```

`chore/plan26` — конкретное предлагаемое имя: если оно уже существует, остановиться и выбрать отдельное имя после проверки, не перезаписывать ветку. Если develop уже checkout в linked worktree, **не** выполняйте `git switch develop` в main. Main worktree может продолжать хранить .git и быть checkout task branch, а linked worktree — develop. Не удаляйте main directory ради освобождения master. Other master worktrees требуют такого же safe disposition; чужую рабочую ветку не переносить.

## 4. Отдельное final confirmation на initial legacy retirement

До удаления агент повторно читает authoritative refs/default/inventory и показывает exact repository/ref/master SHA, develop SHA/ancestry proof, отсутствие releases/уникальной master работы, worktree status, protection rights и consequence: master отсутствует до первого approved publication. Только после вашего **конкретного подтверждения этого удаления** возможна one-off native Git CAS операция. Будущие Plan26 modules/workflows для неё не нужны; это не release/rollback.

Пример формы команды, которую агент обязан заполнить из verified fresh evidence, а не копировать вслепую:

```powershell
# Только после exact approval. Значение — полный проверенный SHA legacy master.
$legacyMasterSha = 'ЗДЕСЬ_ПОЛНЫЙ_ПРОВЕРЕННЫЙ_SHA'
git push --atomic --force-with-lease="refs/heads/master:$legacyMasterSha" origin ':refs/heads/master'
```

CAS lease здесь ограничен **удалением одного заранее одобренного legacy ref** и не разрешает произвольный force push. Нельзя менять SHA после approval. Drift/unsupported atomic/protection refusal — stop, fresh review, никаких -f/admin toggles. Перед исполнением агент проверяет capabilities и exact refspec. Удаление local master не обязательно; оно возможно только после сохранения его commits и отдельной проверки, не вместо remote transition.

Проверка после успешного удаления:

```powershell
git ls-remote --heads origin master
git ls-remote --heads origin develop
gh repo view --json id,nameWithOwner,defaultBranchRef
git status --short
git worktree list --porcelain
```

Первая команда должна не возвращать master ref; default develop и его expected SHA/data должны сохраниться. При partial/unknown response сначала read-only reconciliation, не повторять destructive push наугад. Независимый reviewer проверяет postconditions. Transition выполняется сейчас после proofs/approval либо в early Task1 после Task0; **не ждёт реализации release tooling или первого релиза**.

## 5. Примените proposals и запустите план

Сравните bundle proposals с текущими файлами, merge только целевые hunks; не заменяйте current AGENTS/skills/workflows целиком поверх чужих изменений. Новый `ebb-release` и docs owner добавляются как целые новые dirs, existing skills — по diffs. `package.json` из source не устанавливается; executor изменит scripts после inspection. `README.md` в корне архива объясняет пакет и **не заменяет project README**.

Теперь попросите агента выполнить native skill invocation в Codex:

```text
$ebb-review-plan Проверь docs/architecture/plans/26-branch-and-release-policy.md по настоящему repository source и preflight ledger; master после transition должен отсутствовать.
$ebb-execute-plan Выполни утверждённый Plan26 только task subagents; не более двух subagents всех roles одновременно, independent review обязателен. Начни с Task0, переиспользуй verified preflight, отмечай Docker/runner/provider blockers. Публичные release operations сейчас не разрешены.
```

`$skill-name` — native Codex skill syntax, не существующая repository slash command. На другой платформе используйте её механизм подключения project skills, явно назвав `ebb-review-plan`/`ebb-execute-plan`; не выдумывайте `/ebb-release`. После implementation ручной вызов release skill будет отдельным действием с выбранной версией, reservation, full exact-SHA gates и final concrete confirmation. Пока tool prerequisites не реализованы, release BLOCKED.
