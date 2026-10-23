---
id: plan-24
kind: plan
status: proposed
title: Полный каталог AI-провайдеров и управление ими через Web
summary: Полная настройка каталога провайдеров и моделей LobeHub в Ebb Orchestrator через Web, включая провайдерские токены, subscription/OAuth flows, runtime-интеграцию, модельные настройки и безопасное хранение credentials.
created: 2026-10-23
updated: 2026-10-23
depends_on:
  - plan-20
  - plan-23
specs:
  - ../specs/01-system-design.md
proposals:
  - ../proposals/18-ebb-owned-provider-config.md
---

# Полный каталог AI-провайдеров и управление ими через Web — Implementation Plan

**Goal:** Перенести в Ebb Orchestrator весь каталог из закреплённой версии LobeHub и дать пользователю настраивать в Web все провайдеры, модели, credentials, API-токены и поддерживаемые провайдерами subscription/OAuth-способы входа.

**Architecture:** Ebb сохраняет source-owned каталог провайдеров и моделей, но он содержит все записи LobeHub, закреплённые в Plan22, а не только Hermes built-in providers. Runtime выбирает provider/model/auth-method как явную часть Run selection; provider-specific adapters сводят chat/stream/tool/usage/error контракты к `AgentRuntime`, а все действия модели по-прежнему проходят через существующие `ActionGateway`, `PermissionEngine`, capability и `submit_result` границы. Settings UI и локальный API владеют provider config и auth lifecycle; секретные значения хранятся через существующий OS `SecretStore`, а SQLite сохраняет только references/metadata и несекретные настройки.

**Authority:** прямое требование пользователя от 2026-10-23: включить весь набор полезных настроек провайдеров из LobeHub, без сужения до текущего Hermes registry или двух провайдеров Plan23; поддержать token и subscription authorization там, где это предусмотрено провайдером; выполнять настройку из Web. Пользователь отдельно подтвердил Ebb-owned auth context и разрешил использовать Canva для web-design work. LobeHub source-of-truth — commit `d1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1`, зафиксированный в Plan22; точные источники: `packages/model-bank/src/const/modelProvider.ts`, `packages/model-bank/src/modelProviders/index.ts`, `packages/model-bank/src/modelProviders/*.ts`, `packages/database/src/schemas/aiInfra.ts`, `packages/openapi/src/services/provider.service.ts`, `packages/model-runtime/src/providers/**`. Внешний runtime source pin Ebb: Hermes `08165d58931841cee713468ae89032af7c57060a`; он не ограничивает новый каталог.

**Global Constraints:**
- Реализовать и показывать в Web все 86 provider IDs из закреплённого `ModelProvider` enum; ни один ID, provider-specific config field, auth method, subscription plan, model metadata или custom endpoint field из source inventory не удаляется из scope.
- Поддержать весь provider-specific набор типов credentials: API tokens/keys, multi-field credentials, device-code/OAuth flows, subscription/coding-plan access, cloud/project credentials и endpoint-based/local providers, если они описаны provider card/runtime. OAuth/provider errors не превращать в успешный статус.
- Настройки, provider metadata и credential status конфигурируются в Ebb Web. Никакое обязательное действие по изменению `.env`, вызову интерактивного `hermes auth/model` или ручному редактированию личного Hermes profile не допускается.
- Ни секрет, refresh token, device secret, authorization header, credential payload, полный provider response, ни raw prompt/tool content не возвращается Web UI/API и не попадает в SQLite, логи, artifacts, traces или provider catalog.
- Все credentials проходят через существующий `SecretStore`/OS keyring; SQLite хранит только opaque reference и non-secret metadata. На недоступном keyring операция настройки/запуска завершается fail-closed, без plaintext fallback.
- Все model requests вызываются только из runtime adapter, уже привязанного RunService; provider tools никогда не исполняются напрямую — только через текущие ActionGateway/PermissionEngine/capability contracts.
- Preserve deterministic workflow, SQLite orchestration authority, durable Run ownership/recovery, exact provider/model/auth binding per Run, no provider fallback that silently routes a Run to a different provider.
- Provider-defined API base URLs, local endpoints и custom model IDs отражаются в Web, но серверная сетевая граница предотвращает SSRF, redirect escapes, metadata-service access и DNS rebinding. Требуемые local/private endpoints включаются только явной пользовательской конфигурацией с проверкой exact destination.
- Все новые/изменённые production comments/JSDoc и UI text — по-русски; UI и доступные имена — русские; бренд — `Ebb Orchestrator`.
- Не копировать LobeHub implementation как dependency/vendor bundle; адаптировать data model, UI patterns, provider metadata и protocol contracts к Ebb stack, сверив лицензионные условия до переноса любых исходных фрагментов.

**Specialist Constraints:** Database — `ebb-database-engineering` для новой версии SQLite migration и fresh/populated upgrade; Security — отдельный review по secret storage, OAuth/CSRF/state, provider egress и redaction; Web — `ebb-web-e2e` с реальной локальной сессией, HTTP и browser lifecycle; дизайн — перед UI implementation создать hi-fi прототип в Canva и сохранить его edit/view URL и экспортированный reference в evidence плана.

