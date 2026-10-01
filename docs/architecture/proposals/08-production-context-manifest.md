---
id: proposal-08
status: accepted
title: Production ContextManifest lifecycle across Run bindings
date: 2026-09-30
type: proposal
tags: [context, runs, persistence, plan-05, plan-06]
---

# Proposal: production ContextManifest lifecycle

**Статус:** принято пользователем 2026-09-30 целиком; реализация выполняется по отдельно проверенному implementation plan.

## 1. Goal и non-goals

Связать Orchestrator-prepared input каждого Run с durable `ContextManifest`, чтобы UI показывал достоверные IDs/версии и recovery/resume использовали известное происхождение входа.

Не входят: полный hidden/system prompt или Hermes conversation-history capture; semantic/vector retrieval; LLM summarization; изменение workflow/approval policy; хранение prompt текста или reasoning в manifest; фиктивные версии/ID и приблизительный token count, выдаваемый за точный. Manifest явно не утверждает, что содержит все system/runtime-injected/model-visible context.

## 2. Current state

- `ContextBuilder`, `ContextSelector`, `PromptBuilder` и `ManifestBuilder` существуют, но production Run callsites их не соединяют; `context_manifests` не имеет writer.
- Обычный Task Run создаётся без role-specific prompt, после чего Hermes получает fallback с task ID, role и `contextVersion`.
- Epic orchestration передаёт JSON phase request; Integration отдельно строит prompt с Task/Epic contract, workspace, SHA и persisted integration attempt provenance.
- Task/Epic contract хранится изменяемым `contract_json` без version history. Guideline имеет integer version; Decision не имеет version field. Prompt token count не измеряется.
- Текущая таблица требует `task_id`, ограничивает roles task workflow, хранит только `task_contract_version` и ID arrays, не сохраняет версии Guideline/Decision и не запрещает несколько manifests на один Run.

Следовательно, текущий production Run boundary не знает точный состав context, который агент получил. Пустые ID arrays или постоянное значение `1.0.0` создадут недостоверную историю.

## 3. Подходы и рекомендация

### A. Подключить deterministic Context pipeline к Run preparation — рекомендовано

Production application service загружает persisted subject contract/request и актуальные project knowledge records, применяет selector/budget builder, формирует typed per-role additions, сохраняет обязательный caller-owned role prompt/context без замены, а их structural provenance связывает с exact final prompt. Run и manifest сохраняются одной транзакцией до dispatch из одного DB snapshot. Integration prompt обязан сохранить workspace, source/target SHA, attempt ID и provenance; Reviewer — diff/checks; QA — AC/environment/defects; Developer — workspace/dependency state; Coordinator/PM/Architect — request/project/design context.

Преимущества: manifest отражает тот же объект данных, который попал в prompt; один deterministic owner; transaction failure не оставит Run без provenance. Цена: нужно определить версионирование contracts/decisions, расширить manifest storage для versions и связать существующие context-модули с production orchestration.

### B. Caller-supplied provenance

Каждый вызывающий код сам формирует prompt и список IDs/версий и передаёт их в `RunService`.

Преимущество: меньше центральных изменений. Недостаток: несколько producers могут разойтись; строгая связь metadata с финальным prompt сложнее проверить; уже существующие callsites придётся независимо поддерживать.

### C. Сохранять только то, что есть сейчас

Записывать `contextVersion` как contract version и пустые массивы.

Отклоняется: это не доказывает фактически переданные contract/knowledge items и нарушает цель ContextManifest.

## 4. Рекомендуемое решение

Выбрать A для всех production Run bindings. `RunContextAssembler` формирует role-specific typed context и final prompt, не стирая current caller-owned instructions/context; `RunService` сохраняет Run+manifest до Scheduler dispatch. Manifest subject ровно один из `TASK`, `EPIC`, `REQUEST`: если Run имеет taskId, subject TASK, иначе epicId даёт EPIC, иначе requestId даёт REQUEST. В контекст Task Run входят parent Epic данные, если они реально переданы. Поддержать роли Coordinator, Product Manager и Architect наряду с Developer, Reviewer, QA и Integration.

До реализации plan должен зафиксировать:

