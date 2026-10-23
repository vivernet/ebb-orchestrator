---
id: proposal-09
kind: proposal
title: Reuse the configured Hermes provider for Orchestrator Runs
status: superseded
created: 2026-10-01
updated: 2026-10-23
superseded_by: proposal-18
accepted: 2026-10-10
---

# Proposal 09: Reuse the configured Hermes provider for Orchestrator Runs

**Superseded (2026-10-23):** Решение пользователя (2026-10-23) переносит владение настройкой ИИ-провайдеров и моделей для Orchestrator Runs в Ebb (Proposal 18, `accepted`). Ebb хранит реестр built-in провайдеров/моделей Hermes, хранит API-ключи в `EBB_ORCHESTRATOR_HOME/.env` и передаёт выбор при запуске через `hermes chat … --provider -m --oneshot --ignore-user-config` + env-переменную провайдера. Обязательства «не читать/не копировать/не менять пользовательские Hermes credentials и профиль» сохраняются. Данный документ остаётся исторической записью принятого ранее контракта.

## Contract for v1

- Hermes remains the owner of provider configuration and authentication. Ebb must not ask the user to configure Hermes again, add a duplicate provider/credential in Ebb, read or copy credentials, or change the user's Hermes configuration.
- Each Hermes invocation uses the existing user-configured Hermes root/profile (`HERMES_HOME` remains the normal configured root). Ebb does not create a per-Run Hermes profile/home and does not copy user `config.yaml`, auth files, `.env`, or other Hermes state.
- Hermes itself uses the provider/model/auth already configured by the user. Ebb does not require explicit provider/model/endpoint projection for a new Run and does not classify auth sources. It must not replace the user's Hermes selection.
- The Run API's `model=default` uses the Hermes-configured model. An explicit non-default model override is rejected before Run creation with `HERMES_MODEL_OVERRIDE_UNSUPPORTED`; it is never silently ignored or passed as a second model setting.
- Register the existing Ebb MCP tools through the pinned Hermes in-memory registration API before ordinary CLI discovery. This is an adapter call, not a new config subsystem; verify that discovery preserves `submit_result` and cannot bypass Action Gateway.
- A real provider-backed invocation is required to claim runtime acceptance. Provider-free tests, seeded output, or a successful `hermes --version` do not prove it.
- Run/session correlation remains Orchestrator-owned. Persist only the allowlisted session ID and the minimum Run/generation/attempt/containment correlation needed for recovery. Do not persist raw Hermes output or credentials.
- Resume is allowed only for the same logical Run and durably captured original Hermes session after authoritative proof that its previous process scope stopped and all existing Run/workspace/fingerprint checks pass. Hermes applies its current configured provider/model/auth when resuming; Ebb does not inspect or compare Hermes provider context. Do not add a provider URL hash, Ebb HMAC key, SecretStore mapping, or `.env` setting to manufacture identity.
- Do not add per-Run Hermes profile path, profile ACL/ownership, profile cleanup, auth-route fallback, refresh-contention, or MCP/config-overlay subsystems to v1.

## Superseded design record

The decision accepted on 2026-10-02 proposed creating a unique Hermes-native profile under the auth-owning root for every Run, projecting provider configuration into that profile, and proving profile-specific auth fallback, path safety, isolation, refresh behavior, and cleanup. The user superseded that direction on 2026-10-10. Those profile-specific requirements are no longer v1 requirements. Historical implementation and review evidence may remain in the Plan19 ledger, but it must not be treated as acceptance evidence for this contract.

## Required document reconciliation

Update `docs/architecture/specs/01-system-design.md`, Plan20, and the Hermes runtime setup documentation to describe the shared configured Hermes root consistently and do not introduce an MCP/config-overlay subsystem. Do not change implementation or plan lifecycle status as part of this decision record. Plan20's independent review must check the amended contract before implementation continues.