**Review Focus:** (1) 86/86 provider IDs и все provider-specific auth/config/model metadata представлены и тестируются; (2) token/subscription flows управляют refresh/expiry/disconnect без доступа к личному Hermes profile; (3) точный provider/model/auth method записан вместе с durable Run до dispatch и остаётся тем же при resume; (4) только SecretStore хранит credential values; (5) downstream tool calls не могут обойти ActionGateway; (6) outbound provider request не может стать SSRF или изменить destination после DNS resolution/redirect.

**Execution dependency:** Plan20 остаётся `in_progress` и владеет пересекающимися RunService/runtime/recovery контрактами и миграционным каталогом. Ни одна задача Plan24 не стартует до актуального `plan-20: completed`; после этого повторно сверить исходники, миграционный каталог и Plan20-контракты, затем выполнять только оставшийся scoped DAG. Task 0 и Task 5 изменяют общие с Plan20 контракты только после этого согласования; параллельные правки одних и тех же seams запрещены. Ранее принятое пользователем исключение «Plan22 до завершения Plan20» не применяется к Plan24: это изменение меняет runtime/provider-контракты, пересекающиеся с незакрытым Plan20.

## Scope and complete provider inventory

Обязательный provider ID set сверяется с `ModelProvider` enum закреплённого LobeHub commit. Текущий проверенный enum содержит 86 entries:

```text
ai21, ai302, ai360, aihubmix, akashchat, antgroup, anthropic, azure,
azureai, baichuan, bailiancodingplan, bedrock, bfl, cerebras, chatgpt,
cloudflare, cohere, cometapi, comfyui, deepseek, fal, fireworksai, giteeai,
github, githubcopilot, glmcodingplan, google, groq, higress, huggingface,
hunyuan, infiniai, internlm, jina, kimicodingplan, lmstudio, lobehub,
longcat, meta, minimax, minimaxcodingplan, mistral, modelscope, moonshot,
nebius, newapi, novita, nvidia, ollama, ollamacloud, openai,
opencodecodingplan, opencodezen, openrouter, perplexity, ppio, qiniu, qwen,
replicate, sambanova, search1api, sensenova, siliconcloud, spark, stepfun,
straico, streamlake, supergrok, taichu, tencentcloud, togetherai, unsloth,
upstage, v0, vercelaigateway, vertexai, vllm, volcengine,
volcenginecodingplan, wenxin, xai, xiaomimimo, xinference, zenmux, zeroone,
zhipu
```

The provider card/runtime source is authoritative for each provider's fields, model families, API protocol, capability set, auth method, subscription behavior, and model discovery route. Source cards explicitly describe subscription/coding-plan or account-based flows including `chatgpt`, `githubcopilot`, `supergrok`, `bailiancodingplan`, `glmcodingplan`, `kimicodingplan`, `minimaxcodingplan`, `opencodecodingplan`, and `volcenginecodingplan`; the runtime inventory must also find and add any additional flow in the pinned source. The list above is not permission to omit or hard-code only these entries.

All 86 provider IDs must appear in the catalog and Settings UI. Provider models whose external API lacks the chat/tool/structured-output capability required by an Orchestrator role remain visible/configurable with their exact capability metadata and reason; only compatible models may be selected for that specific role. No provider is hidden or dropped from the provider catalog because its runtime protocol differs.

## File / interface map