1. Contract/Decision versioning — digest сравнения по versioned canonical encoding v1: SHA-256 с domain separator; строгое JSON parse; RFC 8785 canonical JSON; UTF-8; без Unicode normalization; contract digest охватывает полный validated contract object; Decision digest охватывает `id,status,scope,title,rationale,related_guideline,content`; missing/null/empty/array order имеют определённую JCS семантику. Digest доказывает equality/change, но не восстанавливает старый текст.
2. Guideline version — persisted integer `version`; Findings/Defects используют digest canonical selected fields (`id`, `status`, title/description and role-relevant references). Manifest сохраняет ID+version/hash пары.
3. Resume — повторно использовать только исходный Run и его ту же persisted Hermes `sessionId`; никогда не прикреплять старую session к другому Run. Перед resume заново вычисляется fingerprint; resume допустим только при полном совпадении Orchestrator-prepared input/effective execution boundary, неизменных capability/worktree identity и HEAD, и отсутствии любых изменённых или дополнительных regular files в доступном workspace. Проверка учитывает staged, unstaged, untracked и ignored files, кроме `.git` internal metadata, поскольку текущие workspace tools могут читать ignored paths. При любом расхождении вернуть `RESUME_NOT_SAFE_WORKSPACE_CHANGED`, не создавать второй Run и не освобождать reservation/capability, пока прежний runtime process не подтверждён остановленным и прежний Run не прошёл штатную terminalization/reconciliation. Затем только существующий Scheduler recovery/retry flow может решить, запускать ли новый Run; Proposal не добавляет auto-retry. `prompt_hash = SHA-256("ebb-run-prompt-v1\\0" || UTF-8 exact final prompt bytes)`; `context_hash = SHA-256("ebb-run-context-v1\\0" || JCS({prompt_hash, subject_type, subject_id, contract_digest, sorted item ID/version hashes, context_builder_version, role, runtime, model, output_schema_version, context_version, normalized workspace/repository/worktree identity, target HEAD/branch, sorted effective allowed tool/capability IDs, approved Project Config revision/hash, non-secret provider/runtime policy identity}))`. Любое изменение любого переданного context item или effective boundary запрещает resume; старый Hermes session не получает незапрошенный delta. Proposal требует согласованно заменить §10.2 spec обещание “передавать ContextDelta при resume” на это безопасное правило; ContextDelta остаётся read-only diagnostic для UI/recovery. Hermes history уже связана с тем же session ID, но не восстанавливается и не хешируется этим manifest; это явно за пределами его provenance claim.
4. Token size — записывать только точное значение от поддерживаемого tokenizer/runtime, если оно доступно; иначе `NULL` + unavailable. Не переименовывать byte/character estimate в token count.
5. Failure semantics — если assembly или persistence manifest падает, Run не dispatch-ится; транзакция Run+manifest rollback-ится целиком.

## 5. Boundaries и ownership

- Planning/runtime application service владеет сборкой контекста из persisted records и role-specific caller input.
- Context module владеет selection, deterministic budget pruning, context DTO и delta.
- RunService владеет Run identity, transaction, manifest persistence и dispatch-ready invariant.
- SQLite остаётся source of truth. UI/API только читает manifest projection.
- Runtime получает собранный prompt, не принимает domain state transitions и не создаёт persistent IDs. Existing Integration prompt builder остаётся владельцем mandatory integration provenance section.

## 6. Interfaces

- Добавить typed `PreparedRunContext`: final prompt, subject binding, contract/request digest, role, included ID+version/hash pairs, context builder version, `prompt_hash`, полный `context_hash` согласно §4, и необязательный exact initial token count. Данные Integration provenance, Reviewer diff/checks, QA environment/criteria и request-bound summaries входят в exact prompt hash даже если не представлены knowledge ID arrays. `ContextManifest` документирует Orchestrator-prepared input, не полный Hermes/model context.
- Расширить SQLite schema на ровно один FK-backed subject из task/epic/request, `UNIQUE(run_id)`, и разрешённые task/planning roles; transaction snapshot включает source records, Run insert и manifest insert.
- Resume guard проверяет immutable workspace identity/base HEAD и отсутствие любых изменений/добавлений regular files включая ignored; при mismatch возвращает `RESUME_NOT_SAFE_WORKSPACE_CHANGED` без auto-retry. Старые process/capability/reservation terminalize/reconcile в существующем lifecycle до любого другого dispatch. Это отдельный eligibility invariant, не content claim manifest.
- Сохранить existing `guidelineIds` / `decisionIds` API и добавить version fields. У старых строк version поля явно `null`/unknown; не представлять это как empty context.
- `agent_runs.prompt` уже сохраняет prompt; manifest его не дублирует. Proposal не утверждает наличие отдельно документированной retention/access policy. Перед implementation review обязан зафиксировать доступ к этому полю, его текущую retention семантику и отсутствие prompt leakage через Run/API/UI projections. Новый assembler не добавляет secrets; репозиторный и knowledge text остаётся untrusted.
- Manifest не содержит prompt text, credentials, full guideline/decision text или model reasoning.

