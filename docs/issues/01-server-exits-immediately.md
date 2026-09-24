# Проблема: Сервер немедленно завершается после запуска

## Описание

При запуске сервера Ebb Orchestrator через `pnpm start` или `node apps/server/dist/main.js`, сервер выводит:
```
[ebb-orchestrator] Recovered interrupted runs: 0
[ebb-orchestrator] listening on http://127.0.0.1:3000
[ebb-orchestrator] status: READY
[ebb-orchestrator] received SIGINT, shutting down…
[ebb-orchestrator] shutdown complete
```

И сразу завершается. Это происходит потому что:
1. pnpm запускает процесс в подпроцессе
2. Подпроцесс получает SIGINT/SIGTERM
3. Обработчики сигналов сразу вызывают gracefulShutdown

## Текущий код (apps/server/src/main.ts)

```typescript
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
```

Эти обработчики срабатывают сразу после запуска, до того как сервер успеет:
- Записать bootstrapToken в файл
- Открыть браузер
- Принять хотя бы один запрос

## Решение

Добавить флаг `serverReady`, который блокирует обработку SIGINT/SIGTERM до тех пор, пока сервер не полностью инициализирован.

```typescript
let serverReady = false;

process.on("SIGINT", () => {
  if (serverReady) void gracefulShutdown("SIGINT");
});
process.on("SIGTERM", () => {
  if (serverReady) void gracefulShutdown("SIGTERM");
});

// ... после запуска сервера ...
await app.listen({ host, port });
serverReady = true;
```

## Статус

- [x] Проблема обнаружена
- [x] Решение реализовано в main.ts
- [x] Тестирование (см. test-service.test.ts)
- [ ] Документирование в Task 10 evidence report

## Current State (2026-09-24)

- Issue status: Resolved in code, pending commit
- Dirty working tree: 9 modified files including this doc
- Build status: Blocked by AgentRun.output contract error
- Test status: Passes (run-service.test.ts covers this behavior)

## Повторение проблемы

```bash
# Запуск через pnpm
pnpm start

# Или напрямую
node apps/server/dist/main.js
```

Сервер сразу закрывается, не успев записать bootstrapToken.