| Owner | Files | Responsibility |
|---|---|---|
| Task 0 — source inventory and design amendments | `docs/architecture/specs/01-system-design.md` §§3.1/10.2/13.1/21.2–21.3; `docs/architecture/proposals/18-ebb-owned-provider-config.md`; `docs/architecture/plans/20-production-context-manifest.md`; new `docs/architecture/plans/evidence/24-provider-inventory.md` | Replace the two-provider/read-only contract with the all-86 Web-managed contract; record exact provider/auth/model/capability matrix and dispositions for open notes. Amend the v1 runtime and non-goal sections so the multi-provider catalog Web management is part of v1 scope while preserving Hermes as the default runtime; record explicit runtime/auth decision. |
| Task 1 — provider catalog and model metadata | New `apps/server/src/modules/runtime/providers/provider-catalog.ts`, `provider-types.ts`, `provider-model-catalog.ts`; new `apps/server/test/modules/runtime/providers/provider-catalog.test.ts`, `provider-model-catalog.test.ts`; `packages/contracts/src/api.ts` | Versioned Ebb-owned catalog with exact 86 IDs, display metadata, auth schema, model source, capability declarations and typed safe API projections. |
| Task 2 — state and credentials | New migration `apps/server/src/platform/database/migrations/049_provider_configuration.sql` (single owner: Run-selection provider/model/auth/config-revision snapshot column is included in this migration's full contract); new `apps/server/src/modules/runtime/providers/provider-settings-repository.ts`, `provider-credential-store.ts`, `provider-settings-service.ts`; modify `apps/server/src/platform/security/secret-store.ts` only if an identified port gap exists; new migration/store tests | SQLite stores non-secret global/role/default/endpoint/model settings and keyring references; credentials stored as bounded secret payloads in OS SecretStore. Migration is additive/forward-only and owns the full 049 schema, including Run selection snapshot fields consumed by Task 5. |
| Task 3 — provider transports/runtime and network egress gateway | New `apps/server/src/modules/runtime/providers/provider-agent-runtime.ts`, `provider-runtime-port.ts`, `provider-network-gateway.ts`, `provider-request.ts`, `provider-response.ts`, `provider-error-mapper.ts`; provider modules under `apps/server/src/modules/runtime/providers/adapters/<provider-id>.ts`; modify `apps/server/src/modules/runtime/{agent-runtime,run-service,run-types}.ts`, `apps/server/src/modules/execution/{mcp/tool-registry,mcp/mcp-server,action-gateway}.ts` only at verified seams | Normalize chat/stream/tool/structured result/usage/error for all catalog entries; map model tool calls into existing controlled actions; support provider-specific auth and endpoint settings without leaking credentials. The network gateway is the single provider egress port used by model and auth traffic. |
| Task 4 — subscription/OAuth lifecycle | New `apps/server/src/modules/runtime/providers/auth/{provider-auth-flow,device-code-flow,oauth-callback,token-refresh,auth-state}.ts`; new auth tests | Run provider-defined authorization, polling, PKCE/state validation, refresh and disconnect/revocation from Web through an Ebb-owned auth context, all over the Task 3 network gateway; no user Hermes auth/profile reads. |
| Task 5 — Run selection and durable binding | Modify `apps/server/src/modules/runtime/{run-service,run-types,agent-runtime}.ts`, `apps/server/src/app/routes/{runs,settings}.ts`, scheduler RunRequest producers and consumers, context provider/model fingerprint code, and the 049 schema consumers (Task 2 owns the 049 migration file; Task 5 consumes its stored Run-selection snapshot). Tests under corresponding `apps/server/test/modules/runtime`, `test/app`, and `test/e2e` | Resolve priority `explicit Run selection > role default > global default`; persist exact provider/model/auth-method/config revision before dispatch and use it on resume. Credentials/endpoints resolved by the snapshot revision; a config change after queueing does not alter the queued Run. |
| Task 6 — provider management API and Web | New `apps/server/src/app/routes/provider-settings.ts`, `provider-auth.ts`, `provider-models.ts`; modify `apps/server/src/app/create-app.ts`, `packages/contracts/src/api.ts`, `apps/web/src/features/settings/SettingsPage.tsx`, new `apps/web/src/features/settings/providers/*`, `apps/web/src/features/runs/AgentRunPage.tsx`, Run request forms, `apps/web/src/api/client.ts`, `apps/web/src/i18n/ru.ts`, `apps/web/src/app/router.tsx`; focused web tests and E2E | CRUD safe settings, secret input replacement/removal, device/OAuth status/progress, model list/default/per-role selection, test connection, and real Run model/provider choice in Russian UI. Use Canva prototype as the visual acceptance reference. |
| Task 7 — integration acceptance and docs | Relevant README/Hermes/provider docs, API and provider route suites, native keyring acceptance, provider E2E harness, `pnpm` root gates | Prove all 86 IDs, auth/config forms, run binding, safe storage, provider wire contracts, UI, migration/recovery and cleanup; update current-state/roadmap only after actual acceptance. Include a minimal Plan23 metadata fix (unquoted colon in YAML `title`) as part of the docs gate owner so `pnpm docs:roadmap -- --dry-run` passes. |

## Tasks

### Task 0 — Pin the complete source-backed provider/auth/model contract

**Depends on:** —

**Modify:** `docs/architecture/specs/01-system-design.md` §§3.1/10.2/13.1/21.2–21.3; `docs/architecture/proposals/18-ebb-owned-provider-config.md`; `docs/architecture/plans/20-production-context-manifest.md`; create `docs/architecture/plans/evidence/24-provider-inventory.md`.

**Interfaces:** Inventory row has `{providerId, displayName, sourcePath, sourceVersion, authMethods, credentialFields, configFields, modelSource, modelTypes, runtimeProtocol, capabilities, subscriptionSemantics, refreshSemantics, disconnectSemantics}`. Every provider must have exactly one row and at least one tested management form; all auth variants in the source have rows. Record API token, multi-field, subscription/token plan, device/OAuth, cloud-identity, local/no-secret, custom endpoint and model discovery variants where source defines them. The spec amendment makes Web management and Ebb-owned auth context authoritative, superseding Proposal18's read-only UI/two-provider scope. Plan20 keeps its process-supervision and reconciliation invariants but no longer treats Hermes as the only provider configuration owner.

**RED:** Add a source-contract check (`scripts/provider-inventory-check.mjs`, created here) that compares the local catalog ID set with `ModelProvider` enum at the pinned LobeHub commit. Before implementation it must fail because Ebb currently contains only `openai-api` and `anthropic`; report the exact missing count and sorted IDs. An inventory completeness check fails for any provider card lacking an auth/config/model/capability row.

**GREEN:** Inventory reports `86/86`, zero missing/duplicate provider IDs, and provider-card field/auth coverage for every enum row. Update accepted spec/proposal/Plan20 wording only in this task; no production code or auth profile access. Account for all open notes: `IN-001` unrelated skill maintenance deferred; `IN-002` addressed by the Web-managed OS SecretStore contract; `IN-003` macOS CI deferred only as unrelated work, not as a provider-support omission; `IN-004` Plan20 lifecycle status remains unchanged and independent.

**Run:** `node scripts/provider-inventory-check.mjs`; `pnpm docs:check`; `pnpm docs:test`.

**Expected:** Exact source-backed 86-ID set and every auth/config row pass; docs governance passes. Record user decisions and source commit in evidence; don't treat current Hermes runtime list as the complete provider source.

**Review Focus:** No provider is silently omitted; source is pinned, not current LobeHub `main`; every subscription method is classified by what it actually authenticates; auth store and runtime owners are explicit.

### Task 1 — Ebb-native provider catalog, typed config and model metadata

**Depends on:** Task 0.

**Create:** `apps/server/src/modules/runtime/providers/provider-catalog.ts`, `provider-types.ts`, `provider-model-catalog.ts`; `apps/server/test/modules/runtime/providers/provider-catalog.test.ts`, `provider-model-catalog.test.ts`.

**Modify:** `packages/contracts/src/api.ts` only with API-safe serializable types and current catalog consumers; `apps/web/src/features/runs/AgentRunPage.tsx` provider label source.

**Interfaces:** `ProviderDefinition { id, displayName, category, authMethods, credentialSchema, configSchema, modelSource, capabilities, runtimeAdapterId }`; `ProviderAuthMethod = 'api-key' | 'credential-fields' | 'subscription-token' | 'oauth-device-code' | 'oauth-pkce' | 'cloud-identity' | 'local-endpoint'`; provider definitions can declare multiple methods. Model identity is `(providerId, modelId)`, never `modelId` alone. Model capabilities include `chat`, `streaming`, `toolCalling`, `structuredOutput`, `vision`, `audio`, `imageGeneration`, `videoGeneration`, `embeddings`, `reranking`; preserve the LobeHub source fields needed to configure/use every model.

**RED:** Assertions fail on each missing source ID, duplicate id, unknown auth mode, invalid credential schema, duplicate provider/model pair, or model type whose capability row is absent. Verify current UI's hard-coded `providerForModel` mapping fails for models not in its two-provider list.

**GREEN:** Import/maintain a versioned Ebb-owned definition for all 86 entries; catalog query returns all 86 and safe public projection has no secret values or opaque references. Model discovery supports source-defined static lists, provider API catalogs and user-entered custom model IDs. Tests cover the full source matrix, capability eligibility, unknown provider/model fail-closed and safe public projection.

**Run:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/runtime/providers/provider-catalog.test.ts test/modules/runtime/providers/provider-model-catalog.test.ts`; `pnpm --filter @ebb-orchestrator/contracts typecheck`; `pnpm --filter @ebb-orchestrator/contracts test`.

**Expected:** `86/86` provider definitions and all selected model metadata validate; no unknown model is inferred or routed to a fallback provider.

**Review Focus:** Provider identity is not confused with model family; custom/remote models remain bound to their configured provider; non-chat model capabilities remain present in catalog and Web.

### Task 2 — Persistent provider settings and SecretStore-backed credentials

**Depends on:** Task 1.

**Create:** `apps/server/src/platform/database/migrations/049_provider_configuration.sql`; `apps/server/src/modules/runtime/providers/provider-settings-repository.ts`, `provider-credential-store.ts`, `provider-settings-service.ts`; migration and repository tests.

**Modify:** `apps/server/src/platform/database/migrator.ts`, database schema test fixtures and all migration-chain acceptance tests; extend `SecretStore` only if Task0 identified a concrete missing atomicity/metadata operation.

**Migration preflight:** Current tracked catalog ends at migration 048. Before execution, confirm 049 is still next; if another accepted migration was added, revise this plan's migration number and acceptance commands before implementation. Do not edit historical migrations.

**Interfaces:** Persist provider enabled/config fields, selected auth method, non-secret model list/default, global/role preference, credential reference, and a versioned non-secret configuration snapshot (with `configRevision`) in SQLite. Sensitive values are JSON payloads only in OS SecretStore using service `ai-provider` and opaque stable names; do not store them in `.env`, SQLite, context, or process-wide environment. `ProviderSettingsService.saveCredential()` returns status metadata only; `resolveCredentialForRun(providerId, authMethodId, configRevision)` returns secret bytes for the exact snapshot revision only inside runtime execution scope and clears owned mutable buffers after use; missing or mismatched revision fails closed. `disconnectProvider()` deletes local credentials and metadata transactionally; remote revocation is separately attempted only for a documented provider endpoint and reports its result without treating local deletion as remote revocation.

**RED:** Migration tests fail until fresh 001–049 and populated 048→049 upgrade work. Add tests proving no secret value is present in database rows/WAL-readable projections, metadata/API responses contain only secret references/status, failed keyring writes leave prior DB metadata/credential consistent, unavailable keyring does not fall back to plaintext, snapshot revision changes do not mutate older stored revisions, credential resolution for an unknown/stale revision fails closed, and disconnect clears both secret and provider binding.

**GREEN:** Add additive schema and repository with transaction/idempotency semantics; preserve every existing row, index, FK/action, root-page and migration history; run fresh install, populated upgrade, rollback-on-failure and restart readback. Secret rotation replaces the keyring item atomically; missing/unknown references fail closed.

**Run:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/provider-configuration-migration.test.ts test/platform/database/fresh-install-migrations.acceptance.test.ts test/platform/security/secret-store.test.ts test/platform/security/keyring-secret-store.test.ts test/modules/runtime/providers/provider-settings-repository.test.ts`.

**Expected:** Fresh 001–049 and upgrade 048→049 pass; `PRAGMA foreign_key_check` is empty; zero plaintext provider credential values in SQLite projections; no old migration changed.

**Gates:** `ebb-database-engineering`; focused migration/store tests; server typecheck; full migration acceptance.

**Review Focus:** Atomic alignment of SecretStore and SQLite metadata, no plaintext fallback, keyring unavailability semantics, local disconnect vs actual upstream revocation distinction.

### Task 3 — Multi-provider runtime adapters, network egress gateway and controlled tool loop

**Depends on:** Tasks 1–2.

**Create:** `apps/server/src/modules/runtime/providers/provider-runtime-port.ts`, `provider-request.ts`, `provider-response.ts`, `provider-agent-runtime.ts`, `provider-error-mapper.ts`, `provider-network-gateway.ts`; adapter modules under `apps/server/src/modules/runtime/providers/adapters/`; table-driven adapter tests for all 86 provider definitions and source-defined API protocols.

**Modify:** `apps/server/src/modules/runtime/agent-runtime.ts`, `run-types.ts`, `run-service.ts`, Hermes integration selection, `apps/server/src/modules/execution/mcp/tool-registry.ts`, `mcp-server.ts`, `action-gateway.ts`, runtime production composition and related tests. Preserve Hermes adapter as an adapter for Hermes-specific capabilities; do not use its current built-in registry as the source of Ebb's complete catalog.

**Interfaces:** `ProviderChatAdapter` maps canonical request/response/stream/usage/error to provider API. `ProviderAgentRuntime` implements the existing `AgentRuntime` lifecycle and handles model tool calls only by validated `ToolId` + schema through the existing ActionGateway, then continues bounded provider turns. The sole successful completion is validated `submit_result` through the existing controlled result channel. Provider responses cannot set Run state, approvals, files, Git state or workflow transitions. Credential bytes are resolved immediately before each HTTP request through `resolveCredentialForRun(providerId, authMethodId, configRevision)` and only the selected provider/auth method is accessible. No fallback to another provider/model after auth/quota/network errors.

`provider-network-gateway.ts` is the single egress port for every provider-related HTTP request in this plan, including device/OAuth/token/refresh/revoke calls from Task 4 and model requests. It validates scheme/host/port, resolves DNS and pins validated destination for each request, rejects forbidden address ranges and metadata endpoints unless the exact local/private endpoint is explicitly user-configured for a provider that declares local endpoint support, disables redirects by default and revalidates every allowed redirect, bounds request/response bytes/timeouts, and redacts headers/body before diagnostics. Provider-defined endpoints remain editable through Web.

**RED:** Add source-backed contract suite for each of 86 provider cards: correct endpoint/protocol/auth fields/model mapping; canonical chat request, streaming, tool calls, structured result and usage/error parsing for each provider that supports those capabilities. Existing `AgentRuntime` tests must fail when a fake provider attempts direct tool execution or when an unsupported tool/model is routed. SSRF tests fail for metadata IPs, DNS rebinding, cross-host redirects, credential-bearing URLs, malformed endpoints and oversized response bodies. Auth endpoints used by Task 4 must already be representable through this gateway (scheme/host verification, redirect policy, redaction) — the gateway contract tests run before Task 4 depends on them.

**GREEN:** Implement provider protocols and authentication variants in source-derived adapter groups; every provider ID has a concrete runtime adapter/config path, a typed capability result, one positive provider-wire fixture and negative/error fixtures. Non-chat provider/model cards remain configurable and queryable; they are rejected for incompatible AgentRun capability requirements with a precise reason, not silently hidden. Tests prove `ActionGateway` is the only tool execution path and provider credentials are not included in tool payloads.

**Run:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/runtime/providers/ test/modules/runtime/agent-runtime.test.ts test/modules/runtime/run-service.test.ts test/modules/execution/mcp/ test/modules/execution/action-gateway.test.ts`.

**Expected:** 86/86 provider adapters/catalog routes covered; tool loop stops after valid `submit_result`; provider/network failures produce typed safe diagnostics and do not change workflow authority.

**Review Focus:** Tool and output trust boundaries, stream cancellation, request abort/remote in-flight ambiguity, protocol-specific error attribution, SSRF, bounded resource use and no implicit cross-provider retry.

### Task 4 — Provider authorization, token/subscription lifecycle and provider validation

**Depends on:** Tasks 1–3.

**Create:** `apps/server/src/modules/runtime/providers/auth/provider-auth-flow.ts`, `device-code-flow.ts`, `oauth-pkce-flow.ts`, `token-refresh.ts`, `provider-auth-state.ts`; tests under `apps/server/test/modules/runtime/providers/auth/`.

**Modify:** provider catalog definitions, `apps/server/src/app/create-app.ts` route registration and local auth/CSRF tests.

**Interfaces:** `beginAuthorization(providerId, methodId, sessionBinding)` returns only `{flowId, verificationUrl?, userCode?, expiresAt, pollIntervalSeconds}`; `pollAuthorization(flowId)` returns `PENDING | COMPLETE | EXPIRED | DENIED | FAILED` plus safe display status; `refreshCredential()` rotates/upserts SecretStore data and never returns token fields; `disconnectProvider()` clears local state and invokes remote revoke when the source defines it. Every HTTP call in this task (device-code start/poll, token exchange, refresh, revoke) goes through the `provider-network-gateway.ts` egress port from Task 3; no direct fetch/undici/net call bypasses it. PKCE/state uses cryptographically random one-use verifier/challenge/state, binds to authenticated Ebb session and exact allowed callback origin, and expires. Device codes and OAuth tokens are redacted from logs and never returned to browser storage. Subscription plan credentials that are tokens use the same secret flow; subscription status/plan fields are separately projected as non-secret metadata.

**RED:** For every provider auth method in the inventory, a table-driven contract test fails unless it has a tested start/store/refresh/disconnect strategy. Security regressions prove CSRF/state mismatch, replay, expiry, cross-session flow use, callback-origin mismatch, invalid refresh, concurrent refresh and user disconnect all fail safely. Auth HTTP calls must be routed through the Task 3 gateway and fail the same SSRF/redirect/redaction assertions as model traffic. No vendor request occurs in unit tests.

**GREEN:** Implement all provider-specific flow types represented by the 86 source cards. Use provider-defined endpoints and transitions over the shared gateway, bounded polling/rate limits, refresh rotation, and local deletion; where upstream has no revoke API, report `LOCAL_DISCONNECTED` and do not falsely claim remote revocation. OAuth/device flows have mocked HTTP wire fixtures for success/pending/denied/expired/429/5xx/token rotation. No provider auth method from the inventory is hidden or silently replaced by API-key-only behavior.

**Run:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/runtime/providers/auth/`.

**Expected:** Every inventory auth method has positive and negative wire-contract coverage; no raw credential appears in returned objects, logs, diagnostics, traces or test snapshots; all auth requests pass the gateway egress contract.

**Gates:** Security-focused review of auth/CSRF/refresh/revocation lifecycle.

**Review Focus:** OAuth callback/session binding, token refresh concurrency and crash semantics, local vs provider revocation, account identifiers, gateway enforcement of auth egress, and provider error redaction.

### Task 5 — Durable provider/model/auth selection for dispatch, resume and role defaults

**Depends on:** Tasks 2 and 4.

**Create:** tests for global/role/explicit selection, resume binding and pre-dispatch barriers.

**Modify:** consume the 049 provider-selection snapshot schema (Task 2 owns the migration file; Task 5 does not edit it), `apps/server/src/app/routes/runs.ts`, all real Task/Epic/Request/Coordinator/Scheduler run producers, `apps/server/src/modules/runtime/run-service.ts`, Run context fingerprint/provenance/builder/version/resume eligibility, shared contracts and Run API tests.

**Interfaces:** `RunProviderSelection { providerId, modelId, authMethodId, configRevision }`. Resolution order is explicit Run override → exact role default → global default. A selected `(providerId, modelId, authMethodId, configRevision)` is validated and persisted in the same transaction as the Run/RunRequest before scheduler dispatch. The selection is immutable for that Run and used on every resume/recovery path. Credentials are resolved fresh by reference at launch; their value/version is never fingerprinted. Context hash includes stable provider/model/auth-method/config revision IDs only, never endpoint URL, token, account name or secret. Legacy rows with only `model` receive one deterministic registry-default resolution during a forward migration/read compatibility path; historical Run rows are not silently rewritten to a different provider.

**RED:** Route/RunService tests fail for omitted/unknown selection, disabled provider, unsupported model capability, missing credential, concurrent default change during request, and resume where provider/auth identity differs. Production producer matrix tests every real Task/Epic/Request/role path for preflight-before-write and exact binding.

**GREEN:** Persist explicit selection and non-secret config revision atomically before dispatch; capture resolved selection in existing durable Run / RunRequest contract, preserve terminal workflow semantics and old model projection, and ensure changed global defaults affect only newly created Runs. Recovery loads its original provider selection from SQLite, never accepts caller-provided provider/auth overrides, and follows confirmed existing lifecycle/stopped gates. If a direct provider lacks resumable session semantics, reconcile interrupted execution as unsuccessful without replaying a paid request.

**Run:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/app/runs-dispatch.test.ts test/modules/runtime/run-service.test.ts test/modules/scheduler/ test/e2e/context-manifest-production.acceptance.test.ts test/e2e/hermes-session-handoff.acceptance.test.ts`.

**Expected:** Every production Run is bound to the exact chosen provider/model/auth method before dispatch; resume cannot silently switch provider; unresumable/ambiguous external requests are not replayed; context hashes contain only permitted IDs/revisions.

**Gates:** `ebb-database-engineering` migration tests; review actual Run producers and recovery invariants.

**Review Focus:** Provider changes during queued Run, scheduler retry/idempotency, cost duplication on interruption, context version compatibility and migration behavior for existing Runs.

### Task 6 — Provider API, Canva UI design and Web settings implementation

**Depends on:** Tasks 1–5.

**Create:** `apps/server/src/app/routes/provider-settings.ts`, `provider-auth.ts`, `provider-models.ts`; `apps/web/src/features/settings/providers/ProviderCatalogPage.tsx`, `ProviderDetailPage.tsx`, `ProviderAuthForm.tsx`, `ProviderModelSelector.tsx`, `ProviderStatus.tsx`; component/API/E2E tests.

**Modify:** `apps/server/src/app/create-app.ts`, `packages/contracts/src/api.ts`, `apps/web/src/features/settings/SettingsPage.tsx`, `apps/web/src/features/runs/AgentRunPage.tsx`, all Run dispatch forms, `apps/web/src/api/client.ts`, `apps/web/src/i18n/ru.ts`, `apps/web/src/app/router.tsx`, `apps/web/src/components/AppShell.tsx`.

**Canva design deliverable:** Create an editable Canva prototype before coding: provider catalog/list, provider detail with provider-specific credential/config fields, API-key replacement/removal, subscription/OAuth pending/connected/expired/error states, model catalog/search/filter, global and role defaults, and Run selection. Include desktop and narrow viewport layouts; use Russian copy, accessible labels, no fake secret values, and the existing Ebb application information hierarchy. Record the returned Canva edit/view URL and export a static reference into `docs/architecture/plans/evidence/` (no credentials or real account data). The implementation must match the reviewed prototype's information hierarchy and states; UI copy/accessibility review can amend visuals without dropping provider/auth fields.

**Interfaces:** Authenticated/CSRF-protected API provides provider catalog and safe status; provider config update; credential write/replace/delete; auth start/status/cancel/disconnect; model list/refresh; global/role default and explicit Run model selection; connection test. No endpoint returns stored credentials, token fragments or credential references. Credential submission uses HTTPS/loopback same-origin, bounded request body, schema per provider and zeroed mutable input buffers after store call. OAuth callback is one-time state-bound; browser storage contains only flow ID/status. Every page renders loading, empty, error, unavailable, connected, pending, expired and disconnected states for every provider.

**RED:** Real Web/API tests fail because current `/settings` is read-only and supports only two providers. Browser acceptance asserts all 86 providers are discoverable, provider-specific auth forms and source-defined fields render, token replacement never repopulates secret input, OAuth/device flow state moves pending→complete/expired, model defaults persist/reload, and selected provider/model appears on Run. Accessibility tests assert keyboard navigation, labels, focus handling and responsive layout.

**GREEN:** Implement all settings from the editable Canva prototype using existing Ebb Web patterns; page/provider search, filters and pagination handle the full catalog; no provider disappears due to auth state. Real browser+HTTP tests use an isolated EBB_ORCHESTRATOR_HOME, test-only keyring, mock upstream servers and disposable SQLite; verify authenticated mutation, Origin/CSRF, DB readback, app restart, safe projections, OAuth state binding, and shutdown/cleanup without orphan processes.

**Run:** `pnpm --filter @ebb-orchestrator/web test`; `pnpm --filter @ebb-orchestrator/web build`; `pnpm --filter @ebb-orchestrator/web test:e2e -- test/e2e/provider-settings.spec.ts`; `pnpm --filter @ebb-orchestrator/server exec vitest run test/app/provider-settings-route.test.ts test/app/provider-auth-route.test.ts test/app/provider-models-route.test.ts`.

**Expected:** All 86 providers are manageable through Web; all auth/config/model fields in the source inventory are present; secret never reappears in a GET/UI/browser storage; selected model/provider is used by a newly dispatched Run.

**Gates:** `ebb-web-e2e`; localization/accessibility and security review of provider UI/API.

**Review Focus:** no false success during OAuth, route access/session/CSRF, secret lifetime in React state and browser devtools, provider error copy redaction, usability across 86 entries, and consistency with Ebb branding.

### Task 7 — Full 86-provider acceptance, security review, documentation and gates

**Depends on:** Tasks 0–6.

**Modify:** `README.md`, `docs/development/05-hermes.md`, relevant architecture/current-state docs and generated roadmap only after evidence; add marker-gated provider wire acceptance without real credentials to default test suite and opt-in real-provider smoke matrix.

**RED:** Acceptance matrix must fail if provider ID count is not 86, a source-defined auth/config/model field has no UI/API/runtime owner, a credential value is present in stored DB/log/artifact/API snapshots, a custom destination bypasses network policy, a Run resumes with a different selection, or provider adapter bypasses ActionGateway. Default CI must run all deterministic wire fixtures without spending tokens. Real smoke manifest cannot be marked PASS without explicit per-provider user authorization and evidence.

**GREEN:** Run provider-free matrix for all 86 catalog entries and every auth method, adapter protocol, model capability, SSRF case, migration path, and UI CRUD flow. Run a separately marker-gated real provider smoke for every configured provider/auth-method class after explicit user authorization; record provider ID, auth method, model ID, sanitized success/exit, run correlation and stop/cleanup only, never values or provider response bodies. Remote revoke is asserted only where source documents an endpoint; otherwise prove local disconnect and label it accurately. Document all 86 provider IDs and auth method fields from the evidence matrix, and describe settings from Web, supported flows, endpoint fields, local/private-network warning and recovery behavior.

**Run:** `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm build`; `pnpm --filter @ebb-orchestrator/server test`; `pnpm --filter @ebb-orchestrator/web test`; `pnpm --filter @ebb-orchestrator/web build`; `pnpm --filter @ebb-orchestrator/contracts typecheck`; `pnpm --filter @ebb-orchestrator/contracts test`; `pnpm docs:check`; `pnpm docs:test`; `pnpm docs:roadmap -- --dry-run`; `git diff --check`.

**Expected:** Every default gate exits 0; provider-free acceptance reports 86/86; no unreviewed security finding; any unavailable real-provider credentials/smoke remain `NOT RUN` and never substitute mock evidence for a provider-backed PASS.

**Review Focus:** Full independent implementation/security review, real HTTP+browser evidence, migration safety, 86-entry parity, no claims beyond exercised provider methods, no credentials or unrelated changes.

## Dependency DAG

```text
Task 0 → Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7
Task 1 ─────────────────────────────────────────→ Task 6
Task 2 ─────────────────────────→ Task 5
Task 0–6 ───────────────────────────────────────→ Task 7
```

Task 2 owns migration 049 and the stored provider-selection snapshot schema; no other task edits that migration. Task 3 owns the network egress gateway, provider transports and runtime adapters; Task 4 (auth/token lifecycle) and Task 5 consume that gateway and the credential/snapshot stores. Task 5 owns Run selection/persistence/recovery and shared producer paths. Task 6 begins only after stable API DTOs and the approved Canva screens. Tasks 0–7 are sequential except that provider catalog tests and Canva prototype preparation may proceed in parallel after Task0 review.

## Plan completion criteria

- All 86 source provider IDs are present and tested across catalog, Web, settings persistence and provider adapter/config route.
- All source-defined API-key/token, subscription/coding-plan, OAuth/device/PKCE, cloud credential, local endpoint and custom-model configuration methods are mapped; no method is dropped to simplify UI/runtime.
- Provider/model/auth/config revision is a durable, immutable Run selection; new defaults affect only new Runs; no silent provider fallback or paid-request replay.
- All credential values are in OS SecretStore only; DB/API/UI/logs/artifacts contain no values.
- Existing ActionGateway/PermissionEngine, output validation, deterministic Workflow Engine, Scheduler authority, migrations and recovery invariants remain intact.
- Canva prototype URL, export reference, real browser E2E and independent security/whole-plan review are recorded.
- Root gates, docs gates, diff check and full worktree review pass; generated roadmap is synchronized; unresolved real-provider gates are explicit, not mislabeled PASS.

## Self-review

1. User requirement coverage is explicit: full 86-provider inventory, provider-specific forms, API tokens, subscription/OAuth, all settings in Web, custom endpoints/model fields and no scope narrowing.
2. Plan22's actual adopted scope is reconciled: provider configuration/UI was expressly outside its A–C layers; this plan is the missing provider-settings/runtime work, not a claim that Plan22 should have silently owned it.
3. Plan23 remains verified baseline, not repeated: its two-provider static registry, `.env` loader, explicit Hermes selection and read-only Settings are superseded by the broader catalog/Web management contract in this plan.
4. Producers/consumers are named: catalog → settings API/UI; SecretStore → auth service → provider adapter; Run selection → RunService/Scheduler/AgentRuntime/recovery; provider tool response → existing MCP/ActionGateway/OutputValidator.
5. Migration 049 is additive and forward-only; user data is not migrated from personal Hermes profile or copied from user `.env`.
6. Every task includes RED/GREEN, exact run commands, expected behavior, and Review Focus. Provider integration is data-driven across the 86 exact IDs; all auth modes receive their own wire/error tests.
7. Plan remains `proposed` until a fresh independent `ebb-review-plan` returns `APPROVED` and the user explicitly authorizes execution. No implementation, provider network request, credential read, Canva asset creation, commit or push is performed by this plan-authoring task.
