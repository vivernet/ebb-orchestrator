/**
 * В памяти шина событий, управляющая подписками на типы доменных событий.
 */

import type { DomainEvent } from "./domain-event.js";

export type EventHandler = (event: DomainEvent) => Promise<void> | void;
export type EventObserver = (event: DomainEvent) => void;

export interface Subscription {
  readonly type: string;
  readonly name: string;
  readonly handler: EventHandler;
}

/**
 * Предоставляет публичный контракт модуля event-bus для взаимодействия слоёв приложения.
 */
export class EventBus {
  private subscriptions: Subscription[] = [];
  private observers = new Set<EventObserver>();

  subscribe(type: string, consumerName: string, handler: EventHandler): void {
    this.subscriptions.push({ type, name: consumerName, handler });
  }

  subscriptionsFor(type: string): Subscription[] {
    return this.subscriptions.filter((s) => s.type === type);
  }

  /** Подключает наблюдателя только для чтения для SSE/diagnostics без права изменять state. */
  observe(observer: EventObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  /** Публикует уже обработанное событие наблюдателям. */
  emitObserved(event: DomainEvent): void {
    for (const observer of this.observers) {
      try { observer(event); } catch { /* Ошибка UI-наблюдателя не прерывает dispatch. */ }
    }
  }
}
