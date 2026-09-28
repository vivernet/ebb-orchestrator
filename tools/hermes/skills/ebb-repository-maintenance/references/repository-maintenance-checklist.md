# Repository maintenance checklist

## Inventory and preservation

- Inventory строится из текущего tree, а не исторического plan.
- Pre-existing untracked/user changes помечены immutable и не попадают в cleanup commit.
- Wildcard `dir/**` не заменяет атомарный список, если требуется destructive approval.
- Для local tool-state перед удалением проверь readability/JSON/UTF-8, referenced paths, secret exposure и нужное historical evidence.
- Если evidence нужно сохранить, архивируй вне worktree, сохраняй relative paths + SHA-256 manifest и повторно хэшируй копию.

## Move / rename

- До изменения — полный reference scan.
- После изменения — scan старого path/name; remaining matches классифицированы как intentional historical text или defect.
- Docs/skills/scripts/tests обновляются в том же dependency-ordered plan.

## Command audit

Для каждой затронутой команды запиши:

- owner file/script;
- cwd и prerequisites;
- exact invocation;
- side effects;
- expected exit/output;
- platform assumptions;
- verification command.

Exit 0 placeholder не доказывает реализованную функцию. README не является доказательством behavior без source/command check.

## Completion

- approved disposition совпадает с executed path set;
- no orphan references;
- expected files присутствуют, removed files отсутствуют;
- applicable lint/typecheck/test/build/docs + `git diff --check` выполнены;
- final status не содержит неожиданных changes.
