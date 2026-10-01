---
id: proposal-09
kind: proposal
title: Reuse the configured Hermes provider for Orchestrator Runs
status: accepted
created: 2026-10-01
updated: 2026-10-02
---

# Proposal 09: Reuse the configured Hermes provider for Orchestrator Runs

**Status:** Accepted by the user on 2026-10-02 as a conditional design direction. Implementation remains subject to the Plan20 review and the profile/configuration safety and real-provider acceptance gates below.

## Problem

The production runtime creates an isolated Hermes home for each Run. Its current provider bridge requires a second configuration (`EBB_HERMES_PROVIDER_BASE_URL`, `EBB_HERMES_PROVIDER_SECRET_NAME`) and an API key stored in Orchestrator's SecretStore. It does not reuse the provider already configured in the user's Hermes profile. The repository-root `.env`/`.env.example` configure Ebb Orchestrator itself; they are not where the user's Hermes provider credentials belong. The README lacks the complete end-to-end Hermes setup and Run instructions.

This conflicts with the intended operator experience: configure/authenticate Hermes once, then let Ebb Orchestrator use that configured provider without asking the user to maintain a duplicate endpoint/key mapping.

## Goal

Use the provider and authentication already configured in the user's Hermes installation while retaining isolated Hermes state for every Orchestrator Run.

## Non-goals

- Sharing the user's whole Hermes home, session database, memory, MCP configuration, skills, or other personal settings with a Run.
- Copying an `auth.json`, `.env`, or other credential file into the repository or a Run profile.
- Logging, returning, or persisting provider tokens in SQLite, prompts, artifacts, UI, or ordinary logs.
- Replacing Hermes with another runtime.

## Current evidence and constraints

- `HermesRuntimeAdapter` overrides `HERMES_HOME`, `HOME`, and `HERMES_CONFIG`, writes a managed per-Run profile, and resolves the provider API key through `SecretStore`.
- Plan04 explicitly scopes the current bridge to an OpenAI-compatible API key and excludes reuse of the user's OAuth state or an OAuth broker.
- Hermes documentation describes OAuth credentials in its auth store and profiles as separate homes containing configuration, auth state, sessions, memory, skills, and other state. Hermes warns against concurrent use of the same profile.
- Read-only inspection of the installed Hermes `v0.21.5+4831.g02e4118` source found `_global_auth_file_path`, `_load_provider_state_with_source`, `_provider_state_transaction`, and `_save_provider_state_to_source` in `hermes_cli/auth.py`. Distinct Hermes homes can fall back to provider state in Hermes' global-root `auth.json`; provider refresh uses Hermes-owned locks and writes updated state back to the source store. `hermes_constants.py:get_default_hermes_root` determines which root is visible to that fallback.
- Read-only inspection of non-secret active-profile metadata in this environment reported provider `openai-api` and model `gpt-6-luna`; `HERMES_HOME` matches Hermes' platform default root and is not a named profile. No `.env`, `auth.json`, key, token, or account identity was read. Hermes source classifies `openai-api` as an API-key provider and lists `gpt-6-luna` for it.
- Hermes' source distinguishes Hermes-managed credential paths. Its native `hermes auth add openai-api` flow stores an API-key credential in Hermes `credential_pool`; that pool can fall back from a real profile under the Hermes root to the root `auth.json`. Hermes-profile `.env` and scoped process-environment values follow separate profile scoping. These Hermes-side files are distinct from the repository-root Ebb `.env`.
- The current Orchestrator run home is outside the user's Hermes root and the process environment allowlist drops provider keys. Therefore the native credential-pool fallback is currently unreachable. It may work for runs under `<Hermes-root>/profiles/<run-id>`, but provider/model selection, custom endpoint behavior, `.env`-only credentials, and cross-platform path safety remain unproven. No secret value or user auth/config file was read.
- The installed `hermes auth status openai-api` path reads/resolves the credential before it reports status, and its CLI output omits the credential source. `hermes auth list openai-api` exposes auth labels/IDs and still cannot establish whether an environment credential takes precedence. Neither command is a suitable secret-free source-classification interface. No Hermes command or provider request was run for this review.
- Consequently, pointing Runs at the user's whole Hermes profile is not an acceptable shortcut: it would share personal configuration/state and would not support concurrent Run isolation.

## Proposed contract

Hermes owns provider configuration and credentials. Ebb must reuse the provider already configured in Hermes and must not create a second endpoint/key-name mapping or require a second credential entry in Orchestrator `SecretStore`. The installed Hermes `auth.json`/`credential_pool` profile fallback is the leading supported path: create a distinct Hermes profile for every Run under the same Hermes root and let Hermes resolve and refresh its own credential. Do not pass the whole user profile to the Run.

