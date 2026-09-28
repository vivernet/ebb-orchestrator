---
name: ebb-dispatch-agents
description: Используй, когда в Ebb Orchestrator есть два или больше независимых research/implementation/review domains и делегирование сократит основной контекст без конфликтов mutable state.
metadata:
  project: "ebb-orchestrator"
  version: "5.0.0"
---

# Ebb Dispatch Agents

Core principle: **один изолированный агент на один независимый problem domain; контроллер получает компактные artifacts/findings, а не историю его рассуждений.**

1. Раздели work на domains и докажи независимость: разные owners/files/state либо read-only исследования без общей mutation dependency.
2. Связанные failures сначала исследуются вместе: fix одной root cause может закрыть остальные.
3. Каждый dispatch получает self-contained brief: goal, exact scope, authoritative inputs, constraints, allowed mutation, commands и output contract. Не передавай полный session transcript.
4. Parallel dispatch допустим только при отсутствии конфликтов mutable files/resources. Shared file/interface получает одного owner; остальные agents возвращают proposals/evidence.
5. Respect runtime/project concurrency policy. При отсутствии отдельного лимита держи mutating concurrency консервативной; read-only scouts можно группировать шире только если это реально экономит время/контекст.
6. Leaf-agent не расширяет scope и не создаёт каскад делегирования без явного разрешения controller contract.
7. После возврата controller проверяет summaries/artifacts, diff overlap и фактические commands/results. Agent claim не является completion evidence.
8. Перед интеграцией всех параллельных изменений запусти совместимые tests/gates на объединённом tree.

Шаблон brief: [references/dispatch-brief.md](references/dispatch-brief.md).
