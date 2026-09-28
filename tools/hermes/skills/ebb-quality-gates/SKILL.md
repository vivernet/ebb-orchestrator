---
name: ebb-quality-gates
description: Используй, когда нужно выбрать и доказательно выполнить проверки качества для изменения Ebb Orchestrator перед task, plan или release-level completion claim.
metadata:
  project: "ebb-orchestrator"
  version: "4.0.0"
---

# Ebb Quality Gates

**Required companion before completion claims:** Superpowers `verification-before-completion`.

1. Определи применимые gates из approved plan, repository policy и changed scope. Начинай с самого узкого доказательства, затем neighboring и обязательные broader gates.
2. Для каждого запуска запиши exact command, cwd, exit code, фактически выбранные files/tests/counts, существенный result и platform/skipped limitations.
3. Типовые gates (`pnpm lint`, `pnpm typecheck`, `pnpm test`, build, docs, E2E/security) применяй только если они существуют и относятся к scope; plan-required gate нельзя заменить «похожей» командой.
4. Заверши diff hygiene: `git diff --check`, unexpected/generated artifacts, secrets/absolute paths, unrelated changes и final `git status --short`.
5. Broader failures классифицируй: regression текущего scope, pre-existing baseline или pending dependency. Последние два требуют evidence и явного ограничения; они не превращаются в зелёный worktree.
6. Если менялся setup/dev script или документация команд, используй `ebb-repository-maintenance` для command/source audit.
7. Completion claim разрешён только после свежего output текущего HEAD. Старый log, intent, частичный subprocess или subagent summary не является PASS.