1. The user configures/authenticates the provider once using Hermes' supported setup. In this environment, non-secret active metadata is `openai-api` / `gpt-6-luna`, and the active home is the platform default root. Implementation consumes only the selected provider/model/endpoint fields.
2. Every Run receives a unique Hermes-native profile/home under the Hermes root that owns the configured auth store. Hermes' native fallback may read provider auth from that root; the Run does not share another Run's sessions, memory, MCP configuration, tools, or skills.
3. The first supported path requires an explicit provider and model in the default Hermes profile; Ebb does not reproduce Hermes' `auto` provider selection. Run config uses only schema-validated, allowlisted provider/model/endpoint values and rejects endpoint URLs containing userinfo or credential-like query parameters. The available `hermes config get` command reads a declared value rather than resolving the effective runtime provider, and loading config may create directories/backups, so it is not presumed to be a side-effect-free selection API. Never copy the full user configuration or auth/secret files into a Run profile.
4. Hermes remains the owner of credential lookup, provider token refresh/rotation, and cross-process serialization. Ebb does not parse auth files, export/copy token values, implement refresh, or request a duplicate provider mapping.
5. Hermes-managed global/default `credential_pool` and OAuth auth-store fallback are the target credentials for the first supported path. The current active home uses that global/default root layout. Hermes-profile `.env`, process-environment, and external secret-source-plugin credentials are separate sources; support them only if the same Hermes-native isolated profile can resolve them without forwarding unrelated secrets or copying secret-bearing files. Otherwise fail closed with an actionable compatibility message; never ask for a SecretStore key name.
6. Missing, expired, revoked, or unsupported authentication fails before dispatch with a specific Hermes-side remediation; no silent provider fallback occurs.
7. The non-secret provider/runtime policy identity is bound into the existing prepared-input/execution fingerprint so provider changes make resume ineligible without exposing account or credential data.
8. Windows/Linux profile-root ownership, path validation, access control, retention, and cleanup must be specified and independently reviewed before implementation. If native Hermes profile fallback cannot be made safe, stop and present an explicit architecture choice rather than implementing an unsupported auth-file parser or token-copy workaround.

## Unresolved feasibility gates

- Prove the provider home/root calculation on Windows and Linux for a unique per-Run Hermes home and whether it resolves the expected global auth store without exposing user state.
- Prove the pinned Hermes global-root fallback supports Hermes `credential_pool` and OAuth auth-store entries for the configured provider/model; distinguish global/default auth from non-default active profiles.
- Prove Hermes' own lock/refresh/write-through contract safely covers concurrent Orchestrator Runs and a user Hermes process, including crash/restart during token rotation.
- Prove a side-effect-bounded method to resolve explicit provider/model/endpoint values from the default Hermes profile. Validate only allowlisted scalar fields; do not run the full runtime provider resolver or expose provider config. Auth-store fallback supplies credentials for a provider ID but does not select provider/model/custom endpoint.
- Prove whether `.env`, process-environment and Hermes external secret-source plugins can be consumed from a Run profile through Hermes-native behavior without forwarding unrelated secrets or copying user secret-bearing configuration. Do not probe or display credential values to classify the source.
- If profiles must live under the user's Hermes root to use `credential_pool` fallback, define ownership, ACLs, reparse-point/symlink handling, retention, and cleanup for Orchestrator-created per-Run directories on Windows and Linux. This changes the current runtime storage boundary.
- Define the exact first-run instruction and failure action when the user's provider is stored in a Hermes profile that the native fallback cannot reach.
- Bind a stable, non-secret provider identity into resume eligibility and test that changing provider or auth policy rejects resume.

## Accepted conditional design decision

The user approved the direction in Alternative C: Hermes remains the only provider/auth owner; Ebb creates an isolated native Hermes profile per Run under the same default Hermes root and uses Hermes' global/default auth-store fallback. The first supported path requires an explicit provider/model and an allowlisted endpoint; it does not add an Ebb SecretStore credential or a second key mapping. Named-profile auth and profile-scoped external secret sources remain unsupported unless a Hermes-supported sharing mechanism is proven.

This approval covers the design direction. Before the Hermes provider path is enabled, close the configuration-reading and Windows/Linux path-security gates above and pass a real provider-backed acceptance. Update spec-01 and Plans 04/19/20 consistently; Plan20 must pass a fresh independent review before its implementation begins. Continue ordinary implementation and acceptance without asking the user for routine technical approvals. Stop only if Hermes-owned credential reuse and Run-profile isolation cannot be proven.

## Alternatives

### A. Point Runs at the user's whole Hermes profile

