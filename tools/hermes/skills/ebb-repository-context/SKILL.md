---
name: ebb-repository-context
description: Используй, когда начинается новая работа в Ebb Orchestrator и нужно определить применимые инструкции, Git/worktree state, scope, authority sources и обязательные gates.
metadata:
  project: "ebb-orchestrator"
  version: "4.0.0"
---

# Ebb Repository Context

Сформируй компактный Context Brief для планирования, реализации или делегирования. Это bootstrap-контекст, а не повод каждому агенту перечитывать весь репозиторий.

## Процедура

1. Зафиксируй repository root, worktree, branch, HEAD и `git status --short`; отдельно перечисли pre-existing/unrelated changes и не присваивай их текущей задаче.
2. Определи применимые authority sources: root/scoped `AGENTS.md`, `.hermes.md`, approved design/spec, implementation plan, governance docs, package/workspace manifests и README только затронутого scope. Зафиксируй порядок приоритета.
3. Перед созданием нового plan/doc/test/config/script посмотри соседние существующие артефакты и их naming/location conventions. Project conventions имеют приоритет над generic defaults внешних skills.
4. Составь brief: цель, in-scope/out-of-scope, load-bearing contracts, релевантные paths/symbols, зависимости, обязательные gates, известные ограничения и источник каждого существенного решения.
5. Для делегирования передавай leaf-agent только этот brief, точные нужные файлы/выдержки и artifact paths для больших результатов. Не пересылай историю сессии целиком.
6. Если требования, код и утверждённый plan расходятся, зафиксируй evidence и ruling/blocker до изменения scope.

Не запускай scout ради простого `git status`, одного поиска или короткого файла. Делегируй независимое исследование, когда оно реально уменьшает контекст координатора или может выполняться параллельно без общего mutable scope.
