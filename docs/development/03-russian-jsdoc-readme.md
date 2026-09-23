---
id: guideline-03
kind: development
title: Russian JSDoc и README документация
created: 2026-09-23
updated: 2026-09-23
---

# Russian JSDoc и README документация

**Версия:** 1.0  
**Дата утверждения:** 2026-09-23

---

## Цель

Этот документ фиксирует требования к документации на русском языке для проекта Ebb Orchestrator.

## Требования

1. **JSDoc комментарии** — все публичные API, функции, классы и методы должны иметь JSDoc комментарии на русском языке.
2. **README файлы** — основные README файлы проекта должны быть на русском языке.
3. **Согласованность** — терминология должна быть единой во всей документации.

---

## Примеры

### JSDoc пример

```typescript
/**
 * Переходит в следующее состояние рабочего процесса.
 * 
 * @param context — текущий контекст рабочего процесса
 * @returns новое состояние рабочего процесса или null, если переход невозможен
 */
function transition(context: WorkflowContext): WorkflowState | null {
  // реализация
}
```

### README пример

```markdown
# Ebb Orchestrator

Трактатор для автоматизации разработки ПО.

## Установка

```bash
pnpm install
```

## Использование

```bash
pnpm run dev
```
```

---

## См. также

- [Documentation Governance](./01-documentation-governance.md)