## 7. State, failure и security

Manifest создаётся только из validated persisted domain records после deterministic selection. Assembly, включая необходимые authoritative facts, выполняется на одном consistency boundary; любые filesystem/provider reads, которые нельзя включить в DB snapshot, должны быть привязаны к immutable persisted provenance перед Run creation. `prompt_hash` вычисляется по тем же exact UTF-8 bytes, которые persist-ятся в `agent_runs.prompt`; `context_hash` фиксирует все caller-owned inputs и execution/capability boundary, не раскрывая текст. Repository content и все текстовые поля остаются недоверенными; никакие инструкции не исполняются через manifest. Prompt и manifest не меняются между подготовкой и dispatch. Манифест не описывает скрытый system prompt и последующую историю Hermes session.

Run row и manifest записываются одной транзакцией; `UNIQUE(run_id)` запрещает второй manifest. Ошибка context assembly или manifest insert не создаёт dispatchable Run. Retry/recovery повторно используют сохранённые Run identity и exact prompt/context provenance; дублирующий manifest на один Run запрещён уникальным constraint. Сбой после commit, но до dispatch оставляет durable prepared Run+manifest для штатного recovery.

## 8. Migration и compatibility

Subject-bound schema создаётся append-only migration с nullable Task/Epic/Request FK columns and exactly-one CHECK; existing `task_id` rows migrate as TASK subjects only where role/schema validation succeeds. Historical Runs are never backfilled because their exact context is unknown. Legacy API rows expose unknown version fields as `null`; true empty arrays mean a proven empty input. Schema/role combinations not representable in the new model remain unavailable and block dispatch until repaired by explicit migration logic.

## 9. Verification strategy

- Unit: JCS fixtures доказывают поля, null/missing, Unicode, массивы, domain separation и digest version; selected IDs/versions равны данным final role prompt.
- Persistence: Run+manifest атомарны и уникальны; task/epic/request ownership, roles, concurrent knowledge changes, rollback и process restart проверяются на одном DB snapshot.
- Runtime integration: все task/epic/request-bound roles сохраняют точный final prompt provenance; mandatory Integration SHA/attempt fields, Reviewer diff/checks, QA criteria/environment и planning context не теряются.
- Resume: exact digest + unchanged capability/worktree identity + unchanged HEAD + no changed/added accessible files допускают reuse только той же Run/session; dirty/changed workspace returns blocker, leaves old owner intact until process stop and terminalization, and never auto-creates a concurrent Run; ignored-file changes are covered because workspace tools can read them.
- API/UI: показываются только IDs/версии и безопасная unavailable причина, никогда prompt/hidden reasoning.
- Независимый review design до write-plan; после реализации — scoped review и whole-plan review Plan05/06.

## 10. Accepted decisions

Пользователь утвердил Proposal 08 целиком 2026-09-30. Приняты все решения разделов 1–9: подход A для Task/Epic/Request Runs; versioned canonical JSON по RFC 8785 с domain-separated SHA-256 для сравнения версий; exact-fingerprint resume только прежнего Run и Hermes session; отказ с `RESUME_NOT_SAFE_WORKSPACE_CHANGED` без конкурентного Run и автоматического retry; `NULL`, когда точное token measurement недоступно; обновление `spec-01` §10.2; provenance claim ограничен Orchestrator-prepared input и execution boundary и не распространяется на hidden Hermes/model context/history. Существующие per-role prompt additions сохраняются. Исторические Runs не backfill-ятся вымышленным provenance. Независимый implementation plan требуется до изменения production contract/code.
