---
name: ebb-quality-gates
description: Use when claiming an Ebb implementation, audit, recovery fix, provider integration, or documentation change is complete.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, verification, quality]
---

# Ebb Quality Gates

Сначала выполни gates, относящиеся к изменённой области, затем полный набор:
`pnpm lint`, `pnpm typecheck`, `pnpm test`, обязательные build/E2E/security
checks и `git diff --check`. Записывай фактические команды, exit codes и
ограничения. Не объявляй PASS по намерению, старому отчёту или неполному
подпроцессу; generated artifacts и secrets должны отсутствовать в diff.
