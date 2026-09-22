---
name: ebb-provider-integration
description: Добавление/проверка провайдера AI (OpenAI-compatible) для Ebb Orchestrator: endpoint, алиасы моделей, URL, ключи, профили Hermes.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, provider, hermes]
---

# Ebb Provider Integration

Сначала сверяй provider contract по официальной документации и Context7. В Git
храни только endpoint, model alias и имя env key; никогда не храни API key и не
печатай его значение. Разделяй development profile Hermes и production
`AgentRuntime` profile. Проверяй unsupported provider, malformed URL, отсутствие
ключа и redacted diagnostics. Не превращай новый provider в неявный fallback.