This reuses the existing login directly, but shares user configuration and state with Runs, conflicts with Hermes' one-agent-per-profile guidance, and weakens current per-Run isolation. Rejected.

### B. Keep the API-key SecretStore bridge and document it

This preserves current isolation but requires the separate provider endpoint/key setup that prompted this change. It also needs a supported key-entry UX and complete documentation. Rejected as the default user experience.

### C. Use Hermes native profile authentication fallback

This preserves per-Run Hermes state and reuses the existing Hermes auth store without duplicate provider credentials or an Orchestrator auth broker. For v0.21.5, each isolated run home must be a Hermes-recognized profile under the Hermes root that owns the auth store; the current external Orchestrator runtime path does not qualify. This is the recommended direction. Provider/model/endpoint selection, external secret-source compatibility, and concurrent refresh semantics remain feasibility gates.

### D. Reuse every Hermes credential source

Hermes also supports profile-scoped external secret-source plugins and environment-backed credentials. A Run profile does not automatically inherit the user's source declarations or bootstrap material. Extend native Run profiles through a Hermes-supported credential-sharing boundary only if source configuration can be reused without exposing unrelated secrets, reading credential files in Orchestrator, or maintaining another provider/key mapping. Otherwise list these source modes as unsupported for this path with an actionable message. Do not infer a source by parsing credentials or by running a status command that resolves a secret.

## Security and lifecycle requirements

- Do not expose the user's full Hermes home to a Run.
- Do not pass the entire backend environment to Hermes; keep the existing explicit runtime allowlist.
- Provider credentials must remain outside Run prompts, Run records, generated files, logs, and API/UI responses.
- Concurrent Runs must not race on mutable OAuth refresh state. The design must name the single owner/lock and define crash/restart recovery.
- A token refresh failure must not trigger repeated stale-token use, silent provider substitution, or a new Run while the prior process is live.
- Keep provider identity and credential metadata out of public Run responses unless an already-approved API field is explicitly non-sensitive.

## Required plan and documentation updates after design approval

- Update `docs/architecture/specs/01-system-design.md` only where the provider-auth ownership/security contract changes.
- Update Plan04 and Plan19 from the API-key-only bridge to the approved provider-auth flow; update Plan20 acceptance prerequisites so Task5B uses the user's configured Hermes provider without introducing a second key mapping.
- Add a complete README first-run guide: supported OS/runtime prerequisites, install, one-time Hermes provider login, Ebb Orchestrator configuration/startup, expected first-run behavior, a harmless real-provider verification, and recovery/troubleshooting.
- Keep `.env.example` limited to safe, non-secret application settings; document exactly which variables remain necessary and why.
- Update `docs/development/05-hermes.md` to distinguish developer project-trust setup from Orchestrator runtime/provider setup.

## Feasibility and acceptance evidence required before implementation

- Verify the supported Hermes version's native profile fallback can use the existing configured provider from a distinct per-Run home without sharing session/config state or copying raw auth files; cite the exact interface/source.
- Verify user-selected provider/model resolution reads only safe, non-secret configuration and never inherits personal MCP servers, tools, skills, or prompts.
- Verify Hermes-owned token refresh/rotation is safe under concurrent Runs and an independently running user Hermes process; test lock contention, process crash during refresh, and recovery after restart. Orchestrator must rely on Hermes' supported serialization, not reproduce private locks.
- Verify `HERMES_HOME`/profile path behavior and auth-store root resolution on Windows and Linux before moving runtime homes from `.ebb-orchestrator`.
- Run a real provider-backed acceptance using the already configured Hermes account; do not treat seeded/mock tests as provider evidence.
- Prove selected provider/account identity without fallback, per-Run session/home isolation, unchanged user Hermes state, source-tag visibility, process-stop ownership, and fail-closed behavior for missing/revoked auth.
- Prove a provider identity/auth-policy change makes same-Run resume ineligible.
- Obtain independent architecture review before implementation and independent recovery/security review after implementation.

## Sources

- `docs/architecture/specs/01-system-design.md`
- `docs/architecture/plans/04-hermes-autonomous-task.md`
- `docs/architecture/plans/19-unfinished-plan-closure.md`
- `docs/architecture/plans/20-production-context-manifest.md`
- Installed Hermes v0.21.5 source (read-only): `hermes_cli/auth.py` and `hermes_constants.py` in `%LOCALAPPDATA%/hermes/hermes-agent`
- Hermes provider setup and OAuth/auth store behavior: <https://github.com/nousresearch/hermes-agent/blob/main/website/docs/integrations/providers.md>
- Hermes profile isolation: <https://github.com/nousresearch/hermes-agent/blob/main/website/docs/reference/faq.md>
