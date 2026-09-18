# Ebb Orchestrator Web — Agent Instructions

Этот файл дополняет корневой `AGENTS.md` для `apps/web/**`.

Корневые правила имеют приоритет при любом конфликте.

## 1. Backend remains authoritative

Web UI не является security boundary.

Frontend не должен самостоятельно решать:

- разрешено ли действие;
- допустим ли workflow transition;
- существует ли approval authority;
- можно ли выполнить merge;
- превышен ли budget;
- является ли project/repository trusted.

UI может показывать предварительное состояние, но backend обязан повторно валидировать действие.

## 2. Domain logic

Не дублировать сложную domain logic во frontend.

Если UI вынужден воспроизводить backend rules для корректности, это сигнал проверить API/read-model design.

Предпочитать backend-provided:

- status;
- capability;
- blocking reason;
- approval state;
- validation errors;
- read projections.

## 3. UI states

Для пользовательских экранов предусматривать:

- loading;
- empty;
- error;
- unavailable/blocked;
- stale/retrying, если relevant.

Blocked/waiting state должен показывать понятную причину, полученную от backend.

## 4. API

Не скрывать backend errors преобразованием в generic success.

Сохранять typed request/response contracts.

Не читать secrets из client-exposed environment variables.

Не помещать privileged tokens в browser storage.

## 5. Live updates

SSE/live projections — presentation mechanism, не source of truth.

После reconnect UI должен уметь восстановить authoritative state обычным query/API.

## 6. Security UX

Не создавать UI, который подразумевает, что Local Mode является OS sandbox.

Не скрывать требуемые approval/security boundaries ради удобства UX.

## 7. Components

Exported reusable components/hooks/services документировать русским JSDoc, когда комментарий добавляет семантику.

Не добавлять JSDoc к каждому trivial component только ради количества.

## 8. Web quality

Перед completion изменений web-части выполнить существующие workspace-команды:

```bash
pnpm lint
pnpm test
pnpm --filter @ebb-orchestrator/web build
```

Web package не имеет отдельного `typecheck` script: проверка TypeScript входит
в `build` через `tsc -b`. E2E-команду выполнить дополнительно, если она нужна
для изменённой области и окружение для неё доступно.
